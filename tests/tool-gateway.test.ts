import { randomUUID } from 'crypto';

import { digestRuntimeValue } from '../src/runtime/protocol/canonical';
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
  type ToolInvocationV1,
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
      executionPolicyDigest: snapshot.executionPolicy.digest,
    });
    const { digest, ...receiptContent } = result.receipt;
    expect(digest).toBe(digestRuntimeValue(receiptContent));
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

  // v0.3.22 T22-01 — while the first execution is still in flight, the same
  // invocationId with different request content must conflict instead of
  // reusing its promise; identity is the createIntent() request digest
  // (invocationId, parent, thread/turn/step, tool, snapshot digest, args).
  describe('in-flight identity conflicts (T22-01)', () => {
    function startBlocked(overrides: Partial<ToolInvocationV1> = {}): {
      gateway: ToolGateway;
      request: ReturnType<typeof invocation>;
      first: Promise<unknown>;
      release: () => void;
    } {
      let release: (() => void) | undefined;
      const blocker = new Promise<void>(resolve => {
        release = resolve;
      });
      const snapshot = createSnapshot(async () => {
        await blocker;
        return { success: true, output: 'first' };
      });
      const request = { ...invocation(snapshot), ...overrides } as ReturnType<typeof invocation>;
      const gateway = createAllowGateway(snapshot);
      const first = gateway.invoke(request);
      return { gateway, request, first, release: () => release?.() };
    }

    test('same ID with different args conflicts during execution', async () => {
      const context = startBlocked();
      await expect(
        context.gateway.invoke({ ...context.request, args: { path: 'other.md', content: 'other' } })
      ).rejects.toMatchObject({ code: 'ORION_TOOL_INVOCATION_CONFLICT' });
      context.release();
    });

    test('same ID with a different tool conflicts during execution', async () => {
      const context = startBlocked();
      await expect(
        context.gateway.invoke({ ...context.request, toolName: 'other_tool' })
      ).rejects.toMatchObject({ code: 'ORION_TOOL_INVOCATION_CONFLICT' });
      context.release();
    });

    test('same ID with a different snapshot conflicts during execution', async () => {
      const context = startBlocked();
      const otherSnapshot = createSnapshot(async () => ({ success: true, output: 'other' }));
      await expect(
        context.gateway.invoke({ ...context.request, snapshot: otherSnapshot })
      ).rejects.toMatchObject({ code: 'ORION_TOOL_INVOCATION_CONFLICT' });
      context.release();
    });

    test('same ID with a different parent conflicts during execution', async () => {
      const context = startBlocked({ parentInvocationId: randomUUID() });
      await expect(
        context.gateway.invoke({ ...context.request, parentInvocationId: randomUUID() })
      ).rejects.toMatchObject({ code: 'ORION_TOOL_INVOCATION_CONFLICT' });
      context.release();
      await expect(context.first).resolves.toMatchObject({ result: { output: 'first' } });
    });

    test('a conflict does not corrupt the in-flight entry: the original completes and replays', async () => {
      const context = startBlocked();
      const { first } = context;
      await expect(
        context.gateway.invoke({ ...context.request, args: { path: 'other.md', content: 'other' } })
      ).rejects.toMatchObject({ code: 'ORION_TOOL_INVOCATION_CONFLICT' });
      context.release();
      await expect(first).resolves.toMatchObject({ result: { output: 'first' } });
      // After completion the same request replays from the durable receipt.
      await expect(context.gateway.invoke(context.request)).resolves.toMatchObject({
        result: { output: 'first' },
      });
    });

    test('a receipt journaled by a previous process replays without a second side effect', async () => {
      const sharedJournal = new InMemoryToolInvocationJournalV1();
      let fixtureExecutions = 0;
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
          journal: sharedJournal,
        });
      const request = invocation(
        createSnapshot(async () => {
          fixtureExecutions += 1;
          return { success: true, output: 'from-previous-run' };
        })
      );
      await buildGateway().invoke(request);
      expect(fixtureExecutions).toBe(1);

      // A "restarted" process shares only the durable journal: the receipt
      // replays and the side effect never runs twice.
      const replayed = await buildGateway().invoke(request);
      expect(replayed.result).toMatchObject({ output: 'from-previous-run' });
      expect(fixtureExecutions).toBe(1);
    });
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
