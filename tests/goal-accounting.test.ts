/**
 * Phase 1 (P1-1) - Goal accounting tests.
 *
 * Validates: per-turn delta accumulation, budget preflight (before provider
 * call), and stop reason classification. Runtime and coordinator integration
 * are covered by the Goal runtime/evidence suites.
 */

import {
  accumulateTurn,
  isBudgetExceeded,
  budgetPreflight,
  classifyStopReason,
  formatGoalUsage,
  type GoalAccounting,
} from '../src/runtime/goals/accounting';
import type { AgentTurnOutcome } from '../src/runtime/goals/types';
import { GoalCoordinator } from '../src/runtime/goals/coordinator';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as goalStorage from '../src/services/goal-storage';

function makeOutcome(overrides: Partial<AgentTurnOutcome> = {}): AgentTurnOutcome {
  return {
    turnId: 'turn-1',
    sessionId: 'sess-1',
    startedAt: 1000,
    endedAt: 2000,
    finishReason: 'completed',
    usage: { promptTokens: 100, completionTokens: 50, subagentTokens: 0, totalTokens: 150 },
    madeProgress: true,
    ...overrides,
  };
}

describe('accumulateTurn (per-turn delta)', () => {
  it('accumulates token delta from each turn outcome', () => {
    const start: GoalAccounting = {
      tokensUsed: 0,
      timeUsedMs: 0,
      continuationCount: 0,
      noProgressCount: 0,
    };
    const after1 = accumulateTurn(
      start,
      makeOutcome({
        usage: { promptTokens: 100, completionTokens: 50, subagentTokens: 0, totalTokens: 150 },
      })
    );
    expect(after1.tokensUsed).toBe(150);
    expect(after1.continuationCount).toBe(1);

    const after2 = accumulateTurn(
      after1,
      makeOutcome({
        usage: { promptTokens: 200, completionTokens: 100, subagentTokens: 0, totalTokens: 300 },
      })
    );
    // Sum of deltas, not session-lifetime totals.
    expect(after2.tokensUsed).toBe(450);
    expect(after2.continuationCount).toBe(2);
  });

  it('three known deltas produce the exact sum', () => {
    const start: GoalAccounting = {
      tokensUsed: 0,
      timeUsedMs: 0,
      continuationCount: 0,
      noProgressCount: 0,
    };
    const deltas = [150, 300, 50];
    let acc = start;
    for (const total of deltas) {
      acc = accumulateTurn(
        acc,
        makeOutcome({
          usage: { promptTokens: 0, completionTokens: 0, subagentTokens: 0, totalTokens: total },
        })
      );
    }
    expect(acc.tokensUsed).toBe(500);
  });

  it('does not double-count subagent tokens already included in totalTokens', () => {
    const start: GoalAccounting = {
      tokensUsed: 0,
      timeUsedMs: 0,
      continuationCount: 0,
      noProgressCount: 0,
    };
    const acc = accumulateTurn(
      start,
      makeOutcome({
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          subagentTokens: 75,
          totalTokens: 225,
        },
      })
    );
    expect(acc.tokensUsed).toBe(225);
  });

  it('resets noProgressCount when the turn made progress', () => {
    let acc: GoalAccounting = {
      tokensUsed: 0,
      timeUsedMs: 0,
      continuationCount: 0,
      noProgressCount: 2,
    };
    acc = accumulateTurn(acc, makeOutcome({ madeProgress: true }));
    expect(acc.noProgressCount).toBe(0);
  });

  it('increments noProgressCount when the turn made no progress', () => {
    let acc: GoalAccounting = {
      tokensUsed: 0,
      timeUsedMs: 0,
      continuationCount: 0,
      noProgressCount: 1,
    };
    acc = accumulateTurn(acc, makeOutcome({ madeProgress: false }));
    expect(acc.noProgressCount).toBe(2);
  });

  it('accumulates time delta from startedAt/endedAt', () => {
    const start: GoalAccounting = {
      tokensUsed: 0,
      timeUsedMs: 0,
      continuationCount: 0,
      noProgressCount: 0,
    };
    const acc = accumulateTurn(start, makeOutcome({ startedAt: 1000, endedAt: 3500 }));
    expect(acc.timeUsedMs).toBe(2500);
  });
});

