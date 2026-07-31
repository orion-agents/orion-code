/**
 * v0.2.24 — Goal / Target Mode domain types.
 *
 * Goal is a persistent, single-session entity that the Agent pursues across
 * multiple turns, Compact, process restart, and /resume. It is NOT a
 * Harness field, a prompt string, or a UI state — it is an independent
 * lifecycle entity with its own sidecar storage.
 */

// ============================================================================
// Status
// ============================================================================

export type GoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usage_limited'
  | 'budget_limited'
  | 'complete';

export const GOAL_ACTIVE_STATES: ReadonlySet<GoalStatus> = new Set(['active']);
export const GOAL_TERMINAL_STATES: ReadonlySet<GoalStatus> = new Set([
  'blocked', 'usage_limited', 'budget_limited', 'complete',
]);
export const GOAL_USER_RECOVERABLE_STATES: ReadonlySet<GoalStatus> = new Set([
  'paused', 'blocked', 'usage_limited', 'budget_limited',
]);

// ============================================================================
// Core domain types
// ============================================================================

export interface GoalBlocker {
  fingerprint: string;
  firstSeenAt: number;
  lastSeenAt: number;
  consecutiveTurns: number;
  summary: string;
}

export interface GoalLastTurn {
  turnId: string;
  finishReason: string;
  endedAt: number;
  promptTokens: number;
  completionTokens: number;
  subagentTokens: number;
  totalTokens: number;
  madeProgress: boolean;
}

export interface GoalCompletionAudit {
  requestedAt: number;
  auditedAt: number;
  passed: boolean;
  verificationSummary: string;
  remainingRequirements: string[];
  evidenceRefs: string[];
}

export interface GoalStopReason {
  kind: 'user' | 'blocked' | 'usage_limit' | 'budget_limit' | 'runtime_error';
  message: string;
  at: number;
}

// ============================================================================
// v0.1.2 - Goal Contract, criteria, plan, evidence
// (additive to SessionGoalV1; v0.1.1 sidecars load without these and are
// normalized at load time into a minimal pending contract.)
// ============================================================================

export type GoalEvidenceKind =
  | 'test'
  | 'build'
  | 'lint'
  | 'file'
  | 'runtime'
  | 'external'
  | 'user';

export type GoalCriterionStatus = 'pending' | 'passed' | 'failed' | 'stale';

export interface GoalCriterion {
  id: string;
  statement: string;
  source: 'user' | 'derived';
  status: GoalCriterionStatus;
  requiredEvidenceKinds: GoalEvidenceKind[];
  evidenceRefs: string[];
}

export interface GoalConstraint {
  id: string;
  statement: string;
  source: 'user' | 'derived';
}

export interface GoalPlanStep {
  id: string;
  description: string;
  done: boolean;
}

export interface GoalPlanSnapshot {
  revision: number;
  phase: string;
  steps: GoalPlanStep[];
  nextAction?: string;
  updatedAt: number;
}

/**
 * Auditable contract layered on top of the objective string.
 * - `originalObjective` is set at creation and never silently rewritten by
 *   steering; `/target edit` bumps `objectiveRevision` and records the change.
 * - `/target replace` creates a new goalId and a fresh contract.
 * - User-supplied success criteria are `source=user` and cannot be weakened by
 *   the agent; derived criteria are `source=derived`.
 */
export interface GoalContract {
  originalObjective: string;
  objectiveRevision: number;
  constraints: GoalConstraint[];
  successCriteria: GoalCriterion[];
  planSnapshot?: GoalPlanSnapshot;
}

/**
 * Runtime-managed evidence record. The model can only reference captured
 * evidence by id; it cannot self-certify a `passed` result from natural
 * language. Full ledger wiring lands in Phase 3; the type is defined here so
 * the contract and audit can reference it.
 */
export interface GoalEvidenceRecord {
  id: string;
  goalId: string;
  goalRevision: number;
  turnId: string;
  kind: GoalEvidenceKind;
  subject: string;
  result: 'passed' | 'failed' | 'inconclusive';
  sourceRef: string;
  capturedAt: number;
  workspaceFingerprint?: string;
  expiresAt?: number;
  redacted: boolean;
}

// ============================================================================
// Persistent sidecar
// ============================================================================

export interface SessionGoalV1 {
  version: 1;
  goalId: string;
  sessionId: string;
  revision: number;
  objective: string;
  status: GoalStatus;

  tokenBudget?: number;
  tokensUsed: number;
  timeUsedMs: number;

  createdAt: number;
  updatedAt: number;
  activeSince?: number;
  completedAt?: number;

  continuationCount: number;
  noProgressCount: number;
  blocker?: GoalBlocker;

  lastTurn?: GoalLastTurn;
  completionAudit?: GoalCompletionAudit;
  stopReason?: GoalStopReason;

  // v0.1.2 additive: auditable contract with success criteria and plan.
  // Optional so v0.1.1 sidecars load unchanged; coordinators normalize a
  // missing contract into a minimal pending one at load time.
  contract?: GoalContract;
}

