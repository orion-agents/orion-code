import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type ProbeTool = 'git_status' | 'lsp_get_diagnostics' | 'web_fetch';

interface LongTailModuleProbeReceipt {
  readonly beforeConstruction: readonly string[];
  readonly afterConstruction: readonly string[];
  readonly afterSelection: readonly string[];
  readonly afterExecution: readonly string[];
  readonly result: { readonly success: boolean; readonly output: string; readonly error?: string };
  readonly activity: {
    readonly afterConstruction: ProbeActivity;
    readonly afterSelection: ProbeActivity;
    readonly afterExecution: ProbeActivity;
  };
  readonly stats: {
    readonly monolithicModuleLoads: number;
    readonly groupModuleLoads: number;
    readonly loadedGroups: readonly string[];
    readonly resolvedToolNames: readonly string[];
  };
}

interface ProbeActivity {
  readonly processStarts: number;
  readonly socketStarts: number;
  readonly fetches: number;
}

const repoRoot = process.cwd();

function runProbe(toolName: ProbeTool, args: Record<string, unknown>): LongTailModuleProbeReceipt {
  const workspace = mkdtempSync(join(tmpdir(), 'orion-long-tail-module-probe-'));
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'sample.ts'), 'export const value = 1;\n', 'utf8');
  spawnSync('git', ['init', '--quiet'], { cwd: workspace });
  const script = `
    const path = require('path');
    const childProcess = require('child_process');
    const net = require('net');
    let processStarts = 0;
    let socketStarts = 0;
    let fetches = 0;
    const originalSpawn = childProcess.spawn;
    const originalExecFile = childProcess.execFile;
    const originalConnect = net.connect;
    const originalFetch = globalThis.fetch;
    childProcess.spawn = (...values) => { processStarts += 1; return originalSpawn(...values); };
    childProcess.execFile = (...values) => { processStarts += 1; return originalExecFile(...values); };
    net.connect = (...values) => { socketStarts += 1; return originalConnect(...values); };
    if (originalFetch) {
      globalThis.fetch = (...values) => { fetches += 1; return originalFetch(...values); };
    }
    const activity = () => ({ processStarts, socketStarts, fetches });
    const sourceRoot = path.join(process.cwd(), 'src', 'tools') + path.sep;
    const loaded = () => Object.keys(require.cache)
      .filter(filename => filename.startsWith(sourceRoot))
      .map(filename => path.relative(process.cwd(), filename).split(path.sep).join('/'))
      .sort();
    const beforeConstruction = loaded();
    const { createProductionFirstPartyToolUniverseV1 } = require('./src/runtime/first-party-tool-universe');
    const context = {
      cwd: ${JSON.stringify(workspace)},
      config: { name: 'orion-code', mode: 'module-probe' },
    };
    const universe = createProductionFirstPartyToolUniverseV1({ context });
    const provider = universe.longTail;
    const afterConstruction = loaded();
    const activityAfterConstruction = activity();
    const binding = provider.catalog.bindings.get(${JSON.stringify(`builtin:${toolName}:v1`)});
    if (!binding) throw new Error('probe binding missing');
    const afterSelection = loaded();
    const activityAfterSelection = activity();
    binding.execute(${JSON.stringify(args)}, context).then(result => {
      process.stdout.write('LONG_TAIL_MODULE_PROBE:' + JSON.stringify({
        beforeConstruction,
        afterConstruction,
        afterSelection,
        afterExecution: loaded(),
        result,
        activity: {
          afterConstruction: activityAfterConstruction,
          afterSelection: activityAfterSelection,
          afterExecution: activity(),
        },
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
      throw new Error(`Long-tail module probe failed (${child.status}): ${child.stderr}`);
    }
    const marker = 'LONG_TAIL_MODULE_PROBE:';
    const offset = child.stdout.lastIndexOf(marker);
    if (offset < 0) throw new Error(`Long-tail module receipt missing: ${child.stdout}`);
    return JSON.parse(child.stdout.slice(offset + marker.length)) as LongTailModuleProbeReceipt;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function expectOnlyGroup(receipt: LongTailModuleProbeReceipt, group: 'git' | 'lsp' | 'web'): void {
  expect(receipt.beforeConstruction).toEqual([]);
  expect(receipt.afterConstruction).toEqual([]);
  expect(receipt.afterSelection).toEqual([]);
  expect(receipt.activity.afterConstruction).toEqual({
    processStarts: 0,
    socketStarts: 0,
    fetches: 0,
  });
  expect(receipt.activity.afterSelection).toEqual(receipt.activity.afterConstruction);
  expect(receipt.afterExecution).not.toContain('src/tools/index.ts');
  for (const candidate of ['git', 'lsp', 'web']) {
    if (candidate !== group) {
      expect(receipt.afterExecution).not.toContain(`src/tools/${candidate}.ts`);
    }
  }
  expect(receipt.afterExecution).toContain(`src/tools/${group}.ts`);
  expect(receipt.stats).toMatchObject({
    monolithicModuleLoads: 0,
    groupModuleLoads: 1,
    loadedGroups: [group],
  });
}

describe('first-party long-tail fresh-process module loading', () => {
  test('Git loads only after execution and never materializes LSP/Web or the barrel', () => {
    const receipt = runProbe('git_status', {});
    expect(receipt.result.success).toBe(true);
    expect(receipt.stats.resolvedToolNames).toEqual(['git_status']);
    expectOnlyGroup(receipt, 'git');
  });

  test('LSP invalid input loads its group without spawning a language server', () => {
    const receipt = runProbe('lsp_get_diagnostics', { file_path: '' });
    expect(receipt.result).toMatchObject({ success: false });
    expect(receipt.stats.resolvedToolNames).toEqual(['lsp_get_diagnostics']);
    expectOnlyGroup(receipt, 'lsp');
  });

  test('Web invalid input loads its group without opening a network connection', () => {
    const receipt = runProbe('web_fetch', { url: 'not-a-url', prompt: 'summarize' });
    expect(receipt.result).toMatchObject({ success: false });
    expect(receipt.stats.resolvedToolNames).toEqual(['web_fetch']);
    expectOnlyGroup(receipt, 'web');
  });
});
