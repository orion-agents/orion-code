/**
 * v0.2.24 — Goal sidecar unit tests.
 */

import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const testDir = mkdtempSync(join(tmpdir(), 'openhorse-goal-sidecar-'));
const sessionsDir = join(testDir, 'sessions');
mkdirSync(sessionsDir, { recursive: true });

jest.mock('../src/services/config-dir', () => {
  const actual = jest.requireActual('../src/services/config-dir');
  return {
    ...actual,
    getProjectSessionsDir: (_projectPath: string) => sessionsDir,
  };
});

import type { SessionGoalV1 } from '../src/runtime/goals/types';
import {
  loadGoal,
  saveGoal,
  deleteGoal,
  createGoal,
} from '../src/services/goal-storage';

const projectPath = '/test/project';
const sessionId = randomUUID();

function makeGoal(overrides: Partial<SessionGoalV1> = {}): SessionGoalV1 {
  return {
    version: 1,
    goalId: randomUUID(),
    sessionId,
    revision: 0,
    objective: 'test objective',
    status: 'active',
    tokensUsed: 0,
    timeUsedMs: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    continuationCount: 0,
    noProgressCount: 0,
    ...overrides,
  };
}

describe('Goal sidecar storage', () => {
  afterEach(() => {
    // Clean up test goal files.
    const files = [join(sessionsDir, `${sessionId}.goal.json`)];
    for (const f of files) {
      try { rmSync(f, { force: true }); } catch {}
    }
  });

  it('creates and loads a goal', () => {
    const result = createGoal(projectPath, sessionId, 'my objective');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.objective).toBe('my objective');
      expect(result.value.status).toBe('active');
    }

    const loaded = loadGoal(projectPath, sessionId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.objective).toBe('my objective');
    }
  });

  it('returns not_found when no goal exists', () => {
    const result = loadGoal(projectPath, 'nonexistent-session');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('not_found');
  });

  it('saves and reloads goal with CAS revision', () => {
    const goal = makeGoal({ revision: 5 });
    saveGoal(projectPath, sessionId, goal);
    const loaded = loadGoal(projectPath, sessionId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.revision).toBe(5);
  });

  it('deletes a goal', () => {
    createGoal(projectPath, sessionId, 'temp');
    expect(existsSync(join(sessionsDir, `${sessionId}.goal.json`))).toBe(true);

    deleteGoal(projectPath, sessionId);
    expect(existsSync(join(sessionsDir, `${sessionId}.goal.json`))).toBe(false);
  });

  it('returns corrupt for invalid JSON', () => {
    writeFileSync(join(sessionsDir, `${sessionId}.goal.json`), 'not valid json');
    const result = loadGoal(projectPath, sessionId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('corrupt');
  });

  it('returns corrupt for missing goalId', () => {
    const bad = makeGoal();
    delete (bad as any).goalId;
    saveGoal(projectPath, sessionId, bad);
    const result = loadGoal(projectPath, sessionId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('corrupt');
  });
});