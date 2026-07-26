/**
 * SubagentSupervisor: orchestrates a batch of child subtasks.
 *
 * Owns the task/batch ID space, the state machine, the concurrency queue and
 * ordered aggregation. It is the single place that decides when children start,
 * how they are bounded, and how their results are folded back to the root.
 *
 * The supervisor does NOT own LLM state, tool execution, permission policy or
 * transcript storage. It composes the policy gate, the budget ledger, the
 * provider gate and the runner, and emits renderer-independent lifecycle
 * events that the root loop forwards to terminal/Ink/TUI.
 */

import { SubagentBudgetLedger, TurnTaskState } from './budget';
import { evaluateSubtaskPolicy, type PolicyContext, type PolicyRejectReason } from './policy';
import { SubagentProviderGate } from './provider-gate';
import { runSubtask, type ExecuteChildQuery, type ChildToolSet, type SubagentRunnerDeps } from './runner';
import type { ScopeHolder } from './child-executor-guard';
import {
  sumSubtaskUsage,
  type RuntimeSubtaskEvent,
  type SubagentConfig,
  type SubtaskBatchResult,
  type SubtaskPacket,
  type SubtaskRequest,
  type SubtaskResult,
} from './types';

export interface SubagentSupervisorDeps {
  config: SubagentConfig;
  cwd: string;
  budget: SubagentBudgetLedger;
  providerGate: SubagentProviderGate;
  /** Injectable query binding shared with the runner (tests mock this). */
  executeQuery: ExecuteChildQuery;
  /** Filtered, child-safe tool set (already passed through presets). */
  toolSet: ChildToolSet;
  /**
   * R3: mutable scope holder. The supervisor sets the current packet's
   * canonical scope before running it, so the turn-level executor guard can
   * enforce per-packet containment. Optional: when absent, only root
   * containment is enforced.
   */
  scopeHolder?: ScopeHolder;
  /**
   * R6: turn-level task counter. Persists across `subtask` calls so multiple
   * calls in one root turn cannot exceed `maxTasksPerTurn`. When absent, the
   * supervisor falls back to a per-batch counter (weaker; logged).
   */
  turnTaskState?: TurnTaskState;
  /**
   * R6: live permission state from the root runtime. Returns true when a
   * permission request is awaiting user decision. When absent, defaults to
   * false (no pending permission) - the root loop should inject the real
   * state to prevent background auto-approval bypass.
   */
  hasPendingPermission?: () => boolean;
  /**
   * R6: called with each child's observed usage (never clamped) so the root
   * loop can record it into its shared CostTracker. Fires for every terminal
   * state (completed/failed/cancelled/timed_out), so partial usage before a
   * failure is still accounted.
   */
  onChildUsage?: (taskId: string, role: import('./types').SubagentRole, usage: import('./types').SubtaskUsage, modelLabel?: string) => void;
  /** Parent turn abort signal; propagated to every child. */
  parentAbortSignal?: AbortSignal;
  /** Read-only context forwarded to each child. */
  rootObjectiveSummary?: string;
  modelLabel?: string;
  /** Lifecycle event sink (runtime event + trace). */
  onEvent?: (event: RuntimeSubtaskEvent) => void;
  /** Called once per task with its final SubtaskResult (for artifact persistence). */
  onSubtaskResult?: (result: SubtaskResult, batchId: string) => void;
}

let batchCounter = 0;
let taskCounter = 0;

function nextBatchId(): string {
  batchCounter += 1;
  return `batch-${batchCounter}`;
}

function nextTaskId(): string {
  taskCounter += 1;
  return `task-${taskCounter}`;
}

export interface RunBatchOutcome {
  result: SubtaskBatchResult;
  /** Whether policy rejected the entire batch before any child ran. */
  rejected: boolean;
  rejectReason?: PolicyRejectReason;
}

