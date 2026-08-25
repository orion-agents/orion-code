import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createStopDecision } from '../src/framework/stop-decision';
import { ThreadStepSnapshotJournalV1 } from '../src/runtime/agent-loop';
import { CapabilityReceiptJournalV1 } from '../src/runtime/capability-receipt-journal';
import { CapabilityAgentLoopStepFactoryV1 } from '../src/runtime/capability-step-factory';
import { digestRuntimeValue } from '../src/runtime/protocol/canonical';
import {
  captureStepSnapshotV1,
  createAuthoritySnapshotV1,
  createCapabilityPlanV1,
  createExecutionPolicySnapshotV1,
  type AuthoritySnapshotV1,
  type StepSnapshotV1,
} from '../src/runtime/step-snapshot';
import {
  assertSubagentThreadReceiptV1,
  SubagentThreadRuntimeError,
  SubagentThreadRuntimeV1,
  SubagentThreadTreeScopeV1,
  type SubagentAgentLoopFactoryInputV1,
  type SubagentAgentLoopFactoryV1,
} from '../src/runtime/subagent-thread-runtime';
import { createTaskContextService } from '../src/runtime/task-context-service';
import { ThreadEventStore } from '../src/runtime/thread-event-store';
import { ThreadTurnCommitJournalV1 } from '../src/runtime/turn-commit';

