# Orion Code

Local-first, goal-driven coding agent for the terminal and browser.

> v0.3.1 candidate — one Orion runtime with a local Web Workbench, replayable browser state and
> the existing TUI/terminal surfaces. Candidate source is not an npm publication or Git tag.

[中文说明](README.zh-CN.md) ·
[v0.3.1 professional shell plan](docs/plan/v0.3.1-web-workbench-professional-shell-plan.md) ·
[v0.3.1 Web API](docs/architecture/v0.3.1-web-api.yaml) ·
[v0.3.1 E2E plan](docs/test/v0.3.1-web-workbench-e2e-plan.md) ·
[v0.3.1 migration](docs/migration/v0.3.0-to-v0.3.1.md) ·
[v0.3.0 Web plan](docs/plan/v0.3.0-web-workbench-plan.md) ·
[Settings plan](docs/plan/v0.3.0-settings-integration-plan.md) ·
[Node compatibility](docs/plan/v0.3.0-node-runtime-compatibility-plan.md) ·
[Web API](docs/architecture/v0.3.0-web-api.yaml) ·
[Migration guide](docs/migration/v0.2.2-to-v0.3.0.md) ·
[Settings migration](docs/migration/v0.2.2-to-v0.3.0-settings.md) ·
[real-state gallery](docs/assets/screenshots/v0.3.0-web/README.md)

## What v0.3.1 includes

- **One runtime, two interactive surfaces.** `orion web` uses the same product bootstrap,
  AgentRuntimeController, Session/Thread stores, ToolGateway, approvals, Goals, Plans, Skills and
  MCP boundaries as the terminal product; the browser does not run a second agent loop.
- **Recoverable Web workbench.** The React workbench includes workspace/session navigation,
  transcript and tool activity, BUILD/PLAN/AUTO, follow-ups, interrupt, approvals, Goal/Plan,
  model/effort settings, Skills/MCP and diagnostics. Snapshots plus cursor replay repair refreshes
  and SSE reconnects.
- **Professional project shell.** The left navigator shows registered projects with lazy Session
  pages while the center remains the only Agent conversation. A resizable right dock provides
  Agent, Review, Terminal, Files and Git surfaces; files/Git/review are bounded read models and the
  terminal is an explicit, ephemeral real PTY isolated from Session history and SSE.
- **Local security boundary.** The host binds only `127.0.0.1`; writes require an exact Origin,
  process nonce, JSON body and idempotency key. Responses use a restrictive CSP, browser payloads
  are redacted, and large tool results are byte-paged instead of placed on the event stream.
- **Host-owned Settings.** Appearance, the default model, workspace effort and the global tool
  confirmation policy use one strict, revisioned `orion.json` coordinator. Atomic batches, file-lock
  CAS, external-edit invalidation, last-good recovery and explicit source/scope/apply metadata keep
  the browser, slash commands, TUI and Runtime on the same persisted truth.
- **Deliberate DSH adaptation.** The design was source-audited against a fixed DeepSeek Harness
  revision. DSH's browser uses POST plus two downlink WebSockets; Orion intentionally uses JSON
  HTTP plus one replayable SSE downlink while retaining Orion's Model/Skills/MCP boundaries.

## What changed in v0.2.0

Orion now has one product execution spine:

```text
Thread → Turn → Step → Item
                    │
                    ├─ frozen prompt/model/capability snapshot
                    └─ Capability → Policy → Approval → Sandbox → Execute → durable receipt
```

- **Lean by default.** Ordinary coding starts with seven exact core tools instead of sending every
  built-in schema. Long-tail Git, LSP, web, Skill, MCP, batch, and subagent capabilities are selected
  only when the task needs them.
- **One trustworthy loop.** Root turns and child agents use the same Agent Loop and ToolGateway;
  schema and dispatch are bound by the same Step Snapshot.
- **Lazy extensions.** Skill catalogs contain bounded descriptors; definition bodies and resources
  load only after selection. Configured MCP servers stay disconnected until an exact server/tool is
  selected and release their lease when idle.
- **Durable completion.** History, TaskContext evidence, Goal state, StopDecision, capability
  receipts, and Plan receipts commit together. A productive Goal may continue beyond 20 turns and
  exits automatically only after its completion audit passes.
