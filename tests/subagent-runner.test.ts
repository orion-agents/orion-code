import { runSubtask } from '../src/runtime/subagents/runner';
import type { ExecuteChildQuery, ChildToolSet } from '../src/runtime/subagents/runner';
import type { SubtaskPacket, SubtaskUsage } from '../src/runtime/subagents/types';

const TOOL_SET: ChildToolSet = {
  tools: [],
  toolExecutor: async () => '',
};

const PACKET: SubtaskPacket = {
  role: 'research',
  objective: 'Find cancel-signal handlers in runtime',
  reason: 'independent',
};

const USAGE: SubtaskUsage = { modelRequests: 2, toolCalls: 3, promptTokens: 80, completionTokens: 40, durationMs: 1500 };

function deps(executeQuery: ExecuteChildQuery, overrides: { timeoutMs?: number; parentAbortSignal?: AbortSignal } = {}) {
  return {
    cwd: '/tmp/project',
    toolSet: TOOL_SET,
    executeQuery,
    timeoutMs: overrides.timeoutMs ?? 30_000,
    parentAbortSignal: overrides.parentAbortSignal,
  };
}

describe('subagent runner', () => {
  it('returns a completed result for well-formed JSON output', async () => {
    const executeQuery: ExecuteChildQuery = async () => ({
      content: JSON.stringify({ summary: 'Found 2 handlers', findings: [{ title: 'f', evidence: 'e' }] }),
      usage: USAGE,
    });
    const { result } = await runSubtask(PACKET, deps(executeQuery), 'task-1');
    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Found 2 handlers');
    expect(result.usage.modelRequests).toBe(2);
  });

  it('marks non-JSON output as failed', async () => {
    const executeQuery: ExecuteChildQuery = async () => ({ content: 'I could not parse anything', usage: USAGE });
    const { result } = await runSubtask(PACKET, deps(executeQuery), 'task-1');
    expect(result.status).toBe('failed');
    expect(result.risks).toContain('child returned non-JSON output');
  });

  it('times out and returns timed_out status', async () => {
    const executeQuery: ExecuteChildQuery = async (_m, _t, abortSignal) => {
      return new Promise((resolve) => {
        const onAbort = () => resolve({ content: 'partial', usage: USAGE });
        if (abortSignal.aborted) return onAbort();
        abortSignal.addEventListener('abort', onAbort, { once: true });
      });
    };
    const { result } = await runSubtask(PACKET, deps(executeQuery, { timeoutMs: 50 }), 'task-1');
    expect(result.status).toBe('timed_out');
  }, 5000);

  it('cancels when parent abort signal fires', async () => {
    const parent = new AbortController();
    const executeQuery: ExecuteChildQuery = async (_m, _t, abortSignal) => {
      return new Promise((_resolve, reject) => {
        const onAbort = () => reject(new Error('aborted'));
        if (abortSignal.aborted) return onAbort();
        abortSignal.addEventListener('abort', onAbort, { once: true });
      });
    };
    // Abort the parent shortly after starting.
    setTimeout(() => parent.abort(), 20);
    const { result, parentCancelled } = await runSubtask(
      PACKET,
      deps(executeQuery, { timeoutMs: 30_000, parentAbortSignal: parent.signal }),
      'task-1',
    );
    expect(result.status).toBe('cancelled');
    expect(parentCancelled).toBe(true);
  }, 5000);

  it('returns failed when executeQuery rejects without parent abort', async () => {
    const executeQuery: ExecuteChildQuery = async () => {
      throw new Error('provider 500');
    };
    const { result } = await runSubtask(PACKET, deps(executeQuery), 'task-1');
    expect(result.status).toBe('failed');
    expect(result.summary).toMatch(/provider 500/);
  });

  it('immediately cancels if parent signal is already aborted', async () => {
    const parent = new AbortController();
    parent.abort();
    const executeQuery: ExecuteChildQuery = async (_m, _t, abortSignal) => {
      // Real query() rejects when called with an already-aborted signal.
      if (abortSignal.aborted) throw new Error('aborted');
      throw new Error('should not reach here');
    };
    const { result, parentCancelled } = await runSubtask(
      PACKET,
      deps(executeQuery, { parentAbortSignal: parent.signal }),
      'task-1',
    );
    expect(result.status).toBe('cancelled');
    expect(parentCancelled).toBe(true);
  }, 5000);

  it('never throws: all failure modes normalize into a result', async () => {
    const executeQuery: ExecuteChildQuery = async () => {
      throw new Error('unexpected');
    };
    await expect(runSubtask(PACKET, deps(executeQuery), 'task-1')).resolves.toBeDefined();
  });

  // ==========================================================================
  // R5: abort/timeout/shutdown semantics
  // ==========================================================================

  it('R5: late-resolving query after parent abort stays cancelled', async () => {
    const parent = new AbortController();
    // Query resolves (not rejects) shortly AFTER the abort fires. Without the
    // parent_abort race outcome, this would flip to 'completed'.
    const executeQuery: ExecuteChildQuery = (_m, _t, abortSignal) => {
      return new Promise(resolve => {
        const onAbort = () => {
          // Resolve late, simulating a query that finished after abort.
          setTimeout(() => resolve({ content: JSON.stringify({ summary: 'late' }), usage: USAGE }), 30);
        };
        if (abortSignal.aborted) return onAbort();
        abortSignal.addEventListener('abort', onAbort, { once: true });
      });
    };
    setTimeout(() => parent.abort(), 20);
    const { result, parentCancelled } = await runSubtask(
      PACKET,
      deps(executeQuery, { timeoutMs: 30_000, parentAbortSignal: parent.signal }),
      'task-1',
    );
    expect(result.status).toBe('cancelled');
    expect(parentCancelled).toBe(true);
    // The late content must NOT have flipped the status to completed.
    expect(result.status).not.toBe('completed');
  }, 10_000);

  it('R5: rejecting query after parent abort stays cancelled', async () => {
    const parent = new AbortController();
    const executeQuery: ExecuteChildQuery = (_m, _t, abortSignal) => {
      return new Promise((_resolve, reject) => {
        const onAbort = () => setTimeout(() => reject(new Error('aborted late')), 30);
        if (abortSignal.aborted) return onAbort();
        abortSignal.addEventListener('abort', onAbort, { once: true });
      });
    };
    setTimeout(() => parent.abort(), 20);
    const { result } = await runSubtask(
      PACKET,
      deps(executeQuery, { timeoutMs: 30_000, parentAbortSignal: parent.signal }),
      'task-1',
    );
    expect(result.status).toBe('cancelled');
  }, 10_000);

  it('R5: timeout waits for query to settle within grace period (cooperative)', async () => {
    // Query settles promptly when aborted (cooperative executor).
    const executeQuery: ExecuteChildQuery = (_m, _t, abortSignal) => {
      return new Promise(resolve => {
        const onAbort = () => resolve({ content: 'partial', usage: USAGE });
        if (abortSignal.aborted) return onAbort();
        abortSignal.addEventListener('abort', onAbort, { once: true });
      });
    };
    const start = Date.now();
    const { result } = await runSubtask(PACKET, deps(executeQuery, { timeoutMs: 50 }), 'task-1');
    expect(result.status).toBe('timed_out');
    // Should not have waited the full grace period since the query settled fast.
    expect(Date.now() - start).toBeLessThan(2_500);
  }, 10_000);

  it('R5: timeout abandons uncooperative executor after bounded grace', async () => {
    // Query ignores the abort signal and never resolves. The runner must
    // still return after the grace period, not hang forever.
    const executeQuery: ExecuteChildQuery = () => {
      // Never resolves, never rejects - ignores abort.
      return new Promise(() => undefined);
    };
    const start = Date.now();
    const { result } = await runSubtask(PACKET, deps(executeQuery, { timeoutMs: 50 }), 'task-1');
    expect(result.status).toBe('timed_out');
    // Returned within grace + small overhead, proving the uncooperative
    // executor was abandoned rather than waited on indefinitely.
    expect(Date.now() - start).toBeLessThan(5_000);
  }, 10_000);

  it('R5: no late tool/model call after cancel flips the status', async () => {
    // Simulate a query that, after the parent aborts, would have issued a
    // side effect (e.g. a tool call). The result must remain cancelled.
    const parent = new AbortController();
    let sideEffectRan = false;
    const executeQuery: ExecuteChildQuery = (_m, _t, abortSignal) => {
      return new Promise(resolve => {
        const onAbort = () => {
          // Side effect that "would have" run late.
          sideEffectRan = true;
          setTimeout(() => resolve({ content: JSON.stringify({ summary: 'x' }), usage: USAGE }), 30);
        };
        if (abortSignal.aborted) return onAbort();
        abortSignal.addEventListener('abort', onAbort, { once: true });
      });
    };
    setTimeout(() => parent.abort(), 20);
    const { result, parentCancelled } = await runSubtask(
      PACKET,
      deps(executeQuery, { timeoutMs: 30_000, parentAbortSignal: parent.signal }),
      'task-1',
    );
    expect(result.status).toBe('cancelled');
    expect(parentCancelled).toBe(true);
    // The side effect was observed (the query ran during grace), but it did
    // not change the terminal status.
    expect(sideEffectRan).toBe(true);
  }, 10_000);
});