describe('SubagentThreadRuntimeV1', () => {
  const roots: string[] = [];
  const trees: SubagentThreadTreeScopeV1[] = [];

  afterEach(() => {
    for (const tree of trees.splice(0)) tree.close('test cleanup');
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function createRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'orion-subagent-thread-'));
    roots.push(root);
    return root;
  }

  function createTree(
    limits: ConstructorParameters<typeof SubagentThreadTreeScopeV1>[0],
    signal?: AbortSignal
  ): SubagentThreadTreeScopeV1 {
    const tree = new SubagentThreadTreeScopeV1(limits, signal);
    trees.push(tree);
    return tree;
  }

  test('flushes and verifies the active parent step receipts before creating a child', async () => {
    const root = createRoot();
    const parent = await createParent(root, false);
    const flush = jest.fn();
    const createAgentLoop = jest.fn<ReturnType<SubagentAgentLoopFactoryV1>, []>();
    const tree = createTree({
      maxConcurrent: 1,
      maxModelRequests: 2,
      maxToolCalls: 1,
    });
    const runtime = new SubagentThreadRuntimeV1({
      childStoreRootDir: join(root, 'children'),
      tree,
      rolePolicies: { review: roleAuthority(root) },
      createAgentLoop: createAgentLoop as unknown as SubagentAgentLoopFactoryV1,
      defaultBudget: { maxModelRequests: 1, maxToolCalls: 0 },
    });

    await expect(
      runtime.run({
        parent: forkRequest(parent, flush),
        parentAuthority: parent.authority,
        role: 'review',
        objective: 'inspect the change',
      })
    ).rejects.toMatchObject({
      code: 'ORION_SUBAGENT_PARENT_STEP_NOT_DURABLE',
    } satisfies Partial<SubagentThreadRuntimeError>);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(createAgentLoop).not.toHaveBeenCalled();
    expect(tree.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  test('rejects a terminal parent TurnCommit instead of treating it as a fork anchor', async () => {
    const root = createRoot();
    const parent = await createParent(root, true);
    const taskContext = createTaskContextService({
      cwd: parent.authority.projectRoot,
      modelId: 'parent-model',
      config: { completionGate: 'off' },
    });
    new ThreadTurnCommitJournalV1(parent.store).commit({
      turnId: parent.turnId,
      history: [{ role: 'user', content: 'parent task' }],
      taskContextState: taskContext.exportState(),
      taskContextRevision: taskContext.revision,
      terminal: { status: 'completed', outcome: 'must not anchor child' },
    });
    const createAgentLoop = jest.fn<ReturnType<SubagentAgentLoopFactoryV1>, []>();
    const runtime = new SubagentThreadRuntimeV1({
      childStoreRootDir: join(root, 'children'),
      tree: createTree({ maxConcurrent: 1, maxModelRequests: 1, maxToolCalls: 0 }),
      rolePolicies: { review: roleAuthority(root) },
      createAgentLoop: createAgentLoop as unknown as SubagentAgentLoopFactoryV1,
    });

    await expect(
      runtime.run({
        parent: forkRequest(parent),
        parentAuthority: parent.authority,
        role: 'review',
        objective: 'must not use a previous commit',
      })
    ).rejects.toMatchObject({
      code: 'ORION_SUBAGENT_PARENT_NOT_ACTIVE',
    } satisfies Partial<SubagentThreadRuntimeError>);
    expect(createAgentLoop).not.toHaveBeenCalled();
  });

  test('forks an isolated child with intersected authority, bounded result, and independent snapshot', async () => {
    const root = createRoot();
    const projectRoot = join(root, 'project');
    const roleRoot = join(projectRoot, 'review-scope');
    const parent = await createParent(root, true, parentAuthority(projectRoot));
    const tree = createTree({
      maxConcurrent: 2,
      maxModelRequests: 4,
      maxToolCalls: 2,
    });
    const childSnapshots: StepSnapshotV1[] = [];
    const fullSummary = '结果'.repeat(80);
    const createAgentLoop = committingLoopFactory({
      summary: fullSummary,
      modelRequests: 2,
      toolCalls: 1,
      snapshots: childSnapshots,
      evidence: [
        {
          kind: 'verification',
          source: 'jest',
          detail: 'focused test passed with a deliberately overlong evidence description',
        },
        { kind: 'file', source: 'reviewer', detail: 'checked src/runtime/example.ts' },
        { kind: 'runtime', source: 'extra', detail: 'must be dropped by item bound' },
      ],
    });
    const receipts: unknown[] = [];
    const flush = jest.fn();
    const runtime = new SubagentThreadRuntimeV1({
      childStoreRootDir: join(root, 'children'),
      tree,
      rolePolicies: {
        review: createAuthoritySnapshotV1({
          authorityId: 'review-role',
          projectRoot: roleRoot,
          confirmation: 'ask',
          filesystem: 'workspace',
          network: 'read',
        }),
      },
      createAgentLoop,
      defaultBudget: { maxModelRequests: 2, maxToolCalls: 1 },
      maxSummaryBytes: 31,
      maxEvidenceItems: 2,
      maxEvidenceBytes: 24,
      clock: () => 42,
      onReceipt: receipt => {
        receipts.push(receipt);
      },
    });

    const result = await runtime.run({
      parent: {
        ...forkRequest(parent, flush),
      },
      parentAuthority: parent.authority,
      role: 'review',
      objective: 'review the runtime',
    });

    expect(flush).toHaveBeenCalledTimes(1);
    expect(result.childThreadId).not.toBe(parent.store.threadId);
    expect(result.authority).toMatchObject({
      projectRoot: roleRoot,
      confirmation: 'ask',
      filesystem: 'workspace',
      network: 'read',
    });
    expect(Buffer.byteLength(result.summary, 'utf8')).toBeLessThanOrEqual(31);
    expect(result.summary).not.toBe(fullSummary);
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence.every(item => Buffer.byteLength(item.detail, 'utf8') <= 24)).toBe(true);
    expect(result).not.toHaveProperty('history');
    expect(result).not.toHaveProperty('transcript');
    expect(result.usage).toEqual({ modelRequests: 2, toolCalls: 1 });
    expect(result.stopDecision).toMatchObject({
      schemaVersion: 1,
      scope: 'subagent',
      status: 'completed',
      resources: {
        llmRequests: { used: 2, limit: 2 },
        toolCalls: { used: 1, limit: 1 },
      },
    });
    expect(receipts).toEqual([result.receipt]);
    expect(() => assertSubagentThreadReceiptV1(result.receipt)).not.toThrow();

    const childStore = new ThreadEventStore(join(root, 'children'), result.childThreadId);
    const childProjection = childStore.loadProjection();
    const fork = childStore.replay(0).events.find(event => event.payload.type === 'thread.forked');
    expect(fork?.payload).toEqual({
      type: 'thread.forked',
      data: { sourceThreadId: parent.store.threadId, sourceSeq: parent.capabilityReceiptSeq },
    });
    expect(childProjection.turns[result.childTurnId]).toMatchObject({
      status: 'completed',
      commit: { digest: result.receipt.childCommitDigest },
    });
    expect(childSnapshots).toHaveLength(1);
    expect(childSnapshots[0]).toMatchObject({
      threadId: result.childThreadId,
      turnId: result.childTurnId,
      authority: { digest: result.authority.digest },
    });
    expect(result.receipt.childStepSnapshotDigests).toEqual([childSnapshots[0].digest]);
    expect(result.receipt.childStepSnapshotDigests).not.toContain(parent.snapshotDigest);
    expect(result.receipt).toMatchObject({
      parentThreadId: parent.store.threadId,
      parentTurnId: parent.turnId,
      parentStepId: parent.stepId,
      parentRequestId: parent.requestId,
      parentStepSnapshotDigest: parent.snapshotDigest,
      parentCapabilityReceiptDigest: parent.capabilityReceiptDigest,
    });
    expect(tree.snapshot()).toMatchObject({
      active: 0,
      modelRequests: { used: 2, reserved: 0 },
      toolCalls: { used: 1, reserved: 0 },
    });
  });

  test('shares bounded concurrency and cumulative model/tool budget across sibling Threads', async () => {
    const root = createRoot();
    const parent = await createParent(root, true);
    const tree = createTree({
      maxConcurrent: 1,
      maxQueued: 2,
      maxModelRequests: 2,
      maxToolCalls: 0,
    });
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const childThreads: string[] = [];
    const createAgentLoop: SubagentAgentLoopFactoryV1 = input => {
      childThreads.push(input.childThreadId);
      const taskContext = createTaskContextService({
        cwd: input.authority.projectRoot,
        modelId: 'child-model',
        config: { completionGate: 'off' },
      });
      return {
        run: async context => {
          input.budget.consumeModelRequests();
          active += 1;
          maxActive = Math.max(maxActive, active);
          persistSnapshot(input, context.turnId);
          await new Promise<void>(resolve => releases.push(resolve));
          active -= 1;
          const item = context.startItem({ kind: 'message', role: 'assistant' });
          context.completeItem(item, { content: `done:${input.objective}` });
          commitChildTurn(input, context.turnId, taskContext, {
            status: 'completed',
            outcome: 'done',
          });
          return { status: 'completed', outcome: 'done' };
        },
      };
    };
    const runtime = new SubagentThreadRuntimeV1({
      childStoreRootDir: join(root, 'children'),
      tree,
      rolePolicies: { review: roleAuthority(root) },
      createAgentLoop,
      defaultBudget: { maxModelRequests: 1, maxToolCalls: 0 },
    });
    const request = (objective: string) =>
      runtime.run({
        parent: forkRequest(parent),
        parentAuthority: parent.authority,
        role: 'review' as const,
        objective,
      });

    const first = request('first child');
    await waitFor(() => releases.length === 1);
    const second = request('second child');
    await waitFor(() => tree.snapshot().queued === 1);
    releases.shift()?.();
    await waitFor(() => releases.length === 1);
    releases.shift()?.();
    const results = await Promise.all([first, second]);

    expect(maxActive).toBe(1);
    expect(new Set(childThreads).size).toBe(2);
    expect(new Set(results.map(result => result.childThreadId)).size).toBe(2);
    expect(tree.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      modelRequests: { used: 2, reserved: 0, limit: 2 },
    });

    await expect(request('over budget')).rejects.toMatchObject({
      code: 'ORION_SUBAGENT_TREE_BUDGET_EXCEEDED',
    } satisfies Partial<SubagentThreadRuntimeError>);
    expect(tree.snapshot().active).toBe(0);
  });

  test('propagates root abort through a durable child interrupt and typed receipt', async () => {
    const root = createRoot();
    const parent = await createParent(root, true);
    const rootAbort = new AbortController();
    const tree = createTree(
      { maxConcurrent: 1, maxModelRequests: 1, maxToolCalls: 0 },
      rootAbort.signal
    );
    let started = false;
    const createAgentLoop: SubagentAgentLoopFactoryV1 = input => {
      const taskContext = createTaskContextService({
        cwd: input.authority.projectRoot,
        modelId: 'child-model',
        config: { completionGate: 'off' },
      });
      return {
        run: context => {
          input.budget.consumeModelRequests();
          persistSnapshot(input, context.turnId);
          started = true;
          return new Promise(resolve => {
            context.abortSignal.addEventListener(
              'abort',
              () => {
                const decision = createStopDecision({
                  scope: 'subagent',
                  status: 'cancelled',
                  disposition: 'resume_allowed',
                  reason: { code: 'root_abort', message: 'Root Thread cancelled the child.' },
                  evidence: [],
                  nextActions: [{ kind: 'resume', label: 'Resume from the child receipt.' }],
                  resources: {},
                });
                new ThreadTurnCommitJournalV1(input.childStore).commit({
                  turnId: context.turnId,
                  history: [{ role: 'user', content: input.objective }],
                  taskContextState: taskContext.exportState(),
                  taskContextRevision: taskContext.revision,
                  terminal: { status: 'interrupted', reason: 'root cancelled' },
                  stopDecision: decision,
                });
                resolve({ status: 'interrupted', reason: 'root cancelled' });
              },
              { once: true }
            );
          });
        },
      };
    };
    const runtime = new SubagentThreadRuntimeV1({
      childStoreRootDir: join(root, 'children'),
      tree,
      rolePolicies: { review: roleAuthority(root) },
      createAgentLoop,
      defaultBudget: { maxModelRequests: 1, maxToolCalls: 0 },
    });

    const running = runtime.run({
      parent: forkRequest(parent),
      parentAuthority: parent.authority,
      role: 'review',
      objective: 'long-running child',
    });
    await waitFor(() => started);
    rootAbort.abort(new Error('root cancelled'));
    const result = await running;

    expect(result).toMatchObject({
      status: 'cancelled',
      turnTerminal: 'interrupted',
      usage: { modelRequests: 1, toolCalls: 0 },
      stopDecision: {
        schemaVersion: 1,
        scope: 'subagent',
        reason: { code: 'root_abort' },
      },
    });
    expect(() => assertSubagentThreadReceiptV1(result.receipt)).not.toThrow();
    const childStore = new ThreadEventStore(join(root, 'children'), result.childThreadId);
    expect(childStore.loadProjection().turns[result.childTurnId]).toMatchObject({
      status: 'interrupted',
      interruptIntentId: expect.any(String),
    });
    expect(tree.snapshot()).toMatchObject({
      active: 0,
      closed: true,
      modelRequests: { used: 1, reserved: 0 },
    });
  });
});

