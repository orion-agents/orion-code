import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { OrionCodeTool, ToolContext } from '../src/framework/tool';
import { createBuiltinToolCatalogV1 } from '../src/runtime/builtin-tool-provider';
import {
  compileCapabilityPlanV1,
  type CapabilityCompilerInputV1,
} from '../src/runtime/capabilities';
import {
  createFirstPartyLongTailToolProviderV1,
  FirstPartyLongTailToolProviderError,
  type FirstPartyLongTailGroupImporterMapV1,
  type FirstPartyLongTailToolGroupV1,
  type FirstPartyLongTailToolModuleV1,
} from '../src/runtime/first-party-long-tail-provider';
import { createProductionFirstPartyToolUniverseV1 } from '../src/runtime/first-party-tool-universe';
import {
  LONG_TAIL_TOOL_DESCRIPTORS,
  type LongTailToolDescriptorSpecV1,
} from '../src/runtime/long-tail-tools/descriptors';
import {
  ExecutionService,
  captureStepSnapshotV1,
  createAuthoritySnapshotV1,
  createCapabilityPlanV1,
  createExecutionPolicySnapshotV1,
} from '../src/runtime/step-snapshot';
import {
  FirstPartySandboxServiceV1,
  FirstPartyToolApprovalServiceV1,
  FirstPartyToolPolicyServiceV1,
} from '../src/runtime/first-party-tool-services';
import { InMemoryToolInvocationJournalV1, ToolGateway } from '../src/runtime/tool-gateway';
import { GIT_TOOLS } from '../src/tools/git';
import { lspTools } from '../src/tools/lsp';
import { WEB_TOOLS } from '../src/tools/web';

const context: ToolContext = {
  cwd: '/repo',
  config: { name: 'orion-code', mode: 'test' },
};

const GROUPS: readonly FirstPartyLongTailToolGroupV1[] = ['git', 'lsp', 'web'];
const LONG_TAIL_NAMES = LONG_TAIL_TOOL_DESCRIPTORS.map(spec => spec.name).sort();
const CORE_NAMES = [
  'edit_file',
  'exec_command',
  'glob',
  'grep',
  'list_files',
  'read_file',
  'write_file',
];

function fakeTool(spec: LongTailToolDescriptorSpecV1, executions: string[]): OrionCodeTool {
  return {
    name: spec.name,
    aliases: [...spec.aliases],
    description: spec.description,
    parameters: structuredClone(spec.parameters),
    execute: async () => {
      executions.push(spec.name);
      return { success: true, output: spec.name };
    },
    checkPermissions: args => spec.permission(args),
    isReadOnly: args => spec.readOnly(args),
    isDestructive: args => spec.destructive(args),
    isFileEdit: args => spec.fileEdit(args),
    isConcurrencySafe: args => spec.concurrencySafe(args),
    userFacingName: args => spec.userFacingName(args),
  };
}

function fakeImporters(executions: string[]): {
  importers: FirstPartyLongTailGroupImporterMapV1;
  spies: Record<
    FirstPartyLongTailToolGroupV1,
    jest.Mock<Promise<FirstPartyLongTailToolModuleV1>, []>
  >;
} {
  const spies = Object.fromEntries(
    GROUPS.map(group => [
      group,
      jest.fn(async () => ({
        tools: LONG_TAIL_TOOL_DESCRIPTORS.filter(spec => spec.group === group).map(spec =>
          fakeTool(spec, executions)
        ),
      })),
    ])
  ) as unknown as Record<
    FirstPartyLongTailToolGroupV1,
    jest.Mock<Promise<FirstPartyLongTailToolModuleV1>, []>
  >;
  return { importers: spies, spies };
}

function compilerInput(
  tools: CapabilityCompilerInputV1['tools'],
  objective: string
): CapabilityCompilerInputV1 {
  return {
    baseMode: 'build',
    taskContextRevision: 0,
    task: { objective },
    model: { toolCalling: true },
    authority: createAuthoritySnapshotV1({
      authorityId: 'test-project',
      projectRoot: '/repo',
      confirmation: 'allow',
      filesystem: 'workspace',
      network: 'write',
    }),
    budgets: {
      maxDirectTools: 20,
      maxToolSchemaBytes: 32_000,
      maxDeferredTools: 32,
      maxExpansionTools: 4,
    },
    tools,
    receipt: {
      requestId: 'request',
      threadId: 'thread',
      turnId: 'turn',
      stepId: 'step',
      durableCommitId: 'commit',
      createdAt: 1,
    },
    runtimeServicesDigest: 'runtime',
    executionPolicyDigest: 'policy',
    skillCatalogDigest: 'skills',
    mcpCatalogDigest: 'mcp',
    estimatedInputTokens: 10,
  };
}

