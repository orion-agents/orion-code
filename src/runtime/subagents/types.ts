/**
 * Subagent runtime types.
 *
 * v0.2.20 introduces a read-only subagent runtime: the root Agent may request
 * 1-3 independent investigation packets that a Supervisor runs as isolated
 * child agents under a unified budget, permission boundary and trace.
 *
 * These types are renderer- and protocol-agnostic. The runtime event shape
 * lives here so terminal/Ink/TUI consume one definition.
 */

/** Built-in child roles. v0.2.20 ships only read-only investigation roles. */
export type SubagentRole = 'research' | 'review' | 'test-investigate';

/** Whether the `subtask` capability is exposed to the root Agent at all. */
export type SubagentMode = 'off' | 'explicit' | 'auto';

/**
 * Renderer-independent subtask lifecycle state.
 *
 * `requested` is a pre-queue state. `rejected` is emitted as a runtime event
 * (via finalizeTask) when policy denies a task before it runs.
 */
export type RuntimeSubtaskState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'rejected';

export interface SubagentConfig {
  /** `off` hides the capability; `explicit` requires clear delegation intent; `auto` lets the model propose. */
  mode: SubagentMode;
  /** Maximum child agents running concurrently within one batch. */
  maxParallel: number;
  /** Maximum packets accepted in a single `subtask` call. */
  maxTasksPerTurn: number;
  /** Maximum root-turns a single child may consume. */
  maxTurnsPerTask: number;
  /** Maximum model requests a single child may spend. */
  maxModelRequestsPerTask: number;
  /** Aggregate model requests allowed across all children in one batch. */
  maxModelRequestsPerTurn: number;
  /** Maximum tool calls a single child may perform. */
  maxToolCallsPerTask: number;
  /** Hard wall-clock timeout per child. */
  timeoutMs: number;
  /** Enabled roles. A role not listed here is always rejected. */
  roles: SubagentRole[];
}

export const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = {
  mode: 'auto',
  maxParallel: 3,
  maxTasksPerTurn: 3,
  maxTurnsPerTask: 6,
  maxModelRequestsPerTask: 6,
  maxModelRequestsPerTurn: 12,
  maxToolCallsPerTask: 24,
  timeoutMs: 120_000,
  roles: ['research', 'review', 'test-investigate'],
};

/** Minimum/maximum bounds enforced regardless of user config. */
export const SUBAGENT_LIMITS = {
  maxParallel: { min: 1, max: 3 },
  maxTasksPerTurn: { min: 1, max: 3 },
  maxTurnsPerTask: { min: 1, max: 12 },
  maxModelRequestsPerTask: { min: 1, max: 24 },
  maxModelRequestsPerTurn: { min: 1, max: 48 },
  maxToolCallsPerTask: { min: 1, max: 96 },
  timeoutMs: { min: 5_000, max: 600_000 },
} as const;

export interface SubtaskScope {
  /** Canonical, in-project paths the child is scoped to. */
  paths?: string[];
  /** Symbols / identifiers the child should focus on. */
  symbols?: string[];
}

export interface SubtaskPacket {
  /** Caller-proposed id. Runtime generates the authoritative id and ignores this. */
  id?: string;
  role: SubagentRole;
  /** What the child must produce a conclusion about. */
  objective: string;
  /** Why this is independently delegable (used by policy + trace). */
  reason: string;
  scope?: SubtaskScope;
  /** Extra context the root Agent wants the child to consider. */
  contextHints?: string[];
  /** What a good result looks like. */
  expectedOutput?: string;
}

export interface SubtaskRequest {
  tasks: SubtaskPacket[];
  /** `parallel` runs concurrently; `serial` runs in order. */
  execution: 'parallel' | 'serial';
}

export interface SubtaskUsage {
  modelRequests: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  /** Sum of provider-reported costs, present only when every child call reported cost. */
  costUsd?: number;
}

export const EMPTY_SUBTASK_USAGE: SubtaskUsage = {
  modelRequests: 0,
  toolCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  durationMs: 0,
};

export interface SubtaskFinding {
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  evidence: string;
  file?: string;
  line?: number;
}

export interface SubtaskCommandSuggestion {
  command: string;
  purpose: string;
  /** Always false in v0.2.20: children never execute, only suggest. */
  executed: false;
}

export type SubtaskResultStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'rejected';

export interface SubtaskResult {
  id: string;
  role: SubagentRole;
  status: SubtaskResultStatus;
  summary: string;
  findings: SubtaskFinding[];
  files: string[];
  commands: SubtaskCommandSuggestion[];
  verification: string[];
  risks: string[];
  usage: SubtaskUsage;
}

export interface SubtaskBatchResult {
  batchId: string;
  results: SubtaskResult[];
  aggregateUsage: SubtaskUsage;
}

/** Renderer-independent subtask lifecycle event. */
export interface RuntimeSubtaskEvent {
  batchId: string;
  taskId: string;
  role: SubagentRole;
  state: RuntimeSubtaskState;
  objective: string;
  summary?: string;
  durationMs?: number;
  usage?: SubtaskUsage;
}

export function sumSubtaskUsage(usages: SubtaskUsage[]): SubtaskUsage {
  const aggregate = usages.reduce(
    (acc, u) => ({
      modelRequests: acc.modelRequests + u.modelRequests,
      toolCalls: acc.toolCalls + u.toolCalls,
      promptTokens: acc.promptTokens + u.promptTokens,
      completionTokens: acc.completionTokens + u.completionTokens,
      durationMs: acc.durationMs + u.durationMs,
    }),
    { ...EMPTY_SUBTASK_USAGE },
  );
  if (usages.length > 0 && usages.every(usage => usage.costUsd !== undefined)) {
    aggregate.costUsd = usages.reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0);
  }
  return aggregate;
}
