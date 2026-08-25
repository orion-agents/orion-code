import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { LLMResponse, LLMService, Message } from '../src/services/llm';
import {
  AgentLoopV1,
  ThreadStepSnapshotJournalV1,
  deterministicRuntimeId,
} from '../src/runtime/agent-loop';
import { digestRuntimeValue } from '../src/runtime/protocol/canonical';
import {
  ExecutionService,
  captureStepSnapshotV1,
  createAuthoritySnapshotV1,
  createCapabilityPlanV1,
  createExecutionPolicySnapshotV1,
  type ToolBindingV1,
} from '../src/runtime/step-snapshot';
import { createTaskContextService } from '../src/runtime/task-context-service';
import { ThreadEventStore } from '../src/runtime/thread-event-store';
import { ThreadRuntimeV1 } from '../src/runtime/thread-runtime';
import { ThreadToolInvocationJournalV1 } from '../src/runtime/thread-tool-journal';
import {
  ToolGateway,
  createSandboxPreparationV1,
  createStaticApprovalDecisionV1,
  createStaticPolicyDecisionV1,
} from '../src/runtime/tool-gateway';
import { ThreadTurnCommitJournalV1 } from '../src/runtime/turn-commit';

describe('AgentLoopV1', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('binds every provider request to a StepSnapshot and routes tools through ToolGateway', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-agent-loop-'));
    roots.push(root);
    const threadId = randomUUID();
    const store = new ThreadEventStore(root, threadId);
    const responses: LLMResponse[] = [
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'provider-call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"README.md"}' },
          },
        ],
      },
      { content: 'README inspected.', model: 'test-model' },
    ];
    let responseIndex = 0;
    const llm = {
      chat: jest.fn(async () => ({ content: 'summary', model: 'test-model' })),
      chatStream: jest.fn(async () => responses[responseIndex++] ?? responses.at(-1)!),
      getModel: jest.fn(() => 'test-model'),
      setModel: jest.fn(),
      getConfigSummary: jest.fn(() => ({ model: 'test-model' })),
    } as unknown as jest.Mocked<LLMService>;
    let executions = 0;
    const binding: ToolBindingV1 = {
      descriptor: {
        name: 'read_file',
        aliases: [],
        description: 'Read a workspace file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Path' } },
          required: ['path'],
        },
        executorId: 'builtin:read_file:v1',
        risk: {
          readOnly: true,
          destructive: false,
          fileEdit: false,
          effect: 'workspace_read',
          network: 'none',
        },
      },
      execute: async args => {
        executions += 1;
        return { success: true, output: `content:${String(args.path)}` };
      },
    };
    const gateway = new ToolGateway({
      policy: {
        decide: () => createStaticPolicyDecisionV1({ behavior: 'allow', source: 'test' }),
      },
      approval: {
        decide: () => createStaticApprovalDecisionV1({ approved: true, source: 'test' }),
      },
      sandbox: {
        prepare: () => createSandboxPreparationV1({ backend: 'test', enforcement: 'full' }),
      },
      execution: new ExecutionService(),
      journal: new ThreadToolInvocationJournalV1(store),
    });
    const taskContext = createTaskContextService({
      cwd: root,
      modelId: 'test-model',
      config: { completionGate: 'off' },
    });
    const snapshots: string[] = [];
    const journal = new ThreadStepSnapshotJournalV1(store);
    const turnJournal = new ThreadTurnCommitJournalV1(store);
    const loop = new AgentLoopV1({
      llm,
      taskContext,
      gateway,
      loadBaseMessages: async () => [{ role: 'system', content: 'You are Orion.' }],
      onStepCaptured: snapshot => {
        snapshots.push(snapshot.digest);
        journal.commit(snapshot);
      },
      commitTurn: commit => {
        turnJournal.commit({
          turnId: commit.turnId,
          history: commit.history,
          taskContextState: commit.taskContextState,
          taskContextRevision: commit.taskContextRevision,
          stopDecision: commit.queryComplete.stats?.stopDecision,
          terminal: {
            status: 'completed',
            outcome: commit.queryComplete.stats?.finishReason ?? 'completed',
          },
        });
      },
      steps: {
        prepare: input => {
          const stepId = randomUUID();
          return {
            stepId,
            toolBindings: [binding],
            capture: ({ messages, taskContextRevision }) =>
              captureStepSnapshotV1({
                threadId: input.threadId,
                turnId: input.turnId,
                stepId,
                taskEpoch: 1,
                baseMode: input.mode === 'plan' || input.mode === 'auto' ? input.mode : 'build',
                model: {
                  providerId: 'test',
                  modelId: 'test-model',
                  protocol: 'test',
                  contextWindow: 32_000,
                },
                authority: createAuthoritySnapshotV1({
                  authorityId: 'test',
                  projectRoot: root,
                  confirmation: 'allow',
                  filesystem: 'workspace',
                  network: 'deny',
                }),
                executionPolicy: createExecutionPolicySnapshotV1({
                  policyId: 'test',
                  approvalMode: 'never',
                  sandboxRequired: true,
                  sandboxBackend: 'test',
                  timeoutMs: 5_000,
                }),
                environment: {
                  cwd: root,
                  platform: 'test',
                  arch: 'test',
                  environmentDigest: 'test',
                },
                capabilityPlan: createCapabilityPlanV1({
                  direct: [{ id: 'read_file', reason: 'core' }],
                }),
                prompt: {
                  version: 1,
                  sections: [],
                  estimatedTokens: 0,
                  digest: digestRuntimeValue(messages),
                },
                toolBindings: [binding],
                skills: { version: 1, selected: [], catalogDigest: 'none', digest: 'none' },
                mcp: { version: 1, selected: [], catalogDigest: 'none', digest: 'none' },
                taskContextRevision,
              }),
          };
        },
      },
    });
    const runtime = new ThreadRuntimeV1({
      store,
      runner: loop,
      projectPath: root,
      requireTurnCommit: true,
    });
    const consumer = runtime.subscribe('tui', store.getCursor(), {
      maxItems: 64,
      maxBytes: 64 * 1024,
    });

    const admission = runtime.dispatch({
      type: 'turn.start',
      data: { input: 'Read README.md', mode: 'build' },
    });
    expect(admission.status).toBe('started');
    await runtime.waitForIdle();

    expect(executions).toBe(1);
    expect(snapshots).toHaveLength(2);
    expect(new Set(snapshots).size).toBe(2);
    expect(store.loadProjection().stepSnapshotDigests).toEqual(snapshots);
    expect(Object.values(store.loadProjection().items)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'command', name: 'read_file', status: 'completed' }),
        expect.objectContaining({ kind: 'message', role: 'assistant', status: 'completed' }),
      ])
    );
    expect(Object.values(store.loadProjection().turns)[0].status).toBe('completed');
    expect(Object.values(store.loadProjection().turns)[0].commit).toMatchObject({
      terminal: 'completed',
    });
    expect(
      (llm.chatStream as jest.Mock).mock.calls.map(call =>
        (call[2] as Array<{ function: { name: string } }>).map(tool => tool.function.name)
      )
    ).toEqual([['read_file'], ['read_file']]);
    const delivered = consumer.read();
    expect(delivered.status).toBe('events');
    if (delivered.status === 'events') {
      expect(delivered.events.some(event => event.payload.type === 'tool.receipt')).toBe(true);
    }
  });

  test('derives stable UUID identities without sharing provider call ids across steps', () => {
    const left = deterministicRuntimeId(['thread', 'turn', 'step-a', 'call-1', '0']);
    expect(deterministicRuntimeId(['thread', 'turn', 'step-a', 'call-1', '0'])).toBe(left);
    expect(deterministicRuntimeId(['thread', 'turn', 'step-b', 'call-1', '0'])).not.toBe(left);
    expect(left).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
