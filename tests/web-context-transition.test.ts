import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createSession } from '../src/services/session-storage';
import { WorkspaceRegistryV1 } from '../src/services/workspace-registry';
import { WebEventHub } from '../src/web/event-hub';
import { WebWorkbenchController } from '../src/web/workbench-controller';
import { createFakeWebRuntime } from './support/web-runtime';

describe('Web Context transition', () => {
  let root: string;
  let firstWorkspace: string;
  let secondWorkspace: string;
  let failingWorkspace: string;
  let registry: WorkspaceRegistryV1;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-web-context-'));
    firstWorkspace = join(root, 'first');
    secondWorkspace = join(root, 'second');
    failingWorkspace = join(root, 'failing');
    mkdirSync(firstWorkspace);
    mkdirSync(secondWorkspace);
    mkdirSync(failingWorkspace);
    firstWorkspace = realpathSync(firstWorkspace);
    secondWorkspace = realpathSync(secondWorkspace);
    failingWorkspace = realpathSync(failingWorkspace);
    registry = new WorkspaceRegistryV1({ storagePath: join(root, 'registry.json') });
    registry.registerKnown([firstWorkspace, secondWorkspace, failingWorkspace], firstWorkspace);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('lists inactive Workspace Sessions without constructing another Runtime', async () => {
    const first = createSession(firstWorkspace, 'test-model');
    const second = createSession(secondWorkspace, 'test-model');
    const createRuntime = jest.fn(async (cwd: string) => createFakeWebRuntime(cwd));
    const controller = await WebWorkbenchController.create({
      cwd: firstWorkspace,
      workspaceRegistry: registry,
      createRuntime,
    });
    const secondEntry = registry.list().find(entry => entry.canonicalPath === secondWorkspace);

    expect(secondEntry).toBeDefined();
    expect(controller.listWorkspaceSessions(secondEntry!.id)).toEqual([
      expect.objectContaining({ id: second.id, projectPath: secondWorkspace }),
    ]);
    expect(controller.listSessions()).toEqual([
      expect.objectContaining({ id: first.id, projectPath: firstWorkspace }),
    ]);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    await controller.shutdown();
  });

  test('atomically switches Workspace and Session behind one Context revision', async () => {
    const first = createSession(firstWorkspace, 'test-model');
    const second = createSession(secondWorkspace, 'test-model');
    const hub = new WebEventHub();
    const createRuntime = jest.fn(async (cwd: string) => createFakeWebRuntime(cwd));
    const controller = await WebWorkbenchController.create({
      cwd: firstWorkspace,
      eventHub: hub,
      workspaceRegistry: registry,
      createRuntime,
    });
    await controller.createSession('active first');
    const before = controller.bootstrap('nonce');
    const secondEntry = registry.list().find(entry => entry.canonicalPath === secondWorkspace)!;
    const emit = jest.spyOn(hub, 'emit');

    await controller.activateContext({
      expectedContextRevision: before.contextRevision,
      workspaceId: secondEntry.id,
      sessionId: second.id,
    });

    const after = controller.bootstrap('nonce');
    expect(after).toMatchObject({
      workspaceId: secondEntry.id,
      workspace: secondWorkspace,
      activeSessionId: second.id,
    });
    expect(after.contextRevision).not.toBe(before.contextRevision);
    expect(createRuntime.mock.calls.map(call => call[0])).toEqual([
      firstWorkspace,
      secondWorkspace,
    ]);
    const stateEdges = emit.mock.calls
      .map(call => call[0])
      .filter(event => event.type === 'workbench_state');
    expect(stateEdges).toEqual([
      expect.objectContaining({
        contextRevision: after.contextRevision,
        workspaceId: secondEntry.id,
        workspace: secondWorkspace,
        activeSessionId: second.id,
      }),
    ]);
    expect(
      emit.mock.calls.map(call => call[0]).filter(event => event.type === 'runtime_event')
    ).toEqual([]);
    await expect(
      controller.dispatch({
        requestId: 'stale-first-command',
        expectedSessionId: first.id,
        type: 'submit',
        text: 'must not cross Contexts',
      })
    ).rejects.toMatchObject({ status: 409, code: 'active_session_changed' });
    await controller.shutdown();
  });

  test('acquires the target Session before releasing the previous Workspace owner', async () => {
    const first = createSession(firstWorkspace, 'test-model');
    const second = createSession(secondWorkspace, 'test-model');
    const events: string[] = [];
    const createRuntime = jest.fn(async (cwd: string) => {
      const runtime = createFakeWebRuntime(cwd);
      if (cwd === firstWorkspace) {
        const shutdown = runtime.shutdown;
        runtime.shutdown = async () => {
          events.push('previous:shutdown');
          await shutdown();
        };
      } else if (cwd === secondWorkspace) {
        const activateSession = runtime.activateSession;
        runtime.activateSession = async (session, activation) => {
          events.push(`target:activate:${session.id}`);
          if (!activateSession) throw new Error('test runtime activation is unavailable');
          await activateSession(session, activation);
        };
      }
      return runtime;
    });
    const controller = await WebWorkbenchController.create({
      cwd: firstWorkspace,
      workspaceRegistry: registry,
      createRuntime,
    });
    await controller.activateSession(first.id);
    events.splice(0);
    const target = registry.list().find(entry => entry.canonicalPath === secondWorkspace)!;

    await controller.activateContext({
      expectedContextRevision: controller.contextRevision,
      workspaceId: target.id,
      sessionId: second.id,
    });

    expect(events[0]).toBe(`target:activate:${second.id}`);
    expect(events.indexOf('previous:shutdown')).toBeGreaterThan(0);
    expect(controller.runtime.getSession()?.id).toBe(second.id);
    await controller.shutdown();
  });

  test('rejects stale revisions and cross-Workspace Session identities before draining Runtime', async () => {
    const second = createSession(secondWorkspace, 'test-model');
    const createRuntime = jest.fn(async (cwd: string) => createFakeWebRuntime(cwd));
    const controller = await WebWorkbenchController.create({
      cwd: firstWorkspace,
      workspaceRegistry: registry,
      createRuntime,
    });
    const firstEntry = registry.list().find(entry => entry.canonicalPath === firstWorkspace)!;
    const secondEntry = registry.list().find(entry => entry.canonicalPath === secondWorkspace)!;

    await expect(
      controller.activateContext({
        expectedContextRevision: '00000000-0000-4000-8000-000000000000',
        workspaceId: secondEntry.id,
        sessionId: second.id,
      })
    ).rejects.toMatchObject({ status: 409, code: 'context_revision_conflict' });
    await expect(
      controller.activateContext({
        expectedContextRevision: controller.contextRevision,
        workspaceId: firstEntry.id,
        sessionId: second.id,
      })
    ).rejects.toMatchObject({ status: 409, code: 'context_session_mismatch' });
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(controller.workspace).toBe(firstWorkspace);
    await controller.shutdown();
  });

  test('restores the previous Context without advancing its revision when target startup fails', async () => {
    const first = createSession(firstWorkspace, 'test-model');
    const createRuntime = jest.fn(async (cwd: string) => {
      if (cwd === failingWorkspace) throw new Error('target runtime failed');
      return createFakeWebRuntime(cwd);
    });
    const hub = new WebEventHub();
    const controller = await WebWorkbenchController.create({
      cwd: firstWorkspace,
      eventHub: hub,
      workspaceRegistry: registry,
      createRuntime,
    });
    await controller.activateSession(first.id);
    const before = controller.bootstrap('nonce');
    const failingEntry = registry.list().find(entry => entry.canonicalPath === failingWorkspace)!;
    const emit = jest.spyOn(hub, 'emit');

    await expect(
      controller.activateContext({
        expectedContextRevision: before.contextRevision,
        workspaceId: failingEntry.id,
        sessionId: null,
      })
    ).rejects.toThrow('target runtime failed');

    expect(controller.bootstrap('nonce')).toMatchObject({
      contextRevision: before.contextRevision,
      workspace: firstWorkspace,
      activeSessionId: first.id,
    });
    expect(
      emit.mock.calls.map(call => call[0]).filter(event => event.type === 'workbench_state')
    ).toEqual([]);
    expect(
      emit.mock.calls.map(call => call[0]).filter(event => event.type === 'runtime_event')
    ).toEqual([]);
    expect(createRuntime.mock.calls.map(call => call[0])).toEqual([
      firstWorkspace,
      failingWorkspace,
    ]);
    await controller.shutdown();
  });

  test('rejects unrelated mutations while a Context transition is in flight', async () => {
    let releaseTarget!: () => void;
    const targetReady = new Promise<void>(resolve => {
      releaseTarget = resolve;
    });
    let targetStarted!: () => void;
    const targetStarting = new Promise<void>(resolve => {
      targetStarted = resolve;
    });
    const createRuntime = jest.fn(async (cwd: string) => {
      if (cwd === secondWorkspace) {
        targetStarted();
        await targetReady;
      }
      return createFakeWebRuntime(cwd);
    });
    const controller = await WebWorkbenchController.create({
      cwd: firstWorkspace,
      workspaceRegistry: registry,
      createRuntime,
    });
    const secondEntry = registry.list().find(entry => entry.canonicalPath === secondWorkspace)!;
    const originalContext = {
      expectedContextRevision: controller.contextRevision,
      workspaceId: controller.bootstrap('nonce').workspaceId,
    };
    const transition = controller.activateContext({
      expectedContextRevision: controller.contextRevision,
      workspaceId: secondEntry.id,
      sessionId: null,
    });
    await targetStarting;
    const mutation = jest.fn(() => true);

    await expect(
      controller.executeMutation(
        'blocked-during-context-transition',
        'workspace.pin',
        { workspaceId: secondEntry.id },
        mutation
      )
    ).rejects.toMatchObject({ status: 409, code: 'runtime_busy' });
    expect(mutation).not.toHaveBeenCalled();
    expect(() => controller.listFiles(originalContext, { pageSize: 10 })).toThrow(
      expect.objectContaining({ status: 409, code: 'runtime_busy' })
    );
    expect(() => controller.listSessions(originalContext)).toThrow(
      expect.objectContaining({ status: 409, code: 'runtime_busy' })
    );

    releaseTarget();
    await transition;
    await controller.shutdown();
  });
});
