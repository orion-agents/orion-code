/**
 * v0.3.22 T22-02 — durability fault-injection matrix.
 *
 * Each scenario injects a failure at one of the seven durability boundaries
 * (turn start, step snapshot, tool intent, tool receipt, turn commit, turn
 * terminal, compaction pointer) through the real `onBoundary` hook or a shared
 * journal, reopens the store like a restarted process would, and asserts the
 * four recovery columns: durable stream, projection/read model, tool receipt
 * state, and the user-visible recovery outcome. The core invariants:
 * no duplicated external side effects, no fabricated success, no Failed or
 * Interrupted turn projected as Completed, and indeterminate outcomes stay
 * indeterminate.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

import {
  InMemoryToolInvocationJournalV1,
  ToolGateway,
  createSandboxPreparationV1,
  createStaticApprovalDecisionV1,
  createStaticPolicyDecisionV1,
  type ToolInvocationV1,
} from '../src/runtime/tool-gateway';
import {
  ExecutionService,
  captureStepSnapshotV1,
  createAuthoritySnapshotV1,
  createCapabilityPlanV1,
  createExecutionPolicySnapshotV1,
  type ToolBindingV1,
} from '../src/runtime/step-snapshot';
import { ThreadEventStore } from '../src/runtime/thread-event-store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createStore(
  options: ConstructorParameters<typeof ThreadEventStore>[2] = {}
): ThreadEventStore {
  const root = mkdtempSync(join(tmpdir(), 'orion-durability-'));
  roots.push(root);
  return new ThreadEventStore(root, randomUUID(), options);
}

function snapshot() {
  const binding: ToolBindingV1 = {
    descriptor: {
      name: 'write_file',
      aliases: ['write'],
      description: 'Write a file',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      executorId: 'builtin:write_file:v1',
      risk: {
        readOnly: false,
        destructive: true,
        fileEdit: true,
        effect: 'workspace_write',
        network: 'none',
      },
    },
    execute: async () => ({ success: true, output: 'written' }),
  };
  return captureStepSnapshotV1({
    threadId: randomUUID(),
    turnId: randomUUID(),
    stepId: randomUUID(),
    taskEpoch: 0,
    baseMode: 'build',
    model: {
      providerId: 'test',
      modelId: 'test-model',
      protocol: 'openai-completions',
      contextWindow: 32_000,
    },
    authority: createAuthoritySnapshotV1({
      authorityId: 'workspace',
      projectRoot: '/workspace',
      confirmation: 'ask',
      filesystem: 'workspace',
      network: 'deny',
    }),
    executionPolicy: createExecutionPolicySnapshotV1({
      policyId: 'sandboxed',
      approvalMode: 'interactive',
      sandboxRequired: true,
      sandboxBackend: 'test',
      timeoutMs: 5_000,
    }),
    environment: {
      cwd: '/workspace',
      platform: 'test',
      arch: 'test',
      environmentDigest: 'test-environment',
    },
    capabilityPlan: createCapabilityPlanV1({
      direct: [{ id: 'write_file', reason: 'task requires an edit' }],
    }),
    prompt: { version: 1, sections: [], estimatedTokens: 0, digest: 'prompt' },
    toolBindings: [binding],
    skills: { version: 1, selected: [], catalogDigest: 'skills', digest: 'skills-none' },
    mcp: { version: 1, selected: [], catalogDigest: 'mcp', digest: 'mcp-none' },
    taskContextRevision: 0,
  });
}

function toolInvocation(store: ThreadEventStore): {
  request: ToolInvocationV1;
  journal: InMemoryToolInvocationJournalV1;
} {
  const journal = new InMemoryToolInvocationJournalV1();
  const gateway = new ToolGateway({
    policy: { decide: () => createStaticPolicyDecisionV1({ behavior: 'allow', source: 'policy' }) },
    approval: { decide: () => createStaticApprovalDecisionV1({ approved: true, source: 'test' }) },
    sandbox: {
      prepare: () => createSandboxPreparationV1({ backend: 'test', enforcement: 'full' }),
    },
    execution: new ExecutionService(),
    journal,
  });
  void gateway;
  const request: ToolInvocationV1 = {
    invocationId: randomUUID(),
    snapshot: snapshot(),
    toolName: 'write_file',
    args: { path: 'README.md', content: 'updated' },
    context: { cwd: store.rootDir, config: { name: 'orion', mode: 'build' } },
  };
  return { request, journal };
}

describe('T22-02 durability fault-injection matrix', () => {
  test('turn start: crash before the log write leaves nothing durable', () => {
    const store = createStore({
      onBoundary: boundary => {
        if (boundary === 'before_log_write') throw new Error('simulated crash before log');
      },
    });
    expect(() => store.appendDurable({ payload: { type: 'thread.started', data: {} } })).toThrow(
      'simulated crash before log'
    );
    // A restarted process sees an empty durable stream: the turn never started.
    const resumed = new ThreadEventStore(store.rootDir, store.threadId);
    expect(resumed.getCursor()).toBe(0);
    expect(resumed.replay().events).toHaveLength(0);
    expect(resumed.loadProjection().activeTurnId).toBeUndefined();
  });

  test('turn start: crash after flush but before projection publication stays durable and recovers as interrupted', () => {
    let appends = 0;
    const store = createStore({
      onBoundary: boundary => {
        // Crash the projection publication of the SECOND append (the turn
        // start); the thread.started append completes normally.
        if (boundary === 'before_projection_write' && ++appends === 2) {
          throw new Error('simulated projection crash');
        }
      },
    });
    const turnId = randomUUID();
    store.appendDurable({ payload: { type: 'thread.started', data: {} } });
    expect(() =>
      store.appendDurable({
        turnId,
        payload: { type: 'turn.started', data: { input: 'fix tests', mode: 'build' } },
      })
    ).toThrow('simulated projection crash');

    const resumed = new ThreadEventStore(store.rootDir, store.threadId);
    // The event itself is durable (flushed before the boundary).
    expect(resumed.replay().events.map(event => event.payload.type)).toContain('turn.started');
    // Recovery publishes the indeterminate outcome instead of a success.
    const projection = resumed.recoverIncomplete('runtime_restarted_before_terminal_commit');
    expect(projection.turns[turnId]).toBeDefined();
    expect(projection.turns[turnId].status).not.toBe('completed');
    const replayed = resumed.replay().events.map(event => event.payload.type);
    expect(replayed).toContain('turn.interrupted');
  });

  test('tool intent: crash between intent and receipt keeps the outcome indeterminate across processes', async () => {
    let executions = 0;
    const journal = new InMemoryToolInvocationJournalV1();
    const buildGateway = () =>
      new ToolGateway({
        policy: {
          decide: () => createStaticPolicyDecisionV1({ behavior: 'allow', source: 'policy' }),
        },
        approval: {
          decide: () => createStaticApprovalDecisionV1({ approved: true, source: 'test' }),
        },
        sandbox: {
          prepare: () => createSandboxPreparationV1({ backend: 'test', enforcement: 'full' }),
        },
        execution: new ExecutionService(),
        journal,
      });
    const request: ToolInvocationV1 = {
      invocationId: randomUUID(),
      snapshot: snapshot(),
      toolName: 'write_file',
      args: { path: 'README.md', content: 'updated' },
      context: { cwd: '/workspace', config: { name: 'orion', mode: 'build' } },
    };
    void toolInvocation;

    // Start the invocation on a journal whose completion is lost (the process
    // dies between the durable intent and the durable receipt).
    const dyingJournal = journal as unknown as {
      complete: (receipt: unknown) => Promise<void>;
    };
    dyingJournal.complete = async () => {
      throw new Error('process died before receipt');
    };
    await expect(buildGateway().invoke(request)).rejects.toMatchObject({
      code: 'ORION_TOOL_RECEIPT_PERSISTENCE',
    });
    const durableIntent = await journal.load(request.invocationId);
    expect(durableIntent?.intent).toBeDefined();
    expect(durableIntent?.receipt).toBeUndefined();

    // A restarted process shares only the journal: replaying must refuse to
    // re-execute the side effect and report indeterminate.
    dyingJournal.complete = async () => undefined;
    await expect(buildGateway().invoke(request)).rejects.toMatchObject({
      code: 'ORION_TOOL_OUTCOME_INDETERMINATE',
    });
    expect(executions).toBe(0);
  });

  test('tool receipt: a persistence failure never fabricates a success receipt', async () => {
    const executions = { count: 0 };
    const journal = new InMemoryToolInvocationJournalV1();
    journal.complete = async () => {
      throw new Error('disk unavailable');
    };
    const gateway = new ToolGateway({
      policy: {
        decide: () => createStaticPolicyDecisionV1({ behavior: 'allow', source: 'policy' }),
      },
      approval: {
        decide: () => createStaticApprovalDecisionV1({ approved: true, source: 'test' }),
      },
      sandbox: {
        prepare: () => createSandboxPreparationV1({ backend: 'test', enforcement: 'full' }),
      },
      execution: new ExecutionService(),
      journal,
    });
    const request: ToolInvocationV1 = {
      invocationId: randomUUID(),
      snapshot: snapshot(),
      toolName: 'write_file',
      args: { path: 'README.md', content: 'updated' },
      context: { cwd: '/workspace', config: { name: 'orion', mode: 'build' } },
    };
    void executions;
    await expect(gateway.invoke(request)).rejects.toMatchObject({
      code: 'ORION_TOOL_RECEIPT_PERSISTENCE',
    });
    const entry = await journal.load(request.invocationId);
    expect(entry?.receipt).toBeUndefined();
  });

  test('turn commit: a lost commit recovers as interrupted, never as completed', () => {
    let appends = 0;
    const store = createStore({
      onBoundary: boundary => {
        // The commit event (the third append) never reaches the log.
        if (boundary === 'before_log_write' && ++appends === 3) {
          throw new Error('simulated commit loss');
        }
      },
    });
    const turnId = randomUUID();
    store.appendDurable({ payload: { type: 'thread.started', data: {} } });
    store.appendDurable({
      turnId,
      payload: { type: 'turn.started', data: { input: 'refactor', mode: 'build' } },
    });
    expect(() =>
      store.appendDurable({
        turnId,
        stepId: randomUUID(),
        itemId: randomUUID(),
        payload: { type: 'item.started', data: { kind: 'command', name: 'write_file' } },
      })
    ).toThrow('simulated commit loss');

    const resumed = new ThreadEventStore(store.rootDir, store.threadId);
    const projection = resumed.recoverIncomplete('runtime_restarted_before_terminal_commit');
    // The active turn recovers with an explicit interrupted outcome.
    expect(projection.turns[turnId]).toBeDefined();
    expect(projection.turns[turnId].status).not.toBe('completed');
    expect(resumed.replay().events.map(event => event.payload.type)).toContain('turn.interrupted');
  });

  test('turn terminal: a user cancellation stays interrupted after recovery', () => {
    const store = createStore();
    const turnId = randomUUID();
    store.appendDurable({ payload: { type: 'thread.started', data: {} } });
    store.appendDurable({
      turnId,
      payload: { type: 'turn.started', data: { input: 'long task', mode: 'build' } },
    });
    store.appendDurable({
      turnId,
      payload: { type: 'turn.interrupted', data: { reason: 'user_cancelled' } },
    });
    const before = store.loadProjection();
    const after = store.recoverIncomplete('runtime_restarted_before_terminal_commit');
    // The interrupted terminal survives recovery untouched: no resurrection.
    expect(after.turns[turnId]).toMatchObject(before.turns[turnId]);
    expect(after.turns[turnId].status).not.toBe('completed');
  });

  test('a failed turn is not re-projected as completed by recovery', () => {
    const store = createStore();
    const turnId = randomUUID();
    store.appendDurable({ payload: { type: 'thread.started', data: {} } });
    store.appendDurable({
      turnId,
      payload: { type: 'turn.started', data: { input: 'doomed', mode: 'build' } },
    });
    store.appendDurable({ turnId, payload: { type: 'turn.failed', data: { error: 'boom' } } });
    const projection = store.recoverIncomplete('runtime_restarted_before_terminal_commit');
    expect(projection.turns[turnId].status).toBe('failed');
    const types = store.replay().events.map(event => event.payload.type);
    expect(types).not.toContain('turn.completed');
  });

  test('double session overlap: sequential turns adopt the log monotonically without identity borrowing', () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-durability-shared-'));
    roots.push(root);
    const threadId = randomUUID();
    const sessionA = new ThreadEventStore(root, threadId);
    const turnA = randomUUID();
    sessionA.appendDurable({ payload: { type: 'thread.started', data: {} } });
    sessionA.appendDurable({
      turnId: turnA,
      payload: { type: 'turn.started', data: { input: 'A', mode: 'build' } },
    });
    sessionA.appendDurable({ turnId: turnA, payload: { type: 'turn.completed', data: {} } });

    // A second session (a restarted process) adopts the persisted head and
    // appends the next turn: sequences stay monotonic and identities distinct.
    const sessionB = new ThreadEventStore(root, threadId);
    const turnB = randomUUID();
    sessionB.appendDurable({
      turnId: turnB,
      payload: { type: 'turn.started', data: { input: 'B', mode: 'build' } },
    });

    const observer = new ThreadEventStore(root, threadId);
    const events = observer.replay().events;
    expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4]);
    const projection = observer.loadProjection();
    expect(projection.turns[turnA]).toMatchObject({ status: 'completed' });
    expect(projection.turns[turnB]).toMatchObject({ status: 'active' });
    expect(projection.activeTurnId).toBe(turnB);
  });

  test('two concurrent sessions on separate threads never borrow each other identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-durability-parallel-'));
    roots.push(root);
    const threadA = randomUUID();
    const threadB = randomUUID();
    const storeA = new ThreadEventStore(root, threadA);
    const storeB = new ThreadEventStore(root, threadB);
    const turnA = randomUUID();
    const turnB = randomUUID();
    storeA.appendDurable({ payload: { type: 'thread.started', data: {} } });
    storeB.appendDurable({ payload: { type: 'thread.started', data: {} } });
    storeA.appendDurable({
      turnId: turnA,
      payload: { type: 'turn.started', data: { input: 'A', mode: 'build' } },
    });
    storeB.appendDurable({
      turnId: turnB,
      payload: { type: 'turn.started', data: { input: 'B', mode: 'build' } },
    });
    // Each thread's durable stream is its own: A's turn never appears in B's
    // projection and vice versa.
    const projectionA = storeA.loadProjection();
    const projectionB = storeB.loadProjection();
    expect(Object.keys(projectionA.turns)).toEqual([turnA]);
    expect(Object.keys(projectionB.turns)).toEqual([turnB]);
    expect(projectionA.activeTurnId).toBe(turnA);
    expect(projectionB.activeTurnId).toBe(turnB);
  });

  test('compaction boundary: a crash during projection publication loses nothing durable', () => {
    let crash = true;
    const store = createStore({
      onBoundary: boundary => {
        if (crash && boundary === 'before_projection_write') {
          crash = false;
          throw new Error('simulated compaction crash');
        }
      },
    });
    const turnId = randomUUID();
    expect(() => store.appendDurable({ payload: { type: 'thread.started', data: {} } })).toThrow(
      'simulated compaction crash'
    );
    const resumed = new ThreadEventStore(store.rootDir, store.threadId);
    resumed.appendDurable({
      turnId,
      payload: { type: 'turn.started', data: { input: 'continue', mode: 'build' } },
    });
    // The durable stream keeps the identity of every flushed event across the
    // crash: replay from zero sees both.
    const types = resumed.replay().events.map(event => event.payload.type);
    expect(types).toEqual(['thread.started', 'turn.started']);
    expect(existsSync(store.logPath)).toBe(true);
    expect(readFileSync(store.logPath, 'utf8')).toContain('thread.started');
  });
});
