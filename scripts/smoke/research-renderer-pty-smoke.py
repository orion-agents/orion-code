#!/usr/bin/env python3
"""Real-process parity smoke for the research lifecycle renderers.

Terminal and TUI are driven through a pseudo-terminal. Print mode is a real
non-interactive child process whose JSON payload exposes the same ordered,
typed lifecycle stream. All provider traffic stays on a loopback mock server.
"""

from __future__ import annotations

import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from pty_runner_identity import resolve_orion_command
from pty_test_config import write_mock_orion_config


ANSI_RE = re.compile(
    r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]"
)
ROOT_PROMPT = (
    "Delegate two independent research investigations in parallel: inspect the runtime "
    "research renderer events and the services persistence boundary, then summarize."
)
ROOT_COMPLETE = "ROOT_RESEARCH_COMPLETE"


def strip_ansi(value: str) -> str:
    return ANSI_RE.sub("", value)


def set_window_size(fd: int, rows: int = 32, cols: int = 140) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def read_available(fd: int, timeout: float = 0.05) -> bytes:
    chunks: list[bytes] = []
    while True:
        readable, _, _ = select.select([fd], [], [], timeout)
        if not readable:
            break
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno in (errno.EIO, errno.EBADF):
                break
            raise
        if not chunk:
            break
        chunks.append(chunk)
        timeout = 0
    return b"".join(chunks)


class PtyOutput:
    def __init__(self, fd: int) -> None:
        self.fd = fd
        self.chunks: list[bytes] = []

    def drain(self, timeout: float = 0.05) -> None:
        self.chunks.append(read_available(self.fd, timeout))

    def plain(self) -> str:
        raw = b"".join(self.chunks).decode("utf-8", errors="replace")
        return strip_ansi(raw)

    def wait(self, needle: str, timeout: float = 30.0) -> str:
        deadline = time.time() + timeout
        plain = ""
        while time.time() < deadline:
            self.drain()
            plain = self.plain()
            if needle in plain:
                return plain
            time.sleep(0.05)
        raise AssertionError(f"Timed out waiting for {needle!r}. Tail:\n{plain[-5000:]}")


def write_chunk(
    handler: BaseHTTPRequestHandler,
    delta: dict[str, Any],
    *,
    finish_reason: str | None = None,
    usage: dict[str, int] | None = None,
) -> None:
    payload: dict[str, Any] = {
        "id": "chatcmpl-research-renderer-pty",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "mock-research-pty",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    if usage is not None:
        payload["usage"] = usage
    handler.wfile.write(f"data: {json.dumps(payload)}\n\n".encode("utf-8"))
    handler.wfile.flush()


def child_result(messages_text: str) -> dict[str, Any]:
    if "src/services" in messages_text:
        path = "src/services/session-storage.ts"
        title = "Services persistence has a durable storage boundary"
    else:
        path = "src/runtime/ui-view-model.ts"
        title = "Runtime uses a shared research lifecycle projection"
    return {
        "summary": f"Mock research completed for {path}.",
        "findings": [
            {
                "severity": "info",
                "title": title,
                "evidence": f"{path}:1 is the bounded local evidence fixture.",
                "file": path,
                "line": 1,
            }
        ],
        "files": [path],
        "commands": [],
        "verification": [f"Read {path} from the repository root."],
        "risks": [],
    }


class MockResearchHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return

        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        request = json.loads(raw.decode("utf-8"))
        messages = request.get("messages") or []
        messages_text = json.dumps(messages, ensure_ascii=False)
        is_child = "child agent at delegation depth 1" in messages_text
        has_tool_result = any(message.get("role") == "tool" for message in messages)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        try:
            if is_child:
                content = json.dumps(child_result(messages_text), separators=(",", ":"))
                write_chunk(self, {"content": content})
                write_chunk(
                    self,
                    {},
                    finish_reason="stop",
                    usage={"prompt_tokens": 14, "completion_tokens": 8},
                )
            elif has_tool_result:
                write_chunk(self, {"content": ROOT_COMPLETE})
                write_chunk(
                    self,
                    {},
                    finish_reason="stop",
                    usage={"prompt_tokens": 12, "completion_tokens": 3},
                )
            else:
                arguments = {
                    "tasks": [
                        {
                            "role": "research",
                            "objective": "Inspect the runtime research event projection contract.",
                            "reason": "The renderer event contract can be inspected independently.",
                            "scope": {"paths": ["src/runtime"]},
                            "expectedOutput": "One file-bound finding.",
                        },
                        {
                            "role": "research",
                            "objective": "Inspect the services persistence boundary for research artifacts.",
                            "reason": "Persistence is independent of renderer presentation.",
                            "scope": {"paths": ["src/services"]},
                            "expectedOutput": "One file-bound finding.",
                        },
                    ],
                    "execution": "parallel",
                }
                write_chunk(
                    self,
                    {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call-research-renderer-pty",
                                "type": "function",
                                "function": {
                                    "name": "subtask",
                                    "arguments": json.dumps(arguments),
                                },
                            }
                        ]
                    },
                )
                write_chunk(
                    self,
                    {},
                    finish_reason="tool_calls",
                    usage={"prompt_tokens": 16, "completion_tokens": 7},
                )
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return


