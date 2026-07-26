/**
 * v0.2.24 — /target command handler.
 *
 * Parses /target (and /goal alias) syntax, validates input, and returns
 * structured GoalControlInput for AgentRuntimeController to process.
 */

import type { GoalControlAction, GoalControlInput } from '../runtime/goals/types';
import { GOAL_INVARIANTS } from '../runtime/goals/types';

// ============================================================================
// Parse result
// ============================================================================

export type TargetParseResult =
  | { ok: true; input: GoalControlInput }
  | { ok: false; error: string };

// ============================================================================
// Parser
// ============================================================================

export function parseTargetCommand(rawInput: string): TargetParseResult {
  const input = rawInput.trim();

  // Bare /target or /target status
  if (input === '/target' || input === '/goal' || input === '/target status' || input === '/goal status') {
    return { ok: true, input: { type: 'goal_control', action: 'show' } };
  }

  // Extract command and rest
  const cmdPrefix = input.startsWith('/target') ? '/target' : '/goal';
  const rest = input.slice(cmdPrefix.length).trim();

  if (!rest) {
    return { ok: true, input: { type: 'goal_control', action: 'show' } };
  }

  // Sub-commands
  if (rest === 'pause') {
    return { ok: true, input: { type: 'goal_control', action: 'pause' } };
  }
  if (rest === 'resume') {
    return { ok: true, input: { type: 'goal_control', action: 'resume' } };
  }

  if (rest.startsWith('edit ')) {
    const objective = rest.slice(5).trim();
    if (!objective) return { ok: false, error: 'Objective cannot be empty.' };
    if (objective.length > GOAL_INVARIANTS.maxObjectiveChars) {
      return { ok: false, error: `Objective too long (${objective.length} chars, max ${GOAL_INVARIANTS.maxObjectiveChars}). Use /target --file <path> for long objectives.` };
    }
    return { ok: true, input: { type: 'goal_control', action: 'edit', payload: { objective } } };
  }

  if (rest.startsWith('replace ')) {
    const objective = rest.slice(8).trim();
    if (!objective) return { ok: false, error: 'Objective cannot be empty.' };
    if (objective.length > GOAL_INVARIANTS.maxObjectiveChars) {
      return { ok: false, error: `Objective too long (${objective.length} chars, max ${GOAL_INVARIANTS.maxObjectiveChars}).` };
    }
    return { ok: true, input: { type: 'goal_control', action: 'replace', payload: { objective } } };
  }

  if (rest.startsWith('budget ')) {
    const budgetArg = rest.slice(7).trim();
    if (budgetArg === 'off') {
      return { ok: true, input: { type: 'goal_control', action: 'set_budget', payload: { tokenBudget: null } } };
    }
    const budget = Number(budgetArg);
    if (!Number.isInteger(budget) || budget < GOAL_INVARIANTS.tokenBudgetMin) {
      return { ok: false, error: `Token budget must be a positive integer (minimum ${GOAL_INVARIANTS.tokenBudgetMin}).` };
    }
    return { ok: true, input: { type: 'goal_control', action: 'set_budget', payload: { tokenBudget: budget } } };
  }

  if (rest === 'clear' || rest === 'clear --yes') {
    const confirmed = rest === 'clear --yes';
    return { ok: true, input: { type: 'goal_control', action: 'clear', payload: { confirmed } } };
  }

  // Default: treat as create with objective
  if (rest.length > GOAL_INVARIANTS.maxObjectiveChars) {
    return { ok: false, error: `Objective too long (${rest.length} chars, max ${GOAL_INVARIANTS.maxObjectiveChars}). Use /target --file <path> for long objectives.` };
  }
  return { ok: true, input: { type: 'goal_control', action: 'create', payload: { objective: rest } } };
}

/**
 * Determine if a raw input string looks like a target command.
 * Used by the command router to intercept /target and /goal.
 */
export function isTargetCommand(input: string): boolean {
  const trimmed = input.trimStart();
  return trimmed.startsWith('/target') || trimmed.startsWith('/goal');
}