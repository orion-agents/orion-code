# Orion Code

Goal-driven coding agent for the terminal.

> v0.2.2 patch candidate — resilient Thread session recovery, provider-safe interrupted tool
> history, and width-stable Goal usage visibility on the v0.2 Harness.

[中文说明](README.zh-CN.md) · [Architecture plan](docs/plan/v0.2.0-dsh-harness-redesign-plan.md) ·
[Migration guide](docs/migration/v0.1.9-to-v0.2.0.md) ·
[Release checklist](docs/plan/v0.2.0-release-checklist.md)

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

Node.js 20, 22, and 24 are supported.

After the immutable `0.2.2` npm receipt exists:

```bash
npm install -g @orion-agents/orion-code@0.2.2
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
orion -p "explain this repo"  # experimental non-interactive mode
orion -p --output-format json "run the focused tests"
orion diff
orion commit
```

Experimental non-interactive print mode is available through `orion -p`; keep it out of
interactive workflows that require confirmations or live steering.

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
```

Release qualification additionally builds one exact tarball and installs that unchanged hash on
Node 20/22/24 for package identity, native SQLite, TUI, terminal, print, Goal, subagent, Skill, MCP,
Compact, and resume journeys. See the
[`v0.2.0 release checklist`](docs/plan/v0.2.0-release-checklist.md).

## Security

Do not commit `.env`, `~/.orion-code`, local databases, or credentials. File access is contained to
the project boundary, symlink/non-regular path escapes fail closed, and all side effects pass the
same Authority/Policy/Approval/Sandbox chain. Report vulnerabilities privately when disclosure
could put users at risk.

## License

MIT — see [LICENSE](LICENSE).
