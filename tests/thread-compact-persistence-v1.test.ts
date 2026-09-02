import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  CompactTransactionV1,
  type CompactCandidateValidatorV1,
  type CompactPreparedCandidateV1,
  type CompactTransactionBoundaryV1,
} from '../src/runtime/compact-transaction';
import { digestRuntimeValue } from '../src/runtime/protocol/canonical';
import { createTaskContextService } from '../src/runtime/task-context-service';
import { ThreadCompactTransactionPersistenceV1 } from '../src/runtime/thread-compact-persistence';
import {
  ThreadEventStore,
  threadEventStorePerformanceCountersV1,
} from '../src/runtime/thread-event-store';
import { ThreadTurnCommitJournalV1 } from '../src/runtime/turn-commit';

describe('ThreadCompactTransactionPersistenceV1', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('atomically installs checkpoint, history and pointer against a durable TurnCommit', async () => {
    const fixture = createMaintenanceFixture();
    const nextHistory = [{ role: 'system', content: 'bounded compact summary' }] as const;
    const transaction = createTransaction(fixture.store);

    const outcome = await transaction.run({
      transactionId: randomUUID(),
      turnId: fixture.maintenanceTurnId,
      prepare: async () => candidate(nextHistory),
    });

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('Expected compact completion');
    expect(existsSync(fixture.store.compactStatePath)).toBe(true);
    expect(fixture.store.captureCompactSource(fixture.maintenanceTurnId)).toMatchObject({
      history: nextHistory,
      activeCheckpointId: outcome.receipt.commit.checkpointId,
      taskContextRevision: fixture.taskContextRevision,
    });
    expect(outcome.receipt.nextModelVisibleHistoryDigest).toBe(digestRuntimeValue(nextHistory));
    expect(fixture.store.listCompactEvents().map(event => event.payload.type)).toEqual([
      'compact.started',
      'compact.completed',
    ]);

    const countersBefore = threadEventStorePerformanceCountersV1();
    const reopened = new ThreadEventStore(fixture.store.rootDir, fixture.store.threadId);
    expect(reopened.listCompactEvents().map(event => event.payload.type)).toEqual([
      'compact.started',
      'compact.completed',
    ]);
    expect(reopened.loadAuthoritativeModelHistory()).toEqual(nextHistory);
    const countersAfter = threadEventStorePerformanceCountersV1();
    expect(countersAfter.logScans - countersBefore.logScans).toBe(0);
    expect(countersAfter.bytesScanned - countersBefore.bytesScanned).toBe(0);
  });

  test('cursor drift fails closed and leaves the old model-visible history authoritative', async () => {
    const fixture = createMaintenanceFixture();
    const transaction = createTransaction(fixture.store, boundary => {
      if (boundary !== 'after_started_commit') return;
      fixture.store.appendDurable({
        turnId: fixture.maintenanceTurnId,
        payload: {
          type: 'approval.requested',
          data: { requestId: randomUUID(), toolName: 'compact-observer' },
        },
      });
    });

    const outcome = await transaction.run({
      transactionId: randomUUID(),
      turnId: fixture.maintenanceTurnId,
      prepare: async () => candidate([{ role: 'system', content: 'must not install' }]),
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      receipt: { failureCode: 'cas_conflict:cursor_changed' },
    });
    expect(existsSync(fixture.store.compactStatePath)).toBe(false);
    expect(fixture.store.captureCompactSource(fixture.maintenanceTurnId).history).toEqual(
      fixture.originalHistory
    );
  });

  test('a crash after checkpoint write preserves the old pointer and resumes orphan as failed', async () => {
    const fixture = createMaintenanceFixture();
    const transaction = createTransaction(fixture.store, boundary => {
      if (boundary === 'after_checkpoint_write') throw new Error('simulated process crash');
    });

    await expect(
      transaction.run({
        transactionId: randomUUID(),
        turnId: fixture.maintenanceTurnId,
        prepare: async () => candidate([{ role: 'system', content: 'uncommitted summary' }]),
      })
    ).rejects.toMatchObject({ boundary: 'after_checkpoint_write' });

    expect(existsSync(fixture.store.compactStatePath)).toBe(false);
    expect(fixture.store.captureCompactSource(fixture.maintenanceTurnId).history).toEqual(
      fixture.originalHistory
    );
    await expect(createTransaction(fixture.store).recoverOrphans()).resolves.toMatchObject({
      completed: 0,
      failed: 1,
    });
  });

  test('a crash after pointer commit resumes to the same history digest as uninterrupted compact', async () => {
    const interrupted = createMaintenanceFixture();
    const uninterrupted = createMaintenanceFixture();
    const nextHistory = [{ role: 'system', content: 'equivalent compact history' }] as const;
    const interruptedTransaction = createTransaction(interrupted.store, boundary => {
      if (boundary === 'after_pointer_commit') throw new Error('simulated process crash');
    });

    await expect(
      interruptedTransaction.run({
        transactionId: randomUUID(),
        turnId: interrupted.maintenanceTurnId,
        prepare: async () => candidate(nextHistory),
      })
    ).rejects.toMatchObject({ boundary: 'after_pointer_commit' });
    const recovery = await createTransaction(interrupted.store).recoverOrphans();
    const normal = await createTransaction(uninterrupted.store).run({
      transactionId: randomUUID(),
      turnId: uninterrupted.maintenanceTurnId,
      prepare: async () => candidate(nextHistory),
    });

    expect(recovery).toMatchObject({ completed: 1, failed: 0 });
    expect(normal.status).toBe('completed');
    expect(
      digestRuntimeValue(
        interrupted.store.captureCompactSource(interrupted.maintenanceTurnId).history
      )
    ).toBe(
      digestRuntimeValue(
        uninterrupted.store.captureCompactSource(uninterrupted.maintenanceTurnId).history
      )
    );
  });

  function createMaintenanceFixture() {
    const root = mkdtempSync(join(tmpdir(), 'orion-thread-compact-'));
    roots.push(root);
    const store = new ThreadEventStore(root, randomUUID());
    const regularTurnId = randomUUID();
    const maintenanceTurnId = randomUUID();
    const originalHistory = [
      { role: 'system' as const, content: 'system contract' },
      { role: 'user' as const, content: 'complete the implementation' },
      { role: 'assistant' as const, content: 'verified progress' },
    ];
    store.appendDurableBatch([
      { payload: { type: 'thread.started', data: {} } },
      {
        turnId: regularTurnId,
        payload: {
          type: 'turn.started',
          data: { input: 'complete the implementation', mode: 'build' },
        },
      },
    ]);
    const taskContext = createTaskContextService({ cwd: root, modelId: 'test-model' });
    taskContext.observeUserInput('complete the implementation');
    new ThreadTurnCommitJournalV1(store).commit({
      turnId: regularTurnId,
      history: originalHistory,
      taskContextState: taskContext.exportState(),
      taskContextRevision: taskContext.revision,
      terminal: { status: 'completed', outcome: 'progress persisted' },
    });
    store.appendDurableBatch([
      {
        turnId: regularTurnId,
        payload: { type: 'turn.completed', data: { outcome: 'progress persisted' } },
      },
      {
        turnId: maintenanceTurnId,
        payload: {
          type: 'turn.started',
          data: { input: 'compact context', mode: 'maintenance' },
        },
      },
    ]);
    return {
      root,
      store,
      maintenanceTurnId,
      originalHistory,
      taskContextRevision: taskContext.revision,
    };
  }
});

function createTransaction(
  store: ThreadEventStore,
  onBoundary?: (boundary: CompactTransactionBoundaryV1) => void
): CompactTransactionV1 {
  return new CompactTransactionV1(new ThreadCompactTransactionPersistenceV1(store), VALIDATOR, {
    onBoundary: boundary => onBoundary?.(boundary),
  });
}

const VALIDATOR: CompactCandidateValidatorV1 = {
  id: 'compact.thread-store-validator-v1',
  validate: async () => true,
};

function candidate(modelVisibleHistory: readonly unknown[]): CompactPreparedCandidateV1 {
  return {
    checkpointId: randomUUID(),
    checkpoint: { summary: 'bounded compact summary', version: 1 },
    modelVisibleHistory,
  };
}
