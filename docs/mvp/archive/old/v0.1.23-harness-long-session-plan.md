# v0.1.23 Context Harness Long-Session Plan

## Goal

v0.1.23 should refine OpenHorse's Context Harness so a long coding session can still preserve the user's core objective, distinguish refinements from new tasks, and assemble the most useful model context for each turn. The key shift is from "append a harness summary to the system prompt" to a lifecycle-based context engine that maintains structured task state, turn summaries, evidence, and prompt budgets.

## Reference Research

### Codex

Codex uses durable project guidance (`AGENTS.md`) and layered configuration to make behavior repeatable across sessions. Official docs emphasize keeping reusable guidance in AGENTS.md, scoping instructions by directory, and using config for stable environment behavior. In the open-source codebase, compaction is treated as a first-class session operation rather than a simple transcript truncation. `codex-rs/core/src/compact.rs` distinguishes pre-turn/manual compaction from mid-turn compaction and carefully reinserts canonical initial context before the last real user message or summary. This prevents compacted history from losing the model-visible ordering of system/project context and the active user request.

Relevant source references:
- `/Users/hope/ai-project/codex/codex-rs/core/src/compact.rs`
- `/Users/hope/ai-project/codex/codex-rs/core/src/session/turn_context.rs`
- `/Users/hope/ai-project/codex/codex-rs/core/src/agents_md.rs`
- Official docs: https://developers.openai.com/codex/guides/agents-md
- Official best practices: https://developers.openai.com/codex/learn/best-practices

### Claude Code

Claude Code separates durable instructions, auto memory, skills, hooks, permissions, MCP, and auto compact. Public docs describe two complementary memory paths: user-authored `CLAUDE.md` and Claude-authored auto memory, both loaded at the start of a session. Settings expose `autoCompactEnabled`, managed `claudeMd`, memory excludes, permission rules, and MCP policy. The important pattern is not just "more memory"; it is scoped, auditable, and policy-aware context that is reloaded consistently and compacted when needed.

Relevant source and docs:
- Official memory docs: https://docs.anthropic.com/en/docs/claude-code/memory
- Official settings docs: https://docs.anthropic.com/en/docs/claude-code/settings
- Official CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-reference

### OpenClaude

OpenClaude mirrors many Claude Code internal ideas in source. Its bootstrap state tracks session identity, project directory, post-compaction flags, invoked skills, CLAUDE.md cache, prompt cache eligibility, and per-query SDK context. It treats compaction as a transcript event boundary and preserves enough metadata for resume and UI display. It also avoids prompt-cache churn by latching certain headers for the rest of a session.

Relevant source references:
- `/Users/hope/ai-project/openclaude/src/bootstrap/state.ts`
- `/Users/hope/ai-project/openclaude/src/remote/sdkMessageAdapter.ts`
- `/Users/hope/ai-project/openclaude/src/main.tsx`

### OpenClaw

OpenClaw has the clearest abstraction for this work: a pluggable `ContextEngine` lifecycle. The interface separates `bootstrap`, `ingest`, `ingestBatch`, `assemble`, `afterTurn`, `maintain`, and `compact`. It also passes model, token budget, available tools, prompt text, and runtime context into assembly. This is the best architectural reference for OpenHorse because it lets context management evolve independently from the agent loop.

Relevant source references:
- `/Users/hope/ai-project/openclaw/src/context-engine/types.ts`
- `/Users/hope/ai-project/openclaw/src/agents/cli-runner.context-engine.test.ts`
- `/Users/hope/ai-project/openclaw/src/config/zod-schema.agent-defaults.ts`

## Pre-v0.1.23 Baseline

OpenHorse already had a meaningful v0.1.16-era harness foundation:

- `TaskContract`: objective, user intent, requirements, success criteria, prohibitions, allowed scope.
- `ContextLedger`: records user requirements, assistant decisions, tool results, verification, skills, risks, blockers.
- `ContextCapsule`: summarizes contract, current plan, open todos, changed files, verification, next action.
- `assembleHarnessMessages()`: appends a rendered harness block to the system message.
- Compact integration: `compactMessages()` can preserve a rendered Context Capsule before lossy summary text.
- Session integration: session meta stores `harnessState` and `contextCapsule`.

The baseline design was useful, but still too shallow for long sessions:

