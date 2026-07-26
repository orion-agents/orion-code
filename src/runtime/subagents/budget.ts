/**
 * Subagent budget ledger: reserve before launch, reconcile after completion.
 *
 * The root turn owns an aggregate budget (model requests, tool calls,
 * model-visible bytes, wall-clock time). Children draw against it. To avoid
 * over-spending, the Supervisor reserves a per-task allowance up front and
 * releases the difference once the real usage is known.
 *
 * This ledger is the single source of truth for child aggregate usage; the
 * root loop reads it to fold child cost into `/cost` and loop stats.
 */

import type { SubtaskUsage } from './types';
import { EMPTY_SUBTASK_USAGE, sumSubtaskUsage } from './types';

export interface SubagentBudgetLimits {
  /** Total model requests allowed across all children in one root turn. */
  maxModelRequestsPerTurn: number;
  /** Per-child model request allowance. */
  maxModelRequestsPerTask: number;
  /** Per-child tool call allowance. */
  maxToolCallsPerTask: number;
  /** Per-child wall-clock timeout (ms). */
  timeoutMs: number;
}

export interface ReservedBudget {
  taskId: string;
  modelRequests: number;
}

export interface BudgetSnapshot {
  /** Requests reserved but not yet reconciled. */
  reservedModelRequests: number;
  /** Reconciled (actual observed) usage so far - never clamped to hide overage. */
  used: SubtaskUsage;
  /** Requests still available for new reservations. */
  availableModelRequests: number;
  /** Whether the aggregate limit has been exceeded by actual usage. */
  exhausted: boolean;
  /** Per-task overage events: observed usage exceeded an enforced allowance. */
  violations: BudgetViolation[];
}

export interface BudgetViolation {
  taskId: string;
  /** The enforced limit that was exceeded. */
  limit: 'maxModelRequestsPerTask' | 'maxToolCallsPerTask' | 'timeoutMs' | 'maxModelRequestsPerTurn';
  /** The observed value. */
  observed: number;
  /** The enforced ceiling. */
  enforced: number;
}

/**
 * R6: turn-level mutable state shared across all `subtask` calls within one
 * root turn. Lives on the SubagentTurnBundle so multiple `subtask` tool calls
 * in the same turn see a consistent counter - the per-batch reset that
 * previously let a turn exceed `maxTasksPerTurn` is gone.
 */
export class TurnTaskState {
  private started = 0;

  /** Increment by `n` and return the new total. Called atomically by the
   * supervisor after policy allows a batch. */
  addStarted(n: number): number {
    this.started += n;
    return this.started;
  }

  /** Total tasks started in this root turn (across all `subtask` calls). */
  tasksStarted(): number {
    return this.started;
  }

  reset(): void {
    this.started = 0;
  }
}

/**
 * Aggregate budget ledger for one root turn. Not thread-safe by itself;
 * the Supervisor serializes mutations.
 *
 * R6: observed usage is recorded faithfully (never clamped to hide overage).
 * The enforced allowance and observed usage are modeled separately, so `/cost`
 * and telemetry reflect the truth while the runtime still stops children that
 * exceed their allowance.
 */
export class SubagentBudgetLedger {
  private readonly limits: SubagentBudgetLimits;
  private reserved = new Map<string, number>();
  private reconciled: SubtaskUsage[] = [];
  private violations: BudgetViolation[] = [];

  constructor(limits: SubagentBudgetLimits) {
    this.limits = limits;
  }

  /** Reserve model-request slots for a task. Returns false if unavailable. */
  reserve(taskId: string, requestedRequests: number): ReservedBudget | null {
    if (this.reserved.has(taskId)) return null;
    const want = Math.max(1, Math.min(requestedRequests, this.limits.maxModelRequestsPerTask));
    if (want > this.availableModelRequests()) return null;
    this.reserved.set(taskId, want);
    return { taskId, modelRequests: want };
  }

  /** Release a reservation without consuming (e.g. task rejected after reserve). */
  release(taskId: string): void {
    this.reserved.delete(taskId);
  }

