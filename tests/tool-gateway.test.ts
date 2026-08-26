import { randomUUID } from 'crypto';

import {
  ExecutionService,
  captureStepSnapshotV1,
  createAuthoritySnapshotV1,
  createCapabilityPlanV1,
  createExecutionPolicySnapshotV1,
  type ToolBindingV1,
} from '../src/runtime/step-snapshot';
import {
  InMemoryToolInvocationJournalV1,
  ToolGateway,
  ToolGatewayError,
  createSandboxPreparationV1,
  createStaticApprovalDecisionV1,
  createStaticPolicyDecisionV1,
  type ToolInvocationJournalV1,
  type ToolInvocationReceiptV1,
} from '../src/runtime/tool-gateway';

function createSnapshot(execute: ToolBindingV1['execute']) {
  const binding: ToolBindingV1 = {
    descriptor: {
      name: 'write_file',
      aliases: ['write'],
      description: 'Write a file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
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
    execute,
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
    prompt: {
      version: 1,
      sections: [],
      estimatedTokens: 0,
      digest: 'prompt',
    },
    toolBindings: [binding],
    skills: { version: 1, selected: [], catalogDigest: 'skills', digest: 'skills-none' },
    mcp: { version: 1, selected: [], catalogDigest: 'mcp', digest: 'mcp-none' },
    taskContextRevision: 0,
  });
}

function invocation(snapshot: ReturnType<typeof createSnapshot>) {
  return {
    invocationId: randomUUID(),
    snapshot,
    toolName: 'write_file',
    args: { path: 'README.md', content: 'updated' },
    context: { cwd: '/workspace', config: { name: 'orion', mode: 'build' } },
  };
}

