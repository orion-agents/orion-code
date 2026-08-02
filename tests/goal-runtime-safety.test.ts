import { randomUUID } from 'crypto';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  AgentRuntimeController,
  goalProviderError,
  goalTurnMadeProgress,
  type AgentRuntimeRunner,
} from '../src/runtime/agent-runtime-controller';
import type {
  AgentRuntimeEvent,
  AgentRuntimeEventSink,
} from '../src/runtime/agent-runtime-protocol';
import type { AgentTurnRequest, GoalRuntimeEvent } from '../src/runtime/goals/types';
import type { OpenHorseUiRuntime } from '../src/runtime/ui-events';
import { LLMService, ProviderRequestPreflightError } from '../src/services/llm';
import { getProjectSessionsDir } from '../src/services/config-dir';
import { GoalCoordinator } from '../src/runtime/goals/coordinator';
import * as goalStorage from '../src/services/goal-storage';

function createRuntime(): OpenHorseUiRuntime {
  const session = { id: `runtime-safety-${randomUUID()}` };
  return {
    cwd: `/tmp/orion-runtime-safety-${randomUUID()}`,
    version: 'test',
    config: { model: 'test-model', ui: { renderer: 'terminal' } } as OpenHorseUiRuntime['config'],
    store: {
      setProcessing: jest.fn(),
      getSnapshot: jest.fn(() => ({
        tokenUsage: { promptTokens: 8, completionTokens: 3 },
        lastLoopStats: {
          finishReason: 'completed',
          llmRequests: 1,
          toolCalls: 0,
          unsafeToolCalls: 0,
        },
      })),
    } as unknown as OpenHorseUiRuntime['store'],
    llm: null,
    runtime: {} as OpenHorseUiRuntime['runtime'],
    isConfigured: true,
    ensureSession: jest.fn(() => session as ReturnType<OpenHorseUiRuntime['ensureSession']>),
    setSession: jest.fn(),
    getSession: jest.fn(() => session as ReturnType<OpenHorseUiRuntime['getSession']>),
    shutdown: jest.fn(),
  };
}

function createDeferredRunner(): AgentRuntimeRunner & {
  calls: Array<{
    request: AgentTurnRequest;
    signal?: AbortSignal;
    resolve: () => void;
  }>;
} {
  const calls: Array<{
    request: AgentTurnRequest;
    signal?: AbortSignal;
    resolve: () => void;
  }> = [];
  return {
    calls,
    runInput: jest.fn(async () => undefined),
    runRequest: jest.fn(
      (request, options) =>
        new Promise<void>(resolve => {
          calls.push({ request, signal: options?.abortSignal, resolve });
        })
    ),
  };
}

function createController(): {
  controller: AgentRuntimeController;
  runner: ReturnType<typeof createDeferredRunner>;
  events: AgentRuntimeEvent[];
  runtime: OpenHorseUiRuntime;
} {
  const runtime = createRuntime();
  const runner = createDeferredRunner();
  const events: AgentRuntimeEvent[] = [];
  const eventSink: AgentRuntimeEventSink = {
    emit: event => {
      events.push(event);
      return event.type === 'transcript_append' ? `entry-${events.length}` : undefined;
    },
  };
  const controller = new AgentRuntimeController({ runtime, runner, eventSink });
  return {
    controller,
    runner,
    events,
    runtime,
  };
}

function continuationPhases(events: AgentRuntimeEvent[]): string[] {
  return events
    .filter(
      (event): event is Extract<AgentRuntimeEvent, { type: 'goal_event' }> =>
        event.type === 'goal_event'
    )
    .map(event => event.event)
    .filter(
      (event): event is Extract<GoalRuntimeEvent, { type: 'goal_continuation' }> =>
        event.type === 'goal_continuation'
    )
    .map(event => event.phase);
}

