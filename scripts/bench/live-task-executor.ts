/**
 * v0.3.23 T23-A — LiveTaskExecutor: run a coding-task fixture through the
 * PRODUCTION Orion runtime (the non-interactive `-p` entry:
 * cli.ts → createProductUiRuntime → OrionSessionRunnerV1 → product-orion-runtime
 * → ThreadRuntime → AgentLoop → Query → ToolGateway) inside an isolated
 * scratch workspace.
 *
 * Hard rules enforced here:
 *  - The executor never writes the expected answers: only the agent's real
 *    tool calls may modify the workspace.
 *  - Success is decided exclusively by machine-verifiable checks run after
 *    the agent finishes (file checks + command_exit_zero + invariant).
 *  - Model-claimed success (exit code 0) with failing checks records
 *    `task_failed` with the orthogonal `falseComplete: true`.
 *  - Real model runs cost money: the default driver requires
 *    `authorizeLive: true`, otherwise it refuses. Tests inject a driver.
 */
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import {
  evaluateFileCheck,
  type CodingTaskCheckV1,
  type CodingTaskFixtureV1,
} from './coding-task-eval';

export type LiveTaskOutcome =
  | 'solved'
  | 'task_failed'
  | 'provider_failed'
  | 'timeout'
  | 'permission_denied';

