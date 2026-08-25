import { randomUUID } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { OrionCodeTool, ToolContext } from '../src/framework/tool';
import type { LLMResponse, LLMService, LLMUsageEvent } from '../src/services/llm';
import { ProviderRequestPreflightError } from '../src/services/llm';
import { createBuiltinToolCatalogV1 } from '../src/runtime/builtin-tool-provider';
import { CapabilityReceiptJournalV1 } from '../src/runtime/capability-receipt-journal';
import {
  CapabilityAgentLoopStepFactoryV1,
  type CapabilityStepConfigurationV1,
} from '../src/runtime/capability-step-factory';
import {
  createProductionSubagentRuntimeV1,
  type ProductionSubagentRuntimeV1,
} from '../src/runtime/subagents/production';
import {
  createAuthoritySnapshotV1,
  createExecutionPolicySnapshotV1,
} from '../src/runtime/step-snapshot';
import { ThreadEventStore } from '../src/runtime/thread-event-store';

describe('ProductionSubagentRuntimeV1', () => {
  const roots: string[] = [];
  const runtimes: ProductionSubagentRuntimeV1[] = [];

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.close('test_cleanup');
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('runs an isolated child through AgentLoop, Capability snapshot, ToolGateway and durable receipts', async () => {
    const root = createRoot(roots);
    const scopedFile = join(root, 'scope', 'README.md');
    mkdirSync(join(root, 'scope'), { recursive: true });
    writeFileSync(scopedFile, 'verified child content');
    let executions = 0;
    const tool = readFileTool(() => executions++);
    const responses: LLMResponse[] = [
      {
        content: '',
        model: 'child-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: scopedFile }) },
          },
        ],
      },
      {
        content: JSON.stringify({
          summary: 'Child verified the scoped file.',
          findings: [{ title: 'File exists', evidence: 'ToolGateway receipt is durable.' }],
          files: [scopedFile],
          commands: [],
          verification: ['read_file completed'],
          risks: [],
        }),
        model: 'child-model',
      },
    ];
    const model = fakeModel(responses);
    const fixture = await createFixture(root, tool, () => model.llm);
    runtimes.push(fixture.runtime);

    const outcome = await fixture.runtime.execute({
      taskId: 'task-modern-1',
      packet: {
        role: 'review',
        objective: 'Inspect the scoped README.',
        reason: 'Independent review',
        scope: { paths: [join(root, 'scope')] },
        expectedOutput: 'Return a structured finding.',
      },
      canonicalScopePaths: [join(root, 'scope')],
      parent: fixture.parent,
      parentAuthority: fixture.parentAuthority,
      budget: { maxModelRequests: 2, maxToolCalls: 1 },
      timeoutMs: 5_000,
      modelLabel: 'child-model',
    });

    expect(outcome.result).toMatchObject({
      status: 'completed',
      summary: 'Child verified the scoped file.',
      usage: { modelRequests: 2, toolCalls: 1, usageComplete: true },
    });
    expect(outcome.receipt).toBeDefined();
    expect(executions).toBe(1);
    expect(model.preflightCalls).toBe(2);
    expect(fixture.runtime.receipts.read(outcome.receipt!.receiptId)).toEqual(outcome.receipt);
    expect(outcome.receipt).toMatchObject({
      parentThreadId: fixture.parent.threadId,
      parentTurnId: fixture.parent.turnId,
      parentStepId: fixture.parent.stepId,
      parentRequestId: fixture.parent.requestId,
      parentStepSnapshotDigest: fixture.parent.stepSnapshotDigest,
      parentCapabilityReceiptDigest: fixture.parent.capabilityReceiptDigest,
    });

    const childStore = new ThreadEventStore(join(root, 'children'), outcome.receipt!.childThreadId);
    const eventTypes = childStore.replay(0).events.map(event => event.payload.type);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        'thread.forked',
        'step.snapshot',
        'capability.receipt',
        'item.started',
        'tool.receipt',
        'turn.committed',
      ])
    );
    expect(outcome.receipt!.childStepSnapshotDigests).toHaveLength(2);
    expect(outcome.receipt!.authorityDigest).not.toBe(fixture.parentAuthority.digest);
  });

  test('enforces the provider reservation at every request and fails with a committed child boundary', async () => {
    const root = createRoot(roots);
    const tool = readFileTool(() => undefined);
    const model = fakeModel([
      {
        content: '',
        model: 'child-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: root }) },
          },
        ],
      },
      { content: JSON.stringify({ summary: 'must not be reached' }), model: 'child-model' },
    ]);
    const fixture = await createFixture(root, tool, () => model.llm);
    runtimes.push(fixture.runtime);

    const outcome = await fixture.runtime.execute({
      taskId: 'task-budget-1',
      packet: { role: 'review', objective: 'Inspect once.', reason: 'Budget proof' },
      parent: fixture.parent,
      parentAuthority: fixture.parentAuthority,
      budget: { maxModelRequests: 1, maxToolCalls: 1 },
      timeoutMs: 5_000,
    });

    expect(outcome.result.status).toBe('failed');
    expect(outcome.result.usage.modelRequests).toBe(1);
    // Query's frozen loop budget prevents request two before the provider
    // boundary; the single admitted request was also charged to the tree lease.
    expect(model.preflightCalls).toBe(1);
    expect(outcome.receipt).toBeDefined();
    const childStore = new ThreadEventStore(join(root, 'children'), outcome.receipt!.childThreadId);
    expect(childStore.loadProjection().turns[outcome.receipt!.childTurnId]).toMatchObject({
      status: 'completed',
      commit: { digest: outcome.receipt!.childCommitDigest },
    });
    expect(outcome.receipt!.stopDecisionDigest).toBeDefined();
  });

  test('fails closed when a child model factory reuses mutable LLM state', async () => {
    const root = createRoot(roots);
    const model = fakeModel([
      {
        content: JSON.stringify({ summary: 'First isolated child completed.' }),
        model: 'child-model',
      },
    ]);
    const fixture = await createFixture(
      root,
      readFileTool(() => undefined),
      () => model.llm
    );
    runtimes.push(fixture.runtime);
    const request = (taskId: string) => ({
      taskId,
      packet: { role: 'review' as const, objective: 'Inspect isolated state.', reason: 'Proof' },
      parent: fixture.parent,
      parentAuthority: fixture.parentAuthority,
      budget: { maxModelRequests: 1, maxToolCalls: 0 },
      timeoutMs: 5_000,
    });

    await expect(fixture.runtime.execute(request('isolated-model-first'))).resolves.toMatchObject({
      result: { status: 'completed' },
      receipt: expect.any(Object),
    });
    await expect(fixture.runtime.execute(request('isolated-model-reused'))).resolves.toMatchObject({
      result: {
        status: 'failed',
        summary: expect.stringContaining('reused mutable LLM state'),
      },
    });
  });

  test('rejects packet-scope escapes before the injected tool executor', async () => {
    const root = createRoot(roots);
    const allowed = join(root, 'allowed');
    mkdirSync(allowed, { recursive: true });
    const outsideScope = join(root, 'outside.txt');
    writeFileSync(outsideScope, 'must not be read');
    let executions = 0;
    const model = fakeModel([
      {
        content: '',
        model: 'child-model',
        toolCalls: [
          {
            id: 'call-escape',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: outsideScope }) },
          },
        ],
      },
      {
        content: JSON.stringify({ summary: 'Scope denial observed.', risks: ['read denied'] }),
        model: 'child-model',
      },
    ]);
    const fixture = await createFixture(
      root,
      readFileTool(() => executions++),
      () => model.llm
    );
    runtimes.push(fixture.runtime);

    const outcome = await fixture.runtime.execute({
      taskId: 'task-scope-1',
      packet: { role: 'review', objective: 'Inspect allowed scope.', reason: 'Scope proof' },
      canonicalScopePaths: [allowed],
      parent: fixture.parent,
      parentAuthority: fixture.parentAuthority,
      budget: { maxModelRequests: 2, maxToolCalls: 1 },
      timeoutMs: 5_000,
    });

    expect(outcome.result.status).toBe('completed');
    expect(executions).toBe(0);
    const childStore = new ThreadEventStore(join(root, 'children'), outcome.receipt!.childThreadId);
    const receiptEvent = childStore
      .replay(0)
      .events.find(event => event.payload.type === 'tool.receipt');
    expect(receiptEvent?.payload.type).toBe('tool.receipt');
    if (receiptEvent?.payload.type === 'tool.receipt') {
      expect(receiptEvent.payload.data.terminal).toBe('failed');
    }
  });

  test('turns a deadline into a durable interrupted child receipt', async () => {
    const root = createRoot(roots);
    const fixture = await createFixture(
      root,
      readFileTool(() => undefined),
      () => abortAwareModel()
    );
    runtimes.push(fixture.runtime);

    const outcome = await fixture.runtime.execute({
      taskId: 'task-timeout-1',
      packet: { role: 'review', objective: 'Wait forever.', reason: 'Deadline proof' },
      parent: fixture.parent,
      parentAuthority: fixture.parentAuthority,
      budget: { maxModelRequests: 1, maxToolCalls: 0 },
      timeoutMs: 25,
    });

    expect(outcome.result.status).toBe('timed_out');
    expect(outcome.receipt).toBeDefined();
    expect(fixture.runtime.receipts.read(outcome.receipt!.receiptId)).toEqual(outcome.receipt);
    const childStore = new ThreadEventStore(join(root, 'children'), outcome.receipt!.childThreadId);
    expect(childStore.loadProjection().turns[outcome.receipt!.childTurnId]).toMatchObject({
      status: 'interrupted',
      commit: { digest: outcome.receipt!.childCommitDigest },
    });
  });

  test('close is idempotent and rejects new children', async () => {
    const root = createRoot(roots);
    const fixture = await createFixture(
      root,
      readFileTool(() => undefined),
      () => fakeModel([{ content: '{}', model: 'child-model' }]).llm
    );
    runtimes.push(fixture.runtime);
    fixture.runtime.close('first');
    fixture.runtime.close('second');

    await expect(
      fixture.runtime.execute({
        taskId: 'closed-task',
        packet: { role: 'review', objective: 'must not run', reason: 'closed' },
        parent: fixture.parent,
        parentAuthority: fixture.parentAuthority,
        budget: { maxModelRequests: 1, maxToolCalls: 0 },
        timeoutMs: 5_000,
      })
    ).rejects.toMatchObject({ code: 'ORION_SUBAGENT_PRODUCTION_CLOSED' });
    expect(fixture.runtime.tree.snapshot().closed).toBe(true);
  });

  test('binds one production tree budget to exactly one parent turn', async () => {
    const root = createRoot(roots);
    const fixture = await createFixture(
      root,
      readFileTool(() => undefined),
      () => fakeModel([{ content: JSON.stringify({ summary: 'done' }), model: 'child-model' }]).llm
    );
    runtimes.push(fixture.runtime);
    const baseRequest = {
      taskId: 'turn-owner-1',
      packet: { role: 'review' as const, objective: 'bind this turn', reason: 'owner proof' },
      parent: fixture.parent,
      parentAuthority: fixture.parentAuthority,
      budget: { maxModelRequests: 1, maxToolCalls: 0 },
      timeoutMs: 5_000,
    };
    await fixture.runtime.execute(baseRequest);

    await expect(
      fixture.runtime.execute({
        ...baseRequest,
        taskId: 'turn-owner-2',
        parent: { ...fixture.parent, turnId: randomUUID() },
      })
    ).rejects.toMatchObject({
      code: 'ORION_SUBAGENT_PRODUCTION_INVALID',
      message: expect.stringContaining('exactly one parent turn'),
    });
  });
});

