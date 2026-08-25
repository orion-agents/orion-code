import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { canonicalRuntimeJson, digestRuntimeValue } from '../src/runtime/protocol/canonical';
import { createStopDecision } from '../src/framework/stop-decision';
import { createTaskContextService } from '../src/runtime/task-context-service';
import { ThreadEventStore } from '../src/runtime/thread-event-store';
import { ThreadRuntimeV1 } from '../src/runtime/thread-runtime';
import {
  ThreadTurnCommitJournalV1,
  TurnCommitError,
  parseTurnCommitV1,
} from '../src/runtime/turn-commit';

describe('TurnCommitV1', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function createActiveTurn(mode: 'build' | 'plan' = 'build') {
    const root = mkdtempSync(join(tmpdir(), 'orion-turn-commit-'));
    roots.push(root);
    const threadId = randomUUID();
    const turnId = randomUUID();
    const store = new ThreadEventStore(root, threadId);
    store.appendDurableBatch([
      { payload: { type: 'thread.started', data: {} } },
      {
        turnId,
        payload: { type: 'turn.started', data: { input: 'finish work', mode } },
      },
    ]);
    const taskContext = createTaskContextService({ cwd: root, modelId: 'test' });
    return { root, threadId, turnId, store, taskContext };
  }

  test('atomically records history, TaskContext and receipt identities before turn success', () => {
    const { store, turnId, taskContext } = createActiveTurn();
    const stepId = randomUUID();
    const receiptId = randomUUID();
    const receiptContent = {
      version: 1 as const,
      requestId: receiptId,
      threadId: store.threadId,
      turnId,
      stepId,
    };
    const receipt = {
      ...receiptContent,
      digest: digestRuntimeValue(receiptContent),
    };
    store.appendDurable({
      turnId,
      stepId,
      payload: {
        type: 'capability.receipt',
        data: {
          receiptId,
          digest: receipt.digest,
          receipt: canonicalRuntimeJson(receipt),
        },
      },
    });
    const journal = new ThreadTurnCommitJournalV1(store, () => 42);
    const committed = journal.commit({
      turnId,
      history: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'finish work' },
        { role: 'assistant', content: 'done' },
      ],
      taskContextState: taskContext.exportState(),
      taskContextRevision: taskContext.revision,
      goalState: { status: 'completed', generation: 3 },
      compactPointer: { checkpointId: 'checkpoint-1' },
      terminal: { status: 'completed', outcome: 'verified' },
      createdAt: 42,
    });
    store.appendDurable({
      turnId,
      payload: { type: 'turn.completed', data: { outcome: 'verified' } },
    });

    const projection = store.loadProjection();
    expect(projection.turns[turnId]).toMatchObject({
      status: 'completed',
      commit: {
        terminal: 'completed',
        digest: committed.digest,
        outcome: 'verified',
      },
    });
    expect(committed.capabilityReceiptDigests).toEqual([receipt.digest]);
    expect(parseTurnCommitV1(projection.turns[turnId].commit!.receipt).digest).toBe(
      committed.digest
    );
  });

  test('recovers a flushed commit into the same terminal outcome after a crash', () => {
    const { store, turnId, taskContext } = createActiveTurn();
    new ThreadTurnCommitJournalV1(store).commit({
      turnId,
      history: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'finish work' },
        { role: 'assistant', content: 'done' },
      ],
      taskContextState: taskContext.exportState(),
      taskContextRevision: taskContext.revision,
      terminal: { status: 'completed', outcome: 'verified' },
    });

    expect(store.loadProjection().turns[turnId].status).toBe('active');
    const recovered = store.recoverIncomplete();
    expect(recovered.turns[turnId]).toMatchObject({
      status: 'completed',
      commit: { terminal: 'completed', outcome: 'verified' },
    });
  });

  test('binds a typed PlanReceipt to history, TaskContext, StopDecision and capabilities', () => {
    const { store, turnId, taskContext } = createActiveTurn('plan');
    const stepId = randomUUID();
    const receiptId = randomUUID();
    const capability = {
      version: 1 as const,
      requestId: receiptId,
      threadId: store.threadId,
      turnId,
      stepId,
    };
    const capabilityDigest = digestRuntimeValue(capability);
    store.appendDurable({
      turnId,
      stepId,
      payload: {
        type: 'capability.receipt',
        data: {
          receiptId,
          digest: capabilityDigest,
          receipt: canonicalRuntimeJson({ ...capability, digest: capabilityDigest }),
        },
      },
    });
    const plan = '1. Inspect\n2. Implement\n3. Verify';
    const stopDecision = createStopDecision({
      scope: 'request',
      status: 'completed',
      disposition: 'finish_scope',
      reason: { code: 'plan_ready', message: 'Plan is ready.' },
      evidence: [],
      nextActions: [],
      resources: {},
    });
    const commit = new ThreadTurnCommitJournalV1(store, () => 42).commit({
      turnId,
      history: [
        { role: 'user', content: 'finish work' },
        { role: 'assistant', content: plan },
      ],
      taskContextState: taskContext.exportState(),
      taskContextRevision: taskContext.revision,
      stopDecision,
      plan: { plan, returnMode: 'auto', promptReceiptDigest: 'prompt-receipt-v1' },
      terminal: { status: 'completed', outcome: 'plan ready' },
      createdAt: 42,
    });

    const parsed = parseTurnCommitV1(canonicalRuntimeJson(commit));
    const receipt = JSON.parse(parsed.planReceipt!);
    expect(receipt).toMatchObject({
      plan,
      returnMode: 'auto',
      historyDigest: parsed.historyDigest,
      taskContextDigest: parsed.taskContextDigest,
      taskContextRevision: parsed.taskContextRevision,
      stopDecisionDigest: parsed.stopDecisionDigest,
      capabilityReceiptDigests: [capabilityDigest],
      promptReceiptDigest: 'prompt-receipt-v1',
    });
    expect(parsed.planReceiptDigest).toBe(receipt.digest);

    const tamperedReceipt = { ...receipt, plan: 'tampered' };
    const tamperedContent = {
      ...parsed,
      planReceipt: canonicalRuntimeJson(tamperedReceipt),
    };
    const withoutDigest = Object.fromEntries(
      Object.entries(tamperedContent).filter(([key]) => key !== 'digest')
    );
    expect(() =>
      parseTurnCommitV1(
        canonicalRuntimeJson({ ...withoutDigest, digest: digestRuntimeValue(withoutDigest) })
      )
    ).toThrow(TurnCommitError);
  });

  test('refuses to commit while a started Item has no durable terminal', () => {
    const { store, turnId, taskContext } = createActiveTurn();
    store.appendDurable({
      turnId,
      stepId: randomUUID(),
      itemId: randomUUID(),
      payload: { type: 'item.started', data: { kind: 'command', name: 'write_file' } },
    });

    expect(() =>
      new ThreadTurnCommitJournalV1(store).commit({
        turnId,
        history: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'finish work' },
        ],
        taskContextState: taskContext.exportState(),
        taskContextRevision: taskContext.revision,
        terminal: { status: 'completed' },
      })
    ).toThrow(TurnCommitError);
  });

  test('a commit-required ThreadRuntime never publishes uncommitted success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-turn-required-'));
    roots.push(root);
    const store = new ThreadEventStore(root, randomUUID());
    const runtime = new ThreadRuntimeV1({
      store,
      requireTurnCommit: true,
      runner: { run: async () => ({ status: 'completed', outcome: 'unsafe success' }) },
    });

    runtime.dispatch({ type: 'turn.start', data: { input: 'work', mode: 'build' } });
    await runtime.waitForIdle();

    expect(Object.values(store.loadProjection().turns)[0].status).toBe('interrupted');
  });
});
