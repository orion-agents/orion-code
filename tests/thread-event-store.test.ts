import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';

import { ThreadEventStore, ThreadEventStoreError } from '../src/runtime/thread-event-store';
import { ThreadProjectionInvariantError } from '../src/runtime/thread-projection';

describe('ThreadEventStore', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function createStore(
    options: ConstructorParameters<typeof ThreadEventStore>[2] = {}
  ): ThreadEventStore {
    const root = mkdtempSync(join(tmpdir(), 'orion-thread-events-'));
    roots.push(root);
    return new ThreadEventStore(root, randomUUID(), options);
  }

  test('assigns monotonic durable sequences and cursor-replays bounded pages', () => {
    const store = createStore({ maxReplayEvents: 2 });
    const turnId = randomUUID();
    const first = store.appendDurable({
      payload: { type: 'thread.started', data: { projectPath: '/workspace' } },
    });
    const second = store.appendDurable({
      turnId,
      payload: { type: 'turn.started', data: { input: 'fix tests', mode: 'build' } },
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(store.replay(0, 1)).toMatchObject({
      fromCursor: 0,
      nextCursor: 1,
      hasMore: true,
    });
    expect(store.replay(1, 1).events[0]).toMatchObject({ seq: 2, turnId });
    expect(() => store.replay(0, 3)).toThrow(ThreadEventStoreError);
    expect(() => store.replay(3, 1)).toThrow(/ahead of durable cursor/);
  });

  test('builds an immutable projection with exactly one item terminal event', () => {
    const store = createStore();
    const turnId = randomUUID();
    const stepId = randomUUID();
    const itemId = randomUUID();
    store.appendDurableBatch([
      { payload: { type: 'thread.started', data: {} } },
      {
        turnId,
        payload: { type: 'turn.started', data: { input: 'hello', mode: 'build' } },
      },
      {
        turnId,
        stepId,
        itemId,
        payload: { type: 'item.started', data: { kind: 'message' } },
      },
      {
        turnId,
        stepId,
        itemId,
        payload: { type: 'item.completed', data: { summary: 'done' } },
      },
      { turnId, payload: { type: 'turn.completed', data: { outcome: 'verified' } } },
    ]);

    const projection = store.loadProjection();
    expect(projection).toMatchObject({ cursor: 5, status: 'idle' });
    expect(projection.items[itemId]).toMatchObject({ status: 'completed', terminalSeq: 4 });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.items[itemId])).toBe(true);

    expect(() =>
      store.appendDurable({
        turnId,
        stepId,
        itemId,
        payload: { type: 'item.failed', data: { error: 'duplicate' } },
      })
    ).toThrow(ThreadProjectionInvariantError);
    expect(store.getCursor()).toBe(5);
  });

  test('keeps streaming cursor reads and local appends independent of historical log size', () => {
    let logScans = 0;
    const store = createStore({
      onLogScan: () => {
        logScans += 1;
      },
    });
    const turnId = randomUUID();
    const stepId = randomUUID();
    const itemId = randomUUID();

    store.appendDurable({ payload: { type: 'thread.started', data: {} } });
    expect(logScans).toBe(1);

    for (let index = 0; index < 100; index += 1) {
      expect(
        store.createEphemeral({
          turnId,
          stepId,
          itemId,
          payload: { type: 'item.delta', data: { delta: `chunk-${index}`, channel: 'content' } },
        }).seq
      ).toBe(1);
    }
    expect(store.getCursor()).toBe(1);

    store.appendDurable({
      turnId,
      payload: { type: 'turn.started', data: { input: 'continue', mode: 'build' } },
    });
    expect(store.getCursor()).toBe(2);
    expect(logScans).toBe(1);
  });

  test('invalidates the verified head when another store commits', () => {
    let logScans = 0;
    const store = createStore({
      onLogScan: () => {
        logScans += 1;
      },
    });
    store.appendDurable({ payload: { type: 'thread.started', data: {} } });
    expect(logScans).toBe(1);

    const other = new ThreadEventStore(store.rootDir, store.threadId);
    other.appendDurable({
      turnId: randomUUID(),
      payload: { type: 'turn.started', data: { input: 'external', mode: 'build' } },
    });

    expect(store.getCursor()).toBe(2);
    expect(logScans).toBe(2);
  });

  test('captures projection and exact log identity from one verified head', () => {
    let logScans = 0;
    const store = createStore({
      onLogScan: () => {
        logScans += 1;
      },
    });
    const committed = store.appendDurable({
      payload: { type: 'thread.started', data: { projectPath: '/workspace' } },
    });

    const first = store.captureReadModelHead();
    const second = store.captureReadModelHead();

    expect(first).toMatchObject({
      projection: { cursor: committed.seq },
      lastEventTimestamp: committed.timestamp,
      lastRecordHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      log: {
        bytes: expect.any(Number),
        device: expect.stringMatching(/^\d+$/),
        inode: expect.stringMatching(/^\d+$/),
        mtimeNs: expect.stringMatching(/^\d+$/),
        ctimeNs: expect.stringMatching(/^\d+$/),
      },
    });
    expect(second).toEqual(first);
    expect(logScans).toBe(1);
  });

  test('recovers a flushed event when projection publication crashes', () => {
    let crash = true;
    const store = createStore({
      onBoundary: boundary => {
        if (crash && boundary === 'before_projection_write') {
          crash = false;
          throw new Error('simulated projection crash');
        }
      },
    });

    expect(() => store.appendDurable({ payload: { type: 'thread.started', data: {} } })).toThrow(
      'simulated projection crash'
    );

    const resumed = new ThreadEventStore(store.rootDir, store.threadId);
    expect(resumed.loadProjection()).toMatchObject({ cursor: 1, status: 'idle' });
    expect(resumed.replay().events).toHaveLength(1);
  });

  test('discards only an unflushed partial tail before the next append', () => {
    const store = createStore();
    store.appendDurable({ payload: { type: 'thread.started', data: {} } });
    appendFileSync(store.logPath, '{"partial":');

    const turnId = randomUUID();
    store.appendDurable({
      turnId,
      payload: { type: 'turn.started', data: { input: 'resume', mode: 'build' } },
    });

    expect(store.getCursor()).toBe(2);
    expect(readFileSync(store.logPath, 'utf8')).not.toContain('"partial"');
  });

  test('rejects interior corruption and a modified hash chain', () => {
    const store = createStore();
    store.appendDurable({ payload: { type: 'thread.started', data: {} } });
    const record = JSON.parse(readFileSync(store.logPath, 'utf8').trim()) as {
      event: { timestamp: number };
    };
    record.event.timestamp += 1;
    writeFileSync(store.logPath, `${JSON.stringify(record)}\n`);

    expect(() => store.getCursor()).toThrow(/hash mismatch/);
  });

  test('marks orphaned items indeterminate and interrupts the active turn', () => {
    const store = createStore();
    const turnId = randomUUID();
    const stepId = randomUUID();
    const itemId = randomUUID();
    store.appendDurableBatch([
      { payload: { type: 'thread.started', data: {} } },
      {
        turnId,
        payload: { type: 'turn.started', data: { input: 'edit', mode: 'auto' } },
      },
      {
        turnId,
        stepId,
        itemId,
        payload: { type: 'item.started', data: { kind: 'file_change' } },
      },
    ]);

    const recovered = store.recoverIncomplete();
    expect(recovered.items[itemId]).toMatchObject({
      status: 'indeterminate',
      error: 'runtime_restarted_before_terminal_commit',
    });
    expect(recovered.turns[turnId]).toMatchObject({ status: 'interrupted' });
    expect(recovered.cursor).toBe(5);
  });

  test('rebuilds rather than trusting a projection ahead of the durable log', () => {
    const store = createStore();
    store.appendDurable({ payload: { type: 'thread.started', data: {} } });
    const projection = store.loadProjection();
    writeFileSync(
      store.projectionPath,
      JSON.stringify({ ...projection, cursor: 99, digest: 'not-the-log-digest' })
    );

    expect(store.loadProjection()).toMatchObject({ cursor: 1, digest: projection.digest });
  });

  test('serializes durable sequence allocation across processes', async () => {
    const store = createStore({ lockWaitMs: 30_000 });
    store.appendDurable({ payload: { type: 'thread.started', data: {} } });
    const worker = join(__dirname, 'fixtures/thread-event-writer.js');

    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        runWorker(worker, [store.rootDir, store.threadId, `writer-${index}`, '10'])
      )
    );

    const replay = store.replay(0, 100);
    expect(replay.events).toHaveLength(41);
    expect(replay.events.map(event => event.seq)).toEqual(
      Array.from({ length: 41 }, (_, index) => index + 1)
    );
    expect(new Set(replay.events.map(event => event.eventId)).size).toBe(41);
    expect(store.loadProjection()).toMatchObject({ cursor: 41, status: 'idle' });
  });
});

function runWorker(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`thread event writer exited ${code}: ${stderr}`));
    });
  });
}
