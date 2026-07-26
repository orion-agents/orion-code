#!/usr/bin/env python3
"""PTY smoke test for the default scrollback terminal UI.

The product default intentionally avoids alternate-screen/full-frame rendering.
It uses a small raw editor so Orion Code can restore in-progress CJK input while
assistant output streams, without putting prompt frames into shell scrollback.
"""

from __future__ import annotations

import errno
import fcntl
import hashlib
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
import unicodedata
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]")
CONFIRM_APPROVE_TARGET = ".orion-code-terminal-confirm-approved.txt"
CONFIRM_DENY_TARGET = ".orion-code-terminal-confirm-denied.txt"
CONTEXT_FIXTURE = ".orion-code-terminal-context-fixture.txt"
CONTEXT_FILE_MARKER = "OC_TERMINAL_CONTEXT_FILE_MARKER_20260619"
CONTEXT_RULE_MARKER = "OC_TERMINAL_AGENT_RULE_MARKER_20260619"


class TerminalModel:
    def __init__(self, rows: int, cols: int) -> None:
        self.rows = rows
        self.cols = cols
        self.row = 0
        self.col = 0
        self.screen = [[" "] * cols for _ in range(rows)]

    def feed(self, data: bytes) -> None:
        text = data.decode("utf-8", errors="replace")
        index = 0
        while index < len(text):
            char = text[index]
            if char == "\x1b":
                index = self._consume_escape(text, index)
                continue
            if char == "\r":
                self.col = 0
            elif char == "\n":
                self._line_feed()
            elif char == "\b":
                self.col = max(0, self.col - 1)
            elif ord(char) >= 32:
                self._put(char)
            index += 1

    def lines(self) -> list[str]:
        return ["".join(row) for row in self.screen]

    def resize(self, rows: int, cols: int) -> None:
        old_lines = self.lines()
        self.rows = rows
        self.cols = cols
        kept = old_lines[-rows:]
        self.screen = []
        for line in kept:
            chars = list(line[:cols])
            self.screen.append(chars + [" "] * (cols - len(chars)))
        while len(self.screen) < rows:
            self.screen.insert(0, [" "] * cols)
        self.row = min(self.row, rows - 1)
        self.col = min(self.col, cols - 1)

    def _consume_escape(self, text: str, index: int) -> int:
        if index + 1 >= len(text):
            return index + 1
        marker = text[index + 1]
        if marker != "[":
            return min(len(text), index + 2)

        end = index + 2
        while end < len(text) and not ("@" <= text[end] <= "~"):
            end += 1
        if end >= len(text):
            return len(text)

        params = text[index + 2:end].lstrip("?")
        parts = [int(part) if part.isdigit() else 0 for part in params.split(";") if part != ""]
        first = parts[0] if parts else 0
        count = first or 1
        final = text[end]

        if final == "A":
            self.row = max(0, self.row - count)
        elif final == "B":
            self.row = min(self.rows - 1, self.row + count)
        elif final == "C":
            self.col = min(self.cols - 1, self.col + count)
        elif final == "D":
            self.col = max(0, self.col - count)
        elif final == "G":
            self.col = min(self.cols - 1, max(0, count - 1))
        elif final in ("H", "f"):
            row = (parts[0] if len(parts) >= 1 and parts[0] else 1) - 1
            col = (parts[1] if len(parts) >= 2 and parts[1] else 1) - 1
            self.row = min(self.rows - 1, max(0, row))
            self.col = min(self.cols - 1, max(0, col))
        elif final == "K":
            start = 0 if first == 2 else self.col
            end_col = self.col + 1 if first == 1 else self.cols
            for col in range(start, end_col):
                self.screen[self.row][col] = " "
        elif final == "J":
            if first in (2, 3):
                self.screen = [[" "] * self.cols for _ in range(self.rows)]
                self.row = 0
                self.col = 0
            elif first == 0:
                for col in range(self.col, self.cols):
                    self.screen[self.row][col] = " "
                for row in range(self.row + 1, self.rows):
                    self.screen[row] = [" "] * self.cols
            elif first == 1:
                for row in range(0, self.row):
                    self.screen[row] = [" "] * self.cols
                for col in range(0, self.col + 1):
                    self.screen[self.row][col] = " "

        return end + 1

    def _line_feed(self) -> None:
        self.row += 1
        if self.row >= self.rows:
            self.screen.pop(0)
            self.screen.append([" "] * self.cols)
            self.row = self.rows - 1

    def _put(self, char: str) -> None:
        width = char_width(char)
        if width <= 0:
            return
        if self.col >= self.cols:
            self.col = 0
            self._line_feed()
        self.screen[self.row][self.col] = char
        for offset in range(1, width):
            if self.col + offset < self.cols:
                self.screen[self.row][self.col + offset] = " "
        self.col += width
        if self.col >= self.cols:
            self.col = self.cols - 1


