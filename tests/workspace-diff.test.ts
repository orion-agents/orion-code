import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findCommand } from '../src/commands';
import type { CommandContext } from '../src/commands/types';
import { Store } from '../src/framework/store';
import { loadConfig } from '../src/services/config';
import { collectWorkspaceDiff, formatWorkspaceDiff } from '../src/services/workspace-diff';
import { TOOLS } from '../src/tools';

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeRuntime() {
  return {
    brain: { getStatus: () => ({ agents: [], pendingTasks: 0, strategy: 'sequential' }) },
    memory: { getStatus: () => ({ working: 0, 'short-term': 0, 'long-term': 0 }) },
    store: { getStats: () => ({ working: 0, 'short-term': 0, 'long-term': 0 }) },
  };
}

function createDirtyRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'openhorse-workspace-diff-'));
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  writeFileSync(join(repo, 'tracked.txt'), 'base\n');
  writeFileSync(join(repo, 'staged.txt'), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial']);

  writeFileSync(join(repo, 'tracked.txt'), 'base\nunstaged\n');
  writeFileSync(join(repo, 'staged.txt'), 'base\nstaged\n');
  git(repo, ['add', 'staged.txt']);
  writeFileSync(join(repo, 'new.txt'), 'new\n');
  return repo;
}

describe('workspace diff service', () => {
  const maybeIt = hasGit ? it : it.skip;
  let repo: string;

  afterEach(() => {
    if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  maybeIt('collects staged, unstaged, and untracked files', () => {
    repo = createDirtyRepo();
    const report = collectWorkspaceDiff({ cwd: repo });
    const rendered = formatWorkspaceDiff(report);

    expect(report.isGitRepo).toBe(true);
    expect(report.clean).toBe(false);
    expect(report.staged.map(file => file.path)).toContain('staged.txt');
    expect(report.unstaged.map(file => file.path)).toContain('tracked.txt');
    expect(report.untracked.map(file => file.path)).toContain('new.txt');
    expect(rendered).toContain('Workspace Diff');
    expect(rendered).toContain('Staged: 1');
    expect(rendered).toContain('Unstaged: 1');
    expect(rendered).toContain('Untracked: 1');
  });

  maybeIt('is exposed as /diff slash command', async () => {
    repo = createDirtyRepo();
    const config = loadConfig({ apiKey: 'sk-test' });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: config.model,
    });
    const logs: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    try {
      const ctx: CommandContext = {
        cwd: repo,
        config,
        store,
        llm: null,
        runtime: makeRuntime() as any,
      };
      const result = await findCommand('diff')!.execute(ctx, '');
      expect(result.success).toBe(true);
      expect(logs.join('\n')).toContain('Workspace Diff');
      expect(logs.join('\n')).toContain('staged.txt');
      expect(logs.join('\n')).toContain('tracked.txt');
      expect(logs.join('\n')).toContain('new.txt');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('openhorse diff CLI', () => {
  const maybeIt = hasGit ? it : it.skip;
  let repo: string;
  let configDir: string;

  afterEach(() => {
    if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
    if (configDir && existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
  });

  maybeIt('prints JSON workspace changes without entering interactive UI', () => {
    repo = createDirtyRepo();
    configDir = mkdtempSync(join(tmpdir(), 'openhorse-workspace-diff-config-'));
    const projectRoot = join(__dirname, '..');
    const result = spawnSync(
      'node',
      ['-r', join(projectRoot, 'node_modules', 'ts-node', 'register'), join(projectRoot, 'src', 'cli.ts'), 'diff', '--output-format', 'json'],
      {
        cwd: repo,
        env: {
          ...process.env,
          ORION_CODE_CONFIG_DIR: configDir,
          TS_NODE_PROJECT: join(projectRoot, 'tsconfig.json'),
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
        encoding: 'utf8',
        timeout: 45000,
        maxBuffer: 1024 * 1024,
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('stable terminal UI');
    const parsed = JSON.parse(result.stdout);
    expect(parsed.isGitRepo).toBe(true);
    expect(parsed.staged.some((file: any) => file.path === 'staged.txt')).toBe(true);
    expect(parsed.unstaged.some((file: any) => file.path === 'tracked.txt')).toBe(true);
    expect(parsed.untracked.some((file: any) => file.path === 'new.txt')).toBe(true);
  });
});
