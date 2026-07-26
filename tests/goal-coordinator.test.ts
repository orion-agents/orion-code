/**
 * v0.2.24 — GoalCoordinator unit tests.
 */

import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const testDir = mkdtempSync(join(tmpdir(), 'openhorse-goal-coordinator-'));
const sessionsDir = join(testDir, 'sessions');
mkdirSync(sessionsDir, { recursive: true });

jest.mock('../src/services/config-dir', () => {
  const actual = jest.requireActual('../src/services/config-dir');
  return {
    ...actual,
    getProjectSessionsDir: (_projectPath: string) => sessionsDir,
  };
});

import { GoalCoordinator } from '../src/runtime/goals/coordinator';

describe('GoalCoordinator', () => {
  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  let coordinator: GoalCoordinator;

  beforeEach(() => {
    coordinator = new GoalCoordinator('/test/project', `session-${randomUUID().slice(0, 8)}`);
  });

  describe('create', () => {
    it('creates a goal and sets it to active', () => {
      const result = coordinator.create('Run CI pipeline');
      expect(result.ok).toBe(true);
      expect(coordinator.goal).not.toBeNull();
      expect(coordinator.goal!.status).toBe('active');
      expect(coordinator.goal!.objective).toBe('Run CI pipeline');
    });

    it('rejects duplicate active goal', () => {
      coordinator.create('first');
      const result = coordinator.create('second');
      expect(result.ok).toBe(false);
    });

    it('rejects empty objective', () => {
      const result = coordinator.create('  ');
      expect(result.ok).toBe(false);
    });

    it('allows create after completed goal is replaced', () => {
      coordinator.create('first');
      coordinator.pause();
      coordinator.replace('second');
      expect(coordinator.goal!.objective).toBe('second');
    });
  });

  describe('pause and resume', () => {
    it('pauses active goal', () => {
      coordinator.create('test');
      expect(coordinator.pause()).toBe(true);
      expect(coordinator.goal!.status).toBe('paused');
    });

    it('resumes paused goal', () => {
      coordinator.create('test');
      coordinator.pause();
      expect(coordinator.resume()).toBe(true);
      expect(coordinator.goal!.status).toBe('active');
    });

    it('cannot pause non-active goal', () => {
      expect(coordinator.pause()).toBe(false);
    });

    it('cannot resume active goal', () => {
      coordinator.create('test');
      expect(coordinator.resume()).toBe(false);
    });
  });

  describe('edit and replace', () => {
    it('edits objective preserving goalId', () => {
      coordinator.create('original');
      const goalId = coordinator.goal!.goalId;
      coordinator.edit('updated objective');
      expect(coordinator.goal!.goalId).toBe(goalId);
      expect(coordinator.goal!.objective).toBe('updated objective');
    });

    it('replace generates new goalId', () => {
      coordinator.create('original');
      const oldId = coordinator.goal!.goalId;
      coordinator.replace('new goal');
      expect(coordinator.goal!.goalId).not.toBe(oldId);
    });
  });

  describe('budget', () => {
    it('sets token budget', () => {
      coordinator.create('test');
      coordinator.setBudget(50000);
      expect(coordinator.goal!.tokenBudget).toBe(50000);
    });

    it('clears token budget with null', () => {
      coordinator.create('test');
      coordinator.setBudget(10000);
      coordinator.setBudget(null);
      expect(coordinator.goal!.tokenBudget).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('removes goal', () => {
      coordinator.create('test');
      expect(coordinator.clear()).toBe(true);
      expect(coordinator.goal).toBeNull();
    });

    it('no-op when no goal exists', () => {
      expect(coordinator.clear()).toBe(false);
    });
  });

  describe('snapshot', () => {
    it('returns null when no goal', () => {
      expect(coordinator.snapshot()).toBeNull();
    });

    it('returns projection with objective and status', () => {
      coordinator.create('test');
      const snap = coordinator.snapshot();
      expect(snap).not.toBeNull();
      expect(snap!.objective).toBe('test');
      expect(snap!.status).toBe('active');
      expect(snap!.continuationCount).toBe(0);
    });
  });

  describe('finalizeTurn', () => {
    it('accumulates token usage', () => {
      coordinator.create('test');
      const outcome = {
        turnId: 'turn-1',
        sessionId: coordinator.goal!.sessionId,
        goalId: coordinator.goal!.goalId,
        goalRevision: coordinator.goal!.revision,
        startedAt: 1000,
        endedAt: 5000,
        finishReason: 'max_turns',
        usage: { promptTokens: 100, completionTokens: 50, subagentTokens: 0, totalTokens: 150 },
        madeProgress: true,
      };
      coordinator.finalizeTurn(outcome);
      expect(coordinator.goal!.tokensUsed).toBe(150);
      expect(coordinator.goal!.continuationCount).toBe(1);
    });

    it('ignores stale turn from different goal', () => {
      coordinator.create('test');
      const staleOutcome = {
        turnId: 'stale',
        sessionId: coordinator.goal!.sessionId,
        goalId: 'wrong-id',
        goalRevision: 999,
        startedAt: 0, endedAt: 1,
        finishReason: 'max_turns',
        usage: { promptTokens: 999, completionTokens: 999, subagentTokens: 0, totalTokens: 1998 },
        madeProgress: false,
      };
      coordinator.finalizeTurn(staleOutcome);
      expect(coordinator.goal!.tokensUsed).toBe(0);
    });

    it('auto-pauses after 3 consecutive no-progress turns', () => {
      coordinator.create('test');
      for (let i = 0; i < 3; i++) {
        coordinator.finalizeTurn({
          turnId: `turn-${i}`,
          sessionId: coordinator.goal!.sessionId,
          goalId: coordinator.goal!.goalId,
          goalRevision: coordinator.goal!.revision,
          startedAt: i * 1000, endedAt: i * 1000 + 1000,
          finishReason: 'max_turns',
          usage: { promptTokens: 10, completionTokens: 10, subagentTokens: 0, totalTokens: 20 },
          madeProgress: false,
        });
      }
      expect(coordinator.goal!.status).toBe('paused');
    });
  });

  describe('deferContinuation', () => {
    it('pauses goal and prevents continuation', () => {
      coordinator.create('test');
      coordinator.deferContinuation();
      expect(coordinator.goal!.status).toBe('paused');
      expect(coordinator.canContinue).toBe(false);
    });
  });
});