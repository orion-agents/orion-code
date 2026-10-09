/**
 * v0.3.23 T23-A — Live Coding Eval tests.
 *
 * The production wiring (`-p` CLI driver) is exercised through an INJECTED
 * driver so no real model is ever contacted. Every scenario required by the
 * plan is covered: five-outcome classification, orthogonal falseComplete,
 * workspace isolation, abort, resource release, command_exit_zero, invariant,
 * receipt serialization, A/B comparison, and the fake 12/12 regression.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { evaluateLiveChecks, runLiveTask } from '../scripts/bench/live-task-executor';
import { loadCodingTaskCorpus, runCodingTaskEvalV1 } from '../scripts/bench/coding-task-eval';
import { compareCodingTaskReceiptsV1 } from '../scripts/bench/compare-receipts';
import type { CodingTaskFixtureV1 } from '../scripts/bench/coding-task-eval';
import type { LiveDriverContextV1 } from '../scripts/bench/live-task-executor';

function fixture(): CodingTaskFixtureV1 {
  return {
    id: 'LIVE-01',
    category: 'single-file-edit',
    title: 'bump the version',
    instruction: 'Update version.txt to 2.0.0.',
    repo: { files: { 'version.txt': '1.0.0\n' } },
    script: [],
    checks: [{ kind: 'file_equals', path: 'version.txt', value: '2.0.0\n' }],
    expectedModelRequests: 1,
    estimatedTokensPerRequest: 100,
  };
}

function driverThatWrites(content: string, exitCode = 0, stderr = '') {
  return async (context: LiveDriverContextV1) => {
    writeFileSync(join(context.workspace, 'version.txt'), content);
    return {
      exitCode,
      stdout: 'done',
      stderr,
      durationMs: 5,
      usage: { modelRequests: 2, promptTokens: 120, completionTokens: 40, totalTokens: 160 },
    };
  };
}

describe('LiveTaskExecutor (T23-A)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-live-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('solved: the agent writes the expected file through real tool effects', async () => {
    const { sample } = await runLiveTask(fixture(), { driver: driverThatWrites('2.0.0\n') });
    expect(sample.outcome).toBe('solved');
    expect(sample.solved).toBe(true);
    expect(sample.falseComplete).toBe(false);
    expect(sample.tokenSource).toBe('reported');
    expect(sample.totalTokens).toBe(160);
    expect(sample.passedChecks).toBe(sample.totalChecks);
  });

  test('task_failed + falseComplete: the agent claims success but checks fail', async () => {
    const { sample } = await runLiveTask(fixture(), { driver: driverThatWrites('9.9.9\n') });
    expect(sample.outcome).toBe('task_failed');
    expect(sample.solved).toBe(false);
    expect(sample.falseComplete).toBe(true);
    expect(sample.failureReason).toContain('machine verification failed');
  });

  test('task_failed without falseComplete: the agent exits non-zero without provider signals', async () => {
    const { sample } = await runLiveTask(fixture(), {
      driver: async () => ({ exitCode: 3, stdout: '', stderr: 'boom', durationMs: 1 }),
    });
    expect(sample.outcome).toBe('task_failed');
    expect(sample.falseComplete).toBe(false);
  });

  test('provider_failed: provider signatures in stderr classify the failure', async () => {
    const { sample } = await runLiveTask(fixture(), {
      driver: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'Error: provider returned status 429 rate limit',
        durationMs: 1,
      }),
    });
    expect(sample.outcome).toBe('provider_failed');
  });

  test('timeout: a driver that never finishes classifies as timeout', async () => {
    const { sample } = await runLiveTask(fixture(), {
      timeoutMs: 50,
      driver: async context =>
        new Promise((resolve, reject) => {
          // The driver contract: the driver itself enforces context.timeoutMs.
          const timer = setTimeout(
            () => reject(new Error('live task timed out')),
            context.timeoutMs
          );
          context.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('live task aborted'));
            },
            { once: true }
          );
        }),
    });
    expect(sample.outcome).toBe('timeout');
  });

  test('permission_denied: denial signatures classify the failure', async () => {
    const { sample } = await runLiveTask(fixture(), {
      driver: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'write to /etc/hosts: permission denied',
        durationMs: 1,
      }),
    });
    expect(sample.outcome).toBe('permission_denied');
  });

  test('the unauthorized default driver refuses instead of invoking a real model', async () => {
    const { sample } = await runLiveTask(fixture(), {});
    expect(sample.outcome).toBe('task_failed');
    expect(sample.failureReason).toContain('authorizeLive');
  });

  test('workspace isolation: concurrent tasks get distinct scratch directories', async () => {
    const seen: string[] = [];
    const driver = async (context: LiveDriverContextV1) => {
      seen.push(context.workspace);
      writeFileSync(join(context.workspace, 'version.txt'), '2.0.0\n');
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
    };
    await Promise.all([runLiveTask(fixture(), { driver }), runLiveTask(fixture(), { driver })]);
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
    for (const workspace of seen) {
      expect(workspace).toContain('orion-live-LIVE-01-');
      expect(existsSync(workspace)).toBe(false); // cleaned up
    }
  });

  test('abort: cancelling the signal stops the run and reports a failure reason', async () => {
    const controller = new AbortController();
    const runPromise = runLiveTask(fixture(), {
      signal: controller.signal,
      driver: async context =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
            10_000
          );
          context.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('live task aborted'));
            },
            { once: true }
          );
        }),
    });
    setTimeout(() => controller.abort(), 20);
    const { sample } = await runPromise;
    expect(sample.solved).toBe(false);
    expect(sample.failureReason).toBeTruthy();
  });

  test('resource release: the scratch workspace is removed after the run', async () => {
    const { workspace } = await runLiveTask(fixture(), { driver: driverThatWrites('2.0.0\n') });
    expect(workspace).toBeDefined();
    expect(existsSync(workspace as string)).toBe(false);
  });

  test('command_exit_zero and invariant checks gate success in live mode', async () => {
    const task: CodingTaskFixtureV1 = {
      ...fixture(),
      repo: {
        files: {
          'version.txt': '1.0.0\n',
          'protected.txt': 'do-not-touch\n',
        },
      },
      checks: [
        { kind: 'file_equals', path: 'version.txt', value: '2.0.0\n' },
        { kind: 'command_exit_zero', command: 'node -e "process.exit(0)"' },
        {
          kind: 'invariant',
          protectedFiles: ['protected.txt'],
          forbiddenPaths: ['secret.txt'],
        },
      ],
    };
    const materialize = (versionContent: string, touchProtected = false): string => {
      const dir = mkdtempSync(join(tmpdir(), 'orion-live-checks-'));
      writeFileSync(join(dir, 'version.txt'), versionContent);
      writeFileSync(join(dir, 'protected.txt'), touchProtected ? 'tampered\n' : 'do-not-touch\n');
      return dir;
    };
    try {
      const pass = evaluateLiveChecks(task, materialize('2.0.0\n'));
      expect(pass.solved).toBe(true);
      // A failing command blocks success even when files match.
      const withFailingCommand: CodingTaskFixtureV1 = {
        ...task,
        checks: [
          ...task.checks.slice(0, 1),
          { kind: 'command_exit_zero', command: 'node -e "process.exit(1)"' },
        ],
      };
      const fail = evaluateLiveChecks(withFailingCommand, materialize('2.0.0\n'));
      expect(fail.solved).toBe(false);
      // A modified protected file fails the invariant.
      const tampered = evaluateLiveChecks(task, materialize('2.0.0\n', true));
      expect(tampered.solved).toBe(false);
    } finally {
      for (const dir of []) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('receipts serialize and A/B comparison reports the planned metrics', async () => {
    const solvedReceipt = await runCodingTaskEvalV1({
      mode: 'fake',
      workspaceRoot: join(root, 'solved'),
    });
    // Build a "candidate" from one live sample to exercise serialization.
    const { sample } = await runLiveTask(fixture(), { driver: driverThatWrites('2.0.0\n') });
    const liveReceipt = {
      ...solvedReceipt,
      mode: 'live' as const,
      createdAt: new Date().toISOString(),
      samples: [
        {
          sampleId: sample.sampleId,
          taskId: sample.taskId,
          category: sample.category,
          mode: 'live' as const,
          outcome: sample.outcome,
          solved: sample.solved,
          falseComplete: sample.falseComplete,
          regression: false,
          modelRequests: sample.modelRequests,
          totalTokens: sample.totalTokens,
          toolCalls: sample.toolCalls,
          latencyMs: sample.latencyMs,
          retries: sample.retries,
          costEstimate: sample.costEstimate,
          passedChecks: sample.passedChecks,
          totalChecks: sample.totalChecks,
        },
      ],
      summary: {
        ...solvedReceipt.summary,
        solved: sample.solved ? 1 : 0,
        attempted: 1,
        solvedRate: sample.solved ? 1 : 0,
      },
    };
    const roundTrip = JSON.parse(JSON.stringify(liveReceipt)) as typeof liveReceipt;
    expect(roundTrip.samples[0].outcome).toBe('solved');
    const comparison = compareCodingTaskReceiptsV1(solvedReceipt, roundTrip);
    expect(comparison.kind).toBe('orion.coding-task-eval-comparison');
    expect(comparison.rows.map(row => row.metric)).toEqual(
      expect.arrayContaining([
        'solvedRate',
        'falseCompletionRate',
        'tokensPerSolvedTask',
        'modelRequestsPerTask',
        'latencyP50Ms',
        'latencyP95Ms',
        'costPerSolvedTask',
      ])
    );
    expect(comparison.raw.candidate).toHaveLength(1);
    expect(comparison.verdict.solvedRateNotDropped).toBe(true);
  });

  test('fake eval regression: 12/12 solved, zero false completions (unchanged)', async () => {
    const receipt = await runCodingTaskEvalV1({ mode: 'fake', workspaceRoot: join(root, 'fake') });
    expect(receipt.summary.solved).toBe(12);
    expect(receipt.summary.falseComplete).toBe(0);
  });

  test('the unauthorized live mode surfaces the authorization requirement', async () => {
    const receipt = await runCodingTaskEvalV1({ mode: 'live', workspaceRoot: join(root, 'live') });
    // Every sample fails with the authorization message; no model was invoked.
    expect(receipt.samples.every(item => item.solved === false)).toBe(true);
    expect(
      receipt.samples.every(item => item.failureReason?.includes('authorizeLive') ?? false)
    ).toBe(true);
  });
});
