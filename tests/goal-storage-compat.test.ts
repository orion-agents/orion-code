/**
 * Phase 1 - Goal storage compatibility tests.
 *
 * Validates: v0.1.1 sidecar (no contract) loads cleanly, CAS revision
 * enforcement, corrupt sidecar quarantine, and additive contract persistence.
 */

import { tmpdir } from 'os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { loadGoal, saveGoal, createGoal, deleteGoal } from '../src/services/goal-storage';
import type { SessionGoalV1 } from '../src/runtime/goals/types';

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), 'orion-goal-storage-'));
}

/** Ensure the sessions dir exists, then write a raw sidecar (for v0.1.1 / corrupt fixtures). */
function writeRawSidecar(project: string, sessionId: string, payload: unknown): void {
  const { getProjectSessionsDir } = require('../src/services/config-dir');
  const dir = getProjectSessionsDir(project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.goal.json`), JSON.stringify(payload));
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

      const result = loadGoal(project, 'sess-1');
      expect(result.ok).toBe(true);
      expect(result.ok && result.value.objective).toBe('Legacy objective');
      // v0.1.1 sidecar has no contract; storage returns it as-is.
      expect(result.ok && result.value.contract).toBeUndefined();
    });

    it('createGoal persists a contract when provided', () => {
      const contract = {
        originalObjective: 'With contract',
        objectiveRevision: 0,
        constraints: [],
        successCriteria: [
          { id: 'criterion:primary', statement: 'With contract', source: 'derived' as const, status: 'pending' as const, requiredEvidenceKinds: ['test' as const], evidenceRefs: [] },
        ],
      };
      const result = createGoal(project, 'sess-2', 'With contract', contract);
      expect(result.ok).toBe(true);

      const loaded = loadGoal(project, 'sess-2');
      expect(loaded.ok && loaded.value.contract).toBeDefined();
      expect(loaded.ok && loaded.value.contract!.originalObjective).toBe('With contract');
    });

    it('createGoal works without a contract (backward-compatible callers)', () => {
      const result = createGoal(project, 'sess-3', 'No contract');
      expect(result.ok).toBe(true);
      const loaded = loadGoal(project, 'sess-3');
      expect(loaded.ok && loaded.value.objective).toBe('No contract');
      expect(loaded.ok && loaded.value.contract).toBeUndefined();
    });
  });

  describe('CAS revision enforcement', () => {
    it('saveGoal with correct expectedRevision succeeds', () => {
      const result = createGoal(project, 'sess-cas', 'CAS goal');
      if (!result.ok) throw new Error('create failed');
      const goal = result.value;
      const rev = goal.revision;

      const save = saveGoal(project, 'sess-cas', { ...goal, tokensUsed: 100, revision: rev + 1 }, rev);
      expect(save.ok).toBe(true);
    });

    it('saveGoal with stale expectedRevision fails closed', () => {
      const result = createGoal(project, 'sess-cas-stale', 'CAS stale goal');
      if (!result.ok) throw new Error('create failed');
      const goal = result.value;

      // First write bumps revision to 1.
      saveGoal(project, 'sess-cas-stale', { ...goal, tokensUsed: 100, revision: goal.revision + 1 }, goal.revision);

      // Second write with the OLD expectedRevision (0) must fail - no silent overwrite.
      const stale = saveGoal(project, 'sess-cas-stale', { ...goal, tokensUsed: 999, revision: 99 }, goal.revision);
      expect(stale.ok).toBe(false);
      if (!stale.ok) {
        expect(stale.error).toBe('revision_stale');
      }

      // The sidecar must NOT have been overwritten with the stale write.
      const loaded = loadGoal(project, 'sess-cas-stale');
      expect(loaded.ok && loaded.value.tokensUsed).toBe(100);
    });
  });

  describe('corrupt sidecar quarantine', () => {
    it('quarantines a sidecar with invalid schema', () => {
      writeRawSidecar(project, 'sess-corrupt', { version: 1, notGoalId: true });

      const result = loadGoal(project, 'sess-corrupt');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('corrupt');
      }
      // Original sidecar quarantined (renamed with .corrupt- suffix).
      const { getProjectSessionsDir } = require('../src/services/config-dir');
      const dir = getProjectSessionsDir(project);
      expect(existsSync(join(dir, 'sess-corrupt.goal.json'))).toBe(false);
    });

    it('quarantines a sidecar with sessionId mismatch', () => {
      const mismatched = v011Sidecar('g-1', 'wrong-session', 'Mismatched');
      writeRawSidecar(project, 'sess-mismatch', mismatched);

      const result = loadGoal(project, 'sess-mismatch');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('corrupt');
      }
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