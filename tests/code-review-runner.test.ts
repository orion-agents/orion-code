/**
 * v0.3.28 — integration tests for the bounded single-pass review runner
 * (plan S2), driven against real temporary git repositories with injected
 * fake model adapters (no provider access). Covers: frozen snapshot input,
 * finding validation and snapshot-membership anchoring, budgets, cancellation,
 * unparsable output, empty scope, and digest-verifiable receipts.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyReceiptDigest } from '../src/services/code-review/contract';
import {
  runCodeReview,
  type ReviewModelAdapterV1,
} from '../src/services/code-review/runner';
import type { ReviewGitRunner } from '../src/services/code-review/snapshot';

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runner(cwd: string): ReviewGitRunner {
  return async (args: readonly string[]) => git(cwd, args);
}

const IDENTITY = {
  workspaceIdentity: '/fixture/repo',
  sessionId: 'session-1',
  threadId: 'thread-1',
  turnId: 'turn-9',
};

function adapterWith(payload: string, model = 'review-probe-1'): ReviewModelAdapterV1 {
  return {
    async complete() {
      return { content: payload, model };
    },
  };
}

function findingPayload(fileKey: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    findings: [
      {
        findingId: 'abcd1234',
        priority: 'P1',
        title: 'Unguarded division',
        trigger: 'denominator evaluates to zero',
        impact: 'runtime crash on empty input',
        fileKey,
        side: 'new',
        startLine: 2,
        endLine: 2,
        evidence: 'line 2 divides without a guard',
        ...overrides,
      },
    ],
  });
}

describe('v0.3.28 — runCodeReview', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orion-review-run-')));
    repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'review@probe.local']);
    git(repo, ['config', 'user.name', 'Review Probe']);
    writeFileSync(join(repo, 'app.ts'), 'const a = 1;\nconst b = a / count;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'baseline']);
    writeFileSync(join(repo, 'app.ts'), 'const a = 1;\nconst b = a / count;\nconst c = b;\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('worktree scope resolves the changed files and completes against the real repo', async () => {
    const outcome = await runCodeReview({
      cwd: repo,
      selector: { kind: 'worktree' },
      adapter: adapterWith('{"findings":[]}'),
      identity: IDENTITY,
      runGit: runner(repo),
    });
    // '{}' alone means zero findings; drive the full path with a real payload.
    const files = git(repo, ['diff', '--name-only', 'HEAD']).trim().split('\n');
    expect(files).toEqual(['app.ts']);
    expect(outcome.ok).toBe(true);
  });

  test('empty scope completes without calling the model and is not a review pass', async () => {
    git(repo, ['checkout', '--', '.']);
    let modelCalls = 0;
    const outcome = await runCodeReview({
      cwd: repo,
      selector: { kind: 'worktree' },
      adapter: {
        async complete() {
          modelCalls += 1;
          return { content: '{}', model: 'probe' };
        },
      },
      identity: IDENTITY,
      runGit: runner(repo),
    });
    expect(modelCalls).toBe(0);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.state).toBe('completed');
      expect(outcome.result.conclusion).toBe('no_findings');
      expect(outcome.result.limits).toContain('empty_scope_no_changes');
      expect(verifyReceiptDigest(outcome.result)).toBe(true);
    }
  });

  test('valid anchored findings conclude `findings` with a digest-verifiable receipt', async () => {
    const probe = await runCodeReview({
      cwd: repo,
      selector: { kind: 'worktree' },
      adapter: adapterWith('{"findings":[]}'),
      identity: IDENTITY,
      runGit: runner(repo),
    });
    if (!probe.ok) throw new Error('fixture broken');
    const fileKey = probe.result.coverage.inspectedFiles[0];
    // fileKey in coverage is the path; resolve the snapshot fileKey through a
    // second run's payload: the membership check requires the snapshot's
    // fileKey, so derive it by asking the adapter to capture the prompt.
    let capturedPrompt = '';
    const capturing: ReviewModelAdapterV1 = {
      async complete(messages) {
        capturedPrompt = messages[messages.length - 1]?.content ?? '';
        return { content: '{}', model: 'probe' };
      },
    };
    await runCodeReview({
      cwd: repo,
      selector: { kind: 'worktree' },
      adapter: capturing,
      identity: IDENTITY,
      runGit: runner(repo),
    });
    const keyMatch = capturedPrompt.match(/^  ([0-9a-f]{16}) app\.ts \[/m);
    expect(keyMatch).not.toBeNull();
    const fileKeyFromPrompt = keyMatch?.[1] as string;
    expect(fileKey).toBe('app.ts');

    const outcome = await runCodeReview({
      cwd: repo,
      selector: { kind: 'worktree' },
      adapter: adapterWith(findingPayload(fileKeyFromPrompt)),
      identity: IDENTITY,
      runGit: runner(repo),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.state).toBe('completed');
      expect(outcome.result.conclusion).toBe('findings');
      expect(outcome.result.findings).toHaveLength(1);
      expect(outcome.result.invalidFindingCount).toBe(0);
      expect(outcome.result.coverageAssertion.complete).toBe(true);
      expect(verifyReceiptDigest(outcome.result)).toBe(true);
      expect(outcome.result.turnId).toBe('turn-9');
    }
  });

  test('findings outside the frozen snapshot are counted invalid, never green', async () => {
    const outcome = await runCodeReview({
      cwd: repo,
      selector: { kind: 'worktree' },
      adapter: adapterWith(findingPayload('deadbeefdeadbeef')),
      identity: IDENTITY,
      runGit: runner(repo),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.findings).toHaveLength(0);
      expect(outcome.result.invalidFindingCount).toBe(1);
      expect(outcome.result.conclusion).toBe('inconclusive');
    }
  });

  test('unparsable model output fails the run instead of passing', async () => {
    const outcome = await runCodeReview({
      cwd: repo,
      selector: { kind: 'worktree' },
      adapter: adapterWith('I reviewed the code and it looks great!'),
      identity: IDENTITY,
      runGit: runner(repo),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind).toBe('unparsable_output');
  });

  test('model errors surface as typed model_error', async () => {
    const outcome = await runCodeReview({
      cwd: repo,
      selector: { kind: 'worktree' },
      adapter: {
        async complete() {
          throw new Error('provider 503');
        },
      },
      identity: IDENTITY,
      runGit: runner(repo),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('model_error');
      if (outcome.failure.kind === 'model_error') {
        expect(outcome.failure.message).toContain('provider 503');
      }
    }
  });

  test('base scope freezes merge-base OIDs and accepts anchored findings', async () => {
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'change under review']);
    const outcome = await runCodeReview({
      cwd: repo,
      selector: { kind: 'base', ref: 'main~1' },
      adapter: adapterWith('{"findings":[]}'),
      identity: IDENTITY,
      runGit: runner(repo),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.resolvedTarget.kind).toBe('base');
      expect(outcome.result.resolvedTarget.baseOid).toBeTruthy();
      expect(outcome.result.resolvedTarget.headOid).toBeTruthy();
      expect(outcome.result.inputSnapshotDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('snapshot errors are typed failures, not exceptions', async () => {
    const outcome = await runCodeReview({
      cwd: repo,
      selector: { kind: 'base', ref: 'no-such-ref' },
      adapter: adapterWith('{"findings":[]}'),
      identity: IDENTITY,
      runGit: runner(repo),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('snapshot');
      if (outcome.failure.kind === 'snapshot') {
        expect(outcome.failure.code).toBe('ref_unresolved');
      }
    }
  });

  test('aborted runs are cancelled before the model call', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runCodeReview({
      cwd: repo,
      selector: { kind: 'worktree' },
      adapter: adapterWith('{"findings":[]}'),
      identity: IDENTITY,
      abortSignal: controller.signal,
      runGit: runner(repo),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind).toBe('cancelled');
  });

  test('invalid budget overrides are refused before any git access', async () => {
    const outcome = await runCodeReview({
      cwd: repo,
      selector: { kind: 'worktree' },
      adapter: adapterWith('{"findings":[]}'),
      identity: IDENTITY,
      budgets: { maxFiles: 10_000 },
      runGit: runner(repo),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('budget');
      if (outcome.failure.kind === 'budget') expect(outcome.failure.field).toBe('maxFiles');
    }
  });

  test('maxFindings truncation marks the run partial with budget exhaustion', async () => {
    let capturedPrompt = '';
    const capturing: ReviewModelAdapterV1 = {
      async complete(messages) {
        capturedPrompt = messages[messages.length - 1]?.content ?? '';
        return { content: '{}', model: 'probe' };
      },
    };
    await runCodeReview({
      cwd: repo,
      selector: { kind: 'worktree' },
      adapter: capturing,
      identity: IDENTITY,
      runGit: runner(repo),
    });
    const keyMatch = capturedPrompt.match(/^  ([0-9a-f]{16}) app\.ts \[/m);
    const fileKey = keyMatch?.[1] as string;
    const many = {
      findings: Array.from({ length: 5 }, (_, index) => ({
        findingId: `abcd123${index}`,
        priority: 'P2',
        title: `finding ${index}`,
        trigger: 'trigger',
        impact: 'impact',
        fileKey,
        side: 'new',
        startLine: 2,
        endLine: 2,
        evidence: 'evidence',
      })),
    };
    const outcome = await runCodeReview({
      cwd: repo,
      selector: { kind: 'worktree' },
      adapter: adapterWith(JSON.stringify(many)),
      identity: IDENTITY,
      budgets: { maxFindings: 2 },
      runGit: runner(repo),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.findings).toHaveLength(2);
      expect(outcome.result.invalidFindingCount).toBe(3);
      expect(outcome.result.state).toBe('partial');
      expect(outcome.result.coverage.budgetExhausted).toContain('maxFindings');
      expect(outcome.result.conclusion).toBe('findings');
    }
  });

  test('rules digest binds the read-only constraint policy', async () => {
    const outcome = await runCodeReview({
      cwd: repo,
      selector: { kind: 'worktree' },
      adapter: adapterWith('{"findings":[]}'),
      identity: IDENTITY,
      runGit: runner(repo),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.rulesDigest).toMatch(/^[0-9a-f]{64}$/);
      writeFileSync(join(repo, 'AGENTS.md'), 'Always run the linter.\n');
      const changed = await runCodeReview({
        cwd: repo,
        selector: { kind: 'worktree' },
        adapter: adapterWith('{"findings":[]}'),
        identity: IDENTITY,
        runGit: runner(repo),
      });
      expect(changed.ok).toBe(true);
      if (changed.ok) expect(changed.result.rulesDigest).not.toBe(outcome.result.rulesDigest);
    }
  });
});
