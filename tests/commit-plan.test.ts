import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findCommand } from '../src/commands';
import type { CommandContext } from '../src/commands/types';
import { Store } from '../src/framework/store';
import { loadConfig } from '../src/services/config';
import { createCommitPlan, formatCommitPlan } from '../src/services/commit-plan';
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

function createRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'openhorse-commit-plan-'));
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  writeFileSync(join(repo, 'tracked.txt'), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial']);
  return repo;
}

describe('commit plan service', () => {
  const maybeIt = hasGit ? it : it.skip;
  let repo: string;

  afterEach(() => {
    if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  maybeIt('marks a fully staged change as ready to commit', () => {
    repo = createRepo();
    writeFileSync(join(repo, 'tests-new.test.ts'), 'test("ok", () => undefined);\n');
    git(repo, ['add', '.']);

    const plan = createCommitPlan({ cwd: repo });
    const rendered = formatCommitPlan(plan);

    expect(plan.readyToCommit).toBe(true);
    expect(plan.suggestedMessage).toMatch(/^test/);
    expect(rendered).toContain('Ready     yes');
    expect(rendered).toContain('git commit -m');
  });

  maybeIt('warns when changes are unstaged or untracked', () => {
    repo = createRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'base\nchanged\n');
    writeFileSync(join(repo, 'new.txt'), 'new\n');

    const plan = createCommitPlan({ cwd: repo });

    expect(plan.readyToCommit).toBe(false);
    expect(plan.warnings.join('\n')).toContain('unstaged');
    expect(plan.warnings.join('\n')).toContain('untracked');
    expect(plan.nextSteps.join('\n')).toContain('Stage the intended files');
  });

  maybeIt('is exposed as /commit slash command', async () => {
    repo = createRepo();
    writeFileSync(join(repo, 'src-file.ts'), 'export const value = 1;\n');
    git(repo, ['add', '.']);

    const config = loadConfig({ apiKey: 'sk-test' });
    const store = new Store({ config, tools: TOOLS, currentModel: config.model });
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
      const result = await findCommand('commit')!.execute(ctx, '');
      expect(result.success).toBe(true);
      expect(logs.join('\n')).toContain('Commit Plan');
      expect(logs.join('\n')).toContain('Message');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('openhorse commit CLI', () => {
  const maybeIt = hasGit ? it : it.skip;
  let repo: string;
  let configDir: string;

  afterEach(() => {
    if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
    if (configDir && existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
  });

  maybeIt('prints JSON commit plan without creating a commit', () => {
    repo = createRepo();
    configDir = mkdtempSync(join(tmpdir(), 'openhorse-commit-plan-config-'));
    writeFileSync(join(repo, 'docs.md'), 'docs\n');
    git(repo, ['add', '.']);
    const before = git(repo, ['rev-parse', 'HEAD']);
    const projectRoot = join(__dirname, '..');

    const result = spawnSync(
      'node',
      ['-r', join(projectRoot, 'node_modules', 'ts-node', 'register'), join(projectRoot, 'src', 'cli.ts'), 'commit', '--output-format', 'json'],
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
    const after = git(repo, ['rev-parse', 'HEAD']);

    expect(result.status).toBe(0);
    expect(before).toBe(after);
    expect(result.stdout).not.toContain('stable terminal UI');
    const parsed = JSON.parse(result.stdout);
    expect(parsed.readyToCommit).toBe(true);
    expect(parsed.suggestedMessage).toContain(':');
  });
});
