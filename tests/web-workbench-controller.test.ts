import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  appendSessionMessages,
  createSession,
  loadSessionMeta,
} from '../src/services/session-storage';
import { getProjectThreadsV2Dir } from '../src/product/paths';
import { materializeLegacyThreadV1 } from '../src/runtime/legacy-thread-materializer';
import { ThreadEventStore } from '../src/runtime/thread-event-store';
import { loadThreadSessionViewV1 } from '../src/runtime/thread-session-view';
import {
  pageCollectionItems,
  pageItems,
  WebWorkbenchController,
} from '../src/web/workbench-controller';
import { createFakeWebRuntime } from './support/web-runtime';

describe('WebWorkbenchController', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'orion-web-controller-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test('coalesces concurrent retries and rejects request-id reuse with another payload', async () => {
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async cwd => createFakeWebRuntime(cwd),
    });
    let calls = 0;
    let release!: (value: string) => void;
    const pending = new Promise<string>(resolve => {
      release = resolve;
    });

    const first = controller.executeMutation('stable-id', 'test', { value: 1 }, () => {
      calls += 1;
      return pending;
    });
    const retry = controller.executeMutation('stable-id', 'test', { value: 1 }, () => {
      calls += 1;
      return 'duplicate';
    });
    expect(calls).toBe(0);
    await Promise.resolve();
    expect(calls).toBe(1);
    let conflict: unknown;
    try {
      controller.executeMutation('stable-id', 'test', { value: 2 }, () => 'conflict');
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({
      status: 409,
      code: 'request_id_conflict',
      message: 'requestId was already used for another mutation.',
    });

    release('accepted');
    await expect(Promise.all([first, retry])).resolves.toEqual(['accepted', 'accepted']);
    await controller.shutdown();
  });

  test('keeps completed mutation results idempotent for the Host process lifetime', async () => {
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async cwd => createFakeWebRuntime(cwd),
    });
    let victimCalls = 0;
    await expect(
      controller.executeMutation('victim', 'test', { value: 0 }, () => {
        victimCalls += 1;
        return 'original';
      })
    ).resolves.toBe('original');
    for (let index = 0; index < 4_095; index += 1) {
      await controller.executeMutation(`filler-${index}`, 'test', { value: index }, () => index);
    }

    await expect(
      controller.executeMutation('victim', 'test', { value: 0 }, () => {
        victimCalls += 1;
        return 'duplicate';
      })
    ).resolves.toBe('original');
    expect(victimCalls).toBe(1);

    let overflowCalls = 0;
    expect(() =>
      controller.executeMutation('overflow', 'test', { value: 'overflow' }, () => {
        overflowCalls += 1;
        return 'must not run';
      })
    ).toThrow(expect.objectContaining({ status: 503, code: 'mutation_capacity_exhausted' }));
    expect(overflowCalls).toBe(0);
    await controller.shutdown();
  });

  test('rejects commands while a Session rebind is still in progress', async () => {
    const runtime = createFakeWebRuntime(workspace);
    let release!: () => void;
    const rebind = new Promise<void>(resolve => {
      release = resolve;
    });
    runtime.rebindSessionRuntime = jest.fn(() => rebind);
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async () => runtime,
    });

    const creation = controller.createSession('held transition');
    await Promise.resolve();
    const sessionId = controller.runtime.getSession()?.id;
    expect(sessionId).toEqual(expect.any(String));
    await expect(
      controller.dispatch({
        requestId: 'held-command',
        expectedSessionId: sessionId,
        type: 'submit',
        text: 'must not run during rebind',
      })
    ).rejects.toMatchObject({ status: 409, code: 'runtime_busy' });

    release();
    await expect(creation).resolves.toMatchObject({ id: sessionId });
    expect(controller.runtime.store.getSnapshot().isProcessing).toBe(false);
    await controller.shutdown();
  });

  test('uses revision compare-and-swap for secret-free settings', async () => {
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async cwd => createFakeWebRuntime(cwd),
    });
    const before = controller.settings();
    const after = await controller.updateSettings({
      requestId: '7f88f043-4f90-4eca-8d35-224a6123cda2',
      expectedRevision: before.revision,
      operations: [{ op: 'set', key: 'permissions.toolConfirmation', value: 'deny' }],
    });

    expect(after.revision).not.toBe(before.revision);
    expect(after.settings.sections.permissions.toolConfirmation.effectiveValue).toBe('deny');
    expect(after.appliedKeys).toEqual(['permissions.toolConfirmation']);
    await expect(
      controller.updateSettings({
        requestId: 'b4c1ae96-4ef6-49d6-9998-52ed314cc503',
        expectedRevision: before.revision,
        operations: [{ op: 'set', key: 'permissions.toolConfirmation', value: 'allow' }],
      })
    ).rejects.toMatchObject({ status: 409, code: 'settings_revision_conflict' });
    await controller.shutdown();
  });

  test('changes the durable default model without changing the active Session model', async () => {
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async cwd => createFakeWebRuntime(cwd),
    });
    const first = await controller.createSession('first');
    const before = controller.settings();

    const changed = await controller.updateSettings({
      requestId: '85ca501f-3d3f-431a-a4c8-fbd26df5872f',
      expectedRevision: before.revision,
      operations: [{ op: 'set', key: 'defaults.model', value: 'next-model' }],
    });

    expect(changed.settings.sections.defaults.model.effectiveValue).toBe('next-model');
    expect(controller.runtime.store.getSnapshot().currentModel).toBe('test-model');
    expect(loadSessionMeta(first.id)?.model).toBe('test-model');

    const second = await controller.createSession('second');
    expect(loadSessionMeta(second.id)?.model).toBe('next-model');
    expect(controller.runtime.store.getSnapshot().currentModel).toBe('next-model');
    await controller.shutdown();
  });

  test('keeps diagnostics read-only until a Session is explicitly active', async () => {
    const runtime = createFakeWebRuntime(workspace);
    const getHarnessDiagnostics = jest.fn(async () => undefined);
    runtime.getHarnessDiagnostics = getHarnessDiagnostics;
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async () => runtime,
    });

    await expect(controller.diagnostics()).resolves.toMatchObject({
      activeSessionId: null,
      harness: null,
    });
    expect(getHarnessDiagnostics).not.toHaveBeenCalled();
    expect(controller.bootstrap('test-nonce').activeSessionId).toBeNull();

    const session = await controller.createSession('diagnostics session');
    await expect(controller.diagnostics()).resolves.toMatchObject({
      activeSessionId: session.id,
      harness: null,
    });
    expect(getHarnessDiagnostics).toHaveBeenCalledTimes(1);
    await controller.shutdown();
  });

  test('uses opaque bounded collection cursors without skipping items', () => {
    const first = pageItems(['a', 'b', 'c'], undefined, 2);
    expect(first.items).toEqual(['a', 'b']);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = pageItems(['a', 'b', 'c'], first.nextCursor ?? undefined, 2);
    expect(second).toEqual({ items: ['c'], nextCursor: null });
    expect(() => pageItems(['a'], 'not-a-cursor', 1)).toThrow('Page cursor is invalid');
    expect(() => pageItems(['a'], undefined, 101)).toThrow('pageSize');
  });

  test('binds collection cursors to a stable revision and item key', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const first = pageCollectionItems('sessions', items, undefined, 2, item => item.id);
    expect(first.items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = pageCollectionItems(
      'sessions',
      items,
      first.nextCursor ?? undefined,
      2,
      item => item.id
    );
    expect(second).toEqual({ items: [{ id: 'c' }], nextCursor: null });

    expect(() =>
      pageCollectionItems(
        'sessions',
        [{ id: 'new' }, ...items],
        first.nextCursor ?? undefined,
        2,
        item => item.id
      )
    ).toThrow(expect.objectContaining({ status: 409, code: 'collection_cursor_stale' }));
    expect(() =>
      pageCollectionItems('skills', items, first.nextCursor ?? undefined, 2, item => item.id)
    ).toThrow(expect.objectContaining({ status: 400 }));
  });

  test('serves the latest transcript page first and pages backward without collecting history', async () => {
    const session = createSession(workspace, 'test-model');
    appendSessionMessages(
      session.id,
      Array.from({ length: 205 }, (_, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `message-${index + 1}`,
        timestamp: index + 1,
      }))
    );
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async cwd => createFakeWebRuntime(cwd),
    });

    const latest = controller.sessionSnapshot(session.id, undefined, 100, true);
    expect(latest.transcript.items).toHaveLength(100);
    expect(latest.transcript.items[0]).toMatchObject({
      id: `${session.id}:message:106`,
      content: 'message-106',
    });
    expect(latest.transcript.items.at(-1)).toMatchObject({
      id: `${session.id}:message:205`,
      content: 'message-205',
    });

    const middle = controller.sessionSnapshot(
      session.id,
      latest.transcript.nextCursor ?? undefined,
      100,
      true
    );
    expect(middle.transcript.items[0]).toMatchObject({
      id: `${session.id}:message:6`,
      content: 'message-6',
    });
    expect(middle.transcript.items.at(-1)).toMatchObject({
      id: `${session.id}:message:105`,
      content: 'message-105',
    });

    const oldest = controller.sessionSnapshot(
      session.id,
      middle.transcript.nextCursor ?? undefined,
      100,
      true
    );
    expect(oldest.transcript.items.map(item => item.content)).toEqual([
      'message-1',
      'message-2',
      'message-3',
      'message-4',
      'message-5',
    ]);
    expect(oldest.transcript.nextCursor).toBeNull();
    await controller.shutdown();
  });

  test('serves v2 transcript pages without reopening the full projection and stales old cursors', async () => {
    const session = createSession(workspace, 'test-model');
    appendSessionMessages(
      session.id,
      Array.from({ length: 205 }, (_, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `indexed-${index + 1}`,
        timestamp: index + 1,
      }))
    );
    const materialized = materializeLegacyThreadV1({
      projectPath: workspace,
      sessionId: session.id,
    });
    expect(loadThreadSessionViewV1(workspace, session.id)?.messageCount).toBe(205);
    const store = new ThreadEventStore(
      getProjectThreadsV2Dir(workspace),
      materialized.plan.receipt.threadId
    );
    const activeProjection = store.captureReadModelHead().projection;
    rmSync(store.projectionPath);
    expect(existsSync(store.projectionPath)).toBe(false);

    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async cwd => createFakeWebRuntime(cwd),
    });
    controller.runtime.setSession(session);
    const activeRuntimeSlot = controller as unknown as {
      activeOrionRuntime?: {
        readonly sessionId: string;
        readonly runtime: { readonly thread: { getProjection(): typeof activeProjection } };
      };
    };
    activeRuntimeSlot.activeOrionRuntime = {
      sessionId: session.id,
      runtime: { thread: { getProjection: () => activeProjection } },
    };
    const latest = controller.sessionSnapshot(session.id, undefined, 50, true);
    expect(latest.transcript.items).toHaveLength(50);
    expect(latest.transcript.items[0]).toMatchObject({ content: 'indexed-156' });
    expect(latest.transcript.items.at(-1)).toMatchObject({ content: 'indexed-205' });
    expect(existsSync(store.projectionPath)).toBe(false);
    const oldCursor = latest.transcript.nextCursor;

    const turnId = randomUUID();
    const stepId = randomUUID();
    const itemId = randomUUID();
    store.appendDurableBatch([
      {
        turnId,
        payload: { type: 'turn.started', data: { input: 'new indexed message', mode: 'build' } },
      },
      {
        turnId,
        stepId,
        itemId,
        payload: { type: 'item.started', data: { kind: 'message', role: 'assistant' } },
      },
      {
        turnId,
        stepId,
        itemId,
        payload: { type: 'item.completed', data: { content: 'indexed-206' } },
      },
    ]);
    const consistentActive = controller.sessionSnapshot(session.id, undefined, 50, true);
    expect(consistentActive.runtime.active).toBe(true);
    expect(consistentActive.threadCursor).toBe(activeProjection.cursor);
    expect(consistentActive.projectionDigest).toBe(activeProjection.digest);
    expect(consistentActive.transcript.items.at(-1)).toMatchObject({ content: 'indexed-205' });
    expect(consistentActive.transcript.items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ content: 'indexed-206' })])
    );
    expect(() => controller.sessionSnapshot(session.id, oldCursor ?? undefined, 50, true)).toThrow(
      expect.objectContaining({ status: 409, code: 'transcript_cursor_stale' })
    );
    await controller.shutdown();
  });
});
