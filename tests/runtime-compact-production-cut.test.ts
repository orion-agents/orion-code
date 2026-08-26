import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { ToolContext } from '../src/framework/tool';
import { createBuiltinToolCatalogV1 } from '../src/runtime/builtin-tool-provider';
import {
  CompactTransactionV1,
  type CompactCandidateValidatorV1,
} from '../src/runtime/compact-transaction';
import {
  createOrionRuntimeV1,
  type OrionCapabilityStepConfigurationV1,
  type OrionRuntimeV1,
} from '../src/runtime/orion-runtime-v1';
import { digestRuntimeValue } from '../src/runtime/protocol/canonical';
import {
  createAuthoritySnapshotV1,
  createExecutionPolicySnapshotV1,
} from '../src/runtime/step-snapshot';
import { createTaskContextService } from '../src/runtime/task-context-service';
import {
  createThreadCompactCandidateDraftV1,
  ThreadCompactTransactionPersistenceV1,
} from '../src/runtime/thread-compact-persistence';
import { ThreadEventStore } from '../src/runtime/thread-event-store';
import { parseTurnCommitV1, ThreadTurnCommitJournalV1 } from '../src/runtime/turn-commit';
import { CompactCoordinator } from '../src/services/compact/coordinator';
import type { LLMResponse, LLMService, Message } from '../src/services/llm';

