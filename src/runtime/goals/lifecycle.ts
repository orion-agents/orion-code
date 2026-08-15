import { clearSessionGoalBinding, restoreSessionGoalBinding } from '../../services/session-storage';
import type { GoalCoordinator } from './coordinator';

export interface ClearedGoalLifecycle {
  goalId: string;
  objective: string;
}

function lifecycleError(message: string, cause?: unknown): Error {
  const error = new Error(message);
  if (cause !== undefined) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

/**
 * Remove an unfinished Goal without leaving session metadata and the Goal
 * sidecar disagreeing. The binding is conditionally cleared first; if the
 * sidecar delete fails, the disk-authoritative Goal is rebound before the
 * error escapes.
 */
export function clearGoalLifecycle(coord: GoalCoordinator): ClearedGoalLifecycle | null {
  const goal = coord.goal;
  if (!goal) return null;

  const session = clearSessionGoalBinding(coord.boundSessionId, goal.goalId);
  if (!session) {
    throw lifecycleError(
      `Session ${coord.boundSessionId} was not found; refusing to delete Goal ${goal.goalId} without clearing its binding.`
    );
  }

  try {
    if (!coord.clear()) {
      throw lifecycleError('Goal sidecar was no longer available during lifecycle cleanup.');
    }
  } catch (cause) {
    const diskGoal = coord.goal ?? goal;
    try {
      const restored = restoreSessionGoalBinding(
        coord.boundSessionId,
        diskGoal,
        session.updatedAt ?? 0
      );
      if (!restored) {
        throw lifecycleError(`Session ${coord.boundSessionId} disappeared during Goal rollback.`);
      }
    } catch (rollbackCause) {
      const rollbackMessage =
        rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause);
      throw lifecycleError(
        `Goal exit failed and its session binding could not be restored safely: ${rollbackMessage}`,
        cause
      );
    }
    throw lifecycleError(
      `Goal exit failed; the session binding was restored and the Goal remains available. ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      cause
    );
  }

  return { goalId: goal.goalId, objective: goal.objective };
}
