import { digestRuntimeValue } from './protocol/canonical';
import {
  isRuntimeId,
  type RuntimeEventEnvelopeV1,
  type RuntimeEventV1,
} from './protocol/runtime-protocol-v1';

export const COMPACT_TRANSACTION_VERSION = 1 as const;

export type CompactRuntimeEventV1 = Extract<
  RuntimeEventV1,
  { type: 'compact.started' | 'compact.completed' | 'compact.failed' }
>;

export type CompactTransactionBoundaryV1 =
  | 'after_source_prepare'
  | 'after_started_commit'
  | 'after_candidate_prepare'
  | 'after_candidate_validate'
  | 'before_cas_recheck'
  | 'after_cas_recheck'
  | 'after_checkpoint_write'
  | 'after_pointer_commit'
  | 'after_completed_commit'
  | 'after_failed_commit';

export type CompactCasBoundaryV1 = Extract<
  CompactTransactionBoundaryV1,
  'before_cas_recheck' | 'after_cas_recheck' | 'after_checkpoint_write' | 'after_pointer_commit'
>;

export type CompactCasConflictReasonV1 =
  | 'cursor_changed'
  | 'projection_changed'
  | 'history_changed'
  | 'task_context_changed'
  | 'task_context_revision_changed'
  | 'checkpoint_pointer_changed';

export type CompactTransactionFailureCodeV1 =
  | 'candidate_prepare_failed'
  | 'candidate_validation_failed'
  | 'candidate_rejected'
  | 'cas_commit_failed'
  | `cas_conflict:${CompactCasConflictReasonV1}`
  | 'orphaned_before_checkpoint_commit';

export interface CompactMaintenanceTurnV1 {
  readonly turnId: string;
  readonly mode: 'maintenance';
  readonly active: true;
  readonly steerable: false;
}

/** Snapshot captured atomically by the persistence owner before candidate work starts. */
export interface CompactAuthoritativeSourceV1 {
  readonly threadId: string;
  readonly maintenanceTurn: CompactMaintenanceTurnV1;
  readonly cursor: number;
  readonly projectionDigest: string;
  readonly history: readonly unknown[];
  readonly taskContext: unknown;
  readonly taskContextRevision: number;
  readonly activeCheckpointId: string | null;
}

export interface CompactPrepareSourceReceiptV1 {
  readonly version: 1;
  readonly threadId: string;
  readonly turnId: string;
  readonly nonSteerable: true;
  readonly cursor: number;
  readonly projectionDigest: string;
  readonly historyDigest: string;
  readonly historyEntries: number;
  readonly taskContextDigest: string;
  readonly taskContextRevision: number;
  readonly activeCheckpointId: string | null;
  readonly digest: string;
}

export interface CompactPreparedCandidateV1 {
  readonly checkpointId: string;
  /** Durable sidecar payload. It is not copied into transaction receipts. */
  readonly checkpoint: unknown;
  readonly modelVisibleHistory: readonly unknown[];
}

export interface CompactCandidateValidationContextV1 {
  readonly source: CompactPrepareSourceReceiptV1;
  readonly checkpointId: string;
  readonly checkpoint: unknown;
  readonly checkpointDigest: string;
  readonly modelVisibleHistory: readonly unknown[];
  readonly nextModelVisibleHistoryDigest: string;
}

export interface CompactCandidateValidatorV1 {
  readonly id: string;
  validate(
    context: CompactCandidateValidationContextV1,
    signal: AbortSignal
  ): boolean | Promise<boolean>;
}

export interface CompactValidationReceiptV1 {
  readonly version: 1;
  readonly validatorId: string;
  readonly sourceReceiptDigest: string;
  readonly checkpointDigest: string;
  readonly nextModelVisibleHistoryDigest: string;
  readonly valid: true;
  readonly digest: string;
}

export interface CompactEventAnchorV1 {
  readonly cursor: number;
  readonly projectionDigest: string;
}

export interface CompactCheckpointPointerV1 {
  readonly version: 1;
  readonly checkpointId: string;
  readonly transactionId: string;
  readonly sourceReceiptDigest: string;
  readonly nextModelVisibleHistoryDigest: string;
  readonly digest: string;
}

/** Receipt persisted with the checkpoint before its pointer becomes authoritative. */
export interface CompactCheckpointCommitReceiptV1 {
  readonly version: 1;
  readonly transactionId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly source: CompactPrepareSourceReceiptV1;
  readonly startedEvent: CompactEventAnchorV1;
  readonly checkpointId: string;
  readonly checkpointDigest: string;
  readonly candidateDigest: string;
  readonly validation: CompactValidationReceiptV1;
  readonly previousCheckpointId: string | null;
  readonly pointer: CompactCheckpointPointerV1;
  readonly digest: string;
}

