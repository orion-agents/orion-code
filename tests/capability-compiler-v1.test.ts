import type { ToolInputJSONSchema } from '../src/framework/tool';
import {
  CapabilityCompilerError,
  compileCapabilityPlanV1,
  expandCapabilityPlanV1,
  type CapabilityCompilerInputV1,
  type CapabilityToolCandidateV1,
} from '../src/runtime/capabilities';
import { digestRuntimeValue } from '../src/runtime/protocol/canonical';
import {
  ToolRouterSnapshotV1,
  createAuthoritySnapshotV1,
  type AgentBaseModeV1,
  type ToolBindingDescriptorV1,
} from '../src/runtime/step-snapshot';

function tool(
  name: string,
  options: {
    tier?: CapabilityToolCandidateV1['tier'];
    source?: CapabilityToolCandidateV1['source'];
    aliases?: string[];
    keywords?: string[];
    network?: ToolBindingDescriptorV1['risk']['network'];
    write?: boolean;
    bindingId?: string;
    mcp?: CapabilityToolCandidateV1['mcp'];
    descriptionPadding?: number;
  } = {}
): CapabilityToolCandidateV1 {
  const schema: ToolInputJSONSchema = {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  };
  const write = options.write === true;
  return {
    bindingId: options.bindingId ?? `binding:${name}:v1`,
    descriptor: {
      name,
      aliases: options.aliases ?? [],
      description: `Run ${name}${'.'.repeat(options.descriptionPadding ?? 0)}`,
      inputSchema: schema,
      schemaDigest: digestRuntimeValue(schema),
      executorId: `executor:${name}:v1`,
      risk: {
        readOnly: !write,
        destructive: false,
        fileEdit: write,
        effect: write ? 'workspace_write' : 'workspace_read',
        network: options.network ?? 'none',
      },
    },
    tier: options.tier ?? 'standard',
    source: options.source ?? 'first_party',
    keywords: options.keywords ?? [],
    mcp: options.mcp,
  };
}

function catalog(): CapabilityToolCandidateV1[] {
  return [
    tool('read_file', { tier: 'core' }),
    tool('write_file', { tier: 'core', write: true }),
    tool('test_runner', { keywords: ['verify'] }),
    tool('web_search', { tier: 'long_tail', network: 'read' }),
    tool('deep_research', { tier: 'long_tail', network: 'read' }),
    tool('github_issues', {
      tier: 'long_tail',
      source: 'mcp',
      network: 'read',
      bindingId: 'mcp:github:issues',
      mcp: { serverId: 'github', bindingDigest: 'github-issues-binding-v1' },
    }),
  ];
}

function compilerInput(
  options: {
    mode?: AgentBaseModeV1;
    tools?: CapabilityToolCandidateV1[];
    task?: Partial<CapabilityCompilerInputV1['task']>;
    budgets?: Partial<CapabilityCompilerInputV1['budgets']>;
    authority?: CapabilityCompilerInputV1['authority'];
    model?: CapabilityCompilerInputV1['model'];
    hardDeniedTools?: CapabilityCompilerInputV1['hardDeniedTools'];
    skills?: CapabilityCompilerInputV1['skills'];
  } = {}
): CapabilityCompilerInputV1 {
  return {
    baseMode: options.mode ?? 'build',
    taskContextRevision: 4,
    task: {
      objective: 'Fix the release flow and verify behavior',
      ...options.task,
    },
    model: options.model ?? { toolCalling: true },
    authority:
      options.authority ??
      createAuthoritySnapshotV1({
        authorityId: 'project-authority',
        projectRoot: '/repo',
        confirmation: 'allow',
        filesystem: 'workspace',
        network: 'write',
      }),
    hardDeniedTools: options.hardDeniedTools,
    budgets: {
      maxDirectTools: 8,
      maxToolSchemaBytes: 20_000,
      maxDeferredTools: 8,
      maxExpansionTools: 1,
      ...options.budgets,
    },
    tools: options.tools ?? catalog(),
    skills: options.skills,
    receipt: {
      requestId: 'request-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      stepId: 'step-1',
      durableCommitId: 'commit-1',
      createdAt: 100,
    },
    runtimeServicesDigest: 'runtime-services-v1',
    executionPolicyDigest: 'execution-policy-v1',
    skillCatalogDigest: 'skill-catalog-v1',
    mcpCatalogDigest: 'mcp-catalog-v1',
    promptManifest: [
      { id: 'system', digest: 'system-v1', selected: true },
      { id: 'memory', digest: 'memory-v1', selected: false, reason: 'budget' },
    ],
    estimatedInputTokens: 512,
  };
}

