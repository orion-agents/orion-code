import { runSubtaskBatch } from '../src/runtime/subagents/supervisor';
import type { SubagentSupervisorDeps } from '../src/runtime/subagents/supervisor';
import { SubagentBudgetLedger, TurnTaskState, budgetLimitsFromConfig } from '../src/runtime/subagents/budget';
import { SubagentProviderGate } from '../src/runtime/subagents/provider-gate';
import type { ExecuteChildQuery, ChildToolSet } from '../src/runtime/subagents/runner';
import type { RuntimeSubtaskEvent, SubagentConfig, SubtaskPacket, SubtaskRequest, SubtaskUsage } from '../src/runtime/subagents/types';
import { DEFAULT_SUBAGENT_CONFIG } from '../src/runtime/subagents/types';

const TOOL_SET: ChildToolSet = { tools: [], toolExecutor: async () => '' };

function packet(objective: string, role: 'research' | 'review' = 'research'): SubtaskPacket {
  return { role, objective, reason: 'independent' };
}

function request(tasks: SubtaskPacket[], execution: 'parallel' | 'serial' = 'parallel'): SubtaskRequest {
  return { tasks, execution };
}

function makeDeps(overrides: {
  config?: Partial<SubagentConfig>;
  executeQuery?: ExecuteChildQuery;
  parentAbortSignal?: AbortSignal;
  onEvent?: (e: RuntimeSubtaskEvent) => void;
  turnTaskState?: TurnTaskState;
  hasPendingPermission?: () => boolean;
  onChildUsage?: (taskId: string, role: SubtaskPacket['role'], usage: SubtaskUsage, modelLabel?: string) => void;
  onSubtaskResult?: (result: import('../src/runtime/subagents/types').SubtaskResult, batchId: string) => void;
  rootObjectiveSummary?: string;
} = {}): SubagentSupervisorDeps {
  const config = { ...DEFAULT_SUBAGENT_CONFIG, ...overrides.config };
  const budget = new SubagentBudgetLedger(budgetLimitsFromConfig({
    maxModelRequestsPerTurn: config.maxModelRequestsPerTurn,
    maxModelRequestsPerTask: config.maxModelRequestsPerTask,
    maxToolCallsPerTask: config.maxToolCallsPerTask,
    timeoutMs: config.timeoutMs,
  }));
  const providerGate = new SubagentProviderGate({ maxConcurrent: config.maxParallel });
  return {
    config,
    cwd: '/tmp/project',
    budget,
    providerGate,
    executeQuery: overrides.executeQuery ?? (async () => ({ content: JSON.stringify({ summary: 'ok' }), usage: { modelRequests: 1, toolCalls: 0, promptTokens: 0, completionTokens: 0, durationMs: 100 } })),
    toolSet: TOOL_SET,
    turnTaskState: overrides.turnTaskState,
    hasPendingPermission: overrides.hasPendingPermission,
    onChildUsage: overrides.onChildUsage,
    onSubtaskResult: overrides.onSubtaskResult,
    rootObjectiveSummary: overrides.rootObjectiveSummary,
    parentAbortSignal: overrides.parentAbortSignal,
    onEvent: overrides.onEvent,
  };
}

describe('subagent supervisor', () => {
  it('runs a parallel batch and returns results in request order', async () => {
    // Children complete out of order; results must still be in request order.
    let seq = 0;
    const executeQuery: ExecuteChildQuery = async () => {
      const order = seq++;
      const delay = order === 0 ? 50 : 5; // first task slowest
      return new Promise(resolve => {
        setTimeout(() => resolve({
          content: JSON.stringify({ summary: `result-${order}` }),
          usage: { modelRequests: 2, toolCalls: 1, promptTokens: 0, completionTokens: 0, durationMs: delay },
        }), delay);
      });
    };
    const deps = makeDeps({ executeQuery });
    const outcome = await runSubtaskBatch(request([packet('first'), packet('second')]), deps);
    expect(outcome.rejected).toBe(false);
    expect(outcome.result.results).toHaveLength(2);
    expect(outcome.result.results[0].summary).toBe('result-0');
    expect(outcome.result.results[1].summary).toBe('result-1');
    expect(outcome.result.aggregateUsage.modelRequests).toBe(4);
    expect(outcome.result.aggregateUsage.toolCalls).toBe(2);
  });

  it('runs a serial batch one at a time', async () => {
    const order: string[] = [];
    const executeQuery: ExecuteChildQuery = async (_m, _t, _sig) => {
      const label = `r${order.length}`;
      order.push('start');
      return { content: JSON.stringify({ summary: label }), usage: { modelRequests: 1, toolCalls: 0, promptTokens: 0, completionTokens: 0, durationMs: 10 } };
    };
    const deps = makeDeps({ executeQuery });
    const outcome = await runSubtaskBatch(request([packet('investigate alpha'), packet('investigate beta'), packet('investigate gamma')], 'serial'), deps);
    expect(outcome.result.results.map(r => r.summary)).toEqual(['r0', 'r1', 'r2']);
  });

  it('isolates a single child failure; other results remain available', async () => {
    let i = 0;
    const executeQuery: ExecuteChildQuery = async () => {
      const idx = i++;
      if (idx === 1) throw new Error('provider 500');
      return { content: JSON.stringify({ summary: `ok-${idx}` }), usage: { modelRequests: 1, toolCalls: 0, promptTokens: 0, completionTokens: 0, durationMs: 5 } };
    };
    const deps = makeDeps({ executeQuery });
    const outcome = await runSubtaskBatch(request([packet('investigate alpha'), packet('investigate beta'), packet('investigate gamma')]), deps);
    expect(outcome.result.results[0].status).toBe('completed');
    expect(outcome.result.results[1].status).toBe('failed');
    expect(outcome.result.results[2].status).toBe('completed');
  });

  it('isolates a child timeout', async () => {
    let i = 0;
    const executeQuery: ExecuteChildQuery = async (_m, _t, abortSignal) => {
      const idx = i++;
      if (idx === 0) {
        return new Promise((_resolve, reject) => {
          const onAbort = () => reject(new Error('aborted'));
          if (abortSignal.aborted) return onAbort();
          abortSignal.addEventListener('abort', onAbort, { once: true });
        });
      }
      return { content: JSON.stringify({ summary: `ok-${idx}` }), usage: { modelRequests: 1, toolCalls: 0, promptTokens: 0, completionTokens: 0, durationMs: 5 } };
    };
    const deps = makeDeps({ executeQuery, config: { timeoutMs: 40 } });
    const outcome = await runSubtaskBatch(request([packet('investigate slow path'), packet('investigate fast path')]), deps);
    expect(outcome.result.results[0].status).toBe('timed_out');
    expect(outcome.result.results[1].status).toBe('completed');
  });

  it('emits queued, running and terminal lifecycle events', async () => {
    const events: RuntimeSubtaskEvent[] = [];
    // R9: single research task in auto mode needs multi-direction eligibility.
    // Use a multi-direction objective to pass the gate.
    const deps = makeDeps({
      onEvent: e => events.push(e),
      config: { mode: 'auto' },
      rootObjectiveSummary: 'parallel research of runtime and session modules',
    });
    await runSubtaskBatch(request([packet('investigate the only thing')]), deps);
    const states = events.map(e => e.state);
    expect(states).toContain('queued');
    expect(states).toContain('running');
    expect(states).toContain('completed');
    // All events carry the same batchId and taskId.
    expect(events.every(e => e.batchId === events[0].batchId)).toBe(true);
    expect(events.every(e => e.taskId === events[0].taskId)).toBe(true);
  });

  it('rejects the whole batch when policy denies (mode off)', async () => {
    const deps = makeDeps({ config: { mode: 'off' } });
    const outcome = await runSubtaskBatch(request([packet('investigate something specific')]), deps);
    expect(outcome.rejected).toBe(true);
    expect(outcome.rejectReason).toBe('mode_off');
    expect(outcome.result.results[0].status).toBe('rejected');
  });

  it('reconciles budget with actual child usage', async () => {
    const executeQuery: ExecuteChildQuery = async () => ({
      content: JSON.stringify({ summary: 'ok' }),
      usage: { modelRequests: 3, toolCalls: 2, promptTokens: 0, completionTokens: 0, durationMs: 50 },
    });
    const deps = makeDeps({ executeQuery });
    await runSubtaskBatch(request([packet('investigate alpha'), packet('investigate beta')]), deps);
    const agg = deps.budget.aggregateUsage();
    expect(agg.modelRequests).toBe(6);
    expect(agg.toolCalls).toBe(4);
    // No outstanding reservations after reconciliation.
    expect(deps.budget.snapshot().reservedModelRequests).toBe(0);
  });

  it('bounds concurrency to maxParallel via the provider gate', async () => {
    let active = 0;
    let maxActive = 0;
    const executeQuery: ExecuteChildQuery = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 20));
      active -= 1;
      return { content: JSON.stringify({ summary: 'ok' }), usage: { modelRequests: 1, toolCalls: 0, promptTokens: 0, completionTokens: 0, durationMs: 20 } };
    };
    const deps = makeDeps({ executeQuery, config: { maxParallel: 2 } });
    await runSubtaskBatch(request([packet('investigate alpha'), packet('investigate beta'), packet('investigate gamma')]), deps);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('cancels remaining serial tasks when parent aborts', async () => {
    const parent = new AbortController();
    let i = 0;
    const executeQuery: ExecuteChildQuery = async () => {
      const idx = i++;
      if (idx === 0) {
        // First task: abort the parent mid-run.
        setTimeout(() => parent.abort(), 5);
        await new Promise((_resolve, reject) => {
          const onAbort = () => reject(new Error('aborted'));
          if (parent.signal.aborted) return onAbort();
          parent.signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      return { content: JSON.stringify({ summary: `ok-${idx}` }), usage: { modelRequests: 1, toolCalls: 0, promptTokens: 0, completionTokens: 0, durationMs: 5 } };
    };
    const deps = makeDeps({ executeQuery, parentAbortSignal: parent.signal, config: { timeoutMs: 30_000 } });
    const outcome = await runSubtaskBatch(request([packet('investigate first module'), packet('investigate second module'), packet('investigate third module')], 'serial'), deps);
    // First was running and got cancelled; the rest never started and are cancelled.
    expect(outcome.result.results.filter(r => r.status === 'cancelled').length).toBeGreaterThanOrEqual(2);
  });

  it('produces a stable batchId and distinct taskIds', async () => {
    const deps = makeDeps();
    const outcome = await runSubtaskBatch(request([packet('investigate alpha'), packet('investigate beta')]), deps);
    const ids = outcome.result.results.map(r => r.id);
    expect(new Set(ids).size).toBe(2);
    expect(outcome.result.batchId).toBeTruthy();
  });

  // ==========================================================================
  // R6: turn-level task count, permission, budget, cost
  // ==========================================================================

  it('R6: second subtask call in the same turn is bounded by turnTaskState', async () => {
    // maxTasksPerTurn defaults to 3. First call starts 2; second call would
    // push the turn total to 4 > 3, so it must be rejected as too_many_tasks.
    const turnTaskState = new TurnTaskState();
    const deps = makeDeps({ turnTaskState });

    const first = await runSubtaskBatch(request([packet('investigate alpha'), packet('investigate beta')]), deps);
    expect(first.rejected).toBe(false);

    const second = await runSubtaskBatch(request([packet('investigate gamma'), packet('investigate delta')]), deps);
    // 2 + 2 = 4 > maxTasksPerTurn(3) -> rejected.
    expect(second.rejected).toBe(true);
    expect(second.rejectReason).toBe('too_many_tasks');
  });

  it('R6: hasPendingPermission=true rejects the batch as pending_permission', async () => {
    const deps = makeDeps({ hasPendingPermission: () => true });
    const outcome = await runSubtaskBatch(request([packet('investigate something specific')]), deps);
    expect(outcome.rejected).toBe(true);
    expect(outcome.rejectReason).toBe('pending_permission');
  });

  it('R6: hasPendingPermission=false allows the batch (real state, not hardcoded)', async () => {
    // R9: single research task needs multi-direction eligibility in auto mode.
    // Use a multi-direction root objective to satisfy the gate.
    const deps = makeDeps({
      hasPendingPermission: () => false,
      rootObjectiveSummary: 'parallel research of runtime and session modules',
    });
    const outcome = await runSubtaskBatch(request([packet('investigate something specific')]), deps);
    expect(outcome.rejected).toBe(false);
  });

  it('R6: onChildUsage fires with observed usage for every terminal task', async () => {
    const reported: Array<{ taskId: string; role: string; modelRequests: number }> = [];
    const executeQuery: ExecuteChildQuery = async () => ({
      content: JSON.stringify({ summary: 'ok' }),
      usage: { modelRequests: 3, toolCalls: 2, promptTokens: 50, completionTokens: 20, durationMs: 75 },
    });
    const deps = makeDeps({
      executeQuery,
      onChildUsage: (taskId, role, usage) => reported.push({ taskId, role: String(role), modelRequests: usage.modelRequests }),
    });
    await runSubtaskBatch(request([packet('investigate alpha'), packet('investigate beta')]), deps);
    expect(reported).toHaveLength(2);
    expect(reported.every(r => r.modelRequests === 3)).toBe(true);
    expect(reported.every(r => r.role === 'research')).toBe(true);
  });

  it('R6: onChildUsage fires even for failed/cancelled tasks (partial usage accounted)', async () => {
    const reported: SubtaskUsage[] = [];
    const parent = new AbortController();
    const executeQuery: ExecuteChildQuery = async (_m, _t, abortSignal) => {
      return new Promise((_resolve, reject) => {
        const onAbort = () => reject(new Error('aborted'));
        if (abortSignal.aborted) return onAbort();
        abortSignal.addEventListener('abort', onAbort, { once: true });
      });
    };
    const deps = makeDeps({
      executeQuery,
      parentAbortSignal: parent.signal,
      onChildUsage: (_id, _role, usage) => reported.push(usage),
    });
    setTimeout(() => parent.abort(), 20);
    await runSubtaskBatch(request([packet('investigate alpha')]), deps);
    // Cancelled task still reports its (zero/partial) usage so /cost is honest.
    expect(reported).toHaveLength(1);
  });

  // ==========================================================================
  // R7: unified finalize, exactly-once, sink error isolation
  // ==========================================================================

  it('R7: finalized exactly once per task (completed)', async () => {
    const persisted: string[] = [];
    const reported: string[] = [];
    const deps = makeDeps({
      onSubtaskResult: (result) => { persisted.push(result.id); },
      onChildUsage: (taskId) => { reported.push(taskId); },
    });
    const outcome = await runSubtaskBatch(request([packet('investigate alpha'), packet('investigate beta')]), deps);
    // Each task's result persisted exactly once.
    const ids = outcome.result.results.map(r => r.id);
    expect(persisted).toEqual(ids);
    expect(reported).toEqual(ids);
  });

  it('R7: rejected tasks are finalized (trace/artifact/usage)', async () => {
    const persisted: import('../src/runtime/subagents/types').SubtaskResult[] = [];
    const events: RuntimeSubtaskEvent[] = [];
    const deps = makeDeps({
      config: { mode: 'off' },
      onSubtaskResult: (result) => { persisted.push(result); },
      onEvent: (e) => { events.push(e); },
    });
    const outcome = await runSubtaskBatch(request([packet('investigate alpha'), packet('investigate beta')]), deps);
    expect(outcome.rejected).toBe(true);
    // Rejected results persisted (artifact/trace) exactly once each.
    expect(persisted).toHaveLength(2);
    expect(persisted.every(r => r.status === 'rejected')).toBe(true);
    // Rejected lifecycle events emitted.
    expect(events.some(e => e.state === 'rejected')).toBe(true);
  });

  it('R7: serial-cancelled tasks are finalized (resume sees cancelled state)', async () => {
    const parent = new AbortController();
    const persisted: import('../src/runtime/subagents/types').SubtaskResult[] = [];
    let i = 0;
    const executeQuery: ExecuteChildQuery = async () => {
      const idx = i++;
      if (idx === 0) {
        setTimeout(() => parent.abort(), 5);
        await new Promise((_resolve, reject) => {
          const onAbort = () => reject(new Error('aborted'));
          if (parent.signal.aborted) return onAbort();
          parent.signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      return { content: JSON.stringify({ summary: `ok-${idx}` }), usage: { modelRequests: 1, toolCalls: 0, promptTokens: 0, completionTokens: 0, durationMs: 5 } };
    };
    const deps = makeDeps({
      executeQuery,
      parentAbortSignal: parent.signal,
      onSubtaskResult: (result) => { persisted.push(result); },
    });
    const outcome = await runSubtaskBatch(
      request([packet('investigate first module'), packet('investigate second module'), packet('investigate third module')], 'serial'),
      deps,
    );
    // All 3 tasks finalized exactly once (first cancelled, rest cancelled-before-run).
    expect(persisted).toHaveLength(3);
    const cancelled = persisted.filter(r => r.status === 'cancelled');
    expect(cancelled.length).toBeGreaterThanOrEqual(2);
  });

  it('R7: throwing onSubtaskResult does not reject the batch or corrupt siblings', async () => {
    let throwCount = 0;
    const deps = makeDeps({
      onSubtaskResult: () => { throwCount += 1; throw new Error('artifact sink failed'); },
    });
    // Must NOT throw - sink error is isolated.
    const outcome = await runSubtaskBatch(request([packet('investigate alpha'), packet('investigate beta')]), deps);
    expect(outcome.rejected).toBe(false);
    expect(outcome.result.results).toHaveLength(2);
    // Both tasks' sinks were invoked despite throwing.
    expect(throwCount).toBe(2);
    // Aggregate usage still correct (not corrupted by the throwing sink).
    expect(outcome.result.aggregateUsage.modelRequests).toBe(2);
  });

  it('R7: throwing onEvent does not reject the batch', async () => {
    const deps = makeDeps({
      onEvent: () => { throw new Error('event sink failed'); },
      // R9: use two packets to bypass auto-mode single-task eligibility gate.
    });
    const outcome = await runSubtaskBatch(request([packet('investigate alpha'), packet('investigate beta')]), deps);
    expect(outcome.rejected).toBe(false);
    expect(outcome.result.results[0].status).toBe('completed');
    expect(outcome.result.results[1].status).toBe('completed');
  });

  it('R7: throwing onChildUsage does not reject the batch', async () => {
    let callCount = 0;
    const deps = makeDeps({
      onChildUsage: () => { callCount += 1; throw new Error('cost sink failed'); },
    });
    const outcome = await runSubtaskBatch(request([packet('investigate alpha'), packet('investigate beta')]), deps);
    expect(outcome.rejected).toBe(false);
    expect(callCount).toBe(2);
  });
});