  /**
   * Reconcile actual usage for a task. Releases its reservation and debits
   * the REAL usage (never clamped). Records a violation if observed usage
   * exceeded an enforced per-task or aggregate ceiling. Returns true if the
   * aggregate turn limit is still respected.
   *
   * R6: observed usage is stored as-is so `/cost` and telemetry are truthful.
   */
  reconcile(taskId: string, actual: SubtaskUsage): boolean {
    this.reserved.delete(taskId);
    // Record observed usage faithfully - do NOT clamp to hide overage.
    this.reconciled.push({ ...actual });

    // Record violations: observed exceeded an enforced ceiling.
    if (actual.modelRequests > this.limits.maxModelRequestsPerTask) {
      this.violations.push({
        taskId,
        limit: 'maxModelRequestsPerTask',
        observed: actual.modelRequests,
        enforced: this.limits.maxModelRequestsPerTask,
      });
    }
    if (actual.toolCalls > this.limits.maxToolCallsPerTask) {
      this.violations.push({
        taskId,
        limit: 'maxToolCallsPerTask',
        observed: actual.toolCalls,
        enforced: this.limits.maxToolCallsPerTask,
      });
    }
    if (actual.durationMs > this.limits.timeoutMs) {
      this.violations.push({
        taskId,
        limit: 'timeoutMs',
        observed: actual.durationMs,
        enforced: this.limits.timeoutMs,
      });
    }

    return this.aggregateUsedModelRequests() <= this.limits.maxModelRequestsPerTurn;
  }

  availableModelRequests(): number {
    return Math.max(0, this.limits.maxModelRequestsPerTurn - this.aggregateReservedOrUsed());
  }

  /**
   * Whether `count` new tasks can each reserve at least one model request.
   * NOTE: this checks the minimum (1 request per task), not the full
   * per-task cap. The supervisor's reserve loop (supervisor.ts:158-179)
   * handles per-task reserve amounts individually.
   */
  canReserveBatch(count: number): boolean {
    return this.availableModelRequests() >= count;
  }

  snapshot(): BudgetSnapshot {
    const used = sumSubtaskUsage(this.reconciled);
    const reservedModelRequests = sumSubtaskUsage(
      Array.from(this.reserved.entries()).map(([, n]) => ({ ...EMPTY_SUBTASK_USAGE, modelRequests: n })),
    ).modelRequests;
    const availableModelRequests = this.availableModelRequests();
    return {
      reservedModelRequests,
      used,
      availableModelRequests,
      exhausted: this.aggregateUsedModelRequests() > this.limits.maxModelRequestsPerTurn,
      violations: [...this.violations],
    };
  }

  /** Reconciled aggregate usage across all completed children. */
  aggregateUsage(): SubtaskUsage {
    return sumSubtaskUsage(this.reconciled);
  }

  /** Number of tasks that have been reconciled (completed/failed/cancelled). */
  reconciledTaskCount(): number {
    return this.reconciled.length;
  }

  /** Recorded overage violations (observed exceeded enforced ceiling). */
  violationsList(): BudgetViolation[] {
    return [...this.violations];
  }

  /** True if no reservations are outstanding and no usage has been recorded. */
  isClean(): boolean {
    return this.reserved.size === 0 && this.reconciled.length === 0;
  }

  private aggregateReservedOrUsed(): number {
    let total = 0;
    for (const n of this.reserved.values()) total += n;
    for (const u of this.reconciled) total += u.modelRequests;
    return total;
  }

  private aggregateUsedModelRequests(): number {
    return this.reconciled.reduce((acc, u) => acc + u.modelRequests, 0);
  }
}

/** Build limits from a SubagentConfig. */
export function budgetLimitsFromConfig(config: {
  maxModelRequestsPerTurn: number;
  maxModelRequestsPerTask: number;
  maxToolCallsPerTask: number;
  timeoutMs: number;
}): SubagentBudgetLimits {
  return {
    maxModelRequestsPerTurn: config.maxModelRequestsPerTurn,
    maxModelRequestsPerTask: config.maxModelRequestsPerTask,
    maxToolCallsPerTask: config.maxToolCallsPerTask,
    timeoutMs: config.timeoutMs,
  };
}