describe('ToolGateway', () => {
  test('runs the single capability-policy-approval-sandbox-execute chain in order', async () => {
    const order: string[] = [];
    const snapshot = createSnapshot(async () => {
      order.push('execute');
      return { success: true, output: 'written' };
    });
    const journal = new RecordingJournal(order);
    const gateway = new ToolGateway({
      policy: {
        decide: () => {
          order.push('policy');
          return createStaticPolicyDecisionV1({ behavior: 'ask', source: 'tool-risk' });
        },
      },
      approval: {
        decide: () => {
          order.push('approval');
          return createStaticApprovalDecisionV1({ approved: true, source: 'user' });
        },
      },
      sandbox: {
        prepare: () => {
          order.push('sandbox');
          return createSandboxPreparationV1({ backend: 'test', enforcement: 'full' });
        },
      },
      execution: new ExecutionService(),
      journal,
      clock: monotonicClock(),
    });

    const parentInvocationId = randomUUID();
    const result = await gateway.invoke({ ...invocation(snapshot), parentInvocationId });

    expect(order).toEqual(['begin', 'policy', 'approval', 'sandbox', 'execute', 'complete']);
    expect(result.result).toMatchObject({ success: true, output: 'written' });
    expect(result.receipt).toMatchObject({
      parentInvocationId,
      terminal: 'completed',
      terminalPhase: 'execute',
      success: true,
      snapshotDigest: snapshot.digest,
      routerDigest: snapshot.toolRouter.digest,
    });
  });

  test('persists policy denial without approval, sandbox, or execution', async () => {
    const order: string[] = [];
    const snapshot = createSnapshot(async () => {
      order.push('execute');
      return { success: true, output: 'unexpected' };
    });
    const gateway = new ToolGateway({
      policy: {
        decide: () => {
          order.push('policy');
          return createStaticPolicyDecisionV1({
            behavior: 'deny',
            source: 'authority',
            reason: 'workspace is read-only',
          });
        },
      },
      approval: {
        decide: () => {
          order.push('approval');
          return createStaticApprovalDecisionV1({ approved: true, source: 'test' });
        },
      },
      sandbox: {
        prepare: () => {
          order.push('sandbox');
          return createSandboxPreparationV1({ backend: 'test', enforcement: 'full' });
        },
      },
      execution: new ExecutionService(),
      journal: new RecordingJournal(order),
    });

    const result = await gateway.invoke(invocation(snapshot));
    expect(order).toEqual(['begin', 'policy', 'complete']);
    expect(result.receipt).toMatchObject({ terminal: 'failed', terminalPhase: 'policy' });
    expect(result.result.error).toContain('read-only');
  });

  test('fails closed when required sandbox only provides partial enforcement', async () => {
    let executions = 0;
    const snapshot = createSnapshot(async () => {
      executions += 1;
      return { success: true, output: 'unexpected' };
    });
    const gateway = createAllowGateway(snapshot, {
      sandbox: createSandboxPreparationV1({ backend: 'best-effort', enforcement: 'partial' }),
    });

    const result = await gateway.invoke(invocation(snapshot));
    expect(executions).toBe(0);
    expect(result.receipt).toMatchObject({ terminal: 'failed', terminalPhase: 'execute' });
    expect(result.result.error).toContain('Required sandbox enforcement');
  });

  test('deduplicates concurrent invocation IDs and never executes twice', async () => {
    let release: (() => void) | undefined;
    let executions = 0;
    const blocker = new Promise<void>(resolve => {
      release = resolve;
    });
    const snapshot = createSnapshot(async () => {
      executions += 1;
      await blocker;
      return { success: true, output: 'once' };
    });
    const gateway = createAllowGateway(snapshot);
    const request = invocation(snapshot);

    const first = gateway.invoke(request);
    const second = gateway.invoke(request);
    expect(second).toBe(first);
    release?.();
    await expect(first).resolves.toMatchObject({ result: { output: 'once' } });
    expect(executions).toBe(1);

    await expect(gateway.invoke(request)).resolves.toMatchObject({ result: { output: 'once' } });
    expect(executions).toBe(1);
  });

  test('does not retry a side effect after terminal receipt persistence fails', async () => {
    let executions = 0;
    const snapshot = createSnapshot(async () => {
      executions += 1;
      return { success: true, output: 'changed external state' };
    });
    const journal = new FailingCompleteJournal();
    const gateway = createAllowGateway(snapshot, { journal });
    const request = invocation(snapshot);

    await expect(gateway.invoke(request)).rejects.toMatchObject({
      code: 'ORION_TOOL_RECEIPT_PERSISTENCE',
    });
    await expect(gateway.invoke(request)).rejects.toMatchObject({
      code: 'ORION_TOOL_OUTCOME_INDETERMINATE',
    });
    expect(executions).toBe(1);
  });

  test('rejects invocation ID reuse with different arguments', async () => {
    const snapshot = createSnapshot(async () => ({ success: true, output: 'done' }));
    const gateway = createAllowGateway(snapshot);
    const request = invocation(snapshot);
    await gateway.invoke(request);

    await expect(
      gateway.invoke({ ...request, args: { path: 'different', content: 'different' } })
    ).rejects.toBeInstanceOf(ToolGatewayError);
  });
});

class RecordingJournal extends InMemoryToolInvocationJournalV1 {
  constructor(private readonly order: string[]) {
    super();
  }

  override async begin(intent: Parameters<InMemoryToolInvocationJournalV1['begin']>[0]) {
    this.order.push('begin');
    return super.begin(intent);
  }

  override async complete(receipt: ToolInvocationReceiptV1) {
    this.order.push('complete');
    return super.complete(receipt);
  }
}

class FailingCompleteJournal extends InMemoryToolInvocationJournalV1 {
  override async complete(_receipt: ToolInvocationReceiptV1): Promise<void> {
    throw new Error('disk unavailable');
  }
}

function createAllowGateway(
  _snapshot: ReturnType<typeof createSnapshot>,
  options: {
    sandbox?: ReturnType<typeof createSandboxPreparationV1>;
    journal?: ToolInvocationJournalV1;
  } = {}
) {
  return new ToolGateway({
    policy: {
      decide: () => createStaticPolicyDecisionV1({ behavior: 'allow', source: 'policy' }),
    },
    approval: {
      decide: () => createStaticApprovalDecisionV1({ approved: true, source: 'unused' }),
    },
    sandbox: {
      prepare: () =>
        options.sandbox ?? createSandboxPreparationV1({ backend: 'test', enforcement: 'full' }),
    },
    execution: new ExecutionService(),
    journal: options.journal ?? new InMemoryToolInvocationJournalV1(),
  });
}

function monotonicClock(): () => number {
  let now = 1_000;
  return () => now++;
}