interface ParentFixture {
  readonly store: ThreadEventStore;
  readonly turnId: string;
  readonly stepId: string;
  readonly requestId: string;
  readonly authority: AuthoritySnapshotV1;
  readonly snapshotDigest: string;
  readonly capabilityReceiptDigest: string;
  readonly capabilityReceiptSeq?: number;
}

async function createParent(
  root: string,
  persistStepReceipts: boolean,
  authority = parentAuthority(root)
): Promise<ParentFixture> {
  const store = new ThreadEventStore(join(root, 'parent'), randomUUID());
  const turnId = randomUUID();
  const stepId = randomUUID();
  const requestId = randomUUID();
  store.appendDurableBatch([
    { payload: { type: 'thread.started', data: { projectPath: authority.projectRoot } } },
    {
      turnId,
      payload: { type: 'turn.started', data: { input: 'parent task', mode: 'build' } },
    },
  ]);
  if (!persistStepReceipts) {
    return {
      store,
      turnId,
      stepId,
      requestId,
      authority,
      snapshotDigest: 'missing-step-snapshot',
      capabilityReceiptDigest: 'missing-capability-receipt',
    };
  }

  const executionPolicy = createExecutionPolicySnapshotV1({
    policyId: 'parent-policy',
    approvalMode: 'never',
    sandboxRequired: true,
    sandboxBackend: 'test',
    timeoutMs: 5_000,
  });
  const factory = new CapabilityAgentLoopStepFactoryV1({
    resolveConfiguration: () => ({
      taskEpoch: 1,
      model: {
        providerId: 'test',
        modelId: 'parent-model',
        protocol: 'test',
        contextWindow: 32_000,
      },
      executionPolicy,
      environment: {
        cwd: authority.projectRoot,
        platform: 'test',
        arch: 'test',
        environmentDigest: digestRuntimeValue(authority.projectRoot),
      },
      compiler: {
        task: { objective: 'parent task' },
        model: { toolCalling: true },
        authority,
        budgets: {
          maxDirectTools: 1,
          maxToolSchemaBytes: 1_024,
          maxDeferredTools: 1,
          maxExpansionTools: 1,
        },
        tools: [],
        runtimeServicesDigest: 'parent-runtime-services',
        executionPolicyDigest: executionPolicy.digest,
        skillCatalogDigest: 'parent-skill-catalog',
        mcpCatalogDigest: 'parent-mcp-catalog',
        estimatedInputTokens: 8,
      },
    }),
    resolveToolRegistry: () => new Map(),
    idFactory: identity =>
      identity.kind === 'step' ? stepId : identity.kind === 'request' ? requestId : randomUUID(),
  });
  const prepared = await factory.prepare({
    threadId: store.threadId,
    turnId,
    requestIndex: 0,
    input: 'parent task',
    mode: 'build',
    messages: [{ role: 'user', content: 'parent task' }],
    taskContextRevision: 0,
    abortSignal: new AbortController().signal,
  });
  await prepared.capture({
    messages: [{ role: 'user', content: 'parent task' }],
    taskContextRevision: 0,
  });
  const bundle = prepared.persistenceBundle;
  if (!bundle) throw new Error('Parent capability fixture was not captured.');
  const committed = new CapabilityReceiptJournalV1(store).commit(bundle);
  return {
    store,
    turnId,
    stepId,
    requestId,
    authority,
    snapshotDigest: bundle.snapshot.digest,
    capabilityReceiptDigest: bundle.capabilityReceipt.digest,
    capabilityReceiptSeq: committed.lastSeq,
  };
}

