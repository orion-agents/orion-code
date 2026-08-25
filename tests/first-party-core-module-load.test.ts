import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

interface ModuleProbeReceipt {
  beforeConstruction: string[];
  afterConstruction: string[];
  afterExecution: string[];
  result: { success: boolean; output: string; error?: string };
  stats: {
    monolithicModuleLoads: number;
    shardModuleLoads: number;
    loadedShardNames: string[];
  };
}

const repoRoot = process.cwd();

function runFreshModuleProbe(
  toolName: 'read_file' | 'exec_command',
  args: Record<string, unknown>
): ModuleProbeReceipt {
  const workspace = mkdtempSync(join(tmpdir(), 'orion-core-module-probe-'));
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'sample.txt'), 'exact shard\n', 'utf8');
  const script = `
    const path = require('path');
    const sourceRoot = path.join(process.cwd(), 'src', 'tools') + path.sep;
    const loaded = () => Object.keys(require.cache)
      .filter(filename => filename.startsWith(sourceRoot))
      .map(filename => path.relative(process.cwd(), filename).split(path.sep).join('/'))
      .sort();
    const beforeConstruction = loaded();
    const { createFirstPartyCoreToolProviderV1 } = require('./src/runtime/first-party-core-provider');
    const context = {
      cwd: ${JSON.stringify(workspace)},
      config: { name: 'orion-code', mode: 'module-probe' },
    };
    const provider = createFirstPartyCoreToolProviderV1({ context });
    const afterConstruction = loaded();
    const binding = provider.catalog.bindings.get(${JSON.stringify(`builtin:${toolName}:v1`)});
    if (!binding) throw new Error('probe binding missing');
    binding.execute(${JSON.stringify(args)}, context).then(result => {
      process.stdout.write('MODULE_PROBE:' + JSON.stringify({
        beforeConstruction,
        afterConstruction,
        afterExecution: loaded(),
        result,
        stats: provider.stats(),
      }));
    }).catch(error => {
      process.stderr.write(String(error && error.stack || error));
      process.exitCode = 1;
    });
  `;

  try {
    const child = spawnSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', '-e', script],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
        timeout: 20_000,
      }
    );
    if (child.status !== 0) {
      throw new Error(`Module probe failed (${child.status}): ${child.stderr || child.stdout}`);
    }
    const marker = 'MODULE_PROBE:';
    const offset = child.stdout.lastIndexOf(marker);
    if (offset < 0) throw new Error(`Module probe receipt missing: ${child.stdout}`);
    return JSON.parse(child.stdout.slice(offset + marker.length)) as ModuleProbeReceipt;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function expectNoUnselectedModules(receipt: ModuleProbeReceipt, selected: string): void {
  expect(receipt.beforeConstruction).toEqual([]);
  expect(receipt.afterConstruction).toEqual([]);
  expect(receipt.afterExecution).not.toContain('src/tools/index.ts');
  expect(receipt.afterExecution).not.toContain('src/tools/core/index.ts');
  for (const shard of [
    'edit-file',
    'exec-command',
    'glob',
    'grep',
    'list-files',
    'read-file',
    'write-file',
  ]) {
    if (shard !== selected) {
      expect(receipt.afterExecution).not.toContain(`src/tools/core/${shard}.ts`);
    }
  }
  for (const longTail of ['git', 'lsp', 'mcp', 'plan', 'todo', 'web']) {
    expect(receipt.afterExecution).not.toContain(`src/tools/${longTail}.ts`);
  }
}

describe('first-party core fresh-process module loading', () => {
  test('read_file loads only its exact shard and shared containment helpers', () => {
    const receipt = runFreshModuleProbe('read_file', { path: 'src/sample.txt' });

    expect(receipt.result).toEqual({ success: true, output: 'exact shard\n' });
    expect(receipt.afterExecution).toEqual([
      'src/tools/core/common.ts',
      'src/tools/core/read-file.ts',
    ]);
    expect(receipt.stats).toMatchObject({
      monolithicModuleLoads: 0,
      shardModuleLoads: 1,
      loadedShardNames: ['read_file'],
    });
    expectNoUnselectedModules(receipt, 'read-file');
  });

  test('exec_command loads its exact shard plus safety dependencies, never the barrel', () => {
    const receipt = runFreshModuleProbe('exec_command', { command: 'printf exact-exec' });

    expect(receipt.result).toMatchObject({ success: true, output: 'exact-exec' });
    expect(receipt.afterExecution).toEqual(
      expect.arrayContaining([
        'src/tools/bash_security.ts',
        'src/tools/core/common.ts',
        'src/tools/core/exec-command.ts',
        'src/tools/sandbox.ts',
      ])
    );
    expect(receipt.stats).toMatchObject({
      monolithicModuleLoads: 0,
      shardModuleLoads: 1,
      loadedShardNames: ['exec_command'],
    });
    expectNoUnselectedModules(receipt, 'exec-command');
  });
});
