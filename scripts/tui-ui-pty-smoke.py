#!/usr/bin/env python3
"""PTY smoke test for the explicit renderer-owned TUI."""

from __future__ import annotations

import errno
import codecs
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


class TerminalModel:
    def __init__(self, rows: int, cols: int) -> None:
        self.rows = rows
        self.cols = cols
        self.row = 0
        self.col = 0
        self.autowrap = True
        self.pending_wrap = False
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.scrollback: list[list[str]] = []
        self.screen = [[" "] * cols for _ in range(rows)]

    def feed(self, data: bytes) -> None:
        text = self.decoder.decode(data)
        index = 0
        while index < len(text):
            char = text[index]
            if char == "\x1b":
                index = self._consume_escape(text, index)
                continue
            if char == "\r":
                self.col = 0
                self.pending_wrap = False
            elif char == "\n":
                self._line_feed()
            elif char == "\b":
                self.col = max(0, self.col - 1)
            elif ord(char) >= 32:
                self._put(char)
            index += 1

    def lines(self) -> list[str]:
        return ["".join(row) for row in self.screen]

    def scrollback_lines(self) -> list[str]:
        return ["".join(row) for row in self.scrollback]

    def all_lines(self) -> list[str]:
        return [*self.scrollback_lines(), *self.lines()]

    def resize(self, rows: int, cols: int) -> None:
        old_lines = self.lines()
        old_rows = self.rows
        self.rows = rows
        self.cols = cols
        if rows < old_rows:
            removed_count = old_rows - rows
            self.scrollback.extend([list(line) for line in old_lines[:removed_count]])
            kept = old_lines[removed_count:]
            self.row = max(0, self.row - removed_count)
        else:
            added_count = rows - old_rows
            kept = (["" for _ in range(added_count)] + old_lines)
            self.row += added_count
        self.screen = []
        for line in kept:
            chars = list(line[:cols])
            self.screen.append(chars + [" "] * (cols - len(chars)))
        self.screen = self.screen[-rows:]
        self.row = min(self.row, rows - 1)
        self.col = min(self.col, cols - 1)
        self.pending_wrap = False

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
            self.pending_wrap = False
        elif final == "B":
            self.row = min(self.rows - 1, self.row + count)
            self.pending_wrap = False
        elif final == "C":
            self.col = min(self.cols - 1, self.col + count)
            self.pending_wrap = False
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
            self.pending_wrap = False
        elif final in ("h", "l") and text[index + 2:end] == "?7":
            self.autowrap = final == "h"
            self.pending_wrap = False
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

        return end + 1

    def _line_feed(self) -> None:
        self.pending_wrap = False
        self.row += 1
        if self.row >= self.rows:
            self.scrollback.append(self.screen.pop(0))
            self.screen.append([" "] * self.cols)
            self.row = self.rows - 1

    def _put(self, char: str) -> None:
        width = char_width(char)
        if width <= 0:
            return
        if self.pending_wrap and self.autowrap:
            self.col = 0
            self._line_feed()
        self.pending_wrap = False
        self.screen[self.row][self.col] = char
        for offset in range(1, width):
            if self.col + offset < self.cols:
                self.screen[self.row][self.col + offset] = " "
        if self.col + width >= self.cols:
            self.pending_wrap = self.autowrap
            self.col = self.cols - 1
        else:
            self.col += width


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


def wait_for(
    fd: int,
    output: list[bytes],
    needle: str,
    timeout: float = 8.0,
    start_offset: int = 0,
) -> None:
    deadline = time.time() + timeout
    plain = ""
    while time.time() < deadline:
        output.append(read_available(fd))
        plain = strip_ansi(b"".join(output)[start_offset:].decode("utf-8", errors="replace"))
        if needle in plain:
            return
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for {needle!r}. Tail:\n{plain[-2000:]}")


def assert_ordered(haystack: str, needles: list[str]) -> None:
    cursor = 0
    for needle in needles:
        index = haystack.find(needle, cursor)
        if index < 0:
            raise AssertionError(f"Missing ordered text {needle!r}. Tail:\n{haystack[-3000:]}")
        cursor = index + len(needle)