def start_mock_server() -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockResearchHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    return server, f"http://{host}:{port}/v1"


def write_config(config_dir: Path, base_url: str) -> None:
    write_mock_orion_config(
        config_dir,
        base_url=base_url,
        model="mock-research-pty",
        tool_confirmation="allow",
    )
    config_path = config_dir / "orion.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["subagents"] = {
        "mode": "auto",
        "maxParallel": 2,
        "maxTasksPerTurn": 2,
        "maxTurnsPerTask": 2,
        "maxModelRequestsPerTask": 2,
        "maxModelRequestsPerTurn": 4,
        "maxToolCallsPerTask": 2,
        "timeoutMs": 30000,
        "roles": ["research"],
    }
    config_path.write_text(json.dumps(config), encoding="utf-8")


def child_env(config_dir: Path) -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "ORION_CODE_CONFIG_DIR": str(config_dir),
            "ORION_CODE_API_KEY": "sk-research-renderer-pty",
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "FORCE_COLOR": "0",
        }
    )
    return env


def stop_process(process: subprocess.Popen[bytes], master: int) -> None:
    if process.poll() is None:
        for _ in range(2):
            try:
                os.write(master, b"\x03")
            except OSError:
                break
            time.sleep(0.15)
    deadline = time.time() + 4
    while process.poll() is None and time.time() < deadline:
        time.sleep(0.05)
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except OSError:
            pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            pass
        process.wait(timeout=2)
    try:
        os.close(master)
    except OSError:
        pass


def assert_lifecycle_text(output: str, label: str) -> None:
    packet_ids = re.findall(r"research (pkt-[^\s]+) started mode=local", output)
    if len(set(packet_ids)) != 2:
        raise AssertionError(
            f"{label} expected two research packets, found {packet_ids!r}. Tail:\n{output[-6000:]}"
        )
    for packet_id in set(packet_ids):
        started = output.find(f"research {packet_id} started mode=local")
        source = output.find(f"research {packet_id} source ", started + 1)
        completed = output.find(f"research {packet_id} completed audit=met", source + 1)
        if not (started >= 0 and source > started and completed > source):
            raise AssertionError(
                f"{label} lifecycle order failed for {packet_id}. Tail:\n{output[-6000:]}"
            )


