import {
  SubagentBudgetLedger,
  TurnTaskState,
  budgetLimitsFromConfig,
} from '../src/runtime/subagents/budget';
import { EMPTY_SUBTASK_USAGE, type SubtaskUsage } from '../src/runtime/subagents/types';

const LIMITS = budgetLimitsFromConfig({
  maxModelRequestsPerTurn: 12,
  maxModelRequestsPerTask: 6,
  maxToolCallsPerTask: 24,
  timeoutMs: 120_000,
});

function usage(modelRequests: number, toolCalls = 0, durationMs = 0): SubtaskUsage {
  return { ...EMPTY_SUBTASK_USAGE, modelRequests, toolCalls, durationMs, promptTokens: 0, completionTokens: 0 };
}

describe('subagent budget ledger', () => {
  it('reserves and reports available requests', () => {
    const ledger = new SubagentBudgetLedger(LIMITS);
    expect(ledger.availableModelRequests()).toBe(12);
    const reserved = ledger.reserve('task-1', 4);
    expect(reserved).not.toBeNull();
    expect(ledger.availableModelRequests()).toBe(8);
    expect(ledger.snapshot().reservedModelRequests).toBe(4);
  });

  it('refuses to double-reserve the same task', () => {
    const ledger = new SubagentBudgetLedger(LIMITS);
    ledger.reserve('task-1', 3);
    expect(ledger.reserve('task-1', 3)).toBeNull();
  });

  it('refuses reservation that exceeds available requests', () => {
    const ledger = new SubagentBudgetLedger(LIMITS);
    ledger.reserve('task-1', 6); // clamped to maxPerTask=6, avail=6
    ledger.reserve('task-2', 6); // avail now 0
    // A third task cannot reserve even one request.
    expect(ledger.reserve('task-3', 1)).toBeNull();
  });

  it('clamps per-task reservation to maxModelRequestsPerTask', () => {
    const ledger = new SubagentBudgetLedger(LIMITS);
    const reserved = ledger.reserve('task-1', 100);
    expect(reserved?.modelRequests).toBe(6);
  });

  it('reconciles actual usage and releases the reservation', () => {
    const ledger = new SubagentBudgetLedger(LIMITS);
    ledger.reserve('task-1', 6);
    const ok = ledger.reconcile('task-1', usage(3, 10, 1000));
    expect(ok).toBe(true);
    // 3 used, reservation released; 12 - 3 = 9 available
    expect(ledger.availableModelRequests()).toBe(9);
    expect(ledger.snapshot().reservedModelRequests).toBe(0);
    expect(ledger.aggregateUsage().modelRequests).toBe(3);
    expect(ledger.aggregateUsage().toolCalls).toBe(10);
  });

  it('release drops a reservation without consuming budget', () => {
    const ledger = new SubagentBudgetLedger(LIMITS);
    ledger.reserve('task-1', 6);
    ledger.release('task-1');
    expect(ledger.availableModelRequests()).toBe(12);
    expect(ledger.isClean()).toBe(true);
  });

  it('aggregate usage sums across multiple reconciled tasks', () => {
    const ledger = new SubagentBudgetLedger(LIMITS);
    ledger.reserve('task-1', 6);
    ledger.reconcile('task-1', usage(4, 5, 1000));
    ledger.reserve('task-2', 6);
    ledger.reconcile('task-2', usage(3, 8, 2000));
    const agg = ledger.aggregateUsage();
    expect(agg.modelRequests).toBe(7);
    expect(agg.toolCalls).toBe(13);
    expect(agg.durationMs).toBe(3000);
  });

  it('reports exhausted when actual usage exceeds the turn limit', () => {
    const ledger = new SubagentBudgetLedger(LIMITS);
    ledger.reserve('task-1', 6);
    ledger.reconcile('task-1', usage(6, 0, 0));
    ledger.reserve('task-2', 6);
    const ok = ledger.reconcile('task-2', usage(6, 0, 0)); // 12 total, at the limit
    expect(ok).toBe(true);
    expect(ledger.snapshot().exhausted).toBe(false);
    ledger.reserve('task-3', 6);
    const over = ledger.reconcile('task-3', usage(2, 0, 0));
    // 6+6+2 = 14 > 12
    expect(over).toBe(false);
    expect(ledger.snapshot().exhausted).toBe(true);
  });

  it('canReserveBatch reports whether a batch of N can each get a slot', () => {
    const ledger = new SubagentBudgetLedger(LIMITS);
    expect(ledger.canReserveBatch(3)).toBe(true); // 12 >= 3
    ledger.reserve('task-1', 6);
    ledger.reconcile('task-1', usage(6)); // avail = 12 - 6 = 6
    expect(ledger.canReserveBatch(6)).toBe(true); // 6 >= 6
    expect(ledger.canReserveBatch(7)).toBe(false); // 6 < 7
  });

  it('isClean only when nothing is reserved or reconciled', () => {
    const ledger = new SubagentBudgetLedger(LIMITS);
    expect(ledger.isClean()).toBe(true);
    ledger.reserve('task-1', 2);
    expect(ledger.isClean()).toBe(false);
    ledger.release('task-1');
    expect(ledger.isClean()).toBe(true);
    ledger.reserve('task-1', 2);
    ledger.reconcile('task-1', usage(1));
    expect(ledger.isClean()).toBe(false);
  });

  it('R6: records observed usage faithfully (no clamping to hide overage)', () => {
    const ledger = new SubagentBudgetLedger(LIMITS);
    ledger.reserve('task-1', 6);
    ledger.reconcile('task-1', usage(6, 9999, 999_999));
    const agg = ledger.aggregateUsage();
    // Observed values are recorded as-is - NOT clamped. /cost and telemetry
    // must reflect the truth.
    expect(agg.toolCalls).toBe(9999);
    expect(agg.durationMs).toBe(999_999);
  });

  it('R6: records violations when observed exceeds enforced ceilings', () => {
    const ledger = new SubagentBudgetLedger(LIMITS);
    ledger.reserve('task-1', 6);
    ledger.reconcile('task-1', usage(10, 9999, 999_999));
    const violations = ledger.violationsList();
    // Three ceilings exceeded: per-task model requests, tool calls, timeout.
    expect(violations.length).toBe(3);
    const limits = violations.map(v => v.limit);
    expect(limits).toContain('maxModelRequestsPerTask');
    expect(limits).toContain('maxToolCallsPerTask');
    expect(limits).toContain('timeoutMs');
    // Observed vs enforced recorded for diagnostics.
    const modelV = violations.find(v => v.limit === 'maxModelRequestsPerTask')!;
    expect(modelV.observed).toBe(10);
    expect(modelV.enforced).toBe(6);
  });
});

// ==========================================================================
// R6: turn-level task counter (persists across subtask calls)
// ==========================================================================
describe('TurnTaskState', () => {
  it('accumulates tasks started across calls', () => {
    const state = new TurnTaskState();
    expect(state.tasksStarted()).toBe(0);
    state.addStarted(2);
    expect(state.tasksStarted()).toBe(2);
    state.addStarted(1);
    expect(state.tasksStarted()).toBe(3);
  });

  it('reset clears the counter', () => {
    const state = new TurnTaskState();
    state.addStarted(3);
    state.reset();
    expect(state.tasksStarted()).toBe(0);
  });
});
