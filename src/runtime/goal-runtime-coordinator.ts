import { createStopDecision, type StopDecision } from '../framework/stop-decision';
import type { AgentLoopTurnCommitV1 } from './agent-loop';
import {
  GoalLifecycleServiceV2,
  assertGoalLifecycleStateV2,
  type GoalLifecycleBudgetV2,
  type GoalLifecycleStateV2,
  type GoalTurnObservationV2,
} from './goal-lifecycle-v2';
import { digestRuntimeValue } from './protocol/canonical';
import type { ThreadTurnRequestV1 } from './thread-admission';
import type { TurnCommitV1 } from './turn-commit';

export interface GoalRuntimeDefinitionV2 {
  readonly objective: string;
  readonly budget: GoalLifecycleBudgetV2;
  readonly goalId?: string;
  readonly state?: GoalLifecycleStateV2;
}

export interface GoalRuntimeTombstoneV2 {
  readonly version: 2;
  readonly kind: 'goal_tombstone';
  readonly goalId?: string;
  readonly generation: number;
  readonly clearedAt: number;
  readonly reason: 'user_clear';
  readonly digest: string;
}

export type GoalRuntimePersistedStateV2 = GoalLifecycleStateV2 | GoalRuntimeTombstoneV2;

export type GoalRuntimeControlV2 =
  | { readonly action: 'status' }
  | {
      readonly action: 'create';
      readonly objective: string;
      readonly budget?: GoalLifecycleBudgetV2;
    }
  | { readonly action: 'pause' }
  | { readonly action: 'resume' }
  | { readonly action: 'clear' };

export interface GoalRuntimeControlResultV2 {
  readonly accepted: boolean;
  readonly action: GoalRuntimeControlV2['action'];
  readonly message: string;
  readonly state?: GoalLifecycleStateV2;
  readonly tombstone?: GoalRuntimeTombstoneV2;
  readonly scheduleContinuation: boolean;
}

export interface GoalRuntimeCoordinatorOptionsV2 {
  readonly definition?: GoalRuntimeDefinitionV2;
  readonly restoredCommit?: TurnCommitV1;
  readonly clock?: () => number;
  readonly continuationInput?: (state: GoalLifecycleStateV2) => string;
}

export interface GoalRuntimeCommitFieldsV2 {
  readonly goalState?: GoalRuntimePersistedStateV2;
  readonly stopDecision?: StopDecision;
}

export interface GoalRuntimeDurableReceiptV2 {
  readonly turnId: string;
  readonly terminal: TurnCommitV1['terminal'];
  readonly goalStateDigest?: string;
  readonly stopDecisionDigest?: string;
}

export type GoalRuntimePersistTurnV2 = (
  fields: GoalRuntimeCommitFieldsV2
) => GoalRuntimeDurableReceiptV2;

interface PendingContinuationV2 {
  readonly terminal: TurnCommitV1['terminal'];
  readonly request: ThreadTurnRequestV1 & { readonly mode: 'goal'; readonly kind: 'goal' };
}

/**
 * Production owner that binds GoalLifecycleServiceV2 to the atomic TurnCommit boundary.
 *
 * Finalization is evaluated on a disposable lifecycle clone. The authoritative
 * in-memory state advances only after the caller returns a digest-matching durable
 * receipt, so a failed append can neither advance Goal state nor schedule work.
 */
export class GoalRuntimeCoordinatorV2 {
  readonly serviceId = 'goal-runtime-v2' as const;

  private readonly clock: () => number;
  private readonly continuationInput: (state: GoalLifecycleStateV2) => string;
  private lifecycle: GoalLifecycleServiceV2 | undefined;
  private tombstoneValue: GoalRuntimeTombstoneV2 | undefined;
  private readonly turnStartedAt = new Map<string, number>();
  private readonly pendingContinuations = new Map<string, PendingContinuationV2>();
  private restoredContinuationAvailable = false;
  private closed = false;

