import {
  CompactTransactionV1,
  verifyCompactCheckpointCommitReceipt,
  type CompactAuthoritativeSourceV1,
  type CompactCandidateValidationContextV1,
  type CompactCheckpointCommitReceiptV1,
  type CompactCompareAndCommitInputV1,
  type CompactCompareAndCommitResultV1,
  type CompactEventAppendResultV1,
  type CompactRuntimeEventV1,
  type CompactRecoveryReportV1,
  type CompactCandidateValidatorV1,
  type CompactTransactionPersistenceV1,
} from './compact-transaction';
import { canonicalRuntimeJson, digestRuntimeValue } from './protocol/canonical';
import { createRuntimeId } from './protocol/runtime-protocol-v1';
import type { RuntimeEventEnvelopeV1 } from './protocol/runtime-protocol-v1';
import { ThreadEventStore } from './thread-event-store';
import type {
  ThreadCompactCandidateDraftV1,
  ThreadCompactMaintenanceRequestV1,
  ThreadMaintenanceTurnRunnerV1,
  ThreadTurnExecutionContextV1,
  ThreadTurnOutcomeV1,
} from './thread-runtime';
import type { Message } from '../services/llm';
import { assertToolCallGroups } from '../services/compact/tool-call-groups';

export interface ThreadCompactCheckpointV1 {
  readonly version: 1;
  readonly source: 'automatic' | 'explicit';
  readonly sourceHistoryDigest: string;
  readonly modelVisibleHistoryDigest: string;
  readonly payload: unknown;
  readonly digest: string;
}

export interface ThreadCompactMaintenanceRunnerOptionsV1 {
  readonly validator?: CompactCandidateValidatorV1;
  readonly idFactory?: () => string;
}

/**
 * Production CompactTransaction persistence backed by ThreadEventStore.
 * All authoritative CAS work remains inside ThreadEventStore's log lock.
 */
export class ThreadCompactTransactionPersistenceV1 implements CompactTransactionPersistenceV1 {
  readonly threadId: string;

  constructor(private readonly store: ThreadEventStore) {
    this.threadId = store.threadId;
  }

  captureSource(turnId: string): CompactAuthoritativeSourceV1 {
    return this.store.captureCompactSource(turnId);
  }

  appendCompactEvent(input: {
    readonly turnId: string;
    readonly payload: CompactRuntimeEventV1;
  }): CompactEventAppendResultV1 {
    const commit = this.store.appendDurableBatch([
      {
        turnId: input.turnId,
        payload: input.payload,
      },
    ]);
    return {
      event: commit.events[0] as RuntimeEventEnvelopeV1<CompactRuntimeEventV1>,
      projectionDigest: commit.projection.digest,
    };
  }

  compareAndCommit(input: CompactCompareAndCommitInputV1): CompactCompareAndCommitResultV1 {
    verifyCompactCheckpointCommitReceipt(input.commit);
    return this.store.appendCompactCheckpointCas(input);
  }

  findCommittedCheckpoint(
    turnId: string,
    sourceSeq: number
  ): CompactCheckpointCommitReceiptV1 | undefined {
    const commit = this.store.findCompactCheckpointCommit(turnId, sourceSeq);
    if (commit) verifyCompactCheckpointCommitReceipt(commit);
    return commit;
  }

  listCompactEvents(): readonly RuntimeEventEnvelopeV1<CompactRuntimeEventV1>[] {
    return this.store.listCompactEvents();
  }

  loadModelVisibleHistory(): readonly unknown[] | undefined {
    return this.store.loadAuthoritativeModelHistory();
  }
}

/** Create the checkpoint envelope shared by automatic and explicit production compaction. */
export function createThreadCompactCandidateDraftV1(input: {
  readonly source: ThreadCompactMaintenanceRequestV1['source'];
  readonly sourceHistoryDigest: string;
  readonly modelVisibleHistory: readonly unknown[];
  readonly payload: unknown;
}): ThreadCompactCandidateDraftV1 {
  const history = structuredClone(input.modelVisibleHistory);
  const content = {
    version: 1 as const,
    source: input.source,
    sourceHistoryDigest: input.sourceHistoryDigest,
    modelVisibleHistoryDigest: digestRuntimeValue(history),
    payload: structuredClone(input.payload),
  };
  return Object.freeze({
    checkpoint: deepFreeze({ ...content, digest: digestRuntimeValue(content) }),
    modelVisibleHistory: deepFreeze(history),
  });
}

