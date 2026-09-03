import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

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

  test('atomically switches Workspace while keeping foreground Session browser-local', async () => {
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
    const firstRuntimeRevision = controller.sessionRuntimeSummary(first.id).runtimeRevision;
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
      activeSessionId: null,
    });
    expect(controller.sessionRuntimeSummary(second.id)).toMatchObject({
      workspaceId: secondEntry.id,
      sessionId: second.id,
      phase: 'cold',
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
        activeSessionId: null,
      }),
    ]);
    expect(
      emit.mock.calls.map(call => call[0]).filter(event => event.type === 'runtime_event')
    ).toEqual([]);
    await expect(
      controller.dispatch({
        requestId: randomUUID(),
        workspaceId: before.workspaceId,
        expectedContextRevision: before.contextRevision,
        expectedSessionId: first.id,
        expectedSessionRuntimeRevision: firstRuntimeRevision,
        type: 'submit',
        text: 'must not cross Contexts',
      })
    ).rejects.toMatchObject({ status: 409, code: 'context_revision_conflict' });
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
    createSession(firstWorkspace, 'test-model');
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
      activeSessionId: null,
    });
    expect(
      emit.mock.calls.map(call => call[0]).filter(event => event.type === 'workbench_state')
    ).toEqual([]);
    expect(
      emit.mock.calls.map(call => call[0]).filter(event => event.type === 'runtime_event')
    ).toEqual([]);
    // P1-A: when installing the target control plane fails, the previous control
    // plane is still live (this.runtimeValue was never replaced), so the rollback
    // restores the previous foreground without reinstantiating its Runtime.
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

  test('does not admit a Context transition over an in-flight mutation', async () => {
    const controller = await WebWorkbenchController.create({
      cwd: firstWorkspace,
      workspaceRegistry: registry,
      createRuntime: async cwd => createFakeWebRuntime(cwd),
    });
    const secondEntry = registry.list().find(entry => entry.canonicalPath === secondWorkspace)!;
    const mutationStarted = deferred<void>();
    const mutationRelease = deferred<void>();
    const mutation = controller.executeMutation(
      'held-settings-mutation',
      'settings.update',
      { value: 'held' },
      async () => {
        mutationStarted.resolve();
        await mutationRelease.promise;
        return true;
      }
    );
    await mutationStarted.promise;

    await expect(
      controller.activateContext({
        expectedContextRevision: controller.contextRevision,
        workspaceId: secondEntry.id,
        sessionId: null,
      })
    ).rejects.toMatchObject({ status: 409, code: 'runtime_busy' });
    const transitionAction = jest.fn();
    await expect(
      controller.executeMutation(
        randomUUID(),
        'context.activate',
        { workspaceId: secondEntry.id },
        transitionAction
      )
    ).rejects.toMatchObject({ status: 409, code: 'runtime_busy' });
    expect(transitionAction).not.toHaveBeenCalled();
    expect(controller.workspace).toBe(firstWorkspace);

    mutationRelease.resolve();
    await mutation;
    await controller.activateContext({
      expectedContextRevision: controller.contextRevision,
      workspaceId: secondEntry.id,
      sessionId: null,
    });
    expect(controller.workspace).toBe(secondWorkspace);
    await controller.shutdown();
  });

  test('keeps a running Session actor alive across a Workspace Context switch (WEB35-P0-08/09)', async () => {
    const session = createSession(firstWorkspace, 'test-model');
    const actorRuntime = createFakeWebRuntime(firstWorkspace);
    const turn = deferred<void>();
    actorRuntime.createAgentRunner = () => ({ runInput: jest.fn(() => turn.promise) });
    const controller = await WebWorkbenchController.create({
      cwd: firstWorkspace,
      workspaceRegistry: registry,
      createRuntime: async cwd => createFakeWebRuntime(cwd),
      createSessionRuntime: async () => actorRuntime,
    });
    const bootstrap = controller.bootstrap('nonce');
    const firstEntry = registry.list().find(entry => entry.canonicalPath === firstWorkspace)!;
    const secondEntry = registry.list().find(entry => entry.canonicalPath === secondWorkspace)!;
    await controller.dispatch({
      requestId: randomUUID(),
      workspaceId: bootstrap.workspaceId,
      expectedContextRevision: bootstrap.contextRevision,
      expectedSessionId: session.id,
      expectedSessionRuntimeRevision: controller.sessionRuntimeSummary(session.id).runtimeRevision,
      type: 'submit',
      text: 'keep running in the first Workspace',
    });
    expect(controller.sessionRuntimeSummary(session.id).phase).toBe('running');

    // P1-A: a running Session actor of the previous Workspace no longer blocks
    // the Context switch (WEB35-P0-08/09). Only the active control plane swaps;
    // the actor keeps running on the Workspace kernel it was created with.
    await controller.activateContext({
      expectedContextRevision: controller.contextRevision,
      workspaceId: secondEntry.id,
      sessionId: null,
    });
    expect(controller.workspace).toBe(secondWorkspace);
    expect(actorRuntime.shutdown).not.toHaveBeenCalled();
    // Session summaries are scoped to the active Workspace; the first-Workspace
    // actor is observable again after switching back below.

    turn.resolve();
    await controller.activateContext({
      expectedContextRevision: controller.contextRevision,
      workspaceId: firstEntry.id,
      sessionId: null,
    });
    expect(controller.workspace).toBe(firstWorkspace);
    // The resident actor instance survived both switches: no rebuild, same
    // runtime, and its turn completed to idle.
    await waitForCondition(
      () => controller.sessionRuntimeSummary(session.id).phase === 'idle',
      'first-Workspace Session actor to become idle'
    );
    expect(actorRuntime.shutdown).not.toHaveBeenCalled();
    await controller.shutdown();
    expect(actorRuntime.shutdown).toHaveBeenCalledTimes(1);
  });
});

async function waitForCondition(
  condition: () => boolean,
  label: string,
  timeoutMs = 5_000
): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}.`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
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
