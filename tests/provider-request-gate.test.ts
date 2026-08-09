import {
  ProviderRequestGate,
  ProviderResilienceCoordinator,
  ProviderRetryExhaustedError,
} from '../src/services/provider-resilience';

const request = (priority: number, abortSignal?: AbortSignal) => ({
  priority,
  providerKey: 'provider-a',
  abortSignal,
});

describe('ProviderRequestGate', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('queues requests above maxConcurrent and dispatches after release', async () => {
    const gate = new ProviderRequestGate({ maxConcurrent: 2 });
    const first = await gate.acquire(request(1));
    const second = await gate.acquire(request(1));
    let thirdLease: Awaited<ReturnType<typeof gate.acquire>> | undefined;
    const third = gate.acquire(request(1)).then(lease => { thirdLease = lease; });

    await Promise.resolve();
    expect(gate.snapshot()).toMatchObject({ activeCount: 2, waitingCount: 1 });
    first.release();
    await third;
    expect(gate.snapshot()).toMatchObject({ activeCount: 2, waitingCount: 0 });

    first.release(); // idempotent: must not release somebody else's slot
    expect(gate.snapshot().activeCount).toBe(2);
    second.release();
    thirdLease?.release();
    expect(gate.snapshot().activeCount).toBe(0);
  });

  it('dispatches queued requests by priority', async () => {
    const gate = new ProviderRequestGate({ maxConcurrent: 1 });
    const held = await gate.acquire(request(0));
    const order: string[] = [];
    let lowLease: Awaited<ReturnType<typeof gate.acquire>> | undefined;
    let highLease: Awaited<ReturnType<typeof gate.acquire>> | undefined;
    const low = gate.acquire(request(10)).then(lease => { lowLease = lease; order.push('low'); });
    const high = gate.acquire(request(1)).then(lease => { highLease = lease; order.push('high'); });

    held.release();
    await high;
    expect(order).toEqual(['high']);
    highLease?.release();
    await low;
    expect(order).toEqual(['high', 'low']);
    lowLease?.release();
  });

  it('removes an aborted queued request without leaking a slot', async () => {
    const gate = new ProviderRequestGate({ maxConcurrent: 1 });
    const held = await gate.acquire(request(0));
    const controller = new AbortController();
    const queued = gate.acquire(request(1, controller.signal));

    controller.abort();
    await expect(queued).rejects.toThrow('aborted');
    expect(gate.snapshot()).toMatchObject({ activeCount: 1, waitingCount: 0 });
    held.release();
    expect(gate.snapshot().activeCount).toBe(0);
  });

  it('holds a burst during cooldown and resumes after the window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const gate = new ProviderRequestGate({ maxConcurrent: 2 });
    gate.enterCooldown('provider-a', Date.now() + 500, 'retry-after');
    const leases: Array<{ release(): void }> = [];
    const burst = Promise.all([
      gate.acquire(request(1)).then(lease => leases.push(lease)),
      gate.acquire(request(2)).then(lease => leases.push(lease)),
      gate.acquire(request(3)).then(lease => leases.push(lease)),
    ]);

    expect(gate.snapshot()).toMatchObject({ activeCount: 0, waitingCount: 3 });
    await jest.advanceTimersByTimeAsync(499);
    expect(gate.snapshot()).toMatchObject({ activeCount: 0, waitingCount: 3 });
    await jest.advanceTimersByTimeAsync(51);
    expect(gate.snapshot()).toMatchObject({ activeCount: 2, waitingCount: 1 });
    leases[0].release();
    await burst;
    expect(gate.snapshot()).toMatchObject({ activeCount: 2, waitingCount: 0 });
    leases.forEach(lease => lease.release());
  });

  it('keeps the longest cooldown and clears expired diagnostics', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const gate = new ProviderRequestGate({ maxConcurrent: 1 });
    gate.enterCooldown('provider-a', Date.now() + 1000, 'long');
    gate.enterCooldown('provider-a', Date.now() + 100, 'short');
    expect(gate.snapshot()).toMatchObject({
      cooldownUntil: Date.now() + 1000,
      cooldownReason: 'long',
    });

    await jest.advanceTimersByTimeAsync(1050);
    expect(gate.snapshot()).toMatchObject({ cooldownUntil: null, cooldownReason: null });
  });

  it('clamps invalid concurrency to one slot', async () => {
    const gate = new ProviderRequestGate({ maxConcurrent: Number.NaN });
    const first = await gate.acquire(request(1));
    let secondLease: Awaited<ReturnType<typeof gate.acquire>> | undefined;
    const second = gate.acquire(request(1)).then(lease => { secondLease = lease; });
    expect(gate.snapshot()).toMatchObject({ activeCount: 1, waitingCount: 1 });
    first.release();
    await second;
    secondLease?.release();
  });
});

describe('ProviderResilienceCoordinator backoff', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('records exponential jitter backoff steps across retries', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const coordinator = new ProviderResilienceCoordinator({
      maxTotalAttempts: 3,
      maxElapsedMs: 10_000,
      baseDelayMs: 100,
      maxDelayMs: 1000,
    });
    const networkError = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    const transport = jest.fn().mockRejectedValue(networkError);
    const execution = coordinator.execute({
      logicalRequestId: 'request-1',
      operation: 'root_chat',
      providerKey: 'provider-a',
      requestedModel: 'model-a',
    }, transport).catch(error => error);

    await jest.advanceTimersByTimeAsync(50);
    await jest.advanceTimersByTimeAsync(100);
    const error = await execution;

    expect(error).toBeInstanceOf(ProviderRetryExhaustedError);
    expect(error.diagnostics.attempts.map((attempt: { backoffMs?: number }) => attempt.backoffMs))
      .toEqual([50, 100, undefined]);
    expect(error.diagnostics.totalBackoffMs).toBe(150);
    expect(transport).toHaveBeenCalledTimes(3);
  });
});
