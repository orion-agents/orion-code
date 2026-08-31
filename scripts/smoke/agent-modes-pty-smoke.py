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
    "plan complete fixture": (
        "call-plan-read",
        "read_file",
        {"path": "seed.txt"},
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

PLAN_WORKFLOW_STEPS: tuple[tuple[str, str, dict[str, object]], ...] = (
    ("call-plan-read", "read_file", {"path": "seed.txt"}),
    (
        "call-plan-write",
        "write_file",
        {"path": "plan-created.txt", "content": "PLAN_WRITE_REUSED\n"},
    ),
    ("call-plan-exec", "exec_command", {"command": "rm -rf plan-delete"}),
)

FINAL_MARKERS = {
    "build read fixture": "BUILD_READ_DONE",
    "build write grant fixture": "BUILD_WRITE_GRANT_DONE",
    "build write reuse fixture": "BUILD_WRITE_REUSE_DONE",
    "build exec grant fixture": "BUILD_EXEC_GRANT_DONE",
    "build exec reuse delete fixture": "BUILD_EXEC_REUSE_DONE",
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
        if last_user.startswith("[Orion Plan Review V1]") and "action=approve" in last_user:
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
                if not tool_messages:
                    self.write_tool_call(
                        "call-plan-verify",
                        "exec_command",
                        {"command": "test -f plan-created.txt"},
                    )
                else:
                    getattr(self.server, "observed_tool_results").append(
                        {
                            "scenario": "plan-execution",
                            "content": message_text(tool_messages[-1]),
                        }
                    )
                    self.write_text(
                        "PLAN_EXECUTION_DONE\nImplementation completed and verified with a passing command."
                    )
            elif scenario == "plan complete fixture" and "[Plan Mode]" in system_text:
                observed = getattr(self.server, "observed_tool_results")
                if tool_messages:
                    observed.append(
                        {
                            "scenario": f"plan-step-{len(tool_messages)}",
                            "content": message_text(tool_messages[-1]),
                        }
                    )
                if len(tool_messages) < len(PLAN_WORKFLOW_STEPS):
                    self.write_tool_call(*PLAN_WORKFLOW_STEPS[len(tool_messages)])
                else:
                    self.write_text(
                        "PLAN_TURN_DONE\n"
                        "Read the repository evidence, preserve the prepared artifacts, "
                        "then implement only in a separate BUILD request and verify the result."
                    )
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
    for trace_path in config_dir.glob("projects/*/threads-v2/*.events.v1.jsonl"):
        for line in trace_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            record = json.loads(line)
            event = record.get("event", record)
            if isinstance(event, dict):
                events.append(event)
    return events


def call_expectation(call_id: str) -> tuple[str, str]:
    for scenario, (candidate, tool_name, _args) in SCENARIOS.items():
        if candidate == call_id:
            return scenario, tool_name
    for candidate, tool_name, _args in PLAN_WORKFLOW_STEPS:
        if candidate == call_id:
            return "plan complete fixture", tool_name
    raise AssertionError(f"Unknown tool call fixture: {call_id}")


def find_tool_receipt(config_dir: Path, call_id: str) -> dict[str, Any] | None:
    scenario, tool_name = call_expectation(call_id)
    events = read_trace_events(config_dir)
    turn_ids = [
        str(event.get("turnId"))
        for event in events
        if event.get("payload", {}).get("type") == "turn.started"
        and scenario in str(event.get("payload", {}).get("data", {}).get("input", ""))
    ]
    for turn_id in reversed(turn_ids):
        item_ids = [
            str(event.get("itemId"))
            for event in events
            if event.get("turnId") == turn_id
            and event.get("payload", {}).get("type") == "item.started"
            and event.get("payload", {}).get("data", {}).get("kind") == "command"
            and event.get("payload", {}).get("data", {}).get("name") == tool_name
        ]
        for item_id in reversed(item_ids):
            for event in reversed(events):
                if event.get("turnId") != turn_id or event.get("itemId") != item_id:
                    continue
                payload = event.get("payload", {})
                if payload.get("type") not in {
                    "item.completed",
                    "item.failed",
                    "item.interrupted",
                    "item.indeterminate",
                }:
                    continue
                serialized = payload.get("data", {}).get("receipt")
                if isinstance(serialized, str):
                    receipt = json.loads(serialized)
                    return {**receipt, "callId": call_id, "turnId": turn_id}
    return None


def normalize_permission_source(receipt: dict[str, Any]) -> str:
    approval = receipt.get("approval") or {}
    policy = receipt.get("policy") or {}
    if approval.get("source") == "user":
        return "user"
    if approval.get("source") == "authority":
        return "config_allow" if approval.get("approved") else "config_deny"
    source = str(policy.get("source") or "")
    behavior = policy.get("behavior")
    if source.startswith("allowlist:"):
        return f"allowlist_{behavior}"
    return "tool_policy"


def normalized_runtime_event(receipt: dict[str, Any], event_type: str) -> dict[str, Any]:
    if event_type == "tool_result":
        return {
            **receipt,
            "type": "tool_result",
            "success": receipt.get("success") is True,
        }
    if event_type == "permission_decision":
        policy = receipt.get("policy") or {}
        approval = receipt.get("approval") or {}
        behavior = policy.get("behavior")
        approved = behavior == "allow" or (
            behavior == "ask" and approval.get("approved") is True
        )
        return {
            **receipt,
            "type": "permission_decision",
            "permissionApproved": approved,
            "permissionSource": normalize_permission_source(receipt),
        }
    raise AssertionError(f"Unsupported v2 runtime event projection: {event_type}")


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
        receipt = find_tool_receipt(config_dir, call_id)
        if receipt is not None:
            return normalized_runtime_event(receipt, event_type)
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
            event.get("payload", {}).get("type")
            in {"turn.completed", "turn.failed", "turn.interrupted"}
            and event.get("turnId") == turn_id
            for event in read_trace_events(config_dir)
        ):
            return
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for completed turn {turn_id} for {call_id}")


def wait_for_plan_receipt(
    config_dir: Path,
    *,
    timeout: float = 15.0,
    fd: int | None = None,
    output: list[bytes] | None = None,
) -> dict[str, Any]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if fd is not None and output is not None:
            output.append(read_available(fd))
        events = read_trace_events(config_dir)
        turn_ids = [
            str(event.get("turnId"))
            for event in events
            if event.get("payload", {}).get("type") == "turn.started"
            and "plan complete fixture"
            in str(event.get("payload", {}).get("data", {}).get("input", ""))
        ]
        for turn_id in reversed(turn_ids):
            committed = next(
                (
                    event
                    for event in reversed(events)
                    if event.get("turnId") == turn_id
                    and event.get("payload", {}).get("type") == "turn.committed"
                ),
                None,
            )
            serialized = (
                committed.get("payload", {}).get("data", {}).get("receipt")
                if committed
                else None
            )
            if not isinstance(serialized, str):
                continue
            commit = json.loads(serialized)
            plan_serialized = commit.get("planReceipt")
            if not isinstance(plan_serialized, str):
                continue
            plan = json.loads(plan_serialized)
            if plan.get("turnId") != turn_id or plan.get("digest") != commit.get(
                "planReceiptDigest"
            ):
                raise AssertionError("PlanReceipt is not bound to its durable TurnCommit")
            if len(plan.get("toolReceiptDigests") or []) != len(PLAN_WORKFLOW_STEPS):
                raise AssertionError(f"PlanReceipt omitted tool receipts: {plan}")
            stop = json.loads(commit.get("stopDecision") or "{}")
            if stop.get("reason", {}).get("code") != "plan_ready":
                raise AssertionError(f"PLAN did not commit plan_ready: {stop}")
            return plan
        time.sleep(0.05)
    raise AssertionError("Timed out waiting for a durable PlanReceiptV1")


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
    # Keep the synthetic user request neutral. A bare prefix such as
    # "build read fixture" is parsed by the production completion gate as an
    # instruction to run a build, which correctly requires verification but is
    # not what this mode/permission smoke is asking the agent to do.
    prompt = f"perform scenario: {scenario}"
    os.write(master, prompt.encode("utf-8"))
    wait_for(master, output, prompt, timeout=5, start_offset=start)
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
    # The completed status is intentionally transient: the next TUI frame may
    # immediately replace it with context usage. The durable runtime trace is
    # the authoritative turn-completion signal; the assistant marker above
    # still proves that the rendered response reached the PTY.
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
    decision = wait_for_trace_event(config_dir, call_id, "permission_decision")
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
    repo = Path(__file__).resolve().parents[2]
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

            # PLAN exposes the complete tool set, reuses independent project
            # grants and commits one PlanReceipt. The durable review gate must
            # prevent the separate BUILD request until the user explicitly
            # approves the exact saved plan.
            os.write(master, b"\x1b[Z")
            wait_for(master, output, "MODE PLAN", timeout=6)
            plan_complete_start = submit_scenario(master, output, "plan complete fixture")
            wait_for(
                master,
                output,
                "PLAN_TURN_DONE",
                timeout=20,
                start_offset=plan_complete_start,
            )
            plan_receipt = wait_for_plan_receipt(
                config_dir, timeout=15, fd=master, output=output
            )
            if "Read the repository evidence" not in str(plan_receipt.get("plan", "")):
                raise AssertionError(f"PLAN persisted the wrong plan: {plan_receipt}")
            preapproval_requests = [
                request
                for request in getattr(mock_server, "observed_requests")
                if request.get("scenario") == "plan complete fixture"
            ]
            if any(request.get("buildMode") for request in preapproval_requests):
                raise AssertionError("PLAN started BUILD before explicit durable approval")

            output.append(read_available(master))
            approval_start = len(b"".join(output))
            os.write(master, b"/plan approve")
            wait_for(
                master,
                output,
                "/plan approve",
                timeout=5,
                start_offset=approval_start,
            )
            time.sleep(0.15)
            os.write(master, b"\r")
            wait_for(
                master,
                output,
                "Plan review approved; follow-on started.",
                timeout=15,
                start_offset=approval_start,
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
            assert_no_permission_prompt(plan_complete_segment, "PLAN completion")

            for call_id in ("call-plan-read", "call-plan-write", "call-plan-exec"):
                wait_for_call_turn_complete(
                    config_dir,
                    call_id,
                    timeout=10,
                    fd=master,
                    output=output,
                )
            require_decision(
                config_dir, "call-plan-write", approved=True, source="allowlist_allow"
            )
            require_decision(
                config_dir, "call-plan-exec", approved=True, source="allowlist_allow"
            )
            if (workspace / "plan-created.txt").read_text(
                encoding="utf-8"
            ) != "PLAN_WRITE_REUSED\n":
                raise AssertionError("PLAN did not execute the project-granted write")
            if (workspace / "plan-delete").exists():
                raise AssertionError("PLAN did not execute the project-granted command")

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

            for call_id, source in (
                ("call-auto-read", "tool_policy"),
                ("call-auto-write", "allowlist_allow"),
                ("call-auto-edit", "config_allow"),
                ("call-auto-delete", "allowlist_allow"),
            ):
                require_decision(config_dir, call_id, approved=True, source=source)

            results = parsed_tool_results(mock_server)
            for scenario in (
                "build read fixture",
                "build write grant fixture",
                "build write reuse fixture",
                "build exec grant fixture",
                "build exec reuse delete fixture",
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
            for index in range(1, len(PLAN_WORKFLOW_STEPS) + 1):
                result = results.get(f"plan-step-{index}")
                if not result or result.get("success") is not True:
                    raise AssertionError(f"PLAN tool step {index} did not succeed: {result}")
            if "alpha" not in str(results["plan-step-1"].get("output", "")):
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
