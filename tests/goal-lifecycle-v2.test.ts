import {
  GoalLifecycleServiceV2,
  type GoalTurnObservationV2,
} from '../src/runtime/goal-lifecycle-v2';
import type { TaskContextCompletionDecisionV1 } from '../src/runtime/task-context-service';

describe('GoalLifecycleServiceV2', () => {
  const baseObservation: GoalTurnObservationV2 = {
    madeProgress: true,
    tokenDelta: 100,
    elapsedMs: 1_000,
  };

  function createGoal() {
    return new GoalLifecycleServiceV2({
      objective: 'Complete the verified long-running task',
      budget: { maxTokens: 1_000_000, maxElapsedMs: 3_600_000 },
      clock: () => 100,
    });
  }

  test('continues for 20+ productive turns and auto-exits only after TaskContext verifies', () => {
    const goal = createGoal();
    for (let index = 0; index < 21; index++) {
      const resolution = goal.finalizeTurn(baseObservation);
      expect(resolution.state.status).toBe('active');
      expect(resolution.scheduleContinuation).toBe(true);
    }

    const completion: TaskContextCompletionDecisionV1 = {
      version: 1,
      revision: 22,
      auditedAt: 22,
      canComplete: true,
      missing: [],
      evidence: ['evidence:test:passed'],
      criterionResults: [
        {
          criterionId: 'criterion-1',
          statement: 'Tests pass',
          status: 'passed',
          applicable: true,
          evidenceRefs: ['evidence:test:passed'],
          requiredKinds: ['test'],
          missingKinds: [],
          failedKinds: [],
        },
      ],
    };
    const resolution = goal.finalizeTurn({
      ...baseObservation,
      taskContextCompletion: completion,
    });

    expect(resolution.scheduleContinuation).toBe(false);
    expect(resolution.state).toMatchObject({
      status: 'completed',
      continuationCount: 22,
      lastStopDecision: {
        scope: 'goal',
        status: 'completed',
        reason: { code: 'verified_completion' },
      },
    });
  });

  test('pauses on bounded no-progress and blocked policies without a fixed turn cap', () => {
    const noProgress = createGoal();
    for (let index = 0; index < 2; index++) {
      expect(
        noProgress.finalizeTurn({ ...baseObservation, madeProgress: false }).state.status
      ).toBe('active');
    }
    expect(
      noProgress.finalizeTurn({ ...baseObservation, madeProgress: false }).state.lastStopDecision
    ).toMatchObject({ reason: { code: 'no_progress' } });

    const blocked = createGoal();
    expect(
      blocked.finalizeTurn({ ...baseObservation, madeProgress: false, blocked: 'missing auth' })
        .state.status
    ).toBe('active');
    expect(
      blocked.finalizeTurn({ ...baseObservation, madeProgress: false, blocked: 'missing auth' })
        .state.lastStopDecision
    ).toMatchObject({ status: 'blocked', reason: { code: 'blocked' } });
  });

  test('gives persistence, abort and explicit Goal budgets precedence over completion', () => {
    const completion = {
      version: 1,
      revision: 1,
      auditedAt: 1,
      canComplete: true,
      missing: [],
      evidence: [],
    } as TaskContextCompletionDecisionV1;
    const persistence = createGoal().finalizeTurn({
      ...baseObservation,
      taskContextCompletion: completion,
      persistenceFailure: 'fsync failed',
    });
    expect(persistence.state).toMatchObject({
      status: 'failed',
      lastStopDecision: { reason: { code: 'persistence_error' } },
    });

    const aborted = createGoal().finalizeTurn({
      ...baseObservation,
      taskContextCompletion: completion,
      aborted: true,
    });
    expect(aborted.state).toMatchObject({
      status: 'paused',
      lastStopDecision: { reason: { code: 'user_abort' } },
    });

    const budget = new GoalLifecycleServiceV2({
      objective: 'bounded goal',
      budget: { maxTokens: 100, maxElapsedMs: 10_000 },
    }).finalizeTurn({
      ...baseObservation,
      tokenDelta: 100,
      taskContextCompletion: completion,
    });
    expect(budget.state).toMatchObject({
      status: 'paused',
      lastStopDecision: { reason: { code: 'goal_budget' } },
    });
  });

  test('restores only digest-valid lifecycle state', () => {
    const original = createGoal();
    original.finalizeTurn(baseObservation);
    const restored = new GoalLifecycleServiceV2({
      objective: original.state.objective,
      budget: original.state.budget,
      state: original.state,
    });
    expect(restored.state).toEqual(original.state);

    expect(
      () =>
        new GoalLifecycleServiceV2({
          objective: original.state.objective,
          budget: original.state.budget,
          state: { ...original.state, continuationCount: 999 },
        })
    ).toThrow(/integrity/);
  });
});
