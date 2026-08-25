import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { OrionCodeTool, ToolContext } from '../src/framework/tool';
import { createBuiltinToolCatalogV1 } from '../src/runtime/builtin-tool-provider';
import {
  createFirstPartyCoreToolProviderV1,
  FirstPartyCoreToolProviderError,
  type FirstPartyCoreToolImporterMapV1,
  type FirstPartyCoreToolModuleV1,
  type FirstPartyCoreToolNameV1,
} from '../src/runtime/first-party-core-provider';
import { ToolRouterSnapshotV1 } from '../src/runtime/step-snapshot';
import { CORE_TOOLS } from '../src/tools/core';

const context: ToolContext = {
  cwd: '/repo',
  config: { name: 'orion-code', mode: 'test' },
};

const CORE_NAMES: readonly FirstPartyCoreToolNameV1[] = [
  'edit_file',
  'exec_command',
  'glob',
  'grep',
  'list_files',
  'read_file',
  'write_file',
];

function fakeToolFromProvider(
  provider: ReturnType<typeof createFirstPartyCoreToolProviderV1>,
  name: FirstPartyCoreToolNameV1,
  executions: string[]
): OrionCodeTool {
  const entry = provider.catalog.entries.find(
    candidate => candidate.candidate.descriptor.name === name
  );
  if (!entry) throw new Error(`Missing fixture descriptor ${name}`);
  const descriptor = entry.candidate.descriptor;
  return {
    name: descriptor.name,
    aliases: [...descriptor.aliases],
    description: descriptor.description,
    parameters: structuredClone(descriptor.inputSchema),
    execute: async () => {
      executions.push(descriptor.name);
      return { success: true, output: descriptor.name };
    },
    checkPermissions: () => ({ behavior: 'allow' as const }),
  };
}

function fakeImporters(
  getProvider: () => ReturnType<typeof createFirstPartyCoreToolProviderV1>,
  executions: string[]
): {
  importers: FirstPartyCoreToolImporterMapV1;
  spies: Record<FirstPartyCoreToolNameV1, jest.Mock<Promise<FirstPartyCoreToolModuleV1>, []>>;
} {
  const spies = Object.fromEntries(
    CORE_NAMES.map(name => [
      name,
      jest.fn(async () => ({
        coreTool: fakeToolFromProvider(getProvider(), name, executions),
      })),
    ])
  ) as Record<FirstPartyCoreToolNameV1, jest.Mock<Promise<FirstPartyCoreToolModuleV1>, []>>;
  return { importers: spies, spies };
}

