import {
  ResourceActivationError,
  ResourceScope,
  ResourceScopeStateError,
  StaleResourceEpochError,
} from '../src/runtime/resource-scope';

describe('v0.2.0 ResourceScope lifecycle', () => {
  test('disposes resources in LIFO order', async () => {
    const scope = new ResourceScope({ id: 'lifo' });
    const order: string[] = [];
    scope.register('first', () => {
      order.push('first');
    });
    scope.register('second', () => {
      order.push('second');
    });
    scope.register('third', () => {
      order.push('third');
    });

    const report = await scope.close({ reason: 'test_complete' });

    expect(order).toEqual(['third', 'second', 'first']);
    expect(report).toMatchObject({
      scopeId: 'lifo',
      reason: 'test_complete',
      timedOut: false,
      leaseTimedOut: false,
      disposed: ['third', 'second', 'first'],
      errors: [],
    });
    expect(scope.state).toBe('closed');
  });

  test('rolls back previously activated resources when activation fails', async () => {
    const scope = new ResourceScope({ id: 'rollback' });
    const order: string[] = [];
    await scope.activate({
      id: 'database',
      activate: () => ({
        value: 'db',
        dispose: () => {
          order.push('database');
        },
      }),
    });
    await scope.activate({
      id: 'watcher',
      activate: () => ({
        value: 'watcher',
        dispose: () => {
          order.push('watcher');
        },
      }),
    });

    const activation = scope.activate({
      id: 'transport',
      activate: () => {
        throw new Error('transport unavailable');
      },
    });

    await expect(activation).rejects.toMatchObject({
      name: 'ResourceActivationError',
      resourceId: 'transport',
      rollback: { disposed: ['watcher', 'database'] },
    });
    await expect(activation).rejects.toBeInstanceOf(ResourceActivationError);
    expect(order).toEqual(['watcher', 'database']);
    expect(scope.state).toBe('closed');
  });

  test('caches close and invokes each disposer exactly once', async () => {
    const scope = new ResourceScope({ id: 'idempotent' });
    let disposeCount = 0;
    scope.register('resource', () => {
      disposeCount++;
    });

    const first = scope.close();
    const second = scope.close({ reason: 'ignored_after_first_close' });

    expect(second).toBe(first);
    expect(await first).toBe(await second);
    expect(disposeCount).toBe(1);
  });

  test('drains existing leases and rejects new leases while closing', async () => {
    const scope = new ResourceScope({ id: 'leases' });
    const lease = scope.acquireLease('in-flight-call');
    const closing = scope.close({ deadlineMs: 250 });
    let closed = false;
    void closing.then(() => {
      closed = true;
    });

    await Promise.resolve();
    expect(scope.state).toBe('draining');
    expect(closed).toBe(false);
    expect(() => scope.acquireLease('late-call')).toThrow(ResourceScopeStateError);

    lease.release();
    lease.release();
    const report = await closing;
    expect(report.leaseTimedOut).toBe(false);
    expect(scope.activeLeaseCount).toBe(0);
    expect(scope.state).toBe('closed');
  });

  test('bounds an uncooperative disposer by the teardown deadline', async () => {
    const scope = new ResourceScope({ id: 'deadline', deadlineMs: 15 });
    scope.register('hung-resource', () => new Promise<void>(() => undefined));
    const startedAt = Date.now();

    const report = await scope.close();

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(report).toMatchObject({
      timedOut: true,
      leaseTimedOut: false,
      disposed: ['hung-resource'],
    });
  });

  test('discards an async activation result from a stale epoch', async () => {
    const scope = new ResourceScope({ id: 'epochs' });
    let resolveActivation: ((value: { value: string; dispose: () => void }) => void) | undefined;
    let staleDisposeCount = 0;
    const pending = scope.activate({
      id: 'slow-resource',
      activate: () =>
        new Promise<{ value: string; dispose: () => void }>(resolve => {
          resolveActivation = resolve;
        }),
    });

    scope.advanceEpoch();
    resolveActivation?.({
      value: 'late',
      dispose: () => {
        staleDisposeCount++;
      },
    });

    await expect(pending).rejects.toBeInstanceOf(StaleResourceEpochError);
    expect(staleDisposeCount).toBe(1);
    expect(scope.activeResourceCount).toBe(0);
    expect(scope.state).toBe('active');
    await scope.close();
  });

  test('commits only results owned by the current active epoch', async () => {
    const scope = new ResourceScope({ id: 'commit-epoch' });
    const firstEpoch = scope.captureEpoch();
    let commits = 0;

    expect(scope.commitIfCurrent(firstEpoch, () => ++commits)).toBe(1);
    scope.advanceEpoch();
    expect(scope.commitIfCurrent(firstEpoch, () => ++commits)).toBeUndefined();
    expect(scope.commitIfCurrent(scope.captureEpoch(), () => ++commits)).toBe(2);

    await scope.close();
    expect(scope.commitIfCurrent(scope.captureEpoch(), () => ++commits)).toBeUndefined();
    expect(commits).toBe(2);
  });

  test('releases every fake resource across 1,000 scope churn cycles', async () => {
    let activeResources = 0;
    let disposedResources = 0;

    for (let cycle = 0; cycle < 1_000; cycle++) {
      const scope = new ResourceScope({ id: `churn-${cycle}` });
      for (const suffix of ['model', 'tool', 'mcp']) {
        await scope.activate({
          id: suffix,
          activate: () => {
            activeResources++;
            return {
              value: suffix,
              dispose: () => {
                activeResources--;
                disposedResources++;
              },
            };
          },
        });
      }
      const lease = scope.acquireLease('turn');
      lease.release();
      const report = await scope.close();
      expect(report.errors).toHaveLength(0);
      expect(scope.activeResourceCount).toBe(0);
    }

    expect(activeResources).toBe(0);
    expect(disposedResources).toBe(3_000);
  });
});
