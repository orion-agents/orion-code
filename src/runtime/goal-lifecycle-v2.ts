import { randomUUID } from 'crypto';

import { createStopDecision, type StopDecision } from '../framework/stop-decision';
import type { TaskContextCompletionDecisionV1 } from './task-context-service';
import { digestRuntimeValue } from './protocol/canonical';
import { isRuntimeId } from './protocol/runtime-protocol-v1';

export type GoalLifecycleStatusV2 = 'active' | 'paused' | 'completed' | 'failed';

export interface GoalLifecycleBudgetV2 {
  readonly maxTokens: number;
  readonly maxElapsedMs: number;
}

export interface GoalLifecycleStateV2 {
  readonly version: 2;
  readonly goalId: string;
  readonly objective: string;
  readonly status: GoalLifecycleStatusV2;
  readonly generation: number;
  readonly continuationCount: number;
  readonly noProgressCount: number;
  readonly blockedCount: number;
  readonly tokensUsed: number;
  readonly elapsedMs: number;
  readonly budget: GoalLifecycleBudgetV2;
  readonly lastStopDecision?: StopDecision;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly digest: string;
}

export interface GoalTurnObservationV2 {
  readonly requestDecision?: StopDecision;
  readonly taskContextCompletion?: TaskContextCompletionDecisionV1;
  readonly madeProgress: boolean;
  readonly blocked?: string;
  readonly tokenDelta: number;
  readonly elapsedMs: number;
  readonly persistenceFailure?: string;
  readonly aborted?: boolean;
}

export interface GoalTurnResolutionV2 {
  readonly state: GoalLifecycleStateV2;
  readonly scheduleContinuation: boolean;
  readonly decision?: StopDecision;
}

export interface GoalLifecycleOptionsV2 {
  readonly goalId?: string;
  readonly objective: string;
  readonly budget: GoalLifecycleBudgetV2;
  readonly clock?: () => number;
  readonly state?: GoalLifecycleStateV2;
}

const MAX_NO_PROGRESS_TURNS = 3;
const MAX_BLOCKED_CONTINUATIONS = 2;

/**
 * Long-lived Goal owner for lifecycle, budget and continuation only.
 * Task criteria, evidence and completion remain exclusively in TaskContext.
 */
export class GoalLifecycleServiceV2 {
  readonly serviceId = 'goal-lifecycle' as const;
  private stateValue: GoalLifecycleStateV2;
  private readonly clock: () => number;

  constructor(options: GoalLifecycleOptionsV2) {
    this.clock = options.clock ?? Date.now;
    if (options.state) {
      assertGoalLifecycleStateV2(options.state);
      this.stateValue = deepFreeze(structuredClone(options.state));
      return;
    }
    const objective = options.objective.trim();
    validateBudget(options.budget);
    if (!objective) throw new Error('Goal objective must not be empty');
    const now = this.clock();
    this.stateValue = withDigest({
      version: 2 as const,
      goalId: options.goalId ?? randomUUID(),
      objective,
      status: 'active' as const,
      generation: 1,
      continuationCount: 0,
      noProgressCount: 0,
      blockedCount: 0,
      tokensUsed: 0,
      elapsedMs: 0,
      budget: structuredClone(options.budget),
      createdAt: now,
      updatedAt: now,
    });
    assertGoalLifecycleStateV2(this.stateValue);
  }

  get state(): GoalLifecycleStateV2 {
    return deepFreeze(structuredClone(this.stateValue));
  }