  constructor(options: GoalRuntimeCoordinatorOptionsV2 = {}) {
    this.clock = options.clock ?? Date.now;
    this.continuationInput = options.continuationInput ?? defaultContinuationInput;

    const restored = parseGoalPersistence(options.restoredCommit);
    this.tombstoneValue = restored.tombstone;
    const definition = restored.state
      ? {
          objective: restored.state.objective,
          budget: restored.state.budget,
          state: restored.state,
        }
      : restored.tombstone
        ? undefined
        : options.definition;
    if (definition) this.lifecycle = createLifecycle(definition, this.clock);
    this.restoredContinuationAvailable = Boolean(
      restored.state?.status === 'active' && options.restoredCommit?.terminal === 'completed'
    );
  }

  get state(): GoalLifecycleStateV2 | undefined {
    return this.lifecycle?.state;
  }

  get active(): boolean {
    return !this.closed && this.lifecycle?.state.status === 'active';
  }

  get tombstone(): GoalRuntimeTombstoneV2 | undefined {
    return this.tombstoneValue ? deepFreeze(structuredClone(this.tombstoneValue)) : undefined;
  }

  create(definition: GoalRuntimeDefinitionV2): GoalLifecycleStateV2 {
    if (this.closed) throw new Error('Closed Goal runtime cannot create a Goal.');
    if (this.lifecycle) throw new Error('Goal runtime already owns a Goal.');
    this.lifecycle = createLifecycle(definition, this.clock);
    this.tombstoneValue = undefined;
    this.restoredContinuationAvailable = false;
    return this.lifecycle.state;
  }

  control(
    control: GoalRuntimeControlV2,
    turnId: string,
    persist?: GoalRuntimePersistTurnV2
  ): GoalRuntimeControlResultV2 {
    if (this.closed) throw new Error('Closed Goal runtime cannot accept Goal control.');
    if (control.action === 'status') return this.controlStatus();
    if (!persist) throw new Error(`Goal ${control.action} requires a durable TurnCommit callback.`);

    const current = this.lifecycle?.state;
    let candidate: GoalLifecycleServiceV2 | undefined;
    let tombstone = this.tombstoneValue;
    let accepted = true;
    let message: string;
    let scheduleContinuation = false;

    switch (control.action) {
      case 'create': {
        if (current) {
          accepted = false;
          candidate = createLifecycleFromState(current, this.clock);
          message = 'A Goal already exists; clear it before creating another.';
          break;
        }
        const objective = control.objective.trim();
        if (!objective) {
          accepted = false;
          message = 'Goal objective must not be empty.';
          break;
        }
        candidate = createLifecycle(
          {
            objective,
            budget: control.budget ?? defaultGoalBudget(),
          },
          this.clock
        );
        tombstone = undefined;
        scheduleContinuation = true;
        message = 'Goal created and scheduled from the durable control boundary.';
        break;
      }
      case 'pause': {
        if (!current) {
          accepted = false;
          message = 'No Goal exists to pause.';
          break;
        }
        candidate = createLifecycleFromState(current, this.clock);
        if (current.status === 'active') candidate.pause('Goal paused by user control.');
        else if (current.status !== 'paused') accepted = false;
        message = accepted ? 'Goal paused.' : `Goal cannot pause from ${current.status}.`;
        break;
      }
      case 'resume': {
        if (!current) {
          accepted = false;
          message = 'No Goal exists to resume.';
          break;
        }
        candidate = createLifecycleFromState(current, this.clock);
        if (current.status === 'paused') candidate.resume();
        else if (current.status !== 'active') accepted = false;
        scheduleContinuation = accepted && candidate.state.status === 'active';
        message = accepted ? 'Goal resumed.' : `Goal cannot resume from ${current.status}.`;
        break;
      }
      case 'clear': {
        if (!current) {
          accepted = false;
          message = 'No Goal exists to clear.';
          break;
        }
        tombstone = createGoalTombstone(current, this.clock());
        message = 'Goal cleared at the durable control boundary.';
        break;
      }
    }

    const persisted = candidate?.state ?? tombstone;
    const decision = controlDecision(control.action, accepted, message);
    const receipt = persist({
      ...(persisted ? { goalState: persisted } : {}),
      stopDecision: decision,
    });
    assertControlReceipt(turnId, persisted, decision, receipt);

    this.lifecycle = candidate;
    this.tombstoneValue = tombstone;
    this.restoredContinuationAvailable = false;
    this.pendingContinuations.delete(turnId);
    if (accepted && scheduleContinuation && candidate && receipt.terminal === 'completed') {
      this.pendingContinuations.set(turnId, {
        terminal: 'completed',
        request: this.createContinuationRequest(candidate.state),
      });
    }
    return deepFreeze({
      accepted,
      action: control.action,
      message,
      ...(candidate ? { state: candidate.state } : {}),
      ...(tombstone ? { tombstone } : {}),
      scheduleContinuation: accepted && scheduleContinuation,
    });
  }

