# Orion Code Agent Loop Final Form Target

## Document Status

- Status: Target / North Star
- Date: 2026-07-04
- Scope: Agent runtime, harness, tools, session, memory, permissions, and observability
- Non-goal: UI renderer redesign. UI must consume runtime events and must not redefine agent behavior.

## Research Summary

Modern coding agents are no longer a single chat prompt plus file edits. The stronger systems expose a durable agent runtime:

- Claude Code positions itself as an agentic coding tool that reads codebases, edits files, runs commands, and integrates with terminal, IDE, desktop, browser, CI, MCP, memory, skills, hooks, multi-agent work, and scheduled tasks. See Claude Code overview: <https://code.claude.com/docs/en/overview>.
- Codex CLI presents the same direction: interactive TUI, model switching, image input, code review by a separate agent, subagents, web search, cloud tasks, scripting through `codex exec`, MCP, approval modes, sandboxing, session resume/fork/archive/delete, and remote app-server control. See Codex CLI docs: <https://developers.openai.com/codex/cli> and <https://developers.openai.com/codex/cli/reference>.
- Gemini CLI documents a client/core split where the CLI talks to a core server that manages model requests and tools such as filesystem, shell, web fetch, MCP, multi-file reads, checkpointing, telemetry, trusted folders, and token caching. See Gemini CLI docs: <https://google-gemini.github.io/gemini-cli/docs/>.
- Aider shows a useful context pattern: a compact repository map containing important files, symbols, signatures, and relationships is sent with change requests, while lint/test commands close the edit-validation loop. See Aider repo map and lint/test docs: <https://aider.chat/docs/repomap.html> and <https://aider.chat/docs/usage/lint-test.html>.
- MCP-centered designs converge on discovery, schema validation, namespacing, execution, confirmation, resource access, rich responses, and connection health. See Gemini MCP docs: <https://geminicli.com/docs/tools/mcp-server/>.

These are observed design patterns, not a parity checklist. Orion Code should adopt the runtime principles that improve correctness, durability, safety, and cost control without chasing every product surface at once.

Conclusion: the final Orion Code agent-loop should be a deterministic, inspectable runtime state machine that lets the model reason and choose tools, while the harness controls context, budgets, permissions, verification, persistence, and recovery.

Implementation note: external projects are used as references for architecture
principles, not as a product parity checklist. A capability should enter
Orion Code only when it strengthens the local runtime, harness, tools, session,
or terminal-first workflow.

## North Star

Orion Code should have one professional agent-loop core that can run interactively, non-interactively, locally, remotely, or through future UI renderers without changing semantics.

Core invariants:

- One active user turn per session unless a supervisor explicitly creates isolated subagent work.
- A user turn may contain multiple bounded model/tool/observe iterations.
- Each loop iteration may send at most one model request.
- Runtime owns behavior; UI renderers own presentation.
- Unsafe fast paths are forbidden; ambiguity falls back before execution.
- Full tool output is stored in session/artifacts, while model-visible context remains compact.
- Every terminal loop exit records a canonical `finishReason`. Current
  canonical reasons are `completed`, `cancelled`, `max_turns`,
  `completion_gate`, `budget_exceeded`, and `running`. Future reasons such as
  `waiting_user`, `waiting_permission`, `blocked`, and `failed` must be added
  through the same enum and diagnostic surface, not as renderer-local strings.

The final form is:

```text
User / Automation Input
        |
        v
Turn Controller
  classify input, interrupt/revise, route fast paths, enforce one active turn
        |
        v
Context Harness
  root objective, active instruction, constraints, evidence, memory, session capsule
        |
        v
Prompt Assembly
  budgeted ranked context, repo guidance, skills, MCP/tool facts, recent turns
        |
        v
Model Step
  reason, answer, request tools, ask clarification, or finish
        |
        v
Tool Scheduler
  permission, sandbox, batching, concurrency, timeout, abort, result compression
        |
        v
Observation Ingestion
  evidence index, transcript, artifacts, memory candidates, verification state
        |
        v
Completion Gate
  verify, summarize, persist, compact, or continue
```

