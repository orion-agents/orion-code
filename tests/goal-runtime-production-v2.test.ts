import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { LoopFinishReason, LoopStats, QueryEvent } from '../src/framework/query';
import { createStopDecision } from '../src/framework/stop-decision';
import type { HarnessState } from '../src/harness/types';
import type { AgentLoopTurnCommitV1 } from '../src/runtime/agent-loop';
import {
  GoalRuntimeCoordinatorV2,
  type GoalRuntimeCommitFieldsV2,
} from '../src/runtime/goal-runtime-coordinator';
import { digestRuntimeValue } from '../src/runtime/protocol/canonical';
import { ThreadEventStore } from '../src/runtime/thread-event-store';
import { ThreadRuntimeV1, type ThreadTurnRunnerV1 } from '../src/runtime/thread-runtime';
import {
  parseTurnCommitV1,
  ThreadTurnCommitJournalV1,
  type TurnCommitV1,
} from '../src/runtime/turn-commit';

describe('GoalRuntimeCoordinatorV2 production boundary', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('keeps productive Goals unbounded by turn count and advances only after durable receipt', () => {
    let now = 1_000;
    const goal = new GoalRuntimeCoordinatorV2({
      definition: {
        objective: 'Ship only after durable verification',
        budget: { maxTokens: 1_000_000, maxElapsedMs: 1_000_000 },
      },
      clock: () => now,
    });

    const failedTurn = createAgentCommit({ turnId: randomUUID(), progress: true });
    const beforeFailure = goal.state;
    expect(() =>
      goal.commitTurn(failedTurn, () => {
        throw new Error('fsync failed');
      })
    ).toThrow('fsync failed');
    expect(goal.state).toEqual(beforeFailure);
    expect(goal.afterDurableTerminal(failedTurn.turnId, 'completed')).toBeUndefined();

    for (let index = 0; index < 25; index++) {
      now += 10;
      const turn = createAgentCommit({ turnId: randomUUID(), progress: true, revision: index + 1 });
      goal.markTurnStarted(turn.turnId, now - 5);
      const receipt = goal.commitTurn(turn, fields =>
        durableReceipt(turn.turnId, 'completed', fields)
      );
      expect(receipt.goalStateDigest).toBe(digestRuntimeValue(goal.state));
      expect(goal.state).toMatchObject({ status: 'active', continuationCount: index + 1 });
      expect(goal.afterDurableTerminal(turn.turnId, 'completed')).toMatchObject({
        mode: 'goal',
        kind: 'goal',
      });
      expect(goal.afterDurableTerminal(turn.turnId, 'completed')).toBeUndefined();
    }

    const completionTurn = createAgentCommit({
      turnId: randomUUID(),
      progress: true,
      revision: 26,
      complete: true,
    });
    goal.commitTurn(completionTurn, fields =>
      durableReceipt(completionTurn.turnId, 'completed', fields)
    );
    expect(goal.state).toMatchObject({
      status: 'completed',
      continuationCount: 26,
      lastStopDecision: { scope: 'goal', reason: { code: 'verified_completion' } },
    });
    expect(goal.afterDurableTerminal(completionTurn.turnId, 'completed')).toBeUndefined();
  });

  test('restores one continuation and fails closed on accounting, provider and interrupt boundaries', () => {
    const productive = new GoalRuntimeCoordinatorV2({
      definition: {
        objective: 'Recover the durable Goal',
        budget: { maxTokens: 100_000, maxElapsedMs: 100_000 },
      },
    });
    const first = createAgentCommit({ turnId: randomUUID(), progress: true });
    productive.commitTurn(first, fields => durableReceipt(first.turnId, 'completed', fields));
    const state = productive.state!;
    const restored = new GoalRuntimeCoordinatorV2({
      restoredCommit: {
        terminal: 'completed',
        turnId: first.turnId,
        goalState: JSON.stringify(state),
        goalStateDigest: digestRuntimeValue(state),
      } as ReturnType<typeof parseTurnCommitV1>,
    });
    expect(restored.takeRestoredContinuation()).toMatchObject({ mode: 'goal', kind: 'goal' });
    expect(restored.takeRestoredContinuation()).toBeUndefined();

    const missingUsage = new GoalRuntimeCoordinatorV2({
      definition: {
        objective: 'Never continue with unknown accounting',
        budget: { maxTokens: 100_000, maxElapsedMs: 100_000 },
      },
    });
    const unaccounted = createAgentCommit({
      turnId: randomUUID(),
      progress: true,
      includeUsage: false,
    });
    missingUsage.commitTurn(unaccounted, fields =>
      durableReceipt(unaccounted.turnId, 'completed', fields)
    );
    expect(missingUsage.state).toMatchObject({
      status: 'failed',
      lastStopDecision: { reason: { code: 'persistence_error' } },
    });

    const provider = new GoalRuntimeCoordinatorV2({
      definition: {
        objective: 'Pause when the provider fails',
        budget: { maxTokens: 100_000, maxElapsedMs: 100_000 },
      },
    });
    const providerTurn = createAgentCommit({
      turnId: randomUUID(),
      progress: false,
      finishReason: 'failed',
      providerFailure: true,
    });
    provider.commitTurn(providerTurn, fields =>
      durableReceipt(providerTurn.turnId, 'failed', fields)
    );
    expect(provider.state).toMatchObject({
      status: 'paused',
      lastStopDecision: { reason: { code: 'provider_failure' } },
    });
    expect(provider.afterDurableTerminal(providerTurn.turnId, 'failed')).toBeUndefined();

    const interrupted = new GoalRuntimeCoordinatorV2({
      definition: {
        objective: 'Do not ghost continue after shutdown',
        budget: { maxTokens: 100_000, maxElapsedMs: 100_000 },
      },
    });
    const cancelled = createAgentCommit({
      turnId: randomUUID(),
      progress: true,
      finishReason: 'cancelled',
      includeUsage: false,
    });
    interrupted.commitTurn(cancelled, fields =>
      durableReceipt(cancelled.turnId, 'interrupted', fields)
    );
    expect(interrupted.state?.status).toBe('paused');
    interrupted.close();
    expect(interrupted.afterDurableTerminal(cancelled.turnId, 'interrupted')).toBeUndefined();
  });

  test('enforces Goal token, no-progress and repeated-blocker policies on the production path', () => {
    const budget = createCoordinator({ maxTokens: 20, maxElapsedMs: 100_000 });
    const budgetFirst = createAgentCommit({ turnId: randomUUID(), progress: true });
    commitAndTerminal(budget, budgetFirst, 'completed');
    expect(budget.state?.status).toBe('active');
    const budgetSecond = createAgentCommit({ turnId: randomUUID(), progress: true });
    commitAndTerminal(budget, budgetSecond, 'completed');
    expect(budget.state).toMatchObject({
      status: 'paused',
      lastStopDecision: { reason: { code: 'goal_budget' } },
    });

    const noProgress = createCoordinator();
    for (let index = 0; index < 3; index++) {
      const turn = createAgentCommit({ turnId: randomUUID(), progress: false });
      commitAndTerminal(noProgress, turn, 'completed');
    }
    expect(noProgress.state).toMatchObject({
      status: 'paused',
      lastStopDecision: { reason: { code: 'no_progress' } },
    });

    const blocked = createCoordinator();
    for (let index = 0; index < 2; index++) {
      const turn = createAgentCommit({
        turnId: randomUUID(),
        progress: false,
        finishReason: 'blocked',
        blocked: true,
      });
      commitAndTerminal(blocked, turn, 'completed');
    }
    expect(blocked.state).toMatchObject({
      status: 'paused',
      lastStopDecision: { reason: { code: 'blocked' } },
    });
  });

  test('starts continuation strictly after the previous durable terminal and auto-exits on completion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-goal-runtime-v2-'));
    roots.push(root);
    const store = new ThreadEventStore(root, randomUUID());
    const journal = new ThreadTurnCommitJournalV1(store);
    const goal = new GoalRuntimeCoordinatorV2({
      definition: {
        objective: 'Complete on the second verified turn',
        budget: { maxTokens: 100_000, maxElapsedMs: 100_000 },
      },
    });
    let runCount = 0;
    const runner: ThreadTurnRunnerV1 = {
      run: async context => {
        runCount++;
        const commit = createAgentCommit({
          turnId: context.turnId,
          revision: runCount,
          progress: true,
          complete: runCount === 2,
        });
        goal.commitTurn(commit, fields =>
          journal.commit({
            turnId: context.turnId,
            history: commit.history,
            taskContextState: commit.taskContextState,
            taskContextRevision: commit.taskContextRevision,
            terminal: { status: 'completed', outcome: `turn-${runCount}` },
            ...(fields.goalState ? { goalState: fields.goalState } : {}),
            ...(fields.stopDecision ? { stopDecision: fields.stopDecision } : {}),
          })
        );
        return { status: 'completed', outcome: `turn-${runCount}` };
      },
    };
    const runtime = new ThreadRuntimeV1({
      store,
      runner,
      requireTurnCommit: true,
      onTurnStarted: turn => goal.markTurnStarted(turn.turnId, turn.startedAt),
      onTurnDurablyTerminal: terminal =>
        goal.afterDurableTerminal(terminal.turnId, terminal.terminal),
    });

    expect(
      runtime.dispatch({
        type: 'turn.start',
        data: { input: 'start the Goal', mode: 'goal' },
      })
    ).toMatchObject({ status: 'started' });
    await runtime.waitForIdle();

    expect(runCount).toBe(2);
    expect(goal.state?.status).toBe('completed');
    const events = store.replay(0).events;
    const terminals = events.filter(event => event.payload.type === 'turn.completed');
    const starts = events.filter(event => event.payload.type === 'turn.started');
    expect(terminals).toHaveLength(2);
    expect(starts).toHaveLength(2);
    expect(terminals[0].seq).toBeLessThan(starts[1].seq);

    const turns = Object.values(runtime.getProjection().turns).sort(
      (left, right) => left.startedSeq - right.startedSeq
    );
    expect(turns.map(turn => turn.status)).toEqual(['completed', 'completed']);
    expect(turns[1].mode).toBe('goal');
    const finalCommit = parseTurnCommitV1(turns[1].commit!.receipt);
    expect(JSON.parse(finalCommit.goalState!)).toMatchObject({ status: 'completed' });
    expect(JSON.parse(finalCommit.stopDecision!)).toMatchObject({
      scope: 'goal',
      reason: { code: 'verified_completion' },
    });
    runtime.close();
  });

  test('persists typed create/pause/resume/clear controls and a restart-safe tombstone', () => {
    let now = 10;
    const coordinator = new GoalRuntimeCoordinatorV2({ clock: () => now++ });
    const persist = (turnId: string) =>
      (fields: GoalRuntimeCommitFieldsV2) =>
        durableReceipt(turnId, 'completed', fields);

    const createTurn = randomUUID();
    const created = coordinator.control(
      { action: 'create', objective: 'Ship the typed Goal runtime' },
      createTurn,
      persist(createTurn)
    );
    expect(created).toMatchObject({ accepted: true, state: { status: 'active' } });
    expect(coordinator.afterDurableTerminal(createTurn, 'completed')).toMatchObject({
      mode: 'goal',
    });

    const pauseTurn = randomUUID();
    expect(coordinator.control({ action: 'pause' }, pauseTurn, persist(pauseTurn))).toMatchObject({
      accepted: true,
      state: { status: 'paused' },
    });
    const resumeTurn = randomUUID();
    expect(
      coordinator.control({ action: 'resume' }, resumeTurn, persist(resumeTurn))
    ).toMatchObject({ accepted: true, state: { status: 'active' } });

    const clearTurn = randomUUID();
    const cleared = coordinator.control({ action: 'clear' }, clearTurn, persist(clearTurn));
    expect(cleared).toMatchObject({ accepted: true, tombstone: { kind: 'goal_tombstone' } });
    expect(coordinator.state).toBeUndefined();
    expect(coordinator.control({ action: 'status' }, 'status')).toMatchObject({
      accepted: true,
      tombstone: { kind: 'goal_tombstone' },
    });

    const tombstone = cleared.tombstone!;
    const restored = new GoalRuntimeCoordinatorV2({
      restoredCommit: {
        terminal: 'completed',
        turnId: clearTurn,
        goalState: JSON.stringify(tombstone),
        goalStateDigest: digestRuntimeValue(tombstone),
      } as TurnCommitV1,
    });
    expect(restored.state).toBeUndefined();
    expect(restored.tombstone).toEqual(tombstone);
    expect(restored.takeRestoredContinuation()).toBeUndefined();
  });

  test('runs Goal control as a non-steerable committed maintenance turn without the model runner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-goal-control-turn-'));
    roots.push(root);
    const store = new ThreadEventStore(root, randomUUID());
    const journal = new ThreadTurnCommitJournalV1(store);
    const goal = createCoordinator();
    const runner: ThreadTurnRunnerV1 = {
      run: jest.fn(async () => ({ status: 'completed' as const })),
    };
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const runtime = new ThreadRuntimeV1({ store, runner, requireTurnCommit: true });

    const admission = runtime.startGoalControl({
      type: 'goal_control',
      input: 'goal-control:pause',
      run: async context => {
        goal.control({ action: 'pause' }, context.turnId, fields =>
          journal.commit({
            turnId: context.turnId,
            history: [],
            taskContextState: { ledger: [], updatedAt: 0 },
            taskContextRevision: 0,
            terminal: { status: 'completed', outcome: 'goal_control:pause' },
            ...(fields.goalState ? { goalState: fields.goalState } : {}),
            ...(fields.stopDecision ? { stopDecision: fields.stopDecision } : {}),
          })
        );
        await gate;
        return { status: 'completed', outcome: 'goal_control:pause' };
      },
    });
    expect(admission).toMatchObject({ status: 'started' });
    expect(runtime.dispatch({ type: 'turn.steer', data: { input: 'must not steer' } })).toEqual({
      status: 'rejected',
      reason: 'non_steerable',
    });
    release();
    await runtime.waitForIdle();

    expect(runner.run).not.toHaveBeenCalled();
    expect(goal.state?.status).toBe('paused');
    const turn = Object.values(runtime.getProjection().turns)[0];
    expect(turn).toMatchObject({ mode: 'maintenance', status: 'completed' });
    expect(parseTurnCommitV1(turn.commit!.receipt)).toMatchObject({ terminal: 'completed' });
    runtime.close();
  });
});

