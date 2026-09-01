import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type {
  AgentRuntimeEvent,
  AgentRuntimeEventSink,
} from '../src/runtime/agent-runtime-protocol';
import type { AgentTurnRequest } from '../src/runtime/goals/types';
import { GoalLifecycleServiceV2 } from '../src/runtime/goal-lifecycle-v2';
import { digestRuntimeValue } from '../src/runtime/protocol/canonical';
import {
  ExecutionService,
  captureStepSnapshotV1,
  createAuthoritySnapshotV1,
  createCapabilityPlanV1,
  createExecutionPolicySnapshotV1,
  type ToolBindingV1,
} from '../src/runtime/step-snapshot';
import { ThreadEventStore } from '../src/runtime/thread-event-store';
import { ThreadToolInvocationJournalV1 } from '../src/runtime/thread-tool-journal';
import {
  ThreadRuntimeV1,
  type ThreadTurnExecutionContextV1,
  type ThreadTurnRunnerV1,
} from '../src/runtime/thread-runtime';
import { ThreadUiAdapterError, ThreadUiAdapterV1 } from '../src/runtime/thread-ui-adapter';
import {
  ToolGateway,
  createSandboxPreparationV1,
  createStaticApprovalDecisionV1,
  createStaticPolicyDecisionV1,
  type ToolInvocationReceiptV1,
} from '../src/runtime/tool-gateway';
import { ThreadTurnCommitJournalV1 } from '../src/runtime/turn-commit';
import type { TranscriptAppendEntry, UiEventSink } from '../src/runtime/ui-events';

