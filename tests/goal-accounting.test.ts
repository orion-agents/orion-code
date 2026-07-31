/**
 * Phase 1 (P1-1) - Goal accounting tests.
 *
 * Validates: per-turn delta accumulation, budget preflight (before provider
 * call), and stop reason classification. The pure functions are tested here;
 * the controller wiring (per-turn delta vs session-lifetime, madeProgress)
 * lands in Phase 2/3.
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
    const start: GoalAccounting = { tokensUsed: 0, timeUsedMs: 0, continuationCount: 0, noProgressCount: 0 };
    const after1 = accumulateTurn(start, makeOutcome({ usage: { promptTokens: 100, completionTokens: 50, subagentTokens: 0, totalTokens: 150 } }));
    expect(after1.tokensUsed).toBe(150);
    expect(after1.continuationCount).toBe(1);

    const after2 = accumulateTurn(after1, makeOutcome({ usage: { promptTokens: 200, completionTokens: 100, subagentTokens: 0, totalTokens: 300 } }));
    // Sum of deltas, not session-lifetime totals.
    expect(after2.tokensUsed).toBe(450);
    expect(after2.continuationCount).toBe(2);
  });

  it('three known deltas produce the exact sum', () => {
    const start: GoalAccounting = { tokensUsed: 0, timeUsedMs: 0, continuationCount: 0, noProgressCount: 0 };
    const deltas = [150, 300, 50];
    let acc = start;
    for (const total of deltas) {
      acc = accumulateTurn(acc, makeOutcome({ usage: { promptTokens: 0, completionTokens: 0, subagentTokens: 0, totalTokens: total } }));
    }
    expect(acc.tokensUsed).toBe(500);
  });

  it('resets noProgressCount when the turn made progress', () => {
    let acc: GoalAccounting = { tokensUsed: 0, timeUsedMs: 0, continuationCount: 0, noProgressCount: 2 };
    acc = accumulateTurn(acc, makeOutcome({ madeProgress: true }));
    expect(acc.noProgressCount).toBe(0);
  });

  it('increments noProgressCount when the turn made no progress', () => {
    let acc: GoalAccounting = { tokensUsed: 0, timeUsedMs: 0, continuationCount: 0, noProgressCount: 1 };
    acc = accumulateTurn(acc, makeOutcome({ madeProgress: false }));
    expect(acc.noProgressCount).toBe(2);
  });

  it('accumulates time delta from startedAt/endedAt', () => {
    const start: GoalAccounting = { tokensUsed: 0, timeUsedMs: 0, continuationCount: 0, noProgressCount: 0 };
    const acc = accumulateTurn(start, makeOutcome({ startedAt: 1000, endedAt: 3500 }));
    expect(acc.timeUsedMs).toBe(2500);
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

  it('classifies auth as runtime_error with a precise recovery hint', () => {
    const r = classifyStopReason({ kind: 'auth', retryable: false });
    expect(r?.kind).toBe('runtime_error');
    expect(r?.message).toContain('authentication');
  });

  it('classifies network as runtime_error with connectivity hint', () => {
    const r = classifyStopReason({ kind: 'network', retryable: true });
    expect(r?.kind).toBe('runtime_error');
    expect(r?.message).toContain('Network');
  });

  it('classifies rate_limit as runtime_error', () => {
    const r = classifyStopReason({ kind: 'rate_limit', retryable: true });
    expect(r?.kind).toBe('runtime_error');
    expect(r?.message).toContain('rate-limited');
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
    const s = formatGoalUsage({ tokensUsed: 1500, timeUsedMs: 65000, continuationCount: 3, noProgressCount: 0 });
    expect(s).toContain('3 turns');
    expect(s).toContain('1.5K');
    expect(s).toContain('1m');
  });

  it('formats small token counts without K suffix', () => {
    const s = formatGoalUsage({ tokensUsed: 500, timeUsedMs: 500, continuationCount: 1, noProgressCount: 0 });
    expect(s).toContain('500');
    expect(s).not.toContain('K');
  });
});