function createRoot(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'orion-production-subagent-'));
  roots.push(root);
  return root;
}

async function createFixture(root: string, tool: OrionCodeTool, createModel: () => LLMService) {
  const parentAuthority = createAuthoritySnapshotV1({
    authorityId: 'parent-authority',
    projectRoot: root,
    confirmation: 'allow',
    filesystem: 'workspace',
    network: 'read',
  });
  const roleAuthority = createAuthoritySnapshotV1({
    authorityId: 'review-role',
    projectRoot: root,
    confirmation: 'allow',
    filesystem: 'workspace',
    network: 'deny',
  });
  const toolContext: ToolContext = {
    cwd: root,
    config: { name: 'subagent-production-test', mode: 'build' },
  };
  const catalog = createBuiltinToolCatalogV1([tool], { context: toolContext });
  const parentStore = new ThreadEventStore(join(root, 'parent'), randomUUID());
  const parentTurnId = randomUUID();
  const parentStepId = randomUUID();
  const parentRequestId = randomUUID();
  parentStore.appendDurableBatch([
    { payload: { type: 'thread.started', data: { projectPath: root } } },
    {
      turnId: parentTurnId,
      payload: { type: 'turn.started', data: { input: 'Parent objective', mode: 'build' } },
    },
  ]);
  const parentStepFactory = new CapabilityAgentLoopStepFactoryV1({
    resolveConfiguration: () => {
      const configured = capabilityConfiguration(root);
      return {
        ...configured,
        compiler: { ...configured.compiler, authority: parentAuthority },
      };
    },
    resolveToolRegistry: () => new Map(),
    idFactory: identity =>
      identity.kind === 'step'
        ? parentStepId
        : identity.kind === 'request'
          ? parentRequestId
          : randomUUID(),
  });
  const parentStep = await parentStepFactory.prepare({
    threadId: parentStore.threadId,
    turnId: parentTurnId,
    requestIndex: 0,
    input: 'Parent objective',
    mode: 'build',
    messages: [{ role: 'user', content: 'Parent objective' }],
    taskContextRevision: 0,
    abortSignal: new AbortController().signal,
  });
  await parentStep.capture({
    messages: [{ role: 'user', content: 'Parent objective' }],
    taskContextRevision: 0,
  });
  const parentBundle = parentStep.persistenceBundle;
  if (!parentBundle) throw new Error('Parent fixture failed to capture its capability receipt.');
  new CapabilityReceiptJournalV1(parentStore).commit(parentBundle);

  const runtime = createProductionSubagentRuntimeV1({
    childStoreRootDir: join(root, 'children'),
    toolCatalog: catalog,
    treeLimits: {
      maxConcurrent: 2,
      maxModelRequests: 8,
      maxToolCalls: 4,
    },
    rolePolicies: { review: roleAuthority },
    createModelExecutor: createModel,
    resolveCapabilityConfiguration: (_input, context) =>
      capabilityConfiguration(context.authority.projectRoot),
    toolContext: (_request, authority) => ({ ...toolContext, cwd: authority.projectRoot }),
  });
  return {
    runtime,
    parentAuthority,
    parent: {
      store: parentStore,
      threadId: parentStore.threadId,
      turnId: parentTurnId,
      stepId: parentStepId,
      requestId: parentRequestId,
      stepSnapshotDigest: parentBundle.snapshot.digest,
      capabilityReceiptDigest: parentBundle.capabilityReceipt.digest,
      flush: () => undefined,
    },
  };
}

