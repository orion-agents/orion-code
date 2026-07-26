#!/usr/bin/env python3
"""Smoke test for non-interactive print mode."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class MockOpenAIHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return

        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length) if length else b""
        request = json.loads(body.decode("utf-8")) if body else {}
        messages = request.get("messages", [])
        last_user = next((message.get("content", "") for message in reversed(messages) if message.get("role") == "user"), "")
        has_tool_result = any(message.get("role") == "tool" for message in messages)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        if "permission probe" in last_user and not has_tool_result:
            payload = {
                "id": "chatcmpl-orion-code-print",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": "mock-print",
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "call-print-permission",
                                    "type": "function",
                                    "function": {
                                        "name": "write_file",
                                        "arguments": '{"path":"/tmp/orion-code-print-denied.txt","content":"nope"}',
                                    },
                                }
                            ]
                        },
                        "finish_reason": None,
                    }
                ],
            }
            self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode("utf-8"))
            done = {
                "id": "chatcmpl-orion-code-print",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": "mock-print",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 2},
            }
            self.wfile.write(f"data: {json.dumps(done)}\n\n".encode("utf-8"))
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return

        if "permission probe" in last_user and has_tool_result:
            text_chunks = ["permission ", "denied"]
        else:
            text_chunks = ["print-mode ", "ok: ", last_user]

        for text in text_chunks:
            payload = {
                "id": "chatcmpl-orion-code-print",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": "mock-print",
                "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
            }
            self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode("utf-8"))
            self.wfile.flush()

        done = {
            "id": "chatcmpl-orion-code-print",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": "mock-print",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        }
        self.wfile.write(f"data: {json.dumps(done)}\n\n".encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def start_mock_server() -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockOpenAIHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    return server, f"http://{host}:{port}/v1"


def run_cli(
    repo: Path,
    env: dict[str, str],
    args: list[str],
    stdin: str | None = None,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    child_env = env.copy()
    if extra_env:
        child_env.update(extra_env)
    return subprocess.run(
        ["node", "-r", "ts-node/register", "src/cli.ts", *args],
        cwd=repo,
        env=child_env,
        input=stdin,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=45,
    )


def assert_success(result: subprocess.CompletedProcess[str], label: str) -> None:
    if result.returncode != 0:
        raise AssertionError(
            f"{label} failed with {result.returncode}\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )


def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    server, base_url = start_mock_server()
    config_dir = tempfile.mkdtemp(prefix="orion-code-print-")
    env = os.environ.copy()
    env.update(
        {
            "ORION_CODE_CONFIG_DIR": config_dir,
            "NO_COLOR": "1",
            "FORCE_COLOR": "0",
            "ORION_CODE_API_KEY": "sk-orion-code-print",
            "ORION_CODE_API_BASE_URL": base_url,
            "ORION_CODE_MODEL": "mock-print",
        }
    )

    try:
        text = run_cli(repo, env, ["-p", "hello print"])
        assert_success(text, "text print")
        if "print-mode ok: hello print" not in text.stdout:
            raise AssertionError(f"text print stdout missing answer:\n{text.stdout}\nSTDERR:\n{text.stderr}")
        if "ORION_CODE" in text.stdout or "stable terminal UI" in text.stdout:
            raise AssertionError(f"text print leaked interactive banner:\n{text.stdout}")

        json_result = run_cli(repo, env, ["--print", "--output-format", "json", "json task"])
        assert_success(json_result, "json print")
        parsed = json.loads(json_result.stdout)
        if parsed.get("content") != "print-mode ok: json task":
            raise AssertionError(f"json print content mismatch:\n{json_result.stdout}")
        if not parsed.get("sessionId"):
            raise AssertionError(f"json print did not report session id:\n{json_result.stdout}")

        piped = run_cli(repo, env, ["--print"], stdin="pipe task\n")
        assert_success(piped, "stdin print")
        if "print-mode ok: pipe task" not in piped.stdout:
            raise AssertionError(f"stdin print stdout missing answer:\n{piped.stdout}\nSTDERR:\n{piped.stderr}")

        Path(config_dir, "orion.json").write_text(
            json.dumps({"defaultModel": "mock-print", "toolConfirmation": "ask"}),
            encoding="utf-8",
        )
        permission = run_cli(
            repo,
            env,
            ["--print", "--output-format", "json", "permission probe"],
        )
        if permission.returncode == 0:
            raise AssertionError(
                f"permission print unexpectedly succeeded\nSTDOUT:\n{permission.stdout}\nSTDERR:\n{permission.stderr}"
            )
        permission_payload = json.loads(permission.stdout)
        permission_errors = "\n".join(permission_payload.get("errors") or [])
        permission_entries = json.dumps(permission_payload.get("entries") or [])
        if "Tool write_file requires confirmation" not in permission_errors:
            raise AssertionError(f"permission print did not report non-interactive denial:\n{permission.stdout}")
        if "denied by user" not in permission_entries:
            raise AssertionError(f"permission print did not feed a denied tool result:\n{permission.stdout}")

        print("PRINT_MODE_SMOKE_OK")
        return 0
    except Exception as exc:
        print(str(exc), flush=True)
        return 1
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