- **Crash-safe recovery.** Append-only runtime facts are authoritative. UI projection, Compact,
  legacy-session cutover, and resume are digest-checked and fail closed on partial or conflicting
  state.
- **Stable interaction.** TUI, terminal, print, Plan, Goal, Compact, and subagents consume the same
  versioned runtime protocol.

The design borrows scoped resource lifecycle ideas from DeepSeek Harness and immutable execution
contracts from Codex while keeping Orion's Goal/Evidence model at the center. Orion is **not** a
plugin marketplace or arbitrary JavaScript plugin host; Model, Skills, and MCP remain the supported
user extension boundaries.

## Install

Node.js 22.12+, 24, and 26 are supported. Use Node 24 LTS for production or Node 26 Current for
current development environments. Node 20 is upstream EOL and is no longer a v0.3 runtime.

After the immutable `0.3.1` npm receipt exists:

```bash
npm install -g @orion-agents/orion-code@0.3.1
orion --version
orion doctor
```

To run from source:

```bash
git clone https://github.com/orion-agents/orion-code.git
cd orion-code
npm install
npm run build
npm run start
```

## Configure a model

Orion reads `~/.orion-code/orion.json`. Start from
[`docs/orion.example.json`](docs/orion.example.json). Provider keys may be literal local values or
environment references such as `$HUOSHAN_API_KEY`; never commit credentials.

Minimal OpenAI-compatible example:

```json
{
  "schemaVersion": 1,
  "providers": [
    {
      "id": "my-provider",
      "displayName": "My Provider",
      "baseUrl": "https://example.invalid/v1",
      "apiKey": "$MY_PROVIDER_API_KEY",
      "protocol": "openai-completions"
    }
  ],
  "models": [
    {
      "id": "my-model",
      "displayName": "My Model",
      "provider": "my-provider",
      "model": "model-name",
      "contextWindow": 200000,
      "maxOutputTokens": 8192
    }
  ],
  "defaultModel": "my-model",
  "toolConfirmation": "allow"
}
```

Run `orion doctor` after configuration. Diagnostics never need to print the secret itself.

## Use Orion

```bash
orion                         # default product TUI
orion --ui terminal           # technical terminal fallback
orion web                     # local Web Workbench; opens a browser
orion web --no-open --port 0  # choose an ephemeral loopback port
orion web --cwd /path/to/repo # start against another existing workspace
orion -p "explain this repo"  # experimental non-interactive mode
orion -p --output-format json "run the focused tests"
orion diff
orion commit
```

Experimental non-interactive print mode is available through `orion -p`; keep it out of
interactive workflows that require confirmations or live steering.

### Local Web Workbench

`orion web` serves the packaged client and `/api/v1/*` from one loopback origin. It does not expose
a LAN bind. Configure provider credentials with the normal Orion config/environment flow, then use
the browser to select a workspace and session, run or steer work, answer approvals, and inspect
runtime state. Closing or refreshing a tab leaves pending approvals owned by the runtime; stopping
the host aborts them fail-closed.

The browser exposes Plan receipts exactly as committed (`body`, `returnMode`, `digest`). It does not
insert an extra review gate: after PLAN commits, the existing runtime restores BUILD/AUTO and starts
implementation in a separate logical turn.

The project navigator does not create multiple runtimes. Cross-project Session selection is one
atomic, revision-guarded Context transition. The right dock is 320–720px on desktop and is adjusted
with an IDE-style mouse drag; there is no keyboard fine-resize control. Narrow layouts use drawers
without overwriting the saved desktop width. Files, Git and Review are read-only; terminal creation
requires an explicit gesture and its short-lived ticket and output never enter the Workbench SSE.

#### Host-managed Settings

The Settings dialog reads from the active Host rather than treating browser storage as a second
configuration source. Theme and reduced-motion preferences persist across refreshes, ports and Host
restarts. The default model applies to newly created sessions; changing the current session remains
an explicit `/model` or session-control action. Effort is the active workspace's project default,
with a session override taking precedence. Tool confirmation is global, may be changed only while
the Runtime is idle and applies at the next logical request; `allow` never bypasses hard policy,
sandbox or workspace containment.

