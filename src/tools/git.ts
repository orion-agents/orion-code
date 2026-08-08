/**
 * orion code - Git 工具
 *
 * Issue #18/#23 修复：安全执行 git push，自动验证 git status
 * v0.1.11: Git 操作验证 - push 后自动验证工作区状态，未追踪文件警告
 *
 * 提供：
 *   - git_status: 检查工作区状态
 *   - git_push: 安全推送（验证 + commit）
 */

import { buildTool, type OpenHorseTool } from '../framework/tool';
import { execFile } from 'child_process';
import { posix } from 'path';

// ============================================================================
// 辅助函数
// ============================================================================

interface ExecResult {
  success: boolean;
  output: string;
  error?: string;
}

type WorkingTreeStatus =
  | { success: true; hasChanges: boolean; files: string[] }
  | { success: false; error: string };

function normalizeStagePath(value: string): string | null {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.startsWith(':') ||
    ['*', '?', '[', ']'].some(character => value.includes(character))
  ) {
    return null;
  }

  const normalized = posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return null;
  }
  return normalized;
}

function parseStagedPaths(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

/** One entry of `git status --porcelain -z`: the XY code plus its path. */
interface PorcelainEntry {
  code: string;
  path: string;
}

/**
 * The XY codes of `git status` porcelain v1 that mean "unmerged".
 *
 * None of them carries an `M`/`A`/`D` in the position the previous parser
 * inspected, so every conflicted file used to vanish from the tool output and
 * the agent could not tell a merge conflict from a clean tree.
 */
const UNMERGED_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * Parse `git status --porcelain -z` into entries.
 *
 * `-z` is what makes this safe: records are NUL-separated and paths are never
 * quoted or backslash-escaped, so non-ASCII filenames survive `core.quotePath`
 * (on by default). Rename and copy records carry a second NUL-terminated field
 * -- the original path -- which must be consumed or it is read as a bogus entry.
 */
function parsePorcelainStatus(output: string): PorcelainEntry[] {
  const records = output.split('\0');
  const entries: PorcelainEntry[] = [];

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    // A porcelain record is "XY <path>": two status columns, a space, the path.
    if (record.length < 4) continue;

    const code = record.slice(0, 2);
    entries.push({ code, path: record.slice(3) });

    // `R`/`C` are followed by the source path as its own NUL-terminated field.
    if (code.includes('R') || code.includes('C')) {
      index++;
    }
  }

  return entries;
}

async function execGit(command: string, cwd?: string, timeout = 30000): Promise<ExecResult> {
  return execGitArgs(command.split(' '), cwd, timeout);
}

async function execGitArgs(args: string[], cwd?: string, timeout = 30000): Promise<ExecResult> {
  return new Promise(resolve => {
    const workdir = cwd || process.cwd();

    execFile(
      'git',
      args,
      {
        cwd: workdir,
        timeout,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        // Preserve the leading status columns from `git status --porcelain`.
        const output = stdout.toString().trimEnd();
        const errOutput = stderr.toString().trim();

        if (error) {
          resolve({
            success: false,
            output: output || errOutput,
            error: error.message || `Command exited with code ${error.code}`,
          });
        } else {
          resolve({
            success: true,
            output,
            error: errOutput || undefined,
          });
        }
      }
    );
  });
}

/**
 * 检查是否有未暂存/未提交的文件
 */
async function checkUncommittedChanges(cwd?: string): Promise<WorkingTreeStatus> {
  const statusResult = await execGit('status --porcelain', cwd);

  if (!statusResult.success) {
    return { success: false, error: statusResult.error || 'unknown git status error' };
  }

  const files = statusResult.output
    .split('\n')
    .filter(line => line.trim())
    .map(line => line.slice(3).trim()); // 去除状态码

  return { success: true, hasChanges: files.length > 0, files };
}

/**
 * 检查远程认证状态
 */
async function checkRemoteAuth(cwd?: string): Promise<{ authenticated: boolean; error?: string }> {
  const remoteResult = await execGit('remote -v', cwd);
  if (!remoteResult.success || !remoteResult.output.includes('origin')) {
    return { authenticated: false, error: 'No remote origin configured' };
  }

  // 尝试 ls-remote 检测认证
  const lsRemoteResult = await execGitArgs(['ls-remote', '--heads', 'origin'], cwd, 10000);

  if (
    lsRemoteResult.output.includes('Authentication failed') ||
    lsRemoteResult.output.includes('Permission denied') ||
    lsRemoteResult.output.includes('could not read Username') ||
    lsRemoteResult.output.includes('fatal: could not read Password')
  ) {
    return { authenticated: false, error: 'Authentication failed - check your git credentials' };
  }

  if (!lsRemoteResult.success && lsRemoteResult.error) {
    return { authenticated: false, error: lsRemoteResult.error };
  }

  return { authenticated: true };
}

