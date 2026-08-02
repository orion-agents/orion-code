import { auditCompletion } from '../src/runtime/goals/completion-audit';
import { GoalCoordinator } from '../src/runtime/goals/coordinator';
import type {
  AgentTurnOutcome,
  GoalContract,
  GoalEvidenceRecord,
  SessionGoalV1,
} from '../src/runtime/goals/types';
import { loadGoal, saveGoal } from '../src/services/goal-storage';
import { getProjectSessionsDir } from '../src/services/config-dir';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

function writeRawSidecar(project: string, sessionId: string, payload: unknown): void {
  const sessionsDir = getProjectSessionsDir(project);
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, `${sessionId}.goal.json`), JSON.stringify(payload));
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
    usage: { promptTokens: 1, completionTokens: 1, subagentTokens: 0, totalTokens: 2 },
    usageComplete: true,
    madeProgress: true,
    workspaceFingerprint: 'workspace-current',
    ...overrides,
  };
}

function records(
  coord: GoalCoordinator,
  turnId: string,
  results: GoalEvidenceRecord['result'][]
): GoalEvidenceRecord[] {
  const goal = coord.goal!;
  return results.map((result, index) => ({
    id: `${turnId}:${index}`,
    goalId: goal.goalId,
    goalRevision: goal.revision,
    objectiveRevision: goal.contract!.objectiveRevision,
    turnId,
    kind: 'test',
    subject: `${goal.objective} verification ${index}`,
    result,
    sourceRef: `tool:${turnId}:${index}`,
    capturedAt: 1_000 + index,
    workspaceFingerprint: 'workspace-current',
    redacted: true,
  }));
}

function completeRequest(
  coord: GoalCoordinator,
  turnId: string,
  evidenceId: string
): AgentTurnOutcome['pendingTerminalRequest'] {
  return {
    requestedStatus: 'complete',
    requestedAt: Date.now(),
    goalId: coord.goal!.goalId,
    goalRevision: coord.goal!.revision,
    turnId,
    criterionEvidence: [
      {
        criterionId: coord.goal!.contract!.successCriteria[0].id,
        evidenceIds: [evidenceId],
      },
    ],
  };
}

