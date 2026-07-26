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

// ============================================================================
// 辅助函数
// ============================================================================

interface ExecResult {
  success: boolean;
  output: string;
  error?: string;
}

async function execGit(command: string, cwd?: string, timeout = 30000): Promise<ExecResult> {
  return execGitArgs(command.split(' '), cwd, timeout);
}

async function execGitArgs(args: string[], cwd?: string, timeout = 30000): Promise<ExecResult> {
  return new Promise((resolve) => {
    const workdir = cwd || process.cwd();

    execFile('git', args, {
      cwd: workdir,
      timeout,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const output = stdout.toString().trim();
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
          output: output || '(no output)',
          error: errOutput || undefined,
        });
      }
    });
  });
}

/**
 * 检查是否有未暂存/未提交的文件
 */
async function checkUncommittedChanges(cwd?: string): Promise<{ hasChanges: boolean; files: string[] }> {
  const statusResult = await execGit('status --porcelain', cwd);

  if (!statusResult.success) {
    return { hasChanges: false, files: [] };
  }

  const files = statusResult.output
    .split('\n')
    .filter(line => line.trim())
    .map(line => line.slice(3).trim());  // 去除状态码

  return { hasChanges: files.length > 0, files };
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

  if (lsRemoteResult.output.includes('Authentication failed') ||
      lsRemoteResult.output.includes('Permission denied') ||
      lsRemoteResult.output.includes('could not read Username') ||
      lsRemoteResult.output.includes('fatal: could not read Password')) {
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
  execute: async (args) => {
    const cwd = args.cwd as string | undefined;

    // git status --porcelain
    const statusResult = await execGit('status --porcelain', cwd);
    if (!statusResult.success) {
      return { success: false, output: '', error: `git status failed: ${statusResult.error}` };
    }

    // 解析状态
    const lines = statusResult.output.split('\n').filter(l => l.trim());

    const untracked: string[] = [];
    const modified: string[] = [];
    const staged: string[] = [];

    for (const line of lines) {
      const code = line.slice(0, 2);
      const file = line.slice(3).trim();

      if (code === '??') {
        untracked.push(file);
      } else if (code.includes('M') || code.includes('A') || code.includes('D')) {
        if (code[0] !== ' ' && code[0] !== '?') {
          staged.push(file);  // 已暂存
        }
        if (code[1] !== ' ') {
          modified.push(file);  // 工作区修改但未暂存
        }
      }
    }

    const summary = {
      clean: lines.length === 0,
      untracked,
      modified,
      staged,
      total: lines.length,
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
  description: `安全执行 git push，自动验证 git status 和认证状态。

工作流程：
1. 检查 git status --porcelain（未暂存/未提交的文件）
2. 可选自动 git add -A 添加所有变更
3. git commit（如果需要）
4. 检查远程认证状态
5. git push
6. 验证 push 成功

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
        description: '是否自动 git add -A（默认 true）',
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
  execute: async (args) => {
    const message = args.message as string;
    const addAll = (args.add_all as boolean) ?? true;
    const cwd = args.cwd as string | undefined;
    const verify = (args.verify as boolean) ?? true;

    if (!message || typeof message !== 'string') {
      return { success: false, output: '', error: 'git_push requires a commit message' };
    }

    const log: string[] = [];

    // 1. 检查当前状态
    log.push('🔍 Checking git status...');
    const changes = await checkUncommittedChanges(cwd);

    if (changes.hasChanges) {
      log.push(`  Found ${changes.files.length} uncommitted files: ${changes.files.slice(0, 5).join(', ')}${changes.files.length > 5 ? '...' : ''}`);

      // 2. git add（如果启用）
      if (addAll) {
        log.push('📦 Running git add -A...');
        const addResult = await execGit('add -A', cwd);
        if (!addResult.success) {
          return { success: false, output: log.join('\n'), error: `git add failed: ${addResult.error}` };
        }
        log.push('  ✓ Files added to staging');
      } else {
        log.push('  ⚠ add_all=false, skipping git add');
      }

      // 3. git commit
      log.push(`📝 Committing with message: "${message.slice(0, 50)}..."`);
      const commitResult = await execGitArgs(['commit', '-m', message], cwd);
      if (!commitResult.success) {
        // 可能是 "nothing to commit"
        if (commitResult.output.includes('nothing to commit')) {
          log.push('  ⚠ Nothing new to commit');
        } else {
          return { success: false, output: log.join('\n'), error: `git commit failed: ${commitResult.error}` };
        }
      } else {
        log.push('  ✓ Commit successful');
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
          error: auth.error || 'Remote authentication failed - please configure git credentials'
        };
      }
      log.push('  ✓ Authentication verified');
    }

    // 5. git push
    log.push('🚀 Pushing to remote...');
    const pushResult = await execGit('push', cwd, 60000);  // 60s timeout

    if (!pushResult.success) {
      return { success: false, output: log.join('\n'), error: `git push failed: ${pushResult.error}` };
    }
    log.push('  ✓ Push completed');

    // 6. 验证最终状态（v0.1.11 增强）
    log.push('✅ Verifying final status...');
    const finalChanges = await checkUncommittedChanges(cwd);
    const logResult = await execGit('log --oneline -1', cwd);
    const untrackedResult = await execGit('status --short', cwd);

    // v0.1.11: 检查是否有未追踪文件（?? 状态）
    const untrackedFiles = untrackedResult.output
      .split('\n')
      .filter(line => line.startsWith('??'))
      .map(line => line.slice(3).trim());

    if (untrackedFiles.length > 0) {
      log.push(`  ⚠ Warning: ${untrackedFiles.length} untracked files not added to commit`);
      log.push(`  Files: ${untrackedFiles.slice(0, 5).join(', ')}${untrackedFiles.length > 5 ? '...' : ''}`);
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

    log.push(`  ✓ Working directory clean`);
    log.push(`  ✓ Latest commit: ${logResult.output.split('\n')[0]}`);

    return {
      success: true,
      output: log.join('\n'),
    };
  },
  isDestructive: () => true,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ behavior: 'ask', reason: 'git push modifies remote repository' }),
  userFacingName: (args) => `Git Push: ${(args.message as string)?.slice(0, 30)}`,
});

// ============================================================================
// 导出
// ============================================================================

export const GIT_TOOLS: OpenHorseTool[] = [gitStatusTool, gitPushTool];