export interface CompactTransactionCompletedReceiptV1 {
  readonly version: 1;
  readonly status: 'completed';
  readonly recovered: boolean;
  readonly commit: CompactCheckpointCommitReceiptV1;
  readonly completedSeq: number;
  readonly nextModelVisibleHistoryDigest: string;
  readonly digest: string;
}

export interface CompactTransactionFailedReceiptV1 {
  readonly version: 1;
  readonly status: 'failed';
  /** Missing only when v1 protocol recovery cannot reconstruct it from compact.started. */
  readonly transactionId?: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly source?: CompactPrepareSourceReceiptV1;
  readonly sourceSeq: number;
  readonly startedSeq: number;
  readonly failedSeq: number;
  readonly failureCode: CompactTransactionFailureCodeV1;
  readonly previousCheckpointId?: string | null;
  readonly digest: string;
}

export type CompactTransactionOutcomeV1 =
  | { readonly status: 'completed'; readonly receipt: CompactTransactionCompletedReceiptV1 }
  | { readonly status: 'failed'; readonly receipt: CompactTransactionFailedReceiptV1 };

export interface CompactEventAppendResultV1 {
  readonly event: RuntimeEventEnvelopeV1<CompactRuntimeEventV1>;
  readonly projectionDigest: string;
}

export interface CompactCompareAndCommitInputV1 {
  readonly source: CompactPrepareSourceReceiptV1;
  readonly expectedEventAnchor: CompactEventAnchorV1;
  readonly candidate: CompactPreparedCandidateV1;
  readonly commit: CompactCheckpointCommitReceiptV1;
  /** These hooks execute while the persistence lock is held. */
  readonly onBoundary: (boundary: CompactCasBoundaryV1) => void;
}

export type CompactCompareAndCommitResultV1 =
  | { readonly status: 'committed'; readonly pointer: CompactCheckpointPointerV1 }
  | { readonly status: 'conflict'; readonly reason: CompactCasConflictReasonV1 };

type MaybePromise<T> = T | Promise<T>;

/**
 * Atomic persistence boundary required by CompactTransactionV1.
 *
 * compareAndCommit must hold one exclusive lock while it rechecks every source
 * field, writes/reloads the checkpoint, and advances the pointer. A failure at
 * or before after_checkpoint_write must restore the previous pointer/history.
 * A failure at after_pointer_commit may leave the new pointer authoritative and
 * is reconciled from the persisted commit receipt on resume.
 */
export interface CompactTransactionPersistenceV1 {
  readonly threadId: string;
  captureSource(turnId: string): MaybePromise<CompactAuthoritativeSourceV1>;
  appendCompactEvent(input: {
    readonly turnId: string;
    readonly payload: CompactRuntimeEventV1;
  }): MaybePromise<CompactEventAppendResultV1>;
  compareAndCommit(
    input: CompactCompareAndCommitInputV1
  ): MaybePromise<CompactCompareAndCommitResultV1>;
  findCommittedCheckpoint(
    turnId: string,
    sourceSeq: number
  ): MaybePromise<CompactCheckpointCommitReceiptV1 | undefined>;
  listCompactEvents(): MaybePromise<readonly RuntimeEventEnvelopeV1<CompactRuntimeEventV1>[]>;
}

export interface CompactTransactionRunInputV1 {
  readonly transactionId: string;
  readonly turnId: string;
  readonly prepare: (
    context: {
      readonly source: CompactPrepareSourceReceiptV1;
      readonly history: readonly unknown[];
      readonly taskContext: unknown;
    },
    signal: AbortSignal
  ) => Promise<CompactPreparedCandidateV1>;
  readonly signal?: AbortSignal;
}

export interface CompactTransactionOptionsV1 {
  readonly onBoundary?: (
    boundary: CompactTransactionBoundaryV1,
    context: {
      readonly transactionId: string;
      readonly turnId: string;
      readonly sourceSeq?: number;
      readonly checkpointId?: string;
    }
  ) => void;
}

export interface CompactRecoveryReportV1 {
  readonly version: 1;
  readonly completed: number;
  readonly failed: number;
  readonly receipts: readonly (
    | CompactTransactionCompletedReceiptV1
    | CompactTransactionFailedReceiptV1
  )[];
  readonly digest: string;
}

export const COMPACT_PROTOCOL_V1_ADDITIVE_FIELDS = deepFreeze({
  'compact.started': ['transactionId', 'sourceReceiptDigest', 'startedProjectionDigest'],
  'compact.completed': ['transactionId', 'commitReceiptDigest', 'nextModelVisibleHistoryDigest'],
  'compact.failed': ['transactionId', 'sourceSeq', 'failureCode', 'failureReceiptDigest'],
} as const);

export const COMPACT_EVENT_STORE_ADDITIVE_API =
  'appendCompactCheckpointCas(expectedCursor, expectedProjectionDigest, sourceReceipt, checkpoint, pointer)';