  finalizeTurn(observation: GoalTurnObservationV2): GoalTurnResolutionV2 {
    if (this.stateValue.status !== 'active') {
      return {
        state: this.state,
        scheduleContinuation: false,
        decision: this.stateValue.lastStopDecision,
      };
    }
    validateObservation(observation);
    const tokensUsed = this.stateValue.tokensUsed + observation.tokenDelta;
    const elapsedMs = this.stateValue.elapsedMs + observation.elapsedMs;
    const continuationCount = this.stateValue.continuationCount + 1;
    const noProgressCount = observation.madeProgress ? 0 : this.stateValue.noProgressCount + 1;
    const blockedCount = observation.blocked ? this.stateValue.blockedCount + 1 : 0;
    const resourceSnapshot = {
      turns: { used: continuationCount },
      tokens: { used: tokensUsed, limit: this.stateValue.budget.maxTokens },
      elapsedMs: { used: elapsedMs, limit: this.stateValue.budget.maxElapsedMs },
    };

    let status: GoalLifecycleStatusV2 = 'active';
    let decision: StopDecision | undefined;
    if (observation.persistenceFailure) {
      status = 'failed';
      decision = goalDecision(
        'failed',
        'pause_scope',
        'persistence_error',
        observation.persistenceFailure,
        resourceSnapshot
      );
    } else if (observation.aborted || observation.requestDecision?.status === 'cancelled') {
      status = 'paused';
      decision = goalDecision(
        'cancelled',
        'pause_scope',
        'user_abort',
        'Goal paused after an interrupt.',
        resourceSnapshot
      );
    } else if (
      observation.requestDecision?.status === 'failed' &&
      isProviderFailure(observation.requestDecision)
    ) {
      status = 'paused';
      decision = goalDecision(
        'failed',
        'pause_scope',
        'provider_failure',
        observation.requestDecision.reason.message,
        resourceSnapshot
      );
    } else if (
      tokensUsed >= this.stateValue.budget.maxTokens ||
      elapsedMs >= this.stateValue.budget.maxElapsedMs
    ) {
      status = 'paused';
      decision = goalDecision(
        'stopped',
        'pause_scope',
        'goal_budget',
        'Goal budget reached. Raise the explicit budget before resuming.',
        resourceSnapshot
      );
    } else if (observation.taskContextCompletion?.canComplete === true) {
      status = 'completed';
      decision = createStopDecision({
        scope: 'goal',
        status: 'completed',
        disposition: 'finish_scope',
        reason: { code: 'verified_completion', message: 'TaskContext verified every criterion.' },
        evidence: observation.taskContextCompletion.evidence.map(ref => ({
          kind: 'verification' as const,
          source: 'task-context',
          detail: ref,
        })),
        evidenceRefs: [...observation.taskContextCompletion.evidence],
        criterionStates: observation.taskContextCompletion.criterionResults?.map(result => ({
          id: result.criterionId,
          status: result.status,
        })),
        nextActions: [{ kind: 'inspect', label: 'Inspect the durable completion receipt.' }],
        resources: resourceSnapshot,
      });
    } else if (blockedCount >= MAX_BLOCKED_CONTINUATIONS) {
      status = 'paused';
      decision = goalDecision(
        'blocked',
        'pause_scope',
        'blocked',
        observation.blocked ?? 'Goal remained blocked.',
        resourceSnapshot
      );
    } else if (noProgressCount >= MAX_NO_PROGRESS_TURNS) {
      status = 'paused';
      decision = goalDecision(
        'stopped',
        'pause_scope',
        'no_progress',
        `Goal made no observable progress for ${MAX_NO_PROGRESS_TURNS} turns.`,
        resourceSnapshot
      );
    }

    this.stateValue = withDigest({
      version: 2 as const,
      goalId: this.stateValue.goalId,
      objective: this.stateValue.objective,
      status,
      generation: this.stateValue.generation,
      continuationCount,
      noProgressCount,
      blockedCount,
      tokensUsed,
      elapsedMs,
      budget: structuredClone(this.stateValue.budget),
      ...(decision ? { lastStopDecision: decision } : {}),
      createdAt: this.stateValue.createdAt,
      updatedAt: Math.max(this.stateValue.updatedAt + 1, this.clock()),
    });
    return {
      state: this.state,
      scheduleContinuation: status === 'active',
      ...(decision ? { decision } : {}),
    };
  }

  pause(message = 'Goal paused by user.'): GoalLifecycleStateV2 {
    if (this.stateValue.status !== 'active') return this.state;
    return this.transition('paused', 'user_pause', message);
  }

