#!/usr/bin/env python3
"""Real PTY acceptance for the durable v0.1.2 Goal lifecycle.

The scenario intentionally crosses renderer, provider, tool, persistence, compact,
restart, resume, evidence, and completion-audit boundaries.  The default run covers
both the product-default TUI and the technical terminal renderer; set
ORION_GOAL_PTY_RENDERERS=tui or terminal to isolate one renderer while debugging.
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import pty
import re
import select
import signal
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from pty_test_config import write_mock_orion_config
from pty_runner_identity import resolve_orion_command


ANSI_RE = re.compile(
    r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]"
)


def strip_ansi(value: str) -> str:
    return ANSI_RE.sub("", value)


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
    def __init__(self, fd: int, renderer: str) -> None:
        self.fd = fd
        self.renderer = renderer
        self.chunks: list[bytes] = []
        self.auto_approve_permissions = True
        self.permission_pending = False
        self.permission_scan_offset = 0

    def mark(self) -> int:
        self.drain()
        return len(b"".join(self.chunks))

    def drain(self, timeout: float = 0.05) -> None:
        self.chunks.append(read_available(self.fd, timeout))

    def plain(self, start: int = 0) -> str:
        return strip_ansi(b"".join(self.chunks)[start:].decode("utf-8", errors="replace"))

    def wait(self, needle: str, timeout: float = 15.0, start: int = 0) -> str:
        deadline = time.time() + timeout
        plain = ""
        while time.time() < deadline:
            self.drain()
            plain = self.plain(start)
            self._approve_visible_permission(plain)
            if needle in plain:
                return plain
            time.sleep(0.05)
        raise AssertionError(f"Timed out waiting for {needle!r}. Tail:\n{plain[-4000:]}")

    def _approve_visible_permission(self, plain: str) -> None:
        if not self.auto_approve_permissions:
            return
        permission_visible = "Tool Permission" in plain or "Allow tool" in plain
        if not permission_visible:
            return
        full_plain = self.plain()
        if self.permission_pending:
            completion = re.search(
                r"Goal evidence (?:passed|failed)|was not executed because permission was denied",
                full_plain[self.permission_scan_offset:],
            )
            if completion is None:
                return
            self.permission_scan_offset += completion.end()
            self.permission_pending = False

        searchable = full_plain[self.permission_scan_offset:]
        permission_prompts = list(re.finditer(r"Tool Permission|\? Allow tool", searchable))
        if not permission_prompts:
            return
        latest_permission = searchable[permission_prompts[-1].start():]
        allowed_markers = ("npm test", "lifecycle-fixture.txt", "npm run build")
        if not any(marker in latest_permission for marker in allowed_markers):
            return
        self.permission_pending = True
        self.permission_scan_offset = len(full_plain)
        os.write(self.fd, b"y" if self.renderer == "tui" else b"y\r")
        time.sleep(0.15)


def send(output: PtyOutput, value: str) -> None:
    if output.renderer == "terminal":
        # The raw terminal parser processes text and Enter in order within one
        # batch, preventing an asynchronous permission modal from taking input
        # ownership between those events.
        os.write(output.fd, value.encode("utf-8") + b"\r")
        return

    # Ink exposes text and Enter as distinct key events. Wait for its input box
    # to render the command instead of relying on a machine-speed-dependent
    # sleep before Enter chooses submission over palette completion.
    mark = output.mark()
    os.write(output.fd, value.encode("utf-8"))
    # Long commands are left-truncated by the TUI to keep the cursor visible.
    # Waiting for a stable tail proves that Ink has consumed the entire draft
    # without coupling the smoke test to a particular terminal width.
    visible_tail = value[-48:]
    output.wait(visible_tail, timeout=8, start=mark)
    os.write(output.fd, b"\r")


def stop_process(process: subprocess.Popen[bytes], master: int) -> None:
    try:
        os.close(master)
    except OSError:
        pass
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except OSError:
            process.kill()


def exit_interactively(process: subprocess.Popen[bytes], output: PtyOutput) -> None:
    os.write(output.fd, b"\x03")
    time.sleep(0.2)
    os.write(output.fd, b"\x03")
    deadline = time.time() + 8
    while process.poll() is None and time.time() < deadline:
        output.drain()
        time.sleep(0.05)
    if process.poll() is None:
        raise AssertionError("Orion did not exit after repeated Ctrl+C")


def stop_without_goal_shutdown(process: subprocess.Popen[bytes], output: PtyOutput) -> None:
    """Simulate process loss so restart recovery must pause an active Goal."""
    os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=5)
    output.drain()


def last_tool_name(messages: list[dict[str, Any]]) -> str | None:
    if not messages or messages[-1].get("role") != "tool":
        return None
    tool_call_id = messages[-1].get("tool_call_id")
    for message in reversed(messages[:-1]):
        if message.get("role") != "assistant":
            continue
        for call in message.get("tool_calls") or []:
            if call.get("id") == tool_call_id:
                function = call.get("function") or {}
                return str(function.get("name") or "")
    return None


def tool_output_payload(message: dict[str, Any]) -> dict[str, Any]:
    content: Any = message.get("content", "")
    if isinstance(content, list):
        content = "".join(
            str(item.get("text", "")) if isinstance(item, dict) else str(item)
            for item in content
        )
    value: Any = content
    for _ in range(3):
        if isinstance(value, dict) and isinstance(value.get("output"), str):
            value = value["output"]
            continue
        if not isinstance(value, str):
            break
        try:
            value = json.loads(value)
            continue
        except json.JSONDecodeError:
            start = value.find("{")
            end = value.rfind("}")
            if start >= 0 and end > start:
                try:
                    value = json.loads(value[start : end + 1])
                    continue
                except json.JSONDecodeError:
                    pass
            break
    return value if isinstance(value, dict) else {}


class GoalScenario:
    def __init__(self) -> None:
        self.phase = "plan"
        self.lock = threading.Lock()
        self.request_count = 0
        self.completed = threading.Event()
        self.hold_started = threading.Event()
        self.restart_hold_started = threading.Event()

    def set_phase(self, phase: str) -> None:
        with self.lock:
            self.phase = phase

    def get_phase(self) -> str:
        with self.lock:
            return self.phase

    def next_call_id(self, name: str) -> str:
        with self.lock:
            self.request_count += 1
            return f"call-goal-{self.request_count}-{name}"


def make_handler(scenario: GoalScenario) -> type[BaseHTTPRequestHandler]:
    class GoalHandler(BaseHTTPRequestHandler):
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

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()

            try:
                self.respond(messages)
            except (BrokenPipeError, ConnectionResetError):
                return

        def chunk(
            self,
            delta: dict[str, Any],
            finish_reason: str | None = None,
            usage: dict[str, int] | None = None,
        ) -> None:
            payload: dict[str, Any] = {
                "id": "chatcmpl-goal-lifecycle-pty",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": "mock-goal-lifecycle",
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
            }
            if usage is not None:
                payload["usage"] = usage
            self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode("utf-8"))
            self.wfile.flush()

        def finish_text(self, text: str) -> None:
            self.chunk({"content": text})
            self.chunk(
                {},
                finish_reason="stop",
                usage={"prompt_tokens": 20, "completion_tokens": 5},
            )
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

        def tool(self, name: str, args: dict[str, Any]) -> None:
            self.chunk(
                {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": scenario.next_call_id(name),
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": json.dumps(args, separators=(",", ":")),
                            },
                        }
                    ]
                }
            )
            self.chunk(
                {},
                finish_reason="tool_calls",
                usage={"prompt_tokens": 20, "completion_tokens": 5},
            )
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

        def hold(self, marker: str) -> None:
            if marker == "READY_FOR_COMPACT":
                scenario.hold_started.set()
            elif marker == "READY_FOR_RESTART":
                scenario.restart_hold_started.set()
            self.chunk({"content": marker})
            for _ in range(300):
                time.sleep(0.1)
                self.chunk({"content": ""})

        def completion_mapping(self, result: dict[str, Any]) -> list[dict[str, Any]]:
            criteria = result.get("successCriteria") or []
            evidence = result.get("recentEvidence") or []
            mappings: list[dict[str, Any]] = []
            used: set[str] = set()
            for criterion in criteria:
                statement = str(criterion.get("statement") or "")
                if "lifecycle-test-check" in statement:
                    kind = "test"
                    marker = "lifecycle-test-check"
                elif "lifecycle-fixture" in statement:
                    kind = "file"
                    marker = "lifecycle-fixture"
                elif "lifecycle-build-check" in statement:
                    kind = "build"
                    marker = "lifecycle-build-check"
                else:
                    raise AssertionError(f"Unexpected criterion: {criterion}")
                match = next(
                    (
                        item
                        for item in reversed(evidence)
                        if item.get("kind") == kind
                        and item.get("result") == "passed"
                        and marker in str(item.get("subject") or "")
                        and item.get("id") not in used
                    ),
                    None,
                )
                if not match:
                    raise AssertionError(
                        f"No fresh {kind} evidence containing {marker}: {evidence}"
                    )
                used.add(str(match["id"]))
                mappings.append(
                    {
                        "criterion_id": criterion["id"],
                        "evidence_ids": [match["id"]],
                    }
                )
            if len(mappings) != 3:
                raise AssertionError(f"Expected three criterion mappings, got {mappings}")
            return mappings

        def respond(self, messages: list[dict[str, Any]]) -> None:
            phase = scenario.get_phase()
            last_tool = last_tool_name(messages)

            if phase == "compact":
                self.finish_text(
                    "Durable Goal compact checkpoint: three criteria, repaired fixture, "
                    "fresh verification pending final audit."
                )
                return
            if phase == "restart_hold":
                self.hold("READY_FOR_RESTART")
                return
            if phase == "hold":
                self.hold("READY_FOR_COMPACT")
                return

            if phase == "plan":
                if last_tool == "update_goal_plan":
                    scenario.set_phase("repair")
                    self.finish_text("GOAL_PLAN_WITH_THREE_CRITERIA_READY")
                else:
                    self.tool(
                        "update_goal_plan",
                        {
                            "phase": "implementation",
                            "steps": [
                                {"description": "Run lifecycle test", "done": False},
                                {"description": "Repair lifecycle fixture", "done": False},
                                {"description": "Reverify test and build", "done": False},
                            ],
                            "next_action": "Run the intentionally failing lifecycle test",
                            "derived_criteria": [
                                {
                                    "statement": "lifecycle-fixture.txt stores the repaired marker",
                                    "evidence_kinds": ["file"],
                                },
                                {
                                    "statement": "lifecycle-build-check passes after repair",
                                    "evidence_kinds": ["build"],
                                },
                            ],
                        },
                    )
                return

            if phase == "repair":
                if last_tool == "exec_command":
                    self.tool(
                        "write_file",
                        {"path": "lifecycle-fixture.txt", "content": "repaired-marker\n"},
                    )
                elif last_tool == "write_file":
                    scenario.set_phase("verify")
                    self.finish_text("FAILED_TEST_REPAIRED_WITH_FILE_CHANGE")
                else:
                    self.tool(
                        "exec_command",
                        {"command": "npm test -- lifecycle-test-check", "timeout": 15000},
                    )
                return

            if phase == "verify":
                if last_tool == "exec_command":
                    last_content = str(messages[-1].get("content") or "")
                    if "lifecycle-build-check" in last_content:
                        scenario.set_phase("hold")
                        self.finish_text("FRESH_TEST_AND_BUILD_REVERIFY_COMPLETE")
                    else:
                        self.tool(
                            "exec_command",
                            {
                                "command": "npm run build -- lifecycle-build-check",
                                "timeout": 15000,
                            },
                        )
                else:
                    self.tool(
                        "exec_command",
                        {"command": "npm test -- lifecycle-test-check", "timeout": 15000},
                    )
                return

            if phase == "complete":
                if last_tool == "get_goal":
                    result = tool_output_payload(messages[-1])
                    self.tool(
                        "update_goal",
                        {
                            "status": "complete",
                            "criterion_evidence": self.completion_mapping(result),
                        },
                    )
                elif last_tool == "update_goal":
                    scenario.completed.set()
                    self.finish_text("GOAL_LIFECYCLE_COMPLETION_REQUEST_SUBMITTED")
                else:
                    self.tool("get_goal", {})
                return

            raise AssertionError(f"Unknown scenario phase: {phase}")

    return GoalHandler


def start_server(scenario: GoalScenario) -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(scenario))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address
    return server, f"http://{host}:{port}/v1"


def seed_fixture(project: Path) -> None:
    (project / "package.json").write_text(
        json.dumps(
            {
                "name": "goal-lifecycle-pty-fixture",
                "private": True,
                "scripts": {
                    "test": "node check-test.js",
                    "build": "node check-build.js",
                },
            }
        ),
        encoding="utf-8",
    )
    check = (
        "const fs = require('fs');\n"
        "const value = fs.readFileSync('lifecycle-fixture.txt', 'utf8').trim();\n"
        "if (value !== 'repaired-marker') {\n"
        "  console.error('lifecycle fixture is not repaired');\n"
        "  process.exit(1);\n"
        "}\n"
        "console.log('lifecycle verification passed');\n"
    )
    (project / "check-test.js").write_text(check, encoding="utf-8")
    (project / "check-build.js").write_text(check, encoding="utf-8")
    (project / "lifecycle-fixture.txt").write_text("broken-marker\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=project, check=True)
    subprocess.run(["git", "config", "user.name", "Orion PTY"], cwd=project, check=True)
    subprocess.run(
        ["git", "config", "user.email", "orion-pty@example.invalid"],
        cwd=project,
        check=True,
    )
    subprocess.run(["git", "add", "."], cwd=project, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "test: seed broken lifecycle fixture"],
        cwd=project,
        check=True,
    )


def spawn_orion(
    repo: Path,
    project: Path,
    config_dir: Path,
    renderer: str,
) -> tuple[subprocess.Popen[bytes], int]:
    master, slave = pty.openpty()
    env = os.environ.copy()
    env.update(
        {
            "ORION_CODE_CONFIG_DIR": str(config_dir),
            "ORION_CODE_API_KEY": "sk-goal-lifecycle-pty",
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "FORCE_COLOR": "0",
        }
    )
    source_command = [
        str(repo / "node_modules" / ".bin" / "ts-node"),
        str(repo / "src" / "cli.ts"),
    ]
    command = resolve_orion_command(repo, source_command)
    if renderer == "terminal":
        command = [*command, "--ui", "terminal"]
    process = subprocess.Popen(
        command,
        cwd=project,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        start_new_session=True,
    )
    os.close(slave)
    return process, master


def find_goal_sidecar(config_dir: Path) -> Path:
    # Goal locks are transient directories named `<session>.goal.json.lock`.
    # A recursive walk can enter one just before Orion removes it and fail with
    # FileNotFoundError under full-suite load. The storage layout is fixed, so
    # scan only the sessions directory level and never traverse lock contents.
    matches = list(config_dir.glob("projects/*/sessions/*.goal.json"))
    if len(matches) != 1:
        raise AssertionError(f"Expected one Goal sidecar, found {matches}")
    return matches[0]


def encode_project_path(project_path: Path) -> str:
    normalized = str(project_path.resolve()).replace("\\", "/")
    encoded = re.sub(r"[^A-Za-z0-9]+", "-", normalized).strip("-")
    suffix = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:8]
    return f"{encoded or 'root'}-{suffix}"


def load_session_meta(config_dir: Path, project: Path, session_id: str) -> dict[str, Any]:
    path = (
        config_dir
        / "projects"
        / encode_project_path(project)
        / "sessions"
        / f"{session_id}.json"
    )
    return json.loads(path.read_text(encoding="utf-8"))


def run_renderer(repo: Path, renderer: str) -> None:
    scenario = GoalScenario()
    server, base_url = start_server(scenario)
    with tempfile.TemporaryDirectory(prefix=f"orion-goal-{renderer}-") as root_value:
        root = Path(root_value)
        project = root / "project"
        config_dir = root / "config"
        project.mkdir()
        config_dir.mkdir()
        seed_fixture(project)
        write_mock_orion_config(
            config_dir,
            base_url=base_url,
            model="mock-goal-lifecycle",
            tool_confirmation="ask",
        )

        process, master = spawn_orion(repo, project, config_dir, renderer)
        output = PtyOutput(master, renderer)
        try:
            boot_marker = "ORION CODE | 猎户座" if renderer == "tui" else "technical terminal UI"
            output.wait(boot_marker, timeout=25)
            if renderer == "terminal":
                output.wait("Ready.", timeout=10)
                output.wait("›", timeout=10)
                time.sleep(0.2)

            create_mark = output.mark()
            # Pause the freshly-created Goal before allowing its first tool prompt.
            # Otherwise the harness's automatic `y` can race the following slash
            # command and turn `/target pause` into a single invalid input line.
            output.auto_approve_permissions = False
            send(
                output,
                "/goal Make lifecycle-test-check pass with durable evidence, then exit goal mode",
            )
            # Wait for the command result, not its immediately echoed input. Under
            # full-suite load the echo can arrive before the TUI has submitted the
            # command, and sending the next slash command would only edit the draft.
            output.wait("Target: [active]", timeout=8, start=create_mark)
            if renderer == "terminal":
                output.wait("Goal continuation started", timeout=8, start=create_mark)
            send(output, "/goal pause")
            output.wait("Target: [paused]", timeout=8, start=create_mark)
            send(output, "/goal budget 100000")
            # Pausing can race with the first provider usage. The contract is the
            # configured ceiling, not an assumption that no tokens were charged.
            output.wait("/100000", timeout=8, start=create_mark)
            output.auto_approve_permissions = True

            lifecycle_mark = output.mark()
            send(output, "/goal resume")
            output.wait("Goal evidence failed", timeout=25, start=lifecycle_mark)
            output.wait("FAILED_TEST_REPAIRED_WITH_FILE_CHANGE", timeout=25, start=lifecycle_mark)
            output.wait("FRESH_TEST_AND_BUILD_REVERIFY_COMPLETE", timeout=30, start=lifecycle_mark)
            hold_deadline = time.time() + 20
            while not scenario.hold_started.is_set() and time.time() < hold_deadline:
                output.drain()
                time.sleep(0.05)
            if not scenario.hold_started.is_set():
                raise AssertionError("Provider did not enter the pre-compact continuation hold")
            if (project / "lifecycle-fixture.txt").read_text(encoding="utf-8") != "repaired-marker\n":
                raise AssertionError("The Goal turn did not repair lifecycle-fixture.txt")

            pause_mark = output.mark()
            send(output, "/goal pause")
            paused = output.wait("Target: [paused]", timeout=10, start=pause_mark)
            if "0/3" not in paused and "criteria 0/3" not in paused:
                send(output, "/goal status")
                paused = output.wait("criteria 0/3", timeout=8, start=pause_mark)
            if "100000" not in paused:
                raise AssertionError(f"Token budget was not preserved:\n{paused[-2500:]}")

            scenario.set_phase("compact")
            compact_mark = output.mark()
            send(output, "/compact 1")
            output.wait("Compacted", timeout=25, start=compact_mark)

            scenario.set_phase("restart_hold")
            output.mark()
            send(output, "/goal resume")
            restart_deadline = time.time() + 20
            while (
                not scenario.restart_hold_started.is_set() and time.time() < restart_deadline
            ):
                output.drain()
                time.sleep(0.05)
            if not scenario.restart_hold_started.is_set():
                raise AssertionError("Provider did not enter the pre-restart continuation hold")
            stop_without_goal_shutdown(process, output)

            sidecar = find_goal_sidecar(config_dir)
            persisted = json.loads(sidecar.read_text(encoding="utf-8"))
            if persisted.get("status") != "active":
                raise AssertionError(
                    f"Expected active persisted Goal before safe recovery, got {persisted.get('status')}"
                )
            session_id = sidecar.name[: -len(".goal.json")]
        finally:
            stop_process(process, master)

        scenario.set_phase("complete")
        restarted, restarted_master = spawn_orion(repo, project, config_dir, renderer)
        restarted_output = PtyOutput(restarted_master, renderer)
        try:
            boot_marker = "ORION CODE | 猎户座" if renderer == "tui" else "technical terminal UI"
            restarted_output.wait(boot_marker, timeout=25)
            if renderer == "terminal":
                restarted_output.wait("Ready.", timeout=10)
                restarted_output.wait("›", timeout=10)
                time.sleep(0.2)
            else:
                restarted_output.wait("MODE BUILD", timeout=10)
                restarted_output.wait("›", timeout=10)
                time.sleep(0.5)
            resume_mark = restarted_output.mark()
            send(restarted_output, f"/resume {session_id}")
            restarted_output.wait("Restored", timeout=15, start=resume_mark)
            send(restarted_output, "/goal status")
            recovered = restarted_output.wait("Target: [paused]", timeout=10, start=resume_mark)
            if "Recovered after restart" not in recovered:
                raise AssertionError(f"Missing safe-recovery reason:\n{recovered[-3000:]}")

            completion_mark = restarted_output.mark()
            send(restarted_output, "/goal resume")
            provider_deadline = time.time() + 25
            while not scenario.completed.is_set() and time.time() < provider_deadline:
                restarted_output.drain()
                time.sleep(0.05)
            if not scenario.completed.is_set():
                raise AssertionError("Mock provider never observed update_goal completion")
            completion_deadline = time.time() + 15
            final_goal: dict[str, Any] = {}
            while time.time() < completion_deadline:
                restarted_output.drain()
                final_goal = json.loads(
                    find_goal_sidecar(config_dir).read_text(encoding="utf-8")
                )
                if final_goal.get("status") == "complete":
                    break
                time.sleep(0.1)
            if final_goal.get("status") != "complete":
                raise AssertionError(
                    "Goal did not reach persisted complete state:\n"
                    + json.dumps(final_goal, indent=2)
                )
            if (final_goal.get("contract") or {}).get("completionAction") != "exit_goal":
                raise AssertionError(
                    "Chained exit directive was not stored as a completion action:\n"
                    + json.dumps(final_goal, indent=2)
                )
            if renderer == "tui":
                restarted_output.wait("MODE BUILD", timeout=10, start=completion_mark)
            else:
                restarted_output.wait("exited Goal mode", timeout=10, start=completion_mark)
            session_meta = load_session_meta(config_dir, project, session_id)
            if session_meta.get("activeGoalId") is not None or session_meta.get(
                "activeGoalObjective"
            ) is not None:
                raise AssertionError(
                    "Completion did not clear the session Goal binding:\n"
                    + json.dumps(session_meta, indent=2)
                )
            send(restarted_output, "/goal status")
            status = restarted_output.wait("no active goal", timeout=10, start=completion_mark)
            if renderer == "tui" and "MODE BUILD" not in status:
                raise AssertionError(f"Completion did not return TUI to BUILD mode:\n{status[-3000:]}")
            completion_audit = final_goal.get("completionAudit") or {}
            criteria = ((final_goal.get("contract") or {}).get("successCriteria") or [])
            evidence_ids = [
                evidence_id
                for criterion in criteria
                for evidence_id in (criterion.get("evidenceRefs") or [])
            ]
            final_receipts = [
                receipt
                for result in ((completion_audit.get("finalSummary") or {}).get("criterionResults") or [])
                for receipt in (result.get("evidence") or [])
            ]
            if (
                final_goal.get("status") != "complete"
                or completion_audit.get("passed") is not True
                or len(criteria) != 3
                or any(criterion.get("status") != "passed" for criterion in criteria)
                or len(set(evidence_ids)) != 3
                or len(final_receipts) != 3
                or any(receipt.get("provenance") != "runtime_automatic" for receipt in final_receipts)
            ):
                raise AssertionError(
                    "Persisted Goal did not pass the three-criterion completion audit:\n"
                    + json.dumps(final_goal, indent=2)
                )
            exit_interactively(restarted, restarted_output)
        finally:
            stop_process(restarted, restarted_master)
            server.shutdown()
            server.server_close()

    print(f"GOAL_LIFECYCLE_PTY_{renderer.upper()}_OK")


def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    renderers = [
        value.strip()
        for value in os.environ.get("ORION_GOAL_PTY_RENDERERS", "tui,terminal").split(",")
        if value.strip()
    ]
    if not renderers or any(renderer not in {"tui", "terminal"} for renderer in renderers):
        raise SystemExit("ORION_GOAL_PTY_RENDERERS must contain tui and/or terminal")
    for renderer in renderers:
        run_renderer(repo, renderer)
    print("GOAL_LIFECYCLE_PTY_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
