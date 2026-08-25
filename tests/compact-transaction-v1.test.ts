import { digestRuntimeValue } from '../src/runtime/protocol/canonical';
import type { RuntimeEventEnvelopeV1 } from '../src/runtime/protocol/runtime-protocol-v1';
import {
  COMPACT_EVENT_STORE_ADDITIVE_API,
  COMPACT_PROTOCOL_V1_ADDITIVE_FIELDS,
  CompactCrashInjectionError,
  CompactTransactionV1,
  verifyCompactCheckpointCommitReceipt,
  verifyCompactPrepareSourceReceipt,
  type CompactAuthoritativeSourceV1,
  type CompactCandidateValidatorV1,
  type CompactCheckpointCommitReceiptV1,
  type CompactCheckpointPointerV1,
  type CompactCompareAndCommitInputV1,
  type CompactCompareAndCommitResultV1,
  type CompactEventAppendResultV1,
  type CompactMaintenanceTurnV1,
  type CompactPreparedCandidateV1,
  type CompactRuntimeEventV1,
  type CompactTransactionBoundaryV1,
  type CompactTransactionPersistenceV1,
  type CompactTransactionRunInputV1,
} from '../src/runtime/compact-transaction';

const THREAD_ID = '00000000-0000-4000-8000-000000000001';
const TURN_ID = '00000000-0000-4000-8000-000000000002';
const TRANSACTION_ID = '00000000-0000-4000-8000-000000000003';
const CHECKPOINT_ID = '00000000-0000-4000-8000-000000000004';
const PREVIOUS_CHECKPOINT_ID = '00000000-0000-4000-8000-000000000005';

const ORIGINAL_HISTORY = [{ role: 'user', content: 'Keep the verified constraints.' }] as const;
const NEXT_HISTORY = [{ role: 'system', content: 'Verified compact summary.' }] as const;
const TASK_CONTEXT = { goal: 'ship safely', revisionLabel: 'r7' } as const;
const CHECKPOINT = { summary: 'Verified compact summary.', sourceMessages: 1 } as const;

class FakeCompactPersistence implements CompactTransactionPersistenceV1 {
  readonly threadId = THREAD_ID;
  cursor = 10;
  projectionDigest = digestRuntimeValue({ cursor: this.cursor, state: 'initial' });
  history: readonly unknown[] = structuredClone(ORIGINAL_HISTORY);
  taskContext: unknown = structuredClone(TASK_CONTEXT);
  taskContextRevision = 7;
  activeCheckpointId: string | null = PREVIOUS_CHECKPOINT_ID;
  pointer: CompactCheckpointPointerV1 | null = null;
  maintenanceTurn: CompactMaintenanceTurnV1 = {
    turnId: TURN_ID,
    mode: 'maintenance',
    active: true,
    steerable: false,
  };
  beforeCasMutation?: () => void;

  readonly events: RuntimeEventEnvelopeV1<CompactRuntimeEventV1>[] = [];
  readonly checkpoints = new Map<string, unknown>();
  readonly commits = new Map<string, CompactCheckpointCommitReceiptV1>();

  captureSource(_turnId: string): CompactAuthoritativeSourceV1 {
    return {
      threadId: this.threadId,
      maintenanceTurn: structuredClone(this.maintenanceTurn),
      cursor: this.cursor,
      projectionDigest: this.projectionDigest,
      history: structuredClone(this.history),
      taskContext: structuredClone(this.taskContext),
      taskContextRevision: this.taskContextRevision,
      activeCheckpointId: this.activeCheckpointId,
    };
  }

