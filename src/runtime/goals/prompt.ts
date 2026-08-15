/**
 * v0.2.24 — Goal Prompt Fragment.
 *
 * Injects structured [Persistent Goal] context into the model prompt.
 * Continuation instructions are ephemeral and never enter user transcript.
 */

import { GOAL_INVARIANTS, type SessionGoalV1 } from './types';

export interface GoalPromptFragment {
  /** The assembled text to inject into the system prompt. */
  text: string;
  /** Estimated token count for this fragment. */
  estimatedTokens: number;
}

export function buildGoalContextFragment(goal: SessionGoalV1 | null): GoalPromptFragment | null {
  if (!goal || goal.status !== 'active') return null;

  const contract = goal.contract;
  const plan = contract?.planSnapshot;
  const lines = [
    '[Persistent Goal]',
    `Goal ID: ${goal.goalId.slice(0, 8)}`,
    `Status: ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Progress: continuation ${goal.continuationCount}, tokens ${formatTokens(goal.tokensUsed)}${goal.tokenBudget ? ` / budget ${formatTokens(goal.tokenBudget)}` : ' / no explicit budget'}`,
  ];

  if (contract) {
    lines.push(
      `Contract: objective revision ${contract.objectiveRevision}; original: ${compactGoalLine(contract.originalObjective)}`
    );
    if (contract.completionAction === 'exit_goal') {
      lines.push(
        'Completion action: exit Goal mode automatically after the completion audit passes.'
      );
    }
    if (contract.constraints.length > 0) {
      lines.push('Constraints:');
      lines.push(
        ...contract.constraints
          .slice(0, 8)
          .map(item => `- [${item.source}] ${compactGoalLine(item.statement)}`)
      );
    }
    if (contract.successCriteria.length > 0) {
      lines.push('Success criteria:');
      lines.push(
        ...contract.successCriteria
          .slice(0, 12)
          .map(
            item =>
              `- ${item.id} [${item.status}/${item.source}] accepted evidence (any of)=${item.requiredEvidenceKinds.join(',')}: ${compactGoalLine(item.statement)}`
          )
      );
    }
  }

  if (plan) {
    lines.push(`Plan: revision ${plan.revision}; phase ${compactGoalLine(plan.phase)}`);
    lines.push(
      ...plan.steps
        .slice(0, 12)
        .map(step => `- [${step.done ? 'x' : ' '}] ${compactGoalLine(step.description)}`)
    );
    if (plan.nextAction) lines.push(`Next action: ${compactGoalLine(plan.nextAction)}`);
  }

  if (goal.completionAudit?.remainingRequirements.length) {
    lines.push('Audit remaining:');
    lines.push(
      ...goal.completionAudit.remainingRequirements
        .slice(0, 8)
        .map(item => `- ${compactGoalLine(item)}`)
    );
  }

  lines.push(
    `Blocked gate: same eligible blocker ${goal.blocker?.consecutiveTurns ?? 0}/${GOAL_INVARIANTS.maxConsecutiveBlockerTurns}; no-progress ${goal.noProgressCount}/${GOAL_INVARIANTS.maxConsecutiveNoProgressTurns}. Both must reach the threshold.`,
    `Autonomy gate: ${goal.automaticContinuationStreak ?? 0}/${GOAL_INVARIANTS.maxAutomaticContinuationTurns} consecutive automatic continuations; reaching the limit pauses for user review.`,
    '',
    'Rules:',
    '- Preserve the complete objective across turns.',
    '- Inspect current worktree and external state; they are authoritative.',
    '- Make concrete progress. A plan is not a substitute for execution.',
    '- Do not mark complete until every requirement is verified.',
    '- Before requesting completion, call get_goal and use only exact recentEvidence IDs returned by the runtime. Never invent or guess evidence IDs.',
    '- update_goal success records a request only. Do not tell the user the Goal is complete unless a later authoritative Goal snapshot has status=complete and a passed completion audit.',
    '- If update_goal rejects completion, the Goal remains active. Do not repeat the request without newly captured runtime evidence.',
    '- A completion action is runtime-owned. Do not call abandon_goal to satisfy it; complete the auditable objective and let Orion exit Goal mode after the audit passes.',
    '- Evidence kinds listed for a criterion are accepted alternatives, not a requirement to produce every kind.',
    '- Name verification for its criterion or include the exact criterion id so evidence can be matched safely.',
    `- Do not mark blocked unless the same eligible non-retryable blocker persisted for >= ${GOAL_INVARIANTS.maxConsecutiveBlockerTurns} consecutive Goal turns and no progress persisted for >= ${GOAL_INVARIANTS.maxConsecutiveNoProgressTurns} consecutive Goal turns.`,
    '- User corrections refine the work but do not replace the objective unless /target edit/replace occurs.'
  );
  if (/(?:goal|target)(?:\s+mode)?|目标\s*模式/iu.test(goal.objective)) {
    lines.push(
      '- For a Goal-mode lifecycle self-test, successful get_goal and update_goal_plan calls are runtime evidence. After they finish, call get_goal again in the same turn to read their exact IDs; echo/printf output is not verification evidence.'
    );
  }

  const text = lines.join('\n');
  // Rough estimate: ~1.3 tokens per word for English text.
  const estimatedTokens = Math.ceil(text.split(/\s+/).length * 1.3);

  return { text, estimatedTokens };
}

function compactGoalLine(value: string, maxLength: number = 240): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function buildContinuationInstruction(): string {
  return [
    'Continue pursuing the persistent goal.',
    'Re-check the current worktree and external state before acting.',
    'Review completed and remaining requirements against evidence.',
    'Make concrete progress in this turn.',
    'If fully verified, call get_goal, map exact recentEvidence IDs, and request goal completion once.',
    'A completion request is pending audit; never report the Goal complete from the request result alone.',
    `Only request blocked status when the same eligible non-retryable blocker persisted for >= ${GOAL_INVARIANTS.maxConsecutiveBlockerTurns} consecutive Goal turns and no progress persisted for >= ${GOAL_INVARIANTS.maxConsecutiveNoProgressTurns} consecutive Goal turns.`,
    'Otherwise continue working and leave the goal active.',
  ].join('\n');
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
