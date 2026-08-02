import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { GoalCoordinator } from '../src/runtime/goals/coordinator';
import type { AgentTurnOutcome, GoalEvidenceRecord } from '../src/runtime/goals/types';
import { formatGoalRuntimeEvent } from '../src/runtime/goals/presentation';
import { loadGoal, saveGoal } from '../src/services/goal-storage';
import { getProjectSessionsDir } from '../src/services/config-dir';

function writeRawGoal(project: string, sessionId: string, goal: unknown): void {
  const dir = getProjectSessionsDir(project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.goal.json`), JSON.stringify(goal, null, 2));
}

function outcome(
  coord: GoalCoordinator,
  turnId: string,
  overrides: Partial<AgentTurnOutcome> = {}
): AgentTurnOutcome {
  const goal = coord.goal!;
  return {
    turnId,
    sessionId: goal.sessionId,
    goalId: goal.goalId,
    goalRevision: goal.revision,
    startedAt: 10,
    endedAt: 20,
    finishReason: 'completed',
    usage: { promptTokens: 10, completionTokens: 5, subagentTokens: 0, totalTokens: 15 },
    usageComplete: true,
    madeProgress: true,
    workspaceFingerprint: 'workspace-current',
    ...overrides,
  };
}

function evidence(
  coord: GoalCoordinator,
  turnId: string,
  result: GoalEvidenceRecord['result']
): GoalEvidenceRecord {
  const goal = coord.goal!;
  return {
    id: `evidence-${turnId}`,
    goalId: goal.goalId,
    goalRevision: goal.revision,
    objectiveRevision: goal.contract?.objectiveRevision ?? 0,
    turnId,
    kind: 'test',
    subject: `${goal.objective} regression test`,
    result,
    sourceRef: `tool:${turnId}:exec_command`,
    capturedAt: Date.now(),
    workspaceFingerprint: 'workspace-current',
    redacted: true,
  };
}

describe('Goal evidence and terminal audit', () => {
  it('completes only through a turn-bound request with passing evidence', () => {
    const coord = new GoalCoordinator('/tmp/goal-evidence-pass', 'session-pass');
    coord.create('Ship verified feature');
    const record = evidence(coord, 'turn-1', 'passed');
    const terminal = {
      requestedStatus: 'complete' as const,
      requestedAt: Date.now(),
      goalId: coord.goal!.goalId,
      goalRevision: coord.goal!.revision,
      turnId: 'turn-1',
      criterionEvidence: [
        {
          criterionId: coord.goal!.contract!.successCriteria[0].id,
          evidenceIds: [record.id],
        },
      ],
    };

    coord.finalizeTurn(
      outcome(coord, 'turn-1', {
        pendingTerminalRequest: terminal,
        evidenceRecords: [record],
        verificationSummary: 'test passed',
      })
    );

    expect(coord.goal?.status).toBe('complete');
    expect(coord.goal?.completionAudit?.passed).toBe(true);
    expect(coord.goal?.evidenceLedger?.map(item => item.id)).toContain(record.id);
    expect(coord.goal?.contract?.successCriteria[0].status).toBe('passed');
    expect(coord.goal?.completionAudit?.finalSummary).toEqual({
      originalObjective: 'Ship verified feature',
      currentObjective: 'Ship verified feature',
      objectiveRevision: 0,
      completedAt: expect.any(Number),
      verificationSummary: 'test passed',
      criterionResults: [
        {
          criterionId: 'criterion:primary',
          status: 'passed',
          evidenceRefs: [record.id],
          evidence: [
            {
              evidenceId: record.id,
              kind: 'test',
              provenance: 'runtime_automatic',
              result: 'passed',
              subject: 'Ship verified feature regression test',
            },
          ],
        },
      ],
      evidenceRefs: [record.id],
      accounting: {
        tokensUsed: 15,
        timeUsedMs: 10,
        continuationCount: 1,
        usageComplete: true,
      },
      remainingRequirements: [],
      stopReason: 'completed',
    });
    expect(coord.goal?.contract?.planSnapshot).toMatchObject({
      phase: 'complete',
      nextAction: undefined,
    });

    const reloaded = new GoalCoordinator('/tmp/goal-evidence-pass', 'session-pass');
    expect(reloaded.load()).toBe(true);
    expect(reloaded.goal?.status).toBe('complete');
  });

  it.each([
    {
      label: 'empty evidence ledger and references',
      mutate: (goal: NonNullable<GoalCoordinator['goal']>) => {
        goal.evidenceLedger = [];
        goal.contract!.successCriteria[0].evidenceRefs = [];
        goal.completionAudit!.evidenceRefs = [];
        goal.completionAudit!.criterionResults![0].evidenceRefs = [];
        goal.completionAudit!.finalSummary!.evidenceRefs = [];
        goal.completionAudit!.finalSummary!.criterionResults[0].evidenceRefs = [];
        goal.completionAudit!.finalSummary!.criterionResults[0].evidence = [];
      },
    },
    {
      label: 'evidence references missing from the ledger',
      mutate: (goal: NonNullable<GoalCoordinator['goal']>) => {
        goal.evidenceLedger = [];
      },
    },
    {
      label: 'audit and final-summary reference mismatch',
      mutate: (goal: NonNullable<GoalCoordinator['goal']>) => {
        goal.completionAudit!.finalSummary!.criterionResults[0].evidenceRefs = [];
      },
    },
    {
      label: 'semantically unrelated evidence behind a forged passed audit',
      mutate: (goal: NonNullable<GoalCoordinator['goal']>) => {
        goal.evidenceLedger![0].subject = 'unrelated billing smoke test';
        goal.completionAudit!.finalSummary!.criterionResults[0].evidence![0].subject =
          'unrelated billing smoke test';
      },
    },
    {
      label: 'final-summary token accounting drift',
      mutate: (goal: NonNullable<GoalCoordinator['goal']>) => {
        goal.completionAudit!.finalSummary!.accounting.tokensUsed += 1;
      },
    },
    {
      label: 'final-summary elapsed-time accounting drift',
      mutate: (goal: NonNullable<GoalCoordinator['goal']>) => {
        goal.completionAudit!.finalSummary!.accounting.timeUsedMs += 1;
      },
    },
    {
      label: 'final-summary continuation accounting drift',
      mutate: (goal: NonNullable<GoalCoordinator['goal']>) => {
        goal.completionAudit!.finalSummary!.accounting.continuationCount += 1;
      },
    },
    {
      label: 'final-summary verification drift',
      mutate: (goal: NonNullable<GoalCoordinator['goal']>) => {
        goal.completionAudit!.finalSummary!.verificationSummary = 'forged verification summary';
      },
    },
    {
      label: 'duplicate final-summary evidence receipts',
      mutate: (goal: NonNullable<GoalCoordinator['goal']>) => {
        const receipts = goal.completionAudit!.finalSummary!.criterionResults[0].evidence!;
        receipts.push(structuredClone(receipts[0]));
      },
    },
    {
      label: 'duplicate identical evidence ledger ids',
      mutate: (goal: NonNullable<GoalCoordinator['goal']>) => {
        goal.evidenceLedger!.push(structuredClone(goal.evidenceLedger![0]));
      },
    },
    {
      label: 'duplicate conflicting evidence ledger ids',
      mutate: (goal: NonNullable<GoalCoordinator['goal']>) => {
        goal.evidenceLedger!.push({
          ...structuredClone(goal.evidenceLedger![0]),
          result: 'failed',
          subject: 'Conflicting duplicate evidence receipt',
        });
      },
    },
    {
      label: 'a stale blocker on the completed state',
      mutate: (goal: NonNullable<GoalCoordinator['goal']>) => {
        goal.blocker = {
          category: 'external_state',
          fingerprint: 'registry:stale',
          firstSeenAt: 1_000,
          lastSeenAt: 2_000,
          consecutiveTurns: 3,
          summary: 'Stale registry blocker',
          retryable: false,
        };
      },
    },
    {
      label: 'a stale activeSince on the completed state',
      mutate: (goal: NonNullable<GoalCoordinator['goal']>) => {
        goal.activeSince = 1_000;
      },
    },
    {
      label: 'a contradictory top-level stopReason on the completed state',
      mutate: (goal: NonNullable<GoalCoordinator['goal']>) => {
        goal.stopReason = { kind: 'user', message: 'Still paused', at: 2_000 };
      },
    },
  ])('rejects a persisted complete goal with $label', ({ label, mutate }) => {
    const project = `/tmp/goal-evidence-forged-${label.replace(/\W+/gu, '-')}`;
    const sessionId = 'session-forged';
    const coord = new GoalCoordinator(project, sessionId);
    coord.create('Ship verified feature');
    const record = evidence(coord, 'turn-forged', 'passed');
    coord.finalizeTurn(
      outcome(coord, 'turn-forged', {
        evidenceRecords: [record],
        verificationSummary: 'test passed',
        pendingTerminalRequest: {
          requestedStatus: 'complete',
          requestedAt: Date.now(),
          goalId: coord.goal!.goalId,
          goalRevision: coord.goal!.revision,
          turnId: 'turn-forged',
          criterionEvidence: [
            {
              criterionId: coord.goal!.contract!.successCriteria[0].id,
              evidenceIds: [record.id],
            },
          ],
        },
      })
    );
    expect(coord.goal?.status).toBe('complete');

    const forged = structuredClone(coord.goal!);
    mutate(forged);
    expect(saveGoal(project, sessionId, forged, coord.goal!.revision)).toEqual(
      expect.objectContaining({ ok: false, error: 'io_error' })
    );
    expect(loadGoal(project, sessionId)).toEqual(
      expect.objectContaining({ ok: true, value: expect.objectContaining({ status: 'complete' }) })
    );

    writeRawGoal(project, sessionId, forged);
    const loaded = loadGoal(project, sessionId);
    expect(loaded).toEqual(expect.objectContaining({ ok: false, error: 'corrupt' }));
    const restarted = new GoalCoordinator(project, sessionId);
    expect(restarted.load()).toBe(false);
    expect(restarted.goal).toBeNull();
  });

  it('clears stale active-only fields when completion succeeds', () => {
    const coord = new GoalCoordinator('/tmp/goal-evidence-complete-cleanup', 'session-cleanup');
    coord.create('Complete without stale runtime state');
    const record = evidence(coord, 'turn-cleanup', 'passed');
    coord.goal!.activeSince = 1_000;
    coord.goal!.blocker = {
      category: 'external_state',
      fingerprint: 'registry:stale',
      firstSeenAt: 1_000,
      lastSeenAt: 2_000,
      consecutiveTurns: 2,
      summary: 'Stale runtime blocker',
      retryable: false,
    };
    coord.goal!.stopReason = { kind: 'runtime_error', message: 'Stale pause', at: 2_000 };

    coord.finalizeTurn(
      outcome(coord, 'turn-cleanup', {
        evidenceRecords: [record],
        verificationSummary: 'cleanup test passed',
        pendingTerminalRequest: {
          requestedStatus: 'complete',
          requestedAt: Date.now(),
          goalId: coord.goal!.goalId,
          goalRevision: coord.goal!.revision,
          turnId: 'turn-cleanup',
          criterionEvidence: [
            {
              criterionId: coord.goal!.contract!.successCriteria[0].id,
              evidenceIds: [record.id],
            },
          ],
        },
      })
    );

    expect(coord.goal).toMatchObject({ status: 'complete' });
    expect(coord.goal?.activeSince).toBeUndefined();
    expect(coord.goal?.blocker).toBeUndefined();
    expect(coord.goal?.stopReason).toBeUndefined();
    expect(loadGoal('/tmp/goal-evidence-complete-cleanup', 'session-cleanup').ok).toBe(true);
  });

  it('persists and presents runtime, external, and user evidence provenance per criterion', () => {
    const coord = new GoalCoordinator('/tmp/goal-evidence-provenance', 'session-provenance');
    expect(
      coord.create('Release provenance receipt', {
        successCriteria: [
          {
            statement: 'Registry reports the released package',
            requiredEvidenceKinds: ['external'],
          },
          {
            statement: 'Release owner accepts the result',
            requiredEvidenceKinds: ['user'],
          },
        ],
      })
    ).toEqual({ ok: true });
    const externalCriterion = coord.goal!.contract!.successCriteria.find(criterion =>
      criterion.requiredEvidenceKinds.includes('external')
    )!;
    const userCriterion = coord.goal!.contract!.successCriteria.find(criterion =>
      criterion.requiredEvidenceKinds.includes('user')
    )!;
    expect(coord.confirmCriterion(userCriterion.id)).toBe(true);
    const userEvidence = coord.goal!.evidenceLedger!.find(record => record.kind === 'user')!;
    const goal = coord.goal!;
    const runtimeEvidence: GoalEvidenceRecord = {
      id: 'evidence-runtime',
      goalId: goal.goalId,
      goalRevision: goal.revision,
      objectiveRevision: goal.contract!.objectiveRevision,
      turnId: 'turn-provenance',
      kind: 'test',
      subject: 'Release provenance receipt regression test',
      result: 'passed',
      sourceRef: 'tool:turn-provenance:exec_command',
      capturedAt: Date.now(),
      workspaceFingerprint: 'workspace-current',
      redacted: true,
    };
    const externalEvidence: GoalEvidenceRecord = {
      ...runtimeEvidence,
      id: 'evidence-external',
      kind: 'external',
      subject: 'Registry reports the released package',
      sourceRef: 'registry:@orion-agents/orion-code',
    };

    coord.finalizeTurn(
      outcome(coord, 'turn-provenance', {
        evidenceRecords: [runtimeEvidence, externalEvidence],
        verificationSummary: 'runtime, registry, and owner evidence passed',
        pendingTerminalRequest: {
          requestedStatus: 'complete',
          requestedAt: Date.now(),
          goalId: goal.goalId,
          goalRevision: goal.revision,
          turnId: 'turn-provenance',
          criterionEvidence: [
            {
              criterionId: 'criterion:primary',
              evidenceIds: [runtimeEvidence.id],
            },
            {
              criterionId: externalCriterion.id,
              evidenceIds: [externalEvidence.id],
            },
            {
              criterionId: userCriterion.id,
              evidenceIds: [userEvidence.id],
            },
          ],
        },
      })
    );

    expect(coord.goal?.status).toBe('complete');
    const summary = coord.goal!.completionAudit!.finalSummary!;
    expect(
      summary.criterionResults.flatMap(result =>
        (result.evidence ?? []).map(item => [result.criterionId, item.provenance])
      )
    ).toEqual(
      expect.arrayContaining([
        ['criterion:primary', 'runtime_automatic'],
        [externalCriterion.id, 'external'],
        [userCriterion.id, 'user_acceptance'],
      ])
    );

    const rendered = formatGoalRuntimeEvent({
      type: 'goal_completed',
      goal: coord.snapshot()!,
      audit: coord.goal!.completionAudit!,
    });
    expect(rendered).toContain('runtime_automatic/test');
    expect(rendered).toContain('external/external');
    expect(rendered).toContain('user_acceptance/user');
  });

  it('keeps the goal active when relevant evidence failed', () => {
    const coord = new GoalCoordinator('/tmp/goal-evidence-fail', 'session-fail');
    coord.create('Ship verified feature');
    const record = evidence(coord, 'turn-1', 'failed');
    coord.finalizeTurn(
      outcome(coord, 'turn-1', {
        pendingTerminalRequest: {
          requestedStatus: 'complete',
          requestedAt: Date.now(),
          goalId: coord.goal!.goalId,
          goalRevision: coord.goal!.revision,
          turnId: 'turn-1',
          criterionEvidence: [
            {
              criterionId: coord.goal!.contract!.successCriteria[0].id,
              evidenceIds: [record.id],
            },
          ],
        },
        evidenceRecords: [record],
        verificationSummary: 'test failed',
      })
    );

    expect(coord.goal?.status).toBe('active');
    expect(coord.goal?.completionAudit?.passed).toBe(false);
    expect(coord.goal?.completionAudit?.remainingRequirements[0]).toContain('failed');
    expect(coord.goal?.contract?.successCriteria[0].status).toBe('failed');
    expect(coord.goal?.contract?.planSnapshot).toMatchObject({
      phase: 'verification',
      nextAction: expect.stringContaining('Rerun the criterion-specific verification'),
    });
  });

  it('creates an actionable verification plan when an older contract has no plan snapshot', () => {
    const coord = new GoalCoordinator('/tmp/goal-evidence-no-plan', 'session-no-plan');
    coord.create('Verify a normalized contract without a plan');
    coord.goal!.contract!.planSnapshot = undefined;
    const goal = coord.goal!;

    coord.finalizeTurn(
      outcome(coord, 'turn-no-plan', {
        pendingTerminalRequest: {
          requestedStatus: 'complete',
          requestedAt: Date.now(),
          goalId: goal.goalId,
          goalRevision: goal.revision,
          turnId: 'turn-no-plan',
          criterionEvidence: [],
        },
      })
    );

    expect(coord.goal?.status).toBe('active');
    expect(coord.goal?.contract?.planSnapshot).toMatchObject({
      revision: 1,
      phase: 'verification',
      steps: [],
      nextAction: expect.stringContaining('fresh relevant evidence is required'),
    });
  });

  it('ignores a terminal request from another turn', () => {
    const coord = new GoalCoordinator('/tmp/goal-evidence-stale', 'session-stale');
    coord.create('Do not close from stale request');
    const record = evidence(coord, 'turn-1', 'passed');
    coord.finalizeTurn(
      outcome(coord, 'turn-1', {
        pendingTerminalRequest: {
          requestedStatus: 'complete',
          requestedAt: Date.now(),
          goalId: coord.goal!.goalId,
          goalRevision: coord.goal!.revision,
          turnId: 'turn-old',
          criterionEvidence: [
            {
              criterionId: coord.goal!.contract!.successCriteria[0].id,
              evidenceIds: [record.id],
            },
          ],
        },
        evidenceRecords: [record],
      })
    );
    expect(coord.goal?.status).toBe('active');
    expect(coord.goal?.completionAudit).toBeUndefined();
  });

  it('does not reuse evidence captured before /target edit for the new objective', () => {
    const coord = new GoalCoordinator('/tmp/goal-evidence-objective-edit', 'session-edit');
    coord.create('Verify objective A');
    const oldRecord = evidence(coord, 'turn-a', 'passed');
    coord.finalizeTurn(
      outcome(coord, 'turn-a', {
        evidenceRecords: [oldRecord],
        verificationSummary: 'objective A verified',
      })
    );

    expect(coord.edit('Verify unrelated objective B')).toBe(true);
    const current = coord.goal!;
    coord.finalizeTurn(
      outcome(coord, 'turn-b', {
        pendingTerminalRequest: {
          requestedStatus: 'complete',
          requestedAt: Date.now(),
          goalId: current.goalId,
          goalRevision: current.revision,
          turnId: 'turn-b',
          criterionEvidence: [
            {
              criterionId: current.contract!.successCriteria[0].id,
              evidenceIds: [oldRecord.id],
            },
          ],
        },
        verificationSummary: 'attempted stale evidence reuse',
      })
    );

    expect(coord.goal?.status).toBe('active');
    expect(coord.goal?.completionAudit?.passed).toBe(false);
    expect(coord.goal?.contract?.successCriteria[0].evidenceRefs).toEqual([]);
  });

  it('does not let one passing record close multiple criteria', () => {
    const coord = new GoalCoordinator('/tmp/goal-evidence-reuse', 'session-reuse');
    coord.create('Verify both requirements');
    const primary = coord.goal!.contract!.successCriteria[0];
    coord.goal!.contract!.successCriteria.push({
      id: 'criterion:second',
      statement: 'A separate second requirement',
      source: 'user',
      status: 'pending',
      requiredEvidenceKinds: ['test'],
      evidenceRefs: [],
    });
    const record = evidence(coord, 'turn-1', 'passed');
    coord.finalizeTurn(
      outcome(coord, 'turn-1', {
        pendingTerminalRequest: {
          requestedStatus: 'complete',
          requestedAt: Date.now(),
          goalId: coord.goal!.goalId,
          goalRevision: coord.goal!.revision,
          turnId: 'turn-1',
          criterionEvidence: [
            { criterionId: primary.id, evidenceIds: [record.id] },
            { criterionId: 'criterion:second', evidenceIds: [record.id] },
          ],
        },
        evidenceRecords: [record],
      })
    );
    expect(coord.goal?.status).toBe('active');
    expect(coord.goal?.completionAudit?.passed).toBe(false);
    expect(coord.goal?.completionAudit?.remainingRequirements).toHaveLength(2);
  });

  it('rejects evidence captured against an older workspace fingerprint', () => {
    const coord = new GoalCoordinator('/tmp/goal-evidence-workspace', 'session-workspace');
    coord.create('Verify the current workspace');
    const record = evidence(coord, 'turn-1', 'passed');
    record.workspaceFingerprint = 'old-workspace';
    coord.finalizeTurn(
      outcome(coord, 'turn-1', {
        workspaceFingerprint: 'new-workspace',
        pendingTerminalRequest: {
          requestedStatus: 'complete',
          requestedAt: Date.now(),
          goalId: coord.goal!.goalId,
          goalRevision: coord.goal!.revision,
          turnId: 'turn-1',
          criterionEvidence: [
            {
              criterionId: coord.goal!.contract!.successCriteria[0].id,
              evidenceIds: [record.id],
            },
          ],
        },
        evidenceRecords: [record],
      })
    );
    expect(coord.goal?.status).toBe('active');
    expect(coord.goal?.completionAudit?.passed).toBe(false);
    expect(coord.goal?.completionAudit?.remainingRequirements[0]).toContain('stale');
    expect(coord.goal?.contract?.successCriteria[0].status).toBe('stale');
  });

  it('fails closed when provider usage is unknown', () => {
    const coord = new GoalCoordinator('/tmp/goal-usage-unknown', 'session-usage');
    coord.create('Respect accounting');
    coord.finalizeTurn(outcome(coord, 'turn-1', { usageComplete: false }));
    expect(coord.goal?.status).toBe('paused');
    expect(coord.goal).toMatchObject({
      tokensUsed: 15,
      continuationCount: 1,
      stopReason: { message: expect.stringContaining('usage was missing or incomplete') },
    });
  });

  it('stops as usage_limited on provider quota exhaustion', () => {
    const coord = new GoalCoordinator('/tmp/goal-provider-usage', 'session-provider-usage');
    coord.create('Respect provider limits');
    coord.finalizeTurn(
      outcome(coord, 'turn-1', {
        finishReason: 'failed',
        madeProgress: false,
        providerError: { kind: 'usage_limit', retryable: false },
      })
    );
    expect(coord.goal?.status).toBe('usage_limited');
    expect(coord.goal?.stopReason?.kind).toBe('usage_limit');
    expect(coord.canContinue).toBe(false);
  });

  it('pauses on provider authentication failure with a recovery hint', () => {
    const coord = new GoalCoordinator('/tmp/goal-provider-auth', 'session-provider-auth');
    coord.create('Respect provider failures');
    coord.finalizeTurn(
      outcome(coord, 'turn-1', {
        finishReason: 'failed',
        madeProgress: false,
        providerError: { kind: 'auth', retryable: false },
      })
    );
    expect(coord.goal?.status).toBe('paused');
    expect(coord.goal?.stopReason?.message).toContain('authentication');
    expect(coord.canContinue).toBe(false);
  });

  it('enters blocked only after the same structured blocker persists for three turns', () => {
    const coord = new GoalCoordinator('/tmp/goal-blocked-three-turns', 'session-blocked');
    coord.create('Deploy after approval');
    expect(
      coord.resume({
        confirmBoundary: true,
        expectedGoalId: coord.goal?.goalId,
        expectedRevision: coord.goal?.revision,
      })
    ).toBe(true);
    const blocker = {
      category: 'permission' as const,
      fingerprint: 'permission:production:user approval required',
      summary: 'Permission on production: user approval required',
      retryable: false,
    };
    for (let index = 1; index <= 3; index++) {
      const turnId = `turn-${index}`;
      const goal = coord.goal!;
      coord.finalizeTurn(
        outcome(coord, turnId, {
          madeProgress: false,
          blocker,
          pendingTerminalRequest: {
            requestedStatus: 'blocked',
            requestedAt: Date.now(),
            goalId: goal.goalId,
            goalRevision: goal.revision,
            turnId,
          },
        })
      );
      if (index < 3) expect(coord.goal?.status).toBe('active');
    }
    expect(coord.goal?.status).toBe('blocked');
    expect(coord.goal?.blocker?.consecutiveTurns).toBe(3);
    expect(coord.goal?.stopReason?.kind).toBe('blocked');
  });

  it('breaks blocker continuity when an intervening turn omits the blocker', () => {
    const coord = new GoalCoordinator('/tmp/goal-blocker-reset', 'session-blocker-reset');
    coord.create('Deploy after approval');
    expect(
      coord.resume({
        confirmBoundary: true,
        expectedGoalId: coord.goal?.goalId,
        expectedRevision: coord.goal?.revision,
      })
    ).toBe(true);
    const blocker = {
      category: 'permission' as const,
      fingerprint: 'permission:production:user approval required',
      summary: 'Permission on production: user approval required',
      retryable: false,
    };
    const blockedTurn = (turnId: string): AgentTurnOutcome => {
      const goal = coord.goal!;
      return outcome(coord, turnId, {
        madeProgress: false,
        blocker,
        pendingTerminalRequest: {
          requestedStatus: 'blocked',
          requestedAt: Date.now(),
          goalId: goal.goalId,
          goalRevision: goal.revision,
          turnId,
        },
      });
    };

    coord.finalizeTurn(blockedTurn('turn-1'));
    expect(coord.goal?.blocker?.consecutiveTurns).toBe(1);
    coord.finalizeTurn(outcome(coord, 'turn-2', { madeProgress: true }));
    expect(coord.goal?.blocker).toBeUndefined();

    coord.finalizeTurn(blockedTurn('turn-3'));
    coord.finalizeTurn(blockedTurn('turn-4'));
    expect(coord.goal?.status).toBe('active');
    expect(coord.goal?.blocker?.consecutiveTurns).toBe(2);

    coord.finalizeTurn(blockedTurn('turn-5'));
    expect(coord.goal?.status).toBe('blocked');
    expect(coord.goal?.blocker?.consecutiveTurns).toBe(3);
  });
});
