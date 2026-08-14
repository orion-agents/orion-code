#!/usr/bin/env python3
"""End-to-end PTY acceptance test for Orion BUILD, PLAN, and AUTO tools.

The smoke test starts the real source CLI in an isolated workspace, drives the
TUI with the real Shift+Tab escape sequence and permission picker, and uses a
loopback OpenAI server to request representative tools. No provider credentials
or external network are used.
"""

from __future__ import annotations

import errno
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

from pty_runner_identity import resolve_orion_command
from pty_test_config import write_mock_orion_config


ANSI_RE = re.compile(
    r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]"
)

# Use a built-in large-context model id because AutoCompact resolves context
# budgets by the runtime model id, independently of custom registry metadata.
MOCK_MODEL = "ark-code-latest"

SCENARIOS: dict[str, tuple[str, str, dict[str, object]]] = {
    "build read fixture": (
        "call-build-read",
        "read_file",
        {"path": "seed.txt"},
    ),
    "build write grant fixture": (
        "call-build-write-grant",
        "write_file",
        {"path": "build-created.txt", "content": "BUILD_PROJECT_GRANTED\n"},
    ),
    "build write reuse fixture": (
        "call-build-write-reuse",
        "write_file",
        {"path": "build-created.txt", "content": "BUILD_PROJECT_REUSED\n"},
    ),
    "build exec grant fixture": (
        "call-build-exec-grant",
        "exec_command",
        {"command": "printf BUILD_EXEC_GRANTED > build-exec.txt"},
    ),
    "build exec reuse delete fixture": (
        "call-build-exec-reuse",
        "exec_command",
        {"command": "rm -rf build-delete"},
    ),
    "build isolation fixture": (
        "call-build-guard",
        "exec_command",
        {
            "command": "printf build-guard-bypassed > escaped-build.txt",
            "cwd": "../outside",
        },
    ),
    "plan read fixture": (
        "call-plan-read",
        "read_file",
        {"path": "seed.txt"},
    ),
    "plan write reuse fixture": (
        "call-plan-write-reuse",
        "write_file",
        {"path": "plan-created.txt", "content": "PLAN_WRITE_REUSED\n"},
    ),
    "plan exec reuse delete fixture": (
        "call-plan-exec-reuse",
        "exec_command",
        {"command": "rm -rf plan-delete"},
    ),
    "plan complete fixture": (
        "call-plan-exit",
        "exit_plan_mode",
        {
            "plan": "Read the repository evidence, then implement only in a separate BUILD request and verify the result."
        },
    ),
    "auto read fixture": (
        "call-auto-read",
        "read_file",
        {"path": "seed.txt"},
    ),
    "auto write fixture": (
        "call-auto-write",
        "write_file",
        {"path": "auto-created.txt", "content": "AUTO_WRITE_CONTENT\n"},
    ),
    "auto edit fixture": (
        "call-auto-edit",
        "edit_file",
        {
            "path": "auto-created.txt",
            "old_string": "AUTO_WRITE_CONTENT",
            "new_string": "AUTO_EDITED_CONTENT",
        },
    ),
    "auto destructive delete fixture": (
        "call-auto-delete",
        "exec_command",
        {"command": "rm -rf delete-me"},
    ),
    "auto isolation fixture": (
        "call-auto-guard",
        "exec_command",
        {
            "command": "printf guard-bypassed > escaped.txt",
            "cwd": "../outside",
        },
    ),
}

FINAL_MARKERS = {
    "build read fixture": "BUILD_READ_DONE",
    "build write grant fixture": "BUILD_WRITE_GRANT_DONE",
    "build write reuse fixture": "BUILD_WRITE_REUSE_DONE",
    "build exec grant fixture": "BUILD_EXEC_GRANT_DONE",
    "build exec reuse delete fixture": "BUILD_EXEC_REUSE_DONE",
    "plan read fixture": "PLAN_READ_DONE",
    "plan write reuse fixture": "PLAN_WRITE_REUSE_DONE",
    "plan exec reuse delete fixture": "PLAN_EXEC_REUSE_DONE",
    "auto read fixture": "AUTO_READ_DONE",
    "auto write fixture": "AUTO_WRITE_DONE",
    "auto edit fixture": "AUTO_EDIT_DONE",
    "auto destructive delete fixture": "AUTO_DELETE_DONE",
}


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
        except OSError as exc:
            if exc.errno in (errno.EIO, errno.EBADF):
                break
            raise
        if not chunk:
            break
        chunks.append(chunk)
        timeout = 0
    return b"".join(chunks)