/** Executes CompactTransaction inside one ThreadRuntime maintenance turn. */
export class ThreadCompactMaintenanceRunnerV1 implements ThreadMaintenanceTurnRunnerV1 {
  private readonly transaction: CompactTransactionV1;
  private readonly idFactory: () => string;

  constructor(store: ThreadEventStore, options: ThreadCompactMaintenanceRunnerOptionsV1 = {}) {
    this.idFactory = options.idFactory ?? createRuntimeId;
    this.transaction = new CompactTransactionV1(
      new ThreadCompactTransactionPersistenceV1(store),
      options.validator ?? PRODUCTION_COMPACT_VALIDATOR
    );
  }

  recoverOrphans(): Promise<CompactRecoveryReportV1> {
    return this.transaction.recoverOrphans();
  }

  async run(
    request: ThreadCompactMaintenanceRequestV1,
    context: ThreadTurnExecutionContextV1
  ): Promise<ThreadTurnOutcomeV1> {
    if (context.kind !== 'maintenance' || context.mode !== 'maintenance') {
      throw new Error('Compact runner requires a maintenance turn');
    }
    const item = context.startItem({
      kind: 'compact',
      name: `compact:${request.source}`,
      inputDigest: digestRuntimeValue({ type: request.type, source: request.source }),
    });
    let outcome: Awaited<ReturnType<CompactTransactionV1['run']>>;
    try {
      outcome = await this.transaction.run({
        transactionId: this.idFactory(),
        turnId: context.turnId,
        signal: context.abortSignal,
        prepare: async (source, signal) => {
          const draft = await request.prepare(source, signal);
          return {
            checkpointId: this.idFactory(),
            checkpoint: draft.checkpoint,
            modelVisibleHistory: draft.modelVisibleHistory,
          };
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.failItem(item, message);
      return { status: 'failed', error: message };
    }
    if (outcome.status === 'failed') {
      context.failItem(item, outcome.receipt.failureCode);
      return { status: 'failed', error: outcome.receipt.failureCode };
    }
    context.completeItem(item, {
      content: canonicalRuntimeJson(outcome.receipt),
      summary: `Compact checkpoint ${outcome.receipt.commit.checkpointId} committed`,
      outputDigest: outcome.receipt.digest,
    });
    return {
      status: 'completed',
      outcome: canonicalRuntimeJson({
        checkpointId: outcome.receipt.commit.checkpointId,
        historyDigest: outcome.receipt.nextModelVisibleHistoryDigest,
      }),
    };
  }
}

const PRODUCTION_COMPACT_VALIDATOR: CompactCandidateValidatorV1 = Object.freeze({
  id: 'compact.production-history-v1',
  validate: (context: CompactCandidateValidationContextV1) => {
    if (!isThreadCompactCheckpoint(context.checkpoint)) return false;
    if (
      context.checkpoint.sourceHistoryDigest !== context.source.historyDigest ||
      context.checkpoint.modelVisibleHistoryDigest !== context.nextModelVisibleHistoryDigest
    ) {
      return false;
    }
    if (!context.modelVisibleHistory.every(isMessage)) return false;
    try {
      assertToolCallGroups(context.modelVisibleHistory as Message[]);
      return true;
    } catch {
      return false;
    }
  },
});

function isThreadCompactCheckpoint(value: unknown): value is ThreadCompactCheckpointV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const checkpoint = value as Partial<ThreadCompactCheckpointV1>;
  if (
    checkpoint.version !== 1 ||
    (checkpoint.source !== 'automatic' && checkpoint.source !== 'explicit') ||
    typeof checkpoint.sourceHistoryDigest !== 'string' ||
    typeof checkpoint.modelVisibleHistoryDigest !== 'string' ||
    typeof checkpoint.digest !== 'string'
  ) {
    return false;
  }
  const { digest, ...content } = checkpoint;
  return digestRuntimeValue(content) === digest;
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Partial<Message>;
  return (
    (message.role === 'system' ||
      message.role === 'user' ||
      message.role === 'assistant' ||
      message.role === 'tool') &&
    typeof message.content === 'string'
  );
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}
