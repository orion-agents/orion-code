import { runCodeReview } from '../src/services/code-review/runner';
import type { CodeReviewResultV1, ReviewFindingV1 } from '../src/services/code-review/contract';
import {
  WebCodeReviewRunServiceV1,
  type WebCodeReviewRunRecordV1,
} from '../src/web/code-review-run-service';
import { WebWorkbenchError } from '../src/web/errors';

const FINDING: ReviewFindingV1 = {
  findingId: 'f1nd1ng0f1nd1ng0f1nd1ng0f1nd1ng',
  priority: 'P1',
  title: 'Unguarded index access',
  trigger: 'When the list is empty',
  impact: 'The renderer throws on the first paint.',
  fileKey: 'fk-1',
  side: 'new',
  startLine: 2,
  endLine: 2,
  evidence: 'lines[0] is accessed without a length check.',
};

/** A self-consistent receipt: the digest is computed over the full body. */
function makeResult(overrides: Partial<CodeReviewResultV1> = {}): CodeReviewResultV1 {
  const {
    computeReceiptDigest,
  } = require('../src/services/code-review/contract') as typeof import('../src/services/code-review/contract');
  const base = {
    schemaVersion: 1 as const,
    reviewId: 'cr-test0000000000000000000000000000000001',
    workspaceIdentity: '/tmp/ws',
    sessionId: 'web-host:test',
    threadId: 'web-host:test',
    turnId: 'crr-test',
    requestedSelector: { kind: 'worktree' } as const,
    resolvedTarget: { kind: 'worktree' as const, snapshotId: 'snap-1' },
    inputSnapshotDigest: 'a'.repeat(64),
    rulesDigest: 'b'.repeat(64),
    state: 'completed' as const,
    conclusion: 'findings' as const,
    findings: [FINDING],
    invalidFindingCount: 0,
    coverage: {
      inspectedFiles: ['src/a.ts'],
      inspectedRanges: [],
      skipped: [],
      truncated: false,
      budgetExhausted: [],
    },
    coverageAssertion: { complete: true },
    limits: [],
    model: { provider: 'fake', model: 'fake-model' },
    usage: { inputTokens: 10, outputTokens: 5 },
    startedAt: 1,
    endedAt: 2,
    ...overrides,
  };
  return Object.freeze({ ...base, receiptDigest: computeReceiptDigest(base) });
}

function okOutcome(result: CodeReviewResultV1) {
  return { ok: true as const, result };
}

interface HarnessOptions {
  readonly outcome?:
    | { readonly ok: true; readonly result: CodeReviewResultV1 }
    | { readonly ok: false; readonly failure: Record<string, string> };
  readonly adapter?: (() => Record<string, unknown> | null) | null;
  readonly revision?: string | (() => Promise<string>);
  readonly runError?: Error;
  readonly now?: () => number;
  readonly maxRuns?: number;
  /** When set, the fake runner blocks until `release()` is called. */
  readonly gated?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  const runs: Array<Record<string, unknown>> = [];
  let release: (() => void) | null = null;
  const gate = options.gated
    ? new Promise<void>(resolve => {
        release = resolve;
      })
    : null;
  const runReview = jest.fn(async (runOptions: Record<string, unknown>) => {
    runs.push(runOptions);
    if (gate) await gate;
    // The real runner maps an aborted signal to a cancelled outcome.
    if ((runOptions.abortSignal as AbortSignal | undefined)?.aborted) {
      return { ok: false, failure: { kind: 'cancelled' } };
    }
    if (options.runError) throw options.runError;
    return options.outcome ?? okOutcome(makeResult());
  });
  const adapterValue = options.adapter === null ? null : options.adapter ?? { complete: () => {} };
  const revisionValue = options.revision ?? 'rev-1';
  const service = new WebCodeReviewRunServiceV1({
    adapterProvider: () => adapterValue as never,
    cwdProvider: () => '/tmp/ws',
    repositoryRevisionProvider:
      typeof revisionValue === 'function' ? revisionValue : async () => revisionValue,
    runReview: runReview as unknown as typeof runCodeReview,
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxRuns !== undefined ? { maxRuns: options.maxRuns } : {}),
  });
  return { service, runReview, runs, releaseRun: () => release?.() };
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('condition not met in time');
}