  resume(): GoalLifecycleStateV2 | undefined {
    if (this.closed || !this.lifecycle) return undefined;
    this.restoredContinuationAvailable = false;
    return this.lifecycle.resume();
  }

  markTurnStarted(turnId: string, startedAt = this.clock()): void {
    if (this.closed || !this.lifecycle) return;
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) return;
    this.turnStartedAt.set(turnId, startedAt);
  }

  /**
   * Finalize Goal state and persist it with transcript/TaskContext in one TurnCommit.
   * The persist callback must synchronously return the authoritative durable receipt.
   */
  commitTurn(
    turn: AgentLoopTurnCommitV1,
    persist: GoalRuntimePersistTurnV2
  ): GoalRuntimeDurableReceiptV2 {
    if (this.closed) throw new Error('Closed Goal runtime cannot commit a turn.');
    const requestDecision = requestDecisionForGoal(turn);
    if (!this.lifecycle) {
      const receipt = persist({
        ...(this.tombstoneValue ? { goalState: this.tombstoneValue } : {}),
        ...(requestDecision ? { stopDecision: requestDecision } : {}),
      });
      if (this.tombstoneValue) {
        assertPersistedStateReceipt(this.tombstoneValue, requestDecision, receipt);
      }
      return receipt;
    }

    const current = this.lifecycle.state;
    const candidate = new GoalLifecycleServiceV2({
      objective: current.objective,
      budget: current.budget,
      state: current,
      clock: this.clock,
    });
    const observation = this.observeTurn(turn, requestDecision);
    const resolution = candidate.finalizeTurn(observation);
    const stopDecision = resolution.decision ?? requestDecision;
    const receipt = persist({
      goalState: resolution.state,
      ...(stopDecision ? { stopDecision } : {}),
    });
    assertDurableReceipt(turn.turnId, resolution.state, stopDecision, receipt);

    // Install only after the durable receipt proves that the candidate state is
    // part of the same TurnCommit as transcript and TaskContext.
    this.lifecycle = new GoalLifecycleServiceV2({
      objective: resolution.state.objective,
      budget: resolution.state.budget,
      state: resolution.state,
      clock: this.clock,
    });
    this.tombstoneValue = undefined;
    this.turnStartedAt.delete(turn.turnId);
    this.restoredContinuationAvailable = false;
    this.pendingContinuations.delete(turn.turnId);
    if (resolution.scheduleContinuation && receipt.terminal === 'completed') {
      this.pendingContinuations.set(turn.turnId, {
        terminal: receipt.terminal,
        request: this.createContinuationRequest(resolution.state),
      });
    }
    return receipt;
  }

  /** Release an autonomous continuation only after ThreadRuntime commits the turn terminal. */
  afterDurableTerminal(
    turnId: string,
    terminal: TurnCommitV1['terminal']
  ): (ThreadTurnRequestV1 & { readonly mode: 'goal'; readonly kind: 'goal' }) | undefined {
    const pending = this.pendingContinuations.get(turnId);
    this.pendingContinuations.delete(turnId);
    if (this.closed || !pending || pending.terminal !== terminal || terminal !== 'completed') {
      return undefined;
    }
    return pending.request;
  }

  /** One-shot recovery continuation for a previously terminal, active Goal commit. */
  takeRestoredContinuation():
    | (ThreadTurnRequestV1 & { readonly mode: 'goal'; readonly kind: 'goal' })
    | undefined {
    if (!this.restoredContinuationAvailable || !this.active || !this.lifecycle) return undefined;
    this.restoredContinuationAvailable = false;
    return this.createContinuationRequest(this.lifecycle.state);
  }

  close(): void {
    this.closed = true;
    this.restoredContinuationAvailable = false;
    this.turnStartedAt.clear();
    this.pendingContinuations.clear();
  }

  private controlStatus(): GoalRuntimeControlResultV2 {
    const state = this.lifecycle?.state;
    if (state) {
      return deepFreeze({
        accepted: true,
        action: 'status' as const,
        message: `Goal is ${state.status}.`,
        state,
        scheduleContinuation: false,
      });
    }
    return deepFreeze({
      accepted: true,
      action: 'status' as const,
      message: this.tombstoneValue
        ? 'No Goal exists; the previous Goal was cleared.'
        : 'No Goal exists.',
      ...(this.tombstoneValue ? { tombstone: this.tombstoneValue } : {}),
      scheduleContinuation: false,
    });
  }

  private observeTurn(
    turn: AgentLoopTurnCommitV1,
    requestDecision: StopDecision | undefined
  ): GoalTurnObservationV2 {
    const now = this.clock();
    const startedAt = this.turnStartedAt.get(turn.turnId) ?? now;
    const usage = turn.queryComplete.usage;
    const subagentTokens = turn.queryComplete.stats?.subagentTotalTokens ?? 0;
    const tokenDelta = usage
      ? safeUsageTotal(usage.promptTokens, usage.completionTokens, subagentTokens)
      : 0;
    const failed = turn.queryComplete.stats?.finishReason === 'failed';
    const aborted = turn.queryComplete.stats?.finishReason === 'cancelled';
    const providerFailure = isProviderFailureDecision(requestDecision);
    // A provider stream cancelled by explicit user control commonly has no
    // terminal usage frame. That is an expected abort boundary, not corrupted
    // accounting. Every non-cancelled Goal turn still fails closed when usage
    // is absent, so autonomous work cannot continue on unknown cost.
    const accountingFailure =
      usage || aborted
        ? undefined
        : 'Goal usage accounting is unavailable; autonomous continuation is stopped fail-closed.';
    const runtimeFailure =
      failed && !providerFailure
        ? turn.queryComplete.content || 'Goal turn failed before a complete durable observation.'
        : undefined;
    const blocked =
      requestDecision?.status === 'blocked' ? requestDecision.reason.message : undefined;
    return {
      ...(requestDecision ? { requestDecision } : {}),
      ...(turn.taskContextCompletion ? { taskContextCompletion: turn.taskContextCompletion } : {}),
      madeProgress: madeProgress(turn),
      ...(blocked ? { blocked } : {}),
      tokenDelta,
      elapsedMs: Math.max(0, now - startedAt),
      ...(accountingFailure || runtimeFailure
        ? { persistenceFailure: accountingFailure ?? runtimeFailure }
        : {}),
      aborted,
    };
  }

  private createContinuationRequest(
    state: GoalLifecycleStateV2
  ): ThreadTurnRequestV1 & { readonly mode: 'goal'; readonly kind: 'goal' } {
    const input = this.continuationInput(state).trim();
    if (!input) throw new Error('Goal continuation input must not be empty.');
    return Object.freeze({ input, mode: 'goal' as const, kind: 'goal' as const });
  }
}

