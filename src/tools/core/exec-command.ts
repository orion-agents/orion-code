import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { isAbsolute, resolve } from 'path';

import { buildTool, type ToolResult } from '../../framework/tool';
import { coreToolDescriptorV1 } from '../../runtime/core-tools/descriptors';
import { assessCommandSecurity, containsRecursiveRm, isReadOnlyCommand } from '../bash_security';
import {
  describeSandboxPlan,
  planSandboxedCommand,
  resolveSandboxSettings,
  type SandboxConfig,
} from '../sandbox';
import {
  compactOneLine,
  isExecCwdWithinWorkspace,
  normalizeToolPath,
  safePath,
  summarizeFailedToolResult,
  truncateToBytes,
  validateOptionalSafeInteger,
} from './common';

const EXEC_COMMAND_MIN_TIMEOUT_MS = 1;
const EXEC_COMMAND_MAX_TIMEOUT_MS = 600_000;
const EXEC_COMMAND_MIN_OUTPUT_BYTES = 1024;
const EXEC_COMMAND_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

const descriptor = coreToolDescriptorV1('exec_command');

export const coreTool = buildTool({
  name: descriptor.name,
  aliases: [...descriptor.aliases],
  description: descriptor.description,
  parameters: structuredClone(descriptor.parameters),
  execute: async (args, context) => {
    // Ensure command is a valid string
    const command = args.command;
    if (!command || typeof command !== 'string') {
      return { success: false, output: '', error: 'exec_command requires a command parameter' };
    }
    // Issue #32 #3.2: 传递 abortSignal
    return execCommand_(
      command,
      args.cwd as string | undefined,
      args.timeout as number | undefined,
      args.maxOutput as number | undefined,
      context.abortSignal,
      context.cwd
    );
  },
  validateInput: args =>
    validateOptionalSafeInteger(
      args,
      'exec_command',
      'timeout',
      EXEC_COMMAND_MIN_TIMEOUT_MS,
      EXEC_COMMAND_MAX_TIMEOUT_MS
    ) ??
    validateOptionalSafeInteger(
      args,
      'exec_command',
      'maxOutput',
      EXEC_COMMAND_MIN_OUTPUT_BYTES,
      EXEC_COMMAND_MAX_OUTPUT_BYTES
    ),
  isDestructive: args => {
    const cmd = (args.command as string) || '';
    return containsRecursiveRm(cmd) || /(?:^|[;&|]\s*)(?:[^\s]+\/)?(?:mkfs|dd)(?:\s|$)/.test(cmd);
  },
  checkPermissions: (args, context) => {
    const cmd = (args.command as string) || '';

    // Use the bash_security module for comprehensive checks
    const security = assessCommandSecurity(cmd);

    if (security.level === 'blocked') {
      return {
        behavior: 'deny',
        reason: security.reason || `Command blocked by safety policy: ${cmd.slice(0, 50)}`,
      };
    }

    // v0.1.3-2 §1.2: a configured-but-unusable sandbox is a hard deny, decided
    // here so the user sees the reason instead of an opaque execution failure.
    let paths: { workdir: string; projectRoot: string };
    try {
      paths = resolveExecCommandPaths(args.cwd as string | undefined, context?.cwd);
    } catch (error) {
      return {
        behavior: 'deny',
        reason: error instanceof Error ? error.message : 'exec_command cwd is outside workspace',
      };
    }
    const { workdir, projectRoot } = paths;
    const sandboxSettings = resolveSandboxSettings(projectRoot);
    let sandboxNote = '';
    if ((sandboxSettings.profile ?? 'none') !== 'none') {
      const plan = planSandboxedCommand(cmd, {
        cwd: workdir,
        projectRoot,
        settings: sandboxSettings,
      });
      if (!plan.ok) {
        return {
          behavior: 'deny',
          reason: `sandbox profile "${plan.profile}" is configured but cannot be applied — ${plan.reason}`,
        };
      }
      sandboxNote = ` [${describeSandboxPlan(plan)}]`;
    }

    if (security.level === 'safe' && security.isReadOnly) {
      return { behavior: 'allow' };
    }

    if (security.level === 'caution') {
      return {
        behavior: 'ask',
        reason: (security.reason || 'Command requires confirmation') + sandboxNote,
      };
    }

    // Default: ask for confirmation
    return { behavior: 'ask', reason: 'Command requires confirmation' + sandboxNote };
  },
  isReadOnly: args => {
    const cmd = (args.command as string) || '';
    return isReadOnlyCommand(cmd);
  },
  isConcurrencySafe: args => {
    const cmd = (args.command as string) || '';
    return isReadOnlyCommand(cmd);
  },
  userFacingName: args => `Exec ${compactOneLine((args.command as string) || '', 80)}`,
  getSummary: (args, result) => {
    const command = (args.command as string) || '';
    const commandSummary = command ? `\n  $ ${compactOneLine(command, 160)}` : '';
    if (!result.success) {
      const detail = summarizeFailedToolResult(result);
      return `🔧 exec → error${detail ? ` (${detail})` : ''}${commandSummary}`;
    }
    const bytes = Buffer.byteLength(result.output, 'utf8');
    return `🔧 exec (${bytes}B output)${commandSummary}`;
  },
});