// ============================================================================
// git_status 工具
// ============================================================================

export const gitStatusTool: OpenHorseTool = buildTool({
  name: 'git_status',
  description: '检查 Git 工作区状态，返回未暂存和未提交的文件列表。',
  parameters: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description: '工作目录（可选，默认当前目录）',
      },
    },
    required: [],
  },
  execute: async args => {
    const cwd = args.cwd as string | undefined;

    // `-z` gives NUL-separated records and, per git-status(1), disables path
    // quoting entirely -- so a non-ASCII filename arrives verbatim instead of
    // octal-escaped. `core.quotePath=false` is belt-and-braces for old builds.
    const statusResult = await execGitArgs(
      ['-c', 'core.quotePath=false', 'status', '--porcelain', '-z'],
      cwd
    );
    if (!statusResult.success) {
      return {
        success: false,
        output: `git status failed: ${statusResult.error}`,
        error: `git status failed: ${statusResult.error}`,
      };
    }

    // 解析状态
    const entries = parsePorcelainStatus(statusResult.output);

    const untracked: string[] = [];
    const modified: string[] = [];
    const staged: string[] = [];
    const conflicted: string[] = [];

    for (const { code, path: file } of entries) {
      if (code === '??') {
        untracked.push(file);
        continue;
      }

      // Unmerged paths are neither "staged" nor "modified": committing them
      // would commit conflict markers, so they get their own bucket and are
      // surfaced first in the output.
      if (UNMERGED_CODES.has(code)) {
        conflicted.push(file);
        continue;
      }

      if (code === '!!') continue; // ignored, only present with --ignored

      // `R` (rename), `C` (copy) and `T` (typechange) used to match neither
      // branch and were dropped silently while still inflating `total`.
      if (code[0] !== ' ' && code[0] !== '?') {
        staged.push(file); // 已暂存
      }
      if (code[1] !== ' ') {
        modified.push(file); // 工作区修改但未暂存
      }
    }

    // Upstream divergence is best-effort: a detached HEAD or a branch without an
    // upstream makes `rev-list` fail, and that must never turn a successful
    // `git status` into an error.
    let ahead = 0;
    let behind = 0;
    try {
      const upstream = await execGitArgs(
        ['rev-list', '--count', '--left-right', '@{upstream}...HEAD'],
        cwd
      );
      if (upstream.success && upstream.output.includes('\t')) {
        // `--left-right` prints "<left>\t<right>" for `@{upstream}...HEAD`:
        // left  = commits in upstream but not HEAD  -> we are behind
        // right = commits in HEAD but not upstream  -> we are ahead
        const [behindCount, aheadCount] = upstream.output
          .trim()
          .split('\t')
          .map(value => parseInt(value, 10) || 0);
        behind = behindCount;
        ahead = aheadCount;
      }
    } catch {
      // no upstream / detached HEAD -> leave ahead=behind=0
    }

    const summary = {
      clean: entries.length === 0,
      // Listed first so a conflict is impossible to miss: an agent that reads
      // only the head of this object must still see that a merge is in progress.
      conflicted,
      hasConflicts: conflicted.length > 0,
      untracked,
      modified,
      staged,
      total: entries.length,
      ahead,
      behind,
    };

    const output = JSON.stringify(summary, null, 2);

    return {
      success: true,
      output,
    };
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ behavior: 'allow' }),
  userFacingName: () => 'Git Status',
});

// ============================================================================
// git_push 工具
// ============================================================================