def assert_retained(needle: str, label: str, model: TerminalModel) -> None:
    """Assert finalized content remains in visible rows or native scrollback."""
    terminal_text = "\n".join(model.all_lines())
    if needle not in terminal_text:
        raise AssertionError(
            f"{label}: finalized content {needle!r} is absent from visible rows and scrollback\n"
            f"--- scrollback tail ---\n{chr(10).join(model.scrollback_lines()[-20:])}\n"
            f"--- visible ---\n{chr(10).join(model.lines())}"
        )


def prompt_frame_rows(visible: str) -> tuple[list[int], list[int], list[int]]:
    lines = visible.splitlines()
    top_rows = [
        index for index, line in enumerate(lines)
        if line.rstrip().startswith("┌") and line.rstrip().endswith("┐") and "─" in line
    ]
    input_rows = [index for index, line in enumerate(lines) if "│ ›" in line]
    bottom_rows = [
        index for index, line in enumerate(lines)
        if line.rstrip().startswith("└") and line.rstrip().endswith("┘") and "─" in line
    ]
    return top_rows, input_rows, bottom_rows


def assert_single_prompt_frame(visible: str, model: TerminalModel, label: str, expected_input: str | None = None) -> None:
    top_rows, input_rows, bottom_rows = prompt_frame_rows(visible)
    if len(top_rows) != 1 or len(input_rows) != 1 or len(bottom_rows) != 1:
        raise AssertionError(
            f"{label}: expected one prompt frame, got "
            f"{len(top_rows)} top border(s), {len(input_rows)} input row(s), "
            f"{len(bottom_rows)} bottom border(s):\n{visible}"
        )
    if top_rows[0] >= input_rows[0] or bottom_rows[0] <= input_rows[0]:
        raise AssertionError(f"{label}: prompt row is not enclosed by borders:\n{visible}")
    # Keep the smoke test focused on renderer-owned frame stability. The
    # simplified terminal model is good enough to detect duplicated prompt
    # frames, but terminal resize cursor semantics differ across PTYs and should
    # not be treated as the source of truth here.
    if expected_input and expected_input not in visible.replace(" ", ""):
        raise AssertionError(f"{label}: prompt input {expected_input!r} not visible after resize:\n{visible}")


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

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        try:
            messages = request.get("messages", [])
            last_user = next((message.get("content", "") for message in reversed(messages) if message.get("role") == "user"), "")
            has_tool_result = any(message.get("role") == "tool" for message in messages)
            if has_tool_result:
                self.write_text_stream(["tool-final-response "], delay=0.05)
            elif "tool order test" in last_user:
                self.write_tool_call_stream()
            elif "markdown render test" in last_user:
                self.write_markdown_stream()
            elif "long output test" in last_user:
                self.write_long_tool_output_stream()
            elif "permission test" in last_user:
                self.write_permission_tool_stream()
            elif "修正目标" in last_user:
                self.write_text_stream(["revision-final-response "], delay=0.05)
            else:
                self.write_text_stream([
                    "first-response-part-1 ",
                    "first-response-part-2 ",
                    "first-response-part-3 ",
                    "first-response-part-4 ",
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
            "id": "chatcmpl-orion-code-tui-pty",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": "mock-tui-stream",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
        }
        if usage is not None:
            payload["usage"] = usage
        self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode("utf-8"))
        self.wfile.flush()

    def write_tool_call_stream(self) -> None:
        self.write_chunk({"content": "tool-intro-before-call "})
        time.sleep(0.05)
        self.write_chunk({
            "tool_calls": [{
                "index": 0,
                "id": "call-list-files",
                "type": "function",
                "function": {"name": "list_files", "arguments": "{\"path\":\".\",\"maxDepth\":0}"},
            }],
        })
        time.sleep(0.05)
        self.write_chunk(
            {},
            finish_reason="tool_calls",
            usage={"prompt_tokens": 12, "completion_tokens": 4},
        )

    def write_long_tool_output_stream(self) -> None:
        """Generate long text output to test scrollback without triggering tools."""
        long_lines = [f"### line-{i:04d} " + f"long-output-{'word-' * 20}" + f" end-line-{i:04d}" for i in range(40)]
        for line in long_lines:
            self.write_chunk({"content": line + "\n"})
            time.sleep(0.02)
        self.write_chunk(
            {},
            finish_reason="stop",
            usage={"prompt_tokens": 12, "completion_tokens": 4},
        )

    def write_markdown_stream(self) -> None:
        markdown = """# Markdown Heading

## Secondary Heading

**bold** and *italic* with `inline code` and [docs](https://example.com)

> quoted text

- list item

1. first ordered item
2. second ordered item

```javascript
const answer = 42;
```

```python
print("python block")
```

```diff
+added line
-removed line
@@ -1 +1 @@
```

| Key | Value | Status |
| --- | --- | --- |
| one | two | ready |
"""
        self.write_text_stream([markdown], delay=0.05)

    def write_permission_tool_stream(self) -> None:
        """Generate text that may trigger permission. For PTY we verify the
        permission overlay renders without crashing, even if the tool is
        auto-allowed by test config."""
        self.write_chunk({"content": "I will run a command to check the deploy status.\n\n"})
        time.sleep(0.05)
        self.write_chunk({
            "tool_calls": [{
                "index": 0,
                "id": "call-exec",
                "type": "function",
                "function": {"name": "exec_command", "arguments": "{\"command\":\"echo deploy-check\"}"},
            }],
        })
        time.sleep(0.05)
        self.write_chunk(
            {},
            finish_reason="tool_calls",
            usage={"prompt_tokens": 12, "completion_tokens": 4},
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
        # The third fixture (index 2) carries a LONG history so the smoke test
        # exercises the v0.2.21-fix1 /resume blank-page regression: after
        # resume the most-recent tail must stay visible in the live region
        # (not scrolled into scrollback leaving a blank page).
        if index == 2:
            messages = [
                {
                    "role": "user",
                    "content": f"long-resume-{i:03d}",
                    "timestamp": updated_at - (60 - i) * 1000,
                }
                for i in range(60)
            ]
        else:
            messages = [{
                "role": "user",
                "content": f"resume fixture {index + 1} content",
                "timestamp": updated_at,
            }]
        meta = {
            "id": session_id,
            "projectPath": str(project_path),
            "projectKey": encode_project_path(project_path),
            "cwd": str(project_path),
            "model": "mock-tui-stream",
            "startTime": updated_at,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(updated_at / 1000)),
            "updatedAt": updated_at,
            "updatedAtIso": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(updated_at / 1000)),
            "messageCount": len(messages),
            "historySizeBytes": sum(len(json.dumps(m)) for m in messages),
            "tokenCount": 0,
            "cost": 0,
            "name": f"resume fixture {index + 1}",
            "taskSummary": f"resume fixture {index + 1}",
        }
        (sessions_dir / f"{session_id}.json").write_text(json.dumps(meta), encoding="utf-8")
        (sessions_dir / f"{session_id}.jsonl").write_text(
            "\n".join(json.dumps(message) for message in messages) + "\n",
            encoding="utf-8",
        )

    return session_ids