describe('GoalCoordinator.accountStaleTurn', () => {
  function withCoordinator(
    run: (coordinator: GoalCoordinator, projectPath: string) => void,
    tokenBudget?: number
  ): void {
    const projectPath = mkdtempSync(join(tmpdir(), 'orion-stale-accounting-'));
    try {
      const coordinator = new GoalCoordinator(projectPath, 'sess-1');
      expect(coordinator.create('Keep stale turn accounting honest')).toEqual({ ok: true });
      if (tokenBudget !== undefined) expect(coordinator.setBudget(tokenBudget)).toBe(true);
      const staleRevision = coordinator.goal!.revision;
      expect(coordinator.addConstraint('Use the revised instruction')).toBe(true);
      expect(coordinator.goal!.revision).toBeGreaterThan(staleRevision);
      run(coordinator, projectPath);
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  }

  it('accounts a stale turn once without applying its plan, evidence, terminal request, or no-progress', () => {
    withCoordinator(coordinator => {
      const current = coordinator.goal!;
      const staleRevision = current.revision - 1;
      const planBefore = current.contract?.planSnapshot;
      const evidenceBefore = current.evidenceLedger;
      const outcome = makeOutcome({
        goalId: current.goalId,
        goalRevision: staleRevision,
        goalGeneration: coordinator.generation,
        madeProgress: false,
        pendingPlanUpdate: {
          phase: 'stale-phase',
          steps: [{ description: 'must not apply', done: true }],
          nextAction: 'must not apply',
          derivedCriteria: [],
        },
        pendingTerminalRequest: {
          requestedStatus: 'complete',
          requestedAt: 1500,
          goalId: current.goalId,
          goalRevision: staleRevision,
          turnId: 'turn-1',
        },
      });

      expect(coordinator.accountStaleTurn(outcome)).toBe(true);
      expect(coordinator.accountStaleTurn(outcome)).toBe(false);

      expect(coordinator.goal).toMatchObject({
        status: 'active',
        tokensUsed: 150,
        timeUsedMs: 1000,
        continuationCount: 1,
        noProgressCount: 0,
      });
      expect(coordinator.goal?.completionAudit).toBeUndefined();
      expect(coordinator.goal?.contract?.planSnapshot).toEqual(planBefore);
      expect(coordinator.goal?.evidenceLedger).toEqual(evidenceBefore);
    });
  });

  it('retries stale accounting after persistence fails without double-counting a committed retry', () => {
    withCoordinator(coordinator => {
      const current = coordinator.goal!;
      const outcome = makeOutcome({
        turnId: 'turn-retry-after-persist-failure',
        goalId: current.goalId,
        goalRevision: current.revision - 1,
        goalGeneration: coordinator.generation,
      });
      const key = `${current.goalId}:${coordinator.generation}:${outcome.turnId}`;
      const saveSpy = jest.spyOn(goalStorage, 'saveGoal').mockImplementationOnce(() => {
        expect((coordinator as any).accountedStaleTurnKeys.has(key)).toBe(true);
        return {
          ok: false,
          error: 'io_error',
          message: 'simulated transient persistence failure',
        };
      });

      try {
        expect(() => coordinator.accountStaleTurn(outcome)).toThrow(
          'simulated transient persistence failure'
        );
        expect((coordinator as any).accountedStaleTurnKeys.has(key)).toBe(false);

        expect(coordinator.accountStaleTurn(outcome)).toBe(true);
        expect(coordinator.accountStaleTurn(outcome)).toBe(false);
        expect(coordinator.goal).toMatchObject({
          tokensUsed: 150,
          continuationCount: 1,
          lastTurn: { turnId: outcome.turnId },
        });
      } finally {
        saveSpy.mockRestore();
      }
    });
  });

  it('rejects stale accounting for the wrong session, goal, or generation', () => {
    withCoordinator(coordinator => {
      const current = coordinator.goal!;
      const base = makeOutcome({
        goalId: current.goalId,
        goalRevision: current.revision - 1,
        goalGeneration: coordinator.generation,
      });

      expect(coordinator.accountStaleTurn({ ...base, sessionId: 'wrong-session' })).toBe(false);
      expect(coordinator.accountStaleTurn({ ...base, goalId: 'wrong-goal' })).toBe(false);
      expect(
        coordinator.accountStaleTurn({
          ...base,
          goalGeneration: coordinator.generation + 1,
        })
      ).toBe(false);
      expect(coordinator.goal).toMatchObject({
        tokensUsed: 0,
        timeUsedMs: 0,
        continuationCount: 0,
        noProgressCount: 0,
      });
    });
  });

  it('moves the revised goal to budget_limited when stale usage reaches its budget', () => {
    withCoordinator(coordinator => {
      const current = coordinator.goal!;
      expect(
        coordinator.accountStaleTurn(
          makeOutcome({
            goalId: current.goalId,
            goalRevision: current.revision - 1,
            goalGeneration: coordinator.generation,
          })
        )
      ).toBe(true);
      expect(coordinator.goal).toMatchObject({
        status: 'budget_limited',
        tokensUsed: 150,
        continuationCount: 1,
        noProgressCount: 0,
      });
      expect(coordinator.canContinue).toBe(false);
    }, 100);
  });
});

describe('isBudgetExceeded', () => {
  it('returns false when no budget is set', () => {
    expect(isBudgetExceeded(999999, undefined)).toBe(false);
    expect(isBudgetExceeded(999999, 0)).toBe(false);
  });

  it('returns true when usage meets or exceeds budget', () => {
    expect(isBudgetExceeded(1000, 1000)).toBe(true);
    expect(isBudgetExceeded(1001, 1000)).toBe(true);
  });

  it('returns false when usage is below budget', () => {
    expect(isBudgetExceeded(999, 1000)).toBe(false);
  });
});

describe('budgetPreflight (before provider call)', () => {
  it('allows when no budget is set', () => {
    const r = budgetPreflight(500, undefined, 1000);
    expect(r.available).toBe(true);
    expect(r.remaining).toBeUndefined();
  });

  it('blocks when budget already exhausted', () => {
    const r = budgetPreflight(1000, 1000, 100);
    expect(r.available).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.reason).toContain('exhausted');
  });

  it('blocks when projected delta would exceed the remaining budget', () => {
    // 800 used of 1000, next turn projected at 300 -> would exceed.
    const r = budgetPreflight(800, 1000, 300);
    expect(r.available).toBe(false);
    expect(r.reason).toContain('would be exceeded');
  });

  it('allows when projected delta fits within remaining budget', () => {
    const r = budgetPreflight(800, 1000, 100);
    expect(r.available).toBe(true);
    expect(r.remaining).toBe(200);
  });

  it('allows when projectedDelta is 0 (unknown) but budget remains', () => {
    const r = budgetPreflight(500, 1000, 0);
    expect(r.available).toBe(true);
    expect(r.remaining).toBe(500);
  });
});