function forkRequest(parent: ParentFixture, flush = () => undefined) {
  return {
    store: parent.store,
    threadId: parent.store.threadId,
    turnId: parent.turnId,
    stepId: parent.stepId,
    requestId: parent.requestId,
    stepSnapshotDigest: parent.snapshotDigest,
    capabilityReceiptDigest: parent.capabilityReceiptDigest,
    flush,
  };
}

function parentAuthority(projectRoot: string): AuthoritySnapshotV1 {
  return createAuthoritySnapshotV1({
    authorityId: 'parent',
    projectRoot,
    confirmation: 'allow',
    filesystem: 'full',
    network: 'write',
  });
}

function roleAuthority(projectRoot: string): AuthoritySnapshotV1 {
  return createAuthoritySnapshotV1({
    authorityId: 'review-role',
    projectRoot,
    confirmation: 'ask',
    filesystem: 'workspace',
    network: 'deny',
  });
}

function committingLoopFactory(options: {
  readonly summary: string;
  readonly modelRequests: number;
  readonly toolCalls: number;
  readonly snapshots: StepSnapshotV1[];
  readonly evidence?: Parameters<SubagentAgentLoopFactoryInputV1['evidence']['record']>[0][];
}): SubagentAgentLoopFactoryV1 {
  return input => {
    const taskContext = createTaskContextService({
      cwd: input.authority.projectRoot,
      modelId: 'child-model',
      config: { completionGate: 'off' },
    });
    return {
      run: async context => {
        input.budget.consumeModelRequests(options.modelRequests);
        if (options.toolCalls > 0) input.budget.consumeToolCalls(options.toolCalls);
        for (const evidence of options.evidence ?? []) input.evidence.record(evidence);
        const snapshot = persistSnapshot(input, context.turnId);
        options.snapshots.push(snapshot);
        const item = context.startItem({ kind: 'message', role: 'assistant' });
        context.completeItem(item, { content: options.summary });
        commitChildTurn(input, context.turnId, taskContext, {
          status: 'completed',
          outcome: 'child complete',
        });
        return { status: 'completed', outcome: 'child complete' };
      },
    };
  };
}