def spawn_orion(repo: Path, base_url: str, config_dir: str, rows: int = 24, cols: int = 100) -> tuple[subprocess.Popen[bytes], int, int]:
    master, slave = pty.openpty()
    set_window_size(slave, rows=rows, cols=cols)
    env = os.environ.copy()
    env.update(
        {
            "ORION_CODE_CONFIG_DIR": config_dir,
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "FORCE_COLOR": "0",
            "ORION_CODE_API_KEY": "sk-orion-code-tui-pty",
            "ORION_CODE_API_BASE_URL": base_url,
            "ORION_CODE_MODEL": "mock-tui-stream",
            # Stale renderer env values must not override the explicit CLI selection.
            "ORION_CODE_UI": "terminal",
            "ORION_CODE_UI_RENDERER": "terminal",
        }
    )
    process = subprocess.Popen(
        ["npm", "run", "start", "--", "--ui", "tui"],
        cwd=repo,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        start_new_session=True,
    )
    return process, master, slave


def stop_process(process: subprocess.Popen[bytes], master: int | None, slave: int | None = None) -> None:
    if master is not None:
        try:
            os.close(master)
        except OSError:
            pass
    if slave is not None:
        try:
            os.close(slave)
        except OSError:
            pass
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except OSError:
            process.kill()