export class CompactTransactionError extends Error {
  constructor(
    readonly code:
      | 'ORION_COMPACT_INVALID'
      | 'ORION_COMPACT_EVENT_CORRUPT'
      | 'ORION_COMPACT_RECOVERY_REQUIRED',
    message: string
  ) {
    super(message);
    this.name = 'CompactTransactionError';
  }
}

export class CompactCrashInjectionError extends Error {
  readonly code = 'ORION_COMPACT_CRASH_INJECTED';

  constructor(
    readonly boundary: CompactTransactionBoundaryV1,
    readonly cause: unknown
  ) {
    super(`Injected Compact transaction crash at ${boundary}.`);
    this.name = 'CompactCrashInjectionError';
  }
}

class CompactStageFailure extends Error {
  constructor(readonly failureCode: CompactTransactionFailureCodeV1) {
    super(failureCode);
    this.name = 'CompactStageFailure';
  }
}

/** Non-steerable maintenance transaction for compact checkpoint replacement. */
export class CompactTransactionV1 {
  readonly version = COMPACT_TRANSACTION_VERSION;

  constructor(
    private readonly persistence: CompactTransactionPersistenceV1,
    private readonly validator: CompactCandidateValidatorV1,
    private readonly options: CompactTransactionOptionsV1 = {}
  ) {
    validateSafeId(validator.id, 'Compact validator id');
    if (!isRuntimeId(persistence.threadId)) {
      throw new CompactTransactionError(
        'ORION_COMPACT_INVALID',
        'Compact persistence threadId must be a UUID.'
      );
    }
  }

  async run(input: CompactTransactionRunInputV1): Promise<CompactTransactionOutcomeV1> {
    validateRuntimeId(input.transactionId, 'Compact transactionId');
    validateRuntimeId(input.turnId, 'Compact maintenance turnId');
    const signal = input.signal ?? new AbortController().signal;
    throwIfAborted(signal);

    const authoritative = await this.persistence.captureSource(input.turnId);
    const sourceContext = normalizeAuthoritativeSource(
      this.persistence.threadId,
      input.turnId,
      authoritative
    );
    const source = createPrepareSourceReceipt(sourceContext);
    this.boundary('after_source_prepare', input, source.cursor);

    const started = await this.persistence.appendCompactEvent({
      turnId: input.turnId,
      payload: {
        type: 'compact.started',
        data: {
          sourceSeq: source.cursor,
          transactionId: input.transactionId,
          sourceReceiptDigest: source.digest,
          // This binds the bracket to the authoritative projection from which
          // it started. The post-append projection is captured separately in
          // CompactEventAnchorV1 because an event cannot contain its own digest.
          startedProjectionDigest: source.projectionDigest,
        },
      },
    });
    assertAppendedEvent(started, this.persistence.threadId, input.turnId, 'compact.started');
    if (started.event.seq !== source.cursor + 1) {
      throw new CompactTransactionError(
        'ORION_COMPACT_EVENT_CORRUPT',
        'compact.started did not immediately follow its prepared source cursor.'
      );
    }
    const startedEvent = deepFreeze({
      cursor: started.event.seq,
      projectionDigest: validateDigest(
        started.projectionDigest,
        'compact.started projection digest'
      ),
    });
    this.boundary('after_started_commit', input, source.cursor);

    let commit: CompactCheckpointCommitReceiptV1 | undefined;
    try {
      throwIfAborted(signal);
      let candidate: CompactPreparedCandidateV1;
      try {
        candidate = normalizeCandidate(
          await input.prepare(
            {
              source,
              history: sourceContext.history,
              taskContext: sourceContext.taskContext,
            },
            signal
          )
        );
      } catch (error) {
        if (error instanceof CompactCrashInjectionError) throw error;
        throw new CompactStageFailure('candidate_prepare_failed');
      }
      this.boundary('after_candidate_prepare', input, source.cursor, candidate.checkpointId);

      const validationContext = candidateValidationContext(source, candidate);
      let valid: boolean;
      try {
        valid = await this.validator.validate(validationContext, signal);
      } catch (error) {
        if (error instanceof CompactCrashInjectionError) throw error;
        throw new CompactStageFailure('candidate_validation_failed');
      }
      if (valid !== true) throw new CompactStageFailure('candidate_rejected');
      const validation = createValidationReceipt(this.validator.id, validationContext);
      this.boundary('after_candidate_validate', input, source.cursor, candidate.checkpointId);

      commit = createCheckpointCommitReceipt(
        input.transactionId,
        source,
        startedEvent,
        candidate,
        validation
      );
      let cas: CompactCompareAndCommitResultV1;
      try {
        cas = await this.persistence.compareAndCommit({
          source,
          expectedEventAnchor: startedEvent,
          candidate,
          commit,
          onBoundary: boundary =>
            this.boundary(boundary, input, source.cursor, candidate.checkpointId),
        });
      } catch (error) {
        if (error instanceof CompactCrashInjectionError) throw error;
        throw new CompactStageFailure('cas_commit_failed');
      }
      if (cas.status === 'conflict') {
        throw new CompactStageFailure(`cas_conflict:${cas.reason}`);
      }
      assertPointerIntegrity(cas.pointer, commit.pointer);

      return {
        status: 'completed',
        receipt: await this.completeCommittedTransaction(commit, false, input),
      };
    } catch (error) {
      if (error instanceof CompactCrashInjectionError) throw error;

      const installed = await this.persistence.findCommittedCheckpoint(input.turnId, source.cursor);
      if (installed) {
        verifyCompactCheckpointCommitReceipt(installed);
        assertCommitMatchesStarted(installed, started.event);
        if (
          installed.transactionId !== input.transactionId ||
          installed.source.digest !== source.digest ||
          installed.startedEvent.projectionDigest !== startedEvent.projectionDigest
        ) {
          throw new CompactTransactionError(
            'ORION_COMPACT_EVENT_CORRUPT',
            'Committed checkpoint does not belong to the active Compact transaction.'
          );
        }
        try {
          return {
            status: 'completed',
            receipt: await this.completeCommittedTransaction(installed, true, input),
          };
        } catch (terminalError) {
          if (terminalError instanceof CompactCrashInjectionError) throw terminalError;
          throw new CompactTransactionError(
            'ORION_COMPACT_RECOVERY_REQUIRED',
            `Checkpoint ${installed.checkpointId} committed without a terminal compact event.`
          );
        }
      }

      const failureCode =
        error instanceof CompactStageFailure ? error.failureCode : 'candidate_prepare_failed';
      const failureReceiptDigest = createFailureDeclarationDigest({
        transactionId: input.transactionId,
        threadId: source.threadId,
        turnId: source.turnId,
        sourceSeq: source.cursor,
        startedSeq: started.event.seq,
        failureCode,
        previousCheckpointId: source.activeCheckpointId,
      });
      const failed = await this.persistence.appendCompactEvent({
        turnId: input.turnId,
        payload: {
          type: 'compact.failed',
          data: {
            error: failureCode,
            transactionId: input.transactionId,
            sourceSeq: source.cursor,
            failureCode,
            failureReceiptDigest,
          },
        },
      });
      assertAppendedEvent(failed, this.persistence.threadId, input.turnId, 'compact.failed');
      if (failed.event.seq <= started.event.seq) {
        throw new CompactTransactionError(
          'ORION_COMPACT_EVENT_CORRUPT',
          'compact.failed did not follow compact.started.'
        );
      }
      const receipt = createFailedReceipt({
        transactionId: input.transactionId,
        threadId: source.threadId,
        turnId: source.turnId,
        source,
        sourceSeq: source.cursor,
        startedSeq: started.event.seq,
        failedSeq: failed.event.seq,
        failureCode,
        previousCheckpointId: source.activeCheckpointId,
      });
      this.boundary('after_failed_commit', input, source.cursor, commit?.checkpointId);
      return { status: 'failed', receipt };
    }
  }