export const gitPushTool: OpenHorseTool = buildTool({
  name: 'git_push',
  description: `安全执行 git push，自动验证 git status、显式 staging 边界和认证状态。

工作流程：
1. 检查 git status --porcelain（未暂存/未提交的文件）
2. 仅对显式文件 paths 执行 git add -- <paths>；拒绝目录、glob/pathspec 和预暂存越界文件
3. git commit（如果需要）
4. 若提交后仍有未提交文件，在任何远程写入前停止
5. 检查远程认证状态
6. git push
7. 验证 push 成功

Issue #18/#23 修复：不再在未验证的情况下声称成功。`,
  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Commit message（如果有变更需要提交）',
      },
      add_all: {
        type: 'boolean',
        description: '已废弃且禁止；请使用 paths 显式列出要暂存的文件',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: '要暂存的精确仓库相对文件路径；存在工作区变更时必填',
      },
      cwd: {
        type: 'string',
        description: '工作目录（可选）',
      },
      verify: {
        type: 'boolean',
        description: '是否验证远程认证（默认 true）',
      },
    },
    required: ['message'],
  },
  execute: async args => {
    const message = args.message as string;
    const addAll = (args.add_all as boolean) ?? false;
    const rawPaths = args.paths;
    const cwd = args.cwd as string | undefined;
    const verify = (args.verify as boolean) ?? true;

    if (!message || typeof message !== 'string') {
      return { success: false, output: '', error: 'git_push requires a commit message' };
    }

    if (addAll) {
      return {
        success: false,
        output: '',
        error: 'git_push add_all=true is disabled; provide an explicit paths allowlist',
      };
    }

    if (rawPaths !== undefined && !Array.isArray(rawPaths)) {
      return { success: false, output: '', error: 'git_push paths must be an array of strings' };
    }
    const paths = (rawPaths as unknown[] | undefined) ?? [];
    if (paths.some(path => typeof path !== 'string')) {
      return {
        success: false,
        output: '',
        error: 'git_push paths must contain only strings',
      };
    }
    const normalizedPaths = (paths as string[]).map(normalizeStagePath);
    if (normalizedPaths.some(path => path === null)) {
      return {
        success: false,
        output: '',
        error:
          'git_push paths must be exact repository-relative files without glob or pathspec syntax',
      };
    }
    const stagePaths = [...new Set(normalizedPaths as string[])];

    const log: string[] = [];

    // 1. 检查当前状态
    log.push('🔍 Checking git status...');
    const changes = await checkUncommittedChanges(cwd);

    if (!changes.success) {
      return {
        success: false,
        output: log.join('\n'),
        error: `git status failed: ${changes.error}`,
      };
    }

    if (changes.hasChanges) {
      log.push(
        `  Found ${changes.files.length} uncommitted files: ${changes.files.slice(0, 5).join(', ')}${changes.files.length > 5 ? '...' : ''}`
      );

      // 2. 只暂存显式文件 allowlist；永不继承或扩大现有 staging 边界。
      if (stagePaths.length === 0) {
        return {
          success: false,
          output: log.join('\n'),
          error: 'Uncommitted changes require an explicit file paths allowlist',
        };
      }

      const expectedStagePaths = new Set(stagePaths);
      for (const path of stagePaths) {
        const exactPathResult = await execGitArgs(
          ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', path],
          cwd
        );
        if (!exactPathResult.success) {
          return {
            success: false,
            output: log.join('\n'),
            error: `Exact staging-path verification failed for ${path}: ${exactPathResult.error}`,
          };
        }
        const matchingPaths = parseStagedPaths(exactPathResult.output);
        if (matchingPaths.length !== 1 || matchingPaths[0] !== path) {
          return {
            success: false,
            output: log.join('\n'),
            error: `git_push paths must identify exact files, not directories or expanded pathspecs: ${path}`,
          };
        }
      }

      const initialStagedResult = await execGitArgs(['diff', '--cached', '--name-only', '-z'], cwd);
      if (!initialStagedResult.success) {
        return {
          success: false,
          output: log.join('\n'),
          error: `Initial staged-file verification failed: ${initialStagedResult.error}`,
        };
      }
      const unexpectedInitialPaths = parseStagedPaths(initialStagedResult.output).filter(
        path => !expectedStagePaths.has(path)
      );
      if (unexpectedInitialPaths.length > 0) {
        return {
          success: false,
          output: log.join('\n'),
          error: `Pre-staged files fall outside the explicit allowlist: ${unexpectedInitialPaths.join(', ')}`,
        };
      }

      const indexSnapshotResult = await execGitArgs(['write-tree'], cwd);
      if (!indexSnapshotResult.success || !/^[0-9a-f]{40,64}$/.test(indexSnapshotResult.output)) {
        return {
          success: false,
          output: log.join('\n'),
          error: `Unable to snapshot the Git index before staging: ${indexSnapshotResult.error || 'invalid tree id'}`,
        };
      }
      const restoreIndex = async (): Promise<string | undefined> => {
        const result = await execGitArgs(['read-tree', indexSnapshotResult.output], cwd);
        return result.success ? undefined : result.error || 'unknown index restore error';
      };

      log.push(`📦 Staging ${stagePaths.length} explicit file(s)...`);
      const addResult = await execGitArgs(['add', '--', ...stagePaths], cwd);
      if (!addResult.success) {
        const restoreError = await restoreIndex();
        return {
          success: false,
          output: log.join('\n'),
          error: restoreError
            ? `git add failed: ${addResult.error}; index rollback failed: ${restoreError}`
            : `git add failed: ${addResult.error}; index restored`,
        };
      }
      log.push(
        `  ✓ Staged: ${stagePaths.slice(0, 5).join(', ')}${stagePaths.length > 5 ? '...' : ''}`
      );

      const stagedResult = await execGitArgs(['diff', '--cached', '--name-only', '-z'], cwd);
      if (!stagedResult.success) {
        const restoreError = await restoreIndex();
        return {
          success: false,
          output: log.join('\n'),
          error: restoreError
            ? `Staged-file verification failed: ${stagedResult.error}; index rollback failed: ${restoreError}`
            : `Staged-file verification failed: ${stagedResult.error}; index restored`,
        };
      }
      const stagedFiles = parseStagedPaths(stagedResult.output);
      const unexpectedStagedPaths = stagedFiles.filter(path => !expectedStagePaths.has(path));
      const missingStagedPaths = stagePaths.filter(path => !stagedFiles.includes(path));
      if (unexpectedStagedPaths.length > 0 || missingStagedPaths.length > 0) {
        const restoreError = await restoreIndex();
        return {
          success: false,
          output: log.join('\n'),
          error: [
            'Staged files do not exactly match the explicit allowlist',
            unexpectedStagedPaths.length > 0
              ? `unexpected: ${unexpectedStagedPaths.join(', ')}`
              : '',
            missingStagedPaths.length > 0 ? `missing: ${missingStagedPaths.join(', ')}` : '',
            restoreError ? `index rollback failed: ${restoreError}` : 'index restored',
          ]
            .filter(Boolean)
            .join('; '),
        };
      }
      log.push(`  ✓ Verified ${stagedFiles.length} staged file(s)`);

      const preCommitHead = await execGitArgs(['rev-parse', 'HEAD'], cwd);
      if (!preCommitHead.success || !/^[0-9a-f]{40,64}$/.test(preCommitHead.output)) {
        const restoreError = await restoreIndex();
        return {
          success: false,
          output: log.join('\n'),
          error: [
            `Unable to snapshot HEAD before commit: ${preCommitHead.error || 'invalid commit id'}`,
            restoreError ? `index rollback failed: ${restoreError}` : 'index restored',
          ].join('; '),
        };
      }

      // 3. git commit
      log.push(`📝 Committing with message: "${message.slice(0, 50)}..."`);
      const commitResult = await execGitArgs(['commit', '-m', message], cwd);
      if (!commitResult.success) {
        // 可能是 "nothing to commit"
        if (commitResult.output.includes('nothing to commit')) {
          log.push('  ⚠ Nothing new to commit');
        } else {
          const postFailureHead = await execGitArgs(['rev-parse', 'HEAD'], cwd);
          const restoreError = await restoreIndex();
          const headChanged =
            postFailureHead.success && postFailureHead.output !== preCommitHead.output;
          const headStatus = !postFailureHead.success
            ? `HEAD verification failed: ${postFailureHead.error || 'unknown error'}`
            : headChanged
              ? `HEAD changed unexpectedly from ${preCommitHead.output} to ${postFailureHead.output}; manual recovery required`
              : undefined;
          return {
            success: false,
            output: log.join('\n'),
            error: [
              `git commit failed: ${commitResult.error}`,
              restoreError ? `index rollback failed: ${restoreError}` : 'index restored',
              headStatus,
            ]
              .filter(Boolean)
              .join('; '),
          };
        }
      } else {
        log.push('  ✓ Commit successful');
      }

      const postCommitChanges = await checkUncommittedChanges(cwd);
      if (!postCommitChanges.success) {
        return {
          success: false,
          output: log.join('\n'),
          error: `Post-commit git status failed: ${postCommitChanges.error}`,
        };
      }
      if (postCommitChanges.hasChanges) {
        log.push(
          `  ⚠ ${postCommitChanges.files.length} file(s) remain outside the committed boundary`
        );
        return {
          success: false,
          output: log.join('\n'),
          error: 'Commit created but push was not attempted because the working tree is not clean',
        };
      }
    } else {
      log.push('  ✓ Working directory clean, no changes to commit');
    }

    // 4. 检查认证（如果启用）
    if (verify) {
      log.push('🔐 Checking remote authentication...');
      const auth = await checkRemoteAuth(cwd);
      if (!auth.authenticated) {
        return {
          success: false,
          output: log.join('\n'),
          error: auth.error || 'Remote authentication failed - please configure git credentials',
        };
      }
      log.push('  ✓ Authentication verified');
    }

    // 5. git push
    log.push('🚀 Pushing to remote...');
    const pushResult = await execGit('push', cwd, 60000); // 60s timeout

    if (!pushResult.success) {
      return {
        success: false,
        output: log.join('\n'),
        error: `git push failed: ${pushResult.error}`,
      };
    }
    log.push('  ✓ Push completed');

    // 6. 验证最终状态（v0.1.11 增强）
    log.push('✅ Verifying final status...');
    const finalChanges = await checkUncommittedChanges(cwd);

    if (!finalChanges.success) {
      return {
        success: false,
        output: log.join('\n'),
        error: `Final git status failed: ${finalChanges.error}`,
      };
    }

    const logResult = await execGit('log --oneline -1', cwd);

    if (!logResult.success) {
      return {
        success: false,
        output: log.join('\n'),
        error: `Final git log failed: ${logResult.error}`,
      };
    }

    const untrackedResult = await execGit('status --short', cwd);

    if (!untrackedResult.success) {
      return {
        success: false,
        output: log.join('\n'),
        error: `Final git status --short failed: ${untrackedResult.error}`,
      };
    }

    // v0.1.11: 检查是否有未追踪文件（?? 状态）
    const untrackedFiles = untrackedResult.output
      .split('\n')
      .filter(line => line.startsWith('??'))
      .map(line => line.slice(3).trim());

    if (untrackedFiles.length > 0) {
      log.push(`  ⚠ Warning: ${untrackedFiles.length} untracked files not added to commit`);
      log.push(
        `  Files: ${untrackedFiles.slice(0, 5).join(', ')}${untrackedFiles.length > 5 ? '...' : ''}`
      );
      log.push('  Consider using git add to track these files before next push');
    }

    if (finalChanges.hasChanges) {
      log.push(`  ⚠ Warning: ${finalChanges.files.length} files still uncommitted after push`);
      log.push(`  Files: ${finalChanges.files.slice(0, 5).join(', ')}`);
      return {
        success: false,
        output: log.join('\n'),
        error: 'Push completed but some files remain uncommitted - check git status',
      };
    }

    const branchResult = await execGitArgs(['branch', '--show-current'], cwd);
    if (!branchResult.success || !branchResult.output.trim()) {
      return {
        success: false,
        output: log.join('\n'),
        error: `Push completed but current branch verification failed: ${branchResult.error || 'empty branch'}`,
      };
    }
    const branch = branchResult.output.trim();
    const remoteResult = await execGitArgs(['config', '--get', `branch.${branch}.remote`], cwd);
    if (!remoteResult.success || !remoteResult.output.trim()) {
      return {
        success: false,
        output: log.join('\n'),
        error: `Push completed but upstream remote verification failed: ${remoteResult.error || 'missing branch remote'}`,
      };
    }
    const remote = remoteResult.output.trim();
    const latestCommit = logResult.output.split('\n')[0];

    log.push(`  ✓ Working directory clean`);
    log.push(`  ✓ Pushed branch: ${branch}`);
    log.push(`  ✓ Remote: ${remote}`);
    log.push(`  ✓ Latest commit: ${latestCommit}`);

    return {
      success: true,
      output: log.join('\n'),
    };
  },
  isDestructive: () => true,
  isConcurrencySafe: () => false,
  checkPermissions: args => ({
    behavior: 'ask',
    reason:
      Array.isArray(args.paths) && args.paths.length > 0
        ? `git push will stage ${args.paths.length} explicit path(s), commit, and modify the remote repository`
        : 'git push will modify the remote repository and refuses uncommitted changes without explicit paths',
  }),
  userFacingName: args => `Git Push: ${(args.message as string)?.slice(0, 30)}`,
});

// ============================================================================
// git_commit 工具
// ============================================================================

export const gitCommitTool: OpenHorseTool = buildTool({
  name: 'git_commit',
  description: `提交工作区变更到本地仓库。

工作流程：
1. 检查 git status --porcelain
2. 仅对显式 paths 暂存
3. git commit -m <message>
4. 验证 commit 成功

安全：要求明确 message；拒绝盲目暂存未受控文件。`,
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Commit message（必填）' },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: '要暂存的精确仓库相对文件路径；与 all 互斥',
      },
      all: {
        type: 'boolean',
        description: '已废弃且禁止；必须使用 paths 精确列出文件',
      },
      cwd: { type: 'string', description: '工作目录（可选）' },
    },
    required: ['message'],
  },
  execute: async args => {
    const message = args.message as string;
    const rawPaths = args.paths;
    const all = (args.all as boolean) ?? false;
    const cwd = args.cwd as string | undefined;

    if (!message || typeof message !== 'string') {
      return {
        success: false,
        output: 'git_commit requires a commit message',
        error: 'git_commit requires a commit message',
      };
    }
    if (all) {
      return {
        success: false,
        output: '',
        error: 'git_commit all=true is disabled; provide an explicit paths allowlist',
      };
    }
    if (rawPaths !== undefined && !Array.isArray(rawPaths)) {
      return {
        success: false,
        output: 'git_commit paths must be an array of strings',
        error: 'git_commit paths must be an array of strings',
      };
    }
    const paths = (rawPaths as unknown[] | undefined) ?? [];
    if (paths.some(item => typeof item !== 'string')) {
      return {
        success: false,
        output: 'git_commit paths must contain only strings',
        error: 'git_commit paths must contain only strings',
      };
    }
    const normalized = (paths as string[]).map(normalizeStagePath);
    if (normalized.some(item => item === null)) {
      return {
        success: false,
        output:
          'git_commit paths must be exact repository-relative files without glob or pathspec syntax',
        error:
          'git_commit paths must be exact repository-relative files without glob or pathspec syntax',
      };
    }
    const stagePaths = [...new Set(normalized as string[])];

    const log: string[] = [];
    log.push('🔍 Checking git status...');
    const changes = await checkUncommittedChanges(cwd);
    if (!changes.success) {
      return {
        success: false,
        output: log.join('\n'),
        error: `git status failed: ${changes.error}`,
      };
    }
    if (!changes.hasChanges && stagePaths.length === 0) {
      return { success: true, output: '✓ Working directory clean, nothing to commit' };
    }

    if (stagePaths.length > 0) {
      const initialStagedResult = await execGitArgs(['diff', '--cached', '--name-only', '-z'], cwd);
      if (!initialStagedResult.success) {
        return {
          success: false,
          output: log.join('\n'),
          error: `Initial staged-file verification failed: ${initialStagedResult.error}`,
        };
      }
      const initialStaged = parseStagedPaths(initialStagedResult.output);
      const allowed = new Set(stagePaths);
      const unexpectedInitial = initialStaged.filter(path => !allowed.has(path));
      if (unexpectedInitial.length > 0) {
        return {
          success: false,
          output: log.join('\n'),
          error: `Pre-staged files fall outside the explicit allowlist: ${unexpectedInitial.join(', ')}`,
        };
      }

      const indexSnapshotResult = await execGitArgs(['write-tree'], cwd);
      if (!indexSnapshotResult.success || !/^[0-9a-f]{40,64}$/.test(indexSnapshotResult.output)) {
        return {
          success: false,
          output: log.join('\n'),
          error: `Unable to snapshot the Git index before staging: ${indexSnapshotResult.error || 'invalid tree id'}`,
        };
      }
      const restoreIndex = async (): Promise<string | undefined> => {
        const result = await execGitArgs(['read-tree', indexSnapshotResult.output], cwd);
        return result.success ? undefined : result.error || 'unknown index restore error';
      };

      log.push(`📦 Staging ${stagePaths.length} explicit path(s)...`);
      const addResult = await execGitArgs(['add', '--', ...stagePaths], cwd);
      if (!addResult.success) {
        const restoreError = await restoreIndex();
        return {
          success: false,
          output: log.join('\n'),
          error: restoreError
            ? `git add failed: ${addResult.error}; index rollback failed: ${restoreError}`
            : `git add failed: ${addResult.error}; index restored`,
        };
      }
      const stagedResult = await execGitArgs(['diff', '--cached', '--name-only', '-z'], cwd);
      const staged = stagedResult.success ? parseStagedPaths(stagedResult.output) : [];
      const unexpected = staged.filter(path => !allowed.has(path));
      const missing = stagePaths.filter(path => !staged.includes(path));
      if (!stagedResult.success || unexpected.length > 0 || missing.length > 0) {
        const restoreError = await restoreIndex();
        return {
          success: false,
          output: log.join('\n'),
          error: [
            'Staged files do not exactly match the explicit allowlist',
            unexpected.length > 0 ? `unexpected: ${unexpected.join(', ')}` : '',
            missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
            !stagedResult.success ? `verification failed: ${stagedResult.error}` : '',
            restoreError ? `index rollback failed: ${restoreError}` : 'index restored',
          ]
            .filter(Boolean)
            .join('; '),
        };
      }
      log.push(`  ✓ Verified ${staged.length} staged file(s)`);
      log.push(`  Preview: ${staged.join(', ')}`);

      const commitResult = await execGitArgs(['commit', '-m', message], cwd);
      if (!commitResult.success) {
        if (commitResult.output.includes('nothing to commit')) {
          return { success: true, output: log.join('\n') + '\n  ⚠ Nothing new to commit' };
        }
        const restoreError = await restoreIndex();
        return {
          success: false,
          output: log.join('\n'),
          error: [
            `git commit failed: ${commitResult.error}`,
            restoreError ? `index rollback failed: ${restoreError}` : 'index restored',
          ].join('; '),
        };
      }
      log.push('  ✓ Commit successful');

      const logResult = await execGit('log --oneline -1', cwd);
      if (logResult.success) log.push(`  ✓ Latest commit: ${logResult.output.split('\n')[0]}`);
      return { success: true, output: log.join('\n') };
    } else {
      return {
        success: false,
        output: log.join('\n'),
        error: 'No changes staged: provide an explicit paths allowlist',
      };
    }
  },
  isDestructive: () => true,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({
    behavior: 'ask',
    reason: 'git commit will create a new commit in the local repository',
  }),
  userFacingName: args => `Git Commit: ${(args.message as string)?.slice(0, 30)}`,
});

