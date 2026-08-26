/** Scope whose current unit of work reached a stopping boundary. */
export type StopDecisionScope = 'request' | 'goal' | 'subagent' | 'runtime';

/** Observable state at the boundary. This does not imply that a parent task completed. */
export type StopDecisionStatus = 'completed' | 'stopped' | 'blocked' | 'cancelled' | 'failed';

/** What the owner of the parent state machine may do next. */
export type StopDisposition = 'finish_scope' | 'pause_scope' | 'resume_allowed';

export interface StopReason {
  code: string;
  message: string;
}

export interface StopEvidence {
  kind: 'resource_limit' | 'tool_boundary' | 'verification' | 'provider' | 'runtime';
  source: string;
  detail: string;
}

export interface StopNextAction {
  kind: 'continue' | 'inspect' | 'retry' | 'resume' | 'change_input' | 'raise_budget';
  label: string;
  command?: string;
}

export interface StopResourceCounter {
  used: number;
  limit?: number;
}

export interface StopResourceSnapshot {
  turns?: StopResourceCounter;
  llmRequests?: StopResourceCounter;
  providerAttempts?: StopResourceCounter;
  toolCalls?: StopResourceCounter;
  modelVisibleToolBytes?: StopResourceCounter;
  tokens?: StopResourceCounter;
  elapsedMs?: StopResourceCounter;
}

export interface StopDecisionInput {
  scope: StopDecisionScope;
  status: StopDecisionStatus;
  disposition: StopDisposition;
  reason: StopReason;
  evidence: StopEvidence[];
  nextActions: StopNextAction[];
  resources: StopResourceSnapshot;
  /** Additive Harness state used for criterion-aware completion and replay. */
  criterionStates?: Array<{
    id: string;
    status: 'pending' | 'passed' | 'failed' | 'waived';
  }>;
  progressDelta?: import('../harness/types').ProgressDelta;
  evidenceRefs?: string[];
  resumable?: boolean;
}

export interface StopDecision extends StopDecisionInput {
  schemaVersion: 1;
}

function assertCounter(name: string, counter: StopResourceCounter): void {
  for (const [field, value] of Object.entries(counter)) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new Error(
        `StopDecision resource ${name}.${field} must be a finite non-negative integer`
      );
    }
  }
}

/** Create an immutable, serializable stop decision and reject invalid accounting. */
export function createStopDecision(input: StopDecisionInput): StopDecision {
  for (const [name, counter] of Object.entries(input.resources)) {
    if (counter) assertCounter(name, counter);
  }
  return {
    schemaVersion: 1,
    ...input,
    reason: { ...input.reason },
    evidence: input.evidence.map(item => ({ ...item })),
    nextActions: input.nextActions.map(item => ({ ...item })),
    resources: Object.fromEntries(
      Object.entries(input.resources).map(([name, counter]) => [
        name,
        counter ? { ...counter } : counter,
      ])
    ) as StopResourceSnapshot,
    ...(input.criterionStates
      ? { criterionStates: input.criterionStates.map(item => ({ ...item })) }
      : {}),
    ...(input.progressDelta ? { progressDelta: structuredClone(input.progressDelta) } : {}),
    ...(input.evidenceRefs ? { evidenceRefs: [...input.evidenceRefs] } : {}),
  };
}
