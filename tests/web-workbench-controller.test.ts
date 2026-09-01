import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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
import { createContextUsageSnapshot } from '../src/services/model-context';
import { buildRegistry } from '../src/services/model-registry';
import { WebEventHub } from '../src/web/event-hub';
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

  test('boots the production composition root before Session actors reuse its Workspace kernel', async () => {
    const controller = await WebWorkbenchController.create({ cwd: workspace });
    const rootKernel = controller.runtime.workspaceRuntimeKernel;
    expect(rootKernel).toBeDefined();
    expect(rootKernel?.diagnostics()).toMatchObject({
      participantCount: 1,
      ownerReleased: false,
      closed: false,
    });

    const session = await controller.createSession('production actor kernel');
    const baseline = controller.bootstrap('nonce');
    const guard = {
      workspaceId: baseline.workspaceId,
      expectedContextRevision: baseline.contextRevision,
    };
    const cold = controller.composerState(session.id, guard);
    await controller.applyComposerAction({
      requestId: randomUUID(),
      ...guard,
      expectedSessionId: session.id,
      expectedSessionRuntimeRevision: cold.sessionRuntime.runtimeRevision,
      expectedControlRevision: cold.controlRevision,
      type: 'set_agent_mode',
      mode: 'plan',
    });

    expect(rootKernel?.diagnostics()).toMatchObject({ participantCount: 2, closed: false });
    await controller.shutdown();
    expect(rootKernel?.diagnostics()).toMatchObject({
      participantCount: 0,
      ownerReleased: true,
      closed: true,
    });
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

  test('keeps Session selection responsive while another actor is starting', async () => {
    const surfaceRuntime = createFakeWebRuntime(workspace);
    const actorRuntime = createFakeWebRuntime(workspace);
    let release!: () => void;
    const rebind = new Promise<void>(resolve => {
      release = resolve;
    });
    const rebindSessionRuntime = jest.fn(() => rebind);
    actorRuntime.rebindSessionRuntime = rebindSessionRuntime;
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async () => surfaceRuntime,
      createSessionRuntime: async () => actorRuntime,
    });

    const first = await controller.createSession('held actor');
    const starting = controller.dispatch({
      requestId: randomUUID(),
      ...sessionCommandTarget(controller, first.id),
      type: 'submit',
      text: 'start after rebind',
    });
    await waitForCondition(rebindSessionRuntime);
    expect(rebindSessionRuntime).toHaveBeenCalledTimes(1);

    const second = await controller.createSession('foreground remains responsive');
    await expect(controller.activateSession(second.id)).resolves.toMatchObject({
      result: 'foreground_session_selected',
      sessionRuntime: { sessionId: second.id, phase: 'cold' },
    });

    release();
    await expect(starting).resolves.toMatchObject({ requestId: expect.any(String) });
    await controller.shutdown();
  });

  test('fails closed when a Session actor start failure cannot be cleaned up', async () => {
    const surfaceRuntime = createFakeWebRuntime(workspace);
    const actorRuntime = createFakeWebRuntime(workspace);
    actorRuntime.rebindSessionRuntime = jest.fn(async () => {
      throw new Error('rebind failed');
    });
    let shutdownAttempts = 0;
    actorRuntime.shutdown = jest.fn(async () => {
      actorRuntime.settingsCoordinator?.close();
      shutdownAttempts += 1;
      if (shutdownAttempts === 1) throw new Error('shutdown failed');
    });
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async () => surfaceRuntime,
      createSessionRuntime: async () => actorRuntime,
    });
    const session = await controller.createSession('cleanup failure');

    await expect(
      controller.dispatch({
        requestId: randomUUID(),
        ...sessionCommandTarget(controller, session.id),
        type: 'submit',
        text: 'must not start',
      })
    ).rejects.toMatchObject({
      status: 503,
      code: 'session_actor_cleanup_failed',
    });
    expect(actorRuntime.rebindSessionRuntime).toHaveBeenCalledTimes(1);
    expect(actorRuntime.shutdown).toHaveBeenCalledTimes(1);
    expect(controller.sessionRuntimeSummary(session.id)).toMatchObject({
      phase: 'failed',
      resident: true,
    });
    await controller.shutdown();
    expect(actorRuntime.shutdown).toHaveBeenCalledTimes(2);
  });

  test('continues Host cleanup when a resident Session actor cannot close', async () => {
    const surfaceRuntime = createFakeWebRuntime(workspace);
    const actorRuntime = createFakeWebRuntime(workspace);
    actorRuntime.createAgentRunner = () => ({ runInput: jest.fn(async () => undefined) });
    actorRuntime.shutdown = jest.fn(async () => {
      actorRuntime.settingsCoordinator?.close();
      throw new Error('persistent actor shutdown failure');
    });
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async () => surfaceRuntime,
      createSessionRuntime: async () => actorRuntime,
    });
    const closeEvents = jest.spyOn(controller.eventHub, 'close');
    const session = await controller.createSession('persistent cleanup failure');
    await controller.dispatch({
      requestId: randomUUID(),
      ...sessionCommandTarget(controller, session.id),
      type: 'submit',
      text: 'finish before shutdown',
    });
    await controller.waitForSessionIdle(session.id);

    await expect(controller.shutdown()).rejects.toMatchObject({
      status: 503,
      code: 'workbench_shutdown_incomplete',
    });
    expect(actorRuntime.shutdown).toHaveBeenCalledTimes(2);
    expect(surfaceRuntime.shutdown).toHaveBeenCalledTimes(1);
    expect(closeEvents).toHaveBeenCalledTimes(1);
  });

  test('runs two Session actors concurrently without cross-routing their prompts', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstTurn = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const secondTurn = new Promise<void>(resolve => {
      releaseSecond = resolve;
    });
    const firstRunInput = jest.fn((_input: string) => firstTurn);
    const secondRunInput = jest.fn((_input: string) => secondTurn);
    const actorRuntimes = [createFakeWebRuntime(workspace), createFakeWebRuntime(workspace)];
    actorRuntimes[0].createAgentRunner = () => ({ runInput: firstRunInput });
    actorRuntimes[1].createAgentRunner = () => ({ runInput: secondRunInput });
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async () => createFakeWebRuntime(workspace),
      createSessionRuntime: async () => {
        const runtime = actorRuntimes.shift();
        if (!runtime) throw new Error('Unexpected extra Session actor.');
        return runtime;
      },
    });
    const first = await controller.createSession('parallel first');
    const second = await controller.createSession('parallel second');

    const [firstResult, secondResult] = await Promise.all([
      controller.dispatch({
        requestId: randomUUID(),
        ...sessionCommandTarget(controller, first.id),
        type: 'submit',
        text: 'FIRST_SESSION_PROMPT',
      }),
      controller.dispatch({
        requestId: randomUUID(),
        ...sessionCommandTarget(controller, second.id),
        type: 'submit',
        text: 'SECOND_SESSION_PROMPT',
      }),
    ]);

    expect(firstResult).toMatchObject({ result: 'started', sessionRuntime: { phase: 'running' } });
    expect(secondResult).toMatchObject({ result: 'started', sessionRuntime: { phase: 'running' } });
    expect(firstRunInput).toHaveBeenCalledWith('FIRST_SESSION_PROMPT', expect.any(Object));
    expect(secondRunInput).toHaveBeenCalledWith('SECOND_SESSION_PROMPT', expect.any(Object));
    expect(firstRunInput).toHaveBeenCalledTimes(1);
    expect(secondRunInput).toHaveBeenCalledTimes(1);
    expect(controller.sessionRuntimeSummary(first.id).phase).toBe('running');
    expect(controller.sessionRuntimeSummary(second.id).phase).toBe('running');

    releaseFirst();
    releaseSecond();
    await Promise.all([
      controller.waitForSessionIdle(first.id),
      controller.waitForSessionIdle(second.id),
    ]);
    expect(controller.sessionRuntimeSummary(first.id).phase).toBe('idle');
    expect(controller.sessionRuntimeSummary(second.id).phase).toBe('idle');
    await controller.shutdown();
  });

  test('routes a running Session submit to steering without admitting another turn', async () => {
    let releaseTurn!: () => void;
    const activeTurn = new Promise<void>(resolve => {
      releaseTurn = resolve;
    });
    const runInput = jest.fn(() => activeTurn);
    const actorRuntime = createFakeWebRuntime(workspace);
    actorRuntime.createAgentRunner = () => ({ runInput });
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async () => createFakeWebRuntime(workspace),
      createSessionRuntime: async () => actorRuntime,
    });
    const session = await controller.createSession('steering target');

    const started = await controller.dispatch({
      requestId: randomUUID(),
      ...sessionCommandTarget(controller, session.id),
      type: 'submit',
      text: 'hold the active turn',
    });
    expect(started).toMatchObject({ result: 'started', sessionRuntime: { phase: 'running' } });

    const steered = await controller.dispatch({
      requestId: randomUUID(),
      ...sessionCommandTarget(controller, session.id),
      type: 'submit',
      text: 'revise the active turn',
    });

    expect(steered).toMatchObject({
      result: 'revision_requested',
      sessionRuntime: { phase: 'running' },
    });
    expect(runInput).toHaveBeenCalledTimes(1);
    expect(controller.sessionRuntimeSummary(session.id).phase).toBe('running');

    releaseTurn();
    await controller.waitForSessionIdle(session.id);
    await controller.shutdown();
  });

  test('exposes the fourth Session turn as a cancellable FIFO admission', async () => {
    const releases: Array<() => void> = [];
    const actorRuntimes = Array.from({ length: 4 }, () => {
      const runtime = createFakeWebRuntime(workspace);
      const settled = new Promise<void>(resolve => releases.push(resolve));
      runtime.createAgentRunner = () => ({ runInput: jest.fn(() => settled) });
      return runtime;
    });
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async () => createFakeWebRuntime(workspace),
      createSessionRuntime: async () => {
        const runtime = actorRuntimes.shift();
        if (!runtime) throw new Error('Unexpected extra Session actor.');
        return runtime;
      },
    });
    const sessions = await Promise.all(
      Array.from({ length: 4 }, (_, index) => controller.createSession(`parallel ${index + 1}`))
    );

    for (const [index, session] of sessions.entries()) {
      const result = await controller.dispatch({
        requestId: randomUUID(),
        ...sessionCommandTarget(controller, session.id),
        type: 'submit',
        text: `SESSION_${index + 1}`,
      });
      if (index < 3) expect(result).toMatchObject({ result: 'started' });
      else {
        expect(result).toMatchObject({
          result: 'session_turn_queued',
          queuePosition: 1,
          sessionRuntime: { phase: 'queued' },
        });
        expect(result.queueId).toBeDefined();
        const cancelled = await controller.dispatch({
          requestId: randomUUID(),
          ...sessionCommandTarget(controller, session.id),
          type: 'cancel_queued_turn',
          queueId: result.queueId,
        });
        expect(cancelled).toMatchObject({
          result: 'session_turn_queue_cancelled',
          sessionRuntime: { phase: 'idle' },
        });
      }
    }

    const fourthRuntime = controller.sessionRuntimeSummary(sessions[3].id);
    expect(fourthRuntime).toMatchObject({ phase: 'idle' });
    expect(fourthRuntime).not.toHaveProperty('queueId');
    expect(fourthRuntime).not.toHaveProperty('queuePosition');
    releases.slice(0, 3).forEach(release => release());
    await Promise.all(
      sessions.slice(0, 3).map(session => controller.waitForSessionIdle(session.id))
    );
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
      ...settingsContext(controller),
      expectedRevision: before.revision,
      operations: [{ op: 'set', key: 'permissions.toolConfirmation', value: 'deny' }],
    });

    expect(after.revision).not.toBe(before.revision);
    expect(after.settings.sections.permissions.toolConfirmation.effectiveValue).toBe('deny');
    expect(after.appliedKeys).toEqual(['permissions.toolConfirmation']);
    await expect(
      controller.updateSettings({
        requestId: 'b4c1ae96-4ef6-49d6-9998-52ed314cc503',
        ...settingsContext(controller),
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
      ...settingsContext(controller),
      expectedRevision: before.revision,
      operations: [{ op: 'set', key: 'defaults.model', value: 'next-model' }],
    });

    expect(changed.settings.sections.defaults.model.effectiveValue).toBe('next-model');
    expect(controller.runtime.store.getSnapshot().currentModel).toBe('test-model');
    expect(loadSessionMeta(first.id)?.model).toBe('test-model');

    const second = await controller.createSession('second');
    expect(loadSessionMeta(second.id)?.model).toBe('next-model');
    await controller.shutdown();
  });

  test('rejects a delayed Settings write after the active workspace changes', async () => {
    const secondary = join(workspace, 'secondary');
    mkdirSync(secondary);
    const updates = new Map<string, jest.Mock>();
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async cwd => {
        const runtime = createFakeWebRuntime(cwd);
        const update = jest.fn(runtime.updateSettings);
        runtime.updateSettings = update;
        updates.set(cwd, update);
        return runtime;
      },
    });
    const before = controller.settings();
    const initialWorkspace = controller.workspace;
    const staleContext = settingsContext(controller);

    await controller.switchWorkspace(secondary, staleContext);
    const targetWorkspace = controller.workspace;
    expect(targetWorkspace).not.toBe(initialWorkspace);
    await expect(
      controller.updateSettings({
        requestId: randomUUID(),
        ...staleContext,
        expectedRevision: before.revision,
        operations: [{ op: 'set', key: 'defaults.effort', value: 'high' }],
      })
    ).rejects.toMatchObject({ status: 409, code: 'context_revision_conflict' });

    expect(updates.get(initialWorkspace)).toHaveBeenCalledTimes(0);
    expect(updates.get(targetWorkspace)).toHaveBeenCalledTimes(0);
    expect(controller.settings().sections.defaults.effort.explicitValue).toBeUndefined();
    await controller.shutdown();
  });

  test('coalesces Context telemetry without invalidating control CAS, but revisions authority changes', async () => {
    const actorRuntime = createFakeWebRuntime(workspace);
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async cwd => createFakeWebRuntime(cwd),
      createSessionRuntime: async () => actorRuntime,
    });
    const session = await controller.createSession('composer revision');
    const baseline = controller.bootstrap('nonce');
    const guard = {
      workspaceId: baseline.workspaceId,
      expectedContextRevision: baseline.contextRevision,
    };
    const cold = controller.composerState(session.id, guard);
    const activated = await controller.applyComposerAction({
      requestId: randomUUID(),
      ...guard,
      expectedSessionId: session.id,
      expectedSessionRuntimeRevision: cold.sessionRuntime.runtimeRevision,
      expectedControlRevision: cold.controlRevision,
      type: 'set_agent_mode',
      mode: 'plan',
    });
    const before = activated.state;

    actorRuntime.store.setContextUsage(
      createContextUsageSnapshot({ modelId: 'test-model', usedTokens: 2_048 })
    );
    await new Promise(resolve => setTimeout(resolve, 140));
    const telemetry = controller.composerState(session.id, guard);
    expect(telemetry.contextUsage).toMatchObject({ modelId: 'test-model', usedTokens: 2_048 });
    expect(telemetry.controlRevision).toBe(before.controlRevision);

    const changed = await controller.applyComposerAction({
      requestId: randomUUID(),
      ...guard,
      expectedSessionId: session.id,
      expectedSessionRuntimeRevision: telemetry.sessionRuntime.runtimeRevision,
      expectedControlRevision: telemetry.controlRevision,
      type: 'set_agent_mode',
      mode: 'auto',
    });
    expect(changed.state.mode.baseMode).toBe('auto');
    await expect(
      controller.applyComposerAction({
        requestId: randomUUID(),
        ...guard,
        expectedSessionId: session.id,
        expectedSessionRuntimeRevision: changed.state.sessionRuntime.runtimeRevision,
        expectedControlRevision: telemetry.controlRevision,
        type: 'set_agent_mode',
        mode: 'interactive',
      })
    ).rejects.toMatchObject({ status: 409, code: 'composer_control_conflict' });
    await controller.shutdown();
  });

  test('projects canonical Session preferences after cold and resident Composer actions', async () => {
    const actorRuntime = createFakeWebRuntime(workspace);
    const built = buildRegistry({
      providers: [
        {
          id: 'test',
          baseUrl: 'https://example.invalid/v1',
          apiKey: 'test-key',
          protocol: 'openai-completions',
        },
      ],
      models: [
        {
          id: 'test-model',
          provider: 'test',
          model: 'test-model',
          reasoningCapability: {
            kind: 'effort-level',
            supportedLevels: ['low', 'high'],
            defaultLevel: 'low',
            adapter: 'openai-chat-reasoning-effort',
            source: 'config',
          },
        },
        {
          id: 'next-model',
          provider: 'test',
          model: 'next-model',
          reasoningCapability: {
            kind: 'effort-level',
            supportedLevels: ['low', 'high'],
            defaultLevel: 'low',
            adapter: 'openai-chat-reasoning-effort',
            source: 'config',
          },
        },
      ],
      defaultModel: 'test-model',
    });
    if (!built.registry) throw new Error('Composer model registry fixture failed.');
    actorRuntime.config.modelRegistry = built.registry;
    const eventHub = new WebEventHub();
    const emit = jest.spyOn(eventHub, 'emit');
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      eventHub,
      createRuntime: async cwd => createFakeWebRuntime(cwd),
      createSessionRuntime: async () => actorRuntime,
    });
    const session = await controller.createSession('canonical Composer Session');
    const baseline = controller.bootstrap('canonical-composer');
    const guard = {
      workspaceId: baseline.workspaceId,
      expectedContextRevision: baseline.contextRevision,
    };
    const cold = controller.composerState(session.id, guard);
    expect(cold.sessionRuntime).toMatchObject({ phase: 'cold', resident: false });

    const selected = await controller.applyComposerAction({
      requestId: randomUUID(),
      ...guard,
      expectedSessionId: session.id,
      expectedSessionRuntimeRevision: cold.sessionRuntime.runtimeRevision,
      expectedControlRevision: cold.controlRevision,
      type: 'select_model',
      modelId: 'next-model',
      effort: 'high',
    });

    expect(selected).toMatchObject({
      outcome: 'applied',
      state: {
        sessionId: session.id,
        sessionRuntime: { resident: true },
        model: {
          modelId: 'next-model',
          effort: { requested: 'high', effective: 'high' },
        },
      },
    });
    expect(loadSessionMeta(session.id)).toMatchObject({
      model: 'next-model',
      effortPreference: 'high',
    });

    const permission = await controller.applyComposerAction({
      requestId: randomUUID(),
      ...guard,
      expectedSessionId: session.id,
      expectedSessionRuntimeRevision: selected.state.sessionRuntime.runtimeRevision,
      expectedControlRevision: selected.state.controlRevision,
      type: 'set_permission_override',
      value: 'allow',
    });

    expect(permission.state).toMatchObject({
      model: {
        modelId: 'next-model',
        effort: { requested: 'high', effective: 'high' },
      },
      permission: { effective: 'allow', override: 'allow', source: 'session' },
    });
    expect(loadSessionMeta(session.id)).toMatchObject({
      model: 'next-model',
      effortPreference: 'high',
      toolConfirmationOverride: 'allow',
    });
    expect(controller.composerState(session.id, guard)).toMatchObject({
      controlRevision: permission.state.controlRevision,
      model: {
        modelId: 'next-model',
        effort: { requested: 'high', effective: 'high' },
      },
      permission: { effective: 'allow', override: 'allow', source: 'session' },
    });
    const latestComposerEvent = emit.mock.calls
      .map(call => call[0])
      .filter(event => event.type === 'composer_state_changed')
      .at(-1);
    expect(latestComposerEvent).toEqual({
      type: 'composer_state_changed',
      state: permission.state,
    });
    await controller.shutdown();
  });

  test('publishes queued messages atomically with the Composer control revision', async () => {
    const runtime = createFakeWebRuntime(workspace);
    let releaseFirstTurn!: () => void;
    const firstTurn = new Promise<void>(resolve => {
      releaseFirstTurn = resolve;
    });
    const runInput = jest
      .fn()
      .mockImplementationOnce(() => firstTurn)
      .mockImplementation(async () => undefined);
    runtime.createAgentRunner = () => ({ runInput });
    const eventHub = new WebEventHub();
    const emit = jest.spyOn(eventHub, 'emit');
    const emitRuntime = jest.spyOn(eventHub, 'emitRuntime');
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      eventHub,
      createRuntime: async () => createFakeWebRuntime(workspace),
      createSessionRuntime: async () => runtime,
    });
    const session = await controller.createSession('queued Composer CAS');
    const baseline = controller.bootstrap('nonce');
    const guard = {
      workspaceId: baseline.workspaceId,
      expectedContextRevision: baseline.contextRevision,
    };

    await controller.dispatch({
      requestId: randomUUID(),
      ...sessionCommandTarget(controller, session.id),
      type: 'submit',
      text: 'hold the first turn',
    });
    await Promise.resolve();
    expect(runInput).toHaveBeenCalledTimes(1);
    emit.mockClear();
    emitRuntime.mockClear();

    await controller.dispatch({
      requestId: randomUUID(),
      ...sessionCommandTarget(controller, session.id),
      type: 'queue_followup',
      text: 'queued original',
    });

    const projected = emit.mock.calls
      .map(call => call[0])
      .filter(event => event.type === 'composer_state_changed');
    expect(projected).toHaveLength(1);
    const queuedState = projected[0].type === 'composer_state_changed' ? projected[0].state : null;
    expect(queuedState).toMatchObject({
      sessionId: session.id,
      queue: { items: [{ text: 'queued original', revision: 1 }] },
    });
    expect(emitRuntime.mock.calls.some(([event]) => event.type === 'followup_queue_changed')).toBe(
      false
    );

    const queuedItem = queuedState?.queue.items[0];
    expect(queuedItem).toBeDefined();
    await expect(
      controller.applyComposerAction({
        requestId: randomUUID(),
        ...guard,
        expectedSessionId: session.id,
        expectedSessionRuntimeRevision: queuedState!.sessionRuntime.runtimeRevision,
        expectedControlRevision: queuedState!.controlRevision,
        type: 'edit_queue_item',
        itemId: queuedItem!.id,
        expectedItemRevision: queuedItem!.revision,
        text: 'queued edited',
      })
    ).resolves.toMatchObject({
      outcome: 'applied',
      state: { queue: { items: [{ text: 'queued edited', revision: 2 }] } },
    });

    releaseFirstTurn();
    await controller.waitForSessionIdle(session.id);
    await controller.shutdown();
  });

  test('replays an early Workspace mutation state after tool ownership is projected', async () => {
    const runtime = createFakeWebRuntime(workspace);
    const eventHub = new WebEventHub();
    const emit = jest.spyOn(eventHub, 'emit');
    const emitRuntime = jest.spyOn(eventHub, 'emitRuntime');
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      eventHub,
      createRuntime: async () => runtime,
    });
    const bootstrap = controller.bootstrap('nonce');
    const callId = randomUUID();
    const harness = controller as unknown as {
      emitWorkspaceMutationState(state: {
        workspaceId: string;
        invocationId: string;
        phase: 'queued';
        queuePosition: number;
      }): void;
      emitSessionActorRuntimeEvent(
        key: { workspaceId: string; sessionId: string },
        runtime: ReturnType<typeof createFakeWebRuntime>,
        actor: undefined,
        event: {
          type: 'tool_started';
          event: {
            callId: string;
            name: string;
            args: Record<string, unknown>;
            sequence: number;
          };
        }
      ): string | void;
    };

    harness.emitWorkspaceMutationState({
      workspaceId: bootstrap.workspaceId,
      invocationId: callId,
      phase: 'queued',
      queuePosition: 1,
    });
    expect(emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'workspace_mutation_changed' }),
      expect.anything(),
      expect.anything()
    );

    harness.emitSessionActorRuntimeEvent(
      { workspaceId: bootstrap.workspaceId, sessionId: 'session-queued-owner' },
      runtime,
      undefined,
      {
        type: 'tool_started',
        event: { callId, name: 'exec_command', args: {}, sequence: 1 },
      }
    );

    expect(emitRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tool_started' }),
      expect.objectContaining({ sessionId: 'session-queued-owner' })
    );
    expect(emit).toHaveBeenCalledWith(
      {
        type: 'workspace_mutation_changed',
        state: { callId, phase: 'queued', queuePosition: 1 },
      },
      false,
      { sessionId: 'session-queued-owner' }
    );
    expect(emitRuntime.mock.invocationCallOrder[0]).toBeLessThan(emit.mock.invocationCallOrder[0]);
    await controller.shutdown();
  });

  test('resolves exact structured file and Skill Context into one redacted manifest', async () => {
    const marker = 'OPAQUE_WEB32_CONTEXT_SECRET';
    writeFileSync(join(workspace, 'source.ts'), `export const token = '${marker}';\n`);
    const surfaceRuntime = createFakeWebRuntime(workspace);
    surfaceRuntime.inspectSkills = async () => [
      {
        id: 'review-safely',
        name: 'Review safely',
        description: `Inspect without token=${marker}`,
        providerId: 'fixture',
        sourceScope: 'project',
        modelInvocable: true,
        userInvocable: true,
        requestedCapabilities: [],
        digest: 'skill-digest-v1',
      },
    ];
    const actorRuntime = createFakeWebRuntime(workspace);
    const runInput = jest.fn(async (_input: string) => undefined);
    actorRuntime.createAgentRunner = () => ({ runInput });
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async () => surfaceRuntime,
      createSessionRuntime: async () => actorRuntime,
    });
    const session = await controller.createSession('context manifest');
    const baseline = controller.bootstrap('nonce');
    const guard = {
      workspaceId: baseline.workspaceId,
      expectedContextRevision: baseline.contextRevision,
    };
    const files = controller.listFiles(guard, { pageSize: 100 });
    const source = files.items.find(item => item.name === 'source.ts')!;
    const sourcePage = controller.readFileContent(guard, { fileId: source.id });
    const result = await controller.dispatch({
      requestId: randomUUID(),
      ...sessionCommandTarget(controller, session.id),
      type: 'submit',
      text: 'Review the selected Context',
      contextReferences: [
        {
          kind: 'file',
          id: source.id,
          label: source.name,
          revision: sourcePage.revision,
        },
        {
          kind: 'skill',
          id: 'review-safely',
          label: 'Review safely',
          digest: 'skill-digest-v1',
        },
      ],
    });

    expect(result.contextReceipt).toMatchObject({
      manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      referenceCount: 2,
      totalBytes: expect.any(Number),
    });
    await waitForCondition(runInput);
    const resolvedText = runInput.mock.calls[0]?.[0] ?? '';
    expect(resolvedText).toContain('[Orion Context Manifest V1]');
    expect(resolvedText).toContain('source.ts');
    expect(resolvedText).toContain('$review-safely');
    expect(resolvedText).toContain('[REDACTED_SECRET]');
    expect(resolvedText).not.toContain(marker);
    expect(resolvedText).not.toContain(workspace);
    await controller.shutdown();
  });

  test('blocks stale and sensitive Context references before runtime admission', async () => {
    writeFileSync(join(workspace, 'notes.txt'), 'first revision\n');
    writeFileSync(join(workspace, '.env'), 'TOKEN=OPAQUE_CONTEXT_ENV_SECRET\n');
    const runInput = jest.fn(async (_input: string) => undefined);
    const createSessionRuntime = jest.fn(async () => {
      const actorRuntime = createFakeWebRuntime(workspace);
      actorRuntime.createAgentRunner = () => ({ runInput });
      return actorRuntime;
    });
    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async cwd => createFakeWebRuntime(cwd),
      createSessionRuntime,
    });
    const session = await controller.createSession('context validation');
    const baseline = controller.bootstrap('nonce');
    const guard = {
      workspaceId: baseline.workspaceId,
      expectedContextRevision: baseline.contextRevision,
    };
    const files = controller.listFiles(guard, { pageSize: 100 });
    const notes = files.items.find(item => item.name === 'notes.txt')!;
    const sensitive = files.items.find(item => item.name === '.env')!;
    const notesPage = controller.readFileContent(guard, { fileId: notes.id });
    writeFileSync(join(workspace, 'notes.txt'), 'a newer and longer revision\n');
    await expect(
      controller.dispatch({
        requestId: randomUUID(),
        ...sessionCommandTarget(controller, session.id),
        type: 'submit',
        text: 'Do not admit stale Context',
        contextReferences: [
          {
            kind: 'file',
            id: notes.id,
            label: notes.name,
            revision: notesPage.revision,
          },
        ],
      })
    ).rejects.toMatchObject({ status: 409, code: 'context_reference_stale' });

    await expect(
      controller.dispatch({
        requestId: randomUUID(),
        ...sessionCommandTarget(controller, session.id),
        type: 'submit',
        text: 'Do not admit sensitive Context',
        contextReferences: [
          {
            kind: 'file',
            id: sensitive.id,
            label: sensitive.name,
            revision: files.revision,
          },
        ],
      })
    ).rejects.toMatchObject({ status: 403, code: 'context_reference_forbidden' });

    expect(runInput).not.toHaveBeenCalled();
    expect(createSessionRuntime).not.toHaveBeenCalled();
    await controller.shutdown();
  });

  test('keeps workspace diagnostics cold after Session metadata is created', async () => {
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

    await controller.createSession('diagnostics session');
    await expect(controller.diagnostics()).resolves.toMatchObject({
      activeSessionId: null,
      harness: null,
    });
    expect(getHarnessDiagnostics).not.toHaveBeenCalled();
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
    const consistentCold = controller.sessionSnapshot(session.id, undefined, 50, true);
    expect(consistentCold.runtime.active).toBe(false);
    expect(consistentCold.threadCursor).toBe(activeProjection.cursor + 3);
    expect(consistentCold.projectionDigest).not.toBe(activeProjection.digest);
    expect(consistentCold.transcript.items.at(-1)).toMatchObject({ content: 'indexed-206' });
    expect(() => controller.sessionSnapshot(session.id, oldCursor ?? undefined, 50, true)).toThrow(
      expect.objectContaining({ status: 409, code: 'transcript_cursor_stale' })
    );
    await controller.shutdown();
  });

  test('projects a recovered durable interruption instead of reporting the actor idle', async () => {
    const session = createSession(workspace, 'test-model');
    appendSessionMessages(session.id, [
      { role: 'user', content: 'recover interrupted turn', timestamp: 1 },
    ]);
    const materialized = materializeLegacyThreadV1({
      projectPath: workspace,
      sessionId: session.id,
    });
    const store = new ThreadEventStore(
      getProjectThreadsV2Dir(workspace),
      materialized.plan.receipt.threadId
    );
    const turnId = randomUUID();
    store.appendDurableBatch([
      {
        turnId,
        payload: { type: 'turn.started', data: { input: 'held request', mode: 'build' } },
      },
      {
        turnId,
        payload: {
          type: 'turn.interrupted',
          data: { reason: 'runtime_restarted_before_terminal_commit' },
        },
      },
    ]);

    const controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async cwd => createFakeWebRuntime(cwd),
    });

    const snapshot = controller.sessionSnapshot(session.id, undefined, 50, true);
    expect(snapshot.runtime.active).toBe(false);
    expect(snapshot.sessionRuntime.phase).toBe('interrupted');
    expect(snapshot.composer.sessionRuntime.phase).toBe('interrupted');
    expect(snapshot.runtime.processing).toBe(false);
    await controller.shutdown();
  });
});

function sessionCommandTarget(controller: WebWorkbenchController, sessionId: string) {
  const bootstrap = controller.bootstrap('command-target');
  return {
    workspaceId: bootstrap.workspaceId,
    expectedContextRevision: bootstrap.contextRevision,
    expectedSessionId: sessionId,
    expectedSessionRuntimeRevision: controller.sessionRuntimeSummary(sessionId).runtimeRevision,
  } as const;
}

function settingsContext(controller: WebWorkbenchController) {
  const bootstrap = controller.bootstrap('settings-context');
  return {
    workspaceId: bootstrap.workspaceId,
    expectedContextRevision: bootstrap.contextRevision,
  } as const;
}

async function waitForCondition(condition: jest.Mock, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition.mock.calls.length > 0) return;
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for the test condition.');
}