  resume(): GoalLifecycleStateV2 {
    if (this.stateValue.status !== 'paused') return this.state;
    const content = {
      ...withoutDigest(this.stateValue),
      status: 'active' as const,
      generation: this.stateValue.generation + 1,
      noProgressCount: 0,
      blockedCount: 0,
      updatedAt: Math.max(this.stateValue.updatedAt + 1, this.clock()),
    };
    delete (content as { lastStopDecision?: StopDecision }).lastStopDecision;
    this.stateValue = withDigest(content);
    return this.state;
  }

  private transition(
    status: GoalLifecycleStatusV2,
    code: string,
    message: string
  ): GoalLifecycleStateV2 {
    const decision = goalDecision(
      status === 'failed' ? 'failed' : 'stopped',
      'pause_scope',
      code,
      message,
      {
        turns: { used: this.stateValue.continuationCount },
        tokens: { used: this.stateValue.tokensUsed, limit: this.stateValue.budget.maxTokens },
        elapsedMs: { used: this.stateValue.elapsedMs, limit: this.stateValue.budget.maxElapsedMs },
      }
    );
    this.stateValue = withDigest({
      ...withoutDigest(this.stateValue),
      status,
      lastStopDecision: decision,
      updatedAt: Math.max(this.stateValue.updatedAt + 1, this.clock()),
    });
    return this.state;
  }
}

export function assertGoalLifecycleStateV2(state: GoalLifecycleStateV2): void {
  const { digest, ...content } = state;
  if (
    state.version !== 2 ||
    !isRuntimeId(state.goalId) ||
    !state.objective.trim() ||
    digestRuntimeValue(content) !== digest
  ) {
    throw new Error('GoalLifecycleStateV2 failed integrity validation');
  }
  validateBudget(state.budget);
  for (const value of [
    state.generation,
    state.continuationCount,
    state.noProgressCount,
    state.blockedCount,
    state.tokensUsed,
    state.elapsedMs,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Goal lifecycle counters must be non-negative safe integers');
    }
  }
}

function goalDecision(
  status: StopDecision['status'],
  disposition: StopDecision['disposition'],
  code: string,
  message: string,
  resources: StopDecision['resources']
): StopDecision {
  return createStopDecision({
    scope: 'goal',
    status,
    disposition,
    reason: { code, message },
    evidence: [{ kind: 'runtime', source: 'goal-lifecycle-v2', detail: message }],
    nextActions: [
      { kind: 'inspect', label: 'Inspect the durable Goal state.' },
      {
        kind: 'resume',
        label: 'Resume after resolving the stop condition.',
        command: '/goal resume',
      },
    ],
    resources,
  });
}

function isProviderFailure(decision: StopDecision): boolean {
  return (
    decision.evidence.some(item => item.kind === 'provider') ||
    /provider|network|auth|rate.?limit/iu.test(decision.reason.code)
  );
}

function validateBudget(budget: GoalLifecycleBudgetV2): void {
  if (
    !Number.isSafeInteger(budget.maxTokens) ||
    budget.maxTokens <= 0 ||
    !Number.isSafeInteger(budget.maxElapsedMs) ||
    budget.maxElapsedMs <= 0
  ) {
    throw new Error('Goal budget values must be positive safe integers');
  }
}

function validateObservation(observation: GoalTurnObservationV2): void {
  for (const [name, value] of [
    ['tokenDelta', observation.tokenDelta],
    ['elapsedMs', observation.elapsedMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative safe integer`);
    }
  }
}

function withDigest<T extends Record<string, unknown>>(
  content: T
): T & { readonly digest: string } {
  return deepFreeze({ ...content, digest: digestRuntimeValue(content) });
}

function withoutDigest(state: GoalLifecycleStateV2): Omit<GoalLifecycleStateV2, 'digest'> {
  const { digest: _digest, ...content } = state;
  void _digest;
  return structuredClone(content);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}