describe('bounded Goal evidence ledger', () => {
  it('bounds more than 500 passing records and records the discarded count', () => {
    const coord = new GoalCoordinator(
      `/tmp/goal-ledger-passed-${Date.now()}-${Math.random()}`,
      'passed'
    );
    expect(coord.create('Verify bounded passing evidence').ok).toBe(true);
    const batch = records(coord, 'turn-passed', Array(501).fill('passed'));

    coord.finalizeTurn(outcome(coord, 'turn-passed', { evidenceRecords: batch }));

    expect(coord.goal?.evidenceLedger).toHaveLength(500);
    expect(coord.goal?.evidenceLedger?.map(record => record.id)).not.toContain('turn-passed:0');
    expect(coord.goal?.evidenceLedgerTruncation).toEqual({
      objectiveRevision: 0,
      droppedPassed: 1,
      droppedFailed: 0,
      droppedInconclusive: 0,
    });
  });

  it('keeps current-objective failed and inconclusive records ahead of passing records', () => {
    const coord = new GoalCoordinator(
      `/tmp/goal-ledger-mixed-${Date.now()}-${Math.random()}`,
      'mixed'
    );
    expect(coord.create('Verify mixed evidence retention').ok).toBe(true);
    const batch = records(coord, 'turn-mixed', [
      ...Array(499).fill('passed'),
      'failed',
      'inconclusive',
    ]);

    coord.finalizeTurn(outcome(coord, 'turn-mixed', { evidenceRecords: batch }));

    expect(coord.goal?.evidenceLedger).toHaveLength(500);
    expect(coord.goal?.evidenceLedger?.filter(record => record.result === 'failed')).toHaveLength(
      1
    );
    expect(
      coord.goal?.evidenceLedger?.filter(record => record.result === 'inconclusive')
    ).toHaveLength(1);
    expect(coord.goal?.evidenceLedgerTruncation).toEqual({
      objectiveRevision: 0,
      droppedPassed: 1,
      droppedFailed: 0,
      droppedInconclusive: 0,
    });
  });

  it('fails completion closed after negative overflow even with fresh passing evidence', () => {
    const contract: GoalContract = {
      originalObjective: 'Verify negative overflow safety',
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'criterion:primary',
          statement: 'Verify negative overflow safety',
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['test'],
          evidenceRefs: ['passing'],
        },
      ],
    };
    const passing: GoalEvidenceRecord = {
      id: 'passing',
      goalId: 'goal-overflow',
      goalRevision: 2,
      objectiveRevision: 0,
      turnId: 'turn-passing',
      kind: 'test',
      subject: 'Verify negative overflow safety test',
      result: 'passed',
      sourceRef: 'tool:turn-passing',
      capturedAt: 2_000,
      workspaceFingerprint: 'workspace-current',
      redacted: true,
    };

    const audit = auditCompletion({
      objective: contract.originalObjective,
      contract,
      evidenceLedger: [passing],
      evidenceLedgerTruncation: {
        objectiveRevision: 0,
        droppedPassed: 0,
        droppedFailed: 1,
        droppedInconclusive: 1,
      },
      goalId: 'goal-overflow',
      goalRevision: 2,
      requestedAt: 2_000,
      verificationSummary: 'fresh test passed',
      workspaceFingerprint: 'workspace-current',
      now: 2_001,
    });

    expect(audit.criterionResults?.[0]).toMatchObject({ passed: true, status: 'passed' });
    expect(audit.passed).toBe(false);
    expect(audit.remainingRequirements).toEqual([
      expect.stringContaining('Completion is fail-closed'),
    ]);

    const corruptMetadataAudit = auditCompletion({
      objective: contract.originalObjective,
      contract,
      evidenceLedger: [passing],
      evidenceLedgerTruncation: {
        objectiveRevision: 0,
        droppedPassed: 0,
        droppedFailed: 0,
        droppedInconclusive: 0,
      },
      goalId: 'goal-overflow',
      goalRevision: 2,
      requestedAt: 2_000,
      verificationSummary: 'fresh test passed',
      workspaceFingerprint: 'workspace-current',
      now: 2_001,
    });
    expect(corruptMetadataAudit.passed).toBe(false);
    expect(corruptMetadataAudit.remainingRequirements).toEqual([
      expect.stringContaining('truncation metadata is invalid'),
    ]);
  });

  it('clears old-epoch truncation on edit and permits fresh re-verification', () => {
    const coord = new GoalCoordinator(
      `/tmp/goal-ledger-edit-${Date.now()}-${Math.random()}`,
      'edit'
    );
    expect(coord.create('Verify initial objective').ok).toBe(true);
    const overflow = records(coord, 'turn-overflow', Array(501).fill('inconclusive'));
    coord.finalizeTurn(outcome(coord, 'turn-overflow', { evidenceRecords: overflow }));
    expect(coord.goal?.evidenceLedgerTruncation?.droppedInconclusive).toBe(1);

    expect(coord.edit('Verify edited objective')).toBe(true);
    expect(coord.goal?.contract?.objectiveRevision).toBe(1);
    expect(coord.goal?.evidenceLedgerTruncation).toBeUndefined();

    const passing = records(coord, 'turn-edited-pass', ['passed'])[0];
    coord.finalizeTurn(
      outcome(coord, 'turn-edited-pass', {
        evidenceRecords: [passing],
        pendingTerminalRequest: completeRequest(coord, 'turn-edited-pass', passing.id),
        verificationSummary: 'edited objective passed',
      })
    );

    expect(coord.goal?.status).toBe('complete');
    expect(coord.goal?.completionAudit?.passed).toBe(true);
    expect(coord.goal?.evidenceLedgerTruncation).toBeUndefined();
  });

  it('replays a persisted complete audit with truncation metadata and rejects lost negatives', () => {
    const project = `/tmp/goal-ledger-replay-${Date.now()}-${Math.random()}`;
    const sessionId = 'replay';
    const coord = new GoalCoordinator(project, sessionId);
    expect(coord.create('Verify replay protection').ok).toBe(true);
    const passing = records(coord, 'turn-complete', ['passed'])[0];
    coord.finalizeTurn(
      outcome(coord, 'turn-complete', {
        evidenceRecords: [passing],
        pendingTerminalRequest: completeRequest(coord, 'turn-complete', passing.id),
        verificationSummary: 'verified',
      })
    );
    expect(coord.goal?.status).toBe('complete');

    const forged: SessionGoalV1 = {
      ...coord.goal!,
      evidenceLedgerTruncation: {
        objectiveRevision: 0,
        droppedPassed: 0,
        droppedFailed: 1,
        droppedInconclusive: 0,
      },
    };
    expect(saveGoal(project, sessionId, forged)).toEqual(
      expect.objectContaining({ ok: false, error: 'io_error' })
    );
    expect(loadGoal(project, sessionId)).toEqual(
      expect.objectContaining({ ok: true, value: expect.objectContaining({ status: 'complete' }) })
    );
    writeRawSidecar(project, sessionId, forged);

    const loaded = loadGoal(project, sessionId);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error('forged complete goal unexpectedly loaded');
    expect(loaded.error).toBe('corrupt');
    expect(loaded.message).toContain('completionAudit replay failed');
  });

  it.each([
    {
      label: 'counter exceeds the schema bound',
      metadata: {
        objectiveRevision: 0,
        droppedPassed: 1_000_000_001,
        droppedFailed: 0,
        droppedInconclusive: 0,
      },
    },
    {
      label: 'objective epoch does not match the contract',
      metadata: {
        objectiveRevision: 1,
        droppedPassed: 1,
        droppedFailed: 0,
        droppedInconclusive: 0,
      },
    },
    {
      label: 'all counters are zero',
      metadata: {
        objectiveRevision: 0,
        droppedPassed: 0,
        droppedFailed: 0,
        droppedInconclusive: 0,
      },
    },
    {
      label: 'unexpected metadata field',
      metadata: {
        objectiveRevision: 0,
        droppedPassed: 1,
        droppedFailed: 0,
        droppedInconclusive: 0,
        unexpected: 1,
      },
    },
  ])('rejects corrupt truncation metadata: $label', ({ label, metadata }) => {
    const project = `/tmp/goal-ledger-corrupt-${label.replace(/\W+/gu, '-')}-${Math.random()}`;
    const sessionId = 'corrupt';
    const coord = new GoalCoordinator(project, sessionId);
    expect(coord.create('Verify metadata schema').ok).toBe(true);
    const corrupt = {
      ...coord.goal!,
      evidenceLedgerTruncation: metadata,
    };
    expect(saveGoal(project, sessionId, corrupt)).toEqual(
      expect.objectContaining({ ok: false, error: 'io_error' })
    );
    expect(loadGoal(project, sessionId).ok).toBe(true);
    writeRawSidecar(project, sessionId, corrupt);

    const loaded = loadGoal(project, sessionId);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error('corrupt truncation metadata unexpectedly loaded');
    expect(loaded.error).toBe('corrupt');
    expect(loaded.message).toContain('evidenceLedgerTruncation is invalid');
  });
});
