/**
 * v0.2.24 — Goal Accounting.
 *
 * Token and time ledger for goal-level usage tracking.
 * Deduplicates subagent usage, prevents double-counting across retries.
 */

import type { AgentTurnOutcome } from './types';

export interface GoalAccounting {
  tokensUsed: number;
  timeUsedMs: number;
  continuationCount: number;
  noProgressCount: number;
}

export function accumulateTurn(
  accounting: GoalAccounting,
  outcome: AgentTurnOutcome
): GoalAccounting {
  return {
    tokensUsed: accounting.tokensUsed + outcome.usage.totalTokens,
    timeUsedMs: accounting.timeUsedMs + (outcome.endedAt - outcome.startedAt),
    continuationCount: accounting.continuationCount + 1,
    noProgressCount: outcome.madeProgress ? 0 : accounting.noProgressCount + 1,
  };
}

export function isBudgetExceeded(tokensUsed: number, tokenBudget?: number): boolean {
  if (tokenBudget === undefined || tokenBudget <= 0) return false;
  return tokensUsed >= tokenBudget;
}

/**
 * v0.1.2 - Check budget BEFORE issuing the next provider request.
 *
 * `projectedDelta` is the estimated token cost of the next turn (e.g. the
 * previous turn's totalTokens, or 0 if unknown). Returns false when the
 * projected usage would meet or exceed the budget, so the runtime can stop
 * before the request rather than discovering the limit after.
 *
 * Returns true (budget available) when no budget is set.
 */
export function budgetPreflight(
  tokensUsed: number,
  tokenBudget: number | undefined,
  projectedDelta: number
): { available: boolean; remaining: number | undefined; reason?: string } {
  if (tokenBudget === undefined || tokenBudget <= 0) {
    return { available: true, remaining: undefined };
  }
  const remaining = tokenBudget - tokensUsed;
  if (remaining <= 0) {
    return {
      available: false,
      remaining: 0,
      reason: `Token budget exhausted: ${tokensUsed}/${tokenBudget}`,
    };
  }
  if (projectedDelta > 0 && remaining - projectedDelta <= 0) {
    return {
      available: false,
      remaining,
      reason: `Token budget would be exhausted: ${tokensUsed}+${projectedDelta} >= ${tokenBudget}`,
    };
  }
  return { available: true, remaining };
}

/**
 * v0.1.2 - Classify a provider/runtime error into a goal stop reason.
 *
 * Stop reasons are layered (usage/auth/network/rate-limit/budget/runtime) so
 * the user gets a precise recovery path instead of a generic "blocked".
 */
export function classifyStopReason(
  error:
    | {
        kind: 'usage_limit' | 'rate_limit' | 'provider_busy' | 'auth' | 'network' | 'unknown';
        retryable: boolean;
      }
    | undefined
): {
  kind: 'usage_limit' | 'rate_limit' | 'provider_busy' | 'auth' | 'network' | 'runtime_error';
  message: string;
} | null {
  if (!error) return null;
  switch (error.kind) {
    case 'usage_limit':
      return {
        kind: 'usage_limit',
        message: error.retryable
          ? 'Provider usage limit hit (retryable). Try again or switch provider.'
          : 'Provider usage limit hit (not retryable).',
      };
    case 'rate_limit':
      return { kind: 'rate_limit', message: 'Provider rate-limited the request. Wait and retry.' };
    case 'provider_busy':
      return { kind: 'provider_busy', message: 'Provider is busy. Wait and retry.' };
    case 'auth':
      return { kind: 'auth', message: 'Provider authentication failed. Check API key and config.' };
    case 'network':
      return {
        kind: 'network',
        message: 'Network error reaching provider. Check connectivity and base URL.',
      };
    case 'unknown':
    default:
      return {
        kind: 'runtime_error',
        message: error.retryable ? 'Runtime error (retryable).' : 'Runtime error.',
      };
  }
}

export function formatGoalUsage(accounting: GoalAccounting): string {
  const tokens =
    accounting.tokensUsed >= 1000
      ? `${(accounting.tokensUsed / 1000).toFixed(1)}K`
      : String(accounting.tokensUsed);
  const time = formatDuration(accounting.timeUsedMs);
  return `${accounting.continuationCount} turns · ${tokens} tokens · ${time}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