  appendCompactEvent(input: {
    readonly turnId: string;
    readonly payload: CompactRuntimeEventV1;
  }): CompactEventAppendResultV1 {
    this.cursor++;
    const event: RuntimeEventEnvelopeV1<CompactRuntimeEventV1> = {
      protocolVersion: 1,
      eventId: eventId(this.cursor),
      seq: this.cursor,
      threadId: this.threadId,
      turnId: input.turnId,
      durability: 'durable',
      timestamp: this.cursor * 1_000,
      payload: structuredClone(input.payload),
    };
    this.events.push(event);
    this.projectionDigest = digestRuntimeValue({
      cursor: this.cursor,
      compactEvents: this.events.map(entry => ({
        seq: entry.seq,
        turnId: entry.turnId,
        payload: entry.payload,
      })),
    });
    return { event, projectionDigest: this.projectionDigest };
  }

  compareAndCommit(input: CompactCompareAndCommitInputV1): CompactCompareAndCommitResultV1 {
    const oldPointer = this.pointer;
    const oldCheckpointId = this.activeCheckpointId;
    const oldHistory = structuredClone(this.history);
    let pointerAdvanced = false;

    try {
      input.onBoundary('before_cas_recheck');
      this.beforeCasMutation?.();
      const conflict = this.findConflict(input);
      if (conflict) return { status: 'conflict', reason: conflict };
      input.onBoundary('after_cas_recheck');

      verifyCompactCheckpointCommitReceipt(input.commit);
      this.checkpoints.set(
        input.candidate.checkpointId,
        structuredClone(input.candidate.checkpoint)
      );
      input.onBoundary('after_checkpoint_write');

      this.pointer = input.commit.pointer;
      this.activeCheckpointId = input.candidate.checkpointId;
      this.history = structuredClone(input.candidate.modelVisibleHistory);
      this.commits.set(commitKey(input.commit.turnId, input.source.cursor), input.commit);
      pointerAdvanced = true;
      input.onBoundary('after_pointer_commit');
      return { status: 'committed', pointer: input.commit.pointer };
    } catch (error) {
      if (!pointerAdvanced) {
        this.checkpoints.delete(input.candidate.checkpointId);
        this.pointer = oldPointer;
        this.activeCheckpointId = oldCheckpointId;
        this.history = oldHistory;
        this.commits.delete(commitKey(input.commit.turnId, input.source.cursor));
      }
      throw error;
    }
  }

  findCommittedCheckpoint(
    turnId: string,
    sourceSeq: number
  ): CompactCheckpointCommitReceiptV1 | undefined {
    return this.commits.get(commitKey(turnId, sourceSeq));
  }

  listCompactEvents(): readonly RuntimeEventEnvelopeV1<CompactRuntimeEventV1>[] {
    return structuredClone(this.events);
  }

  private findConflict(
    input: CompactCompareAndCommitInputV1
  ): Exclude<CompactCompareAndCommitResultV1, { status: 'committed' }>['reason'] | undefined {
    if (this.cursor !== input.expectedEventAnchor.cursor) return 'cursor_changed';
    if (this.projectionDigest !== input.expectedEventAnchor.projectionDigest) {
      return 'projection_changed';
    }
    if (digestRuntimeValue(this.history) !== input.source.historyDigest) return 'history_changed';
    if (digestRuntimeValue(this.taskContext) !== input.source.taskContextDigest) {
      return 'task_context_changed';
    }
    if (this.taskContextRevision !== input.source.taskContextRevision) {
      return 'task_context_revision_changed';
    }
    if (this.activeCheckpointId !== input.source.activeCheckpointId) {
      return 'checkpoint_pointer_changed';
    }
    return undefined;
  }
}

