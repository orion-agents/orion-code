#!/usr/bin/env python3
"""Capture real PTY raw bytes + model screen for the TUI live region."""
import os
import pty
import re
import errno
import fcntl
import select
import signal
import struct
import subprocess
import sys
import tempfile
import time
import termios
import threading
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class TerminalModel:
    def __init__(self, rows, cols):
        self.rows = rows
        self.cols = cols
        self.row = 0
        self.col = 0
        self.screen = [[" "] * cols for _ in range(rows)]

    def feed(self, data):
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

    def lines(self):
        return ["".join(r) for r in self.screen]

    def _consume_escape(self, text, index):
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
        parts = [int(p) if p.isdigit() else 0 for p in params.split(";") if p != ""]
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
            r = (parts[0] if parts and parts[0] else 1) - 1
            c = (parts[1] if len(parts) >= 2 and parts[1] else 1) - 1
            self.row = min(self.rows - 1, max(0, r))
            self.col = min(self.cols - 1, max(0, c))
        elif final == "K":
            start = 0 if first == 2 else self.col
            end_col = self.col + 1 if first == 1 else self.cols
            for c in range(start, end_col):
                self.screen[self.row][c] = " "
        elif final == "J":
            if first in (2, 3):
                self.screen = [[" "] * self.cols for _ in range(self.rows)]
                self.row = 0
                self.col = 0
            elif first == 0:
                for c in range(self.col, self.cols):
                    self.screen[self.row][c] = " "
                for r in range(self.row + 1, self.rows):
                    self.screen[r] = [" "] * self.cols
        return end + 1

    def _line_feed(self):
        self.row += 1
        if self.row >= self.rows:
            self.screen.pop(0)
            self.screen.append([" "] * self.cols)
            self.row = self.rows - 1

    def _put(self, char):
        w = 2 if ord(char) > 0x1100 and (ord(char) <= 0x115f or 0x2e80 <= ord(char) <= 0xa4cf or 0xac00 <= ord(char) <= 0xd7a3 or 0xf900 <= ord(char) <= 0xfaff or 0xfe30 <= ord(char) <= 0xfe4f or 0xff00 <= ord(char) <= 0xffe6) else 1
        if self.col >= self.cols:
            self.col = 0
            self._line_feed()
        self.screen[self.row][self.col] = char
        if w == 2 and self.col + 1 < self.cols:
            self.screen[self.row][self.col + 1] = " "
        self.col += w
        if self.col >= self.cols:
            self.col = self.cols - 1


def set_window_size(fd, rows=24, cols=100):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def read_available(fd, timeout=0.05):
    chunks = []
    while True:
        r, _, _ = select.select([fd], [], [], timeout)
        if not r:
            break
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        chunks.append(chunk)
        timeout = 0
    return b"".join(chunks)


class MockHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a):
        return
    def do_POST(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main():
    repo = Path(__file__).resolve().parents[1]
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address
    base = f"http://{host}:{port}/v1"
    cfg = tempfile.mkdtemp(prefix="orion-code-cap-")
    master, slave = pty.openpty()
    set_window_size(slave, rows=24, cols=100)
    env = os.environ.copy()
    env.update({
        "ORION_CODE_CONFIG_DIR": cfg, "TERM": "xterm-256color",
        "NO_COLOR": "1", "FORCE_COLOR": "0",
        "ORION_CODE_API_KEY": "sk-test", "ORION_CODE_API_BASE_URL": base,
        "ORION_CODE_MODEL": "mock-stream",
        "ORION_CODE_UI": "terminal", "ORION_CODE_UI_RENDERER": "terminal",
    })
    proc = subprocess.Popen(["npm", "run", "start", "--", "--ui", "tui"], cwd=repo,
                            stdin=slave, stdout=slave, stderr=slave, env=env,
                            start_new_session=True)
    out = []
    model = TerminalModel(24, 100)
    consumed = 0

    def sync():
        nonlocal consumed
        out.append(read_available(master, 0.1))
        raw = b"".join(out)
        model.feed(raw[consumed:])
        consumed = len(raw)
        return raw

    def vis(b):
        return b.replace(b"\x1b[", b"ESC[").replace(b"\x1b]", b"ESC]").replace(b"\x1b", b"ESC").decode("utf-8", "replace")

    try:
        # wait for system message
        deadline = time.time() + 20
        while time.time() < deadline:
            out.append(read_available(master, 0.2))
            if b"ORION CODE v" in b"".join(out):
                break
        time.sleep(0.3)
        raw = sync()
        with open("/tmp/cap_initial.txt", "w") as f:
            f.write("=== MODEL after initial ===\n")
            f.write("\n".join(model.lines()) + "\n")
            f.write("\n=== RAW initial (len=%d) ===\n" % len(raw))
            f.write(vis(raw) + "\n")

        os.write(master, "开源小？事收到".encode("utf-8"))
        time.sleep(0.5)
        raw = sync()
        with open("/tmp/cap_typed.txt", "w") as f:
            f.write("=== MODEL after typing ===\n")
            f.write("\n".join(model.lines()) + "\n")
            f.write("\n=== RAW typed (len=%d) ===\n" % len(raw))
            f.write(vis(raw) + "\n")

        os.write(master, b"\x7f")
        time.sleep(0.5)
        raw = sync()
        with open("/tmp/cap_backspace.txt", "w") as f:
            f.write("=== MODEL after backspace ===\n")
            f.write("\n".join(model.lines()) + "\n")
            f.write("\n=== RAW backspace (len=%d) ===\n" % len(raw))
            f.write(vis(raw) + "\n")

        print("CAPTURED: /tmp/cap_initial.txt /tmp/cap_typed.txt /tmp/cap_backspace.txt")
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except Exception:
            pass
        try:
            os.close(master)
        except Exception:
            pass
        try:
            os.close(slave)
        except Exception:
            pass
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