// ============================================================================
// Runtime snapshot (Store projection)
// ============================================================================

export interface RuntimeGoalSnapshot {
  goalId: string;
  revision: number;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedMs: number;
  continuationCount: number;
  updatedAt: number;
  stopReason?: string;
}

// ============================================================================
// Turn protocol
// ============================================================================

export type AgentInputKind =
  | 'user'
  | 'revision'
  | 'goal_continuation'
  | 'command';

export interface GoalTurnContext {
  goalId: string;
  revision: number;
  continuationIndex: number;
}

export interface AgentTurnRequest {
  inputKind: AgentInputKind;
  text?: string;
  sessionId: string;
  goal?: GoalTurnContext;
  persistAsUserMessage: boolean;
  echoToTranscript: boolean;
}

export interface AgentTurnOutcome {
  turnId: string;
  sessionId: string;
  goalId?: string;
  goalRevision?: number;
  startedAt: number;
  endedAt: number;
  finishReason: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    subagentTokens: number;
    totalTokens: number;
  };
  madeProgress: boolean;
  blocker?: {
    fingerprint: string;
    summary: string;
    retryable: boolean;
  };
  providerError?: {
    kind: 'usage_limit' | 'rate_limit' | 'auth' | 'network' | 'unknown';
    retryable: boolean;
  };
  pendingTerminalRequest?: {
    requestedStatus: 'complete' | 'blocked';
    requestedAt: number;
  };
  // v0.1.2: evidence captured during the turn. The controller populates these
  // from real tool/runtime results so finalizeTurn's audit branch can run
  // per-criterion instead of trusting model text.
  evidenceRefs?: string[];
  verificationSummary?: string;
}

// ============================================================================
// Goal control input
// ============================================================================

export type GoalControlAction =
  | 'show'
  | 'create'
  | 'edit'
  | 'replace'
  | 'pause'
  | 'resume'
  | 'clear'
  | 'set_budget';

export interface GoalControlInput {
  type: 'goal_control';
  action: GoalControlAction;
  payload?: {
    objective?: string;
    tokenBudget?: number | null;  // null = clear budget
    confirmed?: boolean;         // required for clear
  };
}

// ============================================================================
// Runtime events
// ============================================================================

export interface GoalUpdatedEvent {
  type: 'goal_updated';
  goal: RuntimeGoalSnapshot;
  reason: string;
}

export interface GoalClearedEvent {
  type: 'goal_cleared';
  goalId: string;
  reason: string;
}

export interface GoalContinuationEvent {
  type: 'goal_continuation';
  goalId: string;
  phase: 'scheduled' | 'started' | 'deferred' | 'stopped';
  reason: string;
}

export interface GoalAuditFailedEvent {
  type: 'goal_audit_failed';
  goalId: string;
  audit: 'completion' | 'blocked';
  summary: string;
}

export interface GoalRestoredEvent {
  type: 'goal_restored';
  goal: RuntimeGoalSnapshot;
}

export interface GoalCompletedEvent {
  type: 'goal_completed';
  goal: RuntimeGoalSnapshot;
  audit: GoalCompletionAudit;
}

export interface GoalPlanUpdatedEvent {
  type: 'goal_plan_updated';
  goalId: string;
  planRevision: number;
  phase: string;
  nextAction?: string;
}

export interface GoalEvidenceRecordedEvent {
  type: 'goal_evidence_recorded';
  goalId: string;
  evidence: { id: string; kind: GoalEvidenceKind; result: 'passed' | 'failed' | 'inconclusive'; subject: string };
}

// ============================================================================
// State machine
// ============================================================================

/**
 * Valid status transitions for the Goal state machine.
 * Returns the allowed next status, or null if the transition is invalid.
 */
export function goalTransition(
  current: GoalStatus | null,
  event: 'create' | 'pause' | 'resume' | 'complete' | 'block' | 'usage_limit' | 'budget_limit' | 'replace' | 'clear',
): GoalStatus | null {
  if (event === 'create') return current === null ? 'active' : null;
  if (event === 'replace') return 'active';  // always allowed, generates new goalId
  if (event === 'clear') return null;        // removes goal entirely

  if (current === null) return null;

  switch (current) {
    case 'active':
      if (event === 'pause') return 'paused';
      if (event === 'complete') return 'complete';
      if (event === 'block') return 'blocked';
      if (event === 'usage_limit') return 'usage_limited';
      if (event === 'budget_limit') return 'budget_limited';
      return null;

    case 'paused':
      if (event === 'resume') return 'active';
      return null;

    case 'blocked':
    case 'usage_limited':
    case 'budget_limited':
      if (event === 'resume') return 'active';
      return null;

    case 'complete':
      return null;  // terminal — only replace or clear

    default:
      return null;
  }
}

/** Constraints from the goal plan that must hold across the state machine. */
export const GOAL_INVARIANTS = {
  maxObjectiveChars: 4000,
  maxConsecutiveBlockerTurns: 3,
  maxConsecutiveNoProgressTurns: 3,
  tokenBudgetMin: 1,
} as const;