describe('runtime Compact production cut', () => {
  const roots: string[] = [];
  const runtimes: OrionRuntimeV1[] = [];

  afterEach(async () => {
    await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close('test_cleanup')));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('automatic compact commits raw history, then installs its candidate in a maintenance turn', async () => {
    const root = temporaryRoot();
    const model = createModelFixture();
    const rawHistory: Message[] = Array.from({ length: 30 }, (_, index) => ({
      role: 'user',
      content: `RAW_EVICTED_MARKER_${index} ${'x'.repeat(4_000)}`,
    }));
    let loadCount = 0;
    const coordinator = new CompactCoordinator({ modelId: 'gpt-4', llm: model.llm });
    const runtime = createRuntime(root, model.llm, {
      compactCoordinator: coordinator,
      loadBaseMessages: () => [
        { role: 'system', content: 'CURRENT_SYSTEM_PROMPT' },
        ...(loadCount++ === 0
          ? rawHistory
          : [{ role: 'user' as const, content: 'STALE_PRODUCT_HISTORY' }]),
      ],
    });

    await runtime.start();
    expect(
      runtime.thread.dispatch({
        type: 'turn.start',
        data: { input: 'finish the large turn', mode: 'build' },
      }).status
    ).toBe('started');
    await runtime.thread.waitForIdle();

    const projection = runtime.thread.getProjection();
    const firstRegular = Object.values(projection.turns)
      .filter(turn => turn.mode !== 'maintenance')
      .sort((left, right) => left.startedSeq - right.startedSeq)[0];
    if (!firstRegular?.commit) throw new Error('Expected the regular turn to be committed');
    const rawCommit = parseTurnCommitV1(firstRegular.commit.receipt);
    expect(JSON.parse(rawCommit.history)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('RAW_EVICTED_MARKER_0') }),
        expect.objectContaining({ role: 'assistant', content: 'answer-1' }),
      ])
    );

    const compactEvents = runtime.graph.compactPersistence.listCompactEvents();
    expect(compactEvents.map(event => event.payload.type)).toEqual([
      'compact.started',
      'compact.completed',
    ]);
    const authoritative = runtime.graph.compactPersistence.loadModelVisibleHistory() as Message[];
    expect(authoritative.map(message => message.content).join('\n')).toContain('[Context Summary]');
    expect(authoritative.map(message => message.content).join('\n')).not.toContain(
      'RAW_EVICTED_MARKER_0'
    );

    const events = runtime.graph.eventStore.replay(0).events;
    const regularCommitSeq = events.find(
      event => event.turnId === firstRegular.turnId && event.payload.type === 'turn.committed'
    )?.seq;
    const regularTerminalSeq = events.find(
      event => event.turnId === firstRegular.turnId && event.payload.type === 'turn.completed'
    )?.seq;
    const compactStartedSeq = events.find(event => event.payload.type === 'compact.started')?.seq;
    expect(regularCommitSeq).toBeLessThan(regularTerminalSeq ?? 0);
    expect(regularTerminalSeq).toBeLessThan(compactStartedSeq ?? 0);

    expect(
      runtime.thread.dispatch({
        type: 'turn.start',
        data: { input: 'continue from committed compact history', mode: 'build' },
      }).status
    ).toBe('started');
    await runtime.thread.waitForIdle();

    const secondRequest = model.requests[1];
    expect(secondRequest.map(message => message.content).join('\n')).toContain(
      'CURRENT_SYSTEM_PROMPT'
    );
    expect(secondRequest.map(message => message.content).join('\n')).toContain('[Context Summary]');
    expect(secondRequest.map(message => message.content).join('\n')).not.toContain(
      'STALE_PRODUCT_HISTORY'
    );
    expect(secondRequest.map(message => message.content).join('\n')).not.toContain(
      'RAW_EVICTED_MARKER_0'
    );
  });

  test('explicit compact is non-steerable and keeps follow-up work in the user base mode', async () => {
    const root = temporaryRoot();
    const summaryGate = deferred<void>();
    let holdSummary = false;
    const model = createModelFixture(async () => {
      if (holdSummary) await summaryGate.promise;
      return { content: 'manual bounded summary', model: 'gpt-4' };
    });
    const coordinator = new CompactCoordinator({ modelId: 'gpt-4', llm: model.llm });
    const runtime = createRuntime(root, model.llm, {
      compactCoordinator: coordinator,
      loadBaseMessages: () => [
        { role: 'system', content: 'system' },
        ...Array.from({ length: 8 }, (_, index) => ({
          role: 'user' as const,
          content: `manual history ${index}`,
        })),
      ],
    });
    await runtime.start();
    runtime.thread.dispatch({
      type: 'turn.start',
      data: { input: 'create a compact source', mode: 'auto' },
    });
    await runtime.thread.waitForIdle();

    holdSummary = true;
    expect(runtime.compact({ maxMessages: 1 }).status).toBe('started');
    await waitFor(() => model.chat.mock.calls.length === 1);
    expect(runtime.thread.getAdmissionSnapshot().activeTurn).toMatchObject({
      mode: 'maintenance',
      kind: 'maintenance',
    });
    expect(
      runtime.thread.dispatch({ type: 'turn.steer', data: { input: 'replace compact' } })
    ).toEqual({ status: 'rejected', reason: 'non_steerable' });
    expect(
      runtime.thread.dispatch({
        type: 'turn.follow_up',
        data: { input: 'run after compact' },
      }).status
    ).toBe('queued');
    expect(runtime.thread.getAdmissionSnapshot().queue[0]).toMatchObject({
      mode: 'auto',
      kind: 'regular',
    });

    summaryGate.resolve();
    await runtime.thread.waitForIdle();

    expect(
      runtime.graph.compactPersistence.listCompactEvents().map(event => event.payload.type)
    ).toEqual(['compact.started', 'compact.completed']);
    const turns = Object.values(runtime.thread.getProjection().turns).sort(
      (left, right) => left.startedSeq - right.startedSeq
    );
    expect(turns.map(turn => turn.mode)).toEqual(['auto', 'maintenance', 'auto']);
    expect(turns.at(-1)?.input).toBe('run after compact');
  });

  test('runtime startup recovers an orphaned committed pointer before serving model history', async () => {
    const root = temporaryRoot();
    const eventRoot = join(root, 'events');
    const threadId = randomUUID();
    const store = new ThreadEventStore(eventRoot, threadId);
    const regularTurnId = randomUUID();
    const maintenanceTurnId = randomUUID();
    const rawHistory: Message[] = [
      { role: 'system', content: 'old system' },
      { role: 'user', content: 'ORPHAN_RAW_HISTORY' },
      { role: 'assistant', content: 'raw answer' },
    ];
    const taskContext = createTaskContextService({
      cwd: root,
      modelId: 'gpt-4',
      config: { completionGate: 'off' },
    });
    taskContext.observeUserInput('PRESERVED_TASK_OBJECTIVE');
    store.appendDurableBatch([
      { payload: { type: 'thread.started', data: { projectPath: root } } },
      {
        turnId: regularTurnId,
        payload: { type: 'turn.started', data: { input: 'seed', mode: 'build' } },
      },
    ]);
    new ThreadTurnCommitJournalV1(store).commit({
      turnId: regularTurnId,
      history: rawHistory,
      taskContextState: taskContext.exportState(),
      taskContextRevision: taskContext.revision,
      terminal: { status: 'completed', outcome: 'seeded' },
    });
    store.appendDurableBatch([
      {
        turnId: regularTurnId,
        payload: { type: 'turn.completed', data: { outcome: 'seeded' } },
      },
      {
        turnId: maintenanceTurnId,
        payload: {
          type: 'turn.started',
          data: { input: 'compact:automatic', mode: 'maintenance' },
        },
      },
    ]);

    const persistence = new ThreadCompactTransactionPersistenceV1(store);
    const transaction = new CompactTransactionV1(persistence, ACCEPT_ALL, {
      onBoundary: boundary => {
        if (boundary === 'after_pointer_commit') throw new Error('simulated crash');
      },
    });
    const recoveredHistory: Message[] = [
      { role: 'user', content: '[Context Summary]\nRECOVERED_COMPACT_HISTORY' },
      { role: 'assistant', content: 'I will continue from the checkpoint.' },
    ];
    await expect(
      transaction.run({
        transactionId: randomUUID(),
        turnId: maintenanceTurnId,
        prepare: async ({ source }) => {
          const draft = createThreadCompactCandidateDraftV1({
            source: 'automatic',
            sourceHistoryDigest: source.historyDigest,
            modelVisibleHistory: recoveredHistory,
            payload: { version: 1, reason: 'test recovery' },
          });
          return {
            checkpointId: randomUUID(),
            checkpoint: draft.checkpoint,
            modelVisibleHistory: draft.modelVisibleHistory,
          };
        },
      })
    ).rejects.toMatchObject({ boundary: 'after_pointer_commit' });

    const model = createModelFixture();
    const runtime = createRuntime(root, model.llm, {
      eventRoot,
      threadId,
      loadBaseMessages: () => [
        { role: 'system', content: 'CURRENT_RESUME_SYSTEM' },
        { role: 'user', content: 'STALE_RESUME_LOADER_HISTORY' },
      ],
    });
    await runtime.start();

    expect(runtime.graph.compactRecovery).toMatchObject({ completed: 1, failed: 0 });
    expect(
      runtime.graph.compactPersistence.listCompactEvents().map(event => event.payload.type)
    ).toEqual(['compact.started', 'compact.completed']);
    expect(runtime.graph.compactPersistence.loadModelVisibleHistory()).toEqual(recoveredHistory);

    runtime.thread.dispatch({
      type: 'turn.start',
      data: { input: 'resume after crash', mode: 'build' },
    });
    await runtime.thread.waitForIdle();
    const request = model.requests[0];
    const requestText = request.map(message => message.content).join('\n');
    expect(requestText).toContain('CURRENT_RESUME_SYSTEM');
    expect(requestText).toContain('RECOVERED_COMPACT_HISTORY');
    expect(requestText).toContain('PRESERVED_TASK_OBJECTIVE');
    expect(requestText).not.toContain('ORPHAN_RAW_HISTORY');
    expect(requestText).not.toContain('STALE_RESUME_LOADER_HISTORY');
  });

  function temporaryRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'orion-runtime-compact-cut-'));
    roots.push(root);
    return root;
  }

  function createRuntime(
    root: string,
    llm: LLMService,
    options: {
      readonly eventRoot?: string;
      readonly threadId?: string;
      readonly compactCoordinator?: CompactCoordinator;
      readonly loadBaseMessages: () => readonly Message[];
    }
  ): OrionRuntimeV1 {
    const eventRoot = options.eventRoot ?? join(root, 'events');
    const threadId = options.threadId ?? randomUUID();
    const toolContext: ToolContext = {
      cwd: root,
      config: { name: 'orion-runtime-compact-test', mode: 'build' },
    };
    const catalog = createBuiltinToolCatalogV1([], { context: toolContext });
    const runtime = createOrionRuntimeV1({
      modelExecutor: llm,
      toolCatalog: catalog,
      toolContext,
      eventStore: { rootDir: eventRoot, threadId },
      projectPath: root,
      taskContext: {
        cwd: root,
        modelId: 'gpt-4',
        config: { completionGate: 'off' },
      },
      skills: { providers: [] },
      mcp: {
        descriptors: [],
        connector: {
          connect: async () => {
            throw new Error('MCP must remain lazy in Compact tests');
          },
        },
      },
      resolveCapabilityConfiguration: () => capabilityConfiguration(root),
      loadBaseMessages: () => options.loadBaseMessages(),
      loop: options.compactCoordinator
        ? { compactCoordinator: options.compactCoordinator }
        : undefined,
    });
    runtimes.push(runtime);
    return runtime;
  }
});

