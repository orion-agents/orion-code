/**
 * Phase 1 - Goal storage compatibility tests.
 *
 * Validates: v0.1.1 sidecar (no contract) loads cleanly, CAS revision
 * enforcement, corrupt sidecar quarantine, and additive contract persistence.
 */

import { tmpdir } from 'os';
import { createHash } from 'crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { loadGoal, saveGoal, createGoal, deleteGoal } from '../src/services/goal-storage';
import { getProjectSessionsDir } from '../src/services/config-dir';
import { GoalCoordinator } from '../src/runtime/goals/coordinator';
import type {
  AgentTurnOutcome,
  GoalContract,
  GoalNoProgressTurn,
  SessionGoalV1,
} from '../src/runtime/goals/types';

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), 'orion-goal-storage-'));
}

/** Ensure the sessions dir exists, then write a raw sidecar (for v0.1.1 / corrupt fixtures). */
function writeRawSidecar(project: string, sessionId: string, payload: unknown): void {
  const dir = getProjectSessionsDir(project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.goal.json`), JSON.stringify(payload));
}

function sidecarLockPath(project: string, sessionId: string): string {
  return join(getProjectSessionsDir(project), `${sessionId}.goal.json.lock`);
}

function waitForFiles(paths: string[], timeoutMs: number = 5_000): void {
  const deadline = Date.now() + timeoutMs;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (!paths.every(path => existsSync(path))) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for child readiness: ${paths.join(', ')}`);
    }
    Atomics.wait(signal, 0, 0, 10);
  }
}

function collectChild(
  child: ReturnType<typeof spawn>
): Promise<{ code: number | null; output: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', chunk => (stdout += String(chunk)));
  child.stderr?.on('data', chunk => (stderr += String(chunk)));
  return new Promise(resolve => {
    child.on('close', code => resolve({ code, output: `${stdout}\n${stderr}`.trim() }));
  });
}

function v011Sidecar(goalId: string, sessionId: string, objective: string): SessionGoalV1 {
  return {
    version: 1,
    goalId,
    sessionId,
    revision: 0,
    objective,
    status: 'active',
    tokensUsed: 0,
    timeUsedMs: 0,
    createdAt: 1000,
    updatedAt: 1000,
    continuationCount: 0,
    noProgressCount: 0,
    // No contract - v0.1.1 shape.
  };
}

function noProgressTurn(overrides: Partial<GoalNoProgressTurn> = {}): GoalNoProgressTurn {
  return {
    turnId: 'turn:no-progress',
    endedAt: 2_000,
    finishReason: 'completed',
    passedEvidence: 0,
    failedEvidence: 1,
    inconclusiveEvidence: 0,
    planUpdateProposed: false,
    blockerCategory: 'external_state',
    ...overrides,
  };
}

function pendingContract(objective: string) {
  return {
    originalObjective: objective,
    objectiveRevision: 0,
    constraints: [],
    successCriteria: [
      {
        id: 'criterion:primary',
        statement: objective,
        source: 'user' as const,
        status: 'pending' as const,
        requiredEvidenceKinds: ['test' as const],
        evidenceRefs: [],
      },
    ],
  };
}

function validExternalEvidence(goalId: string) {
  return {
    id: 'evidence:registry',
    goalId,
    goalRevision: 0,
    objectiveRevision: 0,
    turnId: 'turn:registry',
    kind: 'external' as const,
    subject: 'registry assertion',
    result: 'passed' as const,
    sourceRef: 'tool:call-registry:exec_command',
    capturedAt: 1_000,
    expiresAt: 301_000,
    externalAssertion: {
      version: 1 as const,
      action: 'registry' as const,
      status: 'passed' as const,
      provider: 'npm' as const,
      target: '@orion-agents/orion-code',
      observedValue: '0.1.2',
      observedAt: 1_000,
      details: {
        kind: 'npm' as const,
        packageName: '@orion-agents/orion-code',
        version: '0.1.2',
        field: 'version' as const,
      },
    },
    redacted: true,
  };
}