/**
 * Run a batch of subtasks. Returns a {@link SubtaskBatchResult} whose results
 * are always in request order, regardless of completion order.
 *
 * Never throws: policy rejection, child failures, timeouts and cancels are
 * all normalized into result entries.
 */
export async function runSubtaskBatch(
  request: SubtaskRequest,
  deps: SubagentSupervisorDeps,
): Promise<RunBatchOutcome> {
  const policyCtx: PolicyContext = {
    depth: 0,
    cwd: deps.cwd,
    config: deps.config,
    rootObjective: deps.rootObjectiveSummary ?? '',
    // R6: turn-level counter persists across `subtask` calls so multiple
    // calls in one root turn cannot exceed `maxTasksPerTurn`.
    tasksStartedThisTurn: deps.turnTaskState?.tasksStarted() ?? 0,
    runningChildren: deps.providerGate.activeCount(),
    // R6: live permission state from the root runtime, not a hardcoded false.
    hasPendingPermission: deps.hasPendingPermission ? deps.hasPendingPermission() : false,
    parentAborted: Boolean(deps.parentAbortSignal?.aborted),
    remainingModelRequests: deps.budget.availableModelRequests(),
    providerCanReserve: (count: number) => deps.providerGate.canReserve(count),
  };

  const verdict = evaluateSubtaskPolicy(request, policyCtx);
  if (!verdict.allowed) {
    const batchId = nextBatchId();
    const results = request.tasks.map(packet => {
      const result = buildRejectedResult(packet, verdict.reason);
      // R7: finalize (trace/artifact/usage) exactly once even for rejected tasks.
      finalizeTask(deps, batchId, result.id, packet, result);
      return result;
    });
    return {
      result: { batchId, results, aggregateUsage: sumSubtaskUsage([]) },
      rejected: true,
      rejectReason: verdict.reason,
    };
  }

  // R6: account for the accepted tasks in the turn-level counter so the
  // next `subtask` call in the same turn sees the updated total.
  deps.turnTaskState?.addStarted(request.tasks.length);

  const batchId = nextBatchId();
  const tasks = request.tasks;
  const taskIds = tasks.map(() => nextTaskId());

  // Reserve a fair share per task: the per-task cap, but no more than an even
  // slice of the turn budget. This lets a 3-task batch fit when the turn limit
  // is smaller than 3x the per-task cap, while the per-task cap still binds at
  // reconcile time. Reserving the full per-task cap for every task would
  // reject batches that would actually fit once real usage is known.
  const reservePerTask = Math.max(
    1,
    Math.min(deps.config.maxModelRequestsPerTask, Math.floor(deps.config.maxModelRequestsPerTurn / tasks.length)),
  );

  // Reserve budget for every task up front; abort the batch if any reserve fails.
  for (let i = 0; i < tasks.length; i++) {
    const reserved = deps.budget.reserve(taskIds[i], reservePerTask);
    if (!reserved) {
      // Release what we reserved and reject the rest.
      for (let j = 0; j <= i; j++) deps.budget.release(taskIds[j]);
      const results = tasks.map((packet, i) => {
        const result = buildRejectedResult(packet, 'budget_exhausted', taskIds[i]);
        // R7: finalize rejected tasks too.
        finalizeTask(deps, batchId, result.id, packet, result);
        return result;
      });
      return {
        result: { batchId, results, aggregateUsage: sumSubtaskUsage([]) },
        rejected: true,
        rejectReason: 'budget_exhausted',
      };
    }
    emit(deps, {
      batchId, taskId: taskIds[i], role: tasks[i].role, state: 'queued',
      objective: tasks[i].objective,
    });
  }

  const runnerDeps = (i: number): SubagentRunnerDeps => ({
    cwd: deps.cwd,
    canonicalScopePaths: verdict.canonicalScope.get(i),
    toolSet: deps.toolSet,
    executeQuery: deps.executeQuery,
    timeoutMs: deps.config.timeoutMs,
    parentAbortSignal: deps.parentAbortSignal,
    rootObjectiveSummary: deps.rootObjectiveSummary,
    modelLabel: deps.modelLabel,
  });

  let outcomes: Array<{ result: SubtaskResult; parentCancelled: boolean }>;
  if (request.execution === 'parallel') {
    outcomes = await runParallel(tasks, taskIds, batchId, deps, runnerDeps);
  } else {
    outcomes = await runSerial(tasks, taskIds, batchId, deps, runnerDeps);
  }

  // Reconcile budget for each task with its real usage.
  for (const outcome of outcomes) {
    deps.budget.reconcile(outcome.result.id, outcome.result.usage);
  }

  const results = outcomes.map(o => o.result);
  const aggregateUsage = sumSubtaskUsage(results.map(r => r.usage));

  return {
    result: { batchId, results, aggregateUsage },
    rejected: false,
  };
}

