#!/usr/bin/env python3
"""Resolve and attest the Orion runner used by PTY acceptance scripts."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Sequence


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_expected_hash(label: str, actual: str, env_name: str, required: bool) -> None:
    expected = os.environ.get(env_name)
    if required and not expected:
        raise RuntimeError(f"{env_name} is required when ORION_REQUIRE_BOUND_RUNNER=1")
    if expected and expected.lower() != actual:
        raise RuntimeError(f"{label} SHA-256 mismatch: expected {expected.lower()}, got {actual}")


def emit_source_identity(repo: Path, command: Sequence[str]) -> list[str]:
    package_json = repo / "package.json"
    source_cli = repo / "src" / "cli.ts"
    if not package_json.is_file() or not source_cli.is_file():
        raise RuntimeError("Source runner identity requires package.json and src/cli.ts")

    resolved_repo = repo.resolve(strict=True)
    print("ORION_PTY_RUNNER_KIND=source")
    print(f"ORION_PTY_REPO_REALPATH={resolved_repo}")
    print(f"ORION_PTY_COMMAND_JSON={json.dumps(list(command), separators=(',', ':'))}")
    print(f"ORION_PTY_PACKAGE_JSON_SHA256={sha256_file(package_json)}")
    print(f"ORION_PTY_SOURCE_CLI_SHA256={sha256_file(source_cli)}")
    return list(command)


def find_package_root(binary: Path) -> Path:
    for parent in binary.parents:
        if (parent / "package.json").is_file() and (parent / "dist" / "cli.js").is_file():
            return parent
    raise RuntimeError(f"Cannot locate package.json and dist/cli.js above {binary}")


def emit_binary_identity(binary_value: str, required: bool) -> list[str]:
    resolved_value = binary_value
    if not Path(binary_value).is_absolute():
        resolved_value = shutil.which(binary_value) or ""
    if not resolved_value:
        raise RuntimeError(f"Cannot resolve Orion binary: {binary_value}")

    binary = Path(resolved_value).expanduser().resolve(strict=True)
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise RuntimeError(f"Orion binary is not an executable file: {binary}")

    package_root = find_package_root(binary)
    package_json = package_root / "package.json"
    dist_cli = package_root / "dist" / "cli.js"
    binary_hash = sha256_file(binary)
    package_hash = sha256_file(package_json)
    dist_cli_hash = sha256_file(dist_cli)

    require_expected_hash("Orion binary", binary_hash, "ORION_EXPECT_BIN_SHA256", required)
    require_expected_hash(
        "package.json", package_hash, "ORION_EXPECT_PACKAGE_JSON_SHA256", required
    )
    require_expected_hash("dist/cli.js", dist_cli_hash, "ORION_EXPECT_DIST_CLI_SHA256", required)

    print("ORION_PTY_RUNNER_KIND=installed")
    print(f"ORION_PTY_BIN_REALPATH={binary}")
    print(f"ORION_PTY_BIN_SHA256={binary_hash}")
    print(f"ORION_PTY_PACKAGE_ROOT={package_root}")
    print(f"ORION_PTY_PACKAGE_JSON_SHA256={package_hash}")
    print(f"ORION_PTY_DIST_CLI_SHA256={dist_cli_hash}")
    return [str(binary)]


def resolve_orion_command(repo: Path, source_command: Sequence[str] | None = None) -> list[str]:
    required = os.environ.get("ORION_REQUIRE_BOUND_RUNNER") == "1"
    configured = os.environ.get("ORION_BIN")
    if configured:
        return emit_binary_identity(configured, required)
    if required:
        raise RuntimeError("ORION_BIN is required when ORION_REQUIRE_BOUND_RUNNER=1")
    if source_command is not None:
        return emit_source_identity(repo, source_command)

    path_binary = shutil.which("orion")
    if not path_binary:
        raise RuntimeError("ORION_BIN is unset and no orion executable exists on PATH")
    return emit_binary_identity(path_binary, required=False)


def main() -> int:
    repo = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
    source_command = ["npm", "run", "start"] if "--source" in sys.argv[2:] else None
    command = resolve_orion_command(repo, source_command)
    print(f"ORION_PTY_RESOLVED_COMMAND_JSON={json.dumps(command, separators=(',', ':'))}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(f"ORION_PTY_IDENTITY_ERROR={error}", file=sys.stderr)
        raise SystemExit(2)