def char_width(char: str) -> int:
    if unicodedata.combining(char):
        return 0
    return 2 if unicodedata.east_asian_width(char) in ("F", "W") else 1


def strip_ansi(value: str) -> str:
    return ANSI_RE.sub("", value)


def set_window_size(fd: int, rows: int = 24, cols: int = 100) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def read_available(fd: int, timeout: float = 0.05) -> bytes:
    chunks: list[bytes] = []
    while True:
        readable, _, _ = select.select([fd], [], [], timeout)
        if not readable:
            break
        try:
            chunk = os.read(fd, 65536)
        except OSError as exc:
            if exc.errno in (errno.EIO, errno.EBADF):
                break
            raise
        if not chunk:
            break
        chunks.append(chunk)
        timeout = 0
    return b"".join(chunks)


def wait_for(fd: int, output: list[bytes], needle: str, timeout: float = 8.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        output.append(read_available(fd))
        plain = strip_ansi(b"".join(output).decode("utf-8", errors="replace"))
        if needle in plain:
            return
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for {needle!r}. Tail:\n{plain[-2000:]}")


def assert_output_order(output: str, markers: list[str]) -> None:
  """Assert all markers appear in strict order inside `output`."""
  cursor = 0
  for marker in markers:
    index = output.find(marker, cursor)
    if index < 0:
      raise AssertionError(
        f"Could not find expected timeline marker {marker!r} after position {cursor}.\n"
        f"Output tail:\n{output[-4000:]}"
      )
    cursor = index + len(marker)


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
        try:
            request = json.loads(body.decode("utf-8")) if body else {}
        except json.JSONDecodeError:
            request = {}

        messages = request.get("messages", [])
        last_user = next((message.get("content", "") for message in reversed(messages) if message.get("role") == "user"), "")
        all_text = json.dumps(messages, ensure_ascii=False)
        has_tool_result = any(message.get("role") == "tool" for message in messages)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        try:
            if "check referenced context" in last_user:
                has_context = CONTEXT_FILE_MARKER in all_text and CONTEXT_RULE_MARKER in all_text
                self.write_text_stream(["context-fixture-seen " if has_context else "context-fixture-missing "], delay=0.05)
            elif "multi tool batch" in last_user and has_tool_result:
                self.write_text_stream(["multi-tool-batch-complete "], delay=0.05)
            elif CONFIRM_DENY_TARGET in all_text and has_tool_result:
                self.write_text_stream(["confirmation-denied-final "], delay=0.05)
            elif CONFIRM_APPROVE_TARGET in all_text and has_tool_result:
                self.write_text_stream(["confirmation-allowed-final "], delay=0.05)
            elif "confirm allow" in last_user:
                self.write_tool_call_stream(CONFIRM_APPROVE_TARGET, "approved")
            elif "confirm deny" in last_user:
                self.write_tool_call_stream(CONFIRM_DENY_TARGET, "denied")
            elif "revision target" in last_user:
                self.write_text_stream(["revision-final-response "], delay=0.05)
            elif "long output while typing" in last_user:
                self.write_text_stream([f"long-output-chunk-{index} " for index in range(1, 41)], delay=0.06)
            elif "multi tool batch" in last_user:
                self.write_tool_calls_stream([
                    ("read_file", {"path": "src/a.ts"}),
                    ("read_file", {"path": "src/b.ts"}),
                    ("read_file", {"path": "src/c.ts"}),
                ])
            elif "stream revise" in last_user:
                self.write_text_stream([
                    "mock-stream-chunk-1 ",
                    "mock-stream-chunk-2 ",
                    "mock-stream-chunk-3 ",
                    "mock-stream-chunk-4 ",
                    "mock-stream-chunk-5 ",
                ], delay=1.2)
            else:
                self.write_text_stream([
                    "mock-stream-chunk-1 ",
                    "mock-stream-chunk-2 ",
                    "mock-stream-chunk-3 ",
                ], delay=0.35)
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return

    def write_text_stream(self, chunks: list[str], delay: float) -> None:
        for chunk in chunks:
            self.write_chunk({"content": chunk})
            time.sleep(delay)
        self.write_chunk(
            {},
            finish_reason="stop",
            usage={"prompt_tokens": 12, "completion_tokens": 4},
        )

    def write_chunk(self, delta: dict, finish_reason: str | None = None, usage: dict | None = None) -> None:
        payload = {
            "id": "chatcmpl-orion-code-terminal-pty",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": "mock-terminal",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
        }
        if usage is not None:
            payload["usage"] = usage
        self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode("utf-8"))
        self.wfile.flush()

    def write_tool_call_stream(self, target_path: str, content: str) -> None:
        args = json.dumps({"path": target_path, "content": content})
        self.write_chunk({
            "content": f"requesting write to {target_path} ",
        })
        time.sleep(0.05)
        self.write_chunk({
            "tool_calls": [{
                "index": 0,
                "id": f"call-write-file-{content}",
                "type": "function",
                "function": {"name": "write_file", "arguments": args},
            }],
        })
        time.sleep(0.05)
        self.write_chunk(
            {},
            finish_reason="tool_calls",
            usage={"prompt_tokens": 20, "completion_tokens": 6},
        )

    def write_tool_calls_stream(self, tool_calls: list[tuple[str, dict]]) -> None:
        """Write multiple simultaneous tool calls for batch testing."""
        tool_call_chunks = [
            {
                "index": idx,
                "id": f"call-batch-{idx}",
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)},
            }
            for idx, (name, args) in enumerate(tool_calls)
        ]
        self.write_chunk({
            "content": "requesting batch of tools ",
        })
        time.sleep(0.05)
        self.write_chunk({"tool_calls": tool_call_chunks})
        time.sleep(0.05)
        self.write_chunk(
            {},
            finish_reason="tool_calls",
            usage={"prompt_tokens": 30, "completion_tokens": 10},
        )


