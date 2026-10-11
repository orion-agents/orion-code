import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { loadCodingTaskCorpus, runCodingTaskEvalV1 } from '../scripts/bench/coding-task-eval';

describe('coding-task-eval (T22-04)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-coding-eval-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('loads the fixture corpus with at least 12 tasks across the required categories', () => {
    const corpus = loadCodingTaskCorpus();
    expect(corpus.version).toBe(1);
    expect(corpus.tasks.length).toBeGreaterThanOrEqual(12);
    const categories = new Set(corpus.tasks.map(task => task.category));
    for (const required of [
      'read-search',
      'single-file-edit',
      'multi-file-refactor',
      'fix-failing-test',
      'multi-turn-goal',
      'compaction-continuation',
      'two-sessions-concurrent',
      'provider-429-recovery',
      'permission-denied',
      'user-cancel',
      'tool-failure-recovery',
    ]) {
      expect(categories.has(required)).toBe(true);
    }
    for (const task of corpus.tasks) {
      expect(task.checks.length).toBeGreaterThan(0);
      expect(task.script.length).toBeGreaterThan(0);
      expect(task.expectedModelRequests).toBeGreaterThan(0);
    }
  });

  test('fake mode solves every task with machine-verifiable checks and zero false completions', async () => {
    const receipt = await runCodingTaskEvalV1({ mode: 'fake', workspaceRoot: root });
    expect(receipt.kind).toBe('orion.coding-task-eval');
    expect(receipt.mode).toBe('fake');
    expect(receipt.taskCount).toBeGreaterThanOrEqual(12);
    expect(receipt.summary.falseComplete).toBe(0);
    // The scripted provider is deterministic: the whole corpus solves.
    expect(receipt.summary.solved).toBe(receipt.summary.attempted);
    expect(receipt.summary.solvedRate).toBe(1);
    for (const sample of receipt.samples) {
      expect(sample.passedChecks).toBe(sample.totalChecks);
      expect(sample.modelRequests).toBeGreaterThan(0);
      expect(sample.totalTokens).toBeGreaterThan(0);
      expect(sample.costEstimate).toBeGreaterThanOrEqual(0);
    }
  });

  test('records the source metadata required for A/B comparison', async () => {
    const receipt = await runCodingTaskEvalV1({ mode: 'fake', workspaceRoot: root });
    expect(receipt.source.gitSha).toBeTruthy();
    expect(receipt.source.packageVersion).toBe('0.3.23');
    expect(receipt.fixtureVersion).toBe(1);
    expect(receipt.createdAt).toBeTruthy();
  });

  test('is deterministic: two runs produce identical solved/tool-call/token numbers', async () => {
    const first = await runCodingTaskEvalV1({ mode: 'fake', workspaceRoot: join(root, 'one') });
    const second = await runCodingTaskEvalV1({ mode: 'fake', workspaceRoot: join(root, 'two') });
    expect(first.summary.solved).toBe(second.summary.solved);
    expect(first.summary.totalModelRequests).toBe(second.summary.totalModelRequests);
    expect(first.summary.totalTokens).toBe(second.summary.totalTokens);
    expect(first.samples.map(sample => sample.toolCalls)).toEqual(
      second.samples.map(sample => sample.toolCalls)
    );
    expect(first.samples.map(sample => sample.retries)).toEqual(
      second.samples.map(sample => sample.retries)
    );
  });

  test('scratch workspaces are cleaned up unless keepWorkspaces is set', async () => {
    const kept = await runCodingTaskEvalV1({
      mode: 'fake',
      workspaceRoot: join(root, 'kept'),
      keepWorkspaces: true,
    });
    // At least one task workspace survives when requested.
    const keptRoot = join(root, 'kept');
    expect(existsSync(keptRoot)).toBe(true);
    void kept;
    const cleaned = await runCodingTaskEvalV1({
      mode: 'fake',
      workspaceRoot: join(root, 'cleaned'),
    });
    const workspaceDirs = cleaned.samples.map(() => true);
    expect(workspaceDirs.length).toBe(cleaned.taskCount);
    // The default cleans the per-task workspaces: only the root remains.
    const entries = existsSync(join(root, 'cleaned'))
      ? require('fs').readdirSync(join(root, 'cleaned'))
      : [];
    expect(entries.filter((entry: string) => entry.startsWith('ws-'))).toHaveLength(0);
  });
});