function capabilityConfiguration(root: string): CapabilityStepConfigurationV1 {
  const executionPolicy = createExecutionPolicySnapshotV1({
    policyId: 'child-policy',
    approvalMode: 'never',
    sandboxRequired: false,
    sandboxBackend: 'none',
    timeoutMs: 2_000,
  });
  const authority = createAuthoritySnapshotV1({
    authorityId: 'resolver-placeholder',
    projectRoot: root,
    confirmation: 'deny',
    filesystem: 'workspace',
    network: 'deny',
  });
  return {
    taskEpoch: 1,
    model: {
      providerId: 'test',
      modelId: 'child-model',
      protocol: 'test',
      contextWindow: 32_000,
    },
    executionPolicy,
    environment: {
      cwd: root,
      platform: 'test',
      arch: 'test',
      environmentDigest: `environment:${root}`,
    },
    compiler: {
      task: { objective: 'placeholder' },
      model: { toolCalling: true },
      authority,
      budgets: {
        maxDirectTools: 4,
        maxToolSchemaBytes: 8_000,
        maxDeferredTools: 4,
        maxExpansionTools: 1,
      },
      tools: [],
      runtimeServicesDigest: 'overridden',
      executionPolicyDigest: executionPolicy.digest,
      skillCatalogDigest: 'skills:none',
      mcpCatalogDigest: 'mcp:none',
      estimatedInputTokens: 64,
    },
  };
}