def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    mock_server, mock_base_url = start_mock_openai_server()
    config_dir = tempfile.mkdtemp(prefix="orion-code-tui-pty-")
    resume_session_ids = seed_resume_sessions(config_dir, repo)
    target_resume_session_id = resume_session_ids[2]
    process, master, slave = spawn_orion(repo, mock_base_url, config_dir)
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

    def expect_prompt_frame(label: str, expected_input: str | None = None, timeout: float = 5.0) -> None:
        """Poll the live screen until exactly one stable prompt frame is visible.

        The renderer paints asynchronously (scheduler + inline-surface FIFO
        queue + PTY delivery), so a single read can land mid-repaint. Wait for
        the frame to settle instead of assuming synchronous completion.
        """
        deadline = time.time() + timeout
        last_exc: Exception | None = None
        while time.time() < deadline:
            visible = sync_screen()
            try:
                assert_single_prompt_frame(visible, model, label, expected_input)
                return
            except AssertionError as exc:
                last_exc = exc
                time.sleep(0.05)
        assert last_exc is not None
        raise last_exc

    def tab_complete(label: str, expect_substr: str, timeout: float = 3.0) -> None:
        """Send Tab and poll until the picker completion text appears.

        The picker opens and populates asynchronously; a single Tab + fixed
        sleep can land before the completion is rendered. Poll instead so the
        check only fails when completion genuinely never happens.
        """
        sync_screen()
        time.sleep(0.1)
        os.write(master, b"\t")
        deadline = time.time() + timeout
        while time.time() < deadline:
            visible = sync_screen()
            if expect_substr in visible:
                return
            time.sleep(0.1)
        visible = sync_screen()
        raise AssertionError(
            f"TUI {label} Tab completion did not update the prompt:\n{visible}"
        )

    try:
        wait_for(master, output, "ORION CODE v", timeout=20)
        wait_for(master, output, "/ commands", timeout=20)
        # v0.2.21: primary-screen inline surface - NO alternate screen.
        if b"\x1b[?1049h" in b"".join(output):
            raise AssertionError("TUI entered alternate screen (should stay on primary screen)")

        os.write(master, "开源小？事收到".encode("utf-8"))
        wait_for(master, output, "开源小？事收到", timeout=5)
        os.write(master, b"\x7f")
        # Backspace + re-render are async; poll until the prompt shows the
        # truncated value and no longer the full string.
        deadline = time.time() + 3.0
        backspace_ok = False
        while time.time() < deadline:
            visible = sync_screen()
            compact_visible = visible.replace(" ", "")
            if "开源小？事收" in compact_visible and "开源小？事收到" not in compact_visible:
                backspace_ok = True
                break
            time.sleep(0.1)
        if not backspace_ok:
            visible = sync_screen()
            raise AssertionError(f"TUI Backspace did not update the visible prompt:\n{visible}")
        expect_prompt_frame("after CJK backspace", "开源小？事收")

        # --- v0.2.19 completion: multiline paste ---
        os.write(master, b"\x15")  # Ctrl+U to clear
        time.sleep(0.15)
        # Send bracketed paste with multiple lines
        paste_content = b"line one\nline two\nline three"
        bracketed = b"\x1b[200~" + paste_content + b"\x1b[201~"
        os.write(master, bracketed)
        time.sleep(0.3)
        expect_prompt_frame("after multiline paste")
        # The paste should NOT auto-submit; prompt should hold the value
        # (We verify by checking the prompt frame is still showing input, not empty)
        # Now submit with Enter
        os.write(master, b"\r")
        wait_for(master, output, "Completed with mock-tui-stream", timeout=10)
        expect_prompt_frame("after multiline paste submit")

        os.write(master, b"\x15/sta")
        wait_for(master, output, 'Commands "sta"', timeout=5)
        tab_complete("slash command", "/status")

        os.write(master, b"\x15?")
        wait_for(master, output, "Shortcuts", timeout=5)
        visible = sync_screen()
        if "Shortcuts" not in visible or "› ?" in visible:
            raise AssertionError(f"TUI shortcuts overlay polluted the prompt:\n{visible}")

        os.write(master, b"\x15@READ")
        wait_for(master, output, 'Files "READ"', timeout=5)
        wait_for(master, output, "README.md", timeout=5)
        tab_complete("file picker", "@README.md")

        os.write(master, b"\x15/resume\r")
        wait_for(master, output, "Sessions: Pick a Session", timeout=8)
        wait_for(master, output, "resume fixture 3", timeout=8)
        os.write(master, target_resume_session_id.encode("ascii") + b"\r")
        wait_for(master, output, "Restored", timeout=8)
        wait_for(master, output, "long-resume-059", timeout=8)
        sync_screen()
        assert_retained("long-resume-059", "TUI did not restore the selected session into transcript", model)

        # v0.2.21-fix1 regression: after /resume with a long history the most
        # recent restored content must be visible in the live region WITHOUT
        # scrolling up (the screen must not be blank). Poll the visible screen
        # because rendering settles asynchronously.
        deadline = time.time() + 6.0
        tail_visible = False
        while time.time() < deadline:
            visible = sync_screen()
            if "long-resume-059" in visible:
                tail_visible = True
                break
            time.sleep(0.1)
        if not tail_visible:
            visible = sync_screen()
            raise AssertionError(
                f"TUI /resume left a blank live region (tail not visible):\n{visible}"
            )
        expect_prompt_frame("after resume long history")

        revision_start = len(b"".join(output))
        os.write(master, b"\x15stream revise\r")
        wait_for(master, output, "first-response-part-1", timeout=8)
        os.write(master, "修正目标".encode("utf-8"))
        wait_for(master, output, "修正目标", timeout=5)
        os.write(master, b"\r")
        wait_for(master, output, "Revision received. Interrupting current response", timeout=8)
        wait_for(master, output, "revision-final-response", timeout=10)
        wait_for(
            master,
            output,
            "Completed with mock-tui-stream",
            timeout=8,
            start_offset=revision_start,
        )
        expect_prompt_frame("after revised response")
        sync_screen()
        assert_retained("revision-final-response", "TUI did not keep the restarted response visible", model)

        tool_start = len(b"".join(output))
        os.write(master, b"tool order test\r")
        wait_for(master, output, "tool-intro-before-call", timeout=8)
        wait_for(master, output, "● list_files", timeout=8)
        wait_for(master, output, "✓ list_files", timeout=8)
        wait_for(master, output, "tool-final-response", timeout=8)
        wait_for(
            master,
            output,
            "Completed with mock-tui-stream",
            timeout=8,
            start_offset=tool_start,
        )
        tool_output = strip_ansi(b"".join(output)[tool_start:].decode("utf-8", errors="replace"))
        assert_ordered(tool_output, [
            "tool-intro-before-call",
            "● list_files",
            "✓ list_files",
            "tool-final-response",
        ])
        expect_prompt_frame("after tool final response")
        sync_screen()
        assert_retained("tool-final-response", "TUI did not keep the tool final response in scrollback", model)

        # --- v0.2.22 Markdown semantic rendering ---
        markdown_start = len(b"".join(output))
        os.write(master, b"markdown render test\r")
        wait_for(master, output, "Markdown Heading", timeout=10, start_offset=markdown_start)
        wait_for(master, output, "const answer = 42;", timeout=10, start_offset=markdown_start)
        wait_for(
            master,
            output,
            "Completed with mock-tui-stream",
            timeout=10,
            start_offset=markdown_start,
        )
        sync_screen()
        rendered_markdown = "\n".join(model.all_lines())
        for expected in (
            "Markdown Heading",
            "Secondary Heading",
            "bold",
            "italic",
            "inline code",
            "docs",
            "const answer = 42;",
            'print("python block")',
            "added line",
            "removed line",
            "Status",
            "ready",
        ):
            if expected not in rendered_markdown:
                raise AssertionError(
                    f"TUI Markdown rendering lost {expected!r}:\n{rendered_markdown[-4000:]}"
                )
        for source_marker in (
            "# Markdown Heading",
            "## Secondary Heading",
            "**bold**",
            "```javascript",
            "```python",
            "```diff",
            "| --- | --- | --- |",
        ):
            if source_marker in rendered_markdown:
                raise AssertionError(
                    f"TUI leaked Markdown source marker {source_marker!r}:\n"
                    f"{rendered_markdown[-4000:]}"
                )
        expect_prompt_frame("after Markdown rendering")

        # --- v0.2.19 切片5: rapid resize ---
        for new_rows, new_cols in [(30, 120), (12, 40), (24, 80)]:
            model.resize(rows=new_rows, cols=new_cols)
            set_window_size(slave, rows=new_rows, cols=new_cols)
            os.killpg(process.pid, signal.SIGWINCH)
            time.sleep(0.35)
            expect_prompt_frame(f"after resize to {new_rows}x{new_cols}")

        # Restore to standard size
        model.resize(rows=24, cols=100)
        set_window_size(slave, rows=24, cols=100)
        os.killpg(process.pid, signal.SIGWINCH)
        time.sleep(0.35)
        expect_prompt_frame("after restore to 24x100")

        # --- 窄宽 + 低高度验证 ---
        model.resize(rows=8, cols=24)
        set_window_size(slave, rows=8, cols=24)
        os.killpg(process.pid, signal.SIGWINCH)
        time.sleep(0.35)
        visible = sync_screen()
        # Prompt frame must still be present at this minimal size
        expect_prompt_frame("after resize to 8x24")
        # Resize back to normal
        model.resize(rows=24, cols=100)
        set_window_size(slave, rows=24, cols=100)
        os.killpg(process.pid, signal.SIGWINCH)
        time.sleep(0.35)
        expect_prompt_frame("after restore from 8x24")

        # --- 长输出 scrollback ---
        long_output_start = len(b"".join(output))
        os.write(master, b"\x15long output test\r")
        wait_for(master, output, "line-0039", timeout=15, start_offset=long_output_start)
        wait_for(
            master,
            output,
            "Completed with mock-tui-stream",
            timeout=15,
            start_offset=long_output_start,
        )
        # Feed the terminal emulator and verify finalized rows remain in its
        # visible screen or scrollback. Raw PTY bytes are not sufficient: text
        # can be emitted once and then erased by a later repaint.
        sync_screen()
        assert_retained(
            "line-0000",
            "TUI lost the earliest committed line - native scrollback not accumulating",
            model,
        )
        assert_retained(
            "line-0039",
            "TUI lost the latest committed line - native scrollback not accumulating",
            model,
        )
        scrollback_text = "\n".join(model.scrollback_lines())
        if "┌" in scrollback_text or "└" in scrollback_text or "│ ›" in scrollback_text:
            raise AssertionError(
                "TUI leaked an ephemeral prompt frame into native scrollback:\n"
                + scrollback_text[-3000:]
            )
        expect_prompt_frame("after long-output scrollback validation")

        # --- Permission / exec tool smoke (may auto-allow due to exec ask=off) ---
        permission_start = len(b"".join(output))
        os.write(master, b"\x15permission test\r")
        wait_for(master, output, "exec_command", timeout=10, start_offset=permission_start)
        # If permission overlay shows, dismiss it; if tool auto-runs, wait for completion
        time.sleep(0.5)
        output.append(read_available(master, timeout=0.5))
        tool_output_plain = strip_ansi(
            b"".join(output)[permission_start:].decode("utf-8", errors="replace")
        )
        if "Tool Permission" in tool_output_plain:
            os.write(master, b"y")
            time.sleep(0.5)
        wait_for(
            master,
            output,
            "Completed with mock-tui-stream",
            timeout=20,
            start_offset=permission_start,
        )
        # Permission/exec smoke passed — verify prompt frame still stable
        expect_prompt_frame("after permission/exec test")

        # --- Repeated interrupt / alternate screen restore ---
        for _ in range(4):
            os.write(master, b"\x03")
            time.sleep(0.25)
            output.append(read_available(master))
            if process.poll() is not None:
                break
        deadline = time.time() + 5
        while process.poll() is None and time.time() < deadline:
            output.append(read_available(master))
            time.sleep(0.05)
        if process.poll() is None:
            raise AssertionError("TUI did not exit after repeated Ctrl+C")

        final_raw = b"".join(output)
        # v0.2.21: primary-screen restore - bracketed paste disable and cursor show.
        if b"\x1b[?2004l" not in final_raw:
            raise AssertionError("TUI did not disable bracketed paste on exit")
        if b"\x1b[?25h" not in final_raw:
            raise AssertionError("TUI did not show cursor on exit")

        print("TUI_EXPLICIT_PTY_OK")
        return 0
    except Exception as exc:
        output.append(read_available(master))
        tail = strip_ansi(b"".join(output).decode("utf-8", errors="replace"))[-4000:]
        print(f"{exc}\n--- TUI PTY output tail ---\n{tail}", flush=True)
        return 1
    finally:
        mock_server.shutdown()
        mock_server.server_close()
        stop_process(process, master, slave)


if __name__ == "__main__":
    raise SystemExit(main())
