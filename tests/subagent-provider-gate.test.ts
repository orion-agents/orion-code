import { SubagentProviderGate, AcquireAbortedError } from '../src/runtime/subagents/provider-gate';

/** A controllable fake timer scheduler for deterministic cooldown tests. */
function fakeScheduler() {
  const fired: Array<() => void> = [];
  const schedule = (fn: () => void, _ms: number) => ({
    clear() { /* no-op: tests drive via fire() */ },
  });
  const fire = () => {
    const f = fired.shift();
    if (f) f();
  };
  // We capture the latest scheduled fn so fire() can invoke it.
  let lastFn: (() => void) | null = null;
  const scheduleCapture = (fn: () => void, _ms: number) => {
    lastFn = fn;
    return { clear() { lastFn = null; } };
  };
  return { schedule: scheduleCapture, fire: () => { const f = lastFn; lastFn = null; if (f) f(); } };
}

describe('subagent provider gate', () => {
  it('allows up to maxConcurrent concurrent acquires', async () => {
    const gate = new SubagentProviderGate({ maxConcurrent: 2 });
    // R4: canReserve only reports cooldown state, not concurrency saturation.
    expect(gate.canReserve(1)).toBe(true);
    expect(gate.canReserve(3)).toBe(true);
    await gate.acquire();
    await gate.acquire();
    expect(gate.activeCount()).toBe(2);
    // canReserve still true (no cooldown) - excess tasks queue.
    expect(gate.canReserve(1)).toBe(true);
  });

  it('blocks new acquires during cooldown', async () => {
    let clock = 1000;
    const gate = new SubagentProviderGate({ maxConcurrent: 3, now: () => clock });
    gate.enterCooldown(500);
    expect(gate.isInCooldown()).toBe(true);
    expect(gate.canReserve(1)).toBe(false);
    expect(gate.cooldownRemainingMs()).toBe(500);
    clock += 500;
    expect(gate.isInCooldown()).toBe(false);
    expect(gate.canReserve(1)).toBe(true);
  });

  it('extends but does not shorten an existing cooldown', () => {
    let clock = 0;
    const gate = new SubagentProviderGate({ maxConcurrent: 3, now: () => clock });
    gate.enterCooldown(1000);
    gate.enterCooldown(200); // shorter, ignored
    expect(gate.cooldownRemainingMs()).toBe(1000);
    gate.enterCooldown(2000); // longer, extends
    expect(gate.cooldownRemainingMs()).toBe(2000);
  });

  it('queues waiters and drains them on release', async () => {
    const gate = new SubagentProviderGate({ maxConcurrent: 1 });
    await gate.acquire();
    let acquired = false;
    const pending = gate.acquire().then(() => { acquired = true; });
    expect(acquired).toBe(false);
    gate.release();
    await pending;
    expect(acquired).toBe(true);
    expect(gate.activeCount()).toBe(1);
    gate.release();
  });

  it('does not drain waiters during cooldown', async () => {
    let clock = 0;
    const { schedule, fire } = fakeScheduler();
    const gate = new SubagentProviderGate({ maxConcurrent: 1, now: () => clock, scheduleTimer: schedule });
    await gate.acquire();
    gate.release(); // slot free
    gate.enterCooldown(1000);
    let acquired = false;
    const pending = gate.acquire().then(() => { acquired = true; });
    // Cooldown blocks even though a slot is free.
    await Promise.resolve();
    expect(acquired).toBe(false);
    clock += 1000;
    // R4: cooldown wake timer fires and drains the queued waiter - no release needed.
    fire();
    await pending;
    expect(acquired).toBe(true);
  });

  it('drains multiple waiters without exceeding maxConcurrent', async () => {
    // Regression test for race condition: drainWaiters must increment
    // active synchronously BEFORE resolving the waiter promise. If it
    // resolves first and increments after, the while-loop would see the
    // stale active count and wake too many waiters.
    const gate = new SubagentProviderGate({ maxConcurrent: 2 });

    // Fill both slots.
    await gate.acquire();
    await gate.acquire();
    expect(gate.activeCount()).toBe(2);

    // Queue 3 waiters (only 2 slots available).
    const waiters = [
      gate.acquire().then(() => 'a'),
      gate.acquire().then(() => 'b'),
      gate.acquire().then(() => 'c'),
    ];

    // Nothing resolved yet - no slots available.
    expect(gate.activeCount()).toBe(2);

    // Release one slot: should drain one waiter (not two).
    gate.release();
    // Let microtasks settle.
    await Promise.resolve();
    // Only one waiter should have been admitted.
    expect(gate.activeCount()).toBe(2);

    // Release the other slot: drains the second waiter.
    gate.release();
    await Promise.resolve();
    expect(gate.activeCount()).toBe(2);

    // Release both - now the third waiter gets in.
    gate.release();
    gate.release();
    await Promise.resolve();
    expect(gate.activeCount()).toBe(1);

    // All three waiters eventually resolved.
    gate.release();
    const results = await Promise.all(waiters);
    expect(results).toEqual(['a', 'b', 'c']);
  });

  // ==========================================================================
  // R4: queueing, cooldown wake timer, abort support
  // ==========================================================================

  it('R4: queues a 3-task parallel batch at maxConcurrent=2 and runs all', async () => {
    const gate = new SubagentProviderGate({ maxConcurrent: 2 });
    const peak = { current: 0, max: 0 };
    const track = async (label: string) => {
      await gate.acquire();
      peak.current += 1;
      peak.max = Math.max(peak.max, peak.current);
      // Hold the slot briefly so overlap is observable.
      await Promise.resolve();
      peak.current -= 1;
      gate.release();
      return label;
    };
    const results = await Promise.all([track('a'), track('b'), track('c')]);
    expect(results).toEqual(['a', 'b', 'c']);
    // Critical assertion: peak concurrency never exceeded maxConcurrent.
    expect(peak.max).toBeLessThanOrEqual(2);
    expect(gate.activeCount()).toBe(0);
  });

  it('R4: serial batch at maxConcurrent=1 runs all tasks to completion', async () => {
    const gate = new SubagentProviderGate({ maxConcurrent: 1 });
    const peak = { current: 0, max: 0 };
    const serial = async (tasks: string[]) => {
      const out: string[] = [];
      for (const t of tasks) {
        await gate.acquire();
        peak.current += 1;
        peak.max = Math.max(peak.max, peak.current);
        await Promise.resolve();
        peak.current -= 1;
        gate.release();
        out.push(t);
      }
      return out;
    };
    const results = await serial(['a', 'b', 'c']);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(peak.max).toBe(1);
    expect(gate.activeCount()).toBe(0);
  });

  it('R4: cooldown wake timer drains queued waiters without a release', async () => {
    let clock = 0;
    const { schedule, fire } = fakeScheduler();
    const gate = new SubagentProviderGate({ maxConcurrent: 1, now: () => clock, scheduleTimer: schedule });
    await gate.acquire(); // slot taken
    gate.enterCooldown(500);
    let acquired = false;
    const pending = gate.acquire().then(() => { acquired = true; });
    await Promise.resolve();
    expect(acquired).toBe(false);
    // Advance past cooldown and release the held slot, but do NOT release
    // again - the wake timer alone must drain.
    clock += 500;
    gate.release(); // free the slot
    fire(); // cooldown wake timer
    await pending;
    expect(acquired).toBe(true);
    expect(gate.activeCount()).toBe(1);
    gate.release();
  });

  it('R4: extending cooldown re-arms the single wake timer', async () => {
    let clock = 0;
    let timersScheduled = 0;
    const schedule = (fn: () => void, _ms: number) => {
      timersScheduled += 1;
      return { clear() { /* test inspects count */ } };
    };
    const gate = new SubagentProviderGate({ maxConcurrent: 1, now: () => clock, scheduleTimer: schedule });
    gate.enterCooldown(500);
    expect(timersScheduled).toBe(1);
    gate.enterCooldown(2000); // longer - re-arm
    expect(timersScheduled).toBe(2);
    gate.enterCooldown(100); // shorter - ignored, no new timer
    expect(timersScheduled).toBe(2);
  });

  it('R4: acquire(signal) rejects queued waiter on abort without leaking a slot', async () => {
    const gate = new SubagentProviderGate({ maxConcurrent: 1 });
    await gate.acquire(); // slot taken
    const ac = new AbortController();
    const pending = gate.acquire(ac.signal);
    // Queued, not resolved.
    await Promise.resolve();
    expect(gate.activeCount()).toBe(1);
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(AcquireAbortedError);
    // No slot leaked: still 1 (the original), waiter removed.
    expect(gate.activeCount()).toBe(1);
    // The queue is empty now; releasing does not over-allocate.
    gate.release();
    expect(gate.activeCount()).toBe(0);
  });

  it('R4: acquire rejects immediately if signal already aborted', async () => {
    const gate = new SubagentProviderGate({ maxConcurrent: 2 });
    const ac = new AbortController();
    ac.abort();
    await expect(gate.acquire(ac.signal)).rejects.toBeInstanceOf(AcquireAbortedError);
    expect(gate.activeCount()).toBe(0);
  });

  it('R4: a fulfilled queued waiter removes its abort listener', async () => {
    const gate = new SubagentProviderGate({ maxConcurrent: 1 });
    await gate.acquire();
    const ac = new AbortController();
    const removeSpy = jest.spyOn(ac.signal, 'removeEventListener');
    const pending = gate.acquire(ac.signal);
    gate.release();
    await pending;
    // Listener removed when the waiter was fulfilled.
    expect(removeSpy).toHaveBeenCalled();
    gate.release();
  });
});