async function flushImmediate(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

describe('goal runtime safety', () => {
  it('does not let a programmatic goal_control resume confirm a high-impact boundary', async () => {
    const { controller, runner } = createController();

    expect(controller.submit('/target publish v0.1.2 to npm')).toEqual({
      type: 'command_handled',
    });
    const coordinator = (controller as any).goalCoordinator;
    expect(coordinator.goal?.status).toBe('paused');

    expect(controller.handle({ type: 'goal_control', action: 'resume' })).toEqual({
      type: 'empty',
    });
    expect(coordinator.goal?.status).toBe('paused');
    expect(runner.calls).toHaveLength(0);

    expect(controller.submit('/target resume')).toEqual({ type: 'started' });
    expect(coordinator.goal?.status).toBe('active');
    expect(coordinator.goal?.boundaryConfirmation).toMatchObject({
      confirmedAt: expect.any(Number),
      confirmedRevision: expect.any(Number),
    });
    expect(runner.calls).toHaveLength(1);
    runner.calls[0].resolve();
    await controller.stopActiveTurn();
  });

  it.each([
    ['quota_or_credit_exhausted', 'usage_limit', false],
    ['rate_limit', 'rate_limit', true],
    ['provider_busy', 'provider_busy', true],
    ['auth_failed', 'auth', false],
    ['connect_timeout', 'network', true],
    ['read_timeout', 'network', true],
    ['connection_reset', 'network', true],
    ['network_error', 'network', true],
  ])('classifies provider stop %s as %s', (errorType, kind, retryable) => {
    expect(goalProviderError('failed', errorType)).toEqual({ kind, retryable });
  });

  it('only reports progress from passed evidence or verified workspace deltas', () => {
    expect(goalTurnMadeProgress({})).toBe(false);
    expect(
      goalTurnMadeProgress({
        evidenceRecords: [
          {
            id: 'failed-write',
            goalId: 'goal-1',
            goalRevision: 0,
            objectiveRevision: 0,
            turnId: 'turn-1',
            kind: 'file',
            result: 'failed',
            subject: 'write src/index.ts',
            sourceRef: 'tool:write',
            capturedAt: Date.now(),
            redacted: false,
          },
        ],
      })
    ).toBe(false);
    expect(
      goalTurnMadeProgress({
        evidenceRecords: [
          {
            id: 'passed-test',
            goalId: 'goal-1',
            goalRevision: 0,
            objectiveRevision: 0,
            turnId: 'turn-1',
            kind: 'test',
            result: 'passed',
            subject: 'focused test',
            sourceRef: 'tool:test',
            capturedAt: Date.now(),
            redacted: false,
          },
        ],
      })
    ).toBe(true);
    expect(
      goalTurnMadeProgress({
        pendingPlanUpdate: {
          phase: 'implementation',
          steps: [],
          derivedCriteria: [],
        },
      })
    ).toBe(false);
    expect(
      goalTurnMadeProgress({
        workspaceFingerprintBefore: 'before',
        workspaceFingerprintAfter: 'after',
      })
    ).toBe(true);
  });

  it('rejects a provider call before network I/O when the active Goal budget is exhausted', async () => {
    const { controller, runner } = createController();
    expect(controller.submit('/target verify provider budget preflight')).toEqual({
      type: 'started',
    });

    const coordinator = (controller as any).goalCoordinator;
    expect(coordinator).toBeDefined();
    expect(coordinator.setBudget(5)).toBe(true);
    const preflight = (controller as any).createChatOptions().beforeProviderRequest;
    const llm = new LLMService({ apiKey: 'test-key', model: 'test-model' });
    const create = jest.fn();
    (llm as any).client = { chat: { completions: { create } } };
    llm.setProviderRequestPreflight(preflight);

    await expect(
      llm.chat([{ role: 'user', content: 'This request must stop before network I/O.' }])
    ).rejects.toBeInstanceOf(ProviderRequestPreflightError);
    expect(create).not.toHaveBeenCalled();
    expect(coordinator.goal).toMatchObject({
      status: 'budget_limited',
      stopReason: { kind: 'budget_limit' },
    });

    runner.calls[0].resolve();
    await controller.stopActiveTurn();
  });

  it('records known usage once and pauses when retry or fallback usage is incomplete', async () => {
    const { controller, runner, runtime } = createController();
    (runtime.store.getSnapshot as jest.Mock).mockReturnValue({
      tokenUsage: { promptTokens: 12, completionTokens: 5 },
      lastLoopStats: {
        finishReason: 'completed',
        llmRequests: 1,
        toolCalls: 0,
        unsafeToolCalls: 0,
        providerRetryCount: 2,
        providerFallbackCount: 1,
      },
    });

    expect(controller.submit('/target verify retry accounting')).toEqual({ type: 'started' });
    runner.calls[0].resolve();
    await controller.waitForIdle();

    const goal = (controller as any).goalCoordinator.goal;
    expect(goal).toMatchObject({
      status: 'paused',
      tokensUsed: 17,
      continuationCount: 1,
      lastTurn: {
        promptTokens: 12,
        completionTokens: 5,
        totalTokens: 17,
      },
      stopReason: {
        kind: 'runtime_error',
        message: expect.stringContaining('retry/fallback'),
      },
    });
    expect(runner.calls).toHaveLength(1);
  });

  it('records subagent-only known usage once but marks a failed turn usage as incomplete', async () => {
    const { controller, runner, runtime } = createController();
    (runtime.store.getSnapshot as jest.Mock).mockReturnValue({
      tokenUsage: { promptTokens: 50, completionTokens: 20 },
      lastLoopStats: {
        finishReason: 'failed',
        llmRequests: 2,
        toolCalls: 1,
        unsafeToolCalls: 0,
        providerRetryCount: 0,
        providerFallbackCount: 0,
        subagentPromptTokens: 50,
        subagentCompletionTokens: 20,
        subagentTotalTokens: 70,
      },
    });

    expect(controller.submit('/target verify failed usage accounting')).toEqual({
      type: 'started',
    });
    runner.calls[0].resolve();
    await controller.waitForIdle();

    const goal = (controller as any).goalCoordinator.goal;
    expect(goal).toMatchObject({
      status: 'paused',
      tokensUsed: 70,
      continuationCount: 1,
      lastTurn: {
        finishReason: 'failed',
        promptTokens: 0,
        completionTokens: 0,
        subagentTokens: 70,
        totalTokens: 70,
      },
      stopReason: {
        kind: 'runtime_error',
        message: expect.stringContaining('known usage was recorded'),
      },
    });
    expect(runner.calls).toHaveLength(1);
  });

  it('emits scheduled and started phases for an accepted goal continuation', async () => {
    const { controller, runner, events } = createController();

    expect(controller.submit('/target verify continuation events')).toEqual({ type: 'started' });
    expect(continuationPhases(events)).toEqual(['scheduled', 'started']);

    runner.calls[0].resolve();
    await controller.stopActiveTurn();
  });

  it('aborts the active runner and rejects pending tool permission when the user clears the active Goal', async () => {
    const { controller, runner } = createController();

    expect(controller.submit('/target verify clear abort safety')).toEqual({ type: 'started' });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].signal?.aborted).toBe(false);
    const coordinator = (controller as any).goalCoordinator as GoalCoordinator;
    const clearGoal = coordinator.clear.bind(coordinator);
    const permission = controller.requestToolPermission({
      name: 'exec_command',
      args: { command: 'touch must-not-run' },
      reason: 'clear must revoke this pending side effect',
    });
    const clearSpy = jest.spyOn(coordinator, 'clear').mockImplementation(() => {
      expect(runner.calls[0].signal?.aborted).toBe(true);
      expect((controller as any).pendingPermissions.size).toBe(0);
      return clearGoal();
    });

    expect(controller.submit('/target clear --yes')).toEqual({ type: 'command_handled' });
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(runner.calls[0].signal?.aborted).toBe(true);
    await expect(permission).resolves.toBe(false);
    expect(coordinator.goal).toBeNull();

    runner.calls[0].resolve();
    await controller.waitForIdle();
    await flushImmediate();
    expect(runner.calls).toHaveLength(1);
  });

  it('keeps the old Goal turn stopped when persistent clear fails', async () => {
    const { controller, runner } = createController();

    expect(controller.submit('/target verify failed clear remains fail-closed')).toEqual({
      type: 'started',
    });
    const coordinator = (controller as any).goalCoordinator as GoalCoordinator;
    const permission = controller.requestToolPermission({
      name: 'exec_command',
      args: { command: 'touch must-not-run-after-clear-failure' },
      reason: 'failed clear must still revoke this pending side effect',
    });
    jest.spyOn(coordinator, 'clear').mockImplementation(() => {
      expect(runner.calls[0].signal?.aborted).toBe(true);
      expect((controller as any).pendingPermissions.size).toBe(0);
      throw new Error('simulated clear persistence failure');
    });

    expect(controller.submit('/target clear --yes')).toEqual({ type: 'command_handled' });
    await expect(permission).resolves.toBe(false);
    expect(coordinator.goal).toMatchObject({
      status: 'paused',
      stopReason: {
        kind: 'runtime_error',
        message: expect.stringContaining('simulated clear persistence failure'),
      },
    });

    runner.calls[0].resolve();
    await controller.waitForIdle();
    await flushImmediate();
    expect(runner.calls).toHaveLength(1);
  });

  it('aborts before a confirmed programmatic goal_control clear persists', async () => {
    const { controller, runner } = createController();

    expect(controller.submit('/target verify programmatic clear ordering')).toEqual({
      type: 'started',
    });
    const coordinator = (controller as any).goalCoordinator as GoalCoordinator;
    const clearGoal = coordinator.clear.bind(coordinator);
    const permission = controller.requestToolPermission({
      name: 'exec_command',
      args: { command: 'touch must-not-run-programmatic' },
      reason: 'programmatic clear must revoke this pending side effect',
    });
    const clearSpy = jest.spyOn(coordinator, 'clear').mockImplementation(() => {
      expect(runner.calls[0].signal?.aborted).toBe(true);
      expect((controller as any).pendingPermissions.size).toBe(0);
      return clearGoal();
    });

    expect(
      controller.handle({ type: 'goal_control', action: 'clear', payload: { confirmed: true } })
    ).toEqual({ type: 'interrupted' });
    expect(clearSpy).toHaveBeenCalledTimes(1);
    await expect(permission).resolves.toBe(false);
    expect(coordinator.goal).toBeNull();

    runner.calls[0].resolve();
    await controller.waitForIdle();
    await flushImmediate();
    expect(runner.calls).toHaveLength(1);
  });

  it('does not abort an ordinary active turn when clear finds no Goal', async () => {
    const { controller, runner, events } = createController();

    expect(controller.submit('ordinary turn without a Goal')).toEqual({ type: 'started' });
    const permission = controller.requestToolPermission({
      name: 'exec_command',
      args: { command: 'echo ordinary-turn' },
      reason: 'no-Goal clear must not revoke this permission',
    });

    expect(controller.submit('/target clear --yes')).toEqual({ type: 'command_handled' });
    expect(runner.calls[0].signal?.aborted).toBe(false);
    expect((controller as any).pendingPermissions.size).toBe(1);
    expect((controller as any).goalCoordinator.goal).toBeNull();

    const permissionEvent = events.find(
      (event): event is Extract<AgentRuntimeEvent, { type: 'permission_requested' }> =>
        event.type === 'permission_requested'
    );
    expect(permissionEvent).toBeDefined();
    expect(
      controller.handle({
        type: 'permission_decision',
        requestId: permissionEvent!.request.id,
        approved: false,
      })
    ).toEqual({ type: 'permission_decision_recorded' });
    await expect(permission).resolves.toBe(false);

    runner.calls[0].resolve();
    await controller.waitForIdle();
  });

  it('keeps /target restart recovery responsive and recoverable during a transient lock', async () => {
    const { controller, runner, events, runtime } = createController();
    const session = runtime.getSession()!;
    const persisted = new GoalCoordinator(runtime.cwd, session.id);
    expect(persisted.create('Recover target routing after a transient lock')).toEqual({ ok: true });
    const lockPath = join(getProjectSessionsDir(runtime.cwd), `${session.id}.goal.json.lock`);
    mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(lockPath, 'owner.json'),
      JSON.stringify({ token: 'live-owner', pid: process.pid, createdAt: Date.now() })
    );

    const startedAt = Date.now();
    try {
      expect(controller.submit('/target')).toEqual({ type: 'command_handled' });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect((controller as any).goalCoordinator.goal).toMatchObject({
        status: 'paused',
        stopReason: { kind: 'runtime_error' },
      });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'transcript_append',
            entry: expect.objectContaining({ role: 'error', title: 'target recovery' }),
          }),
        ])
      );
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }

    expect(controller.submit('/target resume')).toEqual({ type: 'started' });
    expect(runner.calls).toHaveLength(1);
    runner.calls[0].resolve();
    await controller.stopActiveTurn();
  });

  it('rejects an old outcome after steering bumps the goal revision', async () => {
    const { controller, runner, events } = createController();

    expect(controller.submit('/target verify stale outcomes')).toEqual({ type: 'started' });
    const oldRequest = runner.calls[0].request;
    expect(controller.submit('add a new constraint')).toEqual({ type: 'revision_requested' });

    runner.calls[0].resolve();
    await flushImmediate();

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1].request.goal?.revision).toBeGreaterThan(oldRequest.goal!.revision);
    expect(continuationPhases(events)).toContain('deferred');

    expect(controller.submit('/target')).toEqual({ type: 'command_handled' });
    const statusEntries = events.filter(
      (event): event is Extract<AgentRuntimeEvent, { type: 'transcript_append' }> =>
        event.type === 'transcript_append' && event.entry.title === 'target'
    );
    expect(statusEntries.at(-1)?.entry.content).toContain('1 turns | 11 tokens');

    runner.calls[1].resolve();
    await controller.stopActiveTurn();
  });

  it('pauses fail-closed and invalidates the active turn when steering cannot persist', async () => {
    const { controller, runner, events, runtime } = createController();

    expect(controller.submit('/target verify steering persistence safety')).toEqual({
      type: 'started',
    });
    const coordinator = (controller as any).goalCoordinator as GoalCoordinator;
    const session = runtime.getSession()!;
    const original = coordinator.snapshot()!;
    const originalConstraints = coordinator.goal?.contract?.constraints;
    const originalGeneration = (coordinator as any).state.generation as number;
    const lockPath = join(getProjectSessionsDir(runtime.cwd), `${session.id}.goal.json.lock`);
    mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(lockPath, 'owner.json'),
      JSON.stringify({ token: 'live-owner', pid: process.pid, createdAt: Date.now() })
    );

    try {
      expect(controller.submit('preserve this new constraint')).toEqual({
        type: 'command_ignored',
      });
      expect(coordinator.goal).toMatchObject({
        status: 'paused',
        revision: original.revision,
        stopReason: {
          kind: 'runtime_error',
          message: expect.stringContaining('Steering was not saved'),
        },
      });
      expect(coordinator.goal?.contract?.constraints).toEqual(originalConstraints);
      expect((coordinator as any).state.generation).toBeGreaterThan(originalGeneration);
      expect(runner.calls[0].signal?.aborted).toBe(true);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'transcript_append',
            entry: expect.objectContaining({ role: 'error', title: 'target steering' }),
          }),
          expect.objectContaining({
            type: 'goal_event',
            event: expect.objectContaining({
              type: 'goal_updated',
              goal: expect.objectContaining({ status: 'paused' }),
            }),
          }),
          expect.objectContaining({
            type: 'goal_event',
            event: expect.objectContaining({ type: 'goal_continuation', phase: 'deferred' }),
          }),
        ])
      );

      runner.calls[0].resolve();
      await controller.waitForIdle();
      await flushImmediate();
      expect(runner.calls).toHaveLength(1);
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }

    const diskAuthority = new GoalCoordinator(runtime.cwd, session.id);
    expect(diskAuthority.load()).toBe(true);
    expect(diskAuthority.goal).toMatchObject({
      status: 'active',
      revision: original.revision,
      contract: expect.objectContaining({ constraints: originalConstraints }),
    });

    expect(controller.submit('/target resume')).toEqual({ type: 'started' });
    expect(coordinator.goal?.status).toBe('active');
    expect(runner.calls).toHaveLength(2);
    runner.calls[1].resolve();
    await controller.stopActiveTurn();
  });

  it('restores the last disk state and pauses when finalize write and recovery read both fail', async () => {
    const { controller, runner, events, runtime } = createController();

    expect(controller.submit('/target verify finalize persistence safety')).toEqual({
      type: 'started',
    });
    const coordinator = (controller as any).goalCoordinator as GoalCoordinator;
    const original = coordinator.snapshot()!;
    const saveSpy = jest.spyOn(goalStorage, 'saveGoal').mockReturnValue({
      ok: false,
      error: 'io_error',
      message: 'simulated finalize write failure',
    });
    const loadSpy = jest.spyOn(goalStorage, 'loadGoal').mockReturnValue({
      ok: false,
      error: 'io_error',
      message: 'simulated recovery read failure',
    });

    try {
      runner.calls[0].resolve();
      await expect(controller.waitForIdle()).resolves.toBeUndefined();
      await flushImmediate();

      expect(coordinator.goal).toMatchObject({
        status: 'paused',
        revision: original.revision,
        tokensUsed: original.tokensUsed,
        continuationCount: original.continuationCount,
        stopReason: {
          kind: 'runtime_error',
          message: expect.stringContaining('not saved'),
        },
      });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'transcript_append',
            entry: expect.objectContaining({ role: 'error', title: 'goal persistence' }),
          }),
          expect.objectContaining({
            type: 'goal_event',
            event: expect.objectContaining({
              type: 'goal_updated',
              goal: expect.objectContaining({ status: 'paused', revision: original.revision }),
            }),
          }),
          expect.objectContaining({
            type: 'goal_event',
            event: expect.objectContaining({ type: 'goal_continuation', phase: 'deferred' }),
          }),
        ])
      );
      expect(runner.calls).toHaveLength(1);
    } finally {
      saveSpy.mockRestore();
      loadSpy.mockRestore();
    }

    const diskAuthority = new GoalCoordinator(runtime.cwd, runtime.getSession()!.id);
    expect(diskAuthority.load()).toBe(true);
    expect(diskAuthority.snapshot()).toMatchObject({
      status: 'active',
      revision: original.revision,
      tokensUsed: original.tokensUsed,
      continuationCount: original.continuationCount,
    });
  });

  it('invalidates an already queued continuation when stopping the runtime', async () => {
    const { controller, runner, events } = createController();

    expect(controller.submit('/target verify stop safety')).toEqual({ type: 'started' });
    runner.calls[0].resolve();
    await controller.waitForIdle();

    await controller.stopActiveTurn();
    await flushImmediate();

    expect(runner.calls).toHaveLength(1);
    expect(continuationPhases(events)).toContain('deferred');
  });

  it('invalidates an already queued continuation when shutdown is requested', async () => {
    const { controller, runner, events } = createController();

    expect(controller.submit('/target verify shutdown safety')).toEqual({ type: 'started' });
    runner.calls[0].resolve();
    await controller.waitForIdle();

    controller.emitShutdownRequested('test shutdown');
    await flushImmediate();

    expect(runner.calls).toHaveLength(1);
    expect(continuationPhases(events)).toContain('deferred');
    expect(events).toContainEqual({ type: 'shutdown_requested', reason: 'test shutdown' });
  });

  it('does not start a queued continuation while tool permission is pending', async () => {
    const { controller, runner, events } = createController();

    expect(controller.submit('/target verify permission scheduling')).toEqual({ type: 'started' });
    const permission = controller.requestToolPermission({
      name: 'exec_command',
      args: { command: 'echo guarded' },
      reason: 'test permission gate',
    });
    const request = events.find(
      (event): event is Extract<AgentRuntimeEvent, { type: 'permission_requested' }> =>
        event.type === 'permission_requested'
    );
    expect(request).toBeDefined();

    runner.calls[0].resolve();
    await controller.waitForIdle();
    await flushImmediate();

    expect(runner.calls).toHaveLength(1);
    expect(continuationPhases(events)).toContain('deferred');
    expect(
      controller.handle({
        type: 'permission_decision',
        requestId: request!.request.id,
        approved: false,
      })
    ).toEqual({ type: 'permission_decision_recorded' });
    await expect(permission).resolves.toBe(false);
  });

  it('does not run an old queued continuation after a session restore', async () => {
    const { controller, runner, events, runtime } = createController();

    expect(controller.submit('/target verify session switch scheduling')).toEqual({
      type: 'started',
    });
    runner.calls[0].resolve();
    await controller.waitForIdle();

    const nextSession = { id: `runtime-safety-next-${randomUUID()}` };
    (runtime.getSession as jest.Mock).mockReturnValue(nextSession);
    (controller as any).eventSink.emit({
      type: 'session_restored',
      event: {
        sessionId: nextSession.id,
        projectPath: runtime.cwd,
        model: 'test-model',
        restoredMessages: 0,
      },
    });
    await flushImmediate();

    expect(runner.calls).toHaveLength(1);
    expect(continuationPhases(events)).toContain('deferred');
  });
});
