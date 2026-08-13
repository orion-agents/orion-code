#!/usr/bin/env python3
"""v0.2.24 /target PTY smoke test — runs the full goal lifecycle in a real PTY."""

import os, pty, re, select, signal, subprocess, sys, tempfile, time
from pathlib import Path

from pty_runner_identity import resolve_orion_command

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
    command = resolve_orion_command(repo, ["npm", "run", "start", "--"])

    master, slave = pty.openpty()
    isolated_config = tempfile.TemporaryDirectory(prefix="orion-target-pty-")
    env = os.environ.copy()
    env.update({"NO_COLOR": "1", "TERM": "xterm-256color",
                "ORION_CODE_API_KEY": "sk-test-pty-goal", "ORION_CODE_MODEL": "mock-noop",
                "ORION_CODE_CONFIG_DIR": isolated_config.name})

    proc = subprocess.Popen([*command, "--ui", "terminal"], stdin=slave, stdout=slave,
                            stderr=slave, env=env, start_new_session=True, cwd=str(repo))
    os.close(slave)
    out: list[bytes] = []

    try:
        wait_for(master, out, "technical terminal UI", timeout=15)
        wait_for(master, out, "Ready", timeout=10)
        wait_for(master, out, "›", timeout=10)
        print("✓ Terminal UI booted")

        # 1. Create — immediately pause to prevent auto-continuation.
        out.clear()
        send(master, "/target fix all tests and verify")
        wait_for(master, out, "fix all tests and verify", timeout=5)
        print("✓ /target create")
        # Pause immediately to stop auto-continuation before testing commands.
        send(master, "/target pause")
        wait_for(master, out, "paused", timeout=5)

        # Invalid human confirmation cannot fabricate user evidence.
        out.clear()
        send(master, "/target confirm criterion:missing")
        wait_for(master, out, "Criterion cannot be confirmed", timeout=5)
        print("✓ /target invalid confirm rejected")

        # 2. Show via /target status
        send_raw(master, b"\x15"); time.sleep(0.15)
        out.clear()
        send(master, "/target status")
        wait_for(master, out, "Target: [paused]", timeout=5)
        print("✓ /target status")

        # 3. /goal alias
        send_raw(master, b"\x15"); time.sleep(0.15)
        out.clear()
        send(master, "/goal")
        wait_for(master, out, "Target: [paused]", timeout=5)
        print("✓ /goal alias")

        # 4. Pause
        out.clear()
        send(master, "/target pause")
        wait_for(master, out, "paused", timeout=5)
        print("✓ /target pause")

        # 5. Budget (while paused — no active turn)
        out.clear()
        send(master, "/target budget 50000")
        wait_for(master, out, "budget 0/50000", timeout=5)
        print("✓ /target budget 50000")

        # 6. Budget off
        out.clear()
        send(master, "/target budget off")
        plain = wait_for(master, out, "Target: [paused]", timeout=5)
        assert not re.search(r"\| budget \d+/", plain), f"Budget remained after budget off:\n{plain[-1000:]}"
        print("✓ /target budget off")

        # 7. Replace
        out.clear()
        send(master, "/target replace deploy release to production")
        wait_for(master, out, "Target: [paused] deploy release to production", timeout=5)
        print("✓ /target replace boundary paused")

        # 8. Edit
        out.clear()
        send(master, "/target edit updated objective text")
        wait_for(master, out, "Target: [paused] updated objective text", timeout=5)
        print("✓ /target edit")

        # 9. Resume
        out.clear()
        send(master, "/target resume")
        wait_for(master, out, "Target: [active] updated objective text", timeout=5)
        print("✓ /target resume")

        # 10. The removed clear command must fail closed and keep Goal mode active.
        out.clear()
        send(master, "/target clear --yes")
        wait_for(master, out, "clear was removed. Use /goal exit", timeout=5)
        out.clear()
        send(master, "/goal status")
        wait_for(master, out, "Target: [", timeout=5)
        plain = strip(b"".join(out).decode("utf-8", errors="replace"))
        assert "no active goal" not in plain.lower(), f"Removed clear command deleted the Goal:\n{plain[-1000:]}"
        print("✓ removed /target clear --yes rejected")

        # 11. /goal exit is the sole explicit Goal-mode exit.
        send_raw(master, b"\x15"); time.sleep(0.15)
        out.clear()
        send(master, "/goal exit")
        wait_for(master, out, "Goal cleared:", timeout=5)
        send(master, "/goal status")
        wait_for(master, out, "no active goal", timeout=5)
        print("✓ /goal exit")

        # 12. Exit Orion independently of Goal mode.
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
        isolated_config.cleanup()

if __name__ == "__main__":
    raise SystemExit(main())