def start_mock_openai_server() -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockOpenAIHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    return server, f"http://{host}:{port}/v1"


def encode_project_path(project_path: Path) -> str:
    normalized = str(project_path).replace("\\", "/")
    encoded = re.sub(r"[^A-Za-z0-9]+", "-", normalized).strip("-")
    suffix = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:8]
    return f"{encoded or 'root'}-{suffix}"


def seed_resume_sessions(config_dir: str, repo: Path) -> list[str]:
    project_path = repo.resolve()
    sessions_dir = Path(config_dir) / "projects" / encode_project_path(project_path) / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    session_ids: list[str] = []
    base_time = int(time.time() * 1000)

    for index in range(12):
        session_id = str(uuid.uuid4())
        session_ids.append(session_id)
        updated_at = base_time - index * 1000
        message = {
            "role": "user",
            "content": f"resume fixture {index + 1} content",
            "timestamp": updated_at,
        }
        message_line = json.dumps(message, ensure_ascii=False) + "\n"
        meta = {
            "id": session_id,
            "projectPath": str(project_path),
            "projectKey": encode_project_path(project_path),
            "cwd": str(project_path),
            "model": "mock-terminal",
            "startTime": updated_at,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(updated_at / 1000)),
            "updatedAt": updated_at,
            "updatedAtIso": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(updated_at / 1000)),
            "messageCount": 1,
            "historySizeBytes": len(message_line.encode("utf-8")),
            "tokenCount": 0,
            "cost": 0,
            "name": f"resume fixture {index + 1}",
            "taskSummary": f"resume fixture {index + 1}",
        }
        (sessions_dir / f"{session_id}.json").write_text(json.dumps(meta), encoding="utf-8")
        (sessions_dir / f"{session_id}.jsonl").write_text(message_line, encoding="utf-8")

    return session_ids


