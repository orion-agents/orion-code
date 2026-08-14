/** Lifecycle action requested as the final clause of a persistent Goal objective. */
export type GoalCompletionAction = 'exit_goal';

export interface NormalizedGoalObjective {
  /** Verbatim, whitespace-normalized user objective retained for audit. */
  originalObjective: string;
  /** Executable and verifiable part of the objective. */
  objective: string;
  /** Explicit lifecycle request that must run only after completion passes. */
  completionAction?: GoalCompletionAction;
}

const GOAL_EXIT_ACTION = String.raw`(?:(?:automatically|auto)\s+)?(?:exit|leave|quit|end|stop)\s+(?:the\s+)?(?:(?:current|active)\s+)?(?:goal|target|objective)(?:\s+mode)?`;
const CHINESE_GOAL_EXIT_ACTION = String.raw`(?:自动\s*)?(?:退出|离开|结束|终止)\s*(?:这个|当前|该|本)?\s*(?:goal|target|目标)\s*(?:模式)?`;
const CHINESE_IMPLICIT_EXIT_ACTION = String.raw`(?:自动\s*)?(?:退出|离开|结束|终止)`;

const TRAILING_GOAL_EXIT_PATTERNS = [
  new RegExp(
    String.raw`(?:\s*[,;，；]\s*(?:(?:and(?:\s+then)?|then|afterwards?|when\s+(?:done|complete)|once\s+complete)\s+)?|\s+(?:and(?:\s+then)?|then|afterwards?|when\s+(?:done|complete)|once\s+complete)\s+)${GOAL_EXIT_ACTION}[.!。！]*$`,
    'iu'
  ),
  new RegExp(
    String.raw`(?:\s*后?\s*[,;，；]\s*(?:(?:并(?:且)?|然后|随后|最后|之后|完成后|任务完成后|目标完成后|执行完成后)\s*)?|\s*(?:并(?:且)?|后|然后|随后|最后|完成后|任务完成后|目标完成后|执行完成后)\s*)${CHINESE_GOAL_EXIT_ACTION}[.!。！]*$`,
    'iu'
  ),
];

const GOAL_EXIT_ONLY_PATTERNS = [
  new RegExp(String.raw`^(?:please\s+)?${GOAL_EXIT_ACTION}[.!]*$`, 'iu'),
  new RegExp(String.raw`^(?:请\s*)?${CHINESE_GOAL_EXIT_ACTION}[。！!]*$`, 'iu'),
];

const TRAILING_IMPLICIT_GOAL_EXIT_PATTERN = new RegExp(
  String.raw`(?:\s*[,;，；]\s*(?:并(?:且)?|然后|随后|最后|之后|完成后|任务完成后|目标完成后|执行完成后)\s*|\s+(?:并(?:且)?|然后|随后|最后|之后|完成后|任务完成后|目标完成后|执行完成后)\s*)${CHINESE_IMPLICIT_EXIT_ACTION}[.!。！]*$`,
  'iu'
);

const GOAL_MODE_CONTEXT = /(?:goal|target)(?:\s+mode)?|目标\s*模式/iu;

function compactObjective(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * Split a trailing "then exit Goal mode" lifecycle clause from the work that
 * can be audited. An exit phrase used as a subject (for example, "fix the exit
 * goal mode button") is intentionally left untouched because it is not a
 * standalone trailing instruction.
 */
export function normalizeGoalObjective(value: string): NormalizedGoalObjective {
  const originalObjective = compactObjective(value);
  if (!originalObjective) return { originalObjective, objective: '' };

  if (GOAL_EXIT_ONLY_PATTERNS.some(pattern => pattern.test(originalObjective))) {
    return { originalObjective, objective: '', completionAction: 'exit_goal' };
  }

  for (const pattern of TRAILING_GOAL_EXIT_PATTERNS) {
    const match = pattern.exec(originalObjective);
    if (!match || match.index <= 0) continue;
    const objective = originalObjective
      .slice(0, match.index)
      .replace(/[\s,;，；]+$/gu, '')
      .trim();
    if (objective) return { originalObjective, objective, completionAction: 'exit_goal' };
  }

  // Chinese commonly omits the object in a trailing lifecycle clause:
  // “测试一下目标模式，然后退出”. Treat that ellipsis as Goal exit only when
  // the executable prefix explicitly establishes Goal/Target mode context;
  // an unrelated “完成任务，然后退出” remains untouched.
  const implicitExit = TRAILING_IMPLICIT_GOAL_EXIT_PATTERN.exec(originalObjective);
  if (implicitExit && implicitExit.index > 0) {
    const objective = originalObjective
      .slice(0, implicitExit.index)
      .replace(/[\s,;，；]+$/gu, '')
      .trim();
    if (objective && GOAL_MODE_CONTEXT.test(objective)) {
      return { originalObjective, objective, completionAction: 'exit_goal' };
    }
  }

  return { originalObjective, objective: originalObjective };
}
