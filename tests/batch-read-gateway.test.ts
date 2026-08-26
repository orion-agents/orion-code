import { randomUUID } from 'crypto';

import type { OrionCodeTool } from '../src/framework/tool';
import {
  BatchReadExecutionServiceV1,
  createBatchReadToolV1,
} from '../src/runtime/batch-read-service';
import { createBuiltinToolCatalogV1 } from '../src/runtime/builtin-tool-provider';
import {
  ExecutionService,
  captureStepSnapshotV1,
  createAuthoritySnapshotV1,
  createCapabilityPlanV1,
  createExecutionPolicySnapshotV1,
} from '../src/runtime/step-snapshot';
import {
  InMemoryToolInvocationJournalV1,
  ToolGateway,
  createSandboxPreparationV1,
  createStaticApprovalDecisionV1,
  createStaticPolicyDecisionV1,
  type ToolInvocationReceiptV1,
} from '../src/runtime/tool-gateway';

describe('BatchReadExecutionServiceV1', () => {
  test('routes the parent and every child through the same policy/sandbox gateway with lineage', async () => {
    const executions: string[] = [];
    const policy: string[] = [];
    const sandbox: string[] = [];
    const journal = new RecordingJournal();
    const catalog = createCatalog([
      readTool('read_file', executions),
      readTool('grep', executions),
    ]);
    const snapshot = createSnapshot(catalog, ['batch_read', 'grep', 'read_file']);
    const gateway = new ToolGateway({
      policy: {
        decide: input => {
          policy.push(input.descriptor.name);
          return createStaticPolicyDecisionV1({ behavior: 'allow', source: 'test' });
        },
      },
      approval: {
        decide: () => createStaticApprovalDecisionV1({ approved: true, source: 'unused' }),
      },
      sandbox: {
        prepare: input => {
          sandbox.push(input.descriptor.name);
          return createSandboxPreparationV1({ backend: 'test', enforcement: 'full' });
        },
      },
      execution: new ExecutionService(),
      nested: new BatchReadExecutionServiceV1(),
      journal,
    });
    const parentInvocationId = randomUUID();
    const completed = await gateway.invoke({
      invocationId: parentInvocationId,
      snapshot,
      toolName: 'batch_read',
      args: {
        steps: [
          { tool: 'read_file', args: { path: 'README.md' } },
          { tool: 'grep', args: { pattern: 'Orion' } },
        ],
      },
      context: { cwd: '/workspace', config: { name: 'orion', mode: 'build' } },
    });

    expect(completed.receipt).toMatchObject({ terminal: 'completed', success: true });
    expect(executions).toEqual(['read_file', 'grep']);
    expect(policy).toEqual(['batch_read', 'read_file', 'grep']);
    expect(sandbox).toEqual(['batch_read', 'read_file', 'grep']);
    const payload = JSON.parse(completed.result.output) as {
      steps: Array<{ invocationId: string; receiptDigest: string }>;
    };
    expect(payload.steps).toHaveLength(2);
    for (const step of payload.steps) {
      expect(journal.receipts.get(step.invocationId)).toMatchObject({
        parentInvocationId,
        terminal: 'completed',
        digest: step.receiptDigest,
      });
    }
    expect(journal.receipts.get(parentInvocationId)).toMatchObject({
      parentInvocationId: undefined,
      terminal: 'completed',
    });
  });

  test('fails the parent when a child is denied and never calls the denied executor', async () => {
    const executions: string[] = [];
    const catalog = createCatalog([
      readTool('read_file', executions),
      readTool('grep', executions),
    ]);
    const snapshot = createSnapshot(catalog, ['batch_read', 'grep', 'read_file']);
    const journal = new RecordingJournal();
    const gateway = new ToolGateway({
      policy: {
        decide: input =>
          createStaticPolicyDecisionV1({
            behavior: input.descriptor.name === 'grep' ? 'deny' : 'allow',
            source: 'test',
            ...(input.descriptor.name === 'grep' ? { reason: 'grep denied' } : {}),
          }),
      },
      approval: {
        decide: () => createStaticApprovalDecisionV1({ approved: true, source: 'unused' }),
      },
      sandbox: {
        prepare: () => createSandboxPreparationV1({ backend: 'test', enforcement: 'full' }),
      },
      execution: new ExecutionService(),
      nested: new BatchReadExecutionServiceV1(),
      journal,
    });
    const result = await gateway.invoke({
      invocationId: randomUUID(),
      snapshot,
      toolName: 'batch_read',
      args: {
        steps: [
          { tool: 'grep', args: { pattern: 'secret' } },
          { tool: 'read_file', args: { path: 'README.md' } },
        ],
      },
      context: { cwd: '/workspace', config: { name: 'orion', mode: 'build' } },
    });

    expect(result.receipt).toMatchObject({ terminal: 'failed', success: false });
    expect(executions).toEqual(['read_file']);
    expect([...journal.receipts.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: 'grep', terminalPhase: 'policy', success: false }),
        expect.objectContaining({ toolName: 'read_file', terminal: 'completed', success: true }),
        expect.objectContaining({ toolName: 'batch_read', terminal: 'failed', success: false }),
      ])
    );
  });

  test('propagates cancellation and does not start later child invocations', async () => {
    const controller = new AbortController();
    const executions: string[] = [];
    const first = readTool('read_file', executions, () => controller.abort('stop batch'));
    const catalog = createCatalog([first, readTool('grep', executions)]);
    const snapshot = createSnapshot(catalog, ['batch_read', 'grep', 'read_file']);
    const journal = new RecordingJournal();
    const gateway = createGateway(journal);
    const result = await gateway.invoke({
      invocationId: randomUUID(),
      snapshot,
      toolName: 'batch_read',
      args: {
        steps: [
          { tool: 'read_file', args: { path: 'README.md' } },
          { tool: 'grep', args: { pattern: 'never-started' } },
        ],
      },
      context: { cwd: '/workspace', config: { name: 'orion', mode: 'build' } },
      abortSignal: controller.signal,
    });

    expect(result.receipt.terminal).toBe('interrupted');
    expect(executions).toEqual(['read_file']);
    expect([...journal.receipts.values()].filter(receipt => receipt.toolName === 'grep')).toEqual(
      []
    );
    expect(JSON.parse(result.result.output)).toMatchObject({
      skipped: 1,
      steps: [
        expect.objectContaining({ tool: 'read_file', terminal: 'interrupted' }),
        expect.objectContaining({ tool: 'grep', state: 'skipped' }),
      ],
    });
  });
});