- `updateTaskContract()` overwrites `objective` with the newest user input. In long sessions, a correction like "不对吧" can replace the root goal.
- Intent classification is heuristic and line-based. It does not distinguish new task, refinement, interruption, verification request, meta command, or casual feedback.
- The assembler injects a fixed harness block. It does not select evidence based on current turn intent, mentioned files, active skills, available tools, or token pressure.
- Ledger entries are not indexed for retrieval. Important old facts compete with recent noise using only importance and created time.
- Compact summary is deterministic but lossy and mostly natural language. It preserves capsule, but not a structured intent/evidence index.
- Resume loads full stored history plus harness state, but there is no replay-safe reconciliation if transcript and capsule disagree.
- There is no `/harness explain` view to show why a fact entered prompt or was omitted.

## Design Principles

1. Preserve root objective separately from current instruction.
2. Treat every user turn as an intent update, not automatically as a task replacement.
3. Keep structured state canonical; transcript text is evidence, not the source of truth.
4. Assemble prompt from ranked context slices under explicit token budgets.
5. Make compact/resume deterministic and auditable.
6. Prefer small stable prompt sections and dynamic task sections to reduce cache churn.
7. Never claim verification unless a verified ledger entry exists in the current task epoch.

## Proposed Architecture

### 1. Harness Lifecycle Interface

Introduce a local `ContextEngine`-style interface while keeping the current `ContextHarness` as the default implementation:

```ts
interface HarnessEngine {
  bootstrap(params: { sessionId?: string; projectPath: string; cwd: string }): Promise<HarnessState>;
  classifyIntent(params: { input: string; state: HarnessState }): IntentUpdate;
  ingestTurn(params: { userInput: string; assistant?: string; toolEvents: ToolEvent[] }): void;
  assemble(params: {
    messages: Message[];
    input: string;
    tools: OpenHorseTool[];
    modelId: string;
    tokenBudget: number;
  }): AssembledContext;
  compact(params: { messages: Message[]; reason: 'manual' | 'auto' | 'resume' }): Promise<CompactResult>;
  maintain(params: { sessionId?: string; mode: 'foreground' | 'background' }): Promise<void>;
}
```

This does not require plugin support in v0.1.23. It simply turns harness behavior into explicit lifecycle methods that can be tested and replaced later.

### 2. Intent Model

Add a structured intent layer:

```ts
type IntentKind =
  | 'new_task'
  | 'refine_current_task'
  | 'interrupt_and_replace_current_step'
  | 'answer_clarification'
  | 'verify_or_test'
  | 'status_question'
  | 'meta_configuration'
  | 'casual_or_feedback';

interface IntentUpdate {
  kind: IntentKind;
  rootObjectiveDelta?: string;
  activeInstruction: string;
  constraintsAdded: string[];
  constraintsRemoved: string[];
  filesMentioned: string[];
  toolsMentioned: string[];
  confidence: number;
}
```

The root objective should change only for `new_task` or explicit replacement. A short feedback turn should update `activeInstruction` and ledger, not erase the objective.

Initial v0.1.23 implementation can be deterministic:

- Detect replacement: "重新", "改成", "不要做 X，做 Y", "instead", "switch to".
- Detect refinement: "继续", "补充", "另外", "同时", "希望".
- Detect verification: "测试", "验证", "build", "test", "run".
- Detect meta: "配置", "mcp", "session", "ui", "harness".
- Detect files by path-like tokens and known repo paths.

Later versions can add an optional low-cost LLM classifier when confidence is low.

### 3. State Model

Extend `HarnessState` with stable long-session fields:

```ts
interface HarnessStateV2 extends HarnessState {
  version: 2;
  taskEpoch: number;
  rootObjective?: string;
  activeInstruction?: string;
  intentHistory: IntentUpdate[];
  activeConstraints: string[];
  nonGoals: string[];
  openQuestions: string[];
  evidenceIndex: EvidenceRecord[];
  turnSummaries: TurnSummary[];
  promptAssemblyStats?: PromptAssemblyStats;
}
```

`TaskContract.objective` can remain for compatibility, but v0.1.23 should make `rootObjective` the stable source of truth.

### 4. Evidence Index

Convert ledger entries and turn summaries into ranked evidence:

```ts
interface EvidenceRecord {
  id: string;
  kind: 'requirement' | 'decision' | 'file' | 'tool' | 'verification' | 'risk' | 'skill' | 'mcp';
  text: string;
  source: { kind: string; ref?: string };
  paths: string[];
  tools: string[];
  turn: number;
  importance: number;
  ttl: 'turn' | 'task' | 'session' | 'persistent';
  embeddingKey?: string;
}
```

v0.1.23 can start with lexical scoring:

```
score =
  importance * 3
  + recencyBoost
  + pathMentionBoost
  + toolMentionBoost
  + keywordOverlap(currentInput + rootObjective)
  + verificationBoost
  - stalePenalty
```

This gives deterministic behavior without requiring embeddings.

### 5. Dynamic Prompt Assembly

Replace the single fixed harness block with an ordered assembly plan:

1. Static base system prompt.
2. Stable project guidance: memory, skills summary, available tools.
3. Harness Core State: root objective, active instruction, constraints, non-goals, open questions.
4. Current Plan: pending steps, next action, blockers.
5. Verification State: commands run, passed/failed results, what still needs verification.
6. Relevant Evidence: ranked old facts, file paths, decisions, tool outcomes.
7. Recent Conversation: last N turns, selected by token budget.
8. Current user input.

Suggested budget split:

| Slice | Default Share | Notes |
|---|---:|---|
| Static/system/project | cacheable | Already managed by prompt builder |
| Harness core | 8% | Always included, hard cap |
| Recent turns | 25% | Keep local coherence |
| Ranked evidence | 25% | Pull old but relevant facts |
| File/tool summaries | 15% | Changed files, command outputs, MCP/tool digests |
| Reserve | 15% | Model response and tool loop safety |

The assembler should emit `PromptAssemblyStats` so `/harness` can show what was included and why.

### 6. Compact And Resume

Compact should output structured state plus summary:

```md
[OpenHorse Context State v2]
rootObjective: ...
activeInstruction: ...
constraints:
- ...
openTodos:
- ...
verification:
- passed: ...
- failed: ...
relevantEvidence:
- ...

[Conversation Summary]
...
```

For mid-turn compaction, follow Codex's ordering idea: preserve canonical context before the last real user instruction, not after it. For manual/pre-turn compaction, replace older history with compacted state and let the next turn inject fresh project/system context.

Resume should:

1. Load session transcript.
2. Load `harnessState`.
3. Rebuild missing capsule/evidence from transcript only if state is absent or version-stale.
4. Compare first/last user messages with root objective and active instruction.
5. Mark state as `reconciledAt` and record diagnostics if transcript and state disagree.

### 7. Turn Summaries

After every successful non-aborted turn, create a compact turn summary:

```ts
interface TurnSummary {
  turn: number;
  userIntent: string;
  assistantOutcome: string;
  filesTouched: string[];
  toolsUsed: string[];
  decisions: string[];
  verification: string[];
  unresolved: string[];
}
```

This becomes the main input to long-session retrieval. Raw assistant prose should not be the only summary source.

### 8. Diagnostics

Extend `/harness`:

- Current root objective.
- Active instruction.
- Task epoch.
- Open todos and blockers.
- Last verification.
- Prompt assembly budget and included evidence IDs.

Add `/harness explain`:

- Show why top evidence was selected.
- Show omitted high-importance evidence when budget was tight.
- Show whether objective was updated or preserved for the last turn.

## Implementation Path

### Phase 1: Intent And State Stability

Files:
- `src/harness/types.ts`
- `src/harness/intent.ts`
- `src/harness/contract.ts`
- `src/harness/context-harness.ts`
- `tests/harness-intent.test.ts`

Tasks:
- Add `HarnessState.version`, `taskEpoch`, `rootObjective`, `activeInstruction`, `intentHistory`.
- Implement deterministic `classifyIntent()`.
- Change contract update so refinements do not overwrite root objective.
- Store active instruction separately.
- Add tests for short correction turns, new tasks, verification turns, and Chinese inputs.

Acceptance:
- A turn like "不对吧" or "灰色填充" does not erase the original task.
- An explicit "切到 v0.1.23 做 harness" starts a new epoch.

### Phase 2: Evidence Index And Ranked Assembly

Files:
- `src/harness/evidence.ts`
- `src/harness/assembler.ts`
- `src/framework/prompt.ts`
- `tests/harness-assembler.test.ts`

Tasks:
- Create `EvidenceRecord` from ledger and turn summaries.
- Implement relevance scoring.
- Add budgeted assembly slices.
- Return `PromptAssemblyStats`.
- Keep current prompt builder compatible.

Acceptance:
- Old but relevant file/tool facts are included when the user mentions that file/tool.
- Irrelevant old chat is omitted under small budgets.

### Phase 3: Turn Summaries And Durable Maintenance

Files:
- `src/harness/turn-summary.ts`
- `src/services/session-storage.ts`
- `src/commands/index.ts`
- `tests/session-storage.test.ts`