def run_pty_renderer(
    repo: Path,
    base_command: list[str],
    base_url: str,
    renderer: str,
) -> str:
    with tempfile.TemporaryDirectory(prefix=f"orion-research-{renderer}-") as config_name:
        config_dir = Path(config_name)
        write_config(config_dir, base_url)
        master, slave = pty.openpty()
        set_window_size(slave)
        command = [*base_command, "--ui", renderer]
        process = subprocess.Popen(
            command,
            cwd=repo,
            env=child_env(config_dir),
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        output = PtyOutput(master)
        try:
            if renderer == "terminal":
                output.wait("Ready.", timeout=25)
                output.wait("[new] ›", timeout=10)
                # The banner can be printed just before the line editor takes
                # ownership of the PTY. Wait for its prompt frame to settle so
                # the following carriage return is handled as submit.
                time.sleep(0.2)
            else:
                # The static header is painted before the TUI input parser owns
                # the PTY. Wait for the first complete status/prompt frame.
                output.wait("/ commands", timeout=25)
                output.wait("PERM allow", timeout=10)
                time.sleep(0.1)
            os.write(master, (ROOT_PROMPT + "\r").encode("utf-8"))
            plain = output.wait(ROOT_COMPLETE, timeout=45)
            if renderer == "terminal":
                assert_lifecycle_text(plain, renderer)
            else:
                output.wait("research:completed", timeout=10)
                plain = output.plain()
                if "src:1/1" not in plain or "fail:0" not in plain or "cite:1" not in plain:
                    raise AssertionError(f"TUI research projection was incomplete. Tail:\n{plain[-6000:]}")
            return plain
        finally:
            stop_process(process, master)


def assert_print_lifecycle(payload: dict[str, Any]) -> None:
    events = payload.get("researchEvents")
    if not isinstance(events, list):
        raise AssertionError(f"Print JSON omitted researchEvents: {json.dumps(payload)[:2000]}")
    packet_ids = {
        event.get("packetId")
        for event in events
        if isinstance(event, dict) and event.get("type") == "research_started"
    }
    if None in packet_ids:
        packet_ids.remove(None)
    if len(packet_ids) != 2:
        raise AssertionError(f"Print JSON expected two packet streams: {json.dumps(events)}")
    for packet_id in packet_ids:
        types = [
            event.get("type")
            for event in events
            if isinstance(event, dict) and event.get("packetId") == packet_id
        ]
        if types != ["research_started", "research_source", "research_completed"]:
            raise AssertionError(f"Print JSON lifecycle order failed for {packet_id}: {types}")
        completed = next(
            event
            for event in events
            if event.get("packetId") == packet_id and event.get("type") == "research_completed"
        )
        summary = completed.get("summary") or {}
        if completed.get("stage") != "completed" or completed.get("auditStatus") != "met":
            raise AssertionError(f"Print JSON terminal event is incomplete: {completed}")
        if summary.get("retrievedCount") != 1 or summary.get("citationCount") != 1:
            raise AssertionError(f"Print JSON summary counts are wrong: {completed}")
    projection = payload.get("research") or {}
    if projection.get("stage") != "completed" or len(projection.get("sources") or []) != 1:
        raise AssertionError(f"Print JSON projection is missing: {json.dumps(projection)}")


def run_print_renderer(
    repo: Path,
    base_command: list[str],
    base_url: str,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="orion-research-print-") as config_name:
        config_dir = Path(config_name)
        write_config(config_dir, base_url)
        result = subprocess.run(
            [*base_command, "--print", "--output-format", "json", ROOT_PROMPT],
            cwd=repo,
            env=child_env(config_dir),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=45,
        )
        if result.returncode != 0:
            raise AssertionError(
                f"Print renderer failed with {result.returncode}.\n"
                f"STDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
            )
        payload = json.loads(result.stdout)
        if ROOT_COMPLETE not in str(payload.get("content", "")):
            raise AssertionError(f"Print renderer omitted root completion: {result.stdout}")
        assert_print_lifecycle(payload)
        return payload


def main() -> int:
    repo = Path(__file__).resolve().parents[2]
    server, base_url = start_mock_server()
    try:
        base_command = resolve_orion_command(
            repo,
            ["node", "-r", "ts-node/register", "src/cli.ts"],
        )
        terminal = run_pty_renderer(repo, base_command, base_url, "terminal")
        tui = run_pty_renderer(repo, base_command, base_url, "tui")
        printed = run_print_renderer(repo, base_command, base_url)
        print(
            "RESEARCH_RENDERER_PTY_SMOKE_OK "
            f"terminal_events={terminal.count(' started mode=local')} "
            f"tui_projection={'research:completed' in tui} "
            f"print_events={len(printed.get('researchEvents') or [])}"
        )
        return 0
    except Exception as error:
        print(f"RESEARCH_RENDERER_PTY_SMOKE_ERROR={error}", flush=True)
        return 1
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