describe('Capability Compiler V1', () => {
  test('deterministically selects core, explicit and task-derived direct tools', () => {
    const input = compilerInput({ task: { explicitToolIds: ['web_search'] } });
    const first = compileCapabilityPlanV1(input);
    const reordered = compileCapabilityPlanV1({
      ...input,
      baseMode: 'plan',
      tools: [...input.tools].reverse(),
    });
    const auto = compileCapabilityPlanV1({ ...input, baseMode: 'auto' });

    expect(first.plan.direct.map(item => item.id)).toEqual([
      'read_file',
      'test_runner',
      'web_search',
      'write_file',
    ]);
    expect(first.plan.deferred.map(item => item.id)).toEqual(['deep_research', 'github_issues']);
    expect(reordered).toEqual(first);
    expect(auto).toEqual(first);
    expect(first.receipt.toolSchemaBytes).toBeLessThanOrEqual(input.budgets.maxToolSchemaBytes);
    expect(first.receipt.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.directToolBindings[0].descriptor.inputSchema)).toBe(true);
  });

  test('binds the exact selected descriptors to the StepSnapshot router digests', () => {
    const compiled = compileCapabilityPlanV1(
      compilerInput({ task: { explicitToolIds: ['web_search'] } })
    );
    const router = new ToolRouterSnapshotV1(
      compiled.directToolBindings.map(selection => ({
        descriptor: selection.descriptor,
        execute: async () => ({ success: true, output: selection.bindingId }),
      }))
    );

    expect(compiled.directToolBindings.map(binding => binding.bindingId)).toEqual([
      'binding:read_file:v1',
      'binding:test_runner:v1',
      'binding:web_search:v1',
      'binding:write_file:v1',
    ]);
    expect(compiled.receipt).toMatchObject({
      toolSchemaDigest: router.visibleSchemaDigest,
      toolBindingDigest: router.bindingDigest,
      toolRouterDigest: router.digest,
      directToolNames: router.descriptors.map(descriptor => descriptor.name),
    });
  });

  test('puts Authority and model denials in hidden with stable reasons', () => {
    const authority = createAuthoritySnapshotV1({
      authorityId: 'read-only',
      projectRoot: '/repo',
      confirmation: 'deny',
      filesystem: 'workspace',
      network: 'deny',
    });
    const denied = compileCapabilityPlanV1(
      compilerInput({
        authority,
        hardDeniedTools: [{ id: 'read_file', reason: 'Project policy hides filesystem reads.' }],
        task: { explicitToolIds: ['web_search'] },
      })
    );

    expect(denied.receipt.hiddenToolReasons).toMatchObject({
      read_file: 'Project policy hides filesystem reads.',
      web_search: 'Authority denies network reads.',
      write_file: 'Authority denies mutating capabilities.',
    });
    expect(denied.receipt.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'web_search', code: 'authority_denied' }),
      ])
    );

    const unsupported = compileCapabilityPlanV1(compilerInput({ model: { toolCalling: false } }));
    expect(unsupported.plan.direct).toEqual([]);
    expect(unsupported.plan.hidden).toHaveLength(catalog().length);
    expect(Object.values(unsupported.receipt.hiddenToolReasons)).toEqual(
      expect.arrayContaining(['Model does not support tool calling.'])
    );
  });

  test('defers optional matches at budget boundaries and fails closed for required tools', () => {
    const bounded = compileCapabilityPlanV1(compilerInput({ budgets: { maxDirectTools: 2 } }));
    expect(bounded.plan.direct.map(item => item.id)).toEqual(['read_file', 'write_file']);
    expect(bounded.plan.deferred.map(item => item.id)).toContain('test_runner');
    expect(bounded.receipt.omitted).toContainEqual(
      expect.objectContaining({ id: 'test_runner', code: 'direct_tool_budget' })
    );

    expect(() =>
      compileCapabilityPlanV1(compilerInput({ budgets: { maxToolSchemaBytes: 2 } }))
    ).toThrow(expect.objectContaining({ code: 'ORION_CAPABILITY_REQUIRED_BUDGET' }) as Error);
  });

  test('allows one bounded expansion and records the parent digest and omissions', () => {
    const tools = [
      tool('read_file', { tier: 'core' }),
      tool('alpha_tool', { tier: 'long_tail' }),
      tool('beta_tool', { tier: 'long_tail' }),
      tool('gamma_tool', { tier: 'long_tail' }),
    ];
    const input = compilerInput({
      tools,
      task: { objective: 'Investigate the project' },
      budgets: { maxExpansionTools: 1 },
    });
    const initial = compileCapabilityPlanV1(input);
    const expanded = expandCapabilityPlanV1(input, {
      previous: initial,
      requestedToolIds: ['gamma_tool', 'alpha_tool', 'read_file', 'unknown_tool'],
      reason: 'The first model step needs one long-tail capability.',
      receipt: {
        ...input.receipt,
        requestId: 'request-2',
        stepId: 'step-2',
        durableCommitId: 'commit-2',
        createdAt: 200,
      },
    });

    expect(expanded.plan.direct.map(item => item.id)).toEqual(['alpha_tool', 'read_file']);
    expect(expanded.plan.expansionAllowed).toBe(false);
    expect(expanded.receipt.expansion).toMatchObject({
      parentPlanDigest: initial.plan.digest,
      parentReceiptDigest: initial.receipt.digest,
      selectedToolIds: ['alpha_tool'],
      omittedToolIds: ['gamma_tool', 'read_file'],
      maxExpansionTools: 1,
    });
    expect(expanded.receipt.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'gamma_tool', code: 'expansion_limit' }),
        expect.objectContaining({ id: 'read_file', code: 'already_direct' }),
        expect.objectContaining({ id: 'unknown_tool', code: 'expansion_not_deferred' }),
      ])
    );

    expect(() =>
      expandCapabilityPlanV1(input, {
        previous: expanded,
        requestedToolIds: ['beta_tool'],
        reason: 'Try a second expansion.',
        receipt: { ...input.receipt, requestId: 'request-3', stepId: 'step-3' },
      })
    ).toThrow(expect.objectContaining({ code: 'ORION_CAPABILITY_EXPANSION_EXHAUSTED' }) as Error);
  });

  test('intersects Skill-requested capabilities with Authority', () => {
    const deploy = tool('deploy_release', {
      network: 'write',
      write: true,
      tier: 'long_tail',
      source: 'skill',
    });
    const input = compilerInput({
      tools: [tool('read_file', { tier: 'core' }), deploy],
      task: {
        objective: 'Prepare a release',
        explicitSkillIds: ['release-engineer', 'missing-skill'],
      },
      skills: [
        {
          id: 'release-engineer',
          digest: 'release-skill-v1',
          description: 'Prepare releases',
          requestedCapabilities: ['deploy_release'],
          loaded: true,
        },
      ],
      authority: createAuthoritySnapshotV1({
        authorityId: 'no-network-writes',
        projectRoot: '/repo',
        confirmation: 'allow',
        filesystem: 'workspace',
        network: 'read',
      }),
    });
    const compiled = compileCapabilityPlanV1(input);

    expect(compiled.selectedSkills).toEqual([
      expect.objectContaining({ id: 'release-engineer', loaded: true }),
    ]);
    expect(compiled.plan.hidden).toContainEqual(
      expect.objectContaining({ id: 'deploy_release', reason: 'Authority denies network writes.' })
    );
    expect(compiled.receipt.loadedSkillDigests).toEqual({
      'release-engineer': 'release-skill-v1',
    });
    expect(compiled.receipt.omitted).toContainEqual(
      expect.objectContaining({ id: 'missing-skill', code: 'unknown_explicit_skill' })
    );
  });

  test('records selected MCP bindings and deferred overflow without exposing all schemas', () => {
    const secondMcp = tool('linear_issues', {
      tier: 'long_tail',
      source: 'mcp',
      network: 'read',
      bindingId: 'mcp:linear:issues',
      mcp: { serverId: 'linear', bindingDigest: 'linear-issues-binding-v1' },
    });
    const input = compilerInput({
      tools: [...catalog(), secondMcp],
      task: {
        objective: 'Review issue status',
        explicitMcpToolIds: ['mcp:github:issues'],
      },
      budgets: { maxDeferredTools: 1 },
    });
    const compiled = compileCapabilityPlanV1(input);

    expect(compiled.plan.direct.map(item => item.id)).toContain('github_issues');
    expect(compiled.selectedMcpBindings).toContainEqual(
      expect.objectContaining({ id: 'mcp:github:issues', direct: true })
    );
    expect(compiled.receipt.mcpBindingDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(compiled.receipt.omitted).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'deferred_tool_budget' })])
    );
    expect(compiled.deferredTools.every(summary => !('inputSchema' in summary))).toBe(true);
  });

  test('rejects catalog digest drift and duplicate aliases', () => {
    const malformed = tool('malformed');
    (malformed.descriptor as { schemaDigest: string }).schemaDigest = 'wrong';
    expect(() => compileCapabilityPlanV1(compilerInput({ tools: [malformed] }))).toThrow(
      CapabilityCompilerError
    );

    expect(() =>
      compileCapabilityPlanV1(
        compilerInput({
          tools: [tool('first', { aliases: ['shared'] }), tool('second', { aliases: ['shared'] })],
        })
      )
    ).toThrow(/Duplicate tool name or alias/u);
  });
});