function persistSnapshot(input: SubagentAgentLoopFactoryInputV1, turnId: string): StepSnapshotV1 {
  const snapshot = createSnapshot(input.childStore, turnId, input.authority, input.objective);
  new ThreadStepSnapshotJournalV1(input.childStore).commit(snapshot);
  return snapshot;
}

function createSnapshot(
  store: ThreadEventStore,
  turnId: string,
  authority: AuthoritySnapshotV1,
  label: string
): StepSnapshotV1 {
  const stepId = randomUUID();
  return captureStepSnapshotV1({
    threadId: store.threadId,
    turnId,
    stepId,
    taskEpoch: 1,
    baseMode: 'build',
    model: {
      providerId: 'test',
      modelId: 'test-model',
      protocol: 'test',
      contextWindow: 32_000,
    },
    authority,
    executionPolicy: createExecutionPolicySnapshotV1({
      policyId: 'test',
      approvalMode: 'never',
      sandboxRequired: true,
      sandboxBackend: 'test',
      timeoutMs: 5_000,
    }),
    environment: {
      cwd: authority.projectRoot,
      platform: 'test',
      arch: 'test',
      environmentDigest: digestRuntimeValue(authority.projectRoot),
    },
    capabilityPlan: createCapabilityPlanV1({}),
    prompt: {
      version: 1,
      sections: [],
      estimatedTokens: 0,
      digest: digestRuntimeValue(label),
    },
    toolBindings: [],
    skills: { version: 1, selected: [], catalogDigest: 'none', digest: 'none' },
    mcp: { version: 1, selected: [], catalogDigest: 'none', digest: 'none' },
    taskContextRevision: 0,
  });
}