describe('ThreadUiAdapterV1', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function createStore(): ThreadEventStore {
    const root = mkdtempSync(join(tmpdir(), 'orion-thread-ui-adapter-'));
    roots.push(root);
    return new ThreadEventStore(root, randomUUID());
  }

  function collectAgentEvents(): {
    readonly events: AgentRuntimeEvent[];
    readonly sink: AgentRuntimeEventSink;
  } {
    const events: AgentRuntimeEvent[] = [];
    let nextEntry = 1;
    return {
      events,
      sink: {
        emit: event => {
          events.push(event);
          return event.type === 'transcript_append' ? `entry-${nextEntry++}` : undefined;
        },
      },
    };
  }

  test('runs a turn to idle and maps every semantic Item kind without renderer imports', async () => {
    const { events, sink } = collectAgentEvents();
    const runner: ThreadTurnRunnerV1 = {
      run: async context => {
        const message = context.startItem({ kind: 'message', role: 'assistant' });
        context.emitDelta(message, 'hel');
        context.emitDelta(message, 'lo');
        context.completeItem(message, { content: 'hello' });

        const reasoning = context.startItem({ kind: 'reasoning' });
        context.emitDelta(reasoning, 'inspect');
        context.completeItem(reasoning, { content: 'inspect carefully' });

        const command = context.startItem({
          kind: 'command',
          name: 'exec_command',
          inputDigest: 'sha256:command',
        });
        context.emitDelta(command, 'ok', 'output');
        context.completeItem(command, { content: 'ok', summary: 'command complete' });

        const file = context.startItem({ kind: 'file_change', name: 'write_file' });
        context.completeItem(file, { content: 'changed', summary: 'one file changed' });

        const mcp = context.startItem({ kind: 'mcp', name: 'mcp__docs__search' });
        context.failItem(mcp, 'server unavailable');

        const plan = context.startItem({ kind: 'plan' });
        context.completeItem(plan, { content: '1. inspect\n2. implement' });

        const compact = context.startItem({ kind: 'compact' });
        context.completeItem(compact, { content: 'durable summary' });
        return { status: 'completed', outcome: 'done' };
      },
    };
    const runtime = new ThreadRuntimeV1({ store: createStore(), runner });
    const adapter = new ThreadUiAdapterV1({ runtime, eventSink: sink, mode: 'auto' });

    await adapter.runInput('do the work');

    expect(runtime.getProjection()).toMatchObject({ status: 'idle' });
    expect(Object.values(runtime.getProjection().turns)).toEqual([
      expect.objectContaining({ mode: 'auto', status: 'completed', input: 'do the work' }),
    ]);
    expect(events).toContainEqual({ type: 'processing_changed', processing: true });
    expect(events).toContainEqual({ type: 'processing_changed', processing: false });
    expect(events).toContainEqual({ type: 'status_changed', message: 'done' });

    const appends = events.filter(
      (event): event is Extract<AgentRuntimeEvent, { type: 'transcript_append' }> =>
        event.type === 'transcript_append'
    );
    expect(appends.map(event => event.entry.title)).toEqual(
      expect.arrayContaining(['you', 'reasoning', 'plan', 'compact'])
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'transcript_finalize',
        patch: expect.objectContaining({ content: 'hello' }),
      })
    );

    const starts = events.filter(
      (event): event is Extract<AgentRuntimeEvent, { type: 'tool_started' }> =>
        event.type === 'tool_started'
    );
    const finishes = events.filter(
      (event): event is Extract<AgentRuntimeEvent, { type: 'tool_finished' }> =>
        event.type === 'tool_finished'
    );
    expect(starts.map(event => event.event.name)).toEqual([
      'exec_command',
      'write_file',
      'mcp__docs__search',
    ]);
    expect(finishes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({ name: 'exec_command', success: true }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({ name: 'write_file', success: true }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            name: 'mcp__docs__search',
            success: false,
            error: 'server unavailable',
          }),
        }),
      ])
    );
    expect(adapter.snapshot().cursor).toBe(runtime.getProjection().cursor);
    adapter.close();
  });

  test('projects policy and receipt digests only from a validated durable ToolGateway receipt', async () => {
    const store = createStore();
    const { events, sink } = collectAgentEvents();
    let committedReceipt: ToolInvocationReceiptV1 | undefined;
    let executionPolicyDigest: string | undefined;
    const runtime = new ThreadRuntimeV1({
      store,
      runner: {
        run: async context => {
          const binding: ToolBindingV1 = {
            descriptor: {
              name: 'write_file',
              aliases: [],
              description: 'Write a fixture file',
              inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' }, content: { type: 'string' } },
                required: ['path', 'content'],
              },
              executorId: 'fixture:write_file:v1',
              risk: {
                readOnly: false,
                destructive: false,
                fileEdit: true,
                effect: 'workspace_write',
                network: 'none',
              },
            },
            execute: async () => ({ success: true, output: 'written' }),
          };
          const executionPolicy = createExecutionPolicySnapshotV1({
            policyId: 'settings-policy-fixture',
            approvalMode: 'never',
            sandboxRequired: false,
            sandboxBackend: 'fixture',
            timeoutMs: 5_000,
          });
          executionPolicyDigest = executionPolicy.digest;
          const snapshot = captureStepSnapshotV1({
            threadId: context.threadId,
            turnId: context.turnId,
            stepId: randomUUID(),
            taskEpoch: 0,
            baseMode: 'build',
            model: {
              providerId: 'fixture',
              modelId: 'fixture-model',
              protocol: 'openai-completions',
              contextWindow: 32_000,
            },
            authority: createAuthoritySnapshotV1({
              authorityId: 'fixture-workspace',
              projectRoot: '/workspace',
              confirmation: 'allow',
              filesystem: 'workspace',
              network: 'deny',
            }),
            executionPolicy,
            environment: {
              cwd: '/workspace',
              platform: 'test',
              arch: 'test',
              environmentDigest: 'fixture-environment',
            },
            capabilityPlan: createCapabilityPlanV1({
              direct: [{ id: 'write_file', reason: 'fixture write' }],
            }),
            prompt: { version: 1, sections: [], estimatedTokens: 0, digest: 'fixture-prompt' },
            toolBindings: [binding],
            skills: { version: 1, selected: [], catalogDigest: 'skills', digest: 'skills-none' },
            mcp: { version: 1, selected: [], catalogDigest: 'mcp', digest: 'mcp-none' },
            taskContextRevision: 0,
          });
          const gateway = new ToolGateway({
            policy: {
              decide: () =>
                createStaticPolicyDecisionV1({ behavior: 'ask', source: 'tool-policy' }),
            },
            approval: {
              decide: () => createStaticApprovalDecisionV1({ approved: true, source: 'authority' }),
            },
            sandbox: {
              prepare: () =>
                createSandboxPreparationV1({ backend: 'fixture', enforcement: 'full' }),
            },
            execution: new ExecutionService(),
            journal: new ThreadToolInvocationJournalV1(store),
          });
          const result = await gateway.invoke({
            invocationId: randomUUID(),
            snapshot,
            toolName: 'write_file',
            args: { path: 'fixture.txt', content: 'safe' },
            context: { cwd: '/workspace', config: { name: 'orion', mode: 'test' } },
          });
          committedReceipt = result.receipt;
          return { status: 'completed', outcome: 'tool receipt projected' };
        },
      },
    });
    const adapter = new ThreadUiAdapterV1({ runtime, eventSink: sink });

    await adapter.runInput('exercise the real ToolGateway receipt path');

    const finished = events.find(
      (event): event is Extract<AgentRuntimeEvent, { type: 'tool_finished' }> =>
        event.type === 'tool_finished'
    );
    expect(committedReceipt).toBeDefined();
    expect(committedReceipt?.digest).toBe(
      digestRuntimeValue({
        ...committedReceipt,
        digest: undefined,
      })
    );
    expect(finished?.event).toMatchObject({
      name: 'write_file',
      success: true,
      authorization: {
        approved: true,
        behavior: 'ask',
        source: 'config_allow',
      },
      executionPolicyDigest,
      receiptDigest: committedReceipt?.digest,
    });
    expect(finished?.event.receiptDigest).toBe(committedReceipt?.digest);
    expect(finished?.event.executionPolicyDigest).toBe(committedReceipt?.executionPolicyDigest);
    adapter.close();
  });

  test('runs typed Goal requests and exposes a narrow durable interrupt port', async () => {
    const { events, sink } = collectAgentEvents();
    let execution: ThreadTurnExecutionContextV1 | undefined;
    const runtime = new ThreadRuntimeV1({
      store: createStore(),
      runner: {
        run: context => {
          execution = context;
          const message = context.startItem({ kind: 'message', role: 'assistant' });
          context.emitDelta(message, 'working');
          return new Promise(resolve => {
            context.abortSignal.addEventListener(
              'abort',
              () => {
                context.completeItem(message, { content: 'stopped' });
                resolve({ status: 'interrupted', reason: 'stopped by user' });
              },
              { once: true }
            );
          });
        },
      },
    });
    const adapter = new ThreadUiAdapterV1({ runtime, eventSink: sink, mode: 'plan' });
    const request: AgentTurnRequest = {
      inputKind: 'goal_continuation',
      text: 'continue the goal',
      sessionId: 'session-1',
      goal: { goalId: 'goal-1', revision: 2, continuationIndex: 3 },
      persistAsUserMessage: false,
      echoToTranscript: false,
      generation: 4,
    };

    const running = adapter.runRequest(request);
    await waitFor(() => execution !== undefined);
    expect(execution).toMatchObject({ mode: 'goal', kind: 'goal', input: 'continue the goal' });
    await waitFor(() =>
      events.some(event => event.type === 'transcript_update' && event.patch.content === 'working')
    );

    const interrupt = adapter.interrupt('manual stop');
    expect(interrupt).toMatchObject({
      status: 'interrupt_requested',
      alreadyRequested: false,
    });
    await running;

    expect(Object.values(runtime.getProjection().turns)[0]).toMatchObject({
      mode: 'goal',
      status: 'interrupted',
      interruptIntentId: expect.any(String),
    });
    expect(events).toContainEqual({ type: 'status_changed', message: 'Interrupt requested…' });
    expect(events).toContainEqual({ type: 'status_changed', message: 'stopped by user' });
    adapter.close();
    await expect(adapter.runInput('after close')).rejects.toBeInstanceOf(ThreadUiAdapterError);
  });

  test('projects authoritative Goal V2 commits for live and restored purple-mode UI state', async () => {
    const store = createStore();
    const journal = new ThreadTurnCommitJournalV1(store);
    const lifecycle = new GoalLifecycleServiceV2({
      goalId: randomUUID(),
      objective: 'Keep Goal mode visibly purple',
      budget: { maxTokens: 50_000, maxElapsedMs: 600_000 },
      clock: () => 100,
    });
    const active = lifecycle.state;
    const { digest: _activeDigest, ...completedContent } = active;
    void _activeDigest;
    const completed = {
      ...completedContent,
      status: 'completed' as const,
      generation: active.generation + 1,
      updatedAt: active.updatedAt + 1,
    };
    let persistedGoal = active;
    const runtime = new ThreadRuntimeV1({
      store,
      requireTurnCommit: true,
      runner: {
        run: async context => {
          journal.commit({
            turnId: context.turnId,
            history: [{ role: 'user', content: context.input }],
            taskContextState: { version: 2, ledger: [], updatedAt: 100 },
            taskContextRevision: 0,
            goalState: persistedGoal,
            terminal: { status: 'completed', outcome: 'goal state projected' },
          });
          return { status: 'completed', outcome: 'goal state projected' };
        },
      },
    });
    const live = collectAgentEvents();
    const adapter = new ThreadUiAdapterV1({ runtime, eventSink: live.sink, mode: 'auto' });

    await adapter.runInput('persist active Goal');
    expect(live.events).toContainEqual({
      type: 'goal_event',
      event: {
        type: 'goal_updated',
        reason: 'durable_turn_commit',
        goal: expect.objectContaining({
          goalId: active.goalId,
          status: 'active',
          objective: active.objective,
          tokenBudget: active.budget.maxTokens,
        }),
      },
    });

    const restored = collectAgentEvents();
    const restoredAdapter = new ThreadUiAdapterV1({ runtime, eventSink: restored.sink });
    expect(restored.events).toContainEqual(
      expect.objectContaining({
        type: 'goal_event',
        event: expect.objectContaining({
          type: 'goal_updated',
          goal: expect.objectContaining({ goalId: active.goalId, status: 'active' }),
        }),
      })
    );

    persistedGoal = { ...completed, digest: digestRuntimeValue(completed) };
    await adapter.runInput('complete Goal and exit its color override');
    expect(live.events).toContainEqual({
      type: 'goal_event',
      event: {
        type: 'goal_cleared',
        goalId: active.goalId,
        reason: 'completion_auto_exit',
      },
    });

    restoredAdapter.close();
    adapter.close();
  });

  test('recovers a slow live consumer through durable replay_required', async () => {
    const { events, sink } = collectAgentEvents();
    const runtime = new ThreadRuntimeV1({
      store: createStore(),
      runner: {
        run: async context => {
          for (const content of ['one', 'two', 'three']) {
            const item = context.startItem({ kind: 'message', role: 'assistant' });
            context.completeItem(item, { content });
          }
          return { status: 'completed', outcome: 'all delivered' };
        },
      },
    });
    const replay = jest.spyOn(runtime, 'replay');
    const adapter = new ThreadUiAdapterV1({
      runtime,
      eventSink: sink,
      buffer: { maxItems: 1, maxBytes: 1024 },
    });

    expect(
      runtime.dispatch({ type: 'turn.start', data: { input: 'produce facts', mode: 'build' } })
    ).toMatchObject({ status: 'started' });
    await runtime.waitForIdle();
    expect(adapter.flush().cursor).toBe(runtime.getProjection().cursor);

    expect(replay).toHaveBeenCalledWith(1, undefined, 'ui_gap_recovery');
    const finalizedContent = events
      .filter(
        (event): event is Extract<AgentRuntimeEvent, { type: 'transcript_finalize' }> =>
          event.type === 'transcript_finalize'
      )
      .map(event => event.patch?.content);
    expect(finalizedContent).toEqual(
      expect.arrayContaining(['produce facts', 'one', 'two', 'three'])
    );
    expect(events).toContainEqual({ type: 'status_changed', message: 'all delivered' });
    adapter.close();
  });

  test('replays a historical cursor into the existing UiEventSink contract', async () => {
    const runtime = new ThreadRuntimeV1({
      store: createStore(),
      runner: {
        run: async context => {
          const message = context.startItem({ kind: 'message', role: 'assistant' });
          context.completeItem(message, { content: 'persisted answer' });
          return { status: 'completed' };
        },
      },
    });
    runtime.dispatch({ type: 'turn.start', data: { input: 'historical', mode: 'build' } });
    await runtime.waitForIdle();
    const ui = createUiSink();
    const adapter = new ThreadUiAdapterV1({
      runtime,
      uiEventSink: ui.sink,
      cursor: 0,
    });

    expect(adapter.flush().cursor).toBe(runtime.getProjection().cursor);
    expect(ui.appended.map(entry => entry.title)).toContain('you');
    expect(ui.finalize).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ content: 'persisted answer' })
    );
    expect(ui.setProcessing).toHaveBeenNthCalledWith(1, true);
    expect(ui.setProcessing).toHaveBeenLastCalledWith(false);
    adapter.close();
  });

  test('projects the restored base mode after a PLAN turn reaches its durable terminal', async () => {
    const { events, sink } = collectAgentEvents();
    let mode: 'plan' | 'auto' = 'plan';
    const runtime = new ThreadRuntimeV1({
      store: createStore(),
      runner: {
        run: async () => {
          mode = 'auto';
          return { status: 'completed', outcome: 'plan saved' };
        },
      },
    });
    const adapter = new ThreadUiAdapterV1({ runtime, eventSink: sink, mode: () => mode });

    await adapter.runInput('create a decision-complete plan');

    expect(Object.values(runtime.getProjection().turns)[0]).toMatchObject({ mode: 'plan' });
    expect(events).toContainEqual({
      type: 'agent_mode_changed',
      snapshot: { baseMode: 'auto', pendingBaseMode: null },
    });
    adapter.close();
  });
});

function createUiSink(): {
  readonly sink: UiEventSink;
  readonly appended: TranscriptAppendEntry[];
  readonly finalize: jest.Mock;
  readonly setProcessing: jest.Mock;
} {
  const appended: TranscriptAppendEntry[] = [];
  const finalize = jest.fn();
  const setProcessing = jest.fn();
  let nextId = 1;
  return {
    appended,
    finalize,
    setProcessing,
    sink: {
      append: entry => {
        appended.push(entry);
        return `ui-entry-${nextId++}`;
      },
      update: jest.fn(),
      finalize,
      remove: jest.fn(),
      replaceTranscript: jest.fn(),
      clearTranscript: jest.fn(),
      setStatus: jest.fn(),
      showSessionPicker: jest.fn(),
      showEditPreview: jest.fn(),
      setProcessing,
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setImmediate(resolve));
  }
}