class RecordingJournal extends InMemoryToolInvocationJournalV1 {
  readonly receipts = new Map<string, ToolInvocationReceiptV1>();

  override async complete(receipt: ToolInvocationReceiptV1): Promise<void> {
    await super.complete(receipt);
    this.receipts.set(receipt.invocationId, receipt);
  }
}

function createGateway(journal: RecordingJournal): ToolGateway {
  return new ToolGateway({
    policy: {
      decide: () => createStaticPolicyDecisionV1({ behavior: 'allow', source: 'test' }),
    },
    approval: {
      decide: () => createStaticApprovalDecisionV1({ approved: true, source: 'unused' }),
    },
    sandbox: {
      prepare: () => createSandboxPreparationV1({ backend: 'test', enforcement: 'full' }),
    },
    execution: new ExecutionService(),
    nested: new BatchReadExecutionServiceV1(),
    journal,
  });
}

function createCatalog(children: readonly OrionCodeTool[]) {
  return createBuiltinToolCatalogV1([createBatchReadToolV1(), ...children], {
    context: { cwd: '/workspace', config: { name: 'orion', mode: 'test' } },
  });
}

function readTool(
  name: 'read_file' | 'grep',
  executions: string[],
  after?: () => void
): OrionCodeTool {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      executions.push(name);
      after?.();
      return { success: true, output: `${name} output` };
    },
    checkPermissions: () => ({ behavior: 'allow' }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isFileEdit: () => false,
  };
}

function createSnapshot(catalog: ReturnType<typeof createCatalog>, direct: readonly string[]) {
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
      confirmation: 'allow',
      filesystem: 'workspace',
      network: 'deny',
    }),
    executionPolicy: createExecutionPolicySnapshotV1({
      policyId: 'sandboxed',
      approvalMode: 'never',
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
      direct: direct.map(id => ({ id, reason: 'batch test' })),
    }),
    prompt: { version: 1, sections: [], estimatedTokens: 0, digest: 'prompt' },
    toolBindings: [...catalog.bindings.values()],
    skills: { version: 1, selected: [], catalogDigest: 'skills', digest: 'skills-none' },
    mcp: { version: 1, selected: [], catalogDigest: 'mcp', digest: 'mcp-none' },
    taskContextRevision: 0,
  });
}
