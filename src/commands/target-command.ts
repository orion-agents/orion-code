import type { GoalRuntimeControlV2 } from '../runtime/goal-runtime-coordinator';

const MAX_GOAL_OBJECTIVE_CHARS = 4_000;

export type TargetGoalControlInputV2 = { readonly type: 'goal_control' } & GoalRuntimeControlV2;

export type TargetParseResult =
  | { readonly ok: true; readonly input: TargetGoalControlInputV2 }
  | { readonly ok: false; readonly error: string };

/** Parse the v0.2 Goal surface. `/target` and legacy mutations are breaking-cut removed. */
export function parseTargetCommand(rawInput: string): TargetParseResult {
  const input = rawInput.trim();
  if (!/^\/goal(?:\s|$)/u.test(input)) {
    return { ok: false, error: 'Usage: /goal [objective|status|pause|resume|clear]' };
  }
  const rest = input.slice('/goal'.length).trim();
  if (!rest || rest === 'status') {
    return { ok: true, input: { type: 'goal_control', action: 'status' } };
  }
  if (rest === 'pause' || rest === 'resume' || rest === 'clear') {
    return { ok: true, input: { type: 'goal_control', action: rest } };
  }

  const removed = /^(?:exit|confirm|edit|replace|budget)(?:\s|$)|^clear\s+/u.test(rest);
  if (removed) {
    return {
      ok: false,
      error: 'Unsupported Goal command. Use /goal [objective], status, pause, resume, or clear.',
    };
  }
  if (rest.length > MAX_GOAL_OBJECTIVE_CHARS) {
    return {
      ok: false,
      error: `Objective too long (${rest.length} chars, max ${MAX_GOAL_OBJECTIVE_CHARS}).`,
    };
  }
  return { ok: true, input: { type: 'goal_control', action: 'create', objective: rest } };
}

export function isTargetCommand(input: string): boolean {
  return /^\/goal(?:\s|$)/u.test(input.trimStart());
}