## Core Loop States

The loop should be explicit and testable:

- `idle`: no active turn; accepts chat, slash commands, resume, and local fast paths.
- `intake`: normalizes user input, detects command/chat/fast path, records user intent.
- `context_prepare`: refreshes project rules, skills, MCP tools, memory, session capsule, and harness state.
- `assemble`: builds a budgeted prompt with explainable included/omitted evidence.
- `model_request`: sends one model request for the current loop iteration with abort support, retry/fallback policy, and request accounting.
- `tool_plan`: validates tool calls, detects batching opportunities, applies permissions and sandbox policy.
- `tool_execute`: executes tools in safe order, parallelizing only concurrency-safe read-only calls.
- `observe`: records structured tool results, artifacts, evidence, verification data, and UI events.
- `verify`: runs required tests/checks or asks the model for the next action if verification is missing.
- `awaiting_user`: pauses for clarification, missing input, or user-selected next action.
- `awaiting_permission`: pauses for a permission decision, then resumes or records denial.
- `persist`: writes session transcript, model-visible compact content, harness sidecar, artifacts, and loop stats.
- `compact`: automatically compacts when context pressure is high while preserving root objective and next action.
- `complete`: emits final summary, verification results, residual risks, and stable loop stats.
- `aborted`: discards partial assistant output, persists only valid completed state, and supports latest-input restart.

## Runtime Protocol Contract

The final loop must be driven through a renderer-independent protocol, aligned with `docs/targets/ui-runtime-boundary.md`.

Runtime inputs should include:

- submitted chat text;
- slash command execution;
- interrupt and live revision;
- permission decisions;
- picker decisions for sessions, models, files, skills, and MCP resources;
- non-interactive execution requests;
- remote client messages.

Runtime events should include:

- transcript append/update/finalize/remove;
- assistant delta and assistant completion;
- tool requested, tool started, tool finished;
- permission requested;
- picker requested;
- status, warning, error;
- session restored;
- harness diagnostics;
- loop stats and trace events.

Required protocol rules:

- Tool events preserve chronological request order and original call IDs.
- Permission semantics are identical across terminal, ink, tui, print, and remote renderers.
- A renderer may choose a visual picker, but command semantics stay runtime-owned.
- Aborted partial assistant output is never persisted as a completed assistant message.
- Non-interactive renderers must fail explicitly when a required human decision is missing.

Protocol maturity rule:

- `AgentRuntimeInput` and `AgentRuntimeEvent` are the compatibility boundary.
- Existing event names must remain stable unless a migration adapter is added.
- New target events such as assistant deltas, loop stats, trace events, harness diagnostics, warnings, and session-restore notices must be additive protocol events with renderer parity tests.
- Do not reimplement turn control in a renderer to obtain a missing event.

## Harness Contract

The harness is the durable task brain. It must maintain:

- `rootObjective`: stable user goal that short feedback cannot overwrite.
- `activeInstruction`: latest actionable instruction inside the current objective.
- `constraints`: explicit user constraints, safety constraints, repo rules, and non-goals.
- `openQuestions`: unresolved blocking questions.
- `plan`: current ordered work plan with status.
- `verificationState`: required checks, passed checks, failed checks, skipped checks, and reasons.
- `evidenceIndex`: user requirements, file facts, tool outputs, command results, decisions, and summaries.
- `contextCapsule`: compact state used after resume/compact.
- `loopStats`: LLM requests, tool calls, bytes, compaction, fast paths, retries, fallback, budget exits.

Acceptance rule: after 20+ turns, compact, resume, and user input `继续`, Orion Code must continue the correct objective without relying on raw transcript proximity.

## Prompt Assembly Target

Prompt assembly must be budgeted and explainable:

1. Always include system rules, safety policy, root objective, active instruction, and blocking constraints.
2. Include project guidance from `AGENTS.md` and related rule files.
3. Include active skill instructions only when triggered; keep inactive skills as short metadata.
4. Include MCP/tool facts as capability summaries, not full schemas unless needed.
5. Include ranked evidence relevant to current input, touched files, failing checks, and next action.
6. Include recent turns only after canonical state and high-value evidence.
7. Compress or omit long tool outputs; keep full output in artifacts/session, not the prompt.
8. Emit `PromptAssemblyStats` with included evidence, omitted evidence, token estimate, and budget pressure.

The model should see the smallest context that preserves intent, correctness, and next action.

## Tool Loop Target

The tool loop is where most API-limit waste happens. The final form should:

- Batch independent read-only exploration through `batch_read` or scheduler-level grouped calls.
- Keep one model request from producing many small read-only request cycles when the action can be batched.
- Never rewrite provider tool protocol silently; use hints, scheduler grouping where safe, or explicit runtime tools.
- Apply permission and sandbox checks before execution.
- Execute concurrency-safe read-only tools in parallel and emit results in original call order.
- Store full outputs as artifacts when large; return summaries to model context.
- Preserve exact command text and full output references for user inspection.
- Keep long command arguments expandable through redacted artifact references
  instead of truncating them permanently or storing them inline in trace rows.
- Track cost signals: model requests, tool count, visible bytes, summarized bytes, retries, fallback, budget exits.

## Fast Path Target

Some user inputs are mechanical and should not consume a model request:

- exact `git status`;
- exact allowlisted file read/search forms such as `read <single-path>` and `grep <pattern>`;
- exact allowlisted validation forms such as `run test: <command>`, only after the normal command safety layer classifies the command as allow-safe;
- session/list/status diagnostics that are deterministic and non-mutating;
- deterministic storage or doctor checks.

Fast paths must be conservative:

- only trigger on explicit patterns;
- check workspace roots, secret-deny rules, network policy, and command safety before execution;
- execute validation commands only when the safety layer classifies them as allow-safe;
- never execute a command that would otherwise require an interactive permission prompt;
- use the same tool executor, permissions, cwd, session, and artifact policy;
- write transcript in a resume-safe shape;
- set `localFastPathUsed = true`;
- fall back to model only when the intent is ambiguous, not after partially executing unsafe work.

## Verification Target

Completion should be gated by evidence, not by fluent output.

The loop should know:

- whether files were changed;
- which checks are expected for the repo;
- which checks were run;
- which checks failed and why;
- whether the user explicitly allowed skipping verification;
- whether a PR/release/publish workflow requires extra gates.

For coding work, final answers should always include:

- changed files and behavior;
- verification commands and results;
- unresolved risks or skipped checks.

For changed-file tasks, the completion gate should record:

- pre-edit dirty-worktree snapshot;
- files changed by this turn versus pre-existing user changes;
- pre-existing dirty files that were modified again during this turn, detected
  by metadata signatures such as status, size, and mtime without storing file
  contents;
- expected verification profile selected for the repo and changed files;
- checks run, checks skipped, and explicit skip reasons;
- failing check output references;
- whether the final answer is allowed to claim success.

## Budget And Rate-Limit Target

Orion Code should optimize for successful task completion per provider quota, not maximum model chatter.

Required controls:

- per-turn LLM request budget;
- per-turn tool call budget;
- per-turn model-visible tool bytes budget;
- adaptive budget profiles for simple, complex, and release-level tasks, with
  explicit user/config overrides when a large task legitimately needs more
  iterations;
- read-only fragmentation detection;
- retry policy that distinguishes transient rate limit, busy server, quota/credit exhaustion, and malformed requests;
- fallback model policy with clear provider diagnostics;
- automatic compact before context overflow;
- `/loop-stats` and `/harness explain` as user-visible diagnostics.

Budget exhaustion should stop the turn with a useful continuation strategy instead of looping until provider failure.

## Safety, Checkpoint, And Secret Hygiene

The final loop must be safe under real file edits and shell execution:

- Detect dirty worktrees before edits and never overwrite unrelated user changes.
- Create checkpoints before multi-file edits, generated rewrites, migrations, and risky refactors.
- Provide rollback or restore guidance when a turn fails after modifying files.
- Classify shell commands as read-only, validation, ask-required, destructive, or blocked.
- Keep dangerous commands blocked even when a model or fast path requests them.
- Redact secrets from prompt assembly stats, loop traces, logs, session summaries, artifacts indexes, and error reports.
- Treat web/MCP/resource content as untrusted until validated by the runtime.
- Record permission decisions with scope and duration for auditability.

Trace redaction contract:

- trace sidecars may store command/path summaries, tool names, byte counts, timing,
  and artifact ids;
- trace sidecars must not store obvious API keys, bearer tokens, authorization
  headers, passwords, or secret-like key-value values;
- redaction must happen before trace events are written, not only when `/trace`
  renders them;
- artifacts may contain full tool output, but artifact indexes and trace event
  references must remain metadata-only.

## Session, Memory, And Replay Target

The final loop must be replayable enough to debug and resumable enough to continue work.

Persist separately:

- user/assistant transcript;
- model-visible compact transcript;
- tool calls and tool results;
- large artifacts;
- harness sidecar;
- prompt assembly stats;
- loop stats;
- verification state;
- memory candidates.

Resume must reconcile transcript, harness state, project path, model/provider, skills, MCP config, and artifacts. If reconciliation is uncertain, Orion Code should report the risk rather than pretending state is exact.

## Multi-Agent Target

Subagents are a later runtime capability, not a UI feature. They belong in Phase 5 after the single-agent loop, harness, session, tool, and verification layers are stable.

The target model:

- supervisor owns root objective, budget, session, and final integration;
- planner explores strategy and risks;
- coding worker edits bounded file scopes;
- reviewer audits diff, tests, safety, and missing coverage;
- researcher gathers external or repo facts;
- subagents communicate through structured task packets, artifacts, and review findings;
- subagents inherit explicit budgets, permissions, workspace scopes, and artifact policies.

Subagents must not write conflicting state into the main session. The supervisor merges validated outputs, owns final verification, and records aggregate budget usage.

## Near-Term Implementation Boundary

For v0.2.13 and the next stabilization iterations, Orion Code should not pull
Phase 5 features forward. The near-term implementation boundary is:

- continue with the stable `terminal` renderer as the product path;
- keep Ink/TUI as beta protocol consumers only;
- implement loop budget, fast paths, read-only fragmentation diagnostics, trace metadata, and completion-gate evidence inside runtime/query/session layers;
- avoid renderer-local loop behavior, unsafe command auto-execution, broad dynamic tool manifest rewrites, remote UI, or subagent runtime until the single-agent loop is measurable and stable.

## Observability Target

Every turn should be inspectable:

- request count and model used;
- prompt assembly stats;
- tool execution timeline;
- permissions requested/approved/denied;
- compaction events;
- retries/fallback;
- evidence added;
- verification state;
- final finish reason.

The target commands are:

- `/status`: compact health view.
- `/loop-stats`: model/tool/budget diagnostics.
- `/harness`: current objective and next action.
- `/harness explain`: why this context was assembled.
- `/trace <turn>`: structured event timeline for one turn.
- `/artifacts`: large outputs and generated files.
- `/doctor`: configuration and runtime health.

## Orion Code Roadmap

### Phase 1: Stabilize Current Loop

- Keep `terminal` as stable default UI.
- Finish loop budget, fragmentation stats, fast paths, and `/loop-stats`.
- Ensure tool outputs preserve full user-visible detail while model context stays compact.
- Add tests for budget exits, resume-safe fast paths, and unsafe command blocking.

Minimum v0.2.13 acceptance:

- local fast paths avoid LLM calls only for exact allowlisted inputs;
- blocked or failed fast paths record `blocked` or `failed`, never `completed`;
- `/trace` records pre snapshot, ordered tool/model events, post snapshot,
  workspace delta, then a terminal complete/error/aborted event;
- workspace delta distinguishes new files, resolved files, and pre-existing
  dirty files modified again by the turn;
- changed-file turns record a repo-aware `verification_profile` trace event
  with required status, inferred commands, changed files, and reason;
