import type { ToolContext } from '../src/framework/tool';
import { TOOLS } from './support/legacy-tools';
import {
  BuiltinToolCatalogError,
  createBuiltinToolCatalogV1,
} from '../src/runtime/builtin-tool-provider';
import { compileCapabilityPlanV1 } from '../src/runtime/capabilities';
import { createAuthoritySnapshotV1 } from '../src/runtime/step-snapshot';

const context: ToolContext = {
  cwd: '/repo',
  config: { name: 'orion-code', mode: 'test' },
};

describe('BuiltinToolCatalogV1', () => {
  test('adapts every exact core built-in with explicit immutable risk metadata', () => {
    const catalog = createBuiltinToolCatalogV1(TOOLS, { context });

    expect(catalog.entries).toHaveLength(TOOLS.length);
    expect(catalog.candidates.some(candidate => candidate.descriptor.name === 'mcp_call')).toBe(
      false
    );
    expect(catalog.candidates.every(candidate => Object.isFrozen(candidate.descriptor.risk))).toBe(
      true
    );
    expect(catalog.bindings.size).toBe(catalog.entries.length);
  });

  test('reduces the default first-step schema by more than half while preserving coding core', () => {
    const catalog = createBuiltinToolCatalogV1(TOOLS, { context });
    const compilation = compileCapabilityPlanV1({
      baseMode: 'build',
      taskContextRevision: 0,
      task: { objective: 'Fix the implementation and verify tests' },
      model: { toolCalling: true },
      authority: createAuthoritySnapshotV1({
        authorityId: 'project',
        projectRoot: '/repo',
        confirmation: 'allow',
        filesystem: 'workspace',
        network: 'write',
      }),
      hardDeniedTools: [
        { id: 'web_fetch', reason: 'fixture deny' },
        { id: 'git_push', reason: 'fixture deny' },
      ],
      budgets: {
        maxDirectTools: 8,
        maxToolSchemaBytes: 10_298,
        maxDeferredTools: 32,
        maxExpansionTools: 1,
      },
      tools: catalog.candidates,
      receipt: {
        requestId: 'request-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        stepId: 'step-1',
        durableCommitId: 'commit-1',
        createdAt: 1,
      },
      runtimeServicesDigest: 'runtime-v1',
      executionPolicyDigest: 'policy-v1',
      skillCatalogDigest: 'skills-v1',
      mcpCatalogDigest: 'mcp-v1',
      estimatedInputTokens: 100,
    });

    expect(compilation.plan.direct.map(item => item.id)).toEqual([
      'edit_file',
      'exec_command',
      'glob',
      'grep',
      'list_files',
      'read_file',
      'write_file',
    ]);
    expect(compilation.receipt.toolSchemaBytes).toBeLessThanOrEqual(10_298);
    expect(compilation.receipt.toolSchemaBytes).toBeLessThan(20_596 / 2);
    expect(compilation.plan.hidden).toEqual([]);
  });

  test('fails closed for tools missing an explicit first-party policy', () => {
    expect(() =>
      createBuiltinToolCatalogV1(
        [
          {
            name: 'unknown_tool',
            description: 'unknown',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ success: true, output: 'ok' }),
          },
        ],
        { context }
      )
    ).toThrow(BuiltinToolCatalogError);
  });
});
