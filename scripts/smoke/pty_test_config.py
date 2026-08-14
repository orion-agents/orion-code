"""Shared isolated Orion configuration for PTY smoke tests."""

from __future__ import annotations

import json
from pathlib import Path


def write_mock_orion_config(
    config_dir: str | Path,
    *,
    base_url: str,
    model: str,
    tool_confirmation: str = "allow",
) -> None:
    """Write a current-format config backed by the smoke test's mock server."""
    root = Path(config_dir)
    root.mkdir(parents=True, exist_ok=True)
    payload = {
        "schemaVersion": 1,
        "providers": [
            {
                "id": "pty-mock-provider",
                "baseUrl": base_url,
                "apiKey": "$ORION_CODE_API_KEY",
                "protocol": "openai-completions",
            }
        ],
        "models": [
            {
                "id": model,
                "provider": "pty-mock-provider",
                "model": model,
            }
        ],
        "defaultModel": model,
        "toolConfirmation": tool_confirmation,
        "totalSessions": 0,
        "totalTokens": 0,
        "totalCost": 0,
    }
    (root / "orion.json").write_text(json.dumps(payload), encoding="utf-8")
