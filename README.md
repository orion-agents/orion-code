# Orion Code

Local-first, goal-driven coding agent for the terminal and browser.

> v0.3.3 candidate — a bounded multi-Session Web Workbench, the built-in Orion Blocksmith theme
> and the existing single-Session TUI/terminal surfaces. Candidate source is not an npm publication,
> Git tag, or merge-ready release.

[中文说明](README.zh-CN.md) ·
[v0.3.3 plan](docs/plan/v0.3.3-plan.md) ·
[v0.3.3 Web API](docs/architecture/v0.3.3-web-api.yaml) ·
[mode/permission contract](docs/architecture/agent-mode-permission-contract.md) ·
[v0.3.3 E2E plan](docs/test/v0.3.3-web-workbench-e2e-plan.md) ·
[v0.3.3 migration](docs/migration/v0.3.2-to-v0.3.3.md) ·
[v0.3.0 Web plan](docs/plan/v0.3.0-web-workbench-plan.md) ·
[Settings plan](docs/plan/v0.3.0-settings-integration-plan.md) ·
[Node compatibility](docs/plan/v0.3.0-node-runtime-compatibility-plan.md) ·
[Web API](docs/architecture/v0.3.0-web-api.yaml) ·
[Migration guide](docs/migration/v0.2.2-to-v0.3.0.md) ·
[Settings migration](docs/migration/v0.2.2-to-v0.3.0-settings.md) ·
[real-state gallery](docs/assets/screenshots/v0.3.0-web/README.md)

## What v0.3.3 includes

- **One execution spine, bounded Web Session actors.** Web Sessions use the same product bootstrap,
  AgentRuntimeController, Session/Thread stores, ToolGateway, approvals, Goals, Plans, Skills and MCP
  boundaries as the terminal product. Up to three Session turns may run concurrently with four
  resident actors; the TUI and terminal surfaces keep their single-active-Session contract.
- **Orion Blocksmith.** A bundled pixel-workshop style combines with system/light/dark themes without
  remote assets, dynamic theme code or a second settings source. Classic remains available as an
  explicit built-in style.
- **Recoverable Web workbench.** The React workbench includes workspace/session navigation,
  transcript and tool activity, BUILD/PLAN/AUTO, follow-ups, interrupt, approvals, Goal/Plan,
  model/effort settings, Skills/MCP and diagnostics. Snapshots plus cursor replay repair refreshes
  and SSE reconnects.
- **Professional project shell.** The left navigator shows registered projects with lazy Session
  pages, resizes from 240–480px and collapses to a 48px rail while the center remains the only Agent
  conversation. A resizable right dock provides Agent, Review, Terminal, Files and Git surfaces;
  narrow screens use mutually exclusive drawers without overwriting desktop preferences.
- **Composer Control Center.** Mode, Session permission, model, Effort and Context are accessible
  menus beside the textarea. Runtime current/last-good/pending/error state is explicit; active-turn
  model changes defer safely and smaller-context switches run verified Compact first.
- **Reviewable plans and bounded context.** PLAN commits a durable review state and never starts
  implementation before exact-digest approval. Structured file/folder/review/session/Skill refs,
  revisioned queue editing and Session-scoped drafts keep prompt intent visible and recoverable.
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

After the immutable `0.3.3` npm receipt exists:

```bash
npm install -g @orion-agents/orion-code@0.3.3
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

The browser exposes Plan receipts exactly as committed and enters a durable `awaiting_review`
state. Approve starts a separate BUILD logical request, Continue Planning starts a separate PLAN
request with feedback, and Cancel performs no execution. Each operation binds the exact plan digest
and survives refresh or Host restart; stale review actions fail with no side effects.

The project navigator does not create multiple runtimes. Cross-project Session selection is one
atomic, revision-guarded Context transition. The left dock is 240–480px or a 48px rail; the right is
320–720px. Both use IDE-style mouse drag where applicable and there is no keyboard fine resize.
Narrow layouts use drawers without overwriting desktop widths. Files, Git and Review are read-only;
terminal creation requires an explicit gesture and its ticket/output never enter Workbench SSE.

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

Use the Composer mode menu to select `BUILD`, `PLAN` or `AUTO`; the adjacent permission menu selects
Project default, Ask, Allow or Deny. Mode controls workflow behavior while Authority, approval,
containment and sandbox policy remain independent. Allow and AUTO require explicit risk handling and
never override hard policy or explicit Deny.

- **BUILD** is normal collaborative implementation.
- **PLAN** explores with the same available tool universe, commits a decision-complete PlanReceipt,
  and waits for durable approve / continue-planning / cancel review.
- **AUTO** removes interactive approval prompts within the configured Authority; hard policy and
  sandbox boundaries still fail closed.

Start a task-scoped plan with:

```text
/plan refactor the storage boundary and verify crash recovery
```

There is no `exit_plan_mode` tool. Web users select mode from the Composer; terminal surfaces retain
their existing mode controls.

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
MCP, Compact, and resume journeys. WEB33-P0-01..12 qualify the built-in appearance contract, while
WEB33-P0-16..24 qualify parallel Session actors, foreground-local switching, bounded queues, the
right rail and the single Settings entry. See the [`v0.3.3 plan`](docs/plan/v0.3.3-plan.md) and
[`v0.3.3 E2E qualification plan`](docs/test/v0.3.3-web-workbench-e2e-plan.md).

## Security

Do not commit `.env`, `~/.orion-code`, local databases, or credentials. File access is contained to
the project boundary, symlink/non-regular path escapes fail closed, and all side effects pass the
same Authority/Policy/Approval/Sandbox chain. Report vulnerabilities privately when disclosure
could put users at risk.

## License

MIT — see [LICENSE](LICENSE).