Tasks:
- Generate turn summaries from user input, assistant final text, tool calls, and ledger.
- Persist turn summaries in session meta or a sidecar `~/.openhorse/projects/<project>/sessions/<id>.harness.json`.
- Add `maintain()` to prune stale turn-level entries and keep task/session/persistent entries.

Acceptance:
- Resume restores root objective, active instruction, turn summaries, and verification state without replaying the whole transcript.

### Phase 4: Compact/Resume Semantics

Files:
- `src/services/compact/compact.ts`
- `src/services/compact/summary-generator.ts`
- `src/harness/capsule.ts`
- `tests/compact.test.ts`
- `tests/session-commands.test.ts`

Tasks:
- Emit structured harness state before natural-language summary.
- Add compaction mode: `pre_turn`, `manual`, `mid_turn`.
- Preserve canonical context ordering inspired by Codex.
- Reconcile harness state on `/resume`.

Acceptance:
- After compact, the next turn still knows root objective, open todos, changed files, and required verification.
- `/resume --last` keeps the active task state even if transcript is heavily compacted.

### Phase 5: UX And Debugging

Files:
- `src/commands/index.ts`
- `src/ui-v2`
- `tests/harness.test.ts`

Tasks:
- Extend `/harness`.
- Add `/harness explain`.
- Add warnings when context is stale or compact summary conflicts with current state.

Acceptance:
- Users can see why OpenHorse believes the current objective is what it is.
- Debug output explains prompt assembly without dumping secrets or huge transcripts.

## Testing Plan

Unit tests:
- Intent classifier: Chinese and English refinements, replacements, verification, meta config.
- Contract stability: root objective survives feedback and short corrections.
- Evidence scoring: path/tool/keyword matches outrank stale unrelated facts.
- Assembler budgets: hard caps, deterministic ordering, token estimate safety.
- Compact: structured state survives and appears before summary.
- Resume: state loads from session and reconciles with transcript.

Scenario tests:
- 50-turn long coding session with UI, MCP, skills, and test failures.
- Multi-topic conversation where user returns to an earlier task after 20 turns.
- Compact after tool-heavy output; verify large logs are summarized but commands/files remain.
- Resume a compacted session and ask "继续"; agent should pick correct next action.

Manual validation:

```bash
npm run build
npm test -- --runInBand tests/harness.test.ts tests/compact.test.ts tests/session-commands.test.ts
npm run start -- --ui v2
```

Manual prompts:
- "这个版本精进 harness..."
- "先调研，不要实现"
- "继续实现第一阶段"
- "不对，目标还是长会话理解，不是 UI"
- "/compact"
- "/resume --last"
- "继续刚才 harness 的下一步"

## Risks

- Too much structured harness text can crowd out source code. Mitigation: hard budgets and `/harness explain`.
- Deterministic intent classification may miss subtle user intent. Mitigation: confidence score and later optional LLM classifier.
- Turn summaries can become inaccurate if derived only from assistant text. Mitigation: prefer tool calls, file paths, verification results, and user inputs as evidence.
- Prompt cache can churn if dynamic state is inserted into static sections. Mitigation: keep harness state in a clearly dynamic segment.
- Resume can resurrect stale tasks. Mitigation: task epochs and explicit new-task detection.

## v0.1.23 Implementation Status

v0.1.23 implements Phases 1-5 with a deterministic Context Harness engine:

1. Stable root objective, task epochs, active instruction, constraints, non-goals, open questions, and intent history.
2. Deterministic intent classification for new tasks, refinements, interruption/replacement, verification, meta configuration, casual feedback, and continuation.
3. Ranked evidence assembly with budgeted prompt sections and `/harness explain` stats.
4. Turn summaries derived from user input, assistant outcome, tool calls, touched files, verification commands, and unresolved failures.
5. Project-scoped harness sidecars at `~/.openhorse/projects/<project>/sessions/<sessionId>.harness.json`, with lightweight session meta summaries and resume reconciliation.
6. Compact output now writes `[OpenHorse Context State v2]` before natural-language summaries so canonical state survives lossy compaction.
7. `/harness` shows current objective, epoch, active instruction, evidence, turn summaries, todos, verification, and diagnostics.

Deferred to later versions:

- LLM-assisted intent classifier.
- Embedding-based retrieval.
- Pluggable third-party context engines.
- Full prompt-cache observability.

This scope addresses the key requirement: after many turns, compact, or resume, OpenHorse keeps the core goal stable and dynamically assembles the prompt around the current user request.
