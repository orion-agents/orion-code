import { Store } from '../src/framework/store';
import { AgentModeLifecycleController } from '../src/framework/agent-mode';
import {
  AgentRuntimeController,
  type AgentRuntimeRunner,
} from '../src/runtime/agent-runtime-controller';
import type { AgentRuntimeEvent } from '../src/runtime/agent-runtime-protocol';
import type { OrionCodeUiRuntime } from '../src/runtime/ui-events';
import { loadConfig } from '../src/services/config';

function createRuntime(overrides: Partial<OrionCodeUiRuntime> = {}): OrionCodeUiRuntime {
  const config = loadConfig({ apiKey: 'test-key', model: 'test-model' });
  return {
    cwd: process.cwd(),
    version: 'test',
    config,
    store: new Store({ config, tools: [], currentModel: 'test-model' }),
    llm: null,
    isConfigured: true,
    ensureSession: jest.fn(),
    setSession: jest.fn(),
    getSession: jest.fn(() => null),
    shutdown: jest.fn(async () => undefined),
    ...overrides,
  };
}

function deferredRunner(): AgentRuntimeRunner & {
  calls: Array<{ input: string; signal?: AbortSignal; resolve: () => void }>;
} {
  const calls: Array<{ input: string; signal?: AbortSignal; resolve: () => void }> = [];
  return {
    calls,
    runInput: jest.fn(
      (input, options) =>
        new Promise<void>(resolve => calls.push({ input, signal: options?.abortSignal, resolve }))
    ),
  };
}