def spawn_orion(repo: Path, base_url: str, config_dir: str, rows: int = 24, cols: int = 100) -> tuple[subprocess.Popen[bytes], int]:
    master, slave = pty.openpty()
    set_window_size(slave, rows=rows, cols=cols)
    env = os.environ.copy()
    env.update(
        {
            "ORION_CODE_CONFIG_DIR": config_dir,
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "FORCE_COLOR": "0",
            "ORION_CODE_API_KEY": "sk-orion-code-terminal-pty",
            "ORION_CODE_API_BASE_URL": base_url,
            "ORION_CODE_MODEL": "mock-terminal",
            "ORION_CODE_TOOL_CONFIRMATION": "allow",
            # Renderer selection is command-line only. Stale .env values must
            # not pull the default startup path into a raw-mode renderer.
            "ORION_CODE_UI": "ink",
            "ORION_CODE_UI_RENDERER": "ink",
        }
    )
    process = subprocess.Popen(
        ["npm", "run", "start"],
        cwd=repo,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        start_new_session=True,
    )
    os.close(slave)
    return process, master


def stop_process(process: subprocess.Popen[bytes], master: int | None) -> None:
    if master is not None:
        try:
            os.close(master)
        except OSError:
            pass
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except OSError:
            process.kill()


def main() -> int:
    # === Manual Validation Steps for Long Session with Chinese IME ===
    # 1. Launch the terminal UI in a real terminal (not PTY smoke):
    #      npm run start
    # 2. Type a long CJK sentence via IME (e.g. "这是一个需要长时间编辑的复杂中文句子")
    #    and verify the raw editor correctly renders combining characters.
    # 3. Mid-edit, submit the prompt. While the assistant streams output, type
    #    another CJK sentence via IME and verify the readline buffer is restored
    #    after each stream chunk without losing partial IME composition state.
    # 4. Resize the terminal window (e.g. from 80x24 to 120x40) during active
    #    assistant output streaming. Verify CJK characters remain visible and
    #    the prompt is redrawn correctly.
    # 5. Run /resume and navigate session pages. Verify CJK session names render
    #    correctly and can be selected.
    # 6. Type Ctrl+C during an active LLM request. Verify the abort status is
    #    shown and CJK input state is preserved after interruption.
    # 7. Repeat steps 2-6 with different IME engines (e.g. Sogou, Rime, macOS
    #    built-in Pinyin) to confirm cross-IME compatibility.
    # =================================================================
    repo = Path(__file__).resolve().parents[1]
    approve_path = repo / CONFIRM_APPROVE_TARGET
    deny_path = repo / CONFIRM_DENY_TARGET
    context_path = repo / CONTEXT_FIXTURE
    agents_path = repo / "AGENTS.md"
    original_agents = agents_path.read_text(encoding="utf-8") if agents_path.exists() else None
    approve_path.unlink(missing_ok=True)
    deny_path.unlink(missing_ok=True)
    context_path.write_text(CONTEXT_FILE_MARKER + "\n", encoding="utf-8")
    agents_path.write_text(
        ((original_agents + "\n\n") if original_agents else "") + CONTEXT_RULE_MARKER + "\n",
        encoding="utf-8",
    )
    mock_server, mock_base_url = start_mock_openai_server()
    config_dir = tempfile.mkdtemp(prefix="orion-code-terminal-pty-")
    Path(config_dir, "orion.json").write_text(json.dumps({
        "defaultModel": "mock-terminal",
        "toolConfirmation": "ask",
        "totalSessions": 0,
        "totalTokens": 0,
        "totalCost": 0,
    }), encoding="utf-8")
    seed_resume_sessions(config_dir, repo)
    process, master = spawn_orion(repo, mock_base_url, config_dir)
    output: list[bytes] = []
    model = TerminalModel(rows=24, cols=100)
    consumed = 0

    def sync_screen() -> str:
        nonlocal consumed
        output.append(read_available(master, timeout=0.1))
        raw = b"".join(output)
        model.feed(raw[consumed:])
        consumed = len(raw)
        return "\n".join(model.lines())

    try:
        wait_for(master, output, "stable terminal UI", timeout=20)
        wait_for(master, output, "Ready. Terminal editor supports", timeout=20)
        wait_for(master, output, "[new] ›", timeout=20)

        plain = strip_ansi(b"".join(output).decode("utf-8", errors="replace"))
        if "context harness coding agent" in plain or "│ ›" in plain:
            raise AssertionError("Default terminal UI entered a full-frame renderer")
        if b"\x1b[?1049h" in b"".join(output):
            raise AssertionError("Default terminal UI entered alternate screen")

        os.write(master, "开源小？事收到".encode("utf-8"))
        wait_for(master, output, "开源小？事收到", timeout=5)
        os.write(master, b"\x7f")
        time.sleep(0.25)

        visible = sync_screen()
        compact_visible = visible.replace(" ", "")
        if "开源小？事收到" in compact_visible or "开源小？事收" not in compact_visible:
            raise AssertionError(f"Backspace did not update the visible terminal editor buffer:\n{visible}")

        set_window_size(master, rows=24, cols=42)
        model.resize(rows=24, cols=42)
        time.sleep(0.35)
        visible_after_resize = sync_screen()
        compact_after_resize = visible_after_resize.replace(" ", "")
        if "›" not in visible_after_resize or "开源小？事收" not in compact_after_resize:
            raise AssertionError(
                "Terminal editor did not redraw the current CJK input after resize:\n"
                + visible_after_resize
            )
        set_window_size(master, rows=24, cols=100)
        model.resize(rows=24, cols=100)
        time.sleep(0.2)
        sync_screen()

        # --- Bracketed multiline paste: buffer holds multi-line as one input ---
        os.write(master, b"\x15")
        time.sleep(0.15)
        os.write(master, b"\x1b[200~aaa\nbbb\x1b[201~")
        time.sleep(0.35)
        visible_paste = sync_screen()
        if "aaa" not in visible_paste or "bbb" not in visible_paste:
            raise AssertionError(
                "Bracketed multiline paste did not render as a multiline buffer:\n"
                + visible_paste
            )
        # Ctrl+U clears the pasted multiline buffer
        os.write(master, b"\x15")
        time.sleep(0.25)
        visible_cleared = sync_screen()
        if "aaa" in visible_cleared.replace(" ", ""):
            raise AssertionError(
                "Ctrl+U did not clear the pasted multiline buffer:\n" + visible_cleared
            )

        # --- Interactive multiline editing: Alt+Enter inserts, Enter still submits ---
        os.write(master, b"first line\x1b\rsecond line")
        time.sleep(0.35)
        visible_multiline = sync_screen()
        if "first line" not in visible_multiline or "second line" not in visible_multiline:
            raise AssertionError(
                "Alt+Enter did not render a real multiline editor buffer:\n"
                + visible_multiline
            )
        if process.poll() is not None:
            raise AssertionError("Terminal process exited during multiline editing")
        os.write(master, b"\x15")
        time.sleep(0.15)

        # --- Long input remains bounded instead of corrupting or exiting ---
        os.write(master, b"x" * 16384)
        time.sleep(0.5)
        visible_long_input = sync_screen()
        if process.poll() is not None:
            raise AssertionError("Terminal process exited while editing long input")
        if "\u2039" not in visible_long_input and "x" not in visible_long_input:
            raise AssertionError(
                "Long input viewport did not remain visible:\n" + visible_long_input
            )
        os.write(master, b"\x15")
        time.sleep(0.15)

        os.write(master, b"\x15stream revise\r")
        wait_for(master, output, "mock-stream-chunk-1", timeout=8)
        os.write(master, "输入中事地方".encode("utf-8"))
        wait_for(master, output, "输入中事地方", timeout=5)
        wait_for(master, output, "mock-stream-chunk-2", timeout=8)
        visible_during_stream = sync_screen()
        compact_stream = visible_during_stream.replace(" ", "")
        if "输入中事地方" not in compact_stream:
            raise AssertionError(
                "Readline input was not restored while assistant output streamed:\n"
                + visible_during_stream
            )

        os.write(master, b"\x7f")
        time.sleep(0.25)
        visible_after_stream_backspace = sync_screen()
        compact_after_stream_backspace = visible_after_stream_backspace.replace(" ", "")
        if "输入中事地方" in compact_after_stream_backspace or "输入中事地" not in compact_after_stream_backspace:
            raise AssertionError(
                "Backspace did not update CJK input while assistant output was active:\n"
                + visible_after_stream_backspace
            )

        os.write(master, b"\x15")
        os.write(master, b"revision target\r")
        wait_for(master, output, "Revision received. Interrupting current response", timeout=8)
        wait_for(master, output, "revision-final-response", timeout=10)

        # --- Multi-tool batch ordering test ---
        os.write(master, b"\x15multi tool batch\r")
        wait_for(master, output, "requesting batch of tools", timeout=8)
        wait_for(master, output, "Running read_file", timeout=8)
        wait_for(master, output, "multi-tool-batch-complete", timeout=10)
        plain_after_batch = strip_ansi(b"".join(output).decode("utf-8", errors="replace"))
        assert_output_order(plain_after_batch, [
            "requesting batch of tools",
            "Running read_file",
            "multi-tool-batch-complete",
        ])

        os.write(master, b"\x15long output while typing\r")
        wait_for(master, output, "long-output-chunk-1", timeout=8)
        os.write(master, "这是一段持续输入".encode("utf-8"))
        wait_for(master, output, "这是一段持续输入", timeout=5)
        plain_during_long_output = strip_ansi(b"".join(output).decode("utf-8", errors="replace"))
        if "这是一段持续输入" not in plain_during_long_output:
            raise AssertionError(
                "Live input was not reflected while long assistant output was streaming:\n"
                + plain_during_long_output[-4000:]
            )
        set_window_size(master, rows=24, cols=52)
        model.resize(rows=24, cols=52)
        time.sleep(0.2)
        plain_after_shrink = strip_ansi(b"".join(output).decode("utf-8", errors="replace"))
        if "这是一段持续输入" not in plain_after_shrink:
            raise AssertionError(
                "Resize during long assistant output did not keep partial input visible:\n"
                + plain_after_shrink[-4000:]
            )
        set_window_size(master, rows=24, cols=100)
        model.resize(rows=24, cols=100)
        time.sleep(0.2)
        plain_after_restore = strip_ansi(b"".join(output).decode("utf-8", errors="replace"))
        if "这是一段持续输入" not in plain_after_restore:
            raise AssertionError(
                "Restore after resize did not keep partial input:\n"
                + plain_after_restore[-4000:]
            )
        wait_for(master, output, "long-output-chunk-20", timeout=8)

        os.write(master, b"confirm allow\r")
        wait_for(master, output, "Allow tool write_file?", timeout=8)
        wait_for(master, output, CONFIRM_APPROVE_TARGET, timeout=8)
        os.write(master, b"y\r")
        wait_for(master, output, "confirmation-allowed-final", timeout=10)
        # --- Tool timeline order assertion (approve path) ---
        # Verify that tool events appear in strict timeline order:
        #   requesting write to <target> -> Allow tool write_file? -> tool execution -> confirmation-allowed-final
        plain_after_approve_full = strip_ansi(b"".join(output).decode("utf-8", errors="replace"))
        assert_output_order(plain_after_approve_full, [
            f"requesting write to {CONFIRM_APPROVE_TARGET}",
            "Allow tool write_file?",
            CONFIRM_APPROVE_TARGET,
            "confirmation-allowed-final",
        ])
        if not approve_path.exists() or approve_path.read_text(encoding="utf-8") != "approved":
            raise AssertionError("Approved write_file confirmation did not execute the tool")

        os.write(master, b"confirm deny\r")
        wait_for(master, output, "Allow tool write_file?", timeout=8)
        wait_for(master, output, CONFIRM_DENY_TARGET, timeout=8)
        os.write(master, b"n\r")
        wait_for(master, output, "permission was denied (user)", timeout=10)
        # --- Tool timeline order assertion (deny path) ---
        # Verify that tool events appear in strict timeline order:
        #   requesting write to <target> -> Allow tool write_file? -> permission was denied (user)
        plain_after_deny_full = strip_ansi(b"".join(output).decode("utf-8", errors="replace"))
        assert_output_order(plain_after_deny_full, [
            f"requesting write to {CONFIRM_DENY_TARGET}",
            "Allow tool write_file?",
            "permission was denied (user)",
        ])
        if deny_path.exists():
            raise AssertionError("Denied write_file confirmation still created the target file")

        os.write(master, f"check referenced context @{CONTEXT_FIXTURE}\r".encode("utf-8"))
        wait_for(master, output, "context-fixture-seen", timeout=10)
        plain_after_context = strip_ansi(b"".join(output).decode("utf-8", errors="replace"))
        if "context-fixture-missing" in plain_after_context:
            raise AssertionError("@file or AGENTS.md context did not reach the model request")

        os.write(master, b"/resume\r")
        wait_for(master, output, "Pick a Session", timeout=8)
        wait_for(master, output, "resume fixture 1", timeout=8)
        wait_for(master, output, "Showing 1-10 of", timeout=8)
        wait_for(master, output, "Type n/next or p/prev to page", timeout=8)
        wait_for(master, output, "1 msgs", timeout=8)
        wait_for(master, output, "B", timeout=8)
        os.write(master, b"n\r")
        wait_for(master, output, "page 2/2", timeout=8)
        wait_for(master, output, "Showing 11-13 of 13", timeout=8)
        wait_for(master, output, "resume fixture 12", timeout=8)
        os.write(master, b"resume fixture 12\r")
        wait_for(master, output, "Restored conversation", timeout=8)
        wait_for(master, output, "resume fixture 12 content", timeout=8)
        wait_for(master, output, "Restored 1 model-context messages / 1 transcript messages", timeout=8)

        os.write(master, b"\x03\x03")
        deadline = time.time() + 5
        while process.poll() is None and time.time() < deadline:
            output.append(read_available(master))
            time.sleep(0.05)
        if process.poll() is None:
            raise AssertionError("Terminal fallback did not exit after double Ctrl+C")

        print("DEFAULT_TERMINAL_IME_PTY_OK")
        return 0
    except Exception as exc:
        output.append(read_available(master))
        tail = strip_ansi(b"".join(output).decode("utf-8", errors="replace"))[-4000:]
        print(f"{exc}\n--- Terminal PTY output tail ---\n{tail}", flush=True)
        return 1
    finally:
        stop_process(process, master)
        mock_server.shutdown()
        mock_server.server_close()
        approve_path.unlink(missing_ok=True)
        deny_path.unlink(missing_ok=True)
        context_path.unlink(missing_ok=True)
        if original_agents is None:
            agents_path.unlink(missing_ok=True)
        else:
            agents_path.write_text(original_agents, encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