function readFileTool(onExecute: () => void): OrionCodeTool {
  return {
    name: 'read_file',
    description: 'Read one file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    execute: async args => {
      onExecute();
      return { success: true, output: String(args.path) };
    },
    checkPermissions: () => ({ behavior: 'allow' }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isFileEdit: () => false,
  };
}

function fakeModel(responses: readonly LLMResponse[]): {
  readonly llm: LLMService;
  readonly preflightCalls: number;
} {
  let responseIndex = 0;
  let preflight: Parameters<LLMService['setProviderRequestPreflight']>[0];
  let usageObserver: ((event: LLMUsageEvent) => void) | undefined;
  const fixture = {
    preflightCalls: 0,
    llm: undefined as unknown as LLMService,
  };
  fixture.llm = {
    chatStream: async (...args: Parameters<LLMService['chatStream']>) => {
      const options = args[3];
      fixture.preflightCalls++;
      const decision = await preflight?.({
        operation: 'chat_stream',
        attempt: fixture.preflightCalls,
        model: 'child-model',
        estimatedPromptTokens: 32,
      });
      if (decision && !decision.available) {
        throw new ProviderRequestPreflightError(decision.reason ?? 'denied');
      }
      if (options?.abortSignal?.aborted) throw new Error('aborted');
      const response = responses[responseIndex++] ?? responses.at(-1)!;
      usageObserver?.({
        operation: 'chat_stream',
        model: 'child-model',
        usage: { promptTokens: 10, completionTokens: 4 },
      } as LLMUsageEvent);
      return response;
    },
    chat: async () => ({ content: '', model: 'child-model' }),
    getModel: () => 'child-model',
    setProviderRequestPreflight: (
      next: Parameters<LLMService['setProviderRequestPreflight']>[0]
    ) => {
      preflight = next;
      return () => {
        preflight = undefined;
      };
    },
    subscribeUsage: (observer: (event: LLMUsageEvent) => void) => {
      usageObserver = observer;
      return () => {
        usageObserver = undefined;
      };
    },
    getConfigSummary: () => ({ model: 'child-model' }),
  } as unknown as LLMService;
  return fixture;
}

function abortAwareModel(): LLMService {
  let preflight: Parameters<LLMService['setProviderRequestPreflight']>[0];
  return {
    chatStream: async (...args: Parameters<LLMService['chatStream']>) => {
      const decision = await preflight?.({
        operation: 'chat_stream',
        attempt: 1,
        model: 'child-model',
        estimatedPromptTokens: 32,
      });
      if (decision && !decision.available) {
        throw new ProviderRequestPreflightError(decision.reason ?? 'denied');
      }
      const signal = args[3]?.abortSignal;
      return new Promise<LLMResponse>((_resolve, reject) => {
        const abort = () => reject(new Error('deadline aborted provider request'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    },
    chat: async () => ({ content: '', model: 'child-model' }),
    getModel: () => 'child-model',
    setProviderRequestPreflight: (
      next: Parameters<LLMService['setProviderRequestPreflight']>[0]
    ) => {
      preflight = next;
      return () => {
        preflight = undefined;
      };
    },
    subscribeUsage: () => () => undefined,
    getConfigSummary: () => ({ model: 'child-model' }),
  } as unknown as LLMService;
}
