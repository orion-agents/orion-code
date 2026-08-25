import { Store } from '../src/framework/store';
import {
  AgentRuntimeController,
  type AgentRuntimeRunner,
} from '../src/runtime/agent-runtime-controller';
import type { AgentRuntimeEvent } from '../src/runtime/agent-runtime-protocol';
import type { OrionCodeUiRuntime } from '../src/runtime/ui-events';
import { loadConfig } from '../src/services/config';

function createRuntime(): OrionCodeUiRuntime {
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
});