// ============================================================================
// git_diff 工具
// ============================================================================

export const gitDiffTool: OpenHorseTool = buildTool({
  name: 'git_diff',
  description:
    '显示 Git 差异。默认工作区 vs 暂存区；staged=true 显示已暂存 vs HEAD；可指定 paths。',
  parameters: {
    type: 'object',
    properties: {
      staged: { type: 'boolean', description: '显示已暂存变更（vs HEAD），默认 false' },
      stat: { type: 'boolean', description: '仅显示统计摘要（默认 false）' },
      paths: { type: 'array', items: { type: 'string' }, description: '限定路径（可选）' },
      cwd: { type: 'string', description: '工作目录（可选）' },
    },
    required: [],
  },
  execute: async args => {
    const staged = (args.staged as boolean) ?? false;
    const stat = (args.stat as boolean) ?? false;
    const rawPaths = args.paths;
    const cwd = args.cwd as string | undefined;
    if (rawPaths !== undefined && !Array.isArray(rawPaths)) {
      return { success: false, output: '', error: 'git_diff paths must be an array of strings' };
    }
    const rawPathValues = (rawPaths as unknown[] | undefined) ?? [];
    if (rawPathValues.some(path => typeof path !== 'string')) {
      return { success: false, output: '', error: 'git_diff paths must contain only strings' };
    }
    const normalizedPaths = rawPathValues.map(path => normalizeStagePath(path as string));
    if (normalizedPaths.some(path => path === null)) {
      return {
        success: false,
        output: '',
        error:
          'git_diff paths must be exact repository-relative files without glob or pathspec syntax',
      };
    }
    const paths = [...new Set(normalizedPaths as string[])];

    const cmd = ['diff', '--no-color'];
    if (stat) cmd.push('--stat');
    if (staged) cmd.push('--cached');
    if (paths.length) cmd.push('--', ...paths);

    const result = await execGitArgs(cmd, cwd, 60000);
    if (!result.success) {
      return {
        success: false,
        output: `git diff failed: ${result.error}`,
        error: `git diff failed: ${result.error}`,
      };
    }
    const MAX = 20000;
    const out =
      result.output.length > MAX
        ? `${result.output.slice(0, MAX)}\n… (truncated, ${result.output.length} chars total)`
        : result.output;
    return { success: true, output: out || 'No differences' };
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ behavior: 'allow' }),
  userFacingName: () => 'Git Diff',
});

// ============================================================================
// git_log 工具
// ============================================================================

export const gitLogTool: OpenHorseTool = buildTool({
  name: 'git_log',
  description: '显示提交历史。可指定条数与格式。',
  parameters: {
    type: 'object',
    properties: {
      max_count: { type: 'number', description: '返回的最大提交数（默认 20，上限 200）' },
      oneline: { type: 'boolean', description: '单行精简格式（默认 true）' },
      cwd: { type: 'string', description: '工作目录（可选）' },
    },
    required: [],
  },
  execute: async args => {
    const maxCount =
      typeof args.max_count === 'number' ? Math.min(Math.max(args.max_count, 1), 200) : 20;
    const oneline = (args.oneline as boolean) ?? true;
    const cwd = args.cwd as string | undefined;
    const fmt = oneline ? '%h %s (%an, %ar)' : '%H%nAuthor: %an <%ae>%nDate: %ad%n%n%B';
    const cmd = ['log', `--max-count=${maxCount}`, `--pretty=format:${fmt}`, '--no-color'];
    if (!oneline) cmd.push('--date=iso');

    const result = await execGitArgs(cmd, cwd, 30000);
    if (!result.success) {
      return {
        success: false,
        output: `git log failed: ${result.error}`,
        error: `git log failed: ${result.error}`,
      };
    }
    return { success: true, output: result.output || 'No commits' };
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ behavior: 'allow' }),
  userFacingName: () => 'Git Log',
});