describe('AgentRuntimeController v0.2 boundary', () => {
  test.each(['terminal', 'tui', 'print', 'web'] as const)(
    'restores %s from a bounded surface projection instead of replaying Thread history',
    renderer => {
      const runner = deferredRunner();
      type CreateAgentRunner = NonNullable<OrionCodeUiRuntime['createAgentRunner']>;
      const createAgentRunner = jest.fn<
        ReturnType<CreateAgentRunner>,
        Parameters<CreateAgentRunner>
      >(() => runner);
      const controller = new AgentRuntimeController({
        runtime: createRuntime({ createAgentRunner }),
        eventSink: { emit: () => undefined },
        uiRenderer: renderer,
      });

      expect(createAgentRunner).toHaveBeenCalledTimes(1);
      expect(createAgentRunner.mock.calls[0][1]).toMatchObject({
        replayHistoryOnRestore: false,
      });
      const context = (
        controller as unknown as { createCommandContext(): { replaceTranscript?: unknown } }
      ).createCommandContext();
      expect(typeof context.replaceTranscript === 'function').toBe(
        renderer === 'terminal' || renderer === 'tui'
      );
    }
  );

  test('owns one active turn and replaces it only through the typed revision path', async () => {
    const events: AgentRuntimeEvent[] = [];
    const runner = deferredRunner();
    const controller = new AgentRuntimeController({
      runtime: createRuntime(),
      eventSink: { emit: event => void events.push(event) },
      runner,
    });

    expect(controller.submit('first')).toEqual({ type: 'started' });
    expect(controller.submit('revision')).toEqual({ type: 'revision_requested' });
    expect(runner.calls[0].signal?.aborted).toBe(true);
    runner.calls[0].resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(runner.calls[1].input).toBe('revision');
    runner.calls[1].resolve();
    await controller.waitForIdle();

    expect(controller.hasActiveTurn()).toBe(false);
    expect(events.filter(event => event.type === 'processing_changed')).toEqual([
      expect.objectContaining({ processing: true }),
      expect.objectContaining({ processing: true }),
      expect.objectContaining({ processing: false }),
    ]);
  });

  test('does not optimistically re-echo a revision when the runtime owns transcript projection', async () => {
    const events: AgentRuntimeEvent[] = [];
    const runner = deferredRunner();
    const controller = new AgentRuntimeController({
      runtime: createRuntime(),
      eventSink: { emit: event => void events.push(event) },
      runner,
      echoSubmittedInput: false,
    });

    expect(controller.submit('first')).toEqual({ type: 'started' });
    expect(controller.submit('revision')).toEqual({ type: 'revision_requested' });
    expect(
      events.filter(
        event => event.type === 'transcript_append' && event.entry.content === 'revision'
      )
    ).toHaveLength(0);

    runner.calls[0].resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    runner.calls[1].resolve();
    await controller.waitForIdle();
  });

  test('queues follow-up work in FIFO order without aborting the active turn', async () => {
    const runner = deferredRunner();
    const controller = new AgentRuntimeController({
      runtime: createRuntime(),
      eventSink: { emit: () => undefined },
      runner,
    });

    expect(controller.submit('active')).toEqual({ type: 'started' });
    expect(controller.handle({ type: 'queue_followup', text: 'next' })).toMatchObject({
      type: 'followup_queued',
    });
    expect(runner.calls[0].signal?.aborted).toBe(false);
    runner.calls[0].resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(runner.calls[1].input).toBe('next');
    runner.calls[1].resolve();
    await controller.waitForIdle();
  });

  test('sets an exact agent mode immediately while idle and defers it while busy', async () => {
    const runtime = createRuntime();
    const runner = deferredRunner();
    const controller = new AgentRuntimeController({
      runtime,
      eventSink: { emit: () => undefined },
      runner,
    });

    expect(controller.handle({ type: 'set_agent_mode', mode: 'auto' })).toEqual({
      type: 'agent_mode_changed',
      snapshot: { baseMode: 'auto', pendingBaseMode: null },
      appliesFrom: 'immediate',
    });
    expect(runtime.store.getSnapshot().agentMode).toBe('auto');

    expect(controller.submit('active')).toEqual({ type: 'started' });
    expect(controller.handle({ type: 'set_agent_mode', mode: 'plan' })).toEqual({
      type: 'agent_mode_changed',
      snapshot: { baseMode: 'auto', pendingBaseMode: 'plan' },
      appliesFrom: 'next-logical-request',
    });
    expect(runtime.store.getSnapshot().agentMode).toBe('auto');
    expect(controller.handle({ type: 'set_agent_mode', mode: 'auto' })).toEqual({
      type: 'agent_mode_changed',
      snapshot: { baseMode: 'auto', pendingBaseMode: null },
      appliesFrom: 'next-logical-request',
    });
    controller.handle({ type: 'set_agent_mode', mode: 'plan' });

    runner.calls[0].resolve();
    await controller.waitForIdle();
    expect(runtime.store.getSnapshot()).toMatchObject({ agentMode: 'plan', planMode: true });
  });

  test('does not duplicate Plan execution when the durable request runner owns scheduling', async () => {
    const runtime = createRuntime();
    const lifecycle = new AgentModeLifecycleController(runtime.store);
    lifecycle.setMode('plan');
    const requests: string[] = [];
    const runner: AgentRuntimeRunner = {
      runInput: jest.fn(async () => undefined),
      runRequest: jest.fn(async request => {
        requests.push(request.text ?? '');
        lifecycle.completePlan('# Durable plan', 'interactive');
      }),
    };
    const controller = new AgentRuntimeController({
      runtime,
      eventSink: { emit: () => undefined },
      runner,
      agentModeLifecycle: lifecycle,
    });

    expect(controller.submit('prepare the durable plan')).toEqual({ type: 'started' });
    await controller.waitForIdle();

    expect(requests).toEqual(['prepare the durable plan']);
    expect(runtime.store.getSnapshot()).toMatchObject({
      agentMode: 'interactive',
      planMode: false,
      currentPlan: '# Durable plan',
    });
  });

  test('routes only the breaking v0.2 Goal controls through the runtime runner', async () => {
    const controls: unknown[] = [];
    const events: AgentRuntimeEvent[] = [];
    const runner: AgentRuntimeRunner = {
      runInput: jest.fn(async () => undefined),
      interrupt: jest.fn(),
      controlGoal: jest.fn(async control => {
        controls.push(control);
        return {
          accepted: true,
          action: control.action,
          message: `Goal ${control.action} accepted.`,
          scheduleContinuation: false,
        };
      }),
    };
    const controller = new AgentRuntimeController({
      runtime: createRuntime(),
      eventSink: { emit: event => void events.push(event) },
      runner,
    });

    expect(controller.submit('/goal ship v0.2')).toEqual({ type: 'started' });
    await controller.waitForIdle();
    expect(controller.handle({ type: 'goal_control', action: 'status' })).toEqual({
      type: 'started',
    });
    await controller.waitForIdle();
    expect(controller.submit('/goal clear')).toEqual({ type: 'started' });
    await controller.waitForIdle();

    expect(controls).toEqual([
      { action: 'create', objective: 'ship v0.2' },
      { action: 'status' },
      { action: 'clear' },
    ]);
    expect(controller.submit('/goal clear --yes')).toEqual({ type: 'command_handled' });
    expect(controller.submit('/target status')).toEqual({ type: 'command_handled' });
    expect(controls).toHaveLength(3);
    expect(events.filter(event => event.type === 'transcript_append')).toHaveLength(5);
  });

  test('synchronizes external Settings at each logical-request boundary before runner work', async () => {
    const order: string[] = [];
    let idleProbe: (() => boolean) | undefined;
    const runtime = createRuntime({
      bindSettingsRuntimeIdleProbe: probe => {
        idleProbe = probe;
        return () => undefined;
      },
      synchronizeSettings: jest.fn(async () => {
        order.push(`sync:${idleProbe?.()}`);
        return {} as never;
      }),
    });
    const runner: AgentRuntimeRunner = {
      runInput: jest.fn(async () => {
        order.push(`run:${idleProbe?.()}`);
      }),
    };
    const controller = new AgentRuntimeController({
      runtime,
      eventSink: { emit: () => undefined },
      runner,
    });

    controller.submit('first');
    await controller.waitForIdle();
    controller.submit('second');
    await controller.waitForIdle();

    expect(order).toEqual(['sync:true', 'run:false', 'sync:true', 'run:false']);
  });

  test('blocks a logical request when external Settings synchronization fails', async () => {
    const events: AgentRuntimeEvent[] = [];
    const runner: AgentRuntimeRunner = { runInput: jest.fn(async () => undefined) };
    const runtime = createRuntime({
      synchronizeSettings: jest.fn(async () => {
        throw new Error('settings recovery required');
      }),
    });
    const controller = new AgentRuntimeController({
      runtime,
      eventSink: { emit: event => void events.push(event) },
      runner,
    });

    controller.submit('must not run');
    await controller.waitForIdle();

    expect(runner.runInput).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'transcript_append',
        entry: expect.objectContaining({
          content: expect.stringContaining('settings recovery required'),
        }),
      })
    );
  });

  test('keeps active Goal work busy but allows pause before pending Settings synchronization', async () => {
    const order: string[] = [];
    let idleProbe: (() => boolean) | undefined;
    const runtime = createRuntime({
      bindSettingsRuntimeIdleProbe: probe => {
        idleProbe = probe;
        return () => undefined;
      },
      synchronizeSettings: jest.fn(async () => {
        order.push(`sync:${idleProbe?.()}`);
        return {} as never;
      }),
      describeSettings: jest.fn(() => ({ revision: 'unused' }) as never),
      updateSettings: jest.fn(async () => ({}) as never),
    });
    const runner: AgentRuntimeRunner = {
      runInput: jest.fn(async () => undefined),
      controlGoal: jest.fn(async control => {
        order.push(`control:${control.action}`);
        return {
          accepted: true,
          action: control.action,
          message: `Goal ${control.action} accepted.`,
          scheduleContinuation: control.action === 'create',
        };
      }),
    };
    const controller = new AgentRuntimeController({
      runtime,
      eventSink: { emit: () => undefined },
      runner,
    });

    controller.handle({ type: 'goal_control', action: 'create', objective: 'ship safely' });
    await controller.waitForIdle();
    expect(idleProbe?.()).toBe(false);
    expect(controller.handle({ type: 'permission_mode_change', value: 'deny' })).toEqual({
      type: 'command_ignored',
    });
    expect(runtime.updateSettings).not.toHaveBeenCalled();

    order.length = 0;
    controller.handle({ type: 'goal_control', action: 'pause' });
    await controller.waitForIdle();

    expect(order).toEqual(['control:pause', 'sync:true']);
    expect(idleProbe?.()).toBe(true);
  });

  test('fails closed for missing approvals and clears pending requests on shutdown', async () => {
    const controller = new AgentRuntimeController({
      runtime: createRuntime(),
      eventSink: { emit: () => undefined },
      runner: { runInput: jest.fn(async () => undefined) },
    });
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      controller.requestToolPermission({
        name: 'write_file',
        args: { path: 'a.ts' },
        abortSignal: alreadyAborted.signal,
      })
    ).resolves.toBe(false);

    const pending = controller.requestToolPermission({ name: 'exec_command', args: {} });
    await controller.stopActiveTurn();
    await expect(pending).resolves.toBe(false);
  });

  test('exposes immutable sanitized pending permission snapshots for reconnect recovery', async () => {
    const controller = new AgentRuntimeController({
      runtime: createRuntime(),
      eventSink: { emit: () => undefined },
      runner: { runInput: jest.fn(async () => undefined) },
    });
    const abort = new AbortController();
    const args = {
      path: 'src/index.ts',
      headers: { authorization: 'Bearer secret-value-123' },
      nested: [
        'safe',
        {
          apiKey: 'plain-secret-value',
          DEPLOY_TOKEN: 'opaque-token',
          clientSecret: 'opaque-client-secret',
          privateKey: 'opaque-private-key',
          dbPassword: 'opaque-db-password',
          AWS_SECRET_ACCESS_KEY: 'opaque-aws-secret',
          connectionString: 'opaque-connection-string',
          databaseUrl: 'opaque-database-url',
          dsn: 'opaque-dsn',
          pwd: 'opaque-pwd',
          auth: 'opaque-auth',
        },
      ],
    };

    const pending = controller.requestToolPermission({
      name: 'write_file',
      args,
      reason: 'write after checking sk-12345678',
      abortSignal: abort.signal,
    });
    const snapshots = controller.getPendingPermissions();

    expect(snapshots).toEqual([
      {
        id: 'permission-1',
        name: 'write_file',
        reason: 'write after checking [REDACTED_SECRET]',
        args: {
          path: 'src/index.ts',
          headers: '[REDACTED_SECRET]',
          nested: [
            'safe',
            {
              apiKey: '[REDACTED_SECRET]',
              DEPLOY_TOKEN: '[REDACTED_SECRET]',
              clientSecret: '[REDACTED_SECRET]',
              privateKey: '[REDACTED_SECRET]',
              dbPassword: '[REDACTED_SECRET]',
              AWS_SECRET_ACCESS_KEY: '[REDACTED_SECRET]',
              connectionString: '[REDACTED_SECRET]',
              databaseUrl: '[REDACTED_SECRET]',
              dsn: '[REDACTED_SECRET]',
              pwd: '[REDACTED_SECRET]',
              auth: '[REDACTED_SECRET]',
            },
          ],
        },
      },
    ]);
    expect(Object.isFrozen(snapshots)).toBe(true);
    expect(Object.isFrozen(snapshots[0])).toBe(true);
    expect(Object.isFrozen(snapshots[0].args)).toBe(true);
    expect('abortSignal' in snapshots[0]).toBe(false);
    expect(JSON.stringify(snapshots)).not.toContain('secret-value');

    args.path = 'changed-after-request.ts';
    expect(snapshots[0].args.path).toBe('src/index.ts');

    expect(
      controller.handle({
        type: 'permission_decision',
        requestId: snapshots[0].id,
        approved: false,
        scope: 'once',
      })
    ).toEqual({ type: 'permission_decision_recorded' });
    await expect(pending).resolves.toBe(false);
    expect(controller.getPendingPermissions()).toEqual([]);

    const aborted = controller.requestToolPermission({
      name: 'exec_command',
      args: { command: 'npm test' },
      abortSignal: abort.signal,
    });
    abort.abort();
    await expect(aborted).resolves.toBe(false);
    expect(controller.getPendingPermissions()).toEqual([]);
  });
});
