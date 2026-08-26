import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { OrionCodeTool, ToolContext } from '../src/framework/tool';
import { LLMService } from '../src/services/llm';
import { createBuiltinToolCatalogV1 } from '../src/runtime/builtin-tool-provider';
import {
  createOrionRuntimeV1,
  type OrionCapabilityStepConfigurationV1,
  type OrionRuntimeV1,
  type OrionRuntimeV1Options,
} from '../src/runtime/orion-runtime-v1';
import type { McpConnectionV1, McpConnectorV1, McpServerDescriptorV1 } from '../src/runtime/mcp';
import {
  createAuthoritySnapshotV1,
  createExecutionPolicySnapshotV1,
} from '../src/runtime/step-snapshot';
import type {
  SkillDefinitionV1,
  SkillObservationV1,
  SkillProviderSubscriptionV1,
  SkillProviderV1,
  SkillResourceV1,
  SkillScopeV1,
} from '../src/runtime/skills';

class LazySkillFixture implements SkillProviderV1 {
  readonly id = 'skills:test';
  listReads = 0;
  definitionReads = 0;
  resourceReads = 0;
  subscribeCalls = 0;
  disposeCalls = 0;

  async list(_scope: SkillScopeV1, _signal: AbortSignal): Promise<SkillObservationV1> {
    this.listReads++;
    return {
      version: 1,
      providerId: this.id,
      digest: 'skills-observation:test:v1',
      complete: true,
      descriptors: [],
    };
  }

  async get(_id: string, _signal: AbortSignal): Promise<SkillDefinitionV1 | undefined> {
    this.definitionReads++;
    return undefined;
  }

  async getResource(_id: string, _path: string, _signal: AbortSignal): Promise<SkillResourceV1> {
    this.resourceReads++;
    throw new Error('No Skill resource should be loaded during runtime startup.');
  }

  subscribe(
    _invalidate: Parameters<NonNullable<SkillProviderV1['subscribe']>>[0],
    _signal: AbortSignal
  ): SkillProviderSubscriptionV1 {
    this.subscribeCalls++;
    return {
      dispose: () => {
        this.disposeCalls++;
      },
    };
  }
}

class LazyMcpConnectorFixture implements McpConnectorV1 {
  connectCalls = 0;

  async connect(
    _descriptor: McpServerDescriptorV1,
    _signal: AbortSignal
  ): Promise<McpConnectionV1> {
    this.connectCalls++;
    throw new Error('No MCP connection should be opened during runtime startup.');
  }
}

interface RuntimeFixture {
  readonly runtime: OrionRuntimeV1;
  readonly eventRoot: string;
  readonly threadId: string;
  readonly catalog: ReturnType<typeof createBuiltinToolCatalogV1>;
  readonly skills: LazySkillFixture;
  readonly mcp: LazyMcpConnectorFixture;
  readonly resolver: jest.Mock;
}

