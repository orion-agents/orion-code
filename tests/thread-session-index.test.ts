import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  ThreadEventStore,
  type AppendRuntimeEventV1,
  type ThreadReadModelHeadV1,
} from '../src/runtime/thread-event-store';
import {
  buildThreadSessionIndexV1,
  loadThreadSessionIndexedPageV1,
  loadThreadSessionIndexManifestV1,
  threadSessionIndexPerformanceCountersV1,
  ThreadSessionIndexError,
  type ThreadSessionIndexHeadV1,
} from '../src/runtime/thread-session-index';

describe('ThreadSessionIndexV1', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('serves immutable tail pages in a fresh process without rescanning the Thread log', () => {
    const countersBefore = threadSessionIndexPerformanceCountersV1();
    const root = mkdtempSync(join(tmpdir(), 'orion-thread-session-index-'));
    roots.push(root);
    let timestamp = 1;
    const store = new ThreadEventStore(root, randomUUID(), { clock: () => timestamp++ });
    const turnId = randomUUID();
    store.appendDurableBatch([
      { payload: { type: 'thread.started', data: {} } },
      {
        turnId,
        payload: { type: 'turn.started', data: { input: 'indexed history', mode: 'build' } },
      },
      ...messageEvents(turnId, 1, 205),
    ]);
    const projection = store.loadProjection();
    const events = store.replay(0, projection.cursor).events;
    const head = store.captureReadModelHead();
    buildThreadSessionIndexV1({
      rootDir: root,
      threadId: store.threadId,
      projection,
      events,
      head: indexHead(head),
    });

    let logScans = 0;
    const reopened = new ThreadEventStore(root, store.threadId, {
      onLogScan: () => {
        logScans += 1;
      },
    });
    const reopenedHead = reopened.captureReadModelHead();
    const latest = loadThreadSessionIndexedPageV1({
      rootDir: root,
      threadId: store.threadId,
      head: indexHead(reopenedHead),
      pageSize: 50,
    });

    expect(logScans).toBe(0);
    expect(latest?.items).toHaveLength(50);
    expect(latest?.items[0]).toMatchObject({ content: 'message-156', timestamp: 314 });
    expect(latest?.items.at(-1)).toMatchObject({ content: 'message-205', timestamp: 412 });
    expect(latest?.offset).toBe(155);
    expect(latest?.nextCursor).toEqual(expect.any(String));

    const older = loadThreadSessionIndexedPageV1({
      rootDir: root,
      threadId: store.threadId,
      head: indexHead(reopenedHead),
      cursor: latest?.nextCursor ?? undefined,
      pageSize: 50,
    });
    expect(older?.items[0].content).toBe('message-106');
    expect(older?.items.at(-1)?.content).toBe('message-155');
    const countersAfter = threadSessionIndexPerformanceCountersV1();
    expect(countersAfter.indexBuilds - countersBefore.indexBuilds).toBe(1);
    expect(countersAfter.manifestReads - countersBefore.manifestReads).toBeGreaterThanOrEqual(2);
    expect(countersAfter.pageReads - countersBefore.pageReads).toBeGreaterThanOrEqual(2);
    expect(countersAfter.bytesRead - countersBefore.bytesRead).toBeGreaterThan(0);
  });

  test('advances the manifest after durable commits and rejects an old revision cursor', () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-thread-session-index-'));
    roots.push(root);
    const store = new ThreadEventStore(root, randomUUID());
    const turnId = randomUUID();
    store.appendDurableBatch([
      { payload: { type: 'thread.started', data: {} } },
      {
        turnId,
        payload: { type: 'turn.started', data: { input: 'cursor binding', mode: 'build' } },
      },
      ...messageEvents(turnId, 1, 60),
    ]);
    const projection = store.loadProjection();
    buildThreadSessionIndexV1({
      rootDir: root,
      threadId: store.threadId,
      projection,
      events: store.replay(0, projection.cursor).events,
      head: indexHead(store.captureReadModelHead()),
    });
    const beforeHead = indexHead(store.captureReadModelHead());
    const before = loadThreadSessionIndexedPageV1({
      rootDir: root,
      threadId: store.threadId,
      head: beforeHead,
      pageSize: 10,
    });
    expect(before?.items.map(item => item.content)).toEqual(
      Array.from({ length: 10 }, (_, index) => `message-${index + 51}`)
    );
    expect(before?.manifest.latestTurn).toMatchObject({
      turnId,
      status: 'active',
    });

    store.appendDurableBatch(messageEvents(turnId, 61, 1));
    const afterHead = indexHead(store.captureReadModelHead());
    const after = loadThreadSessionIndexedPageV1({
      rootDir: root,
      threadId: store.threadId,
      head: afterHead,
      pageSize: 10,
    });
    expect(after?.items.at(-1)?.content).toBe('message-61');

    store.appendDurableBatch([
      {
        turnId,
        payload: {
          type: 'turn.interrupted',
          data: { reason: 'runtime_restarted_before_terminal_commit' },
        },
      },
    ]);
    const interruptedHead = indexHead(store.captureReadModelHead());
    const interrupted = loadThreadSessionIndexedPageV1({
      rootDir: root,
      threadId: store.threadId,
      head: interruptedHead,
      pageSize: 10,
    });
    expect(interrupted?.manifest.latestTurn).toMatchObject({
      turnId,
      status: 'interrupted',
      terminalSeq: interruptedHead.cursor,
    });

    expect(() =>
      loadThreadSessionIndexedPageV1({
        rootDir: root,
        threadId: store.threadId,
        head: interruptedHead,
        cursor: before?.nextCursor ?? undefined,
        pageSize: 10,
      })
    ).toThrow(ThreadSessionIndexError);
    try {
      loadThreadSessionIndexedPageV1({
        rootDir: root,
        threadId: store.threadId,
        head: interruptedHead,
        cursor: before?.nextCursor ?? undefined,
        pageSize: 10,
      });
    } catch (error) {
      expect(error).toMatchObject({ code: 'ORION_THREAD_SESSION_CURSOR_STALE' });
    }
  });

  test('compacts incremental messages into the partial immutable tail page', () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-thread-session-index-'));
    roots.push(root);
    const store = new ThreadEventStore(root, randomUUID());
    const turnId = randomUUID();
    store.appendDurableBatch([
      { payload: { type: 'thread.started', data: {} } },
      {
        turnId,
        payload: { type: 'turn.started', data: { input: 'compact tail', mode: 'build' } },
      },
      ...messageEvents(turnId, 1, 60),
    ]);
    let head = indexHead(store.captureReadModelHead());
    buildThreadSessionIndexV1({
      rootDir: root,
      threadId: store.threadId,
      projection: store.loadProjection(),
      events: store.replay(0, head.cursor).events,
      head,
    });

    for (let ordinal = 61; ordinal <= 100; ordinal += 1) {
      store.appendDurableBatch(messageEvents(turnId, ordinal, 1));
    }
    head = indexHead(store.captureReadModelHead());
    const manifest = loadThreadSessionIndexManifestV1(root, store.threadId, head);
    expect(manifest?.pages).toHaveLength(1);
    expect(manifest?.pages[0]).toMatchObject({ start: 0, end: 100 });

    const countersBefore = threadSessionIndexPerformanceCountersV1();
    const latest = loadThreadSessionIndexedPageV1({
      rootDir: root,
      threadId: store.threadId,
      head,
      pageSize: 50,
    });
    const countersAfter = threadSessionIndexPerformanceCountersV1();
    expect(latest?.items.map(item => item.content)).toEqual(
      Array.from({ length: 50 }, (_, index) => `message-${index + 51}`)
    );
    expect(countersAfter.pageReads - countersBefore.pageReads).toBe(1);
  });

  test('invalidates incremental pages when a late completion belongs before the indexed tail', () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-thread-session-index-'));
    roots.push(root);
    const store = new ThreadEventStore(root, randomUUID());
    const turnId = randomUUID();
    const earlyItemId = randomUUID();
    const laterItemId = randomUUID();
    const earlyStepId = randomUUID();
    const laterStepId = randomUUID();
    store.appendDurableBatch([
      { payload: { type: 'thread.started', data: {} } },
      {
        turnId,
        payload: {
          type: 'turn.started',
          data: { input: 'out-of-order completion', mode: 'build' },
        },
      },
      {
        turnId,
        stepId: earlyStepId,
        itemId: earlyItemId,
        payload: { type: 'item.started', data: { kind: 'message', role: 'assistant' } },
      },
      {
        turnId,
        stepId: laterStepId,
        itemId: laterItemId,
        payload: { type: 'item.started', data: { kind: 'message', role: 'assistant' } },
      },
      {
        turnId,
        stepId: laterStepId,
        itemId: laterItemId,
        payload: { type: 'item.completed', data: { content: 'later-started' } },
      },
    ]);
    let projection = store.loadProjection();
    buildThreadSessionIndexV1({
      rootDir: root,
      threadId: store.threadId,
      projection,
      events: store.replay(0, projection.cursor).events,
      head: indexHead(store.captureReadModelHead()),
    });

    store.appendDurable({
      turnId,
      stepId: earlyStepId,
      itemId: earlyItemId,
      payload: { type: 'item.completed', data: { content: 'early-started' } },
    });
    const head = indexHead(store.captureReadModelHead());

    expect(
      loadThreadSessionIndexedPageV1({
        rootDir: root,
        threadId: store.threadId,
        head,
        pageSize: 10,
      })
    ).toBeUndefined();

    projection = store.loadProjection();
    buildThreadSessionIndexV1({
      rootDir: root,
      threadId: store.threadId,
      projection,
      events: store.replay(0, projection.cursor).events,
      head,
    });
    expect(
      loadThreadSessionIndexedPageV1({
        rootDir: root,
        threadId: store.threadId,
        head,
        pageSize: 10,
      })?.items.map(item => item.content)
    ).toEqual(['early-started', 'later-started']);
  });
});

function messageEvents(turnId: string, first: number, count: number): AppendRuntimeEventV1[] {
  return Array.from({ length: count }, (_, offset) => {
    const ordinal = first + offset;
    const itemId = randomUUID();
    const stepId = randomUUID();
    return [
      {
        turnId,
        stepId,
        itemId,
        payload: {
          type: 'item.started' as const,
          data: { kind: 'message' as const, role: 'assistant' as const },
        },
      },
      {
        turnId,
        stepId,
        itemId,
        payload: { type: 'item.completed' as const, data: { content: `message-${ordinal}` } },
      },
    ];
  }).flat();
}

function indexHead(head: ThreadReadModelHeadV1): ThreadSessionIndexHeadV1 {
  return {
    cursor: head.projection.cursor,
    projectionDigest: head.projection.digest,
    lastEventTimestamp: head.lastEventTimestamp,
    lastRecordHash: head.lastRecordHash,
    log: head.log,
  };
}