export interface LiveDriverContextV1 {
  readonly workspace: string;
  readonly instruction: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface LiveDriverResultV1 {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** Real usage reported by the runtime, when the provider supplies it. */
  readonly usage?: {
    readonly modelRequests: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export type LiveTaskDriverV1 = (context: LiveDriverContextV1) => Promise<LiveDriverResultV1>;

export interface LiveTaskOptionsV1 {
  /** Must be true for the default CLI driver (real model cost). */
  readonly authorizeLive?: boolean;
  /** Node executable used by the default driver. */
  readonly nodePath?: string;
  /** Orion CLI entry (dist/cli.js) used by the default driver. */
  readonly cliPath?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly keepWorkspace?: boolean;
  /** Injectable driver: tests never use the real model path. */
  readonly driver?: LiveTaskDriverV1;
  readonly signal?: AbortSignal;
  /** Cost per 1k tokens for costEstimate (reporting only). */
  readonly costPerThousandTokens?: number;
  readonly sampleId?: string;
}

export interface LiveTaskSampleV1 {
  readonly sampleId: string;
  readonly taskId: string;
  readonly category: string;
  readonly mode: 'live';
  readonly outcome: LiveTaskOutcome;
  readonly solved: boolean;
  /** The agent claimed completion (exit 0) while machine verification failed. */
  readonly falseComplete: boolean;
  readonly modelRequests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly tokenSource: 'reported' | 'unavailable';
  readonly toolCalls: number;
  readonly retries: number;
  readonly latencyMs: number;
  readonly costEstimate: number;
  readonly provider: string;
  readonly model: string;
  readonly failureReason?: string;
  readonly passedChecks: number;
  readonly totalChecks: number;
}

const PERMISSION_SIGNATURES = [
  'permission denied',
  'denied by policy',
  'not permitted',
  'approval rejected',
  'eacces',
  'eperm',
];

const PROVIDER_SIGNATURES = [
  'provider',
  'api key',
  'apikey',
  'unauthorized',
  'rate limit',
  'status 4',
  'status 5',
  'econnrefused',
  'enotfound',
  'fetch failed',
];

function classifyFailure(
  result: LiveDriverResultV1 | undefined,
  reason: string
): {
  outcome: LiveTaskOutcome;
  failureReason: string;
} {
  const combined = result
    ? `${result.stderr}\n${result.stdout}`.toLowerCase()
    : reason.toLowerCase();
  if (PERMISSION_SIGNATURES.some(signature => combined.includes(signature))) {
    return { outcome: 'permission_denied', failureReason: reason };
  }
  if (PROVIDER_SIGNATURES.some(signature => combined.includes(signature))) {
    return { outcome: 'provider_failed', failureReason: reason };
  }
  return { outcome: 'task_failed', failureReason: reason };
}

/** Default driver: the production non-interactive CLI (`orion -p --output-format json`). */
export function createCliLiveDriver(options: {
  nodePath?: string;
  cliPath?: string;
  model?: string;
}): LiveTaskDriverV1 {
  const nodePath = options.nodePath ?? process.execPath;
  const cliPath = options.cliPath ?? resolve(__dirname, '..', '..', 'dist', 'cli.js');
  return async context => {
    const startedAt = Date.now();
    const args = [cliPath, '-p', context.instruction, '--output-format', 'json'];
    if (options.model) args.push('--model', options.model);
    return await new Promise<LiveDriverResultV1>((resolvePromise, rejectPromise) => {
      const child = spawn(nodePath, args, {
        cwd: context.workspace,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context.signal.removeEventListener('abort', onAbort);
        action();
      };
      const timer = setTimeout(() => {
        finish(() => {
          child.kill('SIGKILL');
          rejectPromise(new Error('live task timed out'));
        });
      }, context.timeoutMs);
      const onAbort = (): void => {
        finish(() => {
          child.kill('SIGKILL');
          rejectPromise(new Error('live task aborted'));
        });
      };
      context.signal.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', chunk => {
        stdout += String(chunk);
      });
      child.stderr.on('data', chunk => {
        stderr += String(chunk);
      });
      child.on('error', error => {
        finish(() => rejectPromise(error));
      });
      child.on('close', code => {
        finish(() => {
          let usage: LiveDriverResultV1['usage'];
          try {
            const parsed = JSON.parse(stdout) as {
              usage?: {
                modelRequests?: number;
                promptTokens?: number;
                completionTokens?: number;
                totalTokens?: number;
              };
            };
            if (parsed.usage && typeof parsed.usage.totalTokens === 'number') {
              usage = {
                modelRequests: parsed.usage.modelRequests ?? 0,
                promptTokens: parsed.usage.promptTokens ?? 0,
                completionTokens: parsed.usage.completionTokens ?? 0,
                totalTokens: parsed.usage.totalTokens,
              };
            }
          } catch {
            // Non-JSON output: usage stays undefined (tokenSource 'unavailable').
          }
          resolvePromise({
            exitCode: code,
            stdout,
            stderr,
            durationMs: Math.max(0, Date.now() - startedAt),
            ...(usage ? { usage } : {}),
          });
        });
      });
    });
  };
}

/** Run one fixture through the live executor. Never writes expected answers. */
export async function runLiveTask(
  task: CodingTaskFixtureV1,
  options: LiveTaskOptionsV1 = {}
): Promise<{ sample: LiveTaskSampleV1; workspace: string | undefined }> {
  const timeoutMs = options.timeoutMs ?? 600_000;
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspace = mkdtempSync(join(tmpdir(), `orion-live-${task.id}-`));
  const driver: LiveTaskDriverV1 =
    options.driver ??
    (options.authorizeLive === true
      ? createCliLiveDriver({
          nodePath: options.nodePath,
          cliPath: options.cliPath,
          model: options.model,
        })
      : async () => {
          throw new Error(
            'live evaluation requires explicit authorization (authorizeLive: true) because the default driver invokes the real model'
          );
        });
  try {
    // Materialize the fixture repo; the agent may only change these files via
    // its real tool calls.
    for (const [relative, content] of Object.entries(task.repo.files)) {
      const target = join(workspace, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const signal = options.signal ?? new AbortController().signal;
    let result: LiveDriverResultV1 | undefined;
    let runError: string | undefined;
    let timedOut = false;
    const startedAt = Date.now();
    try {
      result = await driver({ workspace, instruction: task.instruction, signal, timeoutMs });
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
      if (/timed out/.test(runError)) timedOut = true;
    }
    const latencyMs = Math.max(0, Date.now() - startedAt);

    const checks = evaluateLiveChecks(task, workspace);
    let outcome: LiveTaskOutcome;
    let failureReason: string | undefined;
    if (timedOut) {
      outcome = 'timeout';
      failureReason = `live task exceeded ${timeoutMs}ms`;
    } else if (!result) {
      const classified = classifyFailure(undefined, runError ?? 'driver failed');
      outcome = classified.outcome;
      failureReason = classified.failureReason;
    } else if (result.exitCode !== 0) {
      const classified = classifyFailure(
        result,
        `agent exited with code ${result.exitCode}: ${(result.stderr || result.stdout).slice(0, 200)}`
      );
      outcome = classified.outcome;
      failureReason = classified.failureReason;
    } else if (checks.solved) {
      outcome = 'solved';
    } else {
      // The agent claimed completion (exit 0) but the machine checks failed.
      outcome = 'task_failed';
      failureReason = 'machine verification failed after agent completion';
    }
    const solved = outcome === 'solved';
    const falseComplete = !solved && result?.exitCode === 0;
    const usage = result?.usage;
    const costPerThousandTokens = options.costPerThousandTokens ?? 0.5;
    const totalTokens = usage?.totalTokens ?? 0;
    return {
      sample: {
        sampleId: options.sampleId ?? `coding-live-${task.id}-${runId}`,
        taskId: task.id,
        category: task.category,
        mode: 'live',
        outcome,
        solved,
        falseComplete,
        modelRequests: usage?.modelRequests ?? 0,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens,
        tokenSource: usage ? 'reported' : 'unavailable',
        toolCalls: 0,
        retries: 0,
        latencyMs,
        costEstimate:
          Math.round(((totalTokens / 1000) * costPerThousandTokens + Number.EPSILON) * 100) / 100,
        provider: 'orion-runtime',
        model: options.model ?? 'configured-via-orion-config',
        ...(failureReason && !solved ? { failureReason } : {}),
        passedChecks: checks.passed,
        totalChecks: task.checks.length,
      },
      workspace,
    };
  } finally {
    if (!options.keepWorkspace) rmSync(workspace, { recursive: true, force: true });
  }
}

/** Live-mode check evaluation: file checks reuse the fake-mode semantics. */
export function evaluateLiveChecks(
  task: CodingTaskFixtureV1,
  workspace: string
): { solved: boolean; passed: number } {
  let passed = 0;
  for (const check of task.checks) {
    if (evaluateOneLiveCheck(check, workspace, task)) passed += 1;
  }
  return { solved: passed === task.checks.length, passed };
}

function evaluateOneLiveCheck(
  check: CodingTaskCheckV1,
  workspace: string,
  task: CodingTaskFixtureV1
): boolean {
  if (check.kind === 'command_exit_zero') {
    const result = spawnSync(check.command ?? 'true', {
      cwd: workspace,
      encoding: 'utf8',
      shell: true,
      timeout: 60_000,
    });
    return result.status === 0;
  }
  if (check.kind === 'invariant') {
    for (const relative of check.protectedFiles ?? []) {
      const target = join(workspace, relative);
      const original = task.repo.files[relative];
      if (!existsSync(target)) return false;
      if (original !== undefined && readFileSync(target, 'utf8') !== original) return false;
    }
    for (const relative of check.forbiddenPaths ?? []) {
      if (existsSync(join(workspace, relative))) return false;
    }
    return true;
  }
  return evaluateFileCheck(check, workspace);
}
