import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  appendSessionMessages,
  createSession,
  loadSessionMeta,
} from '../src/services/session-storage';
import { pageItems, WebWorkbenchController } from '../src/web/workbench-controller';
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
});