describe('WebCodeReviewRunServiceV1', () => {
  test('start returns immediately with a running record that completes in the background', async () => {
    const { service, runReview, runs, releaseRun } = makeHarness({
      outcome: okOutcome(makeResult()),
      gated: true,
    });
    const started = await service.start({ kind: 'worktree' });
    expect(started.status).toBe('running');

    const running = await service.get(started.runId);
    expect(running.status).toBe('running');
    expect(running.result).toBeNull();

    expect(runReview.mock.calls.length).toBeGreaterThan(0);
    releaseRun();
    await waitFor(async () => (await service.get(started.runId)).status === 'completed');
    const finished = await service.get(started.runId);
    expect(finished.endedAt).not.toBeNull();
    expect(finished.result?.conclusion).toBe('findings');
    expect(finished.failure).toBeNull();
    expect(finished.stale).toBe(false);
    // The runner receives the workspace cwd and a web-host session identity.
    expect(runs[0]?.cwd).toBe('/tmp/ws');
    expect(String((runs[0]?.identity as { sessionId: string }).sessionId)).toContain('web-host:');
  });

  test('a second start while running is a typed 409 and cancel releases the slot', async () => {
    const { service, releaseRun } = makeHarness({
      outcome: okOutcome(makeResult()),
      gated: true,
    });
    const started = await service.start({ kind: 'worktree' });
    await expect(service.start({ kind: 'worktree' })).rejects.toMatchObject({
      status: 409,
      code: 'review_run_in_progress',
    });
    service.cancel(started.runId);
    releaseRun();
    await waitFor(async () => (await service.get(started.runId)).status === 'cancelled');
    // The slot is free again: a fresh run can start and complete.
    const next = await service.start({ kind: 'worktree' });
    await waitFor(async () => (await service.get(next.runId)).status === 'completed');
  });

  test('start without a model is a typed 422 and never invokes the runner', async () => {
    const { service, runReview } = makeHarness({ adapter: null });
    await expect(service.start({ kind: 'worktree' })).rejects.toMatchObject({
      status: 422,
      code: 'review_no_model',
    });
    expect(runReview).not.toHaveBeenCalled();
  });

  test('runner failure states are mapped to honest failed records, not green passes', async () => {
    const { service } = makeHarness({
      outcome: { ok: false, failure: { kind: 'model_error', message: 'boom' } },
    });
    const started = await service.start({ kind: 'worktree' });
    await waitFor(async () => (await service.get(started.runId)).status !== 'running');
    const record = await service.get(started.runId);
    expect(record.status).toBe('failed');
    expect(record.result).toBeNull();
    expect(record.failure).toMatchObject({ kind: 'model_error' });
  });

  test('cancellation maps to a cancelled record', async () => {
    const { service } = makeHarness({
      outcome: { ok: false, failure: { kind: 'cancelled' } },
    });
    const started = await service.start({ kind: 'worktree' });
    await waitFor(async () => (await service.get(started.runId)).status !== 'running');
    const record = await service.get(started.runId);
    expect(record.status).toBe('cancelled');
    expect(record.result).toBeNull();
  });

  test('a receipt whose repository revision changed reads back as stale', async () => {
    let revision = 'rev-1';
    const { service } = makeHarness({ revision: () => Promise.resolve(revision) });
    const started = await service.start({ kind: 'worktree' });
    await waitFor(async () => (await service.get(started.runId)).status !== 'running');
    expect((await service.get(started.runId)).stale).toBe(false);
    revision = 'rev-2';
    expect((await service.get(started.runId)).stale).toBe(true);
    expect(((await service.list())[0] as WebCodeReviewRunRecordV1).stale).toBe(true);
    // The stored receipt itself is untouched by staleness.
    expect((await service.get(started.runId)).result?.receiptDigest).toBeDefined();
  });

  test('a stored receipt that fails digest re-verification is presented as failed', async () => {
    const tampered = makeResult();
    const { service } = makeHarness({
      outcome: {
        ok: true,
        result: { ...tampered, receiptDigest: 'c'.repeat(64) },
      },
    });
    const started = await service.start({ kind: 'worktree' });
    await waitFor(async () => (await service.get(started.runId)).status !== 'running');
    const record = await service.get(started.runId);
    expect(record.status).toBe('failed');
    expect(record.result).toBeNull();
    expect(record.failure).toMatchObject({ kind: 'receipt_digest_mismatch' });
  });

  test('unknown run ids are a typed 404', async () => {
    const { service } = makeHarness();
    await expect(service.get('crr-missing')).rejects.toBeInstanceOf(WebWorkbenchError);
  });

  test('history is bounded: oldest finished records are evicted first', async () => {
    let clock = 0;
    const { service } = makeHarness({ maxRuns: 2, now: () => (clock += 1) });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const started = await service.start({ kind: 'worktree' });
      ids.push(started.runId);
      await waitFor(async () => (await service.get(started.runId)).status !== 'running');
    }
    const listed = await service.list();
    expect(listed).toHaveLength(2);
    expect(listed.map(record => record.runId)).not.toContain(ids[0]);
  });

  test('list is ordered newest-first', async () => {
    let clock = 0;
    const { service } = makeHarness({ now: () => (clock += 1) });
    const first = await service.start({ kind: 'worktree' });
    await waitFor(async () => (await service.get(first.runId)).status !== 'running');
    const second = await service.start({ kind: 'worktree' });
    await waitFor(async () => (await service.get(second.runId)).status !== 'running');
    const listed = await service.list();
    expect(listed.map(record => record.runId)).toEqual([second.runId, first.runId]);
  });
});