  /** Resolve orphan compact.started events without guessing that candidate work succeeded. */
  async recoverOrphans(): Promise<CompactRecoveryReportV1> {
    const events = [...(await this.persistence.listCompactEvents())].sort(
      (left, right) => left.seq - right.seq
    );
    const orphans = findOrphanStarts(this.persistence.threadId, events);
    const receipts: Array<
      CompactTransactionCompletedReceiptV1 | CompactTransactionFailedReceiptV1
    > = [];
    let completed = 0;
    let failed = 0;

    for (const started of orphans) {
      const turnId = requiredTurnId(started);
      if (started.payload.type !== 'compact.started') continue;
      const sourceSeq = started.payload.data.sourceSeq;
      const commit = await this.persistence.findCommittedCheckpoint(turnId, sourceSeq);
      if (commit) {
        verifyCompactCheckpointCommitReceipt(commit);
        assertCommitMatchesStarted(commit, started);
        receipts.push(await this.completeCommittedTransaction(commit, true));
        completed++;
        continue;
      }

      const terminal = await this.persistence.appendCompactEvent({
        turnId,
        payload: {
          type: 'compact.failed',
          data: {
            error: 'orphaned_before_checkpoint_commit',
            transactionId: started.payload.data.transactionId,
            sourceSeq,
            failureCode: 'orphaned_before_checkpoint_commit',
            failureReceiptDigest: createFailureDeclarationDigest({
              transactionId: started.payload.data.transactionId,
              threadId: this.persistence.threadId,
              turnId,
              sourceSeq,
              startedSeq: started.seq,
              failureCode: 'orphaned_before_checkpoint_commit',
            }),
          },
        },
      });
      assertAppendedEvent(terminal, this.persistence.threadId, turnId, 'compact.failed');
      if (terminal.event.seq <= started.seq) {
        throw new CompactTransactionError(
          'ORION_COMPACT_EVENT_CORRUPT',
          'Recovered compact.failed did not follow compact.started.'
        );
      }
      receipts.push(
        createFailedReceipt({
          transactionId: started.payload.data.transactionId,
          threadId: this.persistence.threadId,
          turnId,
          sourceSeq,
          startedSeq: started.seq,
          failedSeq: terminal.event.seq,
          failureCode: 'orphaned_before_checkpoint_commit',
        })
      );
      failed++;
    }

    const content = {
      version: COMPACT_TRANSACTION_VERSION,
      completed,
      failed,
      receipts,
    } as const;
    return deepFreeze({ ...content, digest: digestRuntimeValue(content) });
  }