describe('CompactTransactionV1', () => {
  test('prepares a digest-bound source, validates, CAS commits, and publishes completion', async () => {
    const persistence = new FakeCompactPersistence();
    const initialProjectionDigest = persistence.projectionDigest;
    let observed: Parameters<CompactTransactionRunInputV1['prepare']>[0] | undefined;
    const transaction = createTransaction(persistence);

    const outcome = await transaction.run(
      runInput(context => {
        observed = context;
        return candidate();
      })
    );

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed' || !observed) throw new Error('Expected completion.');
    expect(observed.source).toMatchObject({
      version: 1,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      nonSteerable: true,
      cursor: 10,
      projectionDigest: initialProjectionDigest,
      historyDigest: digestRuntimeValue(ORIGINAL_HISTORY),
      historyEntries: 1,
      taskContextDigest: digestRuntimeValue(TASK_CONTEXT),
      taskContextRevision: 7,
      activeCheckpointId: PREVIOUS_CHECKPOINT_ID,
    });
    verifyCompactPrepareSourceReceipt(observed.source);
    expect(Object.isFrozen(observed.source)).toBe(true);
    expect(Object.isFrozen(observed.history)).toBe(true);
    expect(Object.isFrozen(observed.history[0])).toBe(true);
    expect(Object.isFrozen(observed.taskContext)).toBe(true);

    expect(persistence.events.map(event => event.payload)).toEqual([
      {
        type: 'compact.started',
        data: {
          sourceSeq: 10,
          transactionId: TRANSACTION_ID,
          sourceReceiptDigest: observed.source.digest,
          startedProjectionDigest: initialProjectionDigest,
        },
      },
      {
        type: 'compact.completed',
        data: {
          checkpointId: CHECKPOINT_ID,
          sourceSeq: 10,
          transactionId: TRANSACTION_ID,
          commitReceiptDigest: outcome.receipt.commit.digest,
          nextModelVisibleHistoryDigest: digestRuntimeValue(NEXT_HISTORY),
        },
      },
    ]);
    expect(persistence.activeCheckpointId).toBe(CHECKPOINT_ID);
    expect(persistence.history).toEqual(NEXT_HISTORY);
    expect(persistence.pointer?.digest).toBe(outcome.receipt.commit.pointer.digest);
    expect(outcome.receipt.nextModelVisibleHistoryDigest).toBe(digestRuntimeValue(NEXT_HISTORY));
    expect(outcome.receipt.completedSeq).toBe(12);
    verifyCompactCheckpointCommitReceipt(outcome.receipt.commit);
  });

  test('rejects a steerable source before recording compact.started', async () => {
    const persistence = new FakeCompactPersistence();
    persistence.maintenanceTurn = {
      ...persistence.maintenanceTurn,
      steerable: true,
    } as unknown as CompactMaintenanceTurnV1;

    await expect(createTransaction(persistence).run(runInput())).rejects.toMatchObject({
      code: 'ORION_COMPACT_INVALID',
    });
    expect(persistence.events).toEqual([]);
    expect(persistence.activeCheckpointId).toBe(PREVIOUS_CHECKPOINT_ID);
  });

  test.each([
    ['candidate_prepare_failed', 'prepare'],
    ['candidate_validation_failed', 'validate'],
    ['candidate_rejected', 'reject'],
  ] as const)('fails closed when %s', async (failureCode, stage) => {
    const persistence = new FakeCompactPersistence();
    const validator = validatorFor(stage);
    const transaction = new CompactTransactionV1(persistence, validator);
    const input = runInput(
      stage === 'prepare'
        ? () => {
            throw new Error('prepare failed');
          }
        : undefined
    );

    const outcome = await transaction.run(input);

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('Expected failure.');
    expect(outcome.receipt.failureCode).toBe(failureCode);
    expect(persistence.events.map(event => event.payload.type)).toEqual([
      'compact.started',
      'compact.failed',
    ]);
    expect(persistence.activeCheckpointId).toBe(PREVIOUS_CHECKPOINT_ID);
    expect(persistence.history).toEqual(ORIGINAL_HISTORY);
    expect(persistence.checkpoints.size).toBe(0);
  });

  test('reports a locked CAS conflict without installing the candidate projection', async () => {
    const persistence = new FakeCompactPersistence();
    persistence.beforeCasMutation = () => {
      persistence.taskContextRevision++;
    };

    const outcome = await createTransaction(persistence).run(runInput());

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('Expected failure.');
    expect(outcome.receipt.failureCode).toBe('cas_conflict:task_context_revision_changed');
    expect(persistence.activeCheckpointId).toBe(PREVIOUS_CHECKPOINT_ID);
    expect(persistence.history).toEqual(ORIGINAL_HISTORY);
    expect(persistence.checkpoints.size).toBe(0);
  });

  test.each([
    'after_started_commit',
    'after_candidate_prepare',
    'after_candidate_validate',
    'before_cas_recheck',
    'after_cas_recheck',
    'after_checkpoint_write',
  ] as const)('rolls back before pointer commit and recovers %s as failed', async boundary => {
    const persistence = new FakeCompactPersistence();
    const transaction = createTransaction(persistence, boundary);

    await expect(transaction.run(runInput())).rejects.toMatchObject({
      code: 'ORION_COMPACT_CRASH_INJECTED',
      boundary,
    });
    expect(persistence.activeCheckpointId).toBe(PREVIOUS_CHECKPOINT_ID);
    expect(persistence.history).toEqual(ORIGINAL_HISTORY);
    expect(persistence.commits.size).toBe(0);
    expect(persistence.checkpoints.size).toBe(0);
    expect(persistence.events.map(event => event.payload.type)).toEqual(['compact.started']);

    const recovered = await createTransaction(persistence).recoverOrphans();
    expect(recovered).toMatchObject({ version: 1, completed: 0, failed: 1 });
    expect(recovered.receipts[0]).toMatchObject({
      status: 'failed',
      failureCode: 'orphaned_before_checkpoint_commit',
      sourceSeq: 10,
      startedSeq: 11,
      failedSeq: 12,
    });
    expect(persistence.events.map(event => event.payload.type)).toEqual([
      'compact.started',
      'compact.failed',
    ]);
  });

  test('crash after source prepare has no durable orphan to recover', async () => {
    const persistence = new FakeCompactPersistence();
    const transaction = createTransaction(persistence, 'after_source_prepare');

    await expect(transaction.run(runInput())).rejects.toBeInstanceOf(CompactCrashInjectionError);
    expect(persistence.events).toEqual([]);
    await expect(createTransaction(persistence).recoverOrphans()).resolves.toMatchObject({
      completed: 0,
      failed: 0,
      receipts: [],
    });
  });

  test('recovery completes an orphan whose checkpoint pointer was already committed', async () => {
    const persistence = new FakeCompactPersistence();
    const transaction = createTransaction(persistence, 'after_pointer_commit');

    await expect(transaction.run(runInput())).rejects.toMatchObject({
      boundary: 'after_pointer_commit',
    });
    expect(persistence.activeCheckpointId).toBe(CHECKPOINT_ID);
    expect(persistence.history).toEqual(NEXT_HISTORY);
    expect(persistence.events.map(event => event.payload.type)).toEqual(['compact.started']);

    const recovery = await createTransaction(persistence).recoverOrphans();
    expect(recovery).toMatchObject({ completed: 1, failed: 0 });
    expect(recovery.receipts[0]).toMatchObject({
      status: 'completed',
      recovered: true,
      nextModelVisibleHistoryDigest: digestRuntimeValue(NEXT_HISTORY),
    });
    expect(persistence.events.map(event => event.payload.type)).toEqual([
      'compact.started',
      'compact.completed',
    ]);
  });

  test('terminal-event crash boundaries leave no orphan to reconcile', async () => {
    const completedPersistence = new FakeCompactPersistence();
    await expect(
      createTransaction(completedPersistence, 'after_completed_commit').run(runInput())
    ).rejects.toMatchObject({ boundary: 'after_completed_commit' });
    expect(completedPersistence.events.map(event => event.payload.type)).toEqual([
      'compact.started',
      'compact.completed',
    ]);
    await expect(createTransaction(completedPersistence).recoverOrphans()).resolves.toMatchObject({
      completed: 0,
      failed: 0,
    });

    const failedPersistence = new FakeCompactPersistence();
    await expect(
      new CompactTransactionV1(failedPersistence, validatorFor('reject'), {
        onBoundary: boundary => crashAt(boundary, 'after_failed_commit'),
      }).run(runInput())
    ).rejects.toMatchObject({ boundary: 'after_failed_commit' });
    expect(failedPersistence.events.map(event => event.payload.type)).toEqual([
      'compact.started',
      'compact.failed',
    ]);
    await expect(createTransaction(failedPersistence).recoverOrphans()).resolves.toMatchObject({
      completed: 0,
      failed: 0,
    });
  });

  test('is deterministic for identical authoritative input and supplied ids', async () => {
    const first = await createTransaction(new FakeCompactPersistence()).run(runInput());
    const second = await createTransaction(new FakeCompactPersistence()).run(runInput());

    expect(first).toEqual(second);
  });

  test('rejects a tampered commit receipt', async () => {
    const outcome = await createTransaction(new FakeCompactPersistence()).run(runInput());
    if (outcome.status !== 'completed') throw new Error('Expected completion.');
    const tampered = structuredClone(outcome.receipt.commit);
    Object.assign(tampered, { candidateDigest: '0'.repeat(64) });

    expect(() => verifyCompactCheckpointCommitReceipt(tampered)).toThrow(
      'Compact checkpoint commit receipt failed integrity validation.'
    );
  });

  test('publishes the exact additive protocol and atomic store gaps', () => {
    expect(COMPACT_PROTOCOL_V1_ADDITIVE_FIELDS).toEqual({
      'compact.started': ['transactionId', 'sourceReceiptDigest', 'startedProjectionDigest'],
      'compact.completed': [
        'transactionId',
        'commitReceiptDigest',
        'nextModelVisibleHistoryDigest',
      ],
      'compact.failed': ['transactionId', 'sourceSeq', 'failureCode', 'failureReceiptDigest'],
    });
    expect(COMPACT_EVENT_STORE_ADDITIVE_API).toContain('appendCompactCheckpointCas');
  });
});

