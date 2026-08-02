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
  'blocked',
  'usage_limited',
  'budget_limited',
  'complete',
]);
export const GOAL_USER_RECOVERABLE_STATES: ReadonlySet<GoalStatus> = new Set([
  'paused',
  'blocked',
  'usage_limited',
  'budget_limited',
]);

// ============================================================================
// Core domain types
// ============================================================================

export type GoalBlockerCategory = 'user_input' | 'permission' | 'external_state';

export interface GoalBlocker {
  category: GoalBlockerCategory;
  fingerprint: string;
  firstSeenAt: number;
  lastSeenAt: number;
  consecutiveTurns: number;
  summary: string;
  retryable: false;
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

/** Bounded, redacted explanation of a turn that did not advance the Goal. */
export interface GoalNoProgressTurn {
  turnId: string;
  endedAt: number;
  finishReason: string;
  passedEvidence: number;
  failedEvidence: number;
  inconclusiveEvidence: number;
  planUpdateProposed: boolean;
  blockerCategory?: GoalBlockerCategory;
}

export interface GoalCompletionAudit {
  requestedAt: number;
  auditedAt: number;
  passed: boolean;
  verificationSummary: string;
  remainingRequirements: string[];
  evidenceRefs: string[];
  criterionResults?: Array<{
    criterionId: string;
    passed: boolean;
    status: GoalCriterionStatus;
    evidenceRefs: string[];
    reason?: string;
  }>;
  /** Persisted, runtime-generated completion receipt. Optional for older sidecars. */
  finalSummary?: {
    originalObjective: string;
    currentObjective: string;
    objectiveRevision: number;
    completedAt: number;
    verificationSummary: string;
    criterionResults: Array<{
      criterionId: string;
      status: GoalCriterionStatus;
      evidenceRefs: string[];
      /** Additive v0.1.2 provenance receipt; absent on older sidecars. */
      evidence?: GoalFinalEvidence[];
    }>;
    evidenceRefs: string[];
    accounting: {
      tokensUsed: number;
      timeUsedMs: number;
      continuationCount: number;
      usageComplete: true;
    };
    remainingRequirements: [];
    stopReason: 'completed';
  };
}

export type GoalEvidenceProvenance = 'runtime_automatic' | 'external' | 'user_acceptance';

export interface GoalFinalEvidence {
  evidenceId: string;
  kind: GoalEvidenceKind;
  provenance: GoalEvidenceProvenance;
  result: GoalEvidenceRecord['result'];
  subject: string;
}

export interface GoalStopReason {
  kind:
    | 'user'
    | 'blocked'
    | 'usage_limit'
    | 'budget_limit'
    | 'rate_limit'
    | 'provider_busy'
    | 'auth'
    | 'network'
    | 'runtime_error';
  message: string;
  at: number;
}

// ============================================================================
// v0.1.2 - Goal Contract, criteria, plan, evidence
// (additive to SessionGoalV1; v0.1.1 sidecars load without these and are
// normalized at load time into a minimal pending contract.)
// ============================================================================

export type GoalEvidenceKind = 'test' | 'build' | 'lint' | 'file' | 'runtime' | 'external' | 'user';

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

export interface GoalPlanUpdate {
  phase: string;
  steps: Array<{ description: string; done: boolean }>;
  nextAction?: string;
  derivedCriteria: Array<{
    statement: string;
    requiredEvidenceKinds: GoalEvidenceKind[];
  }>;
}

export interface GoalCreationContractInput {
  constraints?: string[];
  successCriteria?: Array<{
    statement: string;
    requiredEvidenceKinds: GoalEvidenceKind[];
  }>;
}

export interface GoalObjectiveRevision {
  revision: number;
  previousObjective: string;
  objective: string;
  reason: string;
  changedAt: number;
  source: 'user';
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
  /** Additive edit history; absent on v0.1.1 and early v0.1.2 sidecars. */
  objectiveHistory?: GoalObjectiveRevision[];
  constraints: GoalConstraint[];
  successCriteria: GoalCriterion[];
  planSnapshot?: GoalPlanSnapshot;
}

/**
 * Runtime-managed evidence record. The model can only reference captured
 * evidence by id; it cannot self-certify a `passed` result from natural
 * language. The runtime ledger and completion audit use this record as the
 * only source of terminal completion evidence.
 */
export interface GoalEvidenceRecord {
  id: string;
  goalId: string;
  goalRevision: number;
  /** Objective epoch at capture time; evidence never crosses `/target edit`. */
  objectiveRevision: number;
  turnId: string;
  kind: GoalEvidenceKind;
  subject: string;
  result: 'passed' | 'failed' | 'inconclusive';
  sourceRef: string;
  capturedAt: number;
  workspaceFingerprint?: string;
  expiresAt?: number;
  /** Structured proof for external completion actions. */
  externalAssertion?: import('../../framework/external-assertion').ToolExternalAssertion;
  redacted: boolean;
}

/**
 * Additive summary of evidence removed from the bounded ledger for the current
 * objective epoch. Passing evidence may be replaced by a newer verification,
 * but losing failed or inconclusive evidence is safety-significant and makes
 * completion fail closed until `/target edit` starts a new objective epoch.
 */
export interface GoalEvidenceLedgerTruncation {
  objectiveRevision: number;
  droppedPassed: number;
  droppedFailed: number;
  droppedInconclusive: number;
}

export interface GoalCriterionEvidence {
  criterionId: string;
  evidenceIds: string[];
}

export interface GoalTerminalRequest {
  requestedStatus: 'complete' | 'blocked';
  requestedAt: number;
  goalId: string;
  goalRevision: number;
  turnId: string;
  /** Explicit model-proposed mapping; every reference is revalidated by the runtime. */
  criterionEvidence?: GoalCriterionEvidence[];
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
  /** Additive bounded history used to explain an automatic no-progress pause. */
  recentNoProgressTurns?: GoalNoProgressTurn[];
  /** Bounded hashes of criterion-relevant passed evidence used for progress deduplication. */
  progressEvidenceKeys?: string[];
  blocker?: GoalBlocker;