describe('goal storage compatibility', () => {
  let project: string;

  beforeEach(() => {
    project = freshProject();
  });

  describe('v0.1.1 sidecar loading', () => {
    it('loads a v0.1.1 sidecar with no contract field', () => {
      // Write a raw v0.1.1 sidecar (no contract) directly to disk.
      const legacy: SessionGoalV1 = v011Sidecar('legacy-1', 'sess-1', 'Legacy objective');
      writeRawSidecar(project, 'sess-1', legacy);
      const sidecarPath = join(getProjectSessionsDir(project), 'sess-1.goal.json');
      const beforeBytes = readFileSync(sidecarPath);
      const beforeMtimeMs = statSync(sidecarPath).mtimeMs;

      const result = loadGoal(project, 'sess-1');
      expect(result.ok).toBe(true);
      expect(result.ok && result.value.objective).toBe('Legacy objective');
      // v0.1.1 sidecar has no contract; storage returns it as-is.
      expect(result.ok && result.value.contract).toBeUndefined();
      expect(readFileSync(sidecarPath)).toEqual(beforeBytes);
      expect(statSync(sidecarPath).mtimeMs).toBe(beforeMtimeMs);
    });

    it('keeps contract-less v0.1.1 safe-integer boundary values readable', () => {
      const sessionId = 'sess-v011-safe-integer-boundary';
      writeRawSidecar(project, sessionId, {
        ...v011Sidecar('legacy-safe-integer-boundary', sessionId, 'Legacy safe boundary'),
        revision: Number.MAX_SAFE_INTEGER,
        tokenBudget: Number.MAX_SAFE_INTEGER,
        tokensUsed: Number.MAX_SAFE_INTEGER,
        timeUsedMs: Number.MAX_SAFE_INTEGER,
        createdAt: Number.MAX_SAFE_INTEGER,
        updatedAt: Number.MAX_SAFE_INTEGER,
        activeSince: Number.MAX_SAFE_INTEGER,
        continuationCount: Number.MAX_SAFE_INTEGER,
        noProgressCount: Number.MAX_SAFE_INTEGER,
      });

      const loaded = loadGoal(project, sessionId);
      expect(loaded).toEqual(
        expect.objectContaining({
          ok: true,
          value: expect.objectContaining({
            revision: Number.MAX_SAFE_INTEGER,
            timeUsedMs: Number.MAX_SAFE_INTEGER,
          }),
        })
      );
      expect(loaded.ok && loaded.value.contract).toBeUndefined();
    });

    it('fails restart recovery closed at the revision boundary without rewriting the legacy sidecar', () => {
      const sessionId = 'sess-v011-restart-revision-boundary';
      writeRawSidecar(project, sessionId, {
        ...v011Sidecar('legacy-restart-revision-boundary', sessionId, 'Legacy restart boundary'),
        revision: Number.MAX_SAFE_INTEGER,
      });
      const sidecarPath = join(getProjectSessionsDir(project), `${sessionId}.goal.json`);
      const beforeBytes = readFileSync(sidecarPath);

      const coordinator = new GoalCoordinator(project, sessionId);
      expect(coordinator.load(true)).toBe(true);
      expect(coordinator.lastLoadIssue).toMatchObject({ code: 'io_error' });
      expect(coordinator.goal).toMatchObject({
        status: 'paused',
        revision: Number.MAX_SAFE_INTEGER,
        stopReason: {
          kind: 'runtime_error',
          message: expect.stringContaining('safe integer range'),
        },
      });
      expect(readFileSync(sidecarPath)).toEqual(beforeBytes);
      expect(loadGoal(project, sessionId)).toEqual(
        expect.objectContaining({
          ok: true,
          value: expect.objectContaining({
            status: 'active',
            revision: Number.MAX_SAFE_INTEGER,
          }),
        })
      );
    });

    it('fails an ordinary revision increment closed without corrupting the disk authority', () => {
      const sessionId = 'sess-v011-pause-revision-boundary';
      writeRawSidecar(project, sessionId, {
        ...v011Sidecar('legacy-pause-revision-boundary', sessionId, 'Legacy pause boundary'),
        revision: Number.MAX_SAFE_INTEGER,
      });
      const sidecarPath = join(getProjectSessionsDir(project), `${sessionId}.goal.json`);
      const beforeBytes = readFileSync(sidecarPath);
      const coordinator = new GoalCoordinator(project, sessionId);
      expect(coordinator.load()).toBe(true);

      expect(() => coordinator.pause()).toThrow('safe integer range');
      expect(coordinator.goal).toMatchObject({
        status: 'paused',
        revision: Number.MAX_SAFE_INTEGER,
        stopReason: { kind: 'runtime_error' },
      });
      expect(readFileSync(sidecarPath)).toEqual(beforeBytes);
      expect(loadGoal(project, sessionId)).toEqual(
        expect.objectContaining({
          ok: true,
          value: expect.objectContaining({
            status: 'active',
            revision: Number.MAX_SAFE_INTEGER,
          }),
        })
      );
    });

    it.each([
      {
        field: 'tokensUsed',
        sidecar: { tokensUsed: Number.MAX_SAFE_INTEGER },
        usage: { promptTokens: 1, completionTokens: 0, subagentTokens: 0, totalTokens: 1 },
        startedAt: 1_000,
        endedAt: 1_000,
      },
      {
        field: 'timeUsedMs',
        sidecar: { timeUsedMs: Number.MAX_SAFE_INTEGER },
        usage: { promptTokens: 0, completionTokens: 0, subagentTokens: 0, totalTokens: 0 },
        startedAt: 1_000,
        endedAt: 1_001,
      },
      {
        field: 'continuationCount',
        sidecar: { continuationCount: Number.MAX_SAFE_INTEGER },
        usage: { promptTokens: 0, completionTokens: 0, subagentTokens: 0, totalTokens: 0 },
        startedAt: 1_000,
        endedAt: 1_000,
      },
    ])('fails a $field accumulation closed without replacing the disk sidecar', testCase => {
      const sessionId = `sess-v011-${testCase.field}-boundary`;
      writeRawSidecar(project, sessionId, {
        ...v011Sidecar(`legacy-${testCase.field}-boundary`, sessionId, 'Legacy count boundary'),
        ...testCase.sidecar,
      });
      const sidecarPath = join(getProjectSessionsDir(project), `${sessionId}.goal.json`);
      const beforeBytes = readFileSync(sidecarPath);
      const coordinator = new GoalCoordinator(project, sessionId);
      expect(coordinator.load()).toBe(true);
      const goal = coordinator.goal!;
      const turn: AgentTurnOutcome = {
        turnId: `turn-${testCase.field}-overflow`,
        sessionId,
        goalId: goal.goalId,
        goalRevision: goal.revision,
        startedAt: testCase.startedAt,
        endedAt: testCase.endedAt,
        finishReason: 'completed',
        usage: testCase.usage,
        usageComplete: true,
        madeProgress: true,
      };

      expect(() => coordinator.finalizeTurn(turn)).toThrow('safe integer range');
      expect(coordinator.goal).toMatchObject({
        status: 'paused',
        stopReason: { kind: 'runtime_error' },
      });
      expect(readFileSync(sidecarPath)).toEqual(beforeBytes);
      expect(loadGoal(project, sessionId)).toEqual(
        expect.objectContaining({
          ok: true,
          value: expect.objectContaining({ status: 'active', ...testCase.sidecar }),
        })
      );
    });

    it('refuses an unsafe candidate before save can replace a valid sidecar', () => {
      const sessionId = 'sess-save-schema-preflight';
      const created = createGoal(project, sessionId, 'Preserve valid disk authority');
      if (!created.ok) throw new Error(created.message);
      const sidecarPath = join(getProjectSessionsDir(project), `${sessionId}.goal.json`);
      const beforeBytes = readFileSync(sidecarPath);
      const unsafe = {
        ...created.value,
        revision: Number.MAX_SAFE_INTEGER + 1,
      };

      expect(saveGoal(project, sessionId, unsafe, created.value.revision)).toEqual(
        expect.objectContaining({
          ok: false,
          error: 'io_error',
          message: expect.stringContaining('Refusing to persist an invalid Goal sidecar'),
        })
      );
      expect(readFileSync(sidecarPath)).toEqual(beforeBytes);
      expect(loadGoal(project, sessionId)).toEqual(
        expect.objectContaining({
          ok: true,
          value: expect.objectContaining({ revision: created.value.revision }),
        })
      );
    });

    it.each([
      'corrupt',
      'metadata_mismatch',
      'incompatible_schema',
      'io_error',
      'not_found',
    ] as const)('invalidates an already-loaded Goal when a repeat load fails with %s', failure => {
      const sessionId = `sess-repeat-load-${failure}`;
      const coordinator = new GoalCoordinator(project, sessionId);
      expect(coordinator.create('Do not continue stale in-memory state')).toEqual({ ok: true });
      expect(coordinator.isActive).toBe(true);
      expect(coordinator.canContinue).toBe(true);
      const generationBeforeFailure = coordinator.generation;
      const sidecarPath = join(getProjectSessionsDir(project), `${sessionId}.goal.json`);

      switch (failure) {
        case 'corrupt':
          writeRawSidecar(project, sessionId, { version: 1, notGoalId: true });
          break;
        case 'metadata_mismatch':
          writeRawSidecar(
            project,
            sessionId,
            v011Sidecar('goal-repeat-load-mismatch', 'wrong-session', 'Disk authority')
          );
          break;
        case 'incompatible_schema':
          writeRawSidecar(project, sessionId, {
            ...v011Sidecar('goal-repeat-load-future', sessionId, 'Disk authority'),
            version: 2,
          });
          break;
        case 'io_error':
          rmSync(sidecarPath);
          mkdirSync(sidecarPath);
          break;
        case 'not_found':
          rmSync(sidecarPath);
          break;
      }

      expect(coordinator.load()).toBe(false);
      if (failure === 'not_found') {
        expect(coordinator.lastLoadIssue).toBeNull();
      } else {
        expect(coordinator.lastLoadIssue).toMatchObject({ code: failure });
      }
      expect(coordinator.generation).toBeGreaterThan(generationBeforeFailure);
      expect(coordinator.goal).toBeNull();
      expect(coordinator.isActive).toBe(false);
      expect(coordinator.canContinue).toBe(false);
      if (failure === 'io_error') {
        expect(statSync(sidecarPath).isDirectory()).toBe(true);
      } else {
        expect(existsSync(sidecarPath)).toBe(false);
      }
    });

    it('invalidates pre-reload finalize and stale-accounting outcomes after successful loads', () => {
      const finalizeSessionId = 'sess-repeat-success-finalize';
      const finalizeSeed = createGoal(project, finalizeSessionId, 'Reload before finalizing');
      if (!finalizeSeed.ok) throw new Error(finalizeSeed.message);
      const finalizeCoordinator = new GoalCoordinator(project, finalizeSessionId);
      expect(finalizeCoordinator.load()).toBe(true);
      const staleFinalizeRequest = finalizeCoordinator.buildContinuationRequest()!;
      const staleFinalizeGoal = staleFinalizeRequest.goal!;
      const finalizeBytesBeforeReload = readFileSync(
        join(getProjectSessionsDir(project), `${finalizeSessionId}.goal.json`)
      );

      expect(finalizeCoordinator.load()).toBe(true);
      expect(finalizeCoordinator.generation).not.toBe(staleFinalizeRequest.generation);
      finalizeCoordinator.finalizeTurn({
        turnId: 'turn-before-successful-reload',
        sessionId: finalizeSessionId,
        goalId: staleFinalizeGoal.goalId,
        goalRevision: staleFinalizeGoal.revision,
        goalGeneration: staleFinalizeRequest.generation,
        startedAt: 1_000,
        endedAt: 2_000,
        finishReason: 'completed',
        usage: { promptTokens: 10, completionTokens: 5, subagentTokens: 0, totalTokens: 15 },
        usageComplete: true,
        madeProgress: true,
      });
      expect(finalizeCoordinator.goal).toMatchObject({ revision: 0, continuationCount: 0 });
      expect(
        readFileSync(join(getProjectSessionsDir(project), `${finalizeSessionId}.goal.json`))
      ).toEqual(finalizeBytesBeforeReload);

      const accountingSessionId = 'sess-repeat-success-stale-accounting';
      const accountingSeed = createGoal(project, accountingSessionId, 'Reload before accounting');
      if (!accountingSeed.ok) throw new Error(accountingSeed.message);
      const accountingCoordinator = new GoalCoordinator(project, accountingSessionId);
      expect(accountingCoordinator.load()).toBe(true);
      const staleAccountingRequest = accountingCoordinator.buildContinuationRequest()!;
      const staleAccountingGoal = staleAccountingRequest.goal!;
      expect(
        saveGoal(
          project,
          accountingSessionId,
          {
            ...accountingSeed.value,
            revision: 1,
            updatedAt: accountingSeed.value.updatedAt + 1,
          },
          0
        ).ok
      ).toBe(true);

      expect(accountingCoordinator.load()).toBe(true);
      expect(accountingCoordinator.generation).not.toBe(staleAccountingRequest.generation);
      expect(
        accountingCoordinator.accountStaleTurn({
          turnId: 'turn-stale-before-successful-reload',
          sessionId: accountingSessionId,
          goalId: staleAccountingGoal.goalId,
          goalRevision: staleAccountingGoal.revision,
          goalGeneration: staleAccountingRequest.generation,
          startedAt: 1_000,
          endedAt: 2_000,
          finishReason: 'completed',
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            subagentTokens: 0,
            totalTokens: 15,
          },
          usageComplete: true,
          madeProgress: true,
        })
      ).toBe(false);
      expect(accountingCoordinator.goal).toMatchObject({
        revision: 1,
        tokensUsed: 0,
        continuationCount: 0,
      });
    });

    it('rejects an active pending boundary before create or save can persist it', () => {
      const contract = pendingContract('Publish only after confirmation');
      const pendingBoundary = {
        requiredAt: 1_000,
        reason: 'external_destructive_or_high_impact',
        objectiveRevision: 0,
      };
      const createSessionId = 'sess-invalid-active-pending-boundary-create';

      expect(
        createGoal(
          project,
          createSessionId,
          'Publish only after confirmation',
          contract,
          undefined,
          {
            status: 'active',
            boundaryConfirmation: pendingBoundary,
          }
        )
      ).toEqual(expect.objectContaining({ ok: false, error: 'io_error' }));
      expect(loadGoal(project, createSessionId)).toEqual(
        expect.objectContaining({ ok: false, error: 'not_found' })
      );

      const saveSessionId = 'sess-invalid-active-pending-boundary-save';
      const valid = createGoal(project, saveSessionId, 'Publish only after confirmation', contract);
      if (!valid.ok) throw new Error(valid.message);
      const sidecarPath = join(getProjectSessionsDir(project), `${saveSessionId}.goal.json`);
      const beforeBytes = readFileSync(sidecarPath);
      expect(
        saveGoal(
          project,
          saveSessionId,
          { ...valid.value, boundaryConfirmation: pendingBoundary },
          valid.value.revision
        )
      ).toEqual(expect.objectContaining({ ok: false, error: 'io_error' }));
      expect(readFileSync(sidecarPath)).toEqual(beforeBytes);
    });

    it.each([
      {
        label: 'active pending confirmation',
        mutate: (goal: SessionGoalV1) => ({
          ...goal,
          status: 'active',
          activeSince: 1_000,
          stopReason: undefined,
        }),
      },
      {
        label: 'pending confirmation without a user stop reason',
        mutate: (goal: SessionGoalV1) => ({
          ...goal,
          stopReason: { kind: 'budget_limit', message: 'Wrong reason', at: 1_000 },
        }),
      },
      {
        label: 'confirmedAt without confirmedRevision',
        mutate: (goal: SessionGoalV1) => ({
          ...goal,
          boundaryConfirmation: { ...goal.boundaryConfirmation!, confirmedAt: 2_000 },
        }),
      },
      {
        label: 'confirmedRevision without confirmedAt',
        mutate: (goal: SessionGoalV1) => ({
          ...goal,
          boundaryConfirmation: { ...goal.boundaryConfirmation!, confirmedRevision: 0 },
        }),
      },
      {
        label: 'boundary objective revision mismatch',
        mutate: (goal: SessionGoalV1) => ({
          ...goal,
          boundaryConfirmation: { ...goal.boundaryConfirmation!, objectiveRevision: 1 },
        }),
      },
      {
        label: 'confirmed revision newer than the Goal',
        mutate: (goal: SessionGoalV1) => ({
          ...goal,
          boundaryConfirmation: {
            ...goal.boundaryConfirmation!,
            confirmedAt: 2_000,
            confirmedRevision: goal.revision + 1,
          },
        }),
      },
      {
        label: 'boundary confirmation without a contract',
        mutate: (goal: SessionGoalV1) => ({ ...goal, contract: undefined }),
      },
    ])('fails closed when replaying $label', ({ label, mutate }) => {
      const sessionId = `sess-invalid-boundary-${label.replace(/\s+/gu, '-')}`;
      const objective = 'Publish only after confirmation';
      const base: SessionGoalV1 = {
        ...v011Sidecar(`goal-${sessionId}`, sessionId, objective),
        status: 'paused',
        activeSince: undefined,
        stopReason: {
          kind: 'user',
          message: 'Boundary confirmation required before continuation.',
          at: 1_000,
        },
        boundaryConfirmation: {
          requiredAt: 1_000,
          reason: 'external_destructive_or_high_impact',
          objectiveRevision: 0,
        },
        contract: pendingContract(objective),
      };
      writeRawSidecar(project, sessionId, mutate(base));

      const coordinator = new GoalCoordinator(project, sessionId);
      expect(coordinator.load()).toBe(false);
      expect(coordinator.lastLoadIssue).toMatchObject({ code: 'corrupt' });
      expect(coordinator.goal).toBeNull();
      expect(coordinator.canContinue).toBe(false);
      expect(existsSync(join(getProjectSessionsDir(project), `${sessionId}.goal.json`))).toBe(
        false
      );
    });

    it('downgrades an unverifiable legacy complete marker for v0.1.2 re-verification', () => {
      const sessionId = 'sess-legacy-complete';
      const legacy = {
        ...v011Sidecar('legacy-complete', sessionId, 'Legacy complete objective'),
        status: 'complete' as const,
        completedAt: 2_000,
      };
      writeRawSidecar(project, sessionId, legacy);

      const coordinator = new GoalCoordinator(project, sessionId);
      expect(coordinator.load()).toBe(true);
      expect(coordinator.goal).toMatchObject({
        status: 'paused',
        completedAt: undefined,
        completionAudit: undefined,
        stopReason: {
          kind: 'user',
          message: 'Legacy completion requires v0.1.2 evidence re-verification.',
        },
        contract: {
          successCriteria: [expect.objectContaining({ status: 'pending' })],
        },
      });
    });

    it('normalizes contradictory legacy active fields before restart recovery persists a contract', () => {
      const sessionId = 'sess-legacy-active-completed';
      writeRawSidecar(project, sessionId, {
        ...v011Sidecar(
          'legacy-active-completed',
          sessionId,
          'Legacy active objective with stale terminal fields'
        ),
        completedAt: 2_000,
        stopReason: { kind: 'budget_limit', message: 'Stale terminal marker', at: 2_000 },
      });

      const firstRestart = new GoalCoordinator(project, sessionId);
      expect(firstRestart.load(true)).toBe(true);
      expect(firstRestart.goal).toMatchObject({
        status: 'paused',
        completedAt: undefined,
        contract: { successCriteria: [expect.objectContaining({ status: 'pending' })] },
        stopReason: {
          kind: 'user',
          message: 'Recovered after restart. Use /target resume to continue.',
        },
      });

      const persisted = loadGoal(project, sessionId);
      expect(persisted.ok).toBe(true);
      expect(persisted.ok && persisted.value.completedAt).toBeUndefined();

      const secondRestart = new GoalCoordinator(project, sessionId);
      expect(secondRestart.load(true)).toBe(true);
      expect(secondRestart.goal).toMatchObject({
        status: 'paused',
        contract: { successCriteria: [expect.objectContaining({ status: 'pending' })] },
      });
      expect(secondRestart.goal?.completedAt).toBeUndefined();
    });

    it('createGoal persists a contract when provided', () => {
      const contract = {
        originalObjective: 'With contract',
        objectiveRevision: 0,
        constraints: [],
        successCriteria: [
          {
            id: 'criterion:primary',
            statement: 'With contract',
            source: 'derived' as const,
            status: 'pending' as const,
            requiredEvidenceKinds: ['test' as const],
            evidenceRefs: [],
          },
        ],
      };
      const result = createGoal(project, 'sess-2', 'With contract', contract);
      expect(result.ok).toBe(true);

      const loaded = loadGoal(project, 'sess-2');
      expect(loaded.ok && loaded.value.contract).toBeDefined();
      expect(loaded.ok && loaded.value.contract!.originalObjective).toBe('With contract');
    });

    it.each([
      {
        label: 'constraint',
        contract: {
          ...pendingContract('Reject duplicate constraint IDs'),
          constraints: [
            { id: 'constraint:duplicate', statement: 'First constraint', source: 'user' as const },
            { id: 'constraint:duplicate', statement: 'Second constraint', source: 'user' as const },
          ],
        },
      },
      {
        label: 'success criterion',
        contract: {
          ...pendingContract('Reject duplicate criterion IDs'),
          successCriteria: [
            pendingContract('Reject duplicate criterion IDs').successCriteria[0],
            {
              ...pendingContract('Reject duplicate criterion IDs').successCriteria[0],
              statement: 'Second criterion with the same ID',
            },
          ],
        },
      },
      {
        label: 'plan step',
        contract: {
          ...pendingContract('Reject duplicate plan step IDs'),
          planSnapshot: {
            revision: 1,
            phase: 'execution',
            steps: [
              { id: 'plan:duplicate', description: 'First step', done: false },
              { id: 'plan:duplicate', description: 'Second step', done: false },
            ],
            updatedAt: 1_000,
          },
        },
      },
    ] as Array<{ label: string; contract: GoalContract }>)(
      'createGoal refuses a contract with duplicate $label IDs before writing',
      ({ label, contract }) => {
        const sessionId = `sess-create-duplicate-${label.replace(/\W+/gu, '-')}`;
        expect(createGoal(project, sessionId, contract.originalObjective, contract)).toEqual(
          expect.objectContaining({ ok: false, error: 'io_error' })
        );
        expect(loadGoal(project, sessionId)).toEqual(
          expect.objectContaining({ ok: false, error: 'not_found' })
        );
      }
    );

    it('createGoal works without a contract (backward-compatible callers)', () => {
      const result = createGoal(project, 'sess-3', 'No contract');
      expect(result.ok).toBe(true);
      const loaded = loadGoal(project, 'sess-3');
      expect(loaded.ok && loaded.value.objective).toBe('No contract');
      expect(loaded.ok && loaded.value.contract).toBeUndefined();
    });

    it('round-trips v0.1.2 additive fields through the published v0.1.1 reader', () => {
      const sessionId = 'sess-v011-rollback';
      const additiveGoal: SessionGoalV1 = {
        version: 1,
        goalId: 'goal-v012-additive',
        sessionId,
        revision: 7,
        objective: 'Verify v0.1.1 rollback compatibility',
        status: 'paused',
        tokenBudget: 5_000,
        tokensUsed: 321,
        timeUsedMs: 654,
        createdAt: 1_000,
        updatedAt: 2_000,
        continuationCount: 4,
        noProgressCount: 1,
        contract: {
          originalObjective: 'Verify v0.1.1 rollback compatibility',
          objectiveRevision: 1,
          objectiveHistory: [
            {
              revision: 1,
              previousObjective: 'Verify compatibility',
              objective: 'Verify v0.1.1 rollback compatibility',
              reason: 'Explicit rollback scope',
              changedAt: 1_500,
              source: 'user',
            },
          ],
          constraints: [{ id: 'constraint:1', statement: 'No global install', source: 'user' }],
          successCriteria: [
            {
              id: 'criterion:primary',
              statement: 'Published v0.1.1 reads additive sidecar',
              source: 'user',
              status: 'passed',
              requiredEvidenceKinds: ['runtime'],
              evidenceRefs: ['evidence:1'],
            },
          ],
          planSnapshot: {
            revision: 2,
            phase: 'rollback-verification',
            steps: [{ id: 'step:1', description: 'Read with v0.1.1', done: true }],
            nextAction: 'Record evidence',
            updatedAt: 1_900,
          },
        },
        evidenceLedger: [
          {
            id: 'evidence:1',
            goalId: 'goal-v012-additive',
            goalRevision: 7,
            objectiveRevision: 1,
            turnId: 'turn:1',
            kind: 'runtime',
            subject: 'published v0.1.1 reader',
            result: 'passed',
            sourceRef: 'npm:@orion-agents/orion-code@0.1.1',
            capturedAt: 1_950,
            redacted: true,
          },
        ],
        evidenceLedgerTruncation: {
          objectiveRevision: 1,
          droppedPassed: 4,
          droppedFailed: 0,
          droppedInconclusive: 0,
        },
        recentNoProgressTurns: [
          noProgressTurn({
            turnId: 'turn:1',
            endedAt: 1_975,
            finishReason: 'completion_gate',
            planUpdateProposed: true,
          }),
        ],
        progressEvidenceKeys: ['a'.repeat(64)],
      };
      const written = saveGoal(project, sessionId, additiveGoal);
      expect(written.ok).toBe(true);

      const publishedReaderPath = join(
        __dirname,
        'fixtures',
        'orion-code-v0.1.1',
        'services',
        'goal-storage.js'
      );
      const readerBytes = readFileSync(publishedReaderPath);
      // apply_patch stores text fixtures with a final LF; the published npm
      // artifact did not. Hash the original bytes to pin the actual reader.
      const publishedBytes =
        readerBytes.at(-1) === 0x0a ? readerBytes.subarray(0, -1) : readerBytes;
      expect(createHash('sha256').update(publishedBytes).digest('hex')).toBe(
        'e3e4a6ab7613a1a047be7833f0d2ed84ee1a5fa142c091655f6561deee0e3d17'
      );

      const previousSessionsDir = process.env.ORION_V011_FIXTURE_SESSIONS_DIR;
      process.env.ORION_V011_FIXTURE_SESSIONS_DIR = getProjectSessionsDir(project);
      try {
        const legacyStorage = require(publishedReaderPath) as Pick<
          typeof import('../src/services/goal-storage'),
          'loadGoal' | 'saveGoal'
        >;
        const legacyLoaded = legacyStorage.loadGoal(project, sessionId);
        expect(legacyLoaded.ok).toBe(true);
        if (!legacyLoaded.ok) throw new Error(legacyLoaded.message);
        expect(legacyLoaded.value.contract).toEqual(additiveGoal.contract);
        expect(legacyLoaded.value.evidenceLedger).toEqual(additiveGoal.evidenceLedger);
        expect(legacyLoaded.value.evidenceLedgerTruncation).toEqual(
          additiveGoal.evidenceLedgerTruncation
        );
        expect(legacyLoaded.value.recentNoProgressTurns).toEqual(
          additiveGoal.recentNoProgressTurns
        );
        expect(legacyLoaded.value.progressEvidenceKeys).toEqual(additiveGoal.progressEvidenceKeys);

        const legacySaved = legacyStorage.saveGoal(
          project,
          sessionId,
          { ...legacyLoaded.value, revision: 8, tokensUsed: 999, updatedAt: 3_000 },
          7
        );
        expect(legacySaved.ok).toBe(true);

        const currentReloaded = loadGoal(project, sessionId);
        expect(currentReloaded.ok).toBe(true);
        if (!currentReloaded.ok) throw new Error(currentReloaded.message);
        expect(currentReloaded.value).toMatchObject({ revision: 8, tokensUsed: 999 });
        expect(currentReloaded.value.contract).toEqual(additiveGoal.contract);
        expect(currentReloaded.value.evidenceLedger).toEqual(additiveGoal.evidenceLedger);
        expect(currentReloaded.value.evidenceLedgerTruncation).toEqual(
          additiveGoal.evidenceLedgerTruncation
        );
        expect(currentReloaded.value.recentNoProgressTurns).toEqual(
          additiveGoal.recentNoProgressTurns
        );
        expect(currentReloaded.value.progressEvidenceKeys).toEqual(
          additiveGoal.progressEvidenceKeys
        );
      } finally {
        if (previousSessionsDir === undefined) {
          delete process.env.ORION_V011_FIXTURE_SESSIONS_DIR;
        } else {
          process.env.ORION_V011_FIXTURE_SESSIONS_DIR = previousSessionsDir;
        }
      }
    });
  });

  describe('CAS revision enforcement', () => {
    it('saveGoal with correct expectedRevision succeeds', () => {
      const result = createGoal(project, 'sess-cas', 'CAS goal');
      if (!result.ok) throw new Error('create failed');
      const goal = result.value;
      const rev = goal.revision;

      const save = saveGoal(
        project,
        'sess-cas',
        { ...goal, tokensUsed: 100, revision: rev + 1 },
        rev
      );
      expect(save.ok).toBe(true);
    });

    it('saveGoal with stale expectedRevision fails closed', () => {
      const result = createGoal(project, 'sess-cas-stale', 'CAS stale goal');
      if (!result.ok) throw new Error('create failed');
      const goal = result.value;

      // First write bumps revision to 1.
      saveGoal(
        project,
        'sess-cas-stale',
        { ...goal, tokensUsed: 100, revision: goal.revision + 1 },
        goal.revision
      );

      // Second write with the OLD expectedRevision (0) must fail - no silent overwrite.
      const stale = saveGoal(
        project,
        'sess-cas-stale',
        { ...goal, tokensUsed: 999, revision: 99 },
        goal.revision
      );
      expect(stale.ok).toBe(false);
      if (!stale.ok) {
        expect(stale.error).toBe('revision_stale');
      }

      // The sidecar must NOT have been overwritten with the stale write.
      const loaded = loadGoal(project, 'sess-cas-stale');
      expect(loaded.ok && loaded.value.tokensUsed).toBe(100);
    });

    it('persists a deletion fence across processes without blocking a new Goal identity', async () => {
      const sessionId = 'sess-cas-delete-fence';
      const created = createGoal(project, sessionId, 'Goal that will be deleted');
      if (!created.ok) throw new Error('create failed');

      const deleted = deleteGoal(project, sessionId, created.value.revision);
      expect(deleted.ok).toBe(true);
      expect(
        existsSync(join(getProjectSessionsDir(project), `${sessionId}.goal.json.deleted`))
      ).toBe(true);
      const fence = JSON.parse(
        readFileSync(join(getProjectSessionsDir(project), `${sessionId}.goal.json.deleted`), 'utf8')
      );
      expect(fence).toEqual(
        expect.objectContaining({
          kind: 'goal_deletion_fence',
          sessionId,
          goalId: created.value.goalId,
          revision: created.value.revision,
        })
      );
      expect(fence).not.toHaveProperty('objective');
      expect(loadGoal(project, sessionId)).toEqual(
        expect.objectContaining({ ok: false, error: 'not_found' })
      );

      const childSource = `
        const { join } = require('path');
        const { saveGoal } = require(join(process.cwd(), 'src/services/goal-storage.ts'));
        const [project, sessionId, goalJson] = process.argv.slice(1);
        const goal = JSON.parse(Buffer.from(goalJson, 'base64').toString('utf8'));
        const result = saveGoal(project, sessionId, goal, goal.revision);
        process.stdout.write(JSON.stringify(result));
      `;
      const encodedGoal = Buffer.from(JSON.stringify(created.value)).toString('base64');
      const runStaleWriter = async () => {
        const child = spawn(
          process.execPath,
          [
            '-r',
            'ts-node/register/transpile-only',
            '-e',
            childSource,
            '--',
            project,
            sessionId,
            encodedGoal,
          ],
          { cwd: join(__dirname, '..'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        const result = await collectChild(child);
        expect(result.code).toBe(0);
        try {
          return JSON.parse(result.output);
        } catch {
          throw new Error(`Invalid child output: ${result.output}`);
        }
      };

      const staleAfterDelete = await runStaleWriter();
      expect(staleAfterDelete).toEqual(
        expect.objectContaining({ ok: false, error: 'revision_stale' })
      );
      expect(loadGoal(project, sessionId)).toEqual(
        expect.objectContaining({ ok: false, error: 'not_found' })
      );

      const replacement = createGoal(project, sessionId, 'Fresh Goal after deletion');
      expect(replacement.ok).toBe(true);
      if (!replacement.ok) throw new Error(replacement.message);
      expect(replacement.value.goalId).not.toBe(created.value.goalId);
      expect(
        existsSync(join(getProjectSessionsDir(project), `${sessionId}.goal.json.deleted`))
      ).toBe(false);

      const staleAfterReplacement = await runStaleWriter();
      expect(staleAfterReplacement).toEqual(
        expect.objectContaining({ ok: false, error: 'revision_stale' })
      );
      const loaded = loadGoal(project, sessionId);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) throw new Error(loaded.message);
      expect(loaded.value.goalId).toBe(replacement.value.goalId);
      expect(loaded.value.objective).toBe('Fresh Goal after deletion');
    }, 15_000);

    it('rejects a stale replacement after deletion while allowing a fresh unversioned create', () => {
      const sessionId = 'sess-cas-delete-stale-replacement';
      const created = createGoal(project, sessionId, 'Goal before deletion');
      if (!created.ok) throw new Error(created.message);
      expect(deleteGoal(project, sessionId, created.value.revision).ok).toBe(true);

      const staleReplacement = createGoal(
        project,
        sessionId,
        'Stale replacement must not resurrect',
        undefined,
        created.value.revision
      );
      expect(staleReplacement).toEqual(
        expect.objectContaining({ ok: false, error: 'revision_stale' })
      );
      expect(loadGoal(project, sessionId)).toEqual(
        expect.objectContaining({ ok: false, error: 'not_found' })
      );

      const fresh = createGoal(project, sessionId, 'Fresh create after deletion');
      expect(fresh.ok).toBe(true);
      if (!fresh.ok) throw new Error(fresh.message);
      expect(fresh.value.goalId).not.toBe(created.value.goalId);
      expect(loadGoal(project, sessionId)).toEqual(
        expect.objectContaining({
          ok: true,
          value: expect.objectContaining({
            goalId: fresh.value.goalId,
            objective: 'Fresh create after deletion',
          }),
        })
      );
    });

    it('does not let a stale coordinator replace resurrect a Goal cleared by another instance', () => {
      const sessionId = 'sess-coordinator-delete-stale-replacement';
      const current = new GoalCoordinator(project, sessionId);
      expect(current.create('Goal before coordinator clear')).toEqual({ ok: true });
      const deletedGoalId = current.goal!.goalId;
      const stale = new GoalCoordinator(project, sessionId);
      expect(stale.load()).toBe(true);

      expect(current.clear()).toBe(true);
      expect(stale.replace('Resurrected by stale coordinator')).toBe(false);
      expect(loadGoal(project, sessionId)).toEqual(
        expect.objectContaining({ ok: false, error: 'not_found' })
      );

      expect(current.create('Fresh coordinator create')).toEqual({ ok: true });
      expect(current.goal!.goalId).not.toBe(deletedGoalId);
      const restarted = new GoalCoordinator(project, sessionId);
      expect(restarted.load()).toBe(true);
      expect(restarted.goal).toMatchObject({
        goalId: current.goal!.goalId,
        objective: 'Fresh coordinator create',
        status: 'active',
      });
    });

    it('rejects nonzero CAS updates when both the sidecar and deletion fence are missing', () => {
      const sessionId = 'sess-cas-missing-nonzero';
      const created = createGoal(project, sessionId, 'Goal removed outside storage');
      if (!created.ok) throw new Error('create failed');
      rmSync(join(getProjectSessionsDir(project), `${sessionId}.goal.json`), { force: true });

      const stale = saveGoal(
        project,
        sessionId,
        { ...created.value, revision: 8, tokensUsed: 99 },
        7
      );

      expect(stale).toEqual(expect.objectContaining({ ok: false, error: 'revision_stale' }));
      expect(loadGoal(project, sessionId)).toEqual(
        expect.objectContaining({ ok: false, error: 'not_found' })
      );
    });

    it('allows an explicit revision-zero create only through createGoal', () => {
      const sessionId = 'sess-cas-missing-zero';
      const seed = v011Sidecar('goal-direct-save', sessionId, 'Direct CAS create');
      expect(saveGoal(project, sessionId, seed, 0)).toEqual(
        expect.objectContaining({ ok: false, error: 'revision_stale' })
      );

      const created = createGoal(project, sessionId, 'Canonical Goal create', undefined, 0);
      expect(created.ok).toBe(true);
      expect(loadGoal(project, sessionId)).toEqual(
        expect.objectContaining({ ok: true, value: expect.objectContaining({ revision: 0 }) })
      );
    });

    it('serializes competing cross-process writes so only one CAS succeeds', async () => {
      const sessionId = 'sess-cas-processes';
      const created = createGoal(project, sessionId, 'Cross-process CAS goal');
      if (!created.ok) throw new Error('create failed');

      const startPath = join(project, 'start-cas-children');
      const readyPaths = [join(project, 'child-a-ready'), join(project, 'child-b-ready')];
      const childSource = `
        const { existsSync, writeFileSync } = require('fs');
        const { join } = require('path');
        const { saveGoal } = require(join(process.cwd(), 'src/services/goal-storage.ts'));
        const [project, sessionId, readyPath, startPath, tokenValue, goalJson] = process.argv.slice(1);
        writeFileSync(readyPath, 'ready');
        const signal = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(startPath)) Atomics.wait(signal, 0, 0, 5);
        const goal = JSON.parse(Buffer.from(goalJson, 'base64').toString('utf8'));
        goal.tokensUsed = Number(tokenValue);
        goal.revision = 1;
        const result = saveGoal(project, sessionId, goal, 0);
        process.stdout.write(JSON.stringify(result));
      `;
      const encodedGoal = Buffer.from(JSON.stringify(created.value)).toString('base64');
      const children = readyPaths.map((readyPath, index) =>
        spawn(
          process.execPath,
          [
            '-r',
            'ts-node/register/transpile-only',
            '-e',
            childSource,
            '--',
            project,
            sessionId,
            readyPath,
            startPath,
            String((index + 1) * 100),
            encodedGoal,
          ],
          { cwd: join(__dirname, '..'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
        )
      );

      waitForFiles(readyPaths);
      writeFileSync(startPath, 'go');
      const childResults = await Promise.all(children.map(collectChild));

      expect(childResults.map(result => result.code)).toEqual([0, 0]);
      const storageResults = childResults.map(result => {
        try {
          return JSON.parse(result.output);
        } catch {
          throw new Error(`Invalid child output: ${result.output}`);
        }
      });
      expect(storageResults.filter(result => result.ok)).toHaveLength(1);
      expect(storageResults.filter(result => !result.ok).map(result => result.error)).toEqual([
        'revision_stale',
      ]);

      const loaded = loadGoal(project, sessionId);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) throw new Error(loaded.message);
      expect(loaded.value.revision).toBe(1);
      expect([100, 200]).toContain(loaded.value.tokensUsed);
      expect(existsSync(sidecarLockPath(project, sessionId))).toBe(false);
    }, 15_000);

    it('fails closed without overwriting while a live process owns the lock', () => {
      const sessionId = 'sess-cas-live-lock';
      const created = createGoal(project, sessionId, 'Live lock goal');
      if (!created.ok) throw new Error('create failed');
      const lockPath = sidecarLockPath(project, sessionId);
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(
        join(lockPath, 'owner.json'),
        JSON.stringify({ token: 'live-owner', pid: process.pid, createdAt: Date.now() })
      );

      const result = saveGoal(
        project,
        sessionId,
        { ...created.value, revision: 1, tokensUsed: 999 },
        0
      );
      expect(result).toEqual(expect.objectContaining({ ok: false, error: 'io_error' }));
      const loaded = loadGoal(project, sessionId);
      expect(loaded.ok && loaded.value.revision).toBe(0);
      expect(loaded.ok && loaded.value.tokensUsed).toBe(0);
      rmSync(lockPath, { recursive: true, force: true });
    }, 5_000);

    it('loads restart recovery fail-closed without waiting on a transient live lock', () => {
      const sessionId = 'sess-restart-live-lock';
      const created = createGoal(project, sessionId, 'Resume safely after a transient lock');
      if (!created.ok) throw new Error('create failed');
      const lockPath = sidecarLockPath(project, sessionId);
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(
        join(lockPath, 'owner.json'),
        JSON.stringify({ token: 'live-owner', pid: process.pid, createdAt: Date.now() })
      );

      const restarted = new GoalCoordinator(project, sessionId);
      const startedAt = Date.now();
      try {
        expect(restarted.load(true)).toBe(true);
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(restarted.goal).toMatchObject({
          status: 'paused',
          revision: created.value.revision,
          stopReason: { kind: 'runtime_error' },
        });
        expect(restarted.lastLoadIssue).toMatchObject({ code: 'io_error' });
      } finally {
        rmSync(lockPath, { recursive: true, force: true });
      }

      expect(restarted.resume()).toBe(true);
      expect(restarted.goal).toMatchObject({
        status: 'active',
        revision: created.value.revision + 1,
      });
      expect(loadGoal(project, sessionId)).toEqual(
        expect.objectContaining({
          ok: true,
          value: expect.objectContaining({
            status: 'active',
            revision: created.value.revision + 1,
          }),
        })
      );
    });

    it('recovers a stale lock left by a dead process and cleans up after the write', () => {
      const sessionId = 'sess-cas-stale-lock';
      const created = createGoal(project, sessionId, 'Stale lock goal');
      if (!created.ok) throw new Error('create failed');
      const lockPath = sidecarLockPath(project, sessionId);
      const ownerPath = join(lockPath, 'owner.json');
      const oldTime = new Date(Date.now() - 120_000);
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(
        ownerPath,
        JSON.stringify({ token: 'dead-owner', pid: 2_147_483_647, createdAt: oldTime.getTime() })
      );
      utimesSync(ownerPath, oldTime, oldTime);
      utimesSync(lockPath, oldTime, oldTime);

      const result = saveGoal(
        project,
        sessionId,
        { ...created.value, revision: 1, tokensUsed: 321 },
        0
      );
      expect(result.ok).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
      const loaded = loadGoal(project, sessionId);
      expect(loaded.ok && loaded.value.tokensUsed).toBe(321);
    });

    it('reports a committed save as successful when post-commit lock cleanup fails', () => {
      const sessionId = 'sess-cas-committed-cleanup-failure';
      const created = createGoal(project, sessionId, 'Committed save remains authoritative');
      if (!created.ok) throw new Error('create failed');
      const lockPath = sidecarLockPath(project, sessionId);
      const mutableFs = jest.requireActual<typeof import('fs')>('fs');
      const originalRmSync = mutableFs.rmSync;
      const cleanupWarning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const rmSpy = jest.spyOn(mutableFs, 'rmSync').mockImplementation((path, options) => {
        if (String(path) === lockPath) {
          const error = new Error('simulated lock cleanup denial') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return originalRmSync(path, options as never);
      });

      try {
        const updated = { ...created.value, revision: 1, tokensUsed: 444 };
        const saved = saveGoal(project, sessionId, updated, 0);

        expect(saved).toEqual({
          ok: true,
          value: undefined,
          warnings: [
            expect.objectContaining({
              code: 'lock_cleanup_failed',
              message: expect.stringContaining('simulated lock cleanup denial'),
            }),
          ],
        });
        expect(cleanupWarning).toHaveBeenCalledWith(
          expect.stringContaining('Failed to release Goal sidecar lock')
        );
        expect(loadGoal(project, sessionId)).toEqual(
          expect.objectContaining({
            ok: true,
            value: expect.objectContaining({ revision: 1, tokensUsed: 444 }),
          })
        );
        expect(existsSync(lockPath)).toBe(true);
      } finally {
        rmSpy.mockRestore();
        cleanupWarning.mockRestore();
        originalRmSync(lockPath, { recursive: true, force: true });
      }
    });

    it('keeps coordinator finalize memory and disk aligned after committed lock cleanup failure', () => {
      const sessionId = 'sess-finalize-committed-cleanup-failure';
      const coordinator = new GoalCoordinator(project, sessionId);
      expect(coordinator.create('Finalize remains committed')).toEqual({ ok: true });
      const before = coordinator.goal!;
      const lockPath = sidecarLockPath(project, sessionId);
      const mutableFs = jest.requireActual<typeof import('fs')>('fs');
      const originalRmSync = mutableFs.rmSync;
      const cleanupWarning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const rmSpy = jest.spyOn(mutableFs, 'rmSync').mockImplementation((path, options) => {
        if (String(path) === lockPath) {
          const error = new Error(
            'simulated finalize lock cleanup denial'
          ) as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return originalRmSync(path, options as never);
      });

      try {
        expect(() =>
          coordinator.finalizeTurn({
            sessionId,
            turnId: 'turn:committed-cleanup-failure',
            goalId: before.goalId,
            goalRevision: before.revision,
            goalGeneration: coordinator.generation,
            startedAt: 1_000,
            endedAt: 1_100,
            finishReason: 'completed',
            usage: {
              promptTokens: 5,
              completionTokens: 7,
              subagentTokens: 0,
              totalTokens: 12,
            },
            usageComplete: true,
            madeProgress: false,
          })
        ).not.toThrow();

        expect(coordinator.goal).toMatchObject({
          revision: before.revision + 1,
          tokensUsed: 12,
          continuationCount: 1,
        });
        const disk = loadGoal(project, sessionId);
        expect(disk).toEqual(
          expect.objectContaining({
            ok: true,
            value: expect.objectContaining({
              revision: before.revision + 1,
              tokensUsed: 12,
              continuationCount: 1,
            }),
          })
        );
        expect(cleanupWarning).toHaveBeenCalledWith(
          expect.stringContaining('Failed to release Goal sidecar lock')
        );
      } finally {
        rmSpy.mockRestore();
        cleanupWarning.mockRestore();
        originalRmSync(lockPath, { recursive: true, force: true });
      }

      const restarted = new GoalCoordinator(project, sessionId);
      expect(restarted.load()).toBe(true);
      expect(restarted.goal).toEqual(coordinator.goal);
    });
  });

  describe('corrupt sidecar quarantine', () => {
    it.each([
      {
        label: 'a string revision',
        sessionId: 'sess-invalid-revision',
        payload: {
          ...v011Sidecar('g-invalid-revision', 'sess-invalid-revision', 'Invalid revision'),
          revision: 'broken',
        },
      },
      {
        label: 'an unknown status',
        sessionId: 'sess-invalid-status',
        payload: {
          ...v011Sidecar('g-invalid-status', 'sess-invalid-status', 'Invalid status'),
          status: 'running_forever',
        },
      },
      {
        label: 'string token usage',
        sessionId: 'sess-invalid-tokens',
        payload: {
          ...v011Sidecar('g-invalid-tokens', 'sess-invalid-tokens', 'Invalid tokens'),
          tokensUsed: '100',
        },
      },
      ...[
        { field: 'tokenBudget', value: Number.MAX_SAFE_INTEGER + 1 },
        { field: 'timeUsedMs', value: Number.MAX_SAFE_INTEGER + 1 },
        { field: 'createdAt', value: 1.5 },
        { field: 'activeSince', value: Number.MAX_SAFE_INTEGER + 1 },
        { field: 'continuationCount', value: Number.MAX_SAFE_INTEGER + 1 },
      ].map(({ field, value }) => {
        const sessionId = `sess-invalid-safe-integer-${field}`;
        return {
          label: `an unsafe time or count field ${field}`,
          sessionId,
          payload: {
            ...v011Sidecar(
              `g-invalid-safe-integer-${field}`,
              sessionId,
              `Invalid safe integer ${field}`
            ),
            [field]: value,
          },
        };
      }),
      {
        label: 'a malformed additive contract',
        sessionId: 'sess-invalid-contract',
        payload: {
          ...v011Sidecar('g-invalid-contract', 'sess-invalid-contract', 'Invalid contract'),
          contract: { objectiveRevision: 'broken' },
        },
      },
      {
        label: 'duplicate contract constraint IDs',
        sessionId: 'sess-invalid-duplicate-constraint-ids',
        payload: {
          ...v011Sidecar(
            'g-invalid-duplicate-constraint-ids',
            'sess-invalid-duplicate-constraint-ids',
            'Duplicate constraint IDs'
          ),
          contract: {
            ...pendingContract('Duplicate constraint IDs'),
            constraints: [
              { id: 'constraint:duplicate', statement: 'First', source: 'user' },
              { id: 'constraint:duplicate', statement: 'Second', source: 'user' },
            ],
          },
        },
      },
      {
        label: 'duplicate contract success criterion IDs',
        sessionId: 'sess-invalid-duplicate-criterion-ids',
        payload: {
          ...v011Sidecar(
            'g-invalid-duplicate-criterion-ids',
            'sess-invalid-duplicate-criterion-ids',
            'Duplicate criterion IDs'
          ),
          contract: {
            ...pendingContract('Duplicate criterion IDs'),
            successCriteria: [
              pendingContract('Duplicate criterion IDs').successCriteria[0],
              {
                ...pendingContract('Duplicate criterion IDs').successCriteria[0],
                statement: 'Second criterion with the same ID',
              },
            ],
          },
        },
      },
      {
        label: 'duplicate contract plan step IDs',
        sessionId: 'sess-invalid-duplicate-plan-step-ids',
        payload: {
          ...v011Sidecar(
            'g-invalid-duplicate-plan-step-ids',
            'sess-invalid-duplicate-plan-step-ids',
            'Duplicate plan step IDs'
          ),
          contract: {
            ...pendingContract('Duplicate plan step IDs'),
            planSnapshot: {
              revision: 1,
              phase: 'execution',
              steps: [
                { id: 'plan:duplicate', description: 'First', done: false },
                { id: 'plan:duplicate', description: 'Second', done: false },
              ],
              updatedAt: 1_000,
            },
          },
        },
      },
      {
        label: 'a malformed additive evidence ledger',
        sessionId: 'sess-invalid-evidence',
        payload: {
          ...v011Sidecar('g-invalid-evidence', 'sess-invalid-evidence', 'Invalid evidence'),
          evidenceLedger: [{ id: 'evidence-invalid', redacted: 'yes' }],
        },
      },
      {
        label: 'an unaudited contract-bearing complete goal',
        sessionId: 'sess-invalid-unaudited-complete',
        payload: {
          ...v011Sidecar(
            'g-invalid-unaudited-complete',
            'sess-invalid-unaudited-complete',
            'Unaudited complete goal'
          ),
          status: 'complete',
          completedAt: 2_000,
          contract: {
            originalObjective: 'Unaudited complete goal',
            objectiveRevision: 0,
            constraints: [],
            successCriteria: [
              {
                id: 'criterion:primary',
                statement: 'Unaudited complete goal',
                source: 'user',
                status: 'pending',
                requiredEvidenceKinds: ['test'],
                evidenceRefs: [],
              },
            ],
          },
        },
      },
      {
        label: 'a contract-bearing active goal with completedAt',
        sessionId: 'sess-invalid-active-completed-at',
        payload: {
          ...v011Sidecar(
            'g-invalid-active-completed-at',
            'sess-invalid-active-completed-at',
            'Active cannot be completed'
          ),
          completedAt: 2_000,
          contract: pendingContract('Active cannot be completed'),
        },
      },
      {
        label: 'a contract-bearing paused goal with a passed completion audit',
        sessionId: 'sess-invalid-paused-passed-audit',
        payload: {
          ...v011Sidecar(
            'g-invalid-paused-passed-audit',
            'sess-invalid-paused-passed-audit',
            'Paused cannot carry passed audit'
          ),
          status: 'paused',
          contract: pendingContract('Paused cannot carry passed audit'),
          completionAudit: {
            requestedAt: 1_000,
            auditedAt: 2_000,
            passed: true,
            verificationSummary: 'forged pass',
            remainingRequirements: [],
            evidenceRefs: [],
          },
        },
      },
      {
        label: 'a contract-bearing paused goal with a final summary',
        sessionId: 'sess-invalid-paused-final-summary',
        payload: {
          ...v011Sidecar(
            'g-invalid-paused-final-summary',
            'sess-invalid-paused-final-summary',
            'Paused cannot carry final summary'
          ),
          status: 'paused',
          contract: pendingContract('Paused cannot carry final summary'),
          completionAudit: {
            requestedAt: 1_000,
            auditedAt: 2_000,
            passed: false,
            verificationSummary: 'not complete',
            remainingRequirements: [],
            evidenceRefs: [],
            finalSummary: {
              originalObjective: 'Paused cannot carry final summary',
              currentObjective: 'Paused cannot carry final summary',
              objectiveRevision: 0,
              completedAt: 2_000,
              verificationSummary: 'not complete',
              criterionResults: [],
              evidenceRefs: [],
              accounting: {
                tokensUsed: 0,
                timeUsedMs: 0,
                continuationCount: 0,
                usageComplete: true,
              },
              remainingRequirements: [],
              stopReason: 'completed',
            },
          },
        },
      },
      {
        label: 'a contract-bearing blocked goal without a blocker',
        sessionId: 'sess-invalid-blocked-without-blocker',
        payload: {
          ...v011Sidecar(
            'g-invalid-blocked-without-blocker',
            'sess-invalid-blocked-without-blocker',
            'Blocked requires evidence'
          ),
          status: 'blocked',
          contract: pendingContract('Blocked requires evidence'),
          stopReason: { kind: 'blocked', message: 'Waiting', at: 2_000 },
        },
      },
      {
        label: 'a contract-bearing blocked goal without a blocked stop reason',
        sessionId: 'sess-invalid-blocked-stop-reason',
        payload: {
          ...v011Sidecar(
            'g-invalid-blocked-stop-reason',
            'sess-invalid-blocked-stop-reason',
            'Blocked stop reason must match'
          ),
          status: 'blocked',
          contract: pendingContract('Blocked stop reason must match'),
          blocker: {
            category: 'external_state',
            fingerprint: 'registry:pending',
            firstSeenAt: 1_000,
            lastSeenAt: 2_000,
            consecutiveTurns: 3,
            summary: 'Registry is pending',
            retryable: false,
          },
          stopReason: { kind: 'user', message: 'Wrong stop reason', at: 2_000 },
        },
      },
      {
        label: 'a contract-bearing active goal with a budget-limit stop reason',
        sessionId: 'sess-invalid-active-stop-reason',
        payload: {
          ...v011Sidecar(
            'g-invalid-active-stop-reason',
            'sess-invalid-active-stop-reason',
            'Active cannot carry a stop reason'
          ),
          contract: pendingContract('Active cannot carry a stop reason'),
          stopReason: { kind: 'budget_limit', message: 'Budget reached', at: 2_000 },
        },
      },
      {
        label: 'an oversized recent no-progress history',
        sessionId: 'sess-invalid-no-progress-size',
        payload: {
          ...v011Sidecar(
            'g-invalid-no-progress-size',
            'sess-invalid-no-progress-size',
            'Invalid no-progress size'
          ),
          recentNoProgressTurns: Array.from({ length: 4 }, (_, index) =>
            noProgressTurn({ turnId: `turn:${index}` })
          ),
        },
      },
      {
        label: 'an oversized progress evidence key history',
        sessionId: 'sess-invalid-progress-evidence-size',
        payload: {
          ...v011Sidecar(
            'g-invalid-progress-evidence-size',
            'sess-invalid-progress-evidence-size',
            'Invalid progress evidence size'
          ),
          progressEvidenceKeys: Array.from({ length: 1001 }, () => 'a'.repeat(64)),
        },
      },
      {
        label: 'a malformed progress evidence key',
        sessionId: 'sess-invalid-progress-evidence-key',
        payload: {
          ...v011Sidecar(
            'g-invalid-progress-evidence-key',
            'sess-invalid-progress-evidence-key',
            'Invalid progress evidence key'
          ),
          progressEvidenceKeys: ['not-a-sha256'],
        },
      },
      ...[
        { field: 'turnId', value: '' },
        { field: 'endedAt', value: -1 },
        { field: 'finishReason', value: 42 },
        { field: 'passedEvidence', value: '1' },
        { field: 'failedEvidence', value: -1 },
        { field: 'inconclusiveEvidence', value: 1.5 },
        { field: 'planUpdateProposed', value: 'yes' },
        { field: 'blockerCategory', value: 'network' },
      ].map(({ field, value }) => {
        const sessionId = `sess-invalid-no-progress-${field}`;
        return {
          label: `an invalid recent no-progress ${field}`,
          sessionId,
          payload: {
            ...v011Sidecar(
              `g-invalid-no-progress-${field}`,
              sessionId,
              `Invalid no-progress ${field}`
            ),
            recentNoProgressTurns: [{ ...noProgressTurn(), [field]: value }],
          },
        };
      }),
    ])('quarantines a sidecar with $label', ({ sessionId, payload }) => {
      writeRawSidecar(project, sessionId, payload);

      const result = loadGoal(project, sessionId);

      expect(result).toEqual(expect.objectContaining({ ok: false, error: 'corrupt' }));
      expect(existsSync(join(getProjectSessionsDir(project), `${sessionId}.goal.json`))).toBe(
        false
      );
    });

    it.each([
      {
        label: 'a result that disagrees with its assertion',
        mutate: (record: ReturnType<typeof validExternalEvidence>) => ({
          ...record,
          result: 'failed',
        }),
      },
      {
        label: 'a non-external kind carrying an assertion',
        mutate: (record: ReturnType<typeof validExternalEvidence>) => ({
          ...record,
          kind: 'runtime',
        }),
      },
      {
        label: 'an assertion observed after capture',
        mutate: (record: ReturnType<typeof validExternalEvidence>) => ({
          ...record,
          externalAssertion: { ...record.externalAssertion, observedAt: record.capturedAt + 1 },
        }),
      },
      {
        label: 'an assertion with inconsistent provider and details',
        mutate: (record: ReturnType<typeof validExternalEvidence>) => ({
          ...record,
          externalAssertion: { ...record.externalAssertion, provider: 'git' },
        }),
      },
      {
        label: 'an assertion without structured details',
        mutate: (record: ReturnType<typeof validExternalEvidence>) => {
          const { details: _details, ...externalAssertion } = record.externalAssertion;
          return { ...record, externalAssertion };
        },
      },
    ])('quarantines a sidecar with $label', ({ label: _label, mutate }) => {
      const sessionId = `sess-invalid-assertion-${Math.random().toString(16).slice(2)}`;
      const goalId = `goal-${sessionId}`;
      writeRawSidecar(project, sessionId, {
        ...v011Sidecar(goalId, sessionId, 'Validate assertion envelope'),
        evidenceLedger: [mutate(validExternalEvidence(goalId))],
      });

      expect(loadGoal(project, sessionId)).toEqual(
        expect.objectContaining({ ok: false, error: 'corrupt' })
      );
    });

    it('round-trips a valid structured external assertion', () => {
      const sessionId = 'sess-valid-structured-assertion';
      const goalId = 'goal-valid-structured-assertion';
      writeRawSidecar(project, sessionId, {
        ...v011Sidecar(goalId, sessionId, 'Validate assertion envelope'),
        evidenceLedger: [validExternalEvidence(goalId)],
      });

      const loaded = loadGoal(project, sessionId);
      expect(loaded.ok).toBe(true);
      expect(loaded.ok && loaded.value.evidenceLedger?.[0].externalAssertion).toEqual(
        expect.objectContaining({
          provider: 'npm',
          details: expect.objectContaining({
            kind: 'npm',
            packageName: '@orion-agents/orion-code',
            version: '0.1.2',
          }),
        })
      );
    });

    it('quarantines a sidecar with invalid schema', () => {
      writeRawSidecar(project, 'sess-corrupt', { version: 1, notGoalId: true });

      const result = loadGoal(project, 'sess-corrupt');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('corrupt');
      }
      // Original sidecar quarantined (renamed with .corrupt- suffix).
      const dir = getProjectSessionsDir(project);
      expect(existsSync(join(dir, 'sess-corrupt.goal.json'))).toBe(false);
    });

    it('quarantines a sidecar with sessionId mismatch', () => {
      const mismatched = v011Sidecar('g-1', 'wrong-session', 'Mismatched');
      writeRawSidecar(project, 'sess-mismatch', mismatched);

      const result = loadGoal(project, 'sess-mismatch');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('metadata_mismatch');
      }
    });

    it('quarantines and classifies an unsupported sidecar schema separately', () => {
      writeRawSidecar(project, 'sess-incompatible', {
        ...v011Sidecar('g-incompatible', 'sess-incompatible', 'Future schema'),
        version: 2,
      });

      const result = loadGoal(project, 'sess-incompatible');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('incompatible_schema');
      }
      expect(existsSync(join(getProjectSessionsDir(project), 'sess-incompatible.goal.json'))).toBe(
        false
      );
    });

    it('quarantines a sidecar with empty objective', () => {
      const empty = { ...v011Sidecar('g-2', 'sess-empty', 'x'), objective: '  ' };
      writeRawSidecar(project, 'sess-empty', empty);

      const result = loadGoal(project, 'sess-empty');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('corrupt');
      }
    });

    it('returns io_error without quarantining when the sidecar cannot be read', () => {
      const sessionId = 'sess-read-io-error';
      const path = join(getProjectSessionsDir(project), `${sessionId}.goal.json`);
      mkdirSync(getProjectSessionsDir(project), { recursive: true });
      mkdirSync(path);

      const result = loadGoal(project, sessionId);

      expect(result).toEqual(expect.objectContaining({ ok: false, error: 'io_error' }));
      expect(existsSync(path)).toBe(true);
    });
  });

  describe('delete', () => {
    it('deleteGoal removes the sidecar', () => {
      createGoal(project, 'sess-del', 'Delete me');
      expect(loadGoal(project, 'sess-del').ok).toBe(true);

      deleteGoal(project, 'sess-del');
      expect(loadGoal(project, 'sess-del').ok).toBe(false);
    });

    it('deleteGoal is idempotent on a missing sidecar', () => {
      const result = deleteGoal(project, 'never-existed');
      expect(result.ok).toBe(true);
    });
  });

  describe('not_found', () => {
    it('loadGoal on missing sidecar returns not_found (not corrupt)', () => {
      const result = loadGoal(project, 'missing');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('not_found');
      }
    });
  });
});