function createLifecycle(
  definition: GoalRuntimeDefinitionV2,
  clock: () => number
): GoalLifecycleServiceV2 {
  return new GoalLifecycleServiceV2({
    objective: definition.objective,
    budget: definition.budget,
    ...(definition.goalId ? { goalId: definition.goalId } : {}),
    ...(definition.state ? { state: definition.state } : {}),
    clock,
  });
}

function parseGoalPersistence(commit: TurnCommitV1 | undefined): {
  readonly state?: GoalLifecycleStateV2;
  readonly tombstone?: GoalRuntimeTombstoneV2;
} {
  if (!commit?.goalState) return {};
  let persisted: unknown;
  try {
    persisted = JSON.parse(commit.goalState) as unknown;
  } catch {
    throw new Error('Durable TurnCommit Goal state is not valid JSON.');
  }
  if (digestRuntimeValue(persisted) !== commit.goalStateDigest) {
    throw new Error('Durable TurnCommit Goal state digest does not match its receipt.');
  }
  if (isGoalTombstone(persisted)) {
    assertGoalTombstone(persisted);
    return { tombstone: persisted };
  }
  if (typeof persisted !== 'object' || persisted === null) {
    throw new Error('Durable TurnCommit Goal state has an invalid shape.');
  }
  const state = persisted as GoalLifecycleStateV2;
  assertGoalLifecycleStateV2(state);
  return { state };
}