  lastTurn?: GoalLastTurn;
  completionAudit?: GoalCompletionAudit;
  stopReason?: GoalStopReason;
  /** Pending/confirmed explicit user authorization for a high-impact objective. */
  boundaryConfirmation?: {
    requiredAt: number;
    reason: string;
    objectiveRevision: number;
    confirmedAt?: number;
    confirmedRevision?: number;
  };

  // v0.1.2 additive: auditable contract with success criteria and plan.
  // Optional so v0.1.1 sidecars load unchanged; coordinators normalize a
  // missing contract into a minimal pending one at load time.
  contract?: GoalContract;
  /** Additive, bounded ledger of evidence captured by the runtime. */
  evidenceLedger?: GoalEvidenceRecord[];
  /** Additive v0.1.2 metadata; absent in v0.1.1 sidecars. */
  evidenceLedgerTruncation?: GoalEvidenceLedgerTruncation;
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
  criteria?: { passed: number; total: number; failed: number; stale: number };
  planRevision?: number;
  planPhase?: string;
  nextAction?: string;
  auditRemaining?: string[];
}

// ============================================================================
// Turn protocol
// ============================================================================

export type AgentInputKind = 'user' | 'revision' | 'goal_continuation' | 'command';

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
  generation: number;
}

export interface AgentTurnOutcome {
  turnId: string;
  sessionId: string;
  goalId?: string;
  goalRevision?: number;
  goalGeneration?: number;
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
  /** Runtime-observed workspace delta for auditable no-progress accounting. */
  workspaceChanged?: boolean;
  blocker?: {
    category: GoalBlockerCategory;
    fingerprint: string;
    summary: string;
    retryable: boolean;
  };
  providerError?: {
    kind: 'usage_limit' | 'rate_limit' | 'provider_busy' | 'auth' | 'network' | 'unknown';
    retryable: boolean;
  };
  pendingTerminalRequest?: GoalTerminalRequest;
  pendingPlanUpdate?: GoalPlanUpdate;
  // v0.1.2: evidence captured during the turn. The controller populates these
  // from real tool/runtime results so finalizeTurn's audit branch can run
  // per-criterion instead of trusting model text.
  evidenceRefs?: string[];
  verificationSummary?: string;
  evidenceRecords?: GoalEvidenceRecord[];
  /** Workspace identity at turn finalization for stale-evidence rejection. */
  workspaceFingerprint?: string;
  /** False when usage was omitted; unknown usage must not be treated as zero. */
  usageComplete?: boolean;
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
  | 'confirm'
  | 'clear'
  | 'set_budget';

export interface GoalControlInput {
  type: 'goal_control';
  action: GoalControlAction;
  payload?: {
    objective?: string;
    criterionId?: string;
    tokenBudget?: number | null; // null = clear budget
    confirmed?: boolean; // required for clear
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
  evidence: {
    id: string;
    kind: GoalEvidenceKind;
    result: 'passed' | 'failed' | 'inconclusive';
    subject: string;
  };
}

export type GoalRuntimeEvent =
  | GoalUpdatedEvent
  | GoalClearedEvent
  | GoalContinuationEvent
  | GoalAuditFailedEvent
  | GoalRestoredEvent
  | GoalCompletedEvent
  | GoalPlanUpdatedEvent
  | GoalEvidenceRecordedEvent;

// ============================================================================
// State machine
// ============================================================================

/**
 * Valid status transitions for the Goal state machine.
 * Returns the allowed next status, or null if the transition is invalid.
 */
export function goalTransition(
  current: GoalStatus | null,
  event:
    | 'create'
    | 'pause'
    | 'resume'
    | 'complete'
    | 'block'
    | 'usage_limit'
    | 'budget_limit'
    | 'replace'
    | 'clear'
): GoalStatus | null {
  if (event === 'create') return current === null ? 'active' : null;
  if (event === 'replace') return 'active'; // always allowed, generates new goalId
  if (event === 'clear') return null; // removes goal entirely

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
      return null; // terminal — only replace or clear

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