def output_text(output: list[bytes], start_offset: int = 0) -> str:
    return strip_ansi(
        b"".join(output)[start_offset:].decode("utf-8", errors="replace")
    )


def wait_for(
    fd: int,
    output: list[bytes],
    needle: str,
    *,
    timeout: float = 12.0,
    start_offset: int = 0,
) -> str:
    deadline = time.time() + timeout
    plain = ""
    while time.time() < deadline:
        output.append(read_available(fd))
        plain = output_text(output, start_offset)
        if needle in plain:
            return plain
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for {needle!r}. Tail:\n{plain[-3000:]}")


def message_text(message: dict[str, Any]) -> str:
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            str(part.get("text", ""))
            for part in content
            if isinstance(part, dict)
        )
    return str(content)


class AgentModesMockHandler(BaseHTTPRequestHandler):
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
        if not isinstance(messages, list):
            messages = []

        last_user_index = -1
        last_user = ""
        for index, candidate in enumerate(messages):
            if isinstance(candidate, dict) and candidate.get("role") == "user":
                last_user_index = index
                last_user = message_text(candidate).strip()

        scenario = next((name for name in SCENARIOS if name in last_user), "")
        if (
            last_user.startswith("Execute the saved plan now.")
            and "Read the repository evidence" in last_user
        ):
            scenario = "plan complete fixture"
        later_messages = messages[last_user_index + 1 :] if last_user_index >= 0 else []
        tool_messages = [
            candidate
            for candidate in later_messages
            if isinstance(candidate, dict) and candidate.get("role") == "tool"
        ]
        system_text = "\n".join(
            message_text(candidate)
            for candidate in messages
            if isinstance(candidate, dict) and candidate.get("role") == "system"
        )
        getattr(self.server, "observed_requests").append(
            {
                "lastUser": last_user,
                "scenario": scenario,
                "stream": request.get("stream"),
                "buildMode": "[Build Mode]" in system_text,
                "planMode": "[Plan Mode]" in system_text,
                "roles": [
                    candidate.get("role")
                    for candidate in messages[-8:]
                    if isinstance(candidate, dict)
                ],
            }
        )

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        try:
            if not scenario:
                self.write_text("AGENT_MODE_UNKNOWN_SCENARIO")
            elif scenario == "plan complete fixture" and "[Build Mode]" in system_text:
                self.write_text("PLAN_EXECUTION_DONE")
            elif tool_messages:
                observed = getattr(self.server, "observed_tool_results")
                observed.append(
                    {
                        "scenario": scenario,
                        "content": message_text(tool_messages[-1]),
                    }
                )
                self.write_text(
                    "PLAN_TURN_DONE"
                    if scenario == "plan complete fixture"
                    else FINAL_MARKERS.get(scenario, "AGENT_MODE_TOOL_DONE")
                )
            else:
                call_id, name, args = SCENARIOS[scenario]
                self.write_tool_call(call_id, name, args)
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return

    def write_chunk(
        self,
        delta: dict[str, object],
        *,
        finish_reason: str | None = None,
    ) -> None:
        payload = {
            "id": "chatcmpl-orion-agent-modes-pty",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": MOCK_MODEL,
            "choices": [
                {
                    "index": 0,
                    "delta": delta,
                    "finish_reason": finish_reason,
                }
            ],
        }
        if finish_reason is not None:
            payload["usage"] = {"prompt_tokens": 12, "completion_tokens": 4}
        self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode("utf-8"))
        self.wfile.flush()

    def write_text(self, value: str) -> None:
        self.write_chunk({"content": value})
        self.write_chunk({}, finish_reason="stop")

    def write_tool_call(
        self,
        call_id: str,
        name: str,
        args: dict[str, object],
    ) -> None:
        self.write_chunk(
            {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": json.dumps(args),
                        },
                    }
                ]
            }
        )
        self.write_chunk({}, finish_reason="tool_calls")


