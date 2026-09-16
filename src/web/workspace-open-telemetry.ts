/**
 * v0.3.17 — LOCAL WORKSPACE open-path telemetry.
 *
 * Answers "which segment is slow" without ever recording a path, a label or
 * file content. Every trace carries its own request id, an operation, an
 * outcome and per-stage milliseconds. The ring buffer is bounded and is exposed
 * read-only through Diagnostics, so E2E and the diagnostics panel can compare a
 * cold and a warm open instead of guessing.
 */

export type WorkspaceOpenStage =
  | 'picker_launch'
  | 'picker_result'
  | 'inspect_fs'
  | 'inspect_session_count'
  | 'activate_admitted'
  | 'runtime_install'
  | 'previous_runtime_shutdown'
  | 'baseline_bootstrap'
  | 'baseline_collections'
  | 'baseline_snapshot'
  | 'sse_resumed'
  | 'interactive';

export type WorkspaceOpenOperation = 'pick-directory' | 'inspect' | 'activate';
export type WorkspaceOpenOutcome = 'success' | 'cancelled' | 'failed';

export interface WorkspaceOpenTraceV1 {
  readonly requestId: string;
  readonly operation: WorkspaceOpenOperation;
  readonly outcome: WorkspaceOpenOutcome;
  /** Milliseconds from span start to the moment each stage completed. */
  readonly stages: Readonly<Partial<Record<WorkspaceOpenStage, number>>>;
  readonly totalMs: number;
  readonly errorCode?: string;
}

export interface WorkspaceOpenTelemetrySnapshotV1 {
  readonly retained: number;
  readonly limit: number;
  readonly recent: readonly WorkspaceOpenTraceV1[];
}

export interface WorkspaceOpenTelemetryOptions {
  readonly limit?: number;
  readonly now?: () => number;
}

const DEFAULT_LIMIT = 50;

/** One in-flight operation. Stages are recorded once; later marks are ignored. */
export class WorkspaceOpenSpanV1 {
  private readonly stages: Partial<Record<WorkspaceOpenStage, number>> = {};
  private readonly startedAt: number;
  private finished = false;

  constructor(
    readonly requestId: string,
    readonly operation: WorkspaceOpenOperation,
    private readonly now: () => number
  ) {
    this.startedAt = now();
  }

  mark(stage: WorkspaceOpenStage): void {
    if (this.finished || this.stages[stage] !== undefined) return;
    this.stages[stage] = Math.max(0, Math.round(this.now() - this.startedAt));
  }

  has(stage: WorkspaceOpenStage): boolean {
    return this.stages[stage] !== undefined;
  }

  finish(outcome: WorkspaceOpenOutcome, errorCode?: string): WorkspaceOpenTraceV1 {
    this.finished = true;
    return Object.freeze({
      requestId: this.requestId,
      operation: this.operation,
      outcome,
      stages: Object.freeze({ ...this.stages }),
      totalMs: Math.max(0, Math.round(this.now() - this.startedAt)),
      ...(errorCode ? { errorCode } : {}),
    });
  }

  /** Flush without recording (used when tracing is not interesting). */
  discard(): void {
    this.finished = true;
  }
}

export class WorkspaceOpenTelemetryV1 {
  private readonly limit: number;
  private readonly now: () => number;
  private readonly entries: WorkspaceOpenTraceV1[] = [];

  constructor(options: WorkspaceOpenTelemetryOptions = {}) {
    this.limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
    this.now = options.now ?? (() => performance.now());
  }

  start(requestId: string, operation: WorkspaceOpenOperation): WorkspaceOpenSpanV1 {
    return new WorkspaceOpenSpanV1(requestId, operation, this.now);
  }

  record(trace: WorkspaceOpenTraceV1): void {
    this.entries.push(trace);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
  }

  snapshot(): WorkspaceOpenTelemetrySnapshotV1 {
    return Object.freeze({
      retained: this.entries.length,
      limit: this.limit,
      recent: Object.freeze([...this.entries]),
    });
  }
}