// ============================================================================
// git_branch 工具
// ============================================================================

export const gitBranchTool: OpenHorseTool = buildTool({
  name: 'git_branch',
  description: `分支操作。

action:
- list（默认）: 列出本地分支，标记当前分支（*）与上游跟踪
- create: 基于当前 HEAD 创建新分支（不切换）
- switch: 切换到已有分支
- delete: 删除本地分支（需 force 才允许未合并删除）`,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'create', 'switch', 'delete'],
        description: '操作类型（默认 list）',
      },
      name: { type: 'string', description: '分支名（create/switch/delete 必填）' },
      force: { type: 'boolean', description: 'delete 时允许删除未合并分支（默认 false）' },
      cwd: { type: 'string', description: '工作目录（可选）' },
    },
    required: [],
  },
  execute: async args => {
    const action = (args.action as string) ?? 'list';
    const name = args.name as string | undefined;
    const force = (args.force as boolean) ?? false;
    const cwd = args.cwd as string | undefined;
    const log: string[] = [];

    if (action === 'list') {
      const result = await execGit('branch -vv', cwd);
      if (!result.success) {
        return {
          success: false,
          output: `git branch -vv failed: ${result.error}`,
          error: `git branch -vv failed: ${result.error}`,
        };
      }
      return { success: true, output: result.output || 'No branches' };
    }

    if (!name || typeof name !== 'string') {
      return { success: false, output: '', error: `git_branch ${action} requires a branch name` };
    }
    if (
      name.startsWith('-') ||
      name.includes('\0') ||
      name.includes('\r') ||
      name.includes('\n') ||
      name.includes('..') ||
      name.endsWith('/') ||
      name.endsWith('.')
    ) {
      return { success: false, output: '', error: 'git_branch name is not a safe branch name' };
    }

    if (action === 'create') {
      const result = await execGitArgs(['branch', name], cwd);
      if (!result.success) {
        return {
          success: false,
          output: log.join('\n'),
          error: `git branch create failed: ${result.error}`,
        };
      }
      log.push(`✓ Created branch ${name}`);
      return { success: true, output: log.join('\n') };
    }

    if (action === 'switch') {
      // `git checkout <name>` treats a name that is not a branch as a
      // *pathspec* and overwrites that working-tree file with the index
      // content -- an unrecoverable loss of uncommitted work (no reflog, no
      // stash, no dangling object). A path like `src/index.ts` passes every
      // branch-name check above, so the guard has to be in the argv.
      //
      // `git switch` refuses pathspecs by design. `git checkout <name> --` is
      // the equivalent for git < 2.23, where `switch` does not exist yet.
      let result = await execGitArgs(['switch', name], cwd);
      if (!result.success && /is not a git command|unknown option/i.test(result.error ?? '')) {
        result = await execGitArgs(['checkout', name, '--'], cwd);
      }
      if (!result.success) {
        return {
          success: false,
          output: log.join('\n'),
          error: `git switch failed: ${result.error}`,
        };
      }
      log.push(`✓ Switched to ${name}`);
      return { success: true, output: log.join('\n') };
    }

    if (action === 'delete') {
      const result = await execGitArgs(
        force ? ['branch', '-D', name] : ['branch', '-d', name],
        cwd
      );
      if (!result.success) {
        return {
          success: false,
          output: log.join('\n'),
          error: `git branch delete failed: ${result.error}`,
        };
      }
      log.push(`✓ Deleted branch ${name}`);
      return { success: true, output: log.join('\n') };
    }

    return {
      success: false,
      output: `Unknown git_branch action: ${action}`,
      error: `Unknown git_branch action: ${action}`,
    };
  },
  isReadOnly: args => ((args.action as string | undefined) ?? 'list') === 'list',
  isDestructive: args => ((args.action as string | undefined) ?? 'list') !== 'list',
  isConcurrencySafe: () => false,
  checkPermissions: args => {
    const action = (args.action as string) ?? 'list';
    if (action === 'list') return { behavior: 'allow' };
    const name = typeof args.name === 'string' ? args.name : '<unnamed>';
    // Spell out the consequence per action: "will modify local branch state"
    // told the user nothing about a switch discarding uncommitted work.
    const reason =
      action === 'switch'
        ? `git switch ${name} will change the checked-out branch and update working-tree files`
        : action === 'delete'
          ? `git branch delete will remove the local branch ${name}`
          : `git branch ${action} will modify local branch state`;
    return { behavior: 'ask', reason };
  },
  userFacingName: args => `Git Branch: ${args.action ?? 'list'}`,
});

// ============================================================================
// 导出
// ============================================================================

export const GIT_TOOLS: OpenHorseTool[] = [
  gitStatusTool,
  gitPushTool,
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitBranchTool,
];
