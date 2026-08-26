import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

import { canonicalRuntimeJson, digestRuntimeValue } from '../src/runtime/protocol/canonical';
import { ThreadEventStore } from '../src/runtime/thread-event-store';
import {
  ThreadRuntimeV1,
  type ThreadTurnExecutionContextV1,
  type ThreadTurnRunnerV1,
} from '../src/runtime/thread-runtime';

describe('ThreadRuntimeV1', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function createStore(): ThreadEventStore {
    const root = mkdtempSync(join(tmpdir(), 'orion-thread-runtime-'));
    roots.push(root);
    return new ThreadEventStore(root, randomUUID());
  }

  test('persists a semantic turn and item sequence before renderer delivery', async () => {
    const store = createStore();
    const runner: ThreadTurnRunnerV1 = {
      run: async context => {
        const item = context.startItem({ kind: 'message', role: 'assistant' });
        context.emitDelta(item, 'hel');
        context.emitDelta(item, 'lo');
        context.completeItem(item, { content: 'hello', summary: 'hello' });
        return { status: 'completed', outcome: 'done' };
      },
    };
    const runtime = new ThreadRuntimeV1({ store, runner, projectPath: '/workspace' });
    const consumer = runtime.subscribe('tui', 1, { maxItems: 32, maxBytes: 64 * 1024 });

    const admitted = runtime.dispatch({
      type: 'turn.start',
      data: { input: 'say hello', mode: 'build' },
    });
    expect(admitted.status).toBe('started');
    await runtime.waitForIdle();

    const projection = runtime.getProjection();
    expect(projection.status).toBe('idle');
    expect(Object.values(projection.turns)).toHaveLength(1);
    expect(Object.values(projection.items).map(item => item.status)).toEqual([
      'completed',
      'completed',
    ]);
    const delivery = consumer.read();
    expect(delivery.status).toBe('events');
    if (delivery.status === 'events') {
      expect(delivery.events.some(event => event.payload.type === 'item.delta')).toBe(true);
      expect(delivery.events.at(-1)?.payload.type).toBe('turn.completed');
    }
  });

  test('publishes durable facts committed by ToolGateway journals', () => {
    const store = createStore();
    const runtime = new ThreadRuntimeV1({
      store,
      runner: { run: async () => ({ status: 'completed' }) },
    });
    const consumer = runtime.subscribe('journal', store.getCursor(), {
      maxItems: 8,
      maxBytes: 16 * 1024,
    });
    const receiptId = randomUUID();
    const turnId = randomUUID();
    const stepId = randomUUID();
    const receiptContent = {
      version: 1 as const,
      requestId: receiptId,
      threadId: store.threadId,
      turnId,
      stepId,
    };
    const receipt = {
      ...receiptContent,
      digest: digestRuntimeValue(receiptContent),
    };

    store.appendDurable({
      turnId,
      stepId,
      payload: {
        type: 'capability.receipt',
        data: {
          receiptId,
          digest: receipt.digest,
          receipt: canonicalRuntimeJson(receipt),
        },
      },
    });

    const delivery = consumer.read();
    expect(delivery.status).toBe('events');
    if (delivery.status === 'events') {
      expect(delivery.events).toHaveLength(1);
      expect(delivery.events[0].payload).toEqual({
        type: 'capability.receipt',
        data: {
          receiptId,
          digest: receipt.digest,
          receipt: canonicalRuntimeJson(receipt),
        },
      });
    }
  });

  test('queues concurrent starts and runs exactly one turn at a time', async () => {
    const store = createStore();
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const inputs: string[] = [];
    const runner: ThreadTurnRunnerV1 = {
      run: async context => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        inputs.push(context.input);
        await new Promise<void>(resolve => releases.push(resolve));
        active -= 1;
        return { status: 'completed' };
      },
    };
    const runtime = new ThreadRuntimeV1({ store, runner });
    expect(
      runtime.dispatch({ type: 'turn.start', data: { input: 'first', mode: 'build' } }).status
    ).toBe('started');
    const queued = runtime.dispatch({
      type: 'turn.follow_up',
      data: { input: 'second' },
    });
    expect(queued.status).toBe('queued');
    expect(runtime.getProjection().queue).toHaveLength(1);

    await waitFor(() => releases.length === 1);
    releases.shift()?.();
    await waitFor(() => releases.length === 1);
    releases.shift()?.();
    await runtime.waitForIdle();

    expect(inputs).toEqual(['first', 'second']);
    expect(maxActive).toBe(1);
    expect(runtime.getProjection().queue).toHaveLength(0);
    expect(Object.values(runtime.getProjection().turns)).toHaveLength(2);
  });

  test('durably records steer without aborting or replacing the current turn', async () => {
    const store = createStore();
    let contextRef: ThreadTurnExecutionContextV1 | undefined;
    let release: (() => void) | undefined;
    const steers: string[] = [];
    const runner: ThreadTurnRunnerV1 = {
      run: async context => {
        contextRef = context;
        context.onSteer(input => {
          steers.push(input);
        });
        await new Promise<void>(resolve => {
          release = resolve;
        });
        return { status: 'completed' };
      },
    };
    const runtime = new ThreadRuntimeV1({ store, runner });
    runtime.dispatch({ type: 'turn.start', data: { input: 'initial', mode: 'build' } });
    await waitFor(() => contextRef !== undefined);

    const steered = runtime.dispatch({ type: 'turn.steer', data: { input: 'change direction' } });
    expect(steered.status).toBe('steered');
    expect(contextRef?.abortSignal.aborted).toBe(false);
    await waitFor(() => steers.length === 1);
    expect(steers).toEqual(['change direction']);
    const activeTurn = Object.values(runtime.getProjection().turns)[0];
    expect(activeTurn.steeringItemIds).toHaveLength(1);

    release?.();
    await runtime.waitForIdle();
  });

  test('flushes interrupt intent before propagating AbortSignal', async () => {
    const store = createStore();
    let observedDurableIntent = false;
    const runner: ThreadTurnRunnerV1 = {
      run: context =>
        new Promise(resolve => {
          context.abortSignal.addEventListener(
            'abort',
            () => {
              const turn = runtime.getProjection().turns[context.turnId];
              observedDurableIntent = Boolean(turn.interruptIntentId);
              resolve({ status: 'interrupted', reason: 'aborted' });
            },
            { once: true }
          );
        }),
    };
    const runtime = new ThreadRuntimeV1({ store, runner });
    const started = runtime.dispatch({
      type: 'turn.start',
      data: { input: 'long task', mode: 'auto' },
    });
    await waitFor(() => runtime.getAdmissionSnapshot().activeTurn !== undefined);
    const interrupted = runtime.dispatch({
      type: 'turn.interrupt',
      data: { reason: 'user stopped' },
    });
    expect(interrupted).toMatchObject({ status: 'interrupt_requested', alreadyRequested: false });
    await runtime.waitForIdle();

    expect(started.status).toBe('started');
    expect(observedDurableIntent).toBe(true);
    expect(Object.values(runtime.getProjection().turns)[0]).toMatchObject({
      status: 'interrupted',
      interruptIntentId: expect.any(String),
    });
  });

  test('makes maintenance turns non-steerable', async () => {
    const store = createStore();
    let release: (() => void) | undefined;
    const runtime = new ThreadRuntimeV1({
      store,
      runner: {
        run: async () => {
          await new Promise<void>(resolve => {
            release = resolve;
          });
          return { status: 'completed' };
        },
      },
    });
    expect(runtime.startMaintenance('compact').status).toBe('started');
    expect(runtime.dispatch({ type: 'turn.steer', data: { input: 'do something else' } })).toEqual({
      status: 'rejected',
      reason: 'non_steerable',
    });
    await waitFor(() => release !== undefined);
    release?.();
    await runtime.waitForIdle();
  });

  test('recovers orphaned Items as indeterminate on restart', () => {
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

    const runtime = new ThreadRuntimeV1({
      store,
      runner: { run: async () => ({ status: 'completed' }) },
    });
    expect(runtime.getProjection().items[itemId].status).toBe('indeterminate');
    expect(runtime.getProjection().turns[turnId].status).toBe('interrupted');
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