def start_mock_server() -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), AgentModesMockHandler)
    setattr(server, "observed_tool_results", [])
    setattr(server, "observed_requests", [])
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    return server, f"http://{host}:{port}/v1"


def spawn_orion(
    repo: Path,
    workspace: Path,
    config_dir: Path,
) -> tuple[subprocess.Popen[bytes], int, int]:
    master, slave = pty.openpty()
    env = os.environ.copy()
    env.update(
        {
            "ORION_CODE_CONFIG_DIR": str(config_dir),
            "ORION_CODE_API_KEY": "sk-orion-agent-modes-pty",
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "FORCE_COLOR": "0",
            "TS_NODE_PROJECT": str(repo / "tsconfig.json"),
            "TS_NODE_CWD": str(repo),
        }
    )
    node = env.get("ORION_PTY_NODE", "node")
    command = resolve_orion_command(
        repo,
        [
            node,
            "-r",
            str(repo / "node_modules" / "ts-node" / "register"),
            str(repo / "src" / "cli.ts"),
        ],
    )
    process = subprocess.Popen(
        command,
        cwd=workspace,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        start_new_session=True,
    )
    return process, master, slave


def stop_process(
    process: subprocess.Popen[bytes],
    master: int | None,
    slave: int | None,
) -> None:
    if process.poll() is None and master is not None:
        for _ in range(4):
            try:
                os.write(master, b"\x03")
            except OSError:
                break
            time.sleep(0.15)
            if process.poll() is not None:
                break
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except OSError:
            process.kill()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
    for fd in (master, slave):
        if fd is None:
            continue
        try:
            os.close(fd)
        except OSError:
            pass


