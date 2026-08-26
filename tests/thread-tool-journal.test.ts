import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

import { digestRuntimeValue } from '../src/runtime/protocol/canonical';
import {
  ExecutionService,
  captureStepSnapshotV1,
  createAuthoritySnapshotV1,
  createCapabilityPlanV1,
  createExecutionPolicySnapshotV1,
} from '../src/runtime/step-snapshot';
import { ThreadEventStore } from '../src/runtime/thread-event-store';
import { ThreadToolInvocationJournalV1 } from '../src/runtime/thread-tool-journal';
import {
  ToolGateway,
  createSandboxPreparationV1,
  createStaticApprovalDecisionV1,
  createStaticPolicyDecisionV1,
} from '../src/runtime/tool-gateway';

describe('ThreadToolInvocationJournalV1', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'orion-tool-journal-'));
    roots.push(root);
    const threadId = randomUUID();
    const turnId = randomUUID();
    const stepId = randomUUID();
    const store = new ThreadEventStore(root, threadId);
    store.appendDurableBatch([
      { payload: { type: 'thread.started', data: {} } },
      {
        turnId,
        payload: { type: 'turn.started', data: { input: 'write docs', mode: 'build' } },
      },
    ]);
    let executions = 0;
    const snapshot = captureStepSnapshotV1({
      threadId,
      turnId,
      stepId,
      taskEpoch: 0,
      baseMode: 'build',
      model: {
        providerId: 'test',
        modelId: 'test',
        protocol: 'test',
        contextWindow: 10_000,
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
        direct: [{ id: 'write_file', reason: 'explicit' }],
      }),
      prompt: { version: 1, sections: [], estimatedTokens: 0, digest: 'prompt' },
      toolBindings: [
        {
          descriptor: {
            name: 'write_file',
            aliases: [],
            description: 'write',
            inputSchema: { type: 'object', properties: {} },
            executorId: 'test:write:v1',
            risk: {
              readOnly: false,
              destructive: true,
              fileEdit: true,
              effect: 'workspace_write',
              network: 'none',
            },
          },
          execute: async () => {
            executions += 1;
            return { success: true, output: 'written' };
          },
        },
      ],
      skills: { version: 1, selected: [], catalogDigest: 'none', digest: 'none' },
      mcp: { version: 1, selected: [], catalogDigest: 'none', digest: 'none' },
      taskContextRevision: 0,
    });
    const createGateway = () =>
      new ToolGateway({
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
    return { store, snapshot, createGateway, getExecutions: () => executions };
  }

  test('durably brackets a side effect and replays its terminal receipt', async () => {
    const { store, snapshot, createGateway, getExecutions } = setup();
    const request = {
      invocationId: randomUUID(),
      snapshot,
      toolName: 'write_file',
      args: { path: 'README.md', content: 'updated' },
      context: { cwd: store.rootDir, config: { name: 'orion', mode: 'build' } },
    };

    const first = await createGateway().invoke(request);
    expect(first.receipt.terminal).toBe('completed');
    expect(getExecutions()).toBe(1);
    expect(store.loadProjection().items[request.invocationId]).toMatchObject({
      status: 'completed',
      name: 'write_file',
      inputDigest: expect.any(String),
    });

    const replayed = await createGateway().invoke(request);
    expect(replayed.receipt.digest).toBe(first.receipt.digest);
    expect(getExecutions()).toBe(1);
  });

  test('refuses to replay a durable start without a terminal receipt', async () => {
    const { store, snapshot, createGateway, getExecutions } = setup();
    const request = {
      invocationId: randomUUID(),
      snapshot,
      toolName: 'write_file',
      args: { path: 'README.md', content: 'updated' },
      context: { cwd: store.rootDir, config: { name: 'orion', mode: 'build' } },
    };
    const journal = new ThreadToolInvocationJournalV1(store);
    const argsDigest = digestRuntimeValue(request.args);
    const stable = {
      invocationId: request.invocationId,
      threadId: snapshot.threadId,
      turnId: snapshot.turnId,
      stepId: snapshot.stepId,
      toolName: request.toolName,
      snapshotDigest: snapshot.digest,
      argsDigest,
    };
    const content = {
      version: 1 as const,
      ...stable,
      requestDigest: digestRuntimeValue(stable),
      startedAt: 1,
    };
    await journal.begin({ ...content, digest: digestRuntimeValue(content) });

    await expect(createGateway().invoke(request)).rejects.toMatchObject({
      code: 'ORION_TOOL_OUTCOME_INDETERMINATE',
    });
    expect(getExecutions()).toBe(0);
  });
});
