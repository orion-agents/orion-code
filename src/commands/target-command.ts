/**
 * v0.2.24 — /target command handler.
 *
 * Parses /target (and /goal alias) syntax, validates input, and returns
 * structured GoalControlInput for AgentRuntimeController to process.
 */

import type { GoalControlInput } from '../runtime/goals/types';
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
  if (
    input === '/target' ||
    input === '/goal' ||
    input === '/target status' ||
    input === '/goal status'
  ) {
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

  if (rest.startsWith('confirm ')) {
    const criterionId = rest.slice(8).trim();
    if (!criterionId || /\s/u.test(criterionId)) {
      return { ok: false, error: 'Usage: /target confirm <criterion-id>' };
    }
    return {
      ok: true,
      input: { type: 'goal_control', action: 'confirm', payload: { criterionId } },
    };
  }

  if (rest.startsWith('edit ')) {
    const objective = rest.slice(5).trim();
    if (!objective) return { ok: false, error: 'Objective cannot be empty.' };
    if (objective.length > GOAL_INVARIANTS.maxObjectiveChars) {
      return {
        ok: false,
        error: `Objective too long (${objective.length} chars, max ${GOAL_INVARIANTS.maxObjectiveChars}). Use /target --file <path> for long objectives.`,
      };
    }
    return { ok: true, input: { type: 'goal_control', action: 'edit', payload: { objective } } };
  }

  if (rest.startsWith('replace ')) {
    const objective = rest.slice(8).trim();
    if (!objective) return { ok: false, error: 'Objective cannot be empty.' };
    if (objective.length > GOAL_INVARIANTS.maxObjectiveChars) {
      return {
        ok: false,
        error: `Objective too long (${objective.length} chars, max ${GOAL_INVARIANTS.maxObjectiveChars}).`,
      };
    }
    return { ok: true, input: { type: 'goal_control', action: 'replace', payload: { objective } } };
  }

  if (rest.startsWith('budget ')) {
    const budgetArg = rest.slice(7).trim();
    if (budgetArg === 'off') {
      return {
        ok: true,
        input: { type: 'goal_control', action: 'set_budget', payload: { tokenBudget: null } },
      };
    }
    const budget = Number(budgetArg);
    if (!Number.isInteger(budget) || budget < GOAL_INVARIANTS.tokenBudgetMin) {
      return {
        ok: false,
        error: `Token budget must be a positive integer (minimum ${GOAL_INVARIANTS.tokenBudgetMin}).`,
      };
    }
    return {
      ok: true,
      input: { type: 'goal_control', action: 'set_budget', payload: { tokenBudget: budget } },
    };
  }

  if (rest === 'clear' || rest === 'clear --yes') {
    const confirmed = rest === 'clear --yes';
    return { ok: true, input: { type: 'goal_control', action: 'clear', payload: { confirmed } } };
  }

  // Reserved sub-commands must never fall through to `create`.
  //
  // Every branch above requires a trailing space, so a forgotten argument
  // (`/target confirm`) used to be parsed as "create a goal whose objective is
  // the word confirm" — and AgentRuntimeController then immediately issued a
  // real, billed `submitGoalContinuation` call the user never asked for. With
  // an active goal it instead produced the unrelated "An active goal already
  // exists" error.
  const RESERVED_SUBCOMMAND_USAGE: Record<string, string> = {
    confirm: `${cmdPrefix} confirm <criterion-id>`,
    edit: `${cmdPrefix} edit <objective>`,
    replace: `${cmdPrefix} replace <objective>`,
    budget: `${cmdPrefix} budget <tokens>|off`,
  };
  const bareSubcommandUsage = RESERVED_SUBCOMMAND_USAGE[rest.toLowerCase()];
  if (bareSubcommandUsage) {
    return { ok: false, error: `Usage: ${bareSubcommandUsage}` };
  }

  // `/target clear -y` / `--force`: a mistyped flag, not an objective. Only
  // flag-looking arguments are rejected so a natural-language objective such
  // as "clear the build cache" still creates a goal.
  if (/^clear\s+-/u.test(rest)) {
    return { ok: false, error: `Usage: ${cmdPrefix} clear [--yes]` };
  }

  // Default: treat as create with objective
  if (rest.length > GOAL_INVARIANTS.maxObjectiveChars) {
    return {
      ok: false,
      error: `Objective too long (${rest.length} chars, max ${GOAL_INVARIANTS.maxObjectiveChars}). Use /target --file <path> for long objectives.`,
    };
  }
  return {
    ok: true,
    input: { type: 'goal_control', action: 'create', payload: { objective: rest } },
  };
}

/**
 * Determine if a raw input string looks like a target command.
 * Used by the command router to intercept /target and /goal.
 */
export function isTargetCommand(input: string): boolean {
  const trimmed = input.trimStart();
  return /^\/(?:target|goal)(?:\s|$)/.test(trimmed);
}