Every save is one atomic compare-and-swap batch. A concurrent tab or external `orion.json` edit is
shown as a conflict without discarding the draft. Invalid external JSON preserves the last-good
Runtime configuration and is never overwritten by the Web UI. Provider credentials remain outside
the Web API: Settings exposes readiness only and its local configuration action accepts no path.
See the [Settings migration guide](docs/migration/v0.2.2-to-v0.3.0-settings.md) for precedence,
legacy appearance import and rollback details.

### BUILD, PLAN, AUTO

Press `Shift+Tab` to cycle `BUILD → PLAN → AUTO`. The status bar and input border show the current
mode. Mode controls workflow behavior; Authority, approval, containment, and sandbox policy remain
independent.

- **BUILD** is normal collaborative implementation.
- **PLAN** explores with the same available tool universe, commits a decision-complete PlanReceipt,
  exits automatically, restores BUILD/AUTO, and starts implementation in a separate logical turn.
- **AUTO** removes interactive approval prompts within the configured Authority; hard policy and
  sandbox boundaries still fail closed.

Start a task-scoped plan with:

```text
/plan refactor the storage boundary and verify crash recovery
```

There is no `exit_plan_mode` tool and no `/mode` command.

### Durable Goal mode

```text
/goal fix the open issues, run the release gates, and stop only when evidence is complete
/goal status
/goal pause
/goal resume
/goal clear
```

`/goal <objective>` creates the Goal. Progressing Goals continue without a fixed turn-count stop;
resource budgets, no-progress, blockers, provider failures, persistence failures, and user
interrupts remain explicit stop decisions. A passed evidence audit commits completion and exits
Goal automatically.

`/target`, `/goal exit`, `edit`, `replace`, `confirm`, `budget`, and `clear --yes` were removed in the
v0.2.0 breaking cut.

### Useful commands

- `/help`, `/status`, `/doctor`, `/harness explain`
- `/tools`, `/skills`, `/skill <name>`, `/mcp`
- `/context`, `/memory`, `/usage`, `/trace`, `/last-tool`
- `/model`, `/effort`, `/permissions`, `/config`
- `/compact`, `/resume`, `/session`
- `/diff`, `/commit-plan`, `/review`, `/research`, `/security`, `/test-gen`

Use `/help` in the installed build as the authoritative command inventory.

## Runtime guarantees

- At most one active turn per Thread; steer, follow-up, interrupt, overload, and maintenance have
  typed admission outcomes.
- Every started tool Item reaches exactly one durable terminal outcome. Nested batch calls retain
  parent/child invocation lineage and re-enter ToolGateway.
- A slow renderer may coalesce ephemeral deltas, but durable events are replayable and never silently
  dropped.
- Compact commits only after source-history, TaskContext, projection, and pointer CAS checks.
- Legacy v0.1.9 sessions are materialized side by side; the active index switches only after event
  replay and projection digests verify.
- Public exports expose the product runtime/protocol and Model/Skill/MCP configuration boundaries,
  not internal service locators or a plugin SDK.

## Develop and verify

```bash
npm run lint
npm run build
npm test -- --runInBand
npm run test:coverage -- --runInBand
npm run test:harness-confluence
npm run bench:harness:baseline
npm run bench:harness
npm run bench:harness:compare -- <baseline.json> <candidate.json>
npm run prepublishOnly
npm run test:web-e2e -- --grep @settings
```

Release qualification additionally builds one exact tarball and installs that unchanged hash on
Node 22/24/26 for package identity, native SQLite, TUI, terminal, print, Web, Goal, subagent, Skill,
MCP, Compact, and resume journeys. WEB31-P0-01..12 additionally qualify the multi-project shell,
read-only engineering panels, real PTY and responsive/accessibility contract. See the
[`v0.3.1 Web Workbench plan`](docs/plan/v0.3.1-web-workbench-professional-shell-plan.md) and
[`v0.3.1 E2E qualification plan`](docs/test/v0.3.1-web-workbench-e2e-plan.md).

## Security

Do not commit `.env`, `~/.orion-code`, local databases, or credentials. File access is contained to
the project boundary, symlink/non-regular path escapes fail closed, and all side effects pass the
same Authority/Policy/Approval/Sandbox chain. Report vulnerabilities privately when disclosure
could put users at risk.

## License

MIT — see [LICENSE](LICENSE).