async function runParallel(
  tasks: SubtaskPacket[],
  taskIds: string[],
  batchId: string,
  deps: SubagentSupervisorDeps,
  runnerDeps: (i: number) => SubagentRunnerDeps,
): Promise<Array<{ result: SubtaskResult; parentCancelled: boolean }>> {
  // Launch each child; the provider gate bounds actual concurrency. Collect
  // by index so the final order matches the request order.
  // allSettled guarantees every task is accounted for even if a future
  // refactor breaks the "runOne never throws" contract.
  const slots = tasks.map((task, i) => runOne(task, taskIds[i], batchId, i, deps, runnerDeps(i)));
  const settled = await Promise.allSettled(slots);
  return settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    // Defensive: construct a failed result for any slot that threw unexpectedly.
    const task = tasks[i];
    const result: SubtaskResult = {
      id: taskIds[i],
      role: task.role,
      status: 'failed',
      summary: 'Unexpected runner error.',
      findings: [],
      files: [],
      commands: [],
      verification: [],
      risks: ['runner threw unexpectedly'],
      usage: { modelRequests: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, durationMs: 0 },
    };
    finalizeTask(deps, batchId, taskIds[i], task, result);
    return { result, parentCancelled: false };
  });
}

async function runSerial(
  tasks: SubtaskPacket[],
  taskIds: string[],
  batchId: string,
  deps: SubagentSupervisorDeps,
  runnerDeps: (i: number) => SubagentRunnerDeps,
): Promise<Array<{ result: SubtaskResult; parentCancelled: boolean }>> {
  const outcomes: Array<{ result: SubtaskResult; parentCancelled: boolean }> = [];
  for (let i = 0; i < tasks.length; i++) {
    if (deps.parentAbortSignal?.aborted) {
      // Mark remaining as cancelled without running them.
      // R7: finalize each cancelled result (trace/artifact/usage) exactly
      // once, same as a ran task, so resume sees the cancelled state.
      for (let j = i; j < tasks.length; j++) {
        const cancelled = cancelledResult(taskIds[j], tasks[j]);
        finalizeTask(deps, batchId, taskIds[j], tasks[j], cancelled);
        outcomes.push({
          result: cancelled,
          parentCancelled: true,
        });
      }
      break;
    }
    const outcome = await runOne(tasks[i], taskIds[i], batchId, i, deps, runnerDeps(i));
    outcomes.push(outcome);
  }
  return outcomes;
}