describe('OrionRuntimeV1 production composition root', () => {
  const roots: string[] = [];
  const runtimes: OrionRuntimeV1[] = [];

  afterEach(async () => {
    await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close('test_cleanup')));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('starts one explicit frozen service graph without eager Skill or MCP IO', async () => {
    const fixture = createFixture(roots, runtimes);

    expect(fixture.runtime.state).toBe('created');
    expect(existsSync(fixture.eventRoot)).toBe(false);
    expect(() => fixture.runtime.services).toThrowError(
      expect.objectContaining({ code: 'ORION_RUNTIME_NOT_STARTED' })
    );

    const firstStart = fixture.runtime.start();
    const secondStart = fixture.runtime.start();
    expect(secondStart).toBe(firstStart);
    await expect(firstStart).resolves.toBe(fixture.runtime);

    expect(fixture.runtime.state).toBe('started');
    expect(Object.isFrozen(fixture.runtime.services)).toBe(true);
    expect(Object.isFrozen(fixture.runtime.contributors)).toBe(true);
    expect(fixture.runtime.services.models.executor).toBeInstanceOf(LLMService);
    expect(fixture.runtime.services.tools.catalog).toBe(fixture.catalog);
    expect(fixture.runtime.services.threads.runtime).toBe(fixture.runtime.thread);
    expect(fixture.runtime.services.events.store.getCursor()).toBe(1);
    expect(fixture.runtime.graph.scope).toBe(fixture.runtime.scope);
    expect(fixture.runtime.graph.prompts).toBe(fixture.runtime.services.prompts.registry);

    expect(fixture.resolver).not.toHaveBeenCalled();
    expect(fixture.skills.subscribeCalls).toBe(1);
    expect(fixture.skills.listReads).toBe(0);
    expect(fixture.skills.definitionReads).toBe(0);
    expect(fixture.skills.resourceReads).toBe(0);
    expect(fixture.mcp.connectCalls).toBe(0);
    expect(fixture.runtime.graph.mcp.getCatalog().descriptors).toHaveLength(1);
  });

  test('rejects a second owner for the same event-store thread and releases ownership on close', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-runtime-owner-'));
    roots.push(root);
    const eventRoot = join(root, 'events');
    const threadId = randomUUID();
    const first = createFixture(roots, runtimes, { root, eventRoot, threadId });
    const second = createFixture(roots, runtimes, { root, eventRoot, threadId });
    await first.runtime.start();

    await expect(second.runtime.start()).rejects.toMatchObject({
      code: 'ORION_RUNTIME_OWNER_CONFLICT',
    });
    expect(second.runtime.state).toBe('closed');

    await first.runtime.close('owner_released');
    const successor = createFixture(roots, runtimes, { root, eventRoot, threadId });
    await expect(successor.runtime.start()).resolves.toBe(successor.runtime);
    expect(successor.runtime.services.events.store.getCursor()).toBe(1);
  });

  test('closes its Thread, MCP and Skill resources once in LIFO order', async () => {
    const fixture = createFixture(roots, runtimes);
    await fixture.runtime.start();
    const thread = fixture.runtime.thread;

    const firstClose = fixture.runtime.close('verified_shutdown');
    const secondClose = fixture.runtime.close('ignored_duplicate_reason');
    expect(secondClose).toBe(firstClose);
    const report = await firstClose;

    expect(report).toMatchObject({
      reason: 'verified_shutdown',
      timedOut: false,
      leaseTimedOut: false,
      errors: [],
      disposed: ['thread-runtime', 'lazy-mcp', 'lazy-skills'],
    });
    expect(fixture.runtime.state).toBe('closed');
    expect(fixture.skills.disposeCalls).toBe(1);
    expect(fixture.mcp.connectCalls).toBe(0);
    expect(
      thread.dispatch({ type: 'turn.start', data: { input: 'must not run', mode: 'build' } })
    ).toEqual({ status: 'rejected', reason: 'shutdown' });
    expect(() => fixture.runtime.graph).toThrowError(
      expect.objectContaining({ code: 'ORION_RUNTIME_NOT_STARTED' })
    );
  });

  test('owns one dynamic subagent capability per turn and closes it on settlement', async () => {
    const publishCommitted = jest.fn();
    const closeTurn = jest.fn();
    const createTurn = jest.fn(
      (input: Parameters<NonNullable<OrionRuntimeV1Options['subagents']>['createTurn']>[0]) => {
        const context: ToolContext = {
          cwd: input.authority.projectRoot,
          config: { name: 'orion-runtime-test', mode: 'build' },
        };
        const catalog = createBuiltinToolCatalogV1([subtaskFixtureTool()], { context });
        return {
          serviceId: `test-subagent-turn:${input.turnId}`,
          turnId: input.turnId,
          catalog,
          publishCommitted,
          close: closeTurn,
        };
      }
    );
    const llm = createLoopLlm([
      {
        content: '',
        model: 'model-test',
        toolCalls: [
          {
            id: 'runtime-read-1',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
          },
        ],
      },
      { content: 'finished after the second frozen step', model: 'model-test' },
    ]);
    const fixture = createFixture(roots, runtimes, undefined, {
      modelExecutor: llm,
      subagents: { serviceId: 'test-subagent-composition-v1', createTurn },
    });

    await fixture.runtime.start();
    const admission = fixture.runtime.thread.dispatch({
      type: 'turn.start',
      data: { input: 'Inspect before finishing', mode: 'build' },
    });
    expect(admission).toMatchObject({ status: 'started' });
    if (admission.status !== 'started') throw new Error('Expected the root turn to start.');
    const turnId = admission.turnId;
    await fixture.runtime.thread.waitForIdle();

    expect(createTurn).toHaveBeenCalledTimes(1);
    expect(publishCommitted).toHaveBeenCalledTimes(2);
    expect(
      publishCommitted.mock.calls.every(
        ([bundle, commit]) =>
          bundle.snapshot.turnId === turnId &&
          commit.turnId === turnId &&
          commit.events.length === 2
      )
    ).toBe(true);
    expect(closeTurn).toHaveBeenCalledTimes(1);
    expect(closeTurn).toHaveBeenCalledWith('parent_turn_settled');
  });
});