describe('classifyStopReason', () => {
  it('classifies usage_limit distinctly', () => {
    const r = classifyStopReason({ kind: 'usage_limit', retryable: false });
    expect(r?.kind).toBe('usage_limit');
    expect(r?.message).toContain('usage limit');
  });

  it('classifies auth distinctly with a precise recovery hint', () => {
    const r = classifyStopReason({ kind: 'auth', retryable: false });
    expect(r?.kind).toBe('auth');
    expect(r?.message).toContain('authentication');
  });

  it('classifies network distinctly with connectivity hint', () => {
    const r = classifyStopReason({ kind: 'network', retryable: true });
    expect(r?.kind).toBe('network');
    expect(r?.message).toContain('Network');
  });

  it('classifies rate_limit distinctly', () => {
    const r = classifyStopReason({ kind: 'rate_limit', retryable: true });
    expect(r?.kind).toBe('rate_limit');
    expect(r?.message).toContain('rate-limited');
  });

  it('classifies provider_busy distinctly', () => {
    const r = classifyStopReason({ kind: 'provider_busy', retryable: true });
    expect(r?.kind).toBe('provider_busy');
    expect(r?.message).toContain('busy');
  });

  it('returns null when there is no error', () => {
    expect(classifyStopReason(undefined)).toBeNull();
  });

  it('does not collapse all errors into a generic "blocked"', () => {
    // Each classification must produce a distinct, actionable message - not a
    // single "blocked" bucket.
    const usage = classifyStopReason({ kind: 'usage_limit', retryable: false })?.message;
    const auth = classifyStopReason({ kind: 'auth', retryable: false })?.message;
    const net = classifyStopReason({ kind: 'network', retryable: false })?.message;
    expect(new Set([usage, auth, net]).size).toBe(3);
  });
});

describe('formatGoalUsage', () => {
  it('formats tokens, turns, and time', () => {
    const s = formatGoalUsage({
      tokensUsed: 1500,
      timeUsedMs: 65000,
      continuationCount: 3,
      noProgressCount: 0,
    });
    expect(s).toContain('3 turns');
    expect(s).toContain('1.5K');
    expect(s).toContain('1m');
  });

  it('formats small token counts without K suffix', () => {
    const s = formatGoalUsage({
      tokensUsed: 500,
      timeUsedMs: 500,
      continuationCount: 1,
      noProgressCount: 0,
    });
    expect(s).toContain('500');
    expect(s).not.toContain('K');
  });
});
