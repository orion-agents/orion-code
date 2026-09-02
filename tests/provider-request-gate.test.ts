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
    const third = gate.acquire(request(1)).then(lease => {
      thirdLease = lease;
    });

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
    const low = gate.acquire(request(10)).then(lease => {
      lowLease = lease;
      order.push('low');
    });
    const high = gate.acquire(request(1)).then(lease => {
      highLease = lease;
      order.push('high');
    });

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

  it('isolates cooldown by provider while keeping the concurrency budget global', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const gate = new ProviderRequestGate({ maxConcurrent: 2 });
    gate.enterCooldown('provider-a', Date.now() + 500, 'provider-a-retry');

    let leaseA: Awaited<ReturnType<typeof gate.acquire>> | undefined;
    const waitingA = gate.acquire(request(1)).then(lease => (leaseA = lease));
    const leaseB = await gate.acquire({ priority: 2, providerKey: 'provider-b' });

    expect(gate.snapshot('provider-a')).toMatchObject({
      activeCount: 0,
      waitingCount: 1,
      cooldownReason: 'provider-a-retry',
    });
    expect(gate.snapshot('provider-b')).toMatchObject({
      activeCount: 1,
      waitingCount: 0,
      cooldownUntil: null,
    });

    await jest.advanceTimersByTimeAsync(501);
    await waitingA;
    expect(gate.snapshot()).toMatchObject({ activeCount: 2, waitingCount: 0 });
    leaseA?.release();
    leaseB.release();
  });

  it('clamps invalid concurrency to one slot', async () => {
    const gate = new ProviderRequestGate({ maxConcurrent: Number.NaN });
    const first = await gate.acquire(request(1));
    let secondLease: Awaited<ReturnType<typeof gate.acquire>> | undefined;
    const second = gate.acquire(request(1)).then(lease => {
      secondLease = lease;
    });
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
    const execution = coordinator
      .execute(
        {
          logicalRequestId: 'request-1',
          operation: 'root_chat',
          providerKey: 'provider-a',
          requestedModel: 'model-a',
        },
        transport
      )
      .catch(error => error);

    await jest.advanceTimersByTimeAsync(50);
    await jest.advanceTimersByTimeAsync(100);
    const error = await execution;

    expect(error).toBeInstanceOf(ProviderRetryExhaustedError);
    expect(
      error.diagnostics.attempts.map((attempt: { backoffMs?: number }) => attempt.backoffMs)
    ).toEqual([50, 100, undefined]);
    expect(error.diagnostics.totalBackoffMs).toBe(150);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('shares one request budget across independent Session coordinators', async () => {
    const gate = new ProviderRequestGate({ maxConcurrent: 1 });
    const firstCoordinator = new ProviderResilienceCoordinator({ maxTotalAttempts: 1 }, gate);
    const secondCoordinator = new ProviderResilienceCoordinator({ maxTotalAttempts: 1 }, gate);
    const firstHeld = deferred<void>();
    const firstStarted = deferred<void>();
    const order: string[] = [];
    const first = firstCoordinator.execute(
      {
        logicalRequestId: 'session-a',
        operation: 'root_chat',
        providerKey: 'provider-a',
        requestedModel: 'model-a',
      },
      async () => {
        order.push('a:start');
        firstStarted.resolve();
        await firstHeld.promise;
        order.push('a:end');
        return { response: 'a' };
      }
    );
    await firstStarted.promise;

    const second = secondCoordinator.execute(
      {
        logicalRequestId: 'session-b',
        operation: 'root_chat',
        providerKey: 'provider-a',
        requestedModel: 'model-b',
      },
      async () => {
        order.push('b:start');
        return { response: 'b' };
      }
    );
    await Promise.resolve();
    expect(gate.snapshot()).toMatchObject({ activeCount: 1, waitingCount: 1 });
    expect(order).toEqual(['a:start']);

    firstHeld.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ result: 'a' }),
      expect.objectContaining({ result: 'b' }),
    ]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
    expect(gate.snapshot()).toMatchObject({ activeCount: 0, waitingCount: 0 });
  });

  it('classifies an abort while queued at the shared gate as aborted, not failed-fast', async () => {
    const gate = new ProviderRequestGate({ maxConcurrent: 1 });
    const held = await gate.acquire(request(0));
    const coordinator = new ProviderResilienceCoordinator({ maxTotalAttempts: 1 }, gate);
    const abortController = new AbortController();
    const transport = jest.fn();
    const execution = coordinator.execute(
      {
        logicalRequestId: 'session-queued-abort',
        operation: 'root_chat',
        providerKey: 'provider-a',
        requestedModel: 'model-a',
        abortSignal: abortController.signal,
      },
      transport
    );
    await Promise.resolve();
    expect(gate.snapshot()).toMatchObject({ activeCount: 1, waitingCount: 1 });

    abortController.abort();
    await expect(execution).rejects.toMatchObject({
      diagnostics: {
        finalState: 'aborted',
        attempts: [expect.objectContaining({ outcome: 'aborted', failureKind: 'aborted' })],
      },
    });
    expect(transport).not.toHaveBeenCalled();
    expect(gate.snapshot()).toMatchObject({ activeCount: 1, waitingCount: 0 });
    held.release();
    expect(gate.snapshot().activeCount).toBe(0);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
