#!/usr/bin/env python3
"""PTY smoke test for the Ink UI.

This intentionally exercises a real pseudo terminal instead of a normal pipe.
The UI bugs this protects against are terminal-frame bugs: cursor anchoring,
input redraws, and prompt border pollution can pass component tests while still
failing in an actual terminal.
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
import sys
import tempfile
import termios
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]")


class TerminalModel:
    """Small terminal model for final-screen assertions.

    The PTY log contains every repaint. Stripping ANSI can make one live prompt
    frame look like many scrollback lines, so this model applies the cursor
    movement and erase operations that Ink emits before checking the visible
    screen.
    """

    def __init__(self, rows: int, cols: int) -> None:
        self.rows = rows
        self.cols = cols
        self.row = 0
        self.col = 0
        self.saved_row = 0
        self.saved_col = 0
        self.screen = [[" "] * cols for _ in range(rows)]

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

    def lines(self) -> list[str]:
        return ["".join(row) for row in self.screen]

    def feed(self, data: bytes) -> None:
        text = decode_output(data)
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

    def _consume_escape(self, text: str, index: int) -> int:
        if index + 1 >= len(text):
            return index + 1
        marker = text[index + 1]
        if marker == "[":
            end = index + 2
            while end < len(text) and not ("@" <= text[end] <= "~"):
                end += 1
            if end >= len(text):
                return len(text)
            self._apply_csi(text[index + 2:end], text[end])
            return end + 1
        if marker == "]":
            end_bel = text.find("\x07", index + 2)
            end_st = text.find("\x1b\\", index + 2)
            candidates = [pos for pos in [end_bel, end_st] if pos >= 0]
            if not candidates:
                return len(text)
            end = min(candidates)
            return end + (2 if end == end_st else 1)
        if marker == "7":
            self.saved_row = self.row
            self.saved_col = self.col
            return min(len(text), index + 2)
        if marker == "8":
            self.row = min(self.rows - 1, max(0, self.saved_row))
            self.col = min(self.cols - 1, max(0, self.saved_col))
            return min(len(text), index + 2)
        return min(len(text), index + 2)

    def _apply_csi(self, params: str, final: str) -> None:
        clean = params.lstrip("?")
        parts = [int(part) if part.isdigit() else 0 for part in clean.split(";") if part != ""]
        first = parts[0] if parts else 0
        count = first or 1

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
        elif final == "J":
            if first in (2, 3):
                self.screen = [[" "] * self.cols for _ in range(self.rows)]
                self.row = 0
                self.col = 0
            elif first == 0:
                self._clear_line_from_cursor()
                for row in range(self.row + 1, self.rows):
                    self.screen[row] = [" "] * self.cols
        elif final == "K":
            if first == 2:
                self.screen[self.row] = [" "] * self.cols
            elif first == 1:
                for col in range(0, self.col + 1):
                    self.screen[self.row][col] = " "
            else:
                self._clear_line_from_cursor()

    def _clear_line_from_cursor(self) -> None:
        for col in range(self.col, self.cols):
            self.screen[self.row][col] = " "

    def _line_feed(self) -> None:
        self.row += 1
        if self.row >= self.rows:
            self.screen.pop(0)
            self.screen.append([" "] * self.cols)
            self.row = self.rows - 1

    def _put(self, char: str) -> None:
        width = terminal_char_width(char)
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


def terminal_char_width(char: str) -> int:
    if unicodedata.combining(char):
        return 0
    return 2 if unicodedata.east_asian_width(char) in ("F", "W") else 1


def decode_output(value: bytes) -> str:
    return value.decode("utf-8", errors="replace")


def strip_ansi(value: str) -> str:
    return ANSI_RE.sub("", value)


def set_window_size(fd: int, rows: int = 24, cols: int = 80) -> None:
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


def wait_for(fd: int, output: list[bytes], needle: str, timeout: float = 8.0, *, plain: bool = True) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        output.append(read_available(fd))
        decoded = decode_output(b"".join(output))
        haystack = strip_ansi(decoded) if plain else decoded
        if needle in haystack:
            return
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for {needle!r}. Tail:\n{strip_ansi(decode_output(b''.join(output)))[-2000:]}")


def wait_for_bytes(fd: int, output: list[bytes], needle: bytes, timeout: float = 8.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        output.append(read_available(fd))
        if needle in b"".join(output):
            return
        time.sleep(0.05)
    decoded = strip_ansi(decode_output(b"".join(output)))
    raise AssertionError(f"Timed out waiting for {needle!r}. Tail:\n{decoded[-2000:]}")


def latest_prompt_line(output: list[bytes]) -> str:
    plain = strip_ansi(decode_output(b"".join(output)))
    for line in reversed(plain.splitlines()):
        if "│ ›" in line:
            return line
    return ""


def wait_for_latest_prompt(fd: int, output: list[bytes], expected: str, timeout: float = 8.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        output.append(read_available(fd))
        if expected in latest_prompt_line(output):
            return
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for latest prompt {expected!r}. Latest: {latest_prompt_line(output)!r}")


def wait_for_new_output(fd: int, output: list[bytes], start: int, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        output.append(read_available(fd))
        if len(b"".join(output)) > start:
            output.append(read_available(fd, timeout=0.1))
            return
        time.sleep(0.05)
    raise AssertionError("Timed out waiting for new terminal output")


def wait_for_prompt_frame_after(fd: int, output: list[bytes], start: int, timeout: float = 8.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        output.append(read_available(fd))
        chunk = strip_ansi(decode_output(b"".join(output)[start:]))
        if "┌" in chunk and "│ ›" in chunk and "└" in chunk:
            output.append(read_available(fd, timeout=0.1))
            return
        time.sleep(0.05)
    chunk = strip_ansi(decode_output(b"".join(output)[start:]))
    raise AssertionError(f"Timed out waiting for prompt frame after offset. Tail:\n{chunk[-2000:]}")


def wait_for_shell_prompt_after(fd: int, output: list[bytes], start: int, timeout: float = 8.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        output.append(read_available(fd))
        chunk = strip_ansi(decode_output(b"".join(output)[start:]))
        if re.search(r"(^|\n).{0,4}\$ $", chunk):
            return
        time.sleep(0.05)
    chunk = strip_ansi(decode_output(b"".join(output)[start:]))
    raise AssertionError(f"Timed out waiting for shell prompt after Orion Code exit. Tail:\n{chunk[-2000:]}")


def assert_ordered(haystack: str, needles: list[str]) -> None:
    cursor = 0
    for needle in needles:
        index = haystack.find(needle, cursor)
        if index < 0:
            raise AssertionError(f"Missing ordered text {needle!r}. Tail:\n{haystack[-2000:]}")
        cursor = index + len(needle)


def assert_no_live_prompt_frame(model: TerminalModel, label: str) -> None:
    rows = [line.rstrip() for line in model.lines()]
    prompt_rows = [
        line for line in rows
        if "│ ›" in line or line.startswith("┌") or line.startswith("└")
    ]
    if prompt_rows:
        visible = "\n".join(rows)
        raise AssertionError(f"{label}: live prompt frame leaked into final screen:\n{visible}")


def is_prompt_top_border(line: str) -> bool:
    stripped = line.rstrip()
    return stripped.startswith("┌") and stripped.endswith("┐") and "─" in stripped


def is_prompt_bottom_border(line: str) -> bool:
    stripped = line.rstrip()
    return stripped.startswith("└") and stripped.endswith("┘") and "─" in stripped


def assert_single_live_prompt_frame(model: TerminalModel, label: str) -> None:
    rows = [line.rstrip() for line in model.lines()]
    prompt_indexes = [index for index, line in enumerate(rows) if "│ ›" in line]
    top_indexes = [index for index, line in enumerate(rows) if is_prompt_top_border(line)]
    bottom_indexes = [index for index, line in enumerate(rows) if is_prompt_bottom_border(line)]
    status_indexes = [
        index for index, line in enumerate(rows)
        if "model=" in line and "ctx=" in line
    ]
    help_indexes = [
        index for index, line in enumerate(rows)
        if line.startswith("/ commands") and "@ files" in line and "? shortcuts" in line
    ]

    if len(prompt_indexes) != 1 or len(top_indexes) != 1 or len(bottom_indexes) != 1:
        visible = "\n".join(rows)
        raise AssertionError(
            f"{label}: expected one live prompt frame, got "
            f"{len(top_indexes)} top border(s), {len(prompt_indexes)} input row(s), "
            f"{len(bottom_indexes)} bottom border(s):\n{visible}"
        )

    prompt_index = prompt_indexes[0]
    if top_indexes[0] >= prompt_index or bottom_indexes[0] <= prompt_index:
        visible = "\n".join(rows)
        raise AssertionError(f"{label}: prompt row is not enclosed by its live frame:\n{visible}")

    if len(status_indexes) != 1 or len(help_indexes) != 1:
        visible = "\n".join(rows)
        raise AssertionError(
            f"{label}: expected one status/help block, got "
            f"{len(status_indexes)} status row(s), {len(help_indexes)} help row(s):\n{visible}"
        )

    if status_indexes[0] >= help_indexes[0] or help_indexes[0] >= top_indexes[0]:
        visible = "\n".join(rows)
        raise AssertionError(f"{label}: status/help/prompt rows are out of order:\n{visible}")

    if model.row <= top_indexes[0] or model.row >= bottom_indexes[0]:
        visible = "\n".join(rows)
        raise AssertionError(
            f"{label}: terminal cursor is on row {model.row}, outside prompt frame "
            f"{top_indexes[0]}..{bottom_indexes[0]}:\n{visible}"
        )

    prompt_line_width = len(model.lines()[model.row])
    if model.col <= 1 or model.col >= prompt_line_width - 1:
        visible = "\n".join(rows)
        raise AssertionError(
            f"{label}: terminal cursor column {model.col} is outside the prompt input area:\n{visible}"
        )


def terminal_model_from_output(output: list[bytes], rows: int, cols: int) -> TerminalModel:
    model = TerminalModel(rows, cols)
    model.feed(b"".join(output))
    return model


def write_input(fd: int, value: bytes) -> None:
    os.write(fd, value)
    time.sleep(0.15)


def prompt_top_border(cols: int) -> str:
    layout_width = max(20, cols - 1)
    return "┌" + ("─" * max(0, layout_width - 2)) + "┐"


def prompt_top_border_bytes(cols: int) -> bytes:
    return prompt_top_border(cols).encode("utf-8")


class MockOpenAIHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return

        length = int(self.headers.get("content-length", "0"))
        body = b""
        if length:
            body = self.rfile.read(length)
        request = {}
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
                self.write_text_stream(["tool-final: list_files result integrated."], finish_reason="stop")
            elif "tool order test" in last_user:
                self.write_tool_call_stream()
            else:
                self.write_text_stream([
                    "mock-stream-chunk-1 ",
                    "keeps ",
                    "the ",
                    "prompt ",
                    "alive ",
                    "while ",
                    "assistant ",
                    "output ",
                    "is ",
                    "streaming. ",
                ], finish_reason="stop")

            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return

    def write_chunk(self, delta: dict, finish_reason: str | None = None, usage: dict | None = None) -> None:
        payload = {
            "id": "chatcmpl-orion-code-pty",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": "mock-stream",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
        }
        if usage is not None:
            payload["usage"] = usage
        self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode("utf-8"))
        self.wfile.flush()

    def write_text_stream(self, chunks: list[str], finish_reason: str) -> None:
        for chunk in chunks:
            self.write_chunk({"content": chunk})
            time.sleep(0.25)
        self.write_chunk(
            {},
            finish_reason=finish_reason,
            usage={"prompt_tokens": 12, "completion_tokens": 10},
        )

    def write_tool_call_stream(self) -> None:
        self.write_chunk({"content": "tool-intro: checking files first. "})
        time.sleep(0.1)
        self.write_chunk({
            "tool_calls": [{
                "index": 0,
                "id": "call-list-files",
                "type": "function",
                "function": {"name": "list_files", "arguments": "{\"path\":\".\",\"maxDepth\":0}"},
            }],
        })
        time.sleep(0.1)
        self.write_chunk(
            {},
            finish_reason="tool_calls",
            usage={"prompt_tokens": 20, "completion_tokens": 6},
        )


def start_mock_openai_server() -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockOpenAIHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    return server, f"http://{host}:{port}/v1"


def spawn_orion(repo: Path, env: dict[str, str], rows: int = 24, cols: int = 100) -> tuple[subprocess.Popen[bytes], int]:
    master, slave = pty.openpty()
    set_window_size(slave, rows=rows, cols=cols)
    process = subprocess.Popen(
        ["npm", "run", "start", "--", "--ui", "ink"],
        cwd=repo,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        start_new_session=True,
    )
    os.close(slave)
    return process, master


def spawn_shell(repo: Path, env: dict[str, str], rows: int = 24, cols: int = 100) -> tuple[subprocess.Popen[bytes], int]:
    master, slave = pty.openpty()
    set_window_size(slave, rows=rows, cols=cols)
    shell_env = env.copy()
    shell_env.update({
        "PS1": "$ ",
        "PROMPT_COMMAND": "",
    })
    process = subprocess.Popen(
        ["/bin/sh", "-i"],
        cwd=repo,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=shell_env,
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


def run_resume_check(repo: Path, env: dict[str, str]) -> None:
    process, master = spawn_orion(repo, env, rows=24, cols=100)
    output: list[bytes] = []
    try:
        wait_for(master, output, "ready", timeout=10)
        write_input(master, b"/resume --last")
        write_input(master, b"\r")
        wait_for(master, output, "Restored", timeout=8)
        wait_for(master, output, "mock-stream-chunk-1", timeout=8)
        wait_for(master, output, "tool-final: list_files result integrated.", timeout=8)
        wait_for_latest_prompt(master, output, "›", timeout=5)

        decoded = strip_ansi(decode_output(b"".join(output)))
        assert_ordered(decoded, [
            "mock-stream-chunk-1",
            "tool-intro: checking files first.",
            "list . (",
            "tool-final: list_files result integrated.",
        ])

        write_input(master, b"\x03\x03")
        deadline = time.time() + 5
        while process.poll() is None and time.time() < deadline:
            output.append(read_available(master))
            time.sleep(0.05)
        if process.poll() is None:
            raise AssertionError("Resumed Orion Code did not exit after double Ctrl+C")

        output.append(read_available(master))
        assert_no_live_prompt_frame(
            terminal_model_from_output(output, rows=24, cols=100),
            "resume exit",
        )
    except Exception as exc:
        output.append(read_available(master))
        raise AssertionError(f"{exc}\n--- Resume PTY output tail ---\n{strip_ansi(decode_output(b''.join(output)))[-4000:]}") from exc
    finally:
        stop_process(process, master)


def run_shell_cleanup_check(repo: Path, env: dict[str, str]) -> None:
    process, master = spawn_shell(repo, env, rows=24, cols=100)
    output: list[bytes] = []
    try:
        wait_for(master, output, "$", timeout=8)
        write_input(master, b"npm run start -- --ui ink\r")
        wait_for(master, output, "ready", timeout=10)
        exit_start = len(b"".join(output))
        write_input(master, b"\x03\x03")
        wait_for_shell_prompt_after(master, output, exit_start, timeout=8)
        output.append(read_available(master))

        assert_no_live_prompt_frame(
            terminal_model_from_output(output, rows=24, cols=100),
            "shell after exit",
        )

        write_input(master, b"exit\r")
        deadline = time.time() + 3
        while process.poll() is None and time.time() < deadline:
            output.append(read_available(master))
            time.sleep(0.05)
    except Exception as exc:
        output.append(read_available(master))
        raise AssertionError(f"{exc}\n--- Shell cleanup PTY output tail ---\n{strip_ansi(decode_output(b''.join(output)))[-4000:]}") from exc
    finally:
        stop_process(process, master)


def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    config_dir = tempfile.mkdtemp(prefix="orion-code-pty-smoke-")
    mock_server, mock_base_url = start_mock_openai_server()

    env = os.environ.copy()
    env.update(
        {
            "ORION_CODE_CONFIG_DIR": config_dir,
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "FORCE_COLOR": "0",
            "ORION_CODE_API_KEY": "sk-orion-code-pty",
            "ORION_CODE_API_BASE_URL": mock_base_url,
            "ORION_CODE_MODEL": "mock-stream",
        }
    )

    process, master = spawn_orion(repo, env, rows=24, cols=80)

    output: list[bytes] = []
    screen = TerminalModel(rows=24, cols=80)
    screen_consumed = 0

    def sync_screen(label: str, *, expect_prompt: bool = True) -> None:
        nonlocal screen_consumed
        deadline = time.time() + 1.0
        last_error: AssertionError | None = None
        while time.time() < deadline:
            output.append(read_available(master, timeout=0.1))
            raw = b"".join(output)
            screen.feed(raw[screen_consumed:])
            screen_consumed = len(raw)
            try:
                if expect_prompt:
                    assert_single_live_prompt_frame(screen, label)
                else:
                    assert_no_live_prompt_frame(screen, label)
                return
            except AssertionError as exc:
                last_error = exc
                time.sleep(0.05)
        if last_error is not None:
            raise last_error

    try:
        wait_for(master, output, "ready", timeout=10)
        wait_for_prompt_frame_after(master, output, 0, timeout=5)
        sync_screen("initial ready")

        write_input(master, "开源小？事收到".encode("utf-8"))
        wait_for(master, output, "开源小？事收到", timeout=5)
        sync_screen("after CJK input")

        write_input(master, b"\x7f")
        wait_for(master, output, "开源小？事收", timeout=5)
        sync_screen("after CJK backspace")

        clear_start = len(b"".join(output))
        write_input(master, b"\x15")
        wait_for_new_output(master, output, clear_start, timeout=5)
        sync_screen("after Ctrl+U clear")
        write_input(master, b"/")
        wait_for(master, output, "Commands", timeout=5)

        write_input(master, b"\x1b")
        palette_close_start = len(b"".join(output))
        time.sleep(0.2)
        wait_for_prompt_frame_after(master, output, palette_close_start, timeout=5)
        sync_screen("after command palette close")

        write_input(master, b"\x15resize")
        wait_for_latest_prompt(master, output, "› resize", timeout=5)
        sync_screen("after text input")

        family = "👨‍👩‍👧‍👦"
        write_input(master, f"\x15{family}".encode("utf-8"))
        wait_for_latest_prompt(master, output, f"› {family}", timeout=5)
        sync_screen("after emoji input")
        write_input(master, b"\x7f")
        write_input(master, b"ok")
        wait_for_latest_prompt(master, output, "› ok", timeout=5)
        sync_screen("after emoji backspace")

        if family in latest_prompt_line(output):
            raise AssertionError("Backspace left part of an emoji grapheme in the latest prompt")

        write_input(master, b"\x15")
        write_input(master, b"stream test")
        write_input(master, b"\r")
        wait_for(master, output, "mock-stream-chunk-1", timeout=8)

        write_input(master, "运行中输入".encode("utf-8"))
        wait_for_latest_prompt(master, output, "› 运行中输入", timeout=5)
        sync_screen("during streaming edit")
        stream_completion_start = len(b"".join(output))
        wait_for(master, output, "Completed with mock-stream", timeout=8)
        wait_for_prompt_frame_after(master, output, stream_completion_start, timeout=5)
        sync_screen("after streaming completed")
        clear_start = len(b"".join(output))
        write_input(master, b"\x15")
        wait_for_prompt_frame_after(master, output, clear_start, timeout=5)
        sync_screen("after clearing streaming edit")

        tool_order_start = len(b"".join(output))
        write_input(master, b"tool order test")
        write_input(master, b"\r")
        wait_for(master, output, "tool-intro: checking files first.", timeout=8)
        sync_screen("during tool intro")
        wait_for(master, output, "list_files", timeout=8)
        sync_screen("during tool running")
        wait_for(master, output, "list . (", timeout=8)
        tool_completion_start = len(b"".join(output))
        sync_screen("after tool success")
        wait_for(master, output, "tool-final: list_files result integrated.", timeout=8)
        wait_for(master, output, "Completed with mock-stream", timeout=8)
        wait_for_prompt_frame_after(master, output, tool_completion_start, timeout=5)
        sync_screen("after tool turn completed")
        tool_order_output = strip_ansi(decode_output(b"".join(output)[tool_order_start:]))
        # v0.2.18: structured sequence field may prefix tool names with #N
        assert_ordered(tool_order_output, [
            "tool-intro: checking files first.",
            "list_files",
            "list . (",
            "tool-final: list_files result integrated.",
        ])
        write_input(master, b"x")
        wait_for_latest_prompt(master, output, "› x", timeout=5)
        sync_screen("after tool prompt edit")
        clear_start = len(b"".join(output))
        write_input(master, b"\x15")
        wait_for_prompt_frame_after(master, output, clear_start, timeout=5)
        sync_screen("after clearing tool prompt")

        # --- Resize stability suite ---
        # Baseline: capture the current screen after a stable state.
        write_input(master, b"\x15resize-test  ")
        wait_for_latest_prompt(master, output, "› resize-test", timeout=5)
        sync_screen("pre-resize baseline")

        # Rapid resize: narrow -> wide -> narrow in quick succession.
        set_window_size(master, rows=24, cols=40)
        time.sleep(0.05)
        set_window_size(master, rows=24, cols=120)
        time.sleep(0.05)
        set_window_size(master, rows=24, cols=80)
        time.sleep(0.05)
        set_window_size(master, rows=24, cols=60)
        time.sleep(0.05)
        # Final stable size.
        set_window_size(master, rows=30, cols=90)
        # Wait for the coalesced resize to land.
        time.sleep(0.5)
        output.append(read_available(master))

        # Sync a fresh screen model at the final size and assert single stable frame.
        resize_model = TerminalModel(rows=30, cols=90)
        resize_raw = b"".join(output)
        resize_model.feed(resize_raw)
        try:
            assert_single_live_prompt_frame(resize_model, "after rapid resize")
        except AssertionError as exc:
            # Give it one more paint cycle in case of timing.
            time.sleep(0.3)
            output.append(read_available(master))
            resize_raw2 = b"".join(output)
            resize_model2 = TerminalModel(rows=30, cols=90)
            resize_model2.feed(resize_raw2)
            assert_single_live_prompt_frame(resize_model2, "after rapid resize (retry)")

        # Verify we can still type after resize.
        write_input(master, b"post-resize-ok")
        wait_for_latest_prompt(master, output, "› resize-test  post-resize-ok", timeout=5)
        sync_screen("post-resize input")

        # Clear and move on.
        clear_start = len(b"".join(output))
        write_input(master, b"\x15")
        wait_for_prompt_frame_after(master, output, clear_start, timeout=5)
        sync_screen("after clearing resize test")

        # Bracketed paste can arrive through PTY in several chunks. It must not
        # leak terminal paste markers or submit early on embedded newlines.
        paste_start = len(b"".join(output))
        write_input(master, b"\x1b[200~paste-one\npaste-two\x1b[201~")
        wait_for_latest_prompt(master, output, "› paste-one", timeout=5)
        wait_for(master, output, "paste-two", timeout=5)
        sync_screen("after bracketed paste")
        paste_output = strip_ansi(decode_output(b"".join(output)[paste_start:]))
        if "[200~" in paste_output or "[201~" in paste_output:
            raise AssertionError(f"Bracketed paste marker leaked into prompt:\n{paste_output[-1000:]}")
        if "mock-stream-chunk-1" in paste_output:
            raise AssertionError("Bracketed paste newline submitted the prompt before Enter")

        clear_start = len(b"".join(output))
        write_input(master, b"\x15")
        wait_for_prompt_frame_after(master, output, clear_start, timeout=5)
        sync_screen("after clearing bracketed paste")

        exit_start = len(b"".join(output))
        write_input(master, b"\x03\x03")
        deadline = time.time() + 5
        while process.poll() is None and time.time() < deadline:
            output.append(read_available(master))
            time.sleep(0.05)
        if process.poll() is None:
            raise AssertionError("Orion Code did not exit after double Ctrl+C")

        output.append(read_available(master))
        sync_screen("main exit", expect_prompt=False)

        raw = b"".join(output)
        exit_chunk = raw[exit_start:]
        decoded = decode_output(raw)
        plain_output = strip_ansi(decoded)

        if b"\x1b[2A\r\x1b[" not in raw:
            raise AssertionError("Single-line prompt did not park the native cursor on the input text row")

        last_prompt = exit_chunk.rfind("│ ›".encode("utf-8"))
        last_clear = max(exit_chunk.rfind(b"\x1b[2K"), exit_chunk.rfind(b"\x1b[0K"))
        if last_prompt >= 0 and last_clear < last_prompt:
            raise AssertionError("Orion Code exited without clearing the live prompt frame")

        if re.search(r"\n开源小？事收到\r?\n", plain_output):
            raise AssertionError("Terminal local echo leaked typed CJK text outside the prompt frame")

        if "运行中输入" not in plain_output:
            raise AssertionError("Streaming turn did not preserve editable prompt input")

        if b"\x1b7" in raw or b"\x1b8" in raw:
            raise AssertionError("Native cursor bridge should not rely on terminal save/restore cursor sequences")

        run_resume_check(repo, env)
        run_shell_cleanup_check(repo, env)

        return 0
    except Exception as exc:
        output.append(read_available(master))
        raw_tail = b"".join(output)[-2000:]
        sys.stderr.write(
            f"{exc}\n--- PTY output tail ---\n"
            f"{strip_ansi(decode_output(b''.join(output)))[-4000:]}\n"
            f"--- PTY raw tail repr ---\n{raw_tail!r}\n"
        )
        return 1
    finally:
        stop_process(process, master)
        mock_server.shutdown()
        mock_server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
