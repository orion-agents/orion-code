/**
 * v0.3.29 — Host-side shared code-review run service
 * (docs/plan/v0.3.29-plan.md S1). The Web Host starts the same bounded
 * single-pass review runner the CLI uses (v0.3.28 `runCodeReview`) against the
 * active Workspace, keeps a bounded in-memory receipt history, and re-verifies
 * every receipt digest plus repository revision freshness when results are
 * read. No second review engine: receipts, budgets, validation and honest
 * failure states come from the frozen `src/services/code-review` contract.
 *
 * Delivery model: `start()` validates admission and returns immediately; the
 * model completion runs in the background and clients poll `list()`/`get()`.
 * At most one run is in flight per Host (a second start is a typed 409), and
 * a run may be cancelled to release the slot.
 */
import { randomUUID } from 'crypto';

import {
  verifyReceiptDigest,
  type CodeReviewResultV1,
  type ReviewRunStateV1,
  type ReviewSelectorV1,
} from '../services/code-review/contract';
import {
  runCodeReview,
  type ReviewModelAdapterV1,
  type ReviewRunOptionsV1,
} from '../services/code-review/runner';
import type { CodeReviewSnapshotV1 } from '../services/code-review/snapshot';
import { WebWorkbenchError } from './errors';

export interface WebCodeReviewRunRecordV1 {
  readonly runId: string;
  readonly selector: ReviewSelectorV1;
  readonly status: ReviewRunStateV1 | 'running';
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** Repository revision captured at admission; compared against the current
   *  value on read to mark a stored receipt stale. */
  readonly repositoryRevisionAtAdmission: string;
  /** fileKey -> path mapping captured with the frozen snapshot, so findings
   *  can be anchored to a diff without changing the receipt contract. */
  readonly files: ReadonlyArray<{ readonly fileKey: string; readonly path: string }>;
  /** Present only for finished runs whose receipt passed digest re-verification. */
  readonly result: CodeReviewResultV1 | null;
  readonly failure: { readonly kind: string; readonly message: string } | null;
  /** Recomputed on read: true when the repository changed since admission. */
  readonly stale: boolean;
}

export interface WebCodeReviewRunServiceOptionsV1 {
  /** Returns the review model adapter, or null when the Host has no model. */
  readonly adapterProvider: () => ReviewModelAdapterV1 | null;
  /** Workspace root used for the review snapshot; read at start time. */
  readonly cwdProvider: () => string;
  /** Current repository revision, sampled on every read for staleness. */
  readonly repositoryRevisionProvider: () => Promise<string>;
  /** Injectable runner (tests use fakes); defaults to the shared runner. */
  readonly runReview?: typeof runCodeReview;
  readonly now?: () => number;
  /** Bounded receipt history; oldest finished records are evicted first. */
  readonly maxRuns?: number;
}

export class WebCodeReviewRunServiceV1 {
  private readonly records = new Map<string, WebCodeReviewRunRecordV1>();
  private readonly inflight = new Map<string, AbortController>();
  private readonly adapterProvider: () => ReviewModelAdapterV1 | null;
  private readonly cwdProvider: () => string;
  private readonly repositoryRevisionProvider: () => Promise<string>;
  private readonly runReview: typeof runCodeReview;
  private readonly now: () => number;
  private readonly maxRuns: number;

  constructor(options: WebCodeReviewRunServiceOptionsV1) {
    this.adapterProvider = options.adapterProvider;
    this.cwdProvider = options.cwdProvider;
    this.repositoryRevisionProvider = options.repositoryRevisionProvider;
    this.runReview = options.runReview ?? runCodeReview;
    this.now = options.now ?? Date.now;
    this.maxRuns = Math.max(1, options.maxRuns ?? 20);
  }

  /** Admission is synchronous and fast: validate, record, return. The model
   *  completion continues in the background. */
  async start(selector: ReviewSelectorV1): Promise<{
    readonly runId: string;
    readonly status: 'running';
  }> {
    if (this.inflight.size > 0) {
      throw new WebWorkbenchError(
        409,
        'A code review is already running in this Host. Wait for it to finish or cancel it.',
        'review_run_in_progress'
      );
    }
    const adapter = this.adapterProvider();
    if (!adapter) {
      throw new WebWorkbenchError(
        422,
        'The Host has no configured model. Configure a model first, then retry the review.',
        'review_no_model'
      );
    }
    const runId = randomUUID();
    const repositoryRevisionAtAdmission = await this.repositoryRevisionProvider();
    const startedAt = this.now();
    let capturedFiles: ReadonlyArray<{ readonly fileKey: string; readonly path: string }> = [];
    this.records.set(runId, {
      runId,
      selector,
      status: 'running',
      startedAt,
      endedAt: null,
      repositoryRevisionAtAdmission,
      files: capturedFiles,
      result: null,
      failure: null,
      stale: false,
    });
    const abort = new AbortController();
    this.inflight.set(runId, abort);
    const cwd = this.cwdProvider();
    void this.execute({ runId, selector, cwd, adapter, abort, onSnapshot: snapshot => {
      capturedFiles = Object.freeze(
        snapshot.files.map(file => ({ fileKey: file.fileKey, path: file.path }))
      );
      const record = this.records.get(runId);
      if (record) this.records.set(runId, { ...record, files: capturedFiles });
    } });
    return Object.freeze({ runId, status: 'running' as const });
  }

  /** Cancels a running review; finished or unknown runs are a no-op. */
  cancel(runId: string): void {
    this.inflight.get(runId)?.abort();
  }

  async list(): Promise<readonly WebCodeReviewRunRecordV1[]> {
    const currentRevision = await this.repositoryRevisionProvider();
    return [...this.records.values()]
      .sort((left, right) => right.startedAt - left.startedAt)
      .map(record => this.present(record, currentRevision));
  }