  private async completeCommittedTransaction(
    commit: CompactCheckpointCommitReceiptV1,
    recovered: boolean,
    input?: Pick<CompactTransactionRunInputV1, 'transactionId' | 'turnId'>
  ): Promise<CompactTransactionCompletedReceiptV1> {
    verifyCompactCheckpointCommitReceipt(commit);
    const completed = await this.persistence.appendCompactEvent({
      turnId: commit.turnId,
      payload: {
        type: 'compact.completed',
        data: {
          checkpointId: commit.checkpointId,
          sourceSeq: commit.source.cursor,
          transactionId: commit.transactionId,
          commitReceiptDigest: commit.digest,
          nextModelVisibleHistoryDigest: commit.pointer.nextModelVisibleHistoryDigest,
        },
      },
    });
    assertAppendedEvent(completed, this.persistence.threadId, commit.turnId, 'compact.completed');
    if (completed.event.seq <= commit.startedEvent.cursor) {
      throw new CompactTransactionError(
        'ORION_COMPACT_EVENT_CORRUPT',
        'compact.completed did not follow compact.started.'
      );
    }
    const content = {
      version: COMPACT_TRANSACTION_VERSION,
      status: 'completed' as const,
      recovered,
      commit,
      completedSeq: completed.event.seq,
      nextModelVisibleHistoryDigest: commit.pointer.nextModelVisibleHistoryDigest,
    };
    const receipt = deepFreeze({ ...content, digest: digestRuntimeValue(content) });
    if (input) {
      this.boundary('after_completed_commit', input, commit.source.cursor, commit.checkpointId);
    }
    return receipt;
  }

  private boundary(
    boundary: CompactTransactionBoundaryV1,
    input: Pick<CompactTransactionRunInputV1, 'transactionId' | 'turnId'>,
    sourceSeq?: number,
    checkpointId?: string
  ): void {
    try {
      this.options.onBoundary?.(boundary, {
        transactionId: input.transactionId,
        turnId: input.turnId,
        sourceSeq,
        checkpointId,
      });
    } catch (error) {
      throw new CompactCrashInjectionError(boundary, error);
    }
  }
}

export function verifyCompactPrepareSourceReceipt(receipt: CompactPrepareSourceReceiptV1): void {
  const { digest, ...content } = receipt;
  if (
    receipt.version !== COMPACT_TRANSACTION_VERSION ||
    digestRuntimeValue(content) !== digest ||
    !isRuntimeId(receipt.threadId) ||
    !isRuntimeId(receipt.turnId) ||
    receipt.nonSteerable !== true ||
    !isNonNegativeSafeInteger(receipt.cursor) ||
    !isNonNegativeSafeInteger(receipt.historyEntries) ||
    !isNonNegativeSafeInteger(receipt.taskContextRevision)
  ) {
    throw new CompactTransactionError(
      'ORION_COMPACT_INVALID',
      'Compact prepare source receipt failed integrity validation.'
    );
  }
  for (const [value, label] of [
    [receipt.projectionDigest, 'projection'],
    [receipt.historyDigest, 'history'],
    [receipt.taskContextDigest, 'TaskContext'],
    [receipt.digest, 'receipt'],
  ] as const) {
    validateDigest(value, `Compact source ${label} digest`);
  }
}

export function verifyCompactValidationReceipt(receipt: CompactValidationReceiptV1): void {
  const { digest, ...content } = receipt;
  if (
    receipt.version !== COMPACT_TRANSACTION_VERSION ||
    receipt.valid !== true ||
    digestRuntimeValue(content) !== digest
  ) {
    throw new CompactTransactionError(
      'ORION_COMPACT_INVALID',
      'Compact validation receipt failed integrity validation.'
    );
  }
  validateSafeId(receipt.validatorId, 'Compact validator id');
  validateDigest(receipt.sourceReceiptDigest, 'Compact validation source digest');
  validateDigest(receipt.checkpointDigest, 'Compact validation checkpoint digest');
  validateDigest(receipt.nextModelVisibleHistoryDigest, 'Compact validation history digest');
}