describe('FirstPartyCoreToolProviderV1', () => {
  test('builds a frozen coding-core catalog without loading tool implementations', () => {
    const { importers, spies } = fakeImporters(() => provider, []);
    const provider = createFirstPartyCoreToolProviderV1({ context, importers });
    const router = new ToolRouterSnapshotV1([...provider.catalog.bindings.values()]);

    expect(provider.catalog.candidates.map(candidate => candidate.descriptor.name)).toEqual(
      CORE_NAMES
    );
    expect(provider.catalog.toolSchemaBytes).toBe(3_947);
    expect(provider.stats()).toEqual({
      version: 1,
      monolithicModuleLoads: 0,
      shardModuleLoads: 0,
      loadedShardNames: [],
      resolvedExecutors: 0,
      resolvedToolNames: [],
    });
    expect(Object.values(spies).every(spy => spy.mock.calls.length === 0)).toBe(true);
    expect(() => router.assertIntegrity()).not.toThrow();
    expect(router.descriptors.every(item => item.executorId === `builtin:${item.name}:v1`)).toBe(
      true
    );
  });

  test('single-flights exact shards and leaves every unselected executor unloaded', async () => {
    const executions: string[] = [];
    const { importers, spies } = fakeImporters(() => provider, executions);
    const provider = createFirstPartyCoreToolProviderV1({ context, importers });
    const read = provider.catalog.bindings.get('builtin:read_file:v1');
    const glob = provider.catalog.bindings.get('builtin:glob:v1');

    expect(read).toBeDefined();
    expect(glob).toBeDefined();
    const results = await Promise.all([
      read!.execute({ path: 'README.md' }, context),
      read!.execute({ path: 'package.json' }, context),
      glob!.execute({ pattern: '**/*.ts' }, context),
    ]);

    expect(results).toEqual([
      { success: true, output: 'read_file' },
      { success: true, output: 'read_file' },
      { success: true, output: 'glob' },
    ]);
    expect(executions).toEqual(['read_file', 'read_file', 'glob']);
    expect(spies.read_file).toHaveBeenCalledTimes(1);
    expect(spies.glob).toHaveBeenCalledTimes(1);
    for (const name of CORE_NAMES.filter(name => name !== 'read_file' && name !== 'glob')) {
      expect(spies[name]).not.toHaveBeenCalled();
    }
    expect(provider.stats()).toEqual({
      version: 1,
      monolithicModuleLoads: 0,
      shardModuleLoads: 2,
      loadedShardNames: ['glob', 'read_file'],
      resolvedExecutors: 2,
      resolvedToolNames: ['glob', 'read_file'],
    });
  });

  test('fails closed before execution when a selected shard schema drifts', async () => {
    const executions: string[] = [];
    const { importers: defaults } = fakeImporters(() => provider, executions);
    const readImporter = jest.fn(async () => {
      const read = fakeToolFromProvider(provider, 'read_file', executions);
      return {
        coreTool: {
          ...read,
          parameters: {
            ...structuredClone(read.parameters),
            required: ['path', 'unexpected'],
          },
        },
      };
    });
    const importers = { ...defaults, read_file: readImporter };
    const provider = createFirstPartyCoreToolProviderV1({ context, importers });
    const read = provider.catalog.bindings.get('builtin:read_file:v1');

    await expect(read!.execute({ path: 'README.md' }, context)).rejects.toThrow(
      FirstPartyCoreToolProviderError
    );
    expect(executions).toEqual([]);
  });

  test('keeps lightweight descriptor identity equal to the exact core shard assembly', () => {
    const provider = createFirstPartyCoreToolProviderV1({ context });
    const eager = createBuiltinToolCatalogV1(CORE_TOOLS, {
      context,
      include: provider.catalog.candidates.map(candidate => candidate.descriptor.name),
    });

    expect(provider.catalog.toolSchemaBytes).toBe(eager.toolSchemaBytes);
    expect(provider.catalog.digest).toBe(eager.digest);
    expect(provider.catalog.candidates).toEqual(eager.candidates);
    expect(provider.stats()).toMatchObject({
      monolithicModuleLoads: 0,
      shardModuleLoads: 0,
      resolvedExecutors: 0,
    });
  });

  test('runs all seven production shards while preserving validation and safety semantics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-core-shards-'));
    const localContext: ToolContext = {
      cwd: root,
      config: { name: 'orion-code', mode: 'test' },
    };
    const provider = createFirstPartyCoreToolProviderV1({ context: localContext });
    const run = (name: FirstPartyCoreToolNameV1, args: Record<string, unknown>) => {
      const binding = provider.catalog.bindings.get(`builtin:${name}:v1`);
      if (!binding) throw new Error(`Missing binding ${name}`);
      return binding.execute(args, localContext);
    };

    try {
      await expect(
        run('write_file', { path: 'src/example.ts', content: 'alpha\nbeta\n' })
      ).resolves.toMatchObject({
        success: true,
      });
      await expect(run('read_file', { path: 'src/example.ts' })).resolves.toMatchObject({
        success: true,
        output: 'alpha\nbeta\n',
      });
      await expect(run('list_files', { path: 'src', maxDepth: 1 })).resolves.toMatchObject({
        success: true,
        output: 'example.ts',
      });
      await expect(run('glob', { path: 'src', pattern: '**/*.ts' })).resolves.toMatchObject({
        success: true,
        output: 'example.ts',
      });
      await expect(
        run('grep', { path: 'src', pattern: 'beta', glob: '*.ts' })
      ).resolves.toMatchObject({
        success: true,
        output: expect.stringContaining('example.ts:2: beta'),
      });
      await expect(
        run('edit_file', {
          path: 'src/example.ts',
          old_string: 'beta',
          new_string: 'gamma',
        })
      ).resolves.toMatchObject({ success: true });
      expect(readFileSync(join(root, 'src', 'example.ts'), 'utf8')).toBe('alpha\ngamma\n');
      await expect(run('exec_command', { command: 'printf core-shard' })).resolves.toMatchObject({
        success: true,
        output: 'core-shard',
      });

      await expect(run('list_files', { path: 'src', maxDepth: 9 })).resolves.toEqual({
        success: false,
        output: '',
        error: 'list_files maxDepth must be a safe integer between 0 and 8',
      });
      await expect(run('exec_command', { command: 'rm -rf /' })).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/blocked|dangerous|root|recursive/i),
      });
      await expect(run('read_file', { path: '../outside.txt' })).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('outside the workspace'),
      });
      expect(provider.stats()).toMatchObject({
        monolithicModuleLoads: 0,
        shardModuleLoads: 7,
        resolvedExecutors: 7,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