// Issue #32 #3.2: execCommand_ 支持 abortSignal
function resolveExecCommandPaths(
  cwd?: string,
  baseCwd?: string
): { workdir: string; projectRoot: string } {
  const projectRoot = resolve(baseCwd ?? process.cwd());
  if (!cwd) return { workdir: projectRoot, projectRoot };

  const normalizedCwd = normalizeToolPath(cwd);
  if (isAbsolute(normalizedCwd)) {
    throw new Error('exec_command cwd must be a workspace-relative path');
  }
  const workdir = safePath(normalizedCwd, projectRoot);
  if (!isExecCwdWithinWorkspace(workdir, projectRoot)) {
    throw new Error('exec_command cwd must stay within the workspace');
  }
  return {
    workdir,
    projectRoot,
  };
}

async function execCommand_(
  command: string,
  cwd?: string,
  timeout?: number,
  maxOutput?: number,
  abortSignal?: AbortSignal,
  baseCwd?: string,
  sandbox?: SandboxConfig
): Promise<ToolResult> {
  let paths: { workdir: string; projectRoot: string };
  try {
    paths = resolveExecCommandPaths(cwd, baseCwd);
  } catch (error) {
    return {
      success: false,
      output: '',
      error: error instanceof Error ? error.message : 'exec_command cwd is outside workspace',
    };
  }
  const { workdir, projectRoot } = paths;

  // v0.1.3-2 §1.2: plan the (possibly sandboxed) argv before spawning. A
  // configured sandbox that cannot be honoured must refuse the command rather
  // than silently degrade into an unsandboxed run.
  const plan = planSandboxedCommand(command, {
    cwd: workdir,
    projectRoot,
    settings: sandbox ?? resolveSandboxSettings(projectRoot),
  });
  if (!plan.ok) {
    return {
      success: false,
      output: '',
      error:
        `Refusing to run: sandbox profile "${plan.profile}" is configured but cannot be applied — ${plan.reason}. ` +
        'Set sandbox.profile to "none" to run without isolation.',
    };
  }

  return new Promise(resolve => {
    const timeoutMs = timeout ?? 30000;
    const maxBytes = maxOutput ?? 51200; // Default 50KB, Issue #28 fix

    // The docker backend bind-mounts `workdir` into the container; the host
    // directory must exist at container-creation time or the mount fails with a
    // confusing "nonexistent directory" error. Create it deterministically
    // rather than relying on docker to materialise it.
    if (plan.backend === 'docker') {
      try {
        mkdirSync(workdir, { recursive: true });
      } catch {
        // If it cannot be created we let the spawn fail with a clear error.
      }
    }

    // Use spawn for streaming output with truncation support. The user command
    // is a single argv element, so no intermediate shell re-parses it.
    const useProcessGroup = process.platform !== 'win32';
    const child = spawn(plan.file, plan.args, {
      cwd: workdir,
      detached: useProcessGroup,
    });

    // Issue #53: exec_command runs a complete command as a single argv element
    // and never pipes input into it. If stdin stays open, stdin-reading commands
    // (cat, sort, grep, `python3 -`, ...) block waiting for EOF until the timeout.
    // Close it immediately so the child receives EOF and can proceed.
    child.stdin?.end();

    let stdoutData = '';
    let stderrData = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    // Issue #32 修复：使用独立计数器
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let interrupted: 'aborted' | 'timeout' | null = null;

    // Issue #32 #3.2: AbortSignal 处理
    // Declared uninitialized on purpose: `finish()` below closes over it before the
    // `timeoutId = setTimeout(...)` assignment. `const` without an initializer is a
    // compile error (TS1155), and inlining the assignment would put it in the closure's TDZ.
    // eslint-disable-next-line prefer-const
    let timeoutId: NodeJS.Timeout | undefined;
    let killTimerId: NodeJS.Timeout | undefined;
    let settled = false;

    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (killTimerId) clearTimeout(killTimerId);
      if (abortSignal) {
        abortSignal.removeEventListener('abort', abortHandler);
      }
      resolve(result);
    };

    const terminateChild = () => {
      if (!child.pid || child.killed) return;
      try {
        if (useProcessGroup) {
          process.kill(-child.pid, 'SIGTERM');
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        child.kill('SIGTERM');
      }

      killTimerId = setTimeout(() => {
        if (!child.pid || child.killed || settled) return;
        try {
          if (useProcessGroup) {
            process.kill(-child.pid, 'SIGKILL');
          } else {
            child.kill('SIGKILL');
          }
        } catch {
          child.kill('SIGKILL');
        }
      }, 500);
      killTimerId.unref?.();
    };

    const abortHandler = () => {
      interrupted = 'aborted';
      terminateChild();
    };

    if (abortSignal) {
      abortSignal.addEventListener('abort', abortHandler);
      if (abortSignal.aborted) {
        abortHandler();
      }
    }

    // Timeout handling
    timeoutId = setTimeout(() => {
      if (!interrupted) {
        interrupted = 'timeout';
        terminateChild();
      }
    }, timeoutMs);

    // Stream stdout with truncation
    child.stdout.on('data', (data: Buffer) => {
      if (!stdoutTruncated) {
        const chunk = data.toString();
        // Issue #30: count UTF-8 bytes, not UTF-16 code units, so CJK/emoji
        // output is bounded by `maxBytes` (a UTF-16 count could exceed it ~2x).
        const chunkBytes = Buffer.byteLength(chunk, 'utf8');
        if (stdoutBytes + chunkBytes > maxBytes) {
          stdoutTruncated = true;
          const room = Math.max(0, maxBytes - stdoutBytes);
          // Byte-accurate truncation that respects multi-byte character boundaries.
          stdoutData += truncateToBytes(chunk, room).text;
          stdoutBytes = maxBytes;
        } else {
          stdoutData += chunk;
          stdoutBytes += chunkBytes;
        }
      }
    });

    // Stream stderr with truncation (Issue #32 修复：使用独立计数器)
    child.stderr.on('data', (data: Buffer) => {
      if (!stderrTruncated) {
        const chunk = data.toString();
        // Issue #30: count UTF-8 bytes, not UTF-16 code units.
        const chunkBytes = Buffer.byteLength(chunk, 'utf8');
        if (stderrBytes + chunkBytes > maxBytes) {
          stderrTruncated = true;
          const room = Math.max(0, maxBytes - stderrBytes);
          stderrData += truncateToBytes(chunk, room).text;
          stderrBytes = maxBytes;
        } else {
          stderrData += chunk;
          stderrBytes += chunkBytes;
        }
      }
    });

    child.on('close', code => {
      if (interrupted === 'aborted') {
        finish({
          success: false,
          output: truncateToBytes(stdoutData, maxBytes).text,
          error: 'Command aborted by user',
        });
        return;
      }

      if (interrupted === 'timeout') {
        finish({
          success: false,
          output: truncateToBytes(stdoutData, maxBytes).text,
          error: `Command timed out after ${timeoutMs}ms`,
        });
        return;
      }

      const output = stdoutData.trim();
      const errOutput = stderrData.trim();

      // Add truncation notice if output was truncated
      let finalOutput = output;
      if (stdoutTruncated) {
        finalOutput += '\n\n[... output truncated, exceeded 50KB limit]';
      }

      if (code !== 0) {
        finish({
          success: false,
          output: finalOutput || errOutput,
          error: `Command exited with code ${code}`,
        });
      } else {
        finish({
          success: true,
          output: finalOutput || '(no output)',
          error: stderrTruncated
            ? errOutput + '\n\n[... stderr truncated]'
            : errOutput || undefined,
        });
      }
    });

    child.on('error', err => {
      finish({
        success: false,
        output: '',
        error: err.message,
      });
    });
  });
}