async function runOne(
  task: SubtaskPacket,
  taskId: string,
  batchId: string,
  _index: number,
  deps: SubagentSupervisorDeps,
  runnerDeps: SubagentRunnerDeps,
): Promise<{ result: SubtaskResult; parentCancelled: boolean }> {
  // R4: pass the parent abort signal so a queued waiter is removed and
  // rejected when the user hits Ctrl+C, instead of hanging until a slot
  // frees. A rejected acquire yields a cancelled result, not a hung batch.
  try {
    await deps.providerGate.acquire(deps.parentAbortSignal);
  } catch {
    // AcquireAbortedError: parent aborted while queued. Treat as cancelled.
    // R7: finalize the cancelled result so trace/artifact/usage are recorded
    // exactly once, same as any other terminal state.
    const cancelled = cancelledResult(taskId, task);
    finalizeTask(deps, batchId, taskId, task, cancelled);
    return { result: cancelled, parentCancelled: true };
  }
  try {
    // R3: set the current packet's canonical scope so the executor guard
    // enforces per-packet containment. Cleared in finally.
    if (deps.scopeHolder) {
      deps.scopeHolder.setScope(runnerDeps.canonicalScopePaths ?? []);
    }
    emit(deps, { batchId, taskId, role: task.role, state: 'running', objective: task.objective });
    const outcome = await runSubtask(task, runnerDeps, taskId);
    // R7: single finalize path - terminal event + result callback + usage
    // callback all happen here, exactly once, with errors isolated so a
    // throwing sink cannot reject the batch or corrupt sibling aggregation.
    finalizeTask(deps, batchId, taskId, task, outcome.result);
    return outcome;
  } finally {
    deps.providerGate.release();
    deps.scopeHolder?.clear();
  }
}

/**
 * R7: finalize exactly once per task. Emits the terminal lifecycle event,
 * persists the result (artifact), and reports observed usage to the root
 * CostTracker. Sink errors (event/trace/artifact/usage) are isolated into
 * diagnostics: they must NOT change the child's business terminal state or
 * reject the batch, so a failing sink cannot corrupt sibling aggregation.
 */
function finalizeTask(
  deps: SubagentSupervisorDeps,
  batchId: string,
  taskId: string,
  task: SubtaskPacket,
  result: SubtaskResult,
): void {
  // Terminal lifecycle event - isolated.
  try {
    emit(deps, {
      batchId, taskId, role: task.role,
      state: toEventState(result.status),
      objective: task.objective,
      summary: result.summary,
      durationMs: result.usage.durationMs,
      usage: result.usage,
    });
  } catch {
    // Sink failure must not affect the result.
  }

  // Persist the structured result for trace/resume durability - isolated.
  try {
    deps.onSubtaskResult?.(result, batchId);
  } catch {
    // An artifact/trace sink throwing cannot reject the batch.
  }

  // Report observed usage (never clamped) to the root CostTracker - isolated.
  try {
    deps.onChildUsage?.(taskId, task.role, result.usage, deps.modelLabel);
  } catch {
    // CostTracker failure must not affect the result.
  }
}

function toEventState(status: SubtaskResult['status']): RuntimeSubtaskEvent['state'] {
  switch (status) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'timed_out': return 'timed_out';
    case 'rejected': return 'rejected';
  }
}

/** Build a rejected result (does not emit - finalizeTask handles that). */
function buildRejectedResult(packet: SubtaskPacket, reason: string, taskId?: string): SubtaskResult {
  const id = taskId ?? nextTaskId();
  return {
    id,
    role: packet.role,
    status: 'rejected',
    summary: `Rejected by policy: ${reason}`,
    findings: [],
    files: [],
    commands: [],
    verification: [],
    risks: [`policy rejected: ${reason}`],
    usage: { modelRequests: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, durationMs: 0 },
  };
}

function cancelledResult(taskId: string, packet: SubtaskPacket): SubtaskResult {
  return {
    id: taskId,
    role: packet.role,
    status: 'cancelled',
    summary: 'Cancelled: parent turn aborted before this task started.',
    findings: [],
    files: [],
    commands: [],
    verification: [],
    risks: ['parent turn aborted'],
    usage: { modelRequests: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, durationMs: 0 },
  };
}

function emit(deps: SubagentSupervisorDeps, event: RuntimeSubtaskEvent): void {
  // R7: an event sink throwing must never reject the batch or corrupt
  // sibling aggregation - isolate it as a diagnostic.
  try {
    deps.onEvent?.(event);
  } catch {
    // Event sink failure is best-effort; the result is unaffected.
  }
}
