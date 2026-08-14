# Orion Code

> **Goal-driven coding agent for the terminal.**
>
> v0.1.8 candidate — repository hygiene, audited issue fixes, and actionable runtime recovery

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.0-blue.svg)](https://www.typescriptlang.org)

---

**Language**: [English](README.md) | [简体中文](README.zh-CN.md)

---

## Overview

Orion Code is a terminal-based coding agent. It wraps LLM APIs in a harness of safety checks, tool orchestration, session management, and context awareness.

| Dimension         | Description                                            |
| ----------------- | ------------------------------------------------------ |
| **Agent Harness** | Safety boundaries, task constraints, result validation |
| **Tool Calling**  | LLM autonomously invokes tools to complete tasks       |
| **Memory System** | Layered memory with semantic search                    |
| **MCP Protocol**  | Connect external MCP servers for tool extension        |

## Quick Start

### Requirements

- Node.js 20, 22, or 24 LTS
- npm >= 9.0

### Install & Run

```bash
# Install this exact version after the candidate is published:
npm install -g @orion-agents/orion-code@0.1.8
# Install the current prerelease channel:
npm install -g @orion-agents/orion-code@next

# Or run from a checked-out source tree:
npm ci
npm run build
npm start

# Configure API key
export ORION_CODE_API_KEY=your-api-key
# or create ~/.orion-code/orion.json on first run

# Start
orion

# TUI renderer (default)
orion --ui tui

# Technical terminal renderer for diagnostics and compatibility
orion --ui terminal

# Deprecated compatibility renderer; scheduled for removal in v0.2.0
orion --ui ink

# Diagnostics
orion doctor

# Workspace diff
orion diff

# Commit plan
orion commit-plan

# Experimental non-interactive print mode
orion -p "review the current git diff"
echo "summarize this project" | orion --print
```

> **Release status.** The source tree is an unpublished `0.1.8` candidate: it has no release tag,
> GitHub Release, or npm artifact yet. `0.1.7` remains the published `next` version and stable
> `latest` remains `0.1.4`; promotion is a separate release decision.

### TUI startup banner

The default TUI uses the original Orion Pixel theme and a portable “little star hunter” mascot.
Typed chrome keeps Goal, permission, model, context, queue, and active-work state visible without
polluting code or tool output. It uses only safe terminal character cells: classic mode,
`NO_COLOR`, and narrow terminals automatically fall back to compact text with no image protocol.

```bash
# Default portable pixel banner
ORION_TUI_IMAGE=off orion

# Opt into a PNG in compatible terminals
ORION_TUI_IMAGE=auto orion
ORION_TUI_IMAGE=kitty orion
ORION_TUI_IMAGE=iterm2 orion

# Override the bundled PNG
ORION_TUI_ICON=/absolute/path/to/icon.png orion
```

Apple Terminal does not support either inline image protocol. Capability detection
therefore selects the pixel banner instead of emitting image data. Real macOS
Terminal validation remains part of the release gate.

## Key Features

| Feature                | Description                                                                   |
| ---------------------- | ----------------------------------------------------------------------------- |
| **Tool Orchestration** | 29 built-in tools: file I/O, shell, web, memory, git, LSP, Goal, and planning |
| **Multi-Model**        | Provider profiles, model switching, and explicit effort capabilities          |
| **Context Awareness**  | Per-model context windows, token-based auto-compact                           |
| **MCP Protocol**       | stdio MCP servers with heartbeat + reconnect                                  |
| **Memory System**      | User / Project / Session memory with semantic search                          |
| **Session Management** | Persistent sessions with history restore                                      |
| **Persistent Goal**    | Typed multi-turn continuation, safe restart/resume, criterion evidence audit  |
| **Safety Boundaries**  | Bash safety checks, audit logging, permission modes                           |
| **Skills System**      | Builtin + user + project-level skill extensions                               |
| **Multi-Agent**        | Subagent fork/worker-pool with smart routing                                  |
| **CLI Utilities**      | `doctor`, `diff`, `commit-plan`, experimental `-p` print mode                 |

## Configuration

```json
{
  "providers": [
    {
      "id": "my-provider",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "$MY_API_KEY",
      "protocol": "openai-completions"
    }
  ],
  "models": [
    {
      "id": "my-model",
      "provider": "my-provider",
      "model": "model-name",
      "contextWindow": 200000,
      "maxOutputTokens": 64000,
      "reasoningCapability": {
        "kind": "effort-level",
        "supportedLevels": ["low", "medium", "high"],
        "defaultLevel": "medium",
        "adapter": "openai-chat-reasoning-effort",
        "source": "config"
      }
    }
  ],
  "defaultModel": "my-model",
  "defaultEffort": "auto",
  "toolConfirmation": "deny",
  "subagents": { "mode": "auto", "maxParallel": 3 }
}
```

Configuration: `~/.orion-code/orion.json` | Priority: `CLI flags > config > env vars > defaults`

`reasoningCapability` is an explicit provider contract, not a model-name guess. Only add it
after the configured endpoint is known to accept the selected adapter and levels. A legacy
`"reasoning": true` flag does not enable a wire parameter. With no explicit capability Orion
keeps `/effort` unavailable and sends no reasoning-effort override. Project defaults can be set
with `projects["<absolute path>"].defaultEffort`; session overrides are changed with `/effort`.

The renderer is a runtime choice rather than a persisted setting: `orion` starts
the TUI, while `--ui terminal` selects the technical renderer.

### Interactive and scoped tool permissions (`allowedTools`)

When a tool needs confirmation, the TUI, Ink UI, and technical Terminal renderer wait for one
of four explicit decisions: allow once, always allow this tool in the current project, always
allow it on this machine for every project, or deny. Persistent approvals are written before
the waiting tool continues. A write failure denies the call.

Machine-wide rules live at root `allowedTools`; project rules live under
`projects["<absolute path>"].allowedTools`. Both sets are evaluated, and the most restrictive
matching effect wins (`deny` > `ask` > `allow`). Choosing project or machine scope is explicit
durable consent for that tool, so a durable `allow` skips repeated prompts for external tools, file
edits, and shell operations that are not hard-blocked by command safety policy. AUTO skips all
interactive prompts and authorizes every invocation after hard tool-policy and explicit `deny`
checks. PLAN exposes the same registry as BUILD and inherits the independently selected permission
policy, including durable project or machine grants.

```json
{
  "allowedTools": ["allow:web_fetch"],
  "projects": {
    "/Users/me/work/api": {
      "allowedTools": [
        "exec_command(git status*)",
        "exec_command(npm test*)",
        "ask:exec_command(git push*)",
        "deny:read_file(*.env)"
      ]
    }
  }
}
```

- Grammar: `[allow|ask|deny:]tool[(subject glob)]`; `*` matches any run of characters,
  `?` a single one, and `*` as the tool name matches every tool.
- The subject is the call's `command` / `file_path` / `path` / `url` / `pattern` / `query`
  argument, whichever comes first.
- Conflicts resolve most-restrictive-first (`deny` > `ask` > `allow`), independent of order.
- Interactive persistent choices add an exact tool rule such as `allow:exec_command`; edit
  `~/.orion-code/orion.json` to audit or revoke a stored rule. `/permissions show` reports the
  active machine-wide and project rule counts.
- `allow` skips an interactive confirmation. It never overrides a tool's own `deny`, an explicit
  allowlist `deny`, workspace containment, sandbox restrictions, or hard command safety policy.
- Malformed entries are ignored and listed by `/config` rather than silently applied.

### Shell execution sandbox (`sandbox`)

`exec_command` can run inside an OS-level sandbox. This is a **security POC**: the
backend is probed at runtime and a configured-but-unusable sandbox **fails closed**
(refuses to run) rather than silently degrading to an unsandboxed execution.

```json
{
  "sandbox": {
    "profile": "none",
    "backend": "auto",
    "allowNetwork": false,
    "writableRoots": [],
    "image": "alpine:latest"
  }
}
```

- **Ownership** — `sandbox` lives in the global config (`~/.orion-code/orion.json`)
  and can be overridden per project under `projects["<path>"].sandbox`. Project
  keys win individually; absent keys inherit the global value.
- **`profile`** — `none` (default, no isolation, identical to the legacy `sh -c`),
  `read-only` (no writes anywhere, no network), or `workspace-write` (writes
  confined to the workspace + temp dirs, network still blocked unless
  `allowNetwork: true`). An unknown value (e.g. written by a newer Orion) is a
  hard failure, never a downgrade to `none`.
- **`backend`** — `auto` (default, picks the first usable backend), `seatbelt`
  (macOS `sandbox-exec`), `bubblewrap` (Linux `bwrap`), or `docker`. Each backend
  is validated with a real execution probe; `which`-based guessing is never used.
- **`image`** — required only for `docker`; names the container image to run in.
- **`writableRoots`** — extra host roots the `workspace-write` profile may write
  to (in addition to the cwd and temp). Non-string / empty entries are dropped.
- **Migration / rollback** — adding the `sandbox` key is backward compatible: the
  default `profile: "none"` reproduces the previous behaviour exactly. Removing the
  key (or reverting to a pre-sandbox version) is a safe rollback; older Orion
  simply ignores the unknown field. No secrets are stored, so no redaction is
  required.
- **Known limitations** — `seatbelt` cannot be nested inside another sandbox (e.g.
  when Orion itself runs inside an app sandbox); `docker` runs the command in a
  separate process tree and only constrains what is bind-mounted (the image rootfs
  is made read-only via `--read-only`); none of the backends constrain CPU/memory.

## Interactive Commands

| Command                | Description                                                                 |
| ---------------------- | --------------------------------------------------------------------------- |
| `/help`                | Show help                                                                   |
| `/goal`                | Create, inspect, pause, resume, replace, budget, or exit a persistent goal  |
| `/plan [task]`         | Plan with normal tool access, save it, then restore the previous agent mode |
| `/status`              | System status                                                               |
| `/model`               | View or switch models                                                       |
| `/effort`              | View or change supported reasoning effort                                   |
| `/permissions`         | View or change tool confirmation and edit policy                            |
| `/config`              | Show configuration                                                          |
| `/usage`               | Token usage and cost                                                        |
| `/compact`             | Trigger context compact                                                     |
| `/session`             | List, inspect, or rename sessions                                           |
| `/resume`              | Resume last session                                                         |
| `/memory`              | Memory status, reference validation, and semantic reindexing                |
| `/skills`              | List loaded skills                                                          |
| `/mcp`                 | MCP server status                                                           |
| `/doctor`              | Run diagnostics                                                             |
| `/diff`                | Workspace diff                                                              |
| `/commit-plan`         | Create a read-only commit plan                                              |
| `/clear`               | Clear screen                                                                |
| `/context clear --yes` | Clear in-memory model context; preserve the saved session                   |
| `/exit`                | Exit                                                                        |

Agent modes are TUI actions: use `Shift+Tab` to cycle `BUILD → PLAN → AUTO`; `/mode` and `/perm`
are not registered commands. The remaining deprecated spellings keep their v0.3.0 compatibility
window: `/target` → `/goal`, `/commit` → `/commit-plan`, `/sessions` → `/session list`,
`/session-rename` → `/session rename`, `/context-clear` and `/clear-history` → `/context clear`,
`/models` → `/model`, `/loop-stats` → `/usage loop`, `/checkpoint` → `/rewind`, `/cost` → `/usage`,
`/agents` → `/subagents`, `/task` → `/goal`, and `/run` or `/chat` → plain text.

TUI is the public product interface and the default launch path. `terminal-ui`
is maintained as a technical diagnostics/compatibility renderer, not a second
public product. Ink is deprecated, receives no new product features, and is
scheduled for removal in v0.2.0.

### Task-scoped Plan mode

Use `/plan` to arm planning for the next message, `/plan <task>` to start immediately, or press
`Shift+Tab` to cycle `BUILD → PLAN → AUTO → BUILD` while preserving the draft. Orion allows
the complete tool registry in every Agent mode. PLAN never blocks a call solely because of the
mode: writes, commands, and external tools use the current `/permissions` policy and reusable
project/machine grants. Explicit denies, workspace containment, sandboxing, and hard safety rules
remain enforced. When the plan is decision-complete, the model calls `exit_plan_mode` once;
Orion saves it, exits Plan, and starts implementation in a separate logical request. Base modes are
changed only with `Shift+Tab`; the retired `/mode` and `/perm` commands are not compatibility entry
points. Auto runs without permission or clarification prompts, while hard safety policies and
explicit user boundaries remain enforced.

See [the Plan-mode lifecycle contract](docs/plan/plan-mode-contract.md).
Authorization precedence, AUTO network behavior, and audit provenance are defined in the
[Agent Mode and Tool Permission Contract](docs/architecture/agent-mode-permission-contract.md).

### Persistent Goal safety contract

`/goal <objective>` creates one active Goal for the current session. Automatic
continuations are typed runtime requests: they are not echoed or stored as fake
user messages. After a process restart or `/resume`, an active Goal is restored
in a visible paused state; run `/target resume` to continue deliberately.

The model may request `complete` or `blocked`, but cannot set either terminal
state directly. Orion records runtime/tool evidence and audits every success
criterion. Missing, failed, unmapped, wrong-kind, expired, or stale evidence keeps the
Goal open. Criteria that require human acceptance can only receive trusted
`user` evidence from `/goal confirm <criterion-id>`; model tools cannot mint
that confirmation. v0.1.2 remains single-session and single-active-Goal; it does not
promise multi-Goal scheduling or unattended background execution.

After a completion audit passes, Orion automatically clears the session's active Goal binding,
returns the TUI to its current BUILD/PLAN/AUTO base mode, and retains the terminal Goal sidecar as
the durable completion receipt. A trailing lifecycle clause such as `测试一轮，然后退出目标模式`
is separated from the auditable work: Orion verifies `测试一轮`, then performs the same runtime-owned
automatic exit after the audit passes. It is not treated as an impossible success criterion. Use
`/goal exit` to abandon before completion: it aborts the active
turn, rejects pending permission requests, and removes the persisted Goal. Explicit natural-language
requests such as `exit goal mode` or `退出 goal 模式` route through the same deterministic runtime
boundary. Session binding and Goal-sidecar cleanup fail closed as one lifecycle operation; Orion
never reports a successful exit after only one persisted object changed. Rejected completion requests
cannot be retried in the same turn until new runtime evidence exists, and autonomous continuation
turns have stricter model/tool budgets than fresh user turns. Two consecutive blocked autonomous
continuations pause for review instead of spending the full continuation window. The old `/goal clear --yes` and
`/target clear --yes` syntax is intentionally unsupported in v0.1.6.

## Migration from OpenHorse

```bash
# Preview only (default)
orion migrate openhorse [--include-env]

# Execute after reviewing the preview
orion migrate openhorse --yes [--include-env]
```

See the [v0.1.2 release notes](https://github.com/orion-agents/orion-code/blob/main/docs/mvp/v0.1.2.md),
[Goal evidence and recovery guide](https://github.com/orion-agents/orion-code/blob/main/docs/goals/goal-evidence-and-recovery.md),
and [execution plan](https://github.com/orion-agents/orion-code/blob/main/docs/archive/releases/v0.1.x/v0.1.2-execution-plan.md).

## Research-to-Evidence (v0.1.4, experimental)

> **Status: experimental.** Turns the read-only `research` subagent output into a **traceable, recoverable** research→evidence loop.

Hard guarantees (any violation is a No-Go; never published):

- **Only specialized WebSearch / WebFetch** — no generic MCP, no write/exec grant.
- **SSRF / DNS-rebind / redirect / body-size / timeout** re-use the existing guards: a lexical SSRF pre-check at selection, and the full per-hop guard set delegated to the real WebFetch tool.
- A **claim must bind a source** to reach `observed`; a claim with no independent verification stays `partial`/`unmet` and is never counted as verified/complete.
- A **security-gate failure becomes `blocked`/`failed` with a structured reason** — never faked as a hit; provider fallback only swaps the provider, never downgrades a source status or writes a failure as a success.
- Research evidence (web) and execution-verification evidence (file / test / build / file facts) are **kept distinct**; a web summary cannot stand in for execution verification.
- Packet + source metadata are saved **atomically with a CAS token**; project / session / Goal scope isolation; resume only derives state and never replays external side effects; old schema versions fail closed.

Modules: `src/runtime/subagents/{research-types,research-contract,research-citation,web-research-adapter,research-renderer,research-artifact,research-quality}.ts`.

> Real-terminal (PTY) and external-state evidence are marked `not_run` in CI; local tests are not treated as release completion.

## Development

```bash
npm install      # Install dependencies
npm run build    # Build
npm test         # Run the full Jest suite
npm run lint     # Lint
npm run format   # Format
```

## License

MIT License — see [LICENSE](LICENSE) for details.