  async get(runId: string): Promise<WebCodeReviewRunRecordV1> {
    const record = this.records.get(runId);
    if (!record) {
      throw new WebWorkbenchError(404, 'Unknown review run.', 'review_run_not_found');
    }
    const currentRevision = await this.repositoryRevisionProvider();
    return this.present(record, currentRevision);
  }

  private async execute(input: {
    readonly runId: string;
    readonly selector: ReviewSelectorV1;
    readonly cwd: string;
    readonly adapter: ReviewModelAdapterV1;
    readonly abort: AbortController;
    readonly onSnapshot?: (snapshot: CodeReviewSnapshotV1) => void;
  }): Promise<void> {
    const { runId, selector, cwd, adapter, abort, onSnapshot } = input;
    const options: ReviewRunOptionsV1 = {
      cwd,
      selector,
      adapter,
      identity: {
        workspaceIdentity: cwd,
        // Web control-plane runs are their own session identity; they are not
        // attributed to any chat Session actor.
        sessionId: `web-host:${runId}`,
        threadId: `web-host:${runId}`,
        turnId: runId,
      },
      abortSignal: abort.signal,
      ...(onSnapshot ? { onSnapshotCaptured: onSnapshot } : {}),
    };
    let failure: { kind: string; message: string } | null = null;
    let result: CodeReviewResultV1 | null = null;
    try {
      const outcome = await this.runReview(options);
      if (outcome.ok) {
        result = outcome.result;
      } else {
        failure = {
          kind: outcome.failure.kind,
          message: failureMessage(outcome.failure),
        };
      }
    } catch (error) {
      failure = {
        kind: 'model_error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    this.inflight.delete(runId);
    const existing = this.records.get(runId);
    if (!existing) return;
    const finished: WebCodeReviewRunRecordV1 = {
      ...existing,
      status: result
        ? result.state
        : failure?.kind === 'cancelled'
          ? 'cancelled'
          : 'failed',
      endedAt: this.now(),
      result,
      failure,
    };
    this.records.set(runId, finished);
    this.evictFinished();
  }

  private evictFinished(): void {
    const finished = [...this.records.values()]
      .filter(record => record.status !== 'running')
      .sort(
        (left, right) =>
          (left.endedAt ?? left.startedAt) - (right.endedAt ?? right.startedAt)
      );
    let excess = this.records.size - this.maxRuns;
    for (const record of finished) {
      if (excess <= 0) break;
      this.records.delete(record.runId);
      excess -= 1;
    }
  }

  private present(
    record: WebCodeReviewRunRecordV1,
    currentRevision: string
  ): WebCodeReviewRunRecordV1 {
    const stale =
      record.result !== null && record.repositoryRevisionAtAdmission !== currentRevision;
    if (record.result && !verifyReceiptDigest(record.result)) {
      // A receipt that no longer verifies must never be presented as findings;
      // surface it as a failed run with an honest message instead.
      return {
        ...record,
        status: 'failed',
        stale,
        result: null,
        failure: {
          kind: 'receipt_digest_mismatch',
          message: 'The stored review receipt failed digest re-verification.',
        },
      };
    }
    return { ...record, stale };
  }
}

function failureMessage(failure: {
  readonly kind: string;
  readonly message?: string;
  readonly code?: string;
  readonly field?: string;
}): string {
  switch (failure.kind) {
    case 'cancelled':
      return 'Review cancelled.';
    case 'budget':
      return `Review budget rejected: ${failure.field ?? 'unknown'}`;
    case 'snapshot':
      return `Review scope error (${failure.code ?? 'unknown'}): ${failure.message ?? ''}`;
    case 'model_error':
      return `Review model call failed: ${failure.message ?? ''}`;
    case 'unparsable_output':
      return `Review output could not be parsed: ${failure.message ?? ''}`;
    default:
      return failure.message ?? 'Review failed.';
  }
}

/** v0.3.29 — validates the JSON selector accepted by `POST /review/run`.
 *  Mirrors the CLI selector contract: worktree scope, base ref scope, optional
 *  path filters. Unknown shapes are typed 400s, never guesses. */
export function parseWebReviewSelectorV1(value: unknown): ReviewSelectorV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebWorkbenchError(400, 'Review selector must be an object.', 'review_selector_invalid');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const allowed =
    record.kind === 'base'
      ? ['kind', 'paths', 'ref']
      : ['kind', 'paths'];
  if (keys.some(key => !allowed.includes(key))) {
    throw new WebWorkbenchError(
      400,
      `Review selector accepts only ${allowed.join(', ')}.`,
      'review_selector_invalid'
    );
  }
  const paths = parseSelectorPaths(record.paths);
  if (record.kind === 'base') {
    if (typeof record.ref !== 'string' || record.ref.trim() === '') {
      throw new WebWorkbenchError(400, 'Review selector base ref must be a non-empty string.', 'review_selector_invalid');
    }
    return Object.freeze({ kind: 'base', ref: record.ref, ...(paths ? { paths } : {}) });
  }
  if (record.kind === 'worktree') {
    return Object.freeze({ kind: 'worktree', ...(paths ? { paths } : {}) });
  }
  throw new WebWorkbenchError(
    400,
    'Review selector kind must be "worktree" or "base".',
    'review_selector_invalid'
  );
}

function parseSelectorPaths(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(path => typeof path !== 'string' || path.trim() === '')) {
    throw new WebWorkbenchError(
      400,
      'Review selector paths must be an array of non-empty strings.',
      'review_selector_invalid'
    );
  }
  return Object.freeze([...value]);
}