export function verifyCompactCheckpointCommitReceipt(
  receipt: CompactCheckpointCommitReceiptV1
): void {
  const { digest, ...content } = receipt;
  if (
    receipt.version !== COMPACT_TRANSACTION_VERSION ||
    digestRuntimeValue(content) !== digest ||
    receipt.threadId !== receipt.source.threadId ||
    receipt.turnId !== receipt.source.turnId ||
    receipt.checkpointId !== receipt.pointer.checkpointId ||
    receipt.transactionId !== receipt.pointer.transactionId ||
    receipt.source.digest !== receipt.pointer.sourceReceiptDigest ||
    receipt.validation.sourceReceiptDigest !== receipt.source.digest ||
    receipt.validation.checkpointDigest !== receipt.checkpointDigest ||
    receipt.validation.nextModelVisibleHistoryDigest !==
      receipt.pointer.nextModelVisibleHistoryDigest ||
    receipt.candidateDigest !==
      digestRuntimeValue({
        checkpointId: receipt.checkpointId,
        checkpointDigest: receipt.checkpointDigest,
        nextModelVisibleHistoryDigest: receipt.pointer.nextModelVisibleHistoryDigest,
      }) ||
    receipt.previousCheckpointId !== receipt.source.activeCheckpointId
  ) {
    throw new CompactTransactionError(
      'ORION_COMPACT_INVALID',
      'Compact checkpoint commit receipt failed integrity validation.'
    );
  }
  validateRuntimeId(receipt.transactionId, 'Compact transactionId');
  validateRuntimeId(receipt.checkpointId, 'Compact checkpointId');
  verifyCompactPrepareSourceReceipt(receipt.source);
  verifyCompactValidationReceipt(receipt.validation);
  verifyPointer(receipt.pointer);
  validateDigest(receipt.checkpointDigest, 'Compact checkpoint digest');
  validateDigest(receipt.candidateDigest, 'Compact candidate digest');
  validateDigest(receipt.startedEvent.projectionDigest, 'Compact started projection digest');
  if (receipt.startedEvent.cursor !== receipt.source.cursor + 1) {
    throw new CompactTransactionError(
      'ORION_COMPACT_INVALID',
      'Compact started event is not adjacent to its source cursor.'
    );
  }
}

function assertCommitMatchesStarted(
  commit: CompactCheckpointCommitReceiptV1,
  started: RuntimeEventEnvelopeV1<CompactRuntimeEventV1>
): void {
  if (
    started.payload.type !== 'compact.started' ||
    commit.threadId !== started.threadId ||
    commit.turnId !== started.turnId ||
    commit.source.cursor !== started.payload.data.sourceSeq ||
    commit.startedEvent.cursor !== started.seq ||
    commit.transactionId !== started.payload.data.transactionId ||
    commit.source.digest !== started.payload.data.sourceReceiptDigest ||
    commit.source.projectionDigest !== started.payload.data.startedProjectionDigest
  ) {
    throw new CompactTransactionError(
      'ORION_COMPACT_EVENT_CORRUPT',
      'Committed checkpoint does not match its compact.started event.'
    );
  }
}

function normalizeAuthoritativeSource(
  threadId: string,
  turnId: string,
  source: CompactAuthoritativeSourceV1
): {
  readonly receipt: CompactPrepareSourceReceiptV1;
  readonly history: readonly unknown[];
  readonly taskContext: unknown;
} {
  if (
    source.threadId !== threadId ||
    source.maintenanceTurn.turnId !== turnId ||
    source.maintenanceTurn.mode !== 'maintenance' ||
    source.maintenanceTurn.active !== true ||
    source.maintenanceTurn.steerable !== false
  ) {
    throw new CompactTransactionError(
      'ORION_COMPACT_INVALID',
      'Compact requires the active non-steerable maintenance turn.'
    );
  }
  if (!Array.isArray(source.history) || source.taskContext === undefined) {
    throw new CompactTransactionError(
      'ORION_COMPACT_INVALID',
      'Compact source requires model history and TaskContext state.'
    );
  }
  if (
    !isNonNegativeSafeInteger(source.cursor) ||
    !isNonNegativeSafeInteger(source.taskContextRevision)
  ) {
    throw new CompactTransactionError(
      'ORION_COMPACT_INVALID',
      'Compact source cursor and TaskContext revision must be non-negative safe integers.'
    );
  }
  validateDigest(source.projectionDigest, 'Compact source projection digest');
  if (source.activeCheckpointId !== null) {
    validateRuntimeId(source.activeCheckpointId, 'Compact active checkpointId');
  }
  const history = immutableClone(source.history);
  const taskContext = immutableClone(source.taskContext);
  const base = {
    version: COMPACT_TRANSACTION_VERSION,
    threadId,
    turnId,
    nonSteerable: true as const,
    cursor: source.cursor,
    projectionDigest: source.projectionDigest,
    historyDigest: digestRuntimeValue(history),
    historyEntries: history.length,
    taskContextDigest: digestRuntimeValue(taskContext),
    taskContextRevision: source.taskContextRevision,
    activeCheckpointId: source.activeCheckpointId,
  };
  const receipt = deepFreeze({ ...base, digest: digestRuntimeValue(base) });
  return deepFreeze({ receipt, history, taskContext });
}

