/**
 * v0.2.24 — Goal Prompt Fragment.
 *
 * Injects structured [Persistent Goal] context into the model prompt.
 * Continuation instructions are ephemeral and never enter user transcript.
 */

import type { SessionGoalV1 } from './types';

export interface GoalPromptFragment {
  /** The assembled text to inject into the system prompt. */
  text: string;
  /** Estimated token count for this fragment. */
  estimatedTokens: number;
}

export function buildGoalContextFragment(goal: SessionGoalV1 | null): GoalPromptFragment | null {
  if (!goal || goal.status !== 'active') return null;

  const lines = [
    '[Persistent Goal]',
    `Goal ID: ${goal.goalId.slice(0, 8)}`,
    `Status: ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Progress: continuation ${goal.continuationCount}, tokens ${formatTokens(goal.tokensUsed)}${goal.tokenBudget ? ` / budget ${formatTokens(goal.tokenBudget)}` : ' / no explicit budget'}`,
    '',
    'Rules:',
    '- Preserve the complete objective across turns.',
    '- Inspect current worktree and external state; they are authoritative.',
    '- Make concrete progress. A plan is not a substitute for execution.',
    '- Do not mark complete until every requirement is verified.',
    '- Do not mark blocked unless the same blocker persisted for 3 consecutive goal turns.',
    '- User corrections refine the work but do not replace the objective unless /target edit/replace occurs.',
  ];

  const text = lines.join('\n');
  // Rough estimate: ~1.3 tokens per word for English text.
  const estimatedTokens = Math.ceil(text.split(/\s+/).length * 1.3);

  return { text, estimatedTokens };
}

export function buildContinuationInstruction(): string {
  return [
    'Continue pursuing the persistent goal.',
    'Re-check the current worktree and external state before acting.',
    'Review completed and remaining requirements against evidence.',
    'Make concrete progress in this turn.',
    'If fully verified, request goal completion.',
    'If the same blocker has persisted for three consecutive goal turns, request blocked status.',
    'Otherwise continue working and leave the goal active.',
  ].join('\n');
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}