function commitChildTurn(
  input: SubagentAgentLoopFactoryInputV1,
  turnId: string,
  taskContext: ReturnType<typeof createTaskContextService>,
  terminal: Parameters<ThreadTurnCommitJournalV1['commit']>[0]['terminal']
): void {
  const stopDecision = createStopDecision({
    scope: 'subagent',
    status:
      terminal.status === 'completed'
        ? 'completed'
        : terminal.status === 'failed'
          ? 'failed'
          : 'cancelled',
    disposition: terminal.status === 'completed' ? 'finish_scope' : 'resume_allowed',
    reason: {
      code: terminal.status === 'completed' ? 'child_verified' : `child_${terminal.status}`,
      message: terminal.status === 'completed' ? 'Child evidence is ready.' : 'Child stopped.',
    },
    evidence: [],
    nextActions: [{ kind: 'inspect', label: 'Inspect child evidence.' }],
    resources: {},
  });
  new ThreadTurnCommitJournalV1(input.childStore).commit({
    turnId,
    history: [
      { role: 'user', content: input.objective },
      { role: 'assistant', content: 'private child transcript content' },
    ],
    taskContextState: taskContext.exportState(),
    taskContextRevision: taskContext.revision,
    terminal,
    stopDecision,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setImmediate(resolve));
  }
}