function createPrepareSourceReceipt(source: {
  readonly receipt: CompactPrepareSourceReceiptV1;
}): CompactPrepareSourceReceiptV1 {
  verifyCompactPrepareSourceReceipt(source.receipt);
  return source.receipt;
}

function normalizeCandidate(candidate: CompactPreparedCandidateV1): CompactPreparedCandidateV1 {
  validateRuntimeId(candidate.checkpointId, 'Compact checkpointId');
  if (!Array.isArray(candidate.modelVisibleHistory) || candidate.checkpoint === undefined) {
    throw new CompactTransactionError(
      'ORION_COMPACT_INVALID',
      'Compact candidate requires a checkpoint and model-visible history.'
    );
  }
  return deepFreeze({
    checkpointId: candidate.checkpointId,
    checkpoint: immutableClone(candidate.checkpoint),
    modelVisibleHistory: immutableClone(candidate.modelVisibleHistory),
  });
}

function candidateValidationContext(
  source: CompactPrepareSourceReceiptV1,
  candidate: CompactPreparedCandidateV1
): CompactCandidateValidationContextV1 {
  return deepFreeze({
    source,
    checkpointId: candidate.checkpointId,
    checkpoint: candidate.checkpoint,
    checkpointDigest: digestRuntimeValue(candidate.checkpoint),
    modelVisibleHistory: candidate.modelVisibleHistory,
    nextModelVisibleHistoryDigest: digestRuntimeValue(candidate.modelVisibleHistory),
  });
}

function createValidationReceipt(
  validatorId: string,
  context: CompactCandidateValidationContextV1
): CompactValidationReceiptV1 {
  const base = {
    version: COMPACT_TRANSACTION_VERSION,
    validatorId,
    sourceReceiptDigest: context.source.digest,
    checkpointDigest: context.checkpointDigest,
    nextModelVisibleHistoryDigest: context.nextModelVisibleHistoryDigest,
    valid: true as const,
  };
  return deepFreeze({ ...base, digest: digestRuntimeValue(base) });
}

function createCheckpointCommitReceipt(
  transactionId: string,
  source: CompactPrepareSourceReceiptV1,
  startedEvent: CompactEventAnchorV1,
  candidate: CompactPreparedCandidateV1,
  validation: CompactValidationReceiptV1
): CompactCheckpointCommitReceiptV1 {
  const pointerBase = {
    version: COMPACT_TRANSACTION_VERSION,
    checkpointId: candidate.checkpointId,
    transactionId,
    sourceReceiptDigest: source.digest,
    nextModelVisibleHistoryDigest: validation.nextModelVisibleHistoryDigest,
  };
  const pointer = deepFreeze({ ...pointerBase, digest: digestRuntimeValue(pointerBase) });
  const checkpointDigest = digestRuntimeValue(candidate.checkpoint);
  const candidateDigest = digestRuntimeValue({
    checkpointId: candidate.checkpointId,
    checkpointDigest,
    nextModelVisibleHistoryDigest: validation.nextModelVisibleHistoryDigest,
  });
  const base = {
    version: COMPACT_TRANSACTION_VERSION,
    transactionId,
    threadId: source.threadId,
    turnId: source.turnId,
    source,
    startedEvent,
    checkpointId: candidate.checkpointId,
    checkpointDigest,
    candidateDigest,
    validation,
    previousCheckpointId: source.activeCheckpointId,
    pointer,
  };
  return deepFreeze({ ...base, digest: digestRuntimeValue(base) });
}

function createFailedReceipt(
  input: Omit<CompactTransactionFailedReceiptV1, 'version' | 'status' | 'digest'>
): CompactTransactionFailedReceiptV1 {
  const base = {
    version: COMPACT_TRANSACTION_VERSION,
    status: 'failed' as const,
    ...input,
  };
  return deepFreeze({ ...base, digest: digestRuntimeValue(base) });
}

/**
 * Digest written before compact.failed has an assigned durable sequence. The
 * final failed receipt additionally binds failedSeq.
 */
function createFailureDeclarationDigest(input: {
  readonly transactionId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly sourceSeq: number;
  readonly startedSeq: number;
  readonly failureCode: CompactTransactionFailureCodeV1;
  readonly previousCheckpointId?: string | null;
}): string {
  return digestRuntimeValue({ version: COMPACT_TRANSACTION_VERSION, ...input });
}

function assertPointerIntegrity(
  actual: CompactCheckpointPointerV1,
  expected: CompactCheckpointPointerV1
): void {
  verifyPointer(actual);
  if (actual.digest !== expected.digest) {
    throw new CompactStageFailure('cas_commit_failed');
  }
}

