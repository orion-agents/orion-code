import { createStopDecision, type StopDecision } from '../../framework/stop-decision';
import type { SessionGoalV1 } from './types';

/**
 * Project a persisted Goal terminal/pause state into the shared stop contract.
 * The projection is intentionally computed rather than persisted so v1 sidecars
 * remain backwards compatible and storage validation keeps a single authority.
 */
export function goalStopDecision(goal: SessionGoalV1 | null): StopDecision | null {
  if (!goal || goal.status === 'active') return null;

  const kind = goal.stopReason?.kind;
  const message = goal.stopReason?.message ?? `Goal entered ${goal.status} state.`;
  const noProgress = /no progress/i.test(message);
  const completed = goal.status === 'complete';
  const cancelled = kind === 'user' && /interrupt|paused by user/i.test(message);
  const failed = kind === 'runtime_error' || ['auth', 'network'].includes(kind ?? '');
  const blocked = goal.status === 'blocked' || kind === 'blocked';
  const resourceLimited = goal.status === 'budget_limited' || kind === 'budget_limit';

  const status = completed
    ? 'completed'
    : blocked
      ? 'blocked'
      : cancelled
        ? 'cancelled'
        : failed
          ? 'failed'
          : 'stopped';
  const code = completed
    ? 'goal_completed'
    : noProgress
      ? 'no_progress'
      : blocked
        ? 'blocked'
        : resourceLimited
          ? 'token_budget'
          : (kind ?? goal.status);

  return createStopDecision({
    scope: 'goal',
    status,
    disposition: completed ? 'finish_scope' : 'pause_scope',
    reason: { code, message },
    evidence: [
      {
        kind: resourceLimited
          ? 'resource_limit'
          : failed || ['rate_limit', 'provider_busy', 'usage_limit'].includes(kind ?? '')
            ? 'provider'
            : 'runtime',
        source: 'goal-coordinator',
        detail: noProgress
          ? `${goal.noProgressCount} consecutive turns made no observable progress.`
          : message,
      },
    ],
    nextActions: completed
      ? [{ kind: 'inspect', label: 'Inspect the completion receipt.' }]
      : resourceLimited
        ? [
            { kind: 'raise_budget', label: 'Raise the Goal token budget.' },
            {
              kind: 'resume',
              label: 'Resume the Goal after changing the budget.',
              command: '/target resume',
            },
          ]
        : [
            { kind: 'inspect', label: 'Inspect the stop evidence.', command: '/target' },
            {
              kind: 'resume',
              label: 'Resume when the stopping condition is resolved.',
              command: '/target resume',
            },
          ],
    resources: {
      turns: { used: goal.continuationCount },
      tokens: { used: goal.tokensUsed, limit: goal.tokenBudget },
      elapsedMs: { used: goal.timeUsedMs },
    },
  });
}