- verification tool results are linked into `verification_result` and
  `verification_summary` trace events that list passed, failed, missing checks
  and whether the turn may claim verified completion;
- when required verification is incomplete, the turn records
  `finishReason=completion_gate` and persists a verification gate notice into
  conversation context so the next model step cannot treat the task as verified;
- loop stats and trace metadata are emitted through additive runtime protocol
  events, not only through slash-command reads of store/session files;
- budget exits include structured continuation actions such as continue,
  narrow next instruction, inspect loop stats, or raise configured budget, so
  renderers do not need to parse assistant prose;
- harness diagnostics are emitted through the same runtime protocol with
  objective, active instruction, epoch, evidence count, turn summary count, and
  prompt assembly summary;
- each model-backed turn persists a redacted `prompt_assembly` trace event with
  token budget, section names, included/omitted evidence ids, evidence counts,
  and no full prompt, transcript, or tool output content;
- compacted long tool arguments are expandable through redacted args artifacts,
  and `/trace` points to the artifact instead of permanently losing exact
  command text;
- `/compact` persists model-visible compact history into the session so
  `/resume` restores the compact context and recent tail instead of replaying
  all old raw messages;
- after `/compact` and `/resume`, a generic `继续` keeps the restored
  `rootObjective` and `activeInstruction` in the next assembled prompt;
- ask/deny permission decisions are persisted as redacted trace events with
  approved/denied status, source, behavior, reason summary, and decision latency;
- trace strings are redacted before persistence;
- focused loop, trace, artifact, workspace-state, and command tests pass before
  release.

### Phase 2: Harness V3

- Make evidence index first-class.
- Add prompt assembly stats.
- Upgrade compact/resume reconcile.
- Make `rootObjective`, `activeInstruction`, verification, and next action visible and testable.

### Phase 3: Scheduler And Verification

- Add explicit read-only exploration planner.
- Promote safe grouped tool calls.
- Add repo-aware verification profiles.
- Add completion gate for changed-file tasks.

### Phase 4: Replay And Trace

- Persist per-turn trace metadata.
- Add `/trace`, `/artifacts`, and prompt assembly debug views.
- Add deterministic replay tests for session/resume/compact.

### Phase 5: Multi-Agent Runtime

- Add supervisor-managed subagent task packets.
- Add isolated work scopes and merge protocol.
- Add planner/coder/reviewer/researcher built-in roles.
- Add budget accounting per subagent and aggregate task.

## Final Acceptance Criteria

Orion Code reaches this target when:

- A complex coding task completes with fewer model turns because read-only exploration is batched and mechanical commands use fast paths.
- Long sessions survive compact/resume without losing root objective.
- Tool execution order, permissions, artifacts, and verification are auditable.
- The agent stops safely on budget/rate-limit pressure and gives a useful continuation path.
- UI renderers can change without changing agent-loop behavior.
- A reviewer can inspect one turn and explain what context the model saw, which tools ran, why the loop continued, and why it stopped.

Test-shaped acceptance fixtures:

- Compact/resume fixture: after compaction and resume, `继续` resumes the correct root objective and next action.
- Permission-denial fixture: denied tool execution does not mutate files and records a clear finish reason.
- Aborted-turn fixture: partial assistant output is discarded, latest-input restart works, and transcript remains valid.
- Fast-path fixture: explicit `git status` or read-only file commands avoid LLM calls, while ambiguous coding requests still use the model.
- Budget-exhaustion fixture: loop stops with `budget_exceeded`, persists stats, and suggests a safe continuation.
- Renderer-parity fixture: terminal, ink beta, tui beta, print future, and remote future consume the same runtime event contract for exposed features.
- Secret-redaction fixture: prompt stats, traces, summaries, and artifacts indexes do not expose configured secret patterns.
- Diff-aware verification fixture: with pre-existing unrelated worktree changes, the agent edits a bounded file set, reports only its own changed files, runs the repo verification profile or records explicit skip reasons, and never claims unverified success.
