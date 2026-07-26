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
  outcome: AgentTurnOutcome,
): GoalAccounting {
  return {
    tokensUsed: accounting.tokensUsed + outcome.usage.totalTokens,
    timeUsedMs: accounting.timeUsedMs + (outcome.endedAt - outcome.startedAt),
    continuationCount: accounting.continuationCount + 1,
    noProgressCount: outcome.madeProgress ? 0 : accounting.noProgressCount + 1,
  };
}

export function isBudgetExceeded(
  tokensUsed: number,
  tokenBudget?: number,
): boolean {
  if (tokenBudget === undefined || tokenBudget <= 0) return false;
  return tokensUsed >= tokenBudget;
}

export function formatGoalUsage(accounting: GoalAccounting): string {
  const tokens = accounting.tokensUsed >= 1000
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