interface ModelFixture {
  readonly llm: LLMService;
  readonly requests: Message[][];
  readonly chat: jest.Mock<Promise<LLMResponse>, []>;
}

function createModelFixture(
  summarize: () => Promise<LLMResponse> = async () => ({
    content: 'bounded compact summary',
    model: 'gpt-4',
  })
): ModelFixture {
  const requests: Message[][] = [];
  const chat = jest.fn(summarize);
  const llm = {
    chat,
    chatStream: jest.fn(async (messages: Message[]) => {
      requests.push(messages.map(message => ({ ...message })));
      return { content: `answer-${requests.length}`, model: 'gpt-4' };
    }),
    getModel: jest.fn(() => 'gpt-4'),
    setModel: jest.fn(),
    getConfigSummary: jest.fn(() => ({ model: 'gpt-4' })),
  } as unknown as LLMService;
  return { llm, requests, chat };
}

function capabilityConfiguration(root: string): OrionCapabilityStepConfigurationV1 {
  const executionPolicy = createExecutionPolicySnapshotV1({
    policyId: 'compact-test-policy',
    approvalMode: 'never',
    sandboxRequired: true,
    sandboxBackend: 'test',
    timeoutMs: 5_000,
  });
  return {
    taskEpoch: 1,
    model: {
      providerId: 'test-provider',
      modelId: 'gpt-4',
      protocol: 'test-protocol',
      contextWindow: 8_192,
    },
    executionPolicy,
    environment: {
      cwd: root,
      platform: 'test',
      arch: 'test',
      environmentDigest: digestRuntimeValue({ root }),
    },
    compiler: {
      task: { objective: 'Exercise production compact ownership' },
      model: { toolCalling: true },
      authority: createAuthoritySnapshotV1({
        authorityId: 'project',
        projectRoot: root,
        confirmation: 'allow',
        filesystem: 'workspace',
        network: 'deny',
      }),
      budgets: {
        maxDirectTools: 4,
        maxToolSchemaBytes: 8_000,
        maxDeferredTools: 4,
        maxExpansionTools: 1,
      },
      executionPolicyDigest: executionPolicy.digest,
      skillCatalogDigest: 'skill-catalog:none',
      estimatedInputTokens: 64,
    },
  };
}

const ACCEPT_ALL: CompactCandidateValidatorV1 = {
  id: 'compact-recovery-test-validator-v1',
  validate: async () => true,
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
