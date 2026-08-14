/**
 * Regression tests for issue #36 and issue #40.
 *
 * #36 `env` was allow-listed as a read-only command, so `env <anything>` ran
 *     with no confirmation. Wrappers must inherit the classification of the
 *     command they wrap.
 * #40 `git_branch switch` used `git checkout <name>`, which reverts a
 *     working-tree file when the name is a path; `git_status` dropped renames
 *     and every merge-conflict state.
 */

import { assessCommandSecurity, findDestructiveRmTarget } from '../src/tools/bash_security';
import { gitStatusTool, gitBranchTool } from '../src/tools/git';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolContext } from '../src/framework/tool';

// ---------------------------------------------------------------------------
// #36 -- command wrappers must not launder a dangerous command into `safe`
// ---------------------------------------------------------------------------

describe('issue #36: command wrappers inherit the wrapped classification', () => {
  it('does not treat `env <interpreter>` as read-only', () => {
    const verdict = assessCommandSecurity(`env node -e "require('child_process').execSync('id')"`);
    expect(verdict.isReadOnly).toBe(false);
    expect(verdict.level).not.toBe('safe');
  });

  it.each([
    'env python3 -c "import os"',
    '/usr/bin/env python3 -c "import os"',
    'env -i FOO=bar node -e "1"',
    'env -u PATH bash -c "id"',
    'setsid nohup env node -e "1"',
    'timeout 5 node -e "1"',
    'xargs bash -c "id"',
  ])('does not auto-approve %s', command => {
    expect(assessCommandSecurity(command).isReadOnly).toBe(false);
  });

  it.each([
    ['env ls -la', 'ls'],
    ['env -u PATH ls', 'ls'],
    ['env FOO=bar git status', 'git status'],
    ['nice -10 ls -la', 'ls'],
    ['timeout 5 ls', 'ls'],
    ['stdbuf -o0 cat package.json', 'cat'],
  ])('%s stays read-only because %s is read-only', command => {
    const verdict = assessCommandSecurity(command);
    expect(verdict.isReadOnly).toBe(true);
    expect(verdict.level).toBe('safe');
  });

  it('keeps a bare `env` read-only -- with no command it just prints the environment', () => {
    for (const command of ['env', 'env FOO=bar', 'printenv']) {
      expect(assessCommandSecurity(command).isReadOnly).toBe(true);
    }
  });

  it('never inherits read-only through a privilege wrapper', () => {
    for (const command of ['sudo ls', 'doas ls', 'sudo -u root cat /etc/passwd']) {
      expect(assessCommandSecurity(command).isReadOnly).toBe(false);
    }
  });

  it('resolves the real binary through wrappers so the rm guard still fires', () => {
    expect(findDestructiveRmTarget('env rm -rf / --no-preserve-root')).not.toBeNull();
    expect(findDestructiveRmTarget('timeout 5 rm -rf / --no-preserve-root')).not.toBeNull();
    expect(findDestructiveRmTarget('env -i rm -rf /')).not.toBeNull();
    expect(findDestructiveRmTarget('nice -n 5 sudo rm -rf ~')).not.toBeNull();
  });

  it.each(['env rm -rf / --no-preserve-root', 'timeout 5 rm -rf / --no-preserve-root'])(
    'blocks %s outright',
    command => {
      expect(assessCommandSecurity(command).level).toBe('blocked');
    }
  );

  it('leaves legitimate rm targets alone when wrapped', () => {
    expect(findDestructiveRmTarget('env rm -rf ./build')).toBeNull();
    expect(findDestructiveRmTarget('timeout 5 rm -rf node_modules')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #40 -- git tool correctness
// ---------------------------------------------------------------------------

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version']);
    const dir = mkdtempSync(join(tmpdir(), 'orion-git-probe-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function contextFor(cwd: string): ToolContext {
  return { cwd, config: { name: 'issue-40', mode: 'development' } };
}

const GIT_OK = gitAvailable();
const describeGit = GIT_OK ? describe : describe.skip;

function setupRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orion-issue40-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@orion.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'orion-test'], { cwd: dir });
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: dir });
  return dir;
}

describeGit('issue #40.1: git_branch switch must not revert a working-tree file', () => {
  let repo: string;

  beforeEach(() => {
    repo = setupRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'committed\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('refuses a path-shaped name and preserves uncommitted work', async () => {
    writeFileSync(join(repo, 'tracked.txt'), 'UNCOMMITTED EDIT\n');

    const result = await gitBranchTool.execute(
      { action: 'switch', name: 'tracked.txt', cwd: repo },
      contextFor(repo)
    );

    expect(result.success).toBe(false);
    // The edit is what matters: `git checkout tracked.txt` would silently
    // restore the index content with no way to recover the edit.
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('UNCOMMITTED EDIT\n');
  });

  it('still switches to a real branch', async () => {
    execFileSync('git', ['branch', 'feature'], { cwd: repo });

    const result = await gitBranchTool.execute(
      { action: 'switch', name: 'feature', cwd: repo },
      contextFor(repo)
    );

    expect(result.success).toBe(true);
    const current = execFileSync('git', ['branch', '--show-current'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    expect(current).toBe('feature');
  });

  it('warns that a switch touches working-tree files', () => {
    const decision = gitBranchTool.checkPermissions?.(
      { action: 'switch', name: 'feature', cwd: repo },
      contextFor(repo)
    );
    expect(decision?.behavior).toBe('ask');
    expect(decision?.reason).toMatch(/working-tree/);
  });
});

describeGit('issue #40.2: git_status must surface renames and merge conflicts', () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  async function status(cwd: string): Promise<Record<string, unknown>> {
    const result = await gitStatusTool.execute({ cwd }, contextFor(cwd));
    expect(result.success).toBe(true);
    return JSON.parse(result.output as string);
  }

  it('reports a staged rename instead of dropping it', async () => {
    repo = setupRepo();
    writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
    execFileSync('git', ['add', 'a.ts'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
    execFileSync('git', ['mv', 'a.ts', 'b.ts'], { cwd: repo });

    const summary = await status(repo);

    expect(summary.clean).toBe(false);
    expect(summary.total).toBe(1);
    // Previously: staged=[] modified=[] untracked=[] with total=1.
    expect(summary.staged).toEqual(['b.ts']);
  });

  it('reports conflicted files during a merge conflict', async () => {
    repo = setupRepo();
    writeFileSync(join(repo, 'conflict.txt'), 'base\n');
    execFileSync('git', ['add', 'conflict.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });

    execFileSync('git', ['checkout', '-q', '-b', 'other'], { cwd: repo });
    writeFileSync(join(repo, 'conflict.txt'), 'other\n');
    execFileSync('git', ['commit', '-qam', 'other'], { cwd: repo });

    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo });
    writeFileSync(join(repo, 'conflict.txt'), 'main\n');
    execFileSync('git', ['commit', '-qam', 'main'], { cwd: repo });

    try {
      execFileSync('git', ['merge', 'other'], { cwd: repo, stdio: 'ignore' });
    } catch {
      // The merge is expected to fail: that conflict is the subject of the test.
    }

    const summary = await status(repo);

    expect(summary.hasConflicts).toBe(true);
    expect(summary.conflicted).toEqual(['conflict.txt']);
    // A conflicted path must never be reported as ready to commit.
    expect(summary.staged).toEqual([]);
    expect(summary.clean).toBe(false);
  });

  it('keeps non-ASCII paths intact rather than octal-escaping them', async () => {
    repo = setupRepo();
    writeFileSync(join(repo, 'a.ts'), 'init\n');
    execFileSync('git', ['add', 'a.ts'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
    writeFileSync(join(repo, '文档.md'), '# hi\n');

    const summary = await status(repo);

    expect(summary.untracked).toEqual(['文档.md']);
  });

  it('still reports a plain modification and a clean tree', async () => {
    repo = setupRepo();
    writeFileSync(join(repo, 'a.ts'), 'init\n');
    execFileSync('git', ['add', 'a.ts'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });

    expect(await status(repo)).toMatchObject({ clean: true, total: 0, conflicted: [] });

    writeFileSync(join(repo, 'a.ts'), 'changed\n');
    expect(await status(repo)).toMatchObject({
      clean: false,
      modified: ['a.ts'],
      staged: [],
      conflicted: [],
    });
  });
});