def read_trace_events(config_dir: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for trace_path in config_dir.glob("projects/*/sessions/*.trace.jsonl"):
        for line in trace_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            events.append(json.loads(line))
    return events


def wait_for_trace_event(
    config_dir: Path,
    call_id: str,
    event_type: str,
    *,
    timeout: float = 12.0,
    fd: int | None = None,
    output: list[bytes] | None = None,
) -> dict[str, Any]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if fd is not None and output is not None:
            output.append(read_available(fd))
        for event in read_trace_events(config_dir):
            if event.get("callId") == call_id and event.get("type") == event_type:
                return event
        time.sleep(0.05)
    raise AssertionError(
        f"Timed out waiting for trace {event_type}:{call_id}; "
        f"events={read_trace_events(config_dir)[-20:]}"
    )


def wait_for_call_turn_complete(
    config_dir: Path,
    call_id: str,
    *,
    timeout: float = 12.0,
    fd: int | None = None,
    output: list[bytes] | None = None,
) -> None:
    tool_result = wait_for_trace_event(
        config_dir,
        call_id,
        "tool_result",
        timeout=timeout,
        fd=fd,
        output=output,
    )
    turn_id = tool_result.get("turnId")
    deadline = time.time() + timeout
    while time.time() < deadline:
        if fd is not None and output is not None:
            output.append(read_available(fd))
        if any(
            event.get("type") == "complete" and event.get("turnId") == turn_id
            for event in read_trace_events(config_dir)
        ):
            return
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for completed turn {turn_id} for {call_id}")


def parsed_tool_results(server: ThreadingHTTPServer) -> dict[str, dict[str, Any]]:
    parsed: dict[str, dict[str, Any]] = {}
    for item in getattr(server, "observed_tool_results"):
        parsed[item["scenario"]] = json.loads(item["content"])
    return parsed


def assert_no_permission_prompt(value: str, label: str) -> None:
    forbidden = (
        "Tool Permission",
        "requires user confirmation",
        "denied by toolConfirmation=deny",
    )
    matched = next((needle for needle in forbidden if needle in value), None)
    if matched:
        raise AssertionError(f"{label} opened or reported a permission prompt: {matched}\n{value[-3000:]}")


def submit_scenario(master: int, output: list[bytes], scenario: str) -> int:
    output.append(read_available(master))
    start = len(b"".join(output))
    os.write(master, scenario.encode("utf-8"))
    wait_for(master, output, scenario, timeout=5, start_offset=start)
    time.sleep(0.15)
    os.write(master, b"\r")
    return start


def wait_for_successful_scenario(
    master: int,
    output: list[bytes],
    config_dir: Path,
    scenario: str,
    *,
    start: int,
    timeout: float = 20.0,
) -> str:
    marker = FINAL_MARKERS[scenario]
    segment = wait_for(master, output, marker, timeout=timeout, start_offset=start)
    segment = wait_for(
        master,
        output,
        f"Completed with {MOCK_MODEL}",
        timeout=10,
        start_offset=start,
    )
    wait_for_call_turn_complete(
        config_dir,
        SCENARIOS[scenario][0],
        timeout=10,
        fd=master,
        output=output,
    )
    time.sleep(0.15)
    return segment


def require_decision(
    config_dir: Path,
    call_id: str,
    *,
    approved: bool,
    source: str,
) -> dict[str, Any]:
    decision = next(
        (
            event
            for event in read_trace_events(config_dir)
            if event.get("type") == "permission_decision"
            and event.get("callId") == call_id
        ),
        None,
    )
    if not decision:
        raise AssertionError(f"Missing permission decision for {call_id}")
    if decision.get("permissionApproved") is not approved:
        raise AssertionError(f"Unexpected approval for {call_id}: {decision}")
    if decision.get("permissionSource") != source:
        raise AssertionError(f"Unexpected permission source for {call_id}: {decision}")
    return decision


def project_grants(config_dir: Path, workspace: Path) -> list[str]:
    payload = json.loads((config_dir / "orion.json").read_text(encoding="utf-8"))
    project = payload.get("projects", {}).get(str(workspace.resolve()), {})
    grants = project.get("allowedTools", [])
    return [str(value) for value in grants] if isinstance(grants, list) else []


def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    mock_server, base_url = start_mock_server()
    process: subprocess.Popen[bytes] | None = None
    master: int | None = None
    slave: int | None = None
    output: list[bytes] = []

    try:
        with tempfile.TemporaryDirectory(prefix="orion-agent-modes-pty-") as root_value:
            root = Path(root_value)
            workspace = root / "workspace"
            outside = root / "outside"
            config_dir = root / "config"
            workspace.mkdir()
            outside.mkdir()
            (workspace / "seed.txt").write_text("alpha\n", encoding="utf-8")
            (workspace / "build-delete").mkdir()
            (workspace / "build-delete" / "nested.txt").write_text(
                "delete in build\n", encoding="utf-8"
            )
            (workspace / "plan-delete").mkdir()
            (workspace / "plan-delete" / "nested.txt").write_text(
                "must survive plan\n", encoding="utf-8"
            )
            (workspace / "delete-me").mkdir()
            (workspace / "delete-me" / "nested.txt").write_text("delete me\n", encoding="utf-8")
            subprocess.run(
                ["git", "init", "--quiet"],
                cwd=workspace,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            write_mock_orion_config(
                config_dir,
                base_url=base_url,
                model=MOCK_MODEL,
                tool_confirmation="ask",
            )
            process, master, slave = spawn_orion(repo, workspace, config_dir)

            wait_for(master, output, "ORION CODE | 猎户座", timeout=25)
            wait_for(master, output, "MODE BUILD", timeout=25)

            # BUILD: safe reads run directly.
            build_read_start = submit_scenario(master, output, "build read fixture")
            build_read_segment = wait_for_successful_scenario(
                master,
                output,
                config_dir,
                "build read fixture",
                start=build_read_start,
            )
            assert_no_permission_prompt(build_read_segment, "BUILD read")

            # BUILD: first write is explicitly granted for the project.
            build_write_grant_start = submit_scenario(
                master, output, "build write grant fixture"
            )
            permission_view = wait_for(
                master,
                output,
                "Tool Permission: write_file",
                timeout=12,
                start_offset=build_write_grant_start,
            )
            if "Always allow in this project" not in permission_view:
                raise AssertionError("BUILD write prompt did not expose project-scoped consent")
            os.write(master, b"p")
            build_write_grant_segment = wait_for_successful_scenario(
                master,
                output,
                config_dir,
                "build write grant fixture",
                start=build_write_grant_start,
            )
            if "Tool Permission: write_file" not in build_write_grant_segment:
                raise AssertionError("BUILD write did not request its first explicit permission")
            require_decision(
                config_dir, "call-build-write-grant", approved=True, source="user"
            )
            if "allow:write_file" not in project_grants(config_dir, workspace):
                raise AssertionError("BUILD project write grant was not persisted")

            # The persisted write grant must suppress the next prompt.
            build_write_reuse_start = submit_scenario(
                master, output, "build write reuse fixture"
            )
            build_write_reuse_segment = wait_for_successful_scenario(
                master,
                output,
                config_dir,
                "build write reuse fixture",
                start=build_write_reuse_start,
            )
            assert_no_permission_prompt(build_write_reuse_segment, "BUILD reused write grant")
            require_decision(
                config_dir,
                "call-build-write-reuse",
                approved=True,
                source="allowlist_allow",
            )

            # Repeat the same grant/reuse contract for shell execution, including
            # a destructive command inside the isolated workspace.
            build_exec_grant_start = submit_scenario(
                master, output, "build exec grant fixture"
            )
            permission_view = wait_for(
                master,
                output,
                "Tool Permission: exec_command",
                timeout=12,
                start_offset=build_exec_grant_start,
            )
            if "Always allow in this project" not in permission_view:
                raise AssertionError("BUILD exec prompt did not expose project-scoped consent")
            os.write(master, b"p")
            build_exec_grant_segment = wait_for_successful_scenario(
                master,
                output,
                config_dir,
                "build exec grant fixture",
                start=build_exec_grant_start,
            )
            if "Tool Permission: exec_command" not in build_exec_grant_segment:
                raise AssertionError("BUILD exec did not request its first explicit permission")
            require_decision(
                config_dir, "call-build-exec-grant", approved=True, source="user"
            )
            if "allow:exec_command" not in project_grants(config_dir, workspace):
                raise AssertionError("BUILD project exec grant was not persisted")

            build_exec_reuse_start = submit_scenario(
                master, output, "build exec reuse delete fixture"
            )
            build_exec_reuse_segment = wait_for_successful_scenario(
                master,
                output,
                config_dir,
                "build exec reuse delete fixture",
                start=build_exec_reuse_start,
            )
            assert_no_permission_prompt(build_exec_reuse_segment, "BUILD reused exec grant")
            require_decision(
                config_dir,
                "call-build-exec-reuse",
                approved=True,
                source="allowlist_allow",
            )

            # A project grant never overrides the workspace containment policy.
            build_guard_start = submit_scenario(master, output, "build isolation fixture")
            build_guard_decision = wait_for_trace_event(
                config_dir,
                "call-build-guard",
                "permission_decision",
                timeout=20,
                fd=master,
                output=output,
            )
            build_guard_result = wait_for_trace_event(
                config_dir,
                "call-build-guard",
                "tool_result",
                timeout=20,
                fd=master,
                output=output,
            )
            wait_for_call_turn_complete(
                config_dir,
                "call-build-guard",
                timeout=10,
                fd=master,
                output=output,
            )
            build_guard_segment = output_text(output, build_guard_start)
            assert_no_permission_prompt(build_guard_segment, "BUILD cwd guard")
            if build_guard_decision.get("permissionApproved") is not False:
                raise AssertionError(f"BUILD cwd guard was not denied: {build_guard_decision}")
            if build_guard_decision.get("permissionSource") != "tool_policy":
                raise AssertionError(
                    f"BUILD cwd guard used the wrong source: {build_guard_decision}"
                )
            if build_guard_result.get("success") is not False:
                raise AssertionError(f"BUILD cwd guard reported success: {build_guard_result}")
            if (outside / "escaped-build.txt").exists():
                raise AssertionError("BUILD project grant bypassed the workspace cwd guard")

            if (workspace / "build-created.txt").read_text(
                encoding="utf-8"
            ) != "BUILD_PROJECT_REUSED\n":
                raise AssertionError("BUILD project write grant did not execute both writes")
            if (workspace / "build-exec.txt").read_text(
                encoding="utf-8"
            ) != "BUILD_EXEC_GRANTED":
                raise AssertionError("BUILD project exec grant did not execute the command")
            if (workspace / "build-delete").exists():
                raise AssertionError("BUILD reused exec grant did not remove its fixture")

            # PLAN exposes the complete tool set and reuses the independent
            # project grants established in BUILD.
            os.write(master, b"\x1b[Z")
            wait_for(master, output, "MODE PLAN", timeout=6)

            plan_read_start = submit_scenario(master, output, "plan read fixture")
            plan_read_segment = wait_for_successful_scenario(
                master,
                output,
                config_dir,
                "plan read fixture",
                start=plan_read_start,
            )
            assert_no_permission_prompt(plan_read_segment, "PLAN read")

            plan_write_start = submit_scenario(master, output, "plan write reuse fixture")
            plan_write_segment = wait_for_successful_scenario(
                master,
                output,
                config_dir,
                "plan write reuse fixture",
                start=plan_write_start,
            )
            assert_no_permission_prompt(plan_write_segment, "PLAN reused write grant")
            require_decision(
                config_dir,
                "call-plan-write-reuse",
                approved=True,
                source="allowlist_allow",
            )
            if (workspace / "plan-created.txt").read_text(
                encoding="utf-8"
            ) != "PLAN_WRITE_REUSED\n":
                raise AssertionError("PLAN did not execute the project-granted write")

            plan_exec_start = submit_scenario(
                master, output, "plan exec reuse delete fixture"
            )
            plan_exec_segment = wait_for_successful_scenario(
                master,
                output,
                config_dir,
                "plan exec reuse delete fixture",
                start=plan_exec_start,
            )
            assert_no_permission_prompt(plan_exec_segment, "PLAN reused exec grant")
            require_decision(
                config_dir,
                "call-plan-exec-reuse",
                approved=True,
                source="allowlist_allow",
            )
            if (workspace / "plan-delete").exists():
                raise AssertionError("PLAN did not execute the project-granted command")

            # Completing a plan must save it, exit automatically, and launch a
            # distinct execution request in BUILD without a permission prompt.
            plan_complete_start = submit_scenario(master, output, "plan complete fixture")
            wait_for(
                master,
                output,
                "PLAN_TURN_DONE",
                timeout=20,
                start_offset=plan_complete_start,
            )
            plan_complete_segment = wait_for(
                master,
                output,
                "PLAN_EXECUTION_DONE",
                timeout=25,
                start_offset=plan_complete_start,
            )
            wait_for(
                master,
                output,
                "MODE BUILD",
                timeout=10,
                start_offset=plan_complete_start,
            )
            wait_for_call_turn_complete(
                config_dir,
                "call-plan-exit",
                timeout=10,
                fd=master,
                output=output,
            )
            assert_no_permission_prompt(plan_complete_segment, "PLAN completion")

            mode_requests = [
                request
                for request in getattr(mock_server, "observed_requests")
                if request.get("scenario") == "plan complete fixture"
            ]
            if not any(request.get("planMode") for request in mode_requests):
                raise AssertionError("PLAN completion never reached a Plan-mode provider request")
            if not any(request.get("buildMode") for request in mode_requests):
                raise AssertionError("PLAN completion did not start a separate BUILD request")

            # AUTO remains fully authorized after hard policy checks. Cycle from
            # BUILD through PLAN into AUTO using the real terminal sequence.
            os.write(master, b"\x1b[Z")
            wait_for(master, output, "MODE PLAN", timeout=6)
            os.write(master, b"\x1b[Z")
            wait_for(master, output, "MODE AUTO", timeout=6)

            # Exercise a hard workspace boundary before any successful turn so
            # the assertion cannot be confused with an end-of-turn input race.
            guard_start = len(b"".join(output))
            os.write(master, b"auto isolation fixture")
            wait_for(
                master,
                output,
                "auto isolation fixture",
                timeout=5,
                start_offset=guard_start,
            )
            time.sleep(0.2)
            os.write(master, b"\r")
            guard_decision = wait_for_trace_event(
                config_dir,
                "call-auto-guard",
                "permission_decision",
                timeout=20,
                fd=master,
                output=output,
            )
            guard_result = wait_for_trace_event(
                config_dir,
                "call-auto-guard",
                "tool_result",
                timeout=20,
                fd=master,
                output=output,
            )
            wait_for_call_turn_complete(
                config_dir,
                "call-auto-guard",
                timeout=10,
                fd=master,
                output=output,
            )
            output.append(read_available(master, timeout=0.5))
            assert_no_permission_prompt(output_text(output, guard_start), "cwd guard")
            if (outside / "escaped.txt").exists():
                raise AssertionError("AUTO bypassed the workspace cwd guard")
            if guard_decision.get("permissionApproved") is not False:
                raise AssertionError(f"cwd guard was not denied: {guard_decision}")
            if guard_decision.get("permissionSource") != "tool_policy":
                raise AssertionError(f"cwd guard used the wrong decision source: {guard_decision}")
            if guard_result.get("success") is not False:
                raise AssertionError(f"cwd guard reported success: {guard_result}")
            time.sleep(0.5)

            for scenario in (
                "auto read fixture",
                "auto write fixture",
                "auto edit fixture",
                "auto destructive delete fixture",
            ):
                segment_start = submit_scenario(master, output, scenario)
                segment = wait_for_successful_scenario(
                    master,
                    output,
                    config_dir,
                    scenario,
                    start=segment_start,
                )
                assert_no_permission_prompt(segment, scenario)

            if (workspace / "auto-created.txt").read_text(encoding="utf-8") != "AUTO_EDITED_CONTENT\n":
                raise AssertionError("AUTO write/edit tools did not persist the expected final content")
            if (workspace / "delete-me").exists():
                raise AssertionError("AUTO destructive exec did not remove the isolated fixture directory")

            for call_id in (
                "call-auto-read",
                "call-auto-write",
                "call-auto-edit",
                "call-auto-delete",
            ):
                require_decision(config_dir, call_id, approved=True, source="mode_auto")

            results = parsed_tool_results(mock_server)
            for scenario in (
                "build read fixture",
                "build write grant fixture",
                "build write reuse fixture",
                "build exec grant fixture",
                "build exec reuse delete fixture",
                "plan read fixture",
                "plan write reuse fixture",
                "plan exec reuse delete fixture",
                "plan complete fixture",
                "auto read fixture",
                "auto write fixture",
                "auto edit fixture",
                "auto destructive delete fixture",
            ):
                result = results.get(scenario)
                if not result or result.get("success") is not True:
                    raise AssertionError(f"Tool result was not successful for {scenario}: {result}")
            if "alpha" not in str(results["build read fixture"].get("output", "")):
                raise AssertionError("BUILD read result did not contain the fixture content")
            if "alpha" not in str(results["plan read fixture"].get("output", "")):
                raise AssertionError("PLAN read result did not contain the fixture content")
            if "alpha" not in str(results["auto read fixture"].get("output", "")):
                raise AssertionError("AUTO read result did not contain the fixture content")

            print("AGENT_MODES_PTY_OK")
            return 0
    except Exception as exc:
        if master is not None:
            output.append(read_available(master))
        print(
            f"{exc}\nmock requests={getattr(mock_server, 'observed_requests')}"
            f"\n--- agent modes PTY output tail ---\n{output_text(output)[-5000:]}",
            flush=True,
        )
        return 1
    finally:
        mock_server.shutdown()
        mock_server.server_close()
        if process is not None:
            stop_process(process, master, slave)


if __name__ == "__main__":
    raise SystemExit(main())
