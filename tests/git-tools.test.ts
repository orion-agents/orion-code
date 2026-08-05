import {
  gitStatusTool,
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitBranchTool,
} from '../src/tools/git';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function setupRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orion-git-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@orion.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'orion-test'], { cwd: dir });
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: dir });
  return dir;
}

// 模块加载期探测：沙箱/CI 不可用时整个 suite 跳过，不污染结果。
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

const GIT_OK = gitAvailable();
let repo: string | null = null;

beforeAll(() => {
  if (GIT_OK) {
    try {
      repo = setupRepo();
    } catch {
      repo = null;
    }
  }
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

// 接口签名：execute(args, context) / isReadOnly(args) / checkPermissions(args, context)
const CTX = {} as never;
const ARGS = {} as Record<string, unknown>;

const maybeDescribe = GIT_OK ? describe : describe.skip;
maybeDescribe('git tools (real temp repo)', () => {
  it('git_status reports clean on fresh repo with ahead/behind=0', async () => {
    const result = await gitStatusTool.execute({ cwd: repo! }, CTX);
    expect(result.success).toBe(true);
    const summary = JSON.parse(result.output);
    expect(summary.clean).toBe(true);
    expect(summary.ahead).toBe(0);
    expect(summary.behind).toBe(0);
    // 工具元数据
    expect(gitStatusTool.isReadOnly?.(ARGS)).toBe(true);
    expect(gitStatusTool.checkPermissions?.(ARGS, CTX)).toEqual({ behavior: 'allow' });
  });

  it('git_commit requires a message', async () => {
    const result = await gitCommitTool.execute({ cwd: repo! }, CTX);
    expect(result.success).toBe(false);
    expect(result.error).toContain('commit message');
    expect(result.output).toBeTruthy();
  });

  it('git_commit stages + commits and git_log shows it', async () => {
    writeFileSync(join(repo!, 'a.txt'), 'hello\n');
    const commit = await gitCommitTool.execute(
      { message: 'add a.txt', paths: ['a.txt'], cwd: repo! },
      CTX
    );
    expect(commit.success).toBe(true);
    expect(commit.output).toContain('Commit successful');

    const log = await gitLogTool.execute({ cwd: repo! }, CTX);
    expect(log.success).toBe(true);
    expect(log.output).toContain('add a.txt');

    const status = await gitStatusTool.execute({ cwd: repo! }, CTX);
    const summary = JSON.parse(status.output);
    expect(summary.clean).toBe(true);
  });

  it('git_diff shows working changes', async () => {
    writeFileSync(join(repo!, 'b.txt'), 'line1\n');
    const commit = await gitCommitTool.execute(
      { message: 'add b.txt', paths: ['b.txt'], cwd: repo! },
      CTX
    );
    expect(commit.success).toBe(true);

    writeFileSync(join(repo!, 'b.txt'), 'line1\nline2\n');
    const diff = await gitDiffTool.execute({ cwd: repo! }, CTX);
    expect(diff.success).toBe(true);
    expect(diff.output).toContain('+line2');
  });

  it('git_branch list / create', async () => {
    const list = await gitBranchTool.execute({ action: 'list', cwd: repo! }, CTX);
    expect(list.success).toBe(true);
    expect(list.output).toContain('main');

    const create = await gitBranchTool.execute(
      { action: 'create', name: 'feature-x', cwd: repo! },
      CTX
    );
    expect(create.success).toBe(true);

    const list2 = await gitBranchTool.execute({ action: 'list', cwd: repo! }, CTX);
    expect(list2.output).toContain('feature-x');
  });

  it('git_branch requires a name for create', async () => {
    const result = await gitBranchTool.execute({ action: 'create', cwd: repo! }, CTX);
    expect(result.success).toBe(false);
    expect(result.error).toContain('requires a branch name');
  });

  it('git_commit / git_branch permission metadata', () => {
    expect(gitCommitTool.isReadOnly?.(ARGS)).not.toBe(true);
    expect(gitCommitTool.checkPermissions?.(ARGS, CTX)).toEqual({
      behavior: 'ask',
      reason: expect.any(String),
    });
    expect(gitBranchTool.checkPermissions?.({ action: 'list' }, CTX)).toEqual({ behavior: 'allow' });
    expect(
      gitBranchTool.checkPermissions?.({ action: 'create', name: 'x' }, CTX)
    ).toEqual({ behavior: 'ask', reason: expect.any(String) });
  });
});
