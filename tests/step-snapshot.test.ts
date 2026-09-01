import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { ToolInputJSONSchema, ToolResult } from '../src/framework/tool';
import { retrieveArtifact } from '../src/core/tool-artifacts';
import { getProjectArtifactsDir } from '../src/services/config-dir';
import {
  StepSnapshotValidationError,
  ExecutionService,
  ToolRouterSnapshotV1,
  captureStepSnapshotV1,
  createAuthoritySnapshotV1,
  createCapabilityPlanV1,
  createExecutionPolicySnapshotV1,
  type ToolBindingV1,
} from '../src/runtime/step-snapshot';

function createBinding(
  name: string,
  execute: ToolBindingV1['execute'] = async () => ({ success: true, output: name }),
  options: {
    schema?: ToolInputJSONSchema;
    aliases?: string[];
    risk?: ToolBindingV1['descriptor']['risk'];
  } = {}
): ToolBindingV1 {
  return {
    descriptor: {
      name,
      aliases: options.aliases ?? [],
      description: `Run ${name}`,
      inputSchema:
        options.schema ??
        ({
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        } satisfies ToolInputJSONSchema),
      executorId: `builtin:${name}:v1`,
      risk:
        options.risk ??
        ({
          readOnly: true,
          destructive: false,
          fileEdit: false,
          effect: 'workspace_read',
          network: 'none',
        } as const),
    },
    execute,
  };
}

function createSnapshot(bindings: readonly ToolBindingV1[]) {
  return captureStepSnapshotV1({
    threadId: randomUUID(),
    turnId: randomUUID(),
    stepId: randomUUID(),
    taskEpoch: 1,
    baseMode: 'build',
    model: {
      providerId: 'test',
      modelId: 'test-model',
      protocol: 'openai-completions',
      contextWindow: 32_000,
    },
    authority: createAuthoritySnapshotV1({
      authorityId: 'project-full',
      projectRoot: '/workspace',
      confirmation: 'ask',
      filesystem: 'workspace',
      network: 'deny',
    }),
    executionPolicy: createExecutionPolicySnapshotV1({
      policyId: 'default',
      approvalMode: 'interactive',
      sandboxRequired: true,
      sandboxBackend: 'seatbelt',
      timeoutMs: 30_000,
    }),
    environment: {
      cwd: '/workspace',
      platform: 'darwin',
      arch: 'arm64',
      environmentDigest: 'environment-v1',
    },
    capabilityPlan: createCapabilityPlanV1({
      direct: bindings.map(binding => ({ id: binding.descriptor.name, reason: 'task match' })),
    }),
    prompt: {
      version: 1,
      sections: [],
      estimatedTokens: 0,
      digest: 'prompt-v1',
    },
    toolBindings: bindings,
    skills: { version: 1, selected: [], catalogDigest: 'skills-v1', digest: 'skills-none' },
    mcp: { version: 1, selected: [], catalogDigest: 'mcp-v1', digest: 'mcp-none' },
    taskContextRevision: 3,
  });
}

describe('StepSnapshotV1', () => {
  test('freezes model-visible schema and its exact executor binding together', async () => {
    const schema: ToolInputJSONSchema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    };
    const first: ToolBindingV1['execute'] = async () => ({ success: true, output: 'first' });
    const binding = createBinding('read_file', first, { schema });
    const snapshot = createSnapshot([binding]);

    schema.properties.path.description = 'mutated after capture';
    (binding as { execute: ToolBindingV1['execute'] }).execute = async () => ({
      success: true,
      output: 'replacement',
    });
    const execution = await new ExecutionService().run({
      snapshot,
      toolName: 'read_file',
      args: { path: 'README.md' },
      context: { cwd: '/workspace', config: { name: 'test', mode: 'build' } },
      enforcement: 'full',
    });
    const result = execution.result as ToolResult;

    expect(result.output).toBe('first');
    expect(
      snapshot.toolRouter.visibleSchemas[0].function.parameters.properties.path.description
    ).toBe(undefined);
    expect(() => snapshot.toolRouter.assertIntegrity()).not.toThrow();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.authority)).toBe(true);
  });

  test('rejects duplicate aliases and incomplete or contradictory risk metadata', () => {
    const left = createBinding('read_file', undefined, { aliases: ['files'] });
    const right = createBinding('list_files', undefined, { aliases: ['files'] });
    expect(() => new ToolRouterSnapshotV1([left, right])).toThrow(/Duplicate tool binding/);

    const contradictory = createBinding('bad', undefined, {
      risk: {
        readOnly: true,
        destructive: true,
        fileEdit: false,
        effect: 'workspace_read',
        network: 'none',
      },
    });
    expect(() => new ToolRouterSnapshotV1([contradictory])).toThrow(/contradictory/);
  });

  test('fails closed when CapabilityPlan direct tools and router differ', () => {
    const binding = createBinding('read_file');
    expect(() =>
      captureStepSnapshotV1({
        ...createSnapshot([binding]),
        toolBindings: [],
      })
    ).toThrow(StepSnapshotValidationError);
  });

  test('makes capability lanes deterministic and mutually exclusive', () => {
    const left = createCapabilityPlanV1({
      direct: [
        { id: 'write_file', reason: 'second' },
        { id: 'read_file', reason: 'first' },
      ],
    });
    const right = createCapabilityPlanV1({
      direct: [
        { id: 'read_file', reason: 'first' },
        { id: 'write_file', reason: 'second' },
      ],
    });
    expect(left).toEqual(right);
    expect(left.direct.map(entry => entry.id)).toEqual(['read_file', 'write_file']);
    expect(() =>
      createCapabilityPlanV1({
        direct: [{ id: 'web', reason: 'explicit' }],
        hidden: [{ id: 'web', reason: 'network denied' }],
      })
    ).toThrow(/exactly one lane/);
  });

  test('stores large bound-tool output as a durable artifact and returns a bounded result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-step-artifact-'));
    const workspace = join(root, 'workspace');
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');
    const output = '大'.repeat(12_000);
    try {
      const snapshot = createSnapshot([
        createBinding('exec_command', async () => ({ success: true, output })),
      ]);
      const execution = await new ExecutionService().run({
        snapshot,
        toolName: 'exec_command',
        args: { command: 'fixture' },
        context: { cwd: workspace, config: { name: 'test', mode: 'build' } },
        enforcement: 'full',
      });

      expect(execution.terminal).toBe('completed');
      expect(execution.result.outputBytes).toBe(Buffer.byteLength(output, 'utf8'));
      expect(execution.result.output).toContain('truncated');
      expect(Buffer.byteLength(execution.result.output, 'utf8')).toBeLessThan(
        execution.result.outputBytes!
      );
      expect(execution.result.artifactRef).toEqual({
        id: expect.any(String),
        outputBytes: Buffer.byteLength(output, 'utf8'),
      });
      const artifactPath = join(
        getProjectArtifactsDir(workspace),
        `${execution.result.artifactRef!.id}.txt`
      );
      expect(existsSync(artifactPath)).toBe(true);
      expect(retrieveArtifact(artifactPath)).toBe(output);
    } finally {
      if (previousConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
      else process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