function requestDecisionForGoal(turn: AgentLoopTurnCommitV1): StopDecision | undefined {
  const current = turn.queryComplete.stats?.stopDecision;
  const stats = turn.queryComplete.stats;
  const providerFailure =
    stats?.finishReason === 'failed' &&
    ((stats.providerRetryErrorTypes?.length ?? 0) > 0 || Boolean(stats.providerLastRetryErrorType));
  if (!providerFailure) return current;
  return createStopDecision({
    scope: 'request',
    status: 'failed',
    disposition: 'pause_scope',
    reason: {
      code: `provider_${stats?.providerLastRetryErrorType ?? 'failure'}`,
      message: turn.queryComplete.content || 'Provider failed during the Goal turn.',
    },
    evidence: [
      {
        kind: 'provider',
        source: turn.queryComplete.model,
        detail: (stats?.providerRetryErrorTypes ?? []).join(', ') || 'provider failure',
      },
    ],
    nextActions: [{ kind: 'resume', label: 'Resume after provider recovery.' }],
    resources: {
      llmRequests: { used: stats?.llmRequests ?? 0 },
      tokens: {
        used:
          (turn.queryComplete.usage?.promptTokens ?? 0) +
          (turn.queryComplete.usage?.completionTokens ?? 0),
      },
    },
  });
}

function madeProgress(turn: AgentLoopTurnCommitV1): boolean {
  const completionDelta = turn.taskContextCompletion?.progressDelta;
  if (completionDelta) return completionDelta.changed;
  const stateDelta = turn.taskContextState.progressState?.lastDelta;
  if (stateDelta) return stateDelta.changed;
  return turn.queryComplete.stats?.lastToolSuccess === true;
}

function isProviderFailureDecision(decision: StopDecision | undefined): boolean {
  return Boolean(
    decision &&
    (decision.evidence.some(evidence => evidence.kind === 'provider') ||
      /provider|network|auth|rate.?limit/iu.test(decision.reason.code))
  );
}

function safeUsageTotal(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || total > Number.MAX_SAFE_INTEGER - value) {
      throw new Error('Goal usage accounting must contain non-negative safe integers.');
    }
    total += value;
  }
  return total;
}

function assertDurableReceipt(
  turnId: string,
  state: GoalLifecycleStateV2,
  decision: StopDecision | undefined,
  receipt: GoalRuntimeDurableReceiptV2
): void {
  if (receipt.turnId !== turnId) throw new Error('Goal TurnCommit receipt has a different turnId.');
  assertPersistedStateReceipt(state, decision, receipt);
}

function assertControlReceipt(
  turnId: string,
  persisted: GoalRuntimePersistedStateV2 | undefined,
  decision: StopDecision,
  receipt: GoalRuntimeDurableReceiptV2
): void {
  if (receipt.turnId !== turnId || receipt.terminal !== 'completed') {
    throw new Error('Goal control did not produce its matching completed TurnCommit.');
  }
  if (persisted) assertPersistedStateReceipt(persisted, decision, receipt);
  else if (receipt.goalStateDigest !== undefined) {
    throw new Error('Rejected Goal control unexpectedly persisted Goal state.');
  } else if (receipt.stopDecisionDigest !== digestRuntimeValue(decision)) {
    throw new Error('Goal control did not durably bind its StopDecision.');
  }
}

