import {
  WebSessionRuntimeRegistryError,
  WebSessionRuntimeRegistryV1,
  type WebSessionActorKeyV1,
} from '../src/web/session-runtime-registry';

interface TestActor {
  readonly id: string;
}

describe('WebSessionRuntimeRegistryV1', () => {
  it('runs independent Session actors concurrently and isolates terminal state', async () => {
    const harness = createHarness({ maxRunningSessions: 3, maxResidentSessionActors: 4 });
    const a = key('A');
    const b = key('B');
    const aRevision = harness.registry.summary(a).runtimeRevision;
    const bRevision = harness.registry.summary(b).runtimeRevision;
    const aTerminal = deferred<void>();
    const bTerminal = deferred<void>();

    const aAdmission = await harness.registry.admitTurn({
      key: a,
      expectedRuntimeRevision: aRevision,
      start: async actor => ({ accepted: `started:${actor.id}`, settled: aTerminal.promise }),
    });
    const bAdmission = await harness.registry.admitTurn({
      key: b,
      expectedRuntimeRevision: bRevision,
      start: async actor => ({ accepted: `started:${actor.id}`, settled: bTerminal.promise }),
    });

    expect(aAdmission.status).toBe('started');
    expect(bAdmission.status).toBe('started');
    expect(harness.registry.runningCount).toBe(2);
    expect(harness.registry.summary(a).phase).toBe('running');
    expect(harness.registry.summary(b).phase).toBe('running');

    aTerminal.resolve();
    await flushPromises();
    expect(harness.registry.summary(a).phase).toBe('idle');
    expect(harness.registry.summary(b).phase).toBe('running');
    expect(harness.registry.runningCount).toBe(1);

    bTerminal.resolve();
    await flushPromises();
    expect(harness.registry.runningCount).toBe(0);
  });

  it('serializes same-Session admission so concurrent retries cannot start two turns', async () => {
    const harness = createHarness({ maxRunningSessions: 3, maxResidentSessionActors: 4 });
    const actorKey = key('same');
    const revision = harness.registry.summary(actorKey).runtimeRevision;
    const terminal = deferred<void>();
    let starts = 0;
    const admit = () =>
      harness.registry.admitTurn({
        key: actorKey,
        expectedRuntimeRevision: revision,
        start: async () => {
          starts += 1;
          return { accepted: 'started', settled: terminal.promise };
        },
      });

    const results = await Promise.allSettled([admit(), admit()]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ status: 409 }),
    });
    expect(starts).toBe(1);
    expect(harness.registry.runningCount).toBe(1);
    terminal.resolve();
    await flushPromises();
  });

  it('queues the fourth logical turn FIFO and starts it after a slot becomes free', async () => {
    const harness = createHarness({ maxRunningSessions: 1, maxResidentSessionActors: 2 });
    const a = key('A');
    const b = key('B');
    const aTerminal = deferred<void>();
    const bTerminal = deferred<void>();
    let bStarts = 0;

    await harness.registry.admitTurn({
      key: a,
      expectedRuntimeRevision: harness.registry.summary(a).runtimeRevision,
      start: async () => ({ accepted: 'A', settled: aTerminal.promise }),
    });
    const queued = await harness.registry.admitTurn({
      key: b,
      expectedRuntimeRevision: harness.registry.summary(b).runtimeRevision,
      start: async () => {
        bStarts += 1;
        return { accepted: 'B', settled: bTerminal.promise };
      },
    });

    expect(queued).toMatchObject({ status: 'queued', queuePosition: 1 });
    expect(harness.registry.summary(b)).toMatchObject({
      phase: 'queued',
      queueId: queued.status === 'queued' ? queued.queueId : undefined,
      queuePosition: 1,
    });
    expect(bStarts).toBe(0);

    aTerminal.resolve();
    await flushPromises();
    expect(bStarts).toBe(1);
    expect(harness.registry.summary(b).phase).toBe('running');

    bTerminal.resolve();
    await flushPromises();
    expect(harness.registry.summary(b).phase).toBe('idle');
  });

  it('bumps a queued Session revision when its FIFO position changes', async () => {
    const harness = createHarness({ maxRunningSessions: 1, maxResidentSessionActors: 3 });
    const a = key('A');
    const b = key('B');
    const c = key('C');
    const terminal = deferred<void>();
    await harness.registry.admitTurn({
      key: a,
      expectedRuntimeRevision: harness.registry.summary(a).runtimeRevision,
      start: async () => ({ accepted: 'A', settled: terminal.promise }),
    });
    const queuedB = await harness.registry.admitTurn({
      key: b,
      expectedRuntimeRevision: harness.registry.summary(b).runtimeRevision,
      start: async () => ({ accepted: 'B', settled: Promise.resolve() }),
    });
    const queuedC = await harness.registry.admitTurn({
      key: c,
      expectedRuntimeRevision: harness.registry.summary(c).runtimeRevision,
      start: async () => ({ accepted: 'C', settled: Promise.resolve() }),
    });
    if (queuedB.status !== 'queued' || queuedC.status !== 'queued') {
      throw new Error('Expected B and C to queue.');
    }
    expect(queuedC.queuePosition).toBe(2);

    harness.registry.cancelQueued(b, queuedB.queueId, queuedB.runtime.runtimeRevision);

    const shiftedC = harness.registry.summary(c);
    expect(shiftedC.queuePosition).toBe(1);
    expect(shiftedC.runtimeRevision).not.toBe(queuedC.runtime.runtimeRevision);
    expect(() =>
      harness.registry.cancelQueued(c, queuedC.queueId, queuedC.runtime.runtimeRevision)
    ).toThrow(expect.objectContaining({ status: 409, code: 'session_runtime_revision_conflict' }));
    expect(harness.registry.cancelQueued(c, queuedC.queueId, shiftedC.runtimeRevision).phase).toBe(
      'idle'
    );
    terminal.resolve();
  });

  it('evicts only the least-recently-used idle actor and never a running actor', async () => {
    const harness = createHarness({ maxRunningSessions: 1, maxResidentSessionActors: 2 });
    const a = key('A');
    const b = key('B');
    const c = key('C');

    await harness.registry.ensureResident(a, harness.registry.summary(a).runtimeRevision);
    await harness.registry.ensureResident(b, harness.registry.summary(b).runtimeRevision);
    const bRevision = harness.registry.summary(b).runtimeRevision;
    await harness.registry.withActor(b, bRevision, actor => actor.id);
    await harness.registry.ensureResident(c, harness.registry.summary(c).runtimeRevision);

    expect(harness.closed).toContain('workspace:A:idle Session actor evicted by LRU');
    expect(harness.registry.summary(a)).toMatchObject({ phase: 'cold', resident: false });
    expect(harness.registry.summary(b).resident).toBe(true);
    expect(harness.registry.summary(c).resident).toBe(true);

    const cTerminal = deferred<void>();
    await harness.registry.admitTurn({
      key: c,
      expectedRuntimeRevision: harness.registry.summary(c).runtimeRevision,
      start: async () => ({ accepted: 'C', settled: cTerminal.promise }),
    });
    await expect(
      harness.registry.ensureResident(a, harness.registry.summary(a).runtimeRevision)
    ).resolves.toBeDefined();
    expect(harness.closed).toContain('workspace:B:idle Session actor evicted by LRU');
    expect(harness.registry.summary(c).phase).toBe('running');
    cTerminal.resolve();
  });

  it('fails stale revisions before actor creation or turn side effects', async () => {
    const harness = createHarness({ maxRunningSessions: 1, maxResidentSessionActors: 1 });
    const a = key('A');
    let starts = 0;

    await expect(
      harness.registry.admitTurn({
        key: a,
        expectedRuntimeRevision: 'stale',
        start: async () => {
          starts += 1;
          return { accepted: undefined, settled: Promise.resolve() };
        },
      })
    ).rejects.toMatchObject({
      status: 409,
      code: 'session_runtime_revision_conflict',
    });
    expect(harness.created).toEqual([]);
    expect(starts).toBe(0);
  });

  it('closes a newly created actor when post-create accounting fails', async () => {
    const closed: string[] = [];
    const registry = new WebSessionRuntimeRegistryV1<TestActor>({
      maxRunningSessions: 1,
      maxResidentSessionActors: 1,
      createActor: async actorKey => ({ id: `${actorKey.workspaceId}:${actorKey.sessionId}` }),
      closeActor: async (actor, reason) => {
        closed.push(`${actor.id}:${reason}`);
      },
      estimateActorBytes: () => {
        throw new Error('accounting failed');
      },
    });
    const actorKey = key('accounting-failure');

    await expect(
      registry.ensureResident(actorKey, registry.summary(actorKey).runtimeRevision)
    ).rejects.toThrow('accounting failed');
    expect(closed).toEqual(['workspace:accounting-failure:Session actor start failed']);
    expect(registry.residentCount).toBe(0);
    expect(registry.summary(actorKey)).toMatchObject({
      phase: 'failed',
      resident: false,
      estimatedBytes: 0,
    });
  });

  it('quarantines a partially initialized actor until cleanup can be retried', async () => {
    let cleanupBlocked = true;
    let closeAttempts = 0;
    const registry = new WebSessionRuntimeRegistryV1<TestActor>({
      maxRunningSessions: 1,
      maxResidentSessionActors: 1,
      createActor: async actorKey => ({ id: `${actorKey.workspaceId}:${actorKey.sessionId}` }),
      initializeActor: async () => {
        throw new Error('initialization failed');
      },
      closeActor: async () => {
        closeAttempts += 1;
        if (cleanupBlocked) throw new Error('cleanup failed');
      },
      estimateActorBytes: () => 1024,
    });
    const actorKey = key('quarantined');

    await expect(
      registry.ensureResident(actorKey, registry.summary(actorKey).runtimeRevision)
    ).rejects.toMatchObject({ status: 503, code: 'session_actor_cleanup_failed' });
    expect(registry.summary(actorKey)).toMatchObject({ phase: 'failed', resident: true });
    expect(registry.residentActor(actorKey)).toBeUndefined();
    expect(registry.residentCount).toBe(1);

    cleanupBlocked = false;
    await registry.shutdown('retry quarantined cleanup');
    expect(closeAttempts).toBe(2);
    expect(registry.summary(actorKey)).toMatchObject({ phase: 'cold', resident: false });
  });

  it('attempts every actor on shutdown and retains failed cleanup for a later retry', async () => {
    const failedActor = 'workspace:A';
    let failFirstCleanup = true;
    const closed: string[] = [];
    const registry = new WebSessionRuntimeRegistryV1<TestActor>({
      maxRunningSessions: 1,
      maxResidentSessionActors: 2,
      createActor: async actorKey => ({ id: `${actorKey.workspaceId}:${actorKey.sessionId}` }),
      closeActor: async (actor, reason) => {
        closed.push(`${actor.id}:${reason}`);
        if (actor.id === failedActor && failFirstCleanup) throw new Error('close failed');
      },
    });
    const a = key('A');
    const b = key('B');
    await registry.ensureResident(a, registry.summary(a).runtimeRevision);
    await registry.ensureResident(b, registry.summary(b).runtimeRevision);

    await expect(registry.shutdown('first shutdown')).rejects.toMatchObject({
      status: 503,
      code: 'session_actor_cleanup_failed',
    });
    expect(closed).toEqual(['workspace:A:first shutdown', 'workspace:B:first shutdown']);
    expect(registry.summary(a)).toMatchObject({ phase: 'failed', resident: true });
    expect(registry.summary(b)).toMatchObject({ phase: 'cold', resident: false });

    failFirstCleanup = false;
    await registry.shutdown('second shutdown');
    expect(closed).toContain('workspace:A:second shutdown');
    expect(registry.summary(a)).toMatchObject({ phase: 'cold', resident: false });
  });

  it('keeps approval-waiting actors resident and reports a hard capacity limit', async () => {
    const harness = createHarness({ maxRunningSessions: 1, maxResidentSessionActors: 1 });
    const a = key('A');
    const b = key('B');
    const terminal = deferred<void>();
    await harness.registry.admitTurn({
      key: a,
      expectedRuntimeRevision: harness.registry.summary(a).runtimeRevision,
      start: async () => ({ accepted: 'A', settled: terminal.promise }),
    });
    harness.registry.setPendingApprovalCount(a, 1);

    expect(harness.registry.summary(a)).toMatchObject({
      phase: 'waiting_approval',
      pendingApprovalCount: 1,
    });
    await expect(
      harness.registry.ensureResident(b, harness.registry.summary(b).runtimeRevision)
    ).rejects.toMatchObject({ status: 503, code: 'session_concurrency_limit' });
    expect(harness.closed).toEqual([]);
    terminal.resolve();
  });

  it('cancels a queued turn with revision CAS and closes every resident actor on shutdown', async () => {
    const harness = createHarness({ maxRunningSessions: 1, maxResidentSessionActors: 2 });
    const a = key('A');
    const b = key('B');
    const terminal = deferred<void>();
    await harness.registry.admitTurn({
      key: a,
      expectedRuntimeRevision: harness.registry.summary(a).runtimeRevision,
      start: async () => ({ accepted: 'A', settled: terminal.promise }),
    });
    const queued = await harness.registry.admitTurn({
      key: b,
      expectedRuntimeRevision: harness.registry.summary(b).runtimeRevision,
      start: async () => ({ accepted: 'B', settled: Promise.resolve() }),
    });
    if (queued.status !== 'queued') throw new Error('Expected B to queue.');

    const cancelled = harness.registry.cancelQueued(
      b,
      queued.queueId,
      queued.runtime.runtimeRevision
    );
    expect(cancelled.phase).toBe('idle');

    await harness.registry.shutdown('test shutdown');
    expect(harness.closed).toEqual(
      expect.arrayContaining(['workspace:A:test shutdown', 'workspace:B:test shutdown'])
    );
    expect(harness.registry.summary(a).phase).toBe('interrupted');
    expect(harness.registry.summary(b).phase).toBe('cold');
    await expect(harness.registry.ensureResident(key('C'))).rejects.toBeInstanceOf(
      WebSessionRuntimeRegistryError
    );
    terminal.resolve();
  });
});

function createHarness(input: {
  readonly maxRunningSessions: number;
  readonly maxResidentSessionActors: number;
}) {
  const created: string[] = [];
  const closed: string[] = [];
  let revision = 0;
  let now = 0;
  const registry = new WebSessionRuntimeRegistryV1<TestActor>({
    ...input,
    now: () => ++now,
    createRevision: () => `revision-${++revision}`,
    createActor: async actorKey => {
      const id = `${actorKey.workspaceId}:${actorKey.sessionId}`;
      created.push(id);
      return { id };
    },
    closeActor: async (actor, reason) => {
      closed.push(`${actor.id}:${reason}`);
    },
    estimateActorBytes: () => 1024,
  });
  return { registry, created, closed };
}

function key(sessionId: string): WebSessionActorKeyV1 {
  return { workspaceId: 'workspace', sessionId };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}