function verifyPointer(pointer: CompactCheckpointPointerV1): void {
  const { digest, ...content } = pointer;
  if (pointer.version !== COMPACT_TRANSACTION_VERSION || digestRuntimeValue(content) !== digest) {
    throw new CompactTransactionError(
      'ORION_COMPACT_INVALID',
      'Compact checkpoint pointer failed integrity validation.'
    );
  }
  validateRuntimeId(pointer.checkpointId, 'Compact pointer checkpointId');
  validateRuntimeId(pointer.transactionId, 'Compact pointer transactionId');
  validateDigest(pointer.sourceReceiptDigest, 'Compact pointer source digest');
  validateDigest(pointer.nextModelVisibleHistoryDigest, 'Compact pointer history digest');
}

function assertAppendedEvent(
  result: CompactEventAppendResultV1,
  threadId: string,
  turnId: string,
  type: CompactRuntimeEventV1['type']
): void {
  if (
    result.event.payload.type !== type ||
    result.event.turnId !== turnId ||
    result.event.threadId !== threadId ||
    result.event.durability !== 'durable' ||
    !Number.isSafeInteger(result.event.seq) ||
    result.event.seq < 1
  ) {
    throw new CompactTransactionError(
      'ORION_COMPACT_EVENT_CORRUPT',
      `Persistence returned an invalid ${type} event.`
    );
  }
  validateDigest(result.projectionDigest, `${type} projection digest`);
}

function findOrphanStarts(
  threadId: string,
  events: readonly RuntimeEventEnvelopeV1<CompactRuntimeEventV1>[]
): RuntimeEventEnvelopeV1<Extract<CompactRuntimeEventV1, { type: 'compact.started' }>>[] {
  const startedByTurn = new Map<
    string,
    RuntimeEventEnvelopeV1<Extract<CompactRuntimeEventV1, { type: 'compact.started' }>>
  >();
  const terminalTurns = new Set<string>();
  let previousSeq = 0;
  for (const event of events) {
    if (event.threadId !== threadId || event.seq <= previousSeq) {
      throw new CompactTransactionError(
        'ORION_COMPACT_EVENT_CORRUPT',
        'Compact event replay is out of order or belongs to another thread.'
      );
    }
    previousSeq = event.seq;
    const turnId = requiredTurnId(event);
    if (event.payload.type === 'compact.started') {
      if (startedByTurn.has(turnId)) {
        throw new CompactTransactionError(
          'ORION_COMPACT_EVENT_CORRUPT',
          `Maintenance turn ${turnId} has multiple compact.started events.`
        );
      }
      startedByTurn.set(
        turnId,
        event as RuntimeEventEnvelopeV1<Extract<CompactRuntimeEventV1, { type: 'compact.started' }>>
      );
      continue;
    }
    const started = startedByTurn.get(turnId);
    if (!started || terminalTurns.has(turnId)) {
      throw new CompactTransactionError(
        'ORION_COMPACT_EVENT_CORRUPT',
        `Maintenance turn ${turnId} has an unmatched compact terminal event.`
      );
    }
    if (
      event.payload.type === 'compact.completed' &&
      (event.payload.data.sourceSeq !== started.payload.data.sourceSeq ||
        event.payload.data.transactionId !== started.payload.data.transactionId)
    ) {
      throw new CompactTransactionError(
        'ORION_COMPACT_EVENT_CORRUPT',
        `Maintenance turn ${turnId} compact sourceSeq changed before completion.`
      );
    }
    if (
      event.payload.type === 'compact.failed' &&
      (event.payload.data.sourceSeq !== started.payload.data.sourceSeq ||
        event.payload.data.transactionId !== started.payload.data.transactionId ||
        event.payload.data.failureCode !== event.payload.data.error)
    ) {
      throw new CompactTransactionError(
        'ORION_COMPACT_EVENT_CORRUPT',
        `Maintenance turn ${turnId} compact failure identity changed before completion.`
      );
    }
    terminalTurns.add(turnId);
  }
  return [...startedByTurn.entries()]
    .filter(([turnId]) => !terminalTurns.has(turnId))
    .map(([, event]) => event);
}

function requiredTurnId(event: RuntimeEventEnvelopeV1<CompactRuntimeEventV1>): string {
  if (!event.turnId || !isRuntimeId(event.turnId)) {
    throw new CompactTransactionError(
      'ORION_COMPACT_EVENT_CORRUPT',
      'Compact event is missing a valid maintenance turnId.'
    );
  }
  return event.turnId;
}

function validateRuntimeId(value: string, label: string): void {
  if (!isRuntimeId(value)) {
    throw new CompactTransactionError('ORION_COMPACT_INVALID', `${label} must be a UUID.`);
  }
}

function validateSafeId(value: string, label: string): void {
  if (!/^[a-z][a-z0-9._:-]{0,127}$/.test(value)) {
    throw new CompactTransactionError(
      'ORION_COMPACT_INVALID',
      `${label} must be a stable safe id.`
    );
  }
}

function validateDigest(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new CompactTransactionError('ORION_COMPACT_INVALID', `${label} must be SHA-256.`);
  }
  return value;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Compact transaction aborted.');
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
