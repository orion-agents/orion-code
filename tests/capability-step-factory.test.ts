import { randomUUID } from 'crypto';

import type { Message } from '../src/services/llm';
import type { CapabilityToolCandidateV1 } from '../src/runtime/capabilities';
import {
  CapabilityAgentLoopStepFactoryV1,
  CapabilityStepFactoryError,
  createFinalPromptSnapshotV1,
  type AgentLoopStepPrepareInputV1,
  type CapabilityStepConfigurationV1,
  type CapabilityStepPersistenceBundleV1,
} from '../src/runtime/capability-step-factory';
import { digestRuntimeValue } from '../src/runtime/protocol/canonical';
import {
  createAuthoritySnapshotV1,
  createExecutionPolicySnapshotV1,
  type ToolBindingDescriptorV1,
  type ToolBindingV1,
} from '../src/runtime/step-snapshot';

interface ToolFixture {
  readonly candidate: CapabilityToolCandidateV1;
  readonly binding: ToolBindingV1;
}

function toolFixture(
  name: string,
  options: {
    bindingId?: string;
    write?: boolean;
    description?: string;
    schemaProperty?: string;
  } = {}
): ToolFixture {
  const schemaProperty = options.schemaProperty ?? 'path';
  const inputSchema = {
    type: 'object' as const,
    properties: { [schemaProperty]: { type: 'string' } },
    required: [schemaProperty],
  };
  const write = options.write === true;
  const descriptor: ToolBindingDescriptorV1 = {
    name,
    aliases: [],
    description: options.description ?? `Run ${name}`,
    inputSchema,
    schemaDigest: digestRuntimeValue(inputSchema),
    executorId: `executor:${name}:v1`,
    risk: {
      readOnly: !write,
      destructive: false,
      fileEdit: write,
      effect: write ? 'workspace_write' : 'workspace_read',
      network: 'none',
    },
  };
  const bindingId = options.bindingId ?? `binding:${name}:v1`;
  return {
    candidate: {
      bindingId,
      descriptor,
      tier: 'core',
      source: 'first_party',
    },
    binding: {
      descriptor,
      execute: async args => ({ success: true, output: `${name}:${String(args[schemaProperty])}` }),
    },
  };
}

function configuration(
  fixtures: readonly ToolFixture[],
  modelId = 'model-v1'
): CapabilityStepConfigurationV1 {
  const executionPolicy = createExecutionPolicySnapshotV1({
    policyId: 'policy-v1',
    approvalMode: 'never',
    sandboxRequired: true,
    sandboxBackend: 'test',
    timeoutMs: 5_000,
  });
  return {
    taskEpoch: 2,
    model: {
      providerId: 'test-provider',
      modelId,
      protocol: 'test-protocol',
      contextWindow: 32_000,
    },
    executionPolicy,
    environment: {
      cwd: '/repo',
      platform: 'test',
      arch: 'test',
      environmentDigest: `environment:${modelId}`,
    },
    compiler: {
      task: { objective: 'Implement and verify the requested change' },
      model: { toolCalling: true },
      authority: createAuthoritySnapshotV1({
        authorityId: 'project',
        projectRoot: '/repo',
        confirmation: 'allow',
        filesystem: 'workspace',
        network: 'deny',
      }),
      budgets: {
        maxDirectTools: 8,
        maxToolSchemaBytes: 20_000,
        maxDeferredTools: 8,
        maxExpansionTools: 1,
      },
      tools: fixtures.map(fixture => fixture.candidate),
      runtimeServicesDigest: 'runtime-services-v1',
      executionPolicyDigest: executionPolicy.digest,
      skillCatalogDigest: 'skill-catalog-v1',
      mcpCatalogDigest: 'mcp-catalog-v1',
      promptManifest: [{ id: 'system-policy', digest: 'system-policy-v1', selected: true }],
      estimatedInputTokens: 128,
    },
  };
}

function registry(fixtures: readonly ToolFixture[]): ReadonlyMap<string, ToolBindingV1> {
  return new Map(fixtures.map(fixture => [fixture.candidate.bindingId, fixture.binding]));
}

function prepareInput(
  options: {
    threadId?: string;
    turnId?: string;
    requestIndex?: number;
    mode?: AgentLoopStepPrepareInputV1['mode'];
    messages?: readonly Message[];
    revision?: number;
    abortSignal?: AbortSignal;
  } = {}
): AgentLoopStepPrepareInputV1 {
  return {
    threadId: options.threadId ?? randomUUID(),
    turnId: options.turnId ?? randomUUID(),
    requestIndex: options.requestIndex ?? 0,
    input: 'Implement the change',
    mode: options.mode ?? 'build',
    messages: options.messages ?? [{ role: 'user', content: 'draft prompt' }],
    taskContextRevision: options.revision ?? 3,
    abortSignal: options.abortSignal ?? new AbortController().signal,
  };
}

describe('CapabilityAgentLoopStepFactoryV1', () => {
  test('binds exact executors and the final model messages into persistence artifacts', async () => {
    const read = toolFixture('read_file');
    const captures: CapabilityStepPersistenceBundleV1[] = [];
    const factory = new CapabilityAgentLoopStepFactoryV1({
      resolveConfiguration: () => configuration([read]),
      resolveToolRegistry: () => registry([read]),
      onCaptured: bundle => {
        captures.push(bundle);
      },
      clock: () => 100,
    });
    const input = prepareInput();
    const prepared = await factory.prepare(input);
    const finalMessages: Message[] = [
      { role: 'system', content: 'You are Orion.' },
      { role: 'user', content: 'Final prompt after assembly.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"README.md"}' },
          },
        ],
      },
    ];

    expect(prepared.persistenceBundle).toBeUndefined();
    const snapshot = await prepared.capture({
      messages: finalMessages,
      taskContextRevision: 4,
    });
    const bundle = prepared.persistenceBundle!;

    expect(snapshot.stepId).toBe(prepared.stepId);
    expect(snapshot.taskContextRevision).toBe(4);
    expect(snapshot.prompt.digest).toBe(digestRuntimeValue(finalMessages));
    expect(snapshot.prompt.digest).not.toBe(digestRuntimeValue(input.messages));
    expect(snapshot.toolRouter.descriptors.map(descriptor => descriptor.name)).toEqual([
      'read_file',
    ]);
    expect(bundle.capabilityReceipt).toMatchObject({
      stepId: snapshot.stepId,
      toolSchemaDigest: snapshot.toolRouter.visibleSchemaDigest,
      toolBindingDigest: snapshot.toolRouter.bindingDigest,
      toolRouterDigest: snapshot.toolRouter.digest,
      planDigest: snapshot.capabilityPlan.digest,
    });
    expect(bundle.capabilityReceipt.promptManifest).toContainEqual({
      id: 'final-model-messages',
      digest: snapshot.prompt.digest,
      selected: true,
    });
    expect(bundle.receipt).toMatchObject({
      capabilityReceiptDigest: bundle.capabilityReceipt.digest,
      promptDigest: snapshot.prompt.digest,
      snapshotDigest: snapshot.digest,
    });
    expect(captures).toEqual([bundle]);
    expect(Object.isFrozen(bundle)).toBe(true);
    await expect(
      prepared.capture({ messages: finalMessages, taskContextRevision: 4 })
    ).rejects.toMatchObject({ code: 'ORION_CAPABILITY_STEP_ALREADY_CAPTURED' });
  });

  test('captures configuration once so drift affects only the next step', async () => {
    const read = toolFixture('read_file');
    const write = toolFixture('write_file', { write: true });
    let activeConfiguration = configuration([read], 'model-v1');
    let activeRegistry = registry([read]);
    const factory = new CapabilityAgentLoopStepFactoryV1({
      resolveConfiguration: () => activeConfiguration,
      resolveToolRegistry: () => activeRegistry,
    });
    const threadId = randomUUID();
    const turnId = randomUUID();
    const first = await factory.prepare(
      prepareInput({ threadId, turnId, requestIndex: 0, mode: 'build' })
    );

    activeConfiguration = configuration([read, write], 'model-v2');
    activeRegistry = registry([read, write]);
    const firstSnapshot = await first.capture({
      messages: [{ role: 'user', content: 'First final prompt' }],
      taskContextRevision: 5,
    });
    const second = await factory.prepare(
      prepareInput({ threadId, turnId, requestIndex: 1, mode: 'plan' })
    );
    const secondSnapshot = await second.capture({
      messages: [{ role: 'user', content: 'Second final prompt' }],
      taskContextRevision: 6,
    });

    expect(firstSnapshot.model.modelId).toBe('model-v1');
    expect(firstSnapshot.toolRouter.descriptors.map(item => item.name)).toEqual(['read_file']);
    expect(secondSnapshot.model.modelId).toBe('model-v2');
    expect(secondSnapshot.toolRouter.descriptors.map(item => item.name)).toEqual([
      'read_file',
      'write_file',
    ]);
    expect(firstSnapshot.stepId).not.toBe(secondSnapshot.stepId);
    expect(firstSnapshot.baseMode).toBe('build');
    expect(secondSnapshot.baseMode).toBe('plan');
  });

  test('keeps the capability universe identical across Build, Plan and Auto', async () => {
    const fixtures = [toolFixture('read_file'), toolFixture('write_file', { write: true })];
    const factory = new CapabilityAgentLoopStepFactoryV1({
      resolveConfiguration: () => configuration(fixtures),
      resolveToolRegistry: () => registry(fixtures),
    });
    const threadId = randomUUID();
    const turnId = randomUUID();
    const snapshots = [];

    for (const [requestIndex, mode] of ['build', 'plan', 'auto'].entries()) {
      const prepared = await factory.prepare(
        prepareInput({
          threadId,
          turnId,
          requestIndex,
          mode: mode as AgentLoopStepPrepareInputV1['mode'],
        })
      );
      snapshots.push(
        await prepared.capture({
          messages: [{ role: 'user', content: 'Same final prompt' }],
          taskContextRevision: 7,
        })
      );
    }

    expect(snapshots.map(snapshot => snapshot.baseMode)).toEqual(['build', 'plan', 'auto']);
    expect(new Set(snapshots.map(snapshot => snapshot.capabilityPlan.digest)).size).toBe(1);
    expect(new Set(snapshots.map(snapshot => snapshot.toolRouter.digest)).size).toBe(1);
    expect(new Set(snapshots.map(snapshot => snapshot.stepId)).size).toBe(3);
  });

  test('fails closed for missing executors and descriptor or schema drift', async () => {
    const read = toolFixture('read_file');
    const createFactory = (toolRegistry: ReadonlyMap<string, ToolBindingV1>) =>
      new CapabilityAgentLoopStepFactoryV1({
        resolveConfiguration: () => configuration([read]),
        resolveToolRegistry: () => toolRegistry,
      });

    await expect(createFactory(new Map()).prepare(prepareInput())).rejects.toMatchObject({
      code: 'ORION_CAPABILITY_STEP_BINDING_MISSING',
    });

    const withoutExecutor = {
      ...read.binding,
      execute: undefined,
    } as unknown as ToolBindingV1;
    await expect(
      createFactory(new Map([[read.candidate.bindingId, withoutExecutor]])).prepare(prepareInput())
    ).rejects.toMatchObject({ code: 'ORION_CAPABILITY_STEP_EXECUTOR_MISSING' });

    const drifted = toolFixture('read_file', {
      bindingId: read.candidate.bindingId,
      description: 'A changed descriptor',
      schemaProperty: 'differentPath',
    });
    await expect(
      createFactory(new Map([[read.candidate.bindingId, drifted.binding]])).prepare(prepareInput())
    ).rejects.toMatchObject({ code: 'ORION_CAPABILITY_STEP_BINDING_MISMATCH' });
  });

  test('creates deterministic prompt sections while binding every message field', () => {
    const messages: Message[] = [
      { role: 'system', content: 'System' },
      { role: 'tool', content: 'Output', tool_call_id: 'call-1' },
    ];
    const prompt = createFinalPromptSnapshotV1(messages);

    expect(prompt.sections.map(section => section.id)).toEqual([
      'message:0000:system',
      'message:0001:tool',
    ]);
    expect(prompt.sections[1].sourceDigest).toBe(digestRuntimeValue(messages[1]));
    expect(prompt.digest).toBe(digestRuntimeValue(messages));
    expect(prompt.estimatedTokens).toBeGreaterThan(0);
    expect(Object.isFrozen(prompt.sections)).toBe(true);
  });

  test('surfaces the factory error type for invalid persisted configuration', async () => {
    const read = toolFixture('read_file');
    const invalid = configuration([read]);
    const factory = new CapabilityAgentLoopStepFactoryV1({
      resolveConfiguration: () => ({
        ...invalid,
        compiler: { ...invalid.compiler, executionPolicyDigest: 'stale-policy' },
      }),
      resolveToolRegistry: () => registry([read]),
    });

    await expect(factory.prepare(prepareInput())).rejects.toBeInstanceOf(
      CapabilityStepFactoryError
    );
    await expect(factory.prepare(prepareInput())).rejects.toMatchObject({
      code: 'ORION_CAPABILITY_STEP_CONFIG_INVALID',
    });
  });
});