function createAgentCommit(input: {
  readonly turnId: string;
  readonly revision?: number;
  readonly progress: boolean;
  readonly complete?: boolean;
  readonly includeUsage?: boolean;
  readonly finishReason?: LoopFinishReason;
  readonly providerFailure?: boolean;
  readonly blocked?: boolean;
}): AgentLoopTurnCommitV1 {
  const revision = input.revision ?? 1;
  const finishReason = input.finishReason ?? 'completed';
  const stats: LoopStats = {
    turnsStarted: 1,
    llmRequests: 1,
    toolCalls: input.progress ? 1 : 0,
    readOnlyToolCalls: 0,
    unsafeToolCalls: 0,
    toolResultBytes: 0,
    modelVisibleToolBytes: 0,
    summarizedBytes: 0,
    finishReason,
    lastToolSuccess: input.progress,
    providerRetryErrorTypes: input.providerFailure ? ['provider_busy'] : [],
    providerLastRetryErrorType: input.providerFailure ? 'provider_busy' : undefined,
    singleReadOnlyStreak: 0,
    batchReadSuggestionCount: 0,
    localFastPathUsed: false,
    ...(input.blocked
      ? {
          stopDecision: createStopDecision({
            scope: 'request',
            status: 'blocked',
            disposition: 'resume_allowed',
            reason: { code: 'blocked', message: 'Waiting for external state.' },
            evidence: [{ kind: 'runtime', source: 'test', detail: 'same blocker remains' }],
            nextActions: [{ kind: 'resume', label: 'Resume after resolving the blocker.' }],
            resources: {},
          }),
        }
      : {}),
  };
  const queryComplete: Extract<QueryEvent, { type: 'complete' }> = {
    type: 'complete',
    content: finishReason === 'failed' ? 'provider unavailable' : 'turn complete',
    model: 'model-test',
    stats,
    ...(input.includeUsage === false ? {} : { usage: { promptTokens: 10, completionTokens: 5 } }),
  };
  const taskContextState: HarnessState = {
    ledger: [],
    updatedAt: revision,
    progressState: {
      schemaVersion: 1,
      lastDelta: {
        schemaVersion: 1,
        changed: input.progress,
        criterionChanges: [],
        newEvidenceRefs: [],
        newChangedFiles: input.progress ? [`file-${revision}.ts`] : [],
        newDecisions: [],
        newBlockers: [],
        newDiagnostics: [],
        workspaceStateHash: `workspace-${revision}`,
        repeatedSignatureCount: 0,
        recordedAt: revision,
      },
    },
  };
  const content = {
    threadId: randomUUID(),
    turnId: input.turnId,
    queryComplete,
    taskContextState,
    taskContextRevision: revision,
    ...(input.complete
      ? {
          taskContextCompletion: {
            version: 1 as const,
            revision,
            auditedAt: revision,
            canComplete: true,
            missing: [],
            evidence: ['test:verified'],
            criterionResults: [
              {
                criterionId: 'criterion-1',
                statement: 'Verification passes',
                status: 'passed' as const,
                applicable: true,
                evidenceRefs: ['test:verified'],
                requiredKinds: ['test' as const],
                missingKinds: [],
                failedKinds: [],
              },
            ],
          },
        }
      : {}),
    history: [
      { role: 'user' as const, content: `turn ${revision}` },
      { role: 'assistant' as const, content: queryComplete.content },
    ],
  };
  return { ...content, digest: digestRuntimeValue(content) };
}

function createCoordinator(
  budget = { maxTokens: 100_000, maxElapsedMs: 100_000 }
): GoalRuntimeCoordinatorV2 {
  return new GoalRuntimeCoordinatorV2({
    definition: { objective: 'Exercise the production Goal policy', budget },
  });
}

function commitAndTerminal(
  goal: GoalRuntimeCoordinatorV2,
  turn: AgentLoopTurnCommitV1,
  terminal: 'completed' | 'failed' | 'interrupted'
): void {
  goal.commitTurn(turn, fields => durableReceipt(turn.turnId, terminal, fields));
  goal.afterDurableTerminal(turn.turnId, terminal);
}

function durableReceipt(
  turnId: string,
  terminal: 'completed' | 'failed' | 'interrupted',
  fields: {
    readonly goalState?: unknown;
    readonly stopDecision?: unknown;
  }
) {
  return {
    turnId,
    terminal,
    ...(fields.goalState ? { goalStateDigest: digestRuntimeValue(fields.goalState) } : {}),
    ...(fields.stopDecision ? { stopDecisionDigest: digestRuntimeValue(fields.stopDecision) } : {}),
  };
}
