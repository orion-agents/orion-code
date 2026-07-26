/**
 * v0.2.24 Phase 0 — Goal state machine tests.
 */

import {
  goalTransition,
  GOAL_INVARIANTS,
  type GoalStatus,
} from '../src/runtime/goals/types';

describe('Goal state machine transitions', () => {
  describe('creation', () => {
    it('allows create when no goal exists', () => {
      expect(goalTransition(null, 'create')).toBe('active');
    });

    it('rejects create when goal already exists', () => {
      expect(goalTransition('active', 'create')).toBeNull();
      expect(goalTransition('paused', 'create')).toBeNull();
    });

    it('clear removes goal entirely', () => {
      expect(goalTransition('active', 'clear')).toBeNull();
      expect(goalTransition('paused', 'clear')).toBeNull();
      expect(goalTransition('complete', 'clear')).toBeNull();
    });
  });

  describe('active -> terminal', () => {
    it('active can be paused', () => {
      expect(goalTransition('active', 'pause')).toBe('paused');
    });

    it('active can be completed', () => {
      expect(goalTransition('active', 'complete')).toBe('complete');
    });

    it('active can be blocked', () => {
      expect(goalTransition('active', 'block')).toBe('blocked');
    });

    it('active can hit usage limit', () => {
      expect(goalTransition('active', 'usage_limit')).toBe('usage_limited');
    });

    it('active can hit budget limit', () => {
      expect(goalTransition('active', 'budget_limit')).toBe('budget_limited');
    });
  });

  describe('recovery', () => {
    it('paused can be resumed', () => {
      expect(goalTransition('paused', 'resume')).toBe('active');
    });

    it('blocked can be resumed', () => {
      expect(goalTransition('blocked', 'resume')).toBe('active');
    });

    it('usage_limited can be resumed', () => {
      expect(goalTransition('usage_limited', 'resume')).toBe('active');
    });

    it('budget_limited can be resumed', () => {
      expect(goalTransition('budget_limited', 'resume')).toBe('active');
    });
  });

  describe('terminal states are terminal', () => {
    it('complete cannot transition to any other state', () => {
      expect(goalTransition('complete', 'pause')).toBeNull();
      expect(goalTransition('complete', 'resume')).toBeNull();
      expect(goalTransition('complete', 'block')).toBeNull();
    });

    it('complete can be replaced', () => {
      expect(goalTransition('complete', 'replace')).toBe('active');
    });
  });

  describe('replace and clear are always allowed', () => {
    const states: (GoalStatus | null)[] = [null, 'active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'complete'];

    it('replace works from any state', () => {
      for (const s of states) {
        expect(goalTransition(s, 'replace')).toBe('active');
      }
    });

    it('clear works from any state', () => {
      for (const s of states) {
        expect(goalTransition(s, 'clear')).toBeNull();
      }
    });
  });

  describe('null state only accepts create, replace, clear', () => {
    it('null cannot pause, resume, complete, block', () => {
      expect(goalTransition(null, 'pause')).toBeNull();
      expect(goalTransition(null, 'resume')).toBeNull();
      expect(goalTransition(null, 'complete')).toBeNull();
      expect(goalTransition(null, 'block')).toBeNull();
    });
  });
});

describe('Goal invariants', () => {
  it('max objective is 4000 characters', () => {
    expect(GOAL_INVARIANTS.maxObjectiveChars).toBe(4000);
  });

  it('max consecutive blocker turns is 3', () => {
    expect(GOAL_INVARIANTS.maxConsecutiveBlockerTurns).toBe(3);
  });

  it('max consecutive no-progress turns is 3', () => {
    expect(GOAL_INVARIANTS.maxConsecutiveNoProgressTurns).toBe(3);
  });

  it('token budget min is 1', () => {
    expect(GOAL_INVARIANTS.tokenBudgetMin).toBe(1);
  });
});