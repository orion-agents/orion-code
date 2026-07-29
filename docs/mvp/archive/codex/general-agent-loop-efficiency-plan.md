# Agent Loop Efficiency Optimization Plan

## Summary

OpenHorse should optimize the agent loop without replacing the existing runtime.
The target is practical: fewer base-model round trips, less prompt noise, clearer
tool feedback, and stronger task continuity after long sessions. Keep the current
shape:

`user input -> runtime controller -> query loop -> tool scheduler -> tool results -> next model request`

The improvement path is to add budgets, local deterministic fast paths,
model-facing summaries, and isolated subtask loops around this shape.

## Community Patterns

- Claude Code describes the loop as evaluate, call tools, feed tool results
  back, and repeat until no more tools are needed. It exposes limits such as
  `maxTurns` and budget caps, and recommends subagents, scoped tools, automatic
  compaction, and tool-search/deferred MCP schemas to reduce context pressure.
- Codex separates UI from the core engine. Its protocol defines `Session`,
  `Task`, and `Turn`; one task runs at a time, user revisions interrupt the
  active task, and each turn is model request plus tool execution plus next
  turn input.
- OpenClaude exposes resume/fork/background sessions, compact boundary events,
  agent definitions with tool allowlists, `maxTurns`, background mode, skills,
  and MCP server scoping.
- OpenClaw's compaction path is heavily instrumented: transcript pairing repair,
  pre-compaction hooks, token contributors, safety timeouts, checkpointing, and
  post-compaction transcript rotation.

## Current OpenHorse Baseline

OpenHorse already has useful pieces:

- `src/framework/query.ts` runs the core model/tool loop and predictive compact.
- `src/framework/tool-scheduler.ts` executes concurrency-safe tools in parallel
  while preserving original result order.
- `batch_read` lets the model combine local read-only exploration into one tool.
- v0.2.11/v0.2.12 reduced rate-limit retry noise, added fallback behavior, and
  made provider/tool diagnostics clearer.

The remaining gap is not "parallel tools"; it is reducing unnecessary model
turns and context growth around those tools.

## Implementation Status

- Implemented in v0.2.12 working tree:
  - `LoopStats` on `query()` complete events.
  - model-visible tool result compression before feeding tool results back to
    the LLM.
  - full tool result preservation for UI/session events.
  - `Store.lastLoopStats` and `/status` display for the last completed loop.
- Not implemented yet:
  - budget enforcement;
  - local fast-path routing;
  - dynamic tool manifest;
  - isolated subtask runtime.

## Design Principles

- Do not add a second agent loop in UI code.
- Do not batch unsafe writes, edits, git operations, publish, or shell commands
  that need confirmation.
- Preserve tool-call/result pairing for provider protocol correctness.
- Prefer summaries in model context and full artifacts in session/UI.
- Make every optimization measurable with per-turn stats.

## Proposed Architecture

### 1. Loop Budget And Stats

Add a `LoopBudget` and `LoopStats` object owned by runtime/query:

- `llmRequests`
- `toolCalls`
- `readOnlyToolCalls`
- `unsafeToolCalls`
- `retryCount`
- `fallbackUsed`
- `toolResultBytes`
- `modelVisibleToolBytes`
- `summarizedBytes`
- `compactTrigger`
- `finishReason`

The loop should stop or degrade gracefully on configured caps:

- `maxTurns`
- `maxLlmRequestsPerUserTurn`
- `maxToolCallsPerUserTurn`
- `maxModelVisibleToolBytes`
- `maxCostPerTurn`
- `maxRateLimitRetries`

Expose this through `doctor`, `/status`, or `/loop-stats`. The purpose is to
find request amplification before users hit provider limits.

### 2. Model-Facing Tool Result Compression

Introduce a `ToolResultEnvelope` with two surfaces:

- `modelSummary`: compact text returned to the LLM.
- `artifactRef`: full output persisted for UI/session/harness evidence.

Rules:

- Small outputs pass through unchanged.
- Large `exec`, `grep`, `test`, `web_fetch`, and MCP results get summarized by
  deterministic extractors first.
- Keep the full output in artifacts with byte count and path/id.
- For test logs, preserve command, exit code, failing test names, first relevant
  stack/error, and final summary.
- For grep/search, preserve file paths, counts, and representative matches.

This directly reduces token pressure while preserving auditability.

### 3. Local Deterministic Fast Paths

Before calling the model, route explicit operational requests locally when they
are unambiguous:

- `git status`
- "运行测试: <command>" / "run <command>"
- "读取 <path>"
- "搜索 <pattern>"
- `/doctor`, `/status`, `/resume`, `/harness explain`

Return a tool-style transcript entry and optionally ask the model only if the
user asks for interpretation. This saves a full LLM request for mechanical
commands. Keep the router conservative; ambiguous coding tasks still go through
the model.

### 4. Read-Only Exploration Policy

OpenHorse already has `batch_read`; make the policy stronger:

- Prompt the model to use one `batch_read` for initial codebase exploration.
- Add a runtime warning/stat when a turn performs many single read-only calls
  that could have been batched.
- Consider an optional `autoExplore` local helper only for safe file discovery:
  `git_status`, `list_files`, `glob`, `grep`, `read_file`.
- Never auto-run web, shell, LSP, write/edit, or git mutation tools.

This reduces "read one file -> ask model -> read another file" loops.

### 5. Dynamic Tool Manifest

Tool definitions consume context. Assemble tools per turn:

- Always include core file/search/edit/shell/git tools.
- Include MCP tools only when project state or prompt mentions the domain, or
  after a tool-search selection step.
- Include skill-specific tools only when the selected skill is active.
- Track omitted tool families in `PromptAssemblyStats` so debugging is possible.

This follows the same direction as deferred MCP tool schemas and scoped
subagents in Claude Code/OpenClaude.

### 6. Isolated Subtask Loops

Add a runtime-owned `subtask` capability for expensive research/review/test
work:

- Main loop sends a scoped objective and allowed tools.
- Subtask runs with a fresh context and lower budget.
- Only a structured summary returns to the parent:
  `findings`, `files`, `commands`, `verification`, `risks`.

Use cases:

- code review agent
- test failure investigator
- large codebase exploration
- web/documentation research

This keeps the main session context smaller and reduces repeated user steering.

### 7. Rate-Limit Governance

Use provider diagnostics as a circuit breaker:

- Non-retryable quota/auth/model errors stop immediately with actionable output.
- `rate_limit` and `provider_busy` use backoff and fallback model once.
- After repeated rate-limit failures, pause the current loop instead of issuing
  more model calls.
- Persist `lastProviderFailure` in turn stats so `/status` can explain why work
  paused.

This prevents "provider busy -> immediate retry -> provider busy" loops.

### 8. Context Continuity Rules

Compaction should preserve operational state, not just prose:

- root objective
- active instruction
- acceptance criteria
- current plan/todos
- files read/edited
- commands run and verification status
- unresolved blockers
- active skill names and project instructions

After compact/resume, run a cheap consistency check before the next LLM request.
If harness sidecar is missing, rebuild a capsule from session transcript and
mark confidence low.

## Implementation Phases

### Phase 1: Metrics And Compression

- Add `LoopStats` events from `query`.
- Add tool result envelope and deterministic summarizers.
- Add `/loop-stats` or extend `/status`.
- Tests: query stats, output byte caps, artifact retention, rate-limit finish
  reason.

### Phase 2: Fast Paths And Tool Manifest

- Add local intent router for explicit operational commands.
- Add dynamic tool selection in prompt assembly.
- Add warnings/stats for inefficient read-only call patterns.
- Tests: local command path avoids `llm.chatStream`, ambiguous tasks still use
  LLM, omitted tools are reported.

### Phase 3: Subtask Runtime

- Add `subtask` runtime capability with tool allowlists and budget caps.
- Add `review`, `research`, and `test-investigate` presets.
- Parent receives only structured summary, not full subtask transcript.
- Tests: subtask isolation, budget enforcement, summary persistence.

### Phase 4: Continuity And Evals

- Add resume/compact consistency diagnostics.
- Add long-session eval fixtures: 20+ turns, compact, resume, "继续".
- Add API-limit simulation fixtures: repeated `429`, provider busy, fallback.

## Success Metrics

- Reduce LLM requests per successful coding task by 20-40% on local benchmarks.
- Keep model-visible tool bytes under a configured cap in long runs.
- Preserve full human-auditable tool output through artifacts.
- No unsafe tool batching regressions.
- "继续" after compact/resume continues the same objective.

## Risks

- Over-aggressive fast paths may bypass model reasoning. Mitigation: only route
  explicit operational commands locally.
- Tool result summaries may hide details needed by the model. Mitigation:
  deterministic extractors plus artifact IDs and harness evidence.
- Dynamic tool manifests can hide a needed tool. Mitigation: expose omitted tool
  families in stats and allow the model to request tool discovery.
- Subtasks can increase total cost if used too eagerly. Mitigation: require
  budget caps and clear trigger rules.

## References

- Claude Code docs: [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
  and [How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop)
  for loop phases, max turns, budget caps, automatic compaction, subagents,
  scoped tools, and deferred MCP schemas.
- Codex protocol docs:
  [codex-rs/docs/protocol_v1.md](https://github.com/openai/codex/blob/main/codex-rs/docs/protocol_v1.md)
  for `Session`, `Task`, `Turn`, single active task, and UI/runtime separation.
- OpenClaude source:
  `/Users/hope/ai-project/openclaude/src/entrypoints/sdk/coreSchemas.ts` for
  agent definitions, `maxTurns`, background sessions, compact boundary messages,
  and tool allowlists.
- OpenClaw source:
  `/Users/hope/ai-project/openclaw/src/agents/embedded-agent-runner/compact.ts`
  for compaction diagnostics, transcript repair, hooks, checkpointing, and
  safety timeouts.
