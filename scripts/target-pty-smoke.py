#!/usr/bin/env python3
"""v0.2.24 /target PTY smoke test — runs the full goal lifecycle in a real PTY."""

import os, pty, re, select, signal, subprocess, sys, time, json
from pathlib import Path

ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")
def strip(text: str) -> str: return ANSI_RE.sub("", text)

def drain(fd: int, timeout: float = 0.2) -> bytes:
    chunks = []; deadline = time.time() + timeout
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.05)
        if not r: break
        try: c = os.read(fd, 65536)
        except OSError: break
        if not c: break
        chunks.append(c)
    return b"".join(chunks)

def wait_for(fd: int, acc: list[bytes], needle: str, timeout: float = 8.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        acc.append(drain(fd))
        plain = strip(b"".join(acc).decode("utf-8", errors="replace"))
        if needle in plain: return plain
        time.sleep(0.1)
    raise AssertionError(f"Timed out waiting for {needle!r}. Tail:\n{plain[-2000:]}")

def send(fd: int, text: str) -> None: os.write(fd, (text + "\r").encode("utf-8"))
def send_raw(fd: int, data: bytes) -> None: os.write(fd, data)

def kill(proc: subprocess.Popen, master: int) -> None:
    try: os.close(master)
    except OSError: pass
    if proc.poll() is None:
        try: os.killpg(proc.pid, signal.SIGTERM)
        except OSError: proc.kill()

def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    binary = subprocess.check_output(["which", "orion"], text=True).strip()

    master, slave = pty.openpty()
    env = os.environ.copy()
    env.update({"NO_COLOR": "1", "TERM": "xterm-256color",
                "ORION_CODE_API_KEY": "sk-test-pty-goal", "ORION_CODE_MODEL": "mock-noop"})

    proc = subprocess.Popen([binary, "--ui", "terminal"], stdin=slave, stdout=slave,
                            stderr=slave, env=env, start_new_session=True, cwd=str(repo))
    os.close(slave)
    out: list[bytes] = []

    try:
        wait_for(master, out, "stable terminal UI", timeout=15)
        wait_for(master, out, "Ready", timeout=10)
        wait_for(master, out, "›", timeout=10)
        print("✓ Terminal UI booted")

        # 1. Create — immediately pause to prevent auto-continuation.
        send(master, "/target fix all tests and verify")
        wait_for(master, out, "Goal created", timeout=5)
        print("✓ /target create")
        # Pause immediately to stop auto-continuation before testing commands.
        send(master, "/target pause")
        wait_for(master, out, "paused", timeout=5)

        # 2. Show via /target status
        send_raw(master, b"\x15"); time.sleep(0.15)
        send(master, "/target status")
        wait_for(master, out, "Target", timeout=5)
        print("✓ /target status")

        # 3. /goal alias
        send_raw(master, b"\x15"); time.sleep(0.15)
        send(master, "/goal")
        wait_for(master, out, "Target", timeout=5)
        print("✓ /goal alias")

        # 4. Pause
        send(master, "/target pause")
        wait_for(master, out, "paused", timeout=5)
        print("✓ /target pause")

        # 5. Budget (while paused — no active turn)
        send(master, "/target budget 50000")
        wait_for(master, out, "50000", timeout=5)
        print("✓ /target budget 50000")

        # 6. Budget off
        send(master, "/target budget off")
        wait_for(master, out, "removed", timeout=5)
        print("✓ /target budget off")

        # 7. Replace
        send(master, "/target replace completely new goal")
        wait_for(master, out, "replaced", timeout=5)
        print("✓ /target replace")

        # 8. Edit
        send(master, "/target edit updated objective text")
        wait_for(master, out, "updated", timeout=5)
        print("✓ /target edit")

        # 9. Resume
        send(master, "/target resume")
        wait_for(master, out, "resumed", timeout=5)
        print("✓ /target resume")
        print("✓ /target edit")

        # 10. Clear with --yes
        send(master, "/target clear --yes")
        time.sleep(0.5)
        out.append(drain(master))
        plain = strip(b"".join(out).decode("utf-8", errors="replace"))
        assert "cleared" in plain.lower(), f"Expected 'cleared'. Tail:\n{plain[-1000:]}"
        print("✓ /target clear --yes")

        # 11. Re-create and exit
        send(master, "/target final pty test")
        time.sleep(0.5)
        out.append(drain(master))
        send_raw(master, b"\x03\x03")
        deadline = time.time() + 5
        while proc.poll() is None and time.time() < deadline:
            out.append(drain(master))
            time.sleep(0.05)
        assert proc.poll() is not None, "Process did not exit"
        print("✓ Ctrl+C exit")

        print("\nV024_TARGET_PTY_OK")
        return 0
    except Exception as exc:
        out.append(drain(master))
        tail = strip(b"".join(out).decode("utf-8", errors="replace"))[-2000:]
        print(f"\nFAIL: {exc}\n--- Tail ---\n{tail}", flush=True)
        return 1
    finally:
        kill(proc, master)

if __name__ == "__main__":
    raise SystemExit(main())