describe('FirstPartyLongTailToolProviderV1', () => {
  test('constructs a descriptor-only 12-tool catalog without importing any group', () => {
    const { importers, spies } = fakeImporters([]);
    const provider = createFirstPartyLongTailToolProviderV1({ context, importers });

    expect(provider.catalog.candidates.map(candidate => candidate.descriptor.name)).toEqual(
      LONG_TAIL_NAMES
    );
    expect(provider.catalog.toolSchemaBytes).toBe(7_004);
    expect(provider.stats()).toEqual({
      version: 1,
      monolithicModuleLoads: 0,
      groupModuleLoads: 0,
      loadedGroups: [],
      resolvedExecutors: 0,
      resolvedToolNames: [],
    });
    expect(Object.values(spies).every(spy => spy.mock.calls.length === 0)).toBe(true);
  });

  test('single-flights selected groups and leaves Web unloaded', async () => {
    const executions: string[] = [];
    const { importers, spies } = fakeImporters(executions);
    const provider = createFirstPartyLongTailToolProviderV1({ context, importers });
    const status = provider.catalog.bindings.get('builtin:git_status:v1')!;
    const diagnostics = provider.catalog.bindings.get('builtin:lsp_get_diagnostics:v1')!;

    await expect(
      Promise.all([
        status.execute({}, context),
        status.execute({ cwd: '.' }, context),
        diagnostics.execute({ file_path: '/repo/example.ts' }, context),
      ])
    ).resolves.toEqual([
      { success: true, output: 'git_status' },
      { success: true, output: 'git_status' },
      { success: true, output: 'lsp_get_diagnostics' },
    ]);
    expect(spies.git).toHaveBeenCalledTimes(1);
    expect(spies.lsp).toHaveBeenCalledTimes(1);
    expect(spies.web).not.toHaveBeenCalled();
    expect(provider.stats()).toEqual({
      version: 1,
      monolithicModuleLoads: 0,
      groupModuleLoads: 2,
      loadedGroups: ['git', 'lsp'],
      resolvedExecutors: 2,
      resolvedToolNames: ['git_status', 'lsp_get_diagnostics'],
    });
    expect(executions).toEqual(['git_status', 'git_status', 'lsp_get_diagnostics']);
  });

  test('fails closed before execution when a selected group schema drifts', async () => {
    const executions: string[] = [];
    const { importers } = fakeImporters(executions);
    const originalGit = importers.git;
    const provider = createFirstPartyLongTailToolProviderV1({
      context,
      importers: {
        ...importers,
        git: async () => {
          const module = await originalGit();
          return {
            tools: module.tools.map(tool =>
              tool.name === 'git_status'
                ? {
                    ...tool,
                    parameters: {
                      ...structuredClone(tool.parameters),
                      required: ['unexpected'],
                    },
                  }
                : tool
            ),
          };
        },
      },
    });

    await expect(
      provider.catalog.bindings.get('builtin:git_status:v1')!.execute({}, context)
    ).rejects.toBeInstanceOf(FirstPartyLongTailToolProviderError);
    expect(executions).toEqual([]);
  });

  test('matches the exact existing Git, LSP and Web schema/risk identities', () => {
    const provider = createFirstPartyLongTailToolProviderV1({ context });
    const eagerTools = [...GIT_TOOLS, ...lspTools, ...WEB_TOOLS];
    const eager = createBuiltinToolCatalogV1(eagerTools, { context });

    expect(provider.catalog.candidates).toEqual(eager.candidates);
    expect(provider.catalog.digest).toBe(eager.digest);
    expect(provider.catalog.toolSchemaBytes).toBe(7_004);
  });

  test('preserves dynamic permission behavior for branch and Web fetch', () => {
    const provider = createFirstPartyLongTailToolProviderV1({ context });
    const byName = new Map(provider.catalog.entries.map(entry => [entry.tool.name, entry.tool]));

    expect(byName.get('git_branch')!.checkPermissions!({}, context)).toEqual({
      behavior: 'allow',
    });
    expect(
      byName.get('git_branch')!.checkPermissions!({ action: 'switch', name: 'feature' }, context)
    ).toEqual({
      behavior: 'ask',
      reason: 'git switch feature will change the checked-out branch and update working-tree files',
    });
    expect(
      byName.get('web_fetch')!.checkPermissions!(
        { url: 'https://docs.github.com/example' },
        context
      )
    ).toEqual({ behavior: 'allow', reason: 'Preapproved host' });
    expect(
      byName.get('web_fetch')!.checkPermissions!({ url: 'https://example.com' }, context)
    ).toEqual({ behavior: 'ask', reason: 'Fetching external URL' });
  });

  test('keeps ordinary coding at core 7 and selects explicit long-tail tasks', () => {
    const universe = createProductionFirstPartyToolUniverseV1({ context });
    const ordinary = compileCapabilityPlanV1(
      compilerInput(universe.catalog.candidates, 'Refactor the parser and update its unit tests')
    );
    const explicit = compileCapabilityPlanV1(
      compilerInput(
        universe.catalog.candidates,
        'Inspect git status, run LSP diagnostics, and do a web search for this task'
      )
    );

    expect(ordinary.plan.direct.map(item => item.id)).toEqual(CORE_NAMES);
    expect(ordinary.plan.deferred.map(item => item.id).sort()).toEqual(
      [...LONG_TAIL_NAMES, 'batch_read'].sort()
    );
    expect(explicit.plan.direct.map(item => item.id)).toEqual(
      expect.arrayContaining([...CORE_NAMES, 'git_status', 'lsp_get_diagnostics', 'web_search'])
    );
    expect(
      explicit.plan.direct.map(item => item.id).filter(name => !CORE_NAMES.includes(name))
    ).toEqual(['git_status', 'lsp_get_diagnostics', 'web_search']);
    expect(universe.core.stats()).toMatchObject({ shardModuleLoads: 0, resolvedExecutors: 0 });
    expect(universe.longTail.stats()).toMatchObject({ groupModuleLoads: 0, resolvedExecutors: 0 });
  });

  test('executes a selected production Git binding only through ToolGateway', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-long-tail-gateway-'));
    const localContext: ToolContext = {
      cwd: root,
      config: { name: 'orion-code', mode: 'test' },
    };
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    const provider = createFirstPartyLongTailToolProviderV1({ context: localContext });
    const binding = provider.catalog.bindings.get('builtin:git_status:v1')!;
    const authority = createAuthoritySnapshotV1({
      authorityId: 'gateway-test',
      projectRoot: root,
      confirmation: 'allow',
      filesystem: 'workspace',
      network: 'deny',
    });
    const snapshot = captureStepSnapshotV1({
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
      authority,
      executionPolicy: createExecutionPolicySnapshotV1({
        policyId: 'gateway-test',
        approvalMode: 'never',
        sandboxRequired: false,
        sandboxBackend: 'none',
        timeoutMs: 5_000,
      }),
      environment: {
        cwd: root,
        platform: process.platform,
        arch: process.arch,
        environmentDigest: 'gateway-test-environment',
      },
      capabilityPlan: createCapabilityPlanV1({
        direct: [{ id: 'git_status', reason: 'Explicit task capability.' }],
      }),
      prompt: { version: 1, sections: [], estimatedTokens: 0, digest: 'prompt' },
      toolBindings: [binding],
      skills: { version: 1, selected: [], catalogDigest: 'skills', digest: 'skills-none' },
      mcp: { version: 1, selected: [], catalogDigest: 'mcp', digest: 'mcp-none' },
      taskContextRevision: 0,
    });
    const gateway = new ToolGateway({
      policy: new FirstPartyToolPolicyServiceV1(provider.catalog, localContext),
      approval: new FirstPartyToolApprovalServiceV1(),
      sandbox: new FirstPartySandboxServiceV1(),
      execution: new ExecutionService(),
      journal: new InMemoryToolInvocationJournalV1(),
    });

    try {
      const result = await gateway.invoke({
        invocationId: randomUUID(),
        snapshot,
        toolName: 'git_status',
        args: {},
        context: localContext,
      });
      expect(result.receipt).toMatchObject({
        terminal: 'completed',
        terminalPhase: 'execute',
        success: true,
      });
      expect(JSON.parse(result.result.output)).toMatchObject({ clean: true, total: 0 });
      expect(provider.stats()).toMatchObject({
        groupModuleLoads: 1,
        loadedGroups: ['git'],
        resolvedToolNames: ['git_status'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