function assertPersistedStateReceipt(
  persisted: GoalRuntimePersistedStateV2,
  decision: StopDecision | undefined,
  receipt: GoalRuntimeDurableReceiptV2
): void {
  if (receipt.goalStateDigest !== digestRuntimeValue(persisted)) {
    throw new Error('Goal TurnCommit receipt did not durably bind the finalized Goal state.');
  }
  const expectedDecisionDigest = decision ? digestRuntimeValue(decision) : undefined;
  if (receipt.stopDecisionDigest !== expectedDecisionDigest) {
    throw new Error('Goal TurnCommit receipt did not durably bind the selected StopDecision.');
  }
}

function createLifecycleFromState(
  state: GoalLifecycleStateV2,
  clock: () => number
): GoalLifecycleServiceV2 {
  return new GoalLifecycleServiceV2({
    objective: state.objective,
    budget: state.budget,
    state,
    clock,
  });
}

function defaultGoalBudget(): GoalLifecycleBudgetV2 {
  return {
    maxTokens: Number.MAX_SAFE_INTEGER,
    maxElapsedMs: Number.MAX_SAFE_INTEGER,
  };
}

function createGoalTombstone(
  state: GoalLifecycleStateV2,
  clearedAt: number
): GoalRuntimeTombstoneV2 {
  const content = {
    version: 2 as const,
    kind: 'goal_tombstone' as const,
    goalId: state.goalId,
    generation: state.generation + 1,
    clearedAt,
    reason: 'user_clear' as const,
  };
  return deepFreeze({ ...content, digest: digestRuntimeValue(content) });
}

function isGoalTombstone(persisted: unknown): persisted is GoalRuntimeTombstoneV2 {
  return (
    typeof persisted === 'object' &&
    persisted !== null &&
    'kind' in persisted &&
    persisted.kind === 'goal_tombstone'
  );
}

function assertGoalTombstone(tombstone: GoalRuntimeTombstoneV2): void {
  const { digest, ...content } = tombstone;
  if (
    tombstone.version !== 2 ||
    tombstone.kind !== 'goal_tombstone' ||
    !Number.isSafeInteger(tombstone.generation) ||
    tombstone.generation <= 0 ||
    !Number.isSafeInteger(tombstone.clearedAt) ||
    tombstone.clearedAt < 0 ||
    digestRuntimeValue(content) !== digest
  ) {
    throw new Error('GoalRuntimeTombstoneV2 failed integrity validation.');
  }
}

function controlDecision(
  action: Exclude<GoalRuntimeControlV2['action'], 'status'>,
  accepted: boolean,
  message: string
): StopDecision {
  const status: StopDecision['status'] = !accepted
    ? 'failed'
    : action === 'pause'
      ? 'stopped'
      : action === 'clear'
        ? 'cancelled'
        : 'completed';
  return createStopDecision({
    scope: action === 'pause' || action === 'clear' ? 'goal' : 'request',
    status,
    disposition: action === 'pause' ? 'pause_scope' : 'finish_scope',
    reason: { code: accepted ? `goal_${action}` : `goal_${action}_rejected`, message },
    evidence: [{ kind: 'runtime', source: 'goal-runtime-v2', detail: message }],
    nextActions:
      action === 'pause' && accepted
        ? [{ kind: 'resume', label: 'Resume the Goal with /goal resume.' }]
        : [],
    resources: {},
  });
}

function defaultContinuationInput(state: GoalLifecycleStateV2): string {
  const objective = state.objective.slice(0, 8_192);
  return [
    'Continue the active Goal autonomously from the latest durable TaskContext and receipts.',
    `Goal objective: ${objective}`,
    'Do not claim completion unless the TaskContext completion gate verifies every criterion.',
  ].join('\n');
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}