function createFixture(
  roots: string[],
  runtimes: OrionRuntimeV1[],
  reuse?: {
    readonly root: string;
    readonly eventRoot: string;
    readonly threadId: string;
  },
  overrides: Partial<OrionRuntimeV1Options> = {}
): RuntimeFixture {
  const root = reuse?.root ?? mkdtempSync(join(tmpdir(), 'orion-runtime-v1-'));
  if (!reuse) roots.push(root);
  const eventRoot = reuse?.eventRoot ?? join(root, 'events');
  const threadId = reuse?.threadId ?? randomUUID();
  const toolContext: ToolContext = {
    cwd: root,
    config: { name: 'orion-runtime-test', mode: 'build' },
  };
  const catalog = createBuiltinToolCatalogV1([readFileTool()], { context: toolContext });
  const skills = new LazySkillFixture();
  const mcp = new LazyMcpConnectorFixture();
  const resolver = jest.fn(() => capabilityConfiguration(root));
  const options: OrionRuntimeV1Options = {
    modelExecutor: new LLMService({ apiKey: 'test-only', model: 'model-test' }),
    toolCatalog: catalog,
    toolContext,
    eventStore: { rootDir: eventRoot, threadId },
    projectPath: root,
    taskContext: { cwd: root, modelId: 'model-test' },
    skills: { providers: [skills] },
    mcp: {
      descriptors: [
        {
          id: 'docs',
          name: 'docs',
          transport: 'stdio',
          configDigest: 'config:docs:v1',
        },
      ],
      connector: mcp,
    },
    resolveCapabilityConfiguration: resolver,
    ...overrides,
  };
  const runtime = createOrionRuntimeV1(options);
  runtimes.push(runtime);
  return { runtime, eventRoot, threadId, catalog, skills, mcp, resolver };
}

function readFileTool(): OrionCodeTool {
  return {
    name: 'read_file',
    description: 'Read a test file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    execute: async args => ({ success: true, output: String(args.path) }),
    checkPermissions: () => ({ behavior: 'allow' }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isDestructive: () => false,
    isFileEdit: () => false,
  };
}

function subtaskFixtureTool(): OrionCodeTool {
  return {
    name: 'subtask',
    description: 'Turn-bound test subtask',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ success: true, output: 'unused' }),
    checkPermissions: () => ({ behavior: 'allow' }),
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    isDestructive: () => false,
    isFileEdit: () => false,
  };
}

function createLoopLlm(
  responses: readonly import('../src/services/llm').LLMResponse[]
): LLMService {
  let index = 0;
  return {
    chatStream: jest.fn(async () => responses[index++] ?? responses.at(-1)!),
    getModel: jest.fn(() => 'model-test'),
  } as unknown as LLMService;
}

function capabilityConfiguration(root: string): OrionCapabilityStepConfigurationV1 {
  const executionPolicy = createExecutionPolicySnapshotV1({
    policyId: 'policy-test',
    approvalMode: 'never',
    sandboxRequired: true,
    sandboxBackend: 'test',
    timeoutMs: 5_000,
  });
  return {
    taskEpoch: 1,
    model: {
      providerId: 'test-provider',
      modelId: 'model-test',
      protocol: 'test-protocol',
      contextWindow: 32_000,
    },
    executionPolicy,
    environment: {
      cwd: root,
      platform: 'test',
      arch: 'test',
      environmentDigest: 'environment-test',
    },
    compiler: {
      task: { objective: 'Exercise explicit runtime composition' },
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
      skillCatalogDigest: 'skill-catalog:not-observed',
      estimatedInputTokens: 64,
    },
  };
}