function createTransaction(
  persistence: FakeCompactPersistence,
  crashBoundary?: CompactTransactionBoundaryV1
): CompactTransactionV1 {
  return new CompactTransactionV1(persistence, validatorFor('valid'), {
    onBoundary: boundary => crashAt(boundary, crashBoundary),
  });
}

function runInput(
  prepare: (
    context: Parameters<CompactTransactionRunInputV1['prepare']>[0]
  ) => CompactPreparedCandidateV1 = () => candidate()
): CompactTransactionRunInputV1 {
  return {
    transactionId: TRANSACTION_ID,
    turnId: TURN_ID,
    prepare: async context => prepare(context),
  };
}

function candidate(): CompactPreparedCandidateV1 {
  return {
    checkpointId: CHECKPOINT_ID,
    checkpoint: structuredClone(CHECKPOINT),
    modelVisibleHistory: structuredClone(NEXT_HISTORY),
  };
}

function validatorFor(
  stage: 'valid' | 'validate' | 'reject' | 'prepare'
): CompactCandidateValidatorV1 {
  return {
    id: 'compact.semantic-validator-v1',
    validate: async () => {
      if (stage === 'validate') throw new Error('validator failed');
      return stage !== 'reject';
    },
  };
}

function crashAt(
  boundary: CompactTransactionBoundaryV1,
  crashBoundary?: CompactTransactionBoundaryV1
): void {
  if (boundary === crashBoundary) throw new Error(`crash:${boundary}`);
}

function eventId(sequence: number): string {
  return `00000000-0000-4000-8001-${sequence.toString(16).padStart(12, '0')}`;
}

function commitKey(turnId: string, sourceSeq: number): string {
  return `${turnId}:${sourceSeq}`;
}
