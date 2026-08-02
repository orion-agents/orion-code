import { GoalCoordinator } from '../src/runtime/goals/coordinator';
import type { AgentTurnOutcome } from '../src/runtime/goals/types';

function completedTurn(coord: GoalCoordinator, index: number): AgentTurnOutcome {
  const goal = coord.goal!;
  return {
    turnId: `turn-${index}`,
    sessionId: goal.sessionId,
    goalId: goal.goalId,
    goalRevision: goal.revision,
    startedAt: index * 100,
    endedAt: index * 100 + 25,
    finishReason: 'completed',
    usage: { promptTokens: 10, completionTokens: 5, subagentTokens: 0, totalTokens: 15 },
    usageComplete: true,
    madeProgress: true,
    pendingPlanUpdate:
      index === 1
        ? {
            phase: 'implementation',
            steps: [{ description: 'Preserve contract through long execution', done: false }],
            nextAction: 'Continue the long-running fixture',
            derivedCriteria: [
              {
                statement: 'Long-running Goal preserves its contract',
                requiredEvidenceKinds: ['test'],
              },
            ],
          }
        : undefined,
  };
}

describe('Goal 20+ turn continuity', () => {
  it('preserves objective, contract, accounting, and next continuation across reloads', () => {
    const project = `/tmp/goal-long-${Date.now()}-${Math.random()}`;
    let coord = new GoalCoordinator(project, 'long-session');
    coord.create('Complete a long-running verified task');
    coord.setBudget(10000);
    const goalId = coord.goal!.goalId;
    const originalObjective = coord.goal!.contract!.originalObjective;
    let criterionIds: string[] = [];

    for (let index = 1; index <= 21; index++) {
      coord.finalizeTurn(completedTurn(coord, index));
      if (index === 1) {
        criterionIds = coord.goal!.contract!.successCriteria.map(criterion => criterion.id);
      }
      if (index === 7 || index === 14) {
        const reloaded = new GoalCoordinator(project, 'long-session');
        expect(reloaded.load()).toBe(true);
        coord = reloaded;
      }
      expect(coord.buildContinuationRequest()).toMatchObject({
        inputKind: 'goal_continuation',
        sessionId: 'long-session',
        persistAsUserMessage: false,
        echoToTranscript: false,
      });
      expect(coord.goal?.contract?.successCriteria.map(criterion => criterion.id)).toEqual(
        criterionIds
      );
      expect(coord.goal?.contract?.planSnapshot).toMatchObject({
        revision: 1,
        phase: 'implementation',
        nextAction: 'Continue the long-running fixture',
      });
    }

    expect(coord.goal?.goalId).toBe(goalId);
    expect(coord.goal?.contract?.originalObjective).toBe(originalObjective);
    expect(coord.goal?.continuationCount).toBe(21);
    expect(coord.goal?.tokensUsed).toBe(315);

    const restarted = new GoalCoordinator(project, 'long-session');
    expect(restarted.load(true)).toBe(true);
    expect(restarted.goal?.status).toBe('paused');
    expect(restarted.goal?.contract?.successCriteria.map(criterion => criterion.id)).toEqual(
      criterionIds
    );
    expect(restarted.goal?.contract?.planSnapshot?.nextAction).toBe(
      'Continue the long-running fixture'
    );
    expect(restarted.buildContinuationRequest()).toBeNull();
    expect(restarted.resume()).toBe(true);
    expect(restarted.buildContinuationRequest()?.goal?.continuationIndex).toBe(22);
  });

  it('preserves steering, failed verification, restart recovery, and fresh re-verification', () => {
    const project = `/tmp/goal-long-mixed-${Date.now()}-${Math.random()}`;
    let coord = new GoalCoordinator(project, 'long-mixed-session');
    coord.create('Finish a mixed long-running verification flow');
    coord.finalizeTurn(completedTurn(coord, 1));
    coord.addConstraint('Never publish during this fixture');
    const goalId = coord.goal!.goalId;
    const criterionIds = coord.goal!.contract!.successCriteria.map(item => item.id);

    const verificationTurn = (
      index: number,
      fingerprint: string,
      results: Array<'passed' | 'failed'>
    ): AgentTurnOutcome => {
      const goal = coord.goal!;
      const evidenceRecords = criterionIds.map((criterionId, evidenceIndex) => ({
        id: `evidence:mixed:${index}:${evidenceIndex}`,
        goalId: goal.goalId,
        goalRevision: goal.revision,
        objectiveRevision: goal.contract!.objectiveRevision,
        turnId: `turn-${index}`,
        kind: 'test' as const,
        subject: `verification result for ${criterionId}`,
        result: results[evidenceIndex],
        sourceRef: `tool:mixed-${index}-${evidenceIndex}:exec_command`,
        capturedAt: index * 1_000,
        workspaceFingerprint: fingerprint,
        redacted: true,
      }));
      return {
        ...completedTurn(coord, index),
        evidenceRecords,
        workspaceFingerprint: fingerprint,
        pendingTerminalRequest: {
          requestedStatus: 'complete',
          requestedAt: index * 1_000,
          goalId: goal.goalId,
          goalRevision: goal.revision,
          turnId: `turn-${index}`,
          criterionEvidence: criterionIds.map((criterionId, evidenceIndex) => ({
            criterionId,
            evidenceIds: [evidenceRecords[evidenceIndex].id],
          })),
        },
      };
    };

    for (let index = 2; index <= 21; index += 1) {
      if (index === 8) {
        coord.finalizeTurn(verificationTurn(index, 'workspace:v1', ['passed', 'failed']));
        expect(coord.goal?.status).toBe('active');
        expect(coord.goal?.contract?.successCriteria.map(item => item.status)).toEqual([
          'passed',
          'failed',
        ]);
      } else if (index === 21) {
        coord.finalizeTurn(verificationTurn(index, 'workspace:v2', ['passed', 'passed']));
      } else {
        coord.finalizeTurn({
          ...completedTurn(coord, index),
          // One denied/no-op turn must not erase the goal or trigger terminal state.
          madeProgress: index !== 9,
        });
      }

      if (index === 7) {
        const reloaded = new GoalCoordinator(project, 'long-mixed-session');
        expect(reloaded.load()).toBe(true);
        coord = reloaded;
      }
      if (index === 14) {
        const restarted = new GoalCoordinator(project, 'long-mixed-session');
        expect(restarted.load(true)).toBe(true);
        expect(restarted.goal?.status).toBe('paused');
        expect(restarted.buildContinuationRequest()).toBeNull();
        expect(restarted.resume()).toBe(true);
        coord = restarted;
      }
    }

    expect(coord.goal).toMatchObject({
      goalId,
      status: 'complete',
      continuationCount: 21,
    });
    expect(coord.goal?.contract?.constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ statement: 'Never publish during this fixture', source: 'user' }),
      ])
    );
    expect(coord.goal?.contract?.successCriteria.map(item => item.status)).toEqual([
      'passed',
      'passed',
    ]);
    expect(coord.goal?.completionAudit?.passed).toBe(true);
  });
});
