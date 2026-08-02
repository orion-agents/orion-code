import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findCommand } from '../src/commands';
import { Store } from '../src/framework/store';
import {
  AgentRuntimeController,
  goalProviderError,
  goalTurnMadeProgress,
  type AgentRuntimeRunner,
} from '../src/runtime/agent-runtime-controller';
import type { AgentRuntimeEvent } from '../src/runtime/agent-runtime-protocol';
import {
  AgentChatController,
  closeSession,
  createAssistantStreamPresenter,
  createToolEventPresenter,
  loadSessionIntoRuntime,
  sessionMessagesToTranscriptEntries,
} from '../src/runtime/chat-controller';
import type {
  OpenHorseUiRuntime,
  TranscriptAppendEntry,
  TranscriptEntry,
  UiEventSink,
} from '../src/runtime/ui-events';
import { loadConfig } from '../src/services/config';
import {
  appendSessionMessage,
  appendSessionTraceEvent,
  createSession,
  readSessionMessages,
  type SessionMeta,
} from '../src/services/session-storage';

function createRuntime(root: string, overrides: Partial<OpenHorseUiRuntime> = {}) {
  const config = loadConfig({
    apiKey: 'test-key',
    model: 'test-model',
    ui: { renderer: 'tui' },
  });
  const store = new Store({ config, tools: [], currentModel: 'test-model' });
  let session: SessionMeta | null = null;
  const runtime: OpenHorseUiRuntime = {
    cwd: root,
    version: 'test',
    config,
    store,
    llm: null,
    runtime: {
      brain: { getStatus: () => ({ agents: [], pendingTasks: 0, strategy: 'sequential' }) },
      memory: { getStatus: () => ({ working: 0, 'short-term': 0, 'long-term': 0 }) },
      store: { getStats: () => ({ working: 0, 'short-term': 0, 'long-term': 0 }) },
      shutdown: jest.fn(async () => undefined),
    } as never,
    isConfigured: true,
    ensureSession: jest.fn(() => {
      session ??= createSession(root, 'test-model');
      return session;
    }),
    setSession: jest.fn(next => {
      session = next;
    }),
    getSession: jest.fn(() => session),
    shutdown: jest.fn(async () => undefined),
    ...overrides,
  };
  return runtime;
}

function createEvents() {
  const entries: TranscriptEntry[] = [];
  const statuses: string[] = [];
  const events: UiEventSink = {
    append: jest.fn((entry: TranscriptAppendEntry) => {
      const id = `entry-${entries.length + 1}`;
      entries.push({ id, ...entry });
      return id;
    }),
    update: jest.fn((id, patch) => {
      const entry = entries.find(item => item.id === id);
      if (entry) Object.assign(entry, patch);
    }),
    finalize: jest.fn((id, patch) => {
      const entry = entries.find(item => item.id === id);
      if (entry && patch) Object.assign(entry, patch);
    }),
    remove: jest.fn(id => {
      const index = entries.findIndex(item => item.id === id);
      if (index >= 0) entries.splice(index, 1);
    }),
    replaceTranscript: jest.fn(next => {
      entries.splice(0, entries.length, ...next);
    }),
    clearTranscript: jest.fn(() => entries.splice(0)),
    clearView: jest.fn(),
    setStatus: jest.fn(status => statuses.push(status)),
    showSessionPicker: jest.fn(),
    showEditPreview: jest.fn(),
    showPermissionRequest: jest.fn(),
    toolStarted: jest.fn(),
    toolFinished: jest.fn(),
    sessionRestored: jest.fn(),
    loopStatsUpdated: jest.fn(),
    traceEventRecorded: jest.fn(),
    harnessDiagnosticsUpdated: jest.fn(),
    subtaskEvent: jest.fn(),
    goalEvent: jest.fn(),
    setProcessing: jest.fn(),
    shutdownRequested: jest.fn(),
  };
  return { events, entries, statuses };
}

function createDeferredRunner(): AgentRuntimeRunner & {
  calls: Array<{
    input: string;
    resolve: () => void;
    reject: (reason: unknown) => void;
    signal?: AbortSignal;
  }>;
} {
  const calls: Array<{
    input: string;
    resolve: () => void;
    reject: (reason: unknown) => void;
    signal?: AbortSignal;
  }> = [];
  return {
    calls,
    runInput: jest.fn(
      (input, options) =>
        new Promise<void>((resolve, reject) => {
          calls.push({ input, resolve, reject, signal: options?.abortSignal });
        })
    ),
  };
}

function fakeGoalCoordinator(overrides: Record<string, unknown> = {}) {
  const goal = {
    goalId: 'goal-1',
    revision: 3,
    objective: 'A deliberately long objective that should be compacted in status output for users',
    status: 'active',
    tokenBudget: 5000,
    tokensUsed: 1500,
    continuationCount: 4,
    contract: {
      objectiveRevision: 2,
      planSnapshot: { revision: 7, phase: 'execute', nextAction: 'run tests' },
      successCriteria: [
        { id: 'c1', status: 'passed' },
        { id: 'c2', status: 'failed' },
        { id: 'c3', status: 'stale' },
        { id: 'c4', status: 'pending' },
      ],
    },
    completionAudit: { remainingRequirements: ['build', 'coverage', 'package', 'extra'] },
    stopReason: { message: 'review evidence' },
    evidenceLedger: [
      { id: 'e1', kind: 'test', result: 'passed', subject: 'jest' },
      { id: 'e2', kind: 'build', result: 'failed', subject: 'tsc' },
    ],
  };
  return {
    boundSessionId: 'session-goal',
    generation: 2,
    goal,
    isActive: true,
    canContinue: false,
    lastLoadIssue: undefined,
    setGoalCoordinator: jest.fn(),
    create: jest.fn(() => ({ ok: true })),
    pause: jest.fn(() => true),
    resume: jest.fn(() => true),
    confirmCriterion: jest.fn(() => true),
    edit: jest.fn(() => true),
    replace: jest.fn(() => true),
    setBudget: jest.fn(() => true),
    clear: jest.fn(() => true),
    load: jest.fn(() => true),
    snapshot: jest.fn(() => ({
      goalId: goal.goalId,
      revision: goal.revision,
      objective: goal.objective,
      status: goal.status,
      tokenBudget: goal.tokenBudget,
      tokensUsed: goal.tokensUsed,
      timeUsedMs: 10,
      continuationCount: goal.continuationCount,
      updatedAt: Date.now(),
    })),
    buildContinuationRequest: jest.fn(() => null),
    deferContinuation: jest.fn(),
    limitBudget: jest.fn(),
    finalizeTurn: jest.fn(),
    accountStaleTurn: jest.fn(() => true),
    failClosedAfterPersistenceError: jest.fn(),
    addConstraint: jest.fn(),
    ...overrides,
  };
}

describe('runtime controller branch coverage', () => {
  let root: string;
  let configRoot: string;
  let priorConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-runtime-branch-'));
    configRoot = mkdtempSync(join(tmpdir(), 'orion-runtime-config-'));
    priorConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = configRoot;
  });

  afterEach(() => {
    if (priorConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = priorConfigDir;
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    if (existsSync(configRoot)) rmSync(configRoot, { recursive: true, force: true });
  });

  it('classifies provider errors and progress evidence exhaustively', () => {
    expect(goalProviderError(undefined, undefined)).toBeUndefined();
    expect(goalProviderError('completed', 'rate_limit')).toBeUndefined();
    expect(goalProviderError('failed', undefined)).toBeUndefined();
    expect(goalProviderError('failed', 'quota_or_credit_exhausted')).toEqual({
      kind: 'usage_limit',
      retryable: false,
    });
    expect(goalProviderError('failed', 'rate_limit')).toEqual({
      kind: 'rate_limit',
      retryable: true,
    });
    expect(goalProviderError('failed', 'provider_busy')).toEqual({
      kind: 'provider_busy',
      retryable: true,
    });
    expect(goalProviderError('failed', 'auth_failed')).toEqual({
      kind: 'auth',
      retryable: false,
    });
    for (const error of ['connect_timeout', 'read_timeout', 'connection_reset', 'network_error']) {
      expect(goalProviderError('failed', error)).toEqual({ kind: 'network', retryable: true });
    }
    expect(goalProviderError('failed', 'mystery')).toEqual({
      kind: 'unknown',
      retryable: false,
    });

    expect(goalTurnMadeProgress({})).toBe(false);
    expect(goalTurnMadeProgress({ evidenceRecords: [] })).toBe(false);
    expect(goalTurnMadeProgress({ evidenceRecords: [{ result: 'failed' }] as never })).toBe(false);
    expect(goalTurnMadeProgress({ evidenceRecords: [{ result: 'passed' }] as never })).toBe(true);
    expect(
      goalTurnMadeProgress({ workspaceFingerprintBefore: 'a', workspaceFingerprintAfter: 'b' })
    ).toBe(true);
    expect(
      goalTurnMadeProgress({ workspaceFingerprintBefore: 'a', workspaceFingerprintAfter: 'a' })
    ).toBe(false);
  });

  it('validates constructor, target interception, renderer events, and verification state', () => {
    const runtime = createRuntime(root);
    expect(() => new AgentRuntimeController({ runtime })).toThrow('requires either events');

    const recorded: AgentRuntimeEvent[] = [];
    const controller = new AgentRuntimeController({
      runtime,
      eventSink: {
        emit: event => {
          recorded.push(event);
        },
      },
      runner: { runInput: jest.fn(async () => undefined) },
    });

    expect(controller.canInterceptTargetCommand('hello', false)).toBe(false);
    expect(controller.canInterceptTargetCommand('/target confirm bad id', false)).toBe(true);
    expect(controller.canInterceptTargetCommand('/target status', true)).toBe(true);
    expect(controller.canInterceptTargetCommand('/target pause', true)).toBe(true);
    expect(controller.canInterceptTargetCommand('/target clear', true)).toBe(true);
    expect(controller.canInterceptTargetCommand('/target change objective', true)).toBe(false);
    expect(controller.canInterceptTargetCommand('/goal change objective', false)).toBe(true);

    controller.emitClearView();
    controller.emitShutdownRequested();
    controller.emitShutdownRequested('restart');
    controller.setVerificationState('pending');
    expect(controller.getVerificationState()).toBe('pending');
    controller.clearExitIntent();
    expect(recorded.map(event => event.type)).toContain('clear_view');
    expect(recorded.filter(event => event.type === 'shutdown_requested')).toHaveLength(2);
  });

  it('routes every public input kind, revision, command rejection, and turn errors', async () => {
    const runtime = createRuntime(root);
    const recorded: AgentRuntimeEvent[] = [];
    const runner = createDeferredRunner();
    const onTurnError = jest.fn();
    const afterTurnLoop = jest.fn();
    const beforeTurn = jest.fn();
    const controller = new AgentRuntimeController({
      runtime,
      eventSink: {
        emit: event => {
          recorded.push(event);
        },
      },
      runner,
      runningStatus: input => `running ${input}`,
      readyStatus: () => 'ready',
      commandWhileRunningStatus: 'busy command',
      revisionStatus: 'revising',
      restartingStatus: 'restarting',
      interruptedStatus: 'stopped',
      exitPromptStatus: 'exit?',
      onTurnError,
      afterTurnLoop,
      beforeTurn,
    });

    expect(controller.handle({ type: 'submit', text: '   ' })).toEqual({ type: 'empty' });
    for (const text of ['/exit', '/quit', '/q']) {
      expect(controller.handle({ type: 'submit', text })).toEqual({ type: 'exit_requested' });
    }
    expect(controller.handle({ type: 'submit', text: '/clear' })).toEqual({
      type: 'command_handled',
    });
    expect(
      controller.handle({ type: 'permission_decision', requestId: 'missing', approved: true })
    ).toEqual({ type: 'permission_decision_ignored' });
    expect(controller.handle({ type: 'clear_exit_intent' })).toEqual({
      type: 'exit_intent_cleared',
    });

    expect(controller.handle({ type: 'submit', text: 'first' })).toEqual({ type: 'started' });
    expect(controller.hasActiveTurn()).toBe(true);
    expect(controller.handle({ type: 'submit', text: '/help' })).toEqual({
      type: 'command_ignored',
    });
    expect(controller.handle({ type: 'submit', text: 'revision' })).toEqual({
      type: 'revision_requested',
    });
    expect(runner.calls[0].signal?.aborted).toBe(true);
    runner.calls[0].resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(runner.calls[1].input).toBe('revision');
    runner.calls[1].reject(new Error('runner failure'));
    await controller.waitForIdle();
    expect(onTurnError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'runner failure' })
    );
    expect(beforeTurn).toHaveBeenCalledTimes(2);
    expect(afterTurnLoop).toHaveBeenCalledTimes(1);
    expect(recorded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'clear_view' }),
        expect.objectContaining({ type: 'processing_changed', processing: true }),
        expect.objectContaining({ type: 'processing_changed', processing: false }),
      ])
    );
  });

  it('uses default error rendering and both interrupt exit paths', async () => {
    const runtime = createRuntime(root);
    const recorded: AgentRuntimeEvent[] = [];
    const runner: AgentRuntimeRunner = {
      runInput: jest.fn(async () => {
        throw 'string failure';
      }),
    };
    const controller = new AgentRuntimeController({
      runtime,
      eventSink: {
        emit: event => {
          recorded.push(event);
        },
      },
      runner,
      readyStatus: 'ready',
    });
    expect(controller.submit('work')).toEqual({ type: 'started' });
    await controller.waitForIdle();
    expect(recorded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'transcript_append',
          entry: expect.objectContaining({ content: 'Error: string failure' }),
        }),
      ])
    );

    expect(controller.interrupt()).toEqual({ type: 'exit_prompt' });
    expect(controller.interrupt()).toEqual({ type: 'exit_requested' });
    controller.clearExitIntent();

    const deferred = createDeferredRunner();
    const active = new AgentRuntimeController({
      runtime,
      eventSink: {
        emit: event => {
          recorded.push(event);
        },
      },
      runner: deferred,
    });
    active.submit('active');
    expect(active.interrupt()).toEqual({ type: 'interrupted' });
    expect(active.interrupt()).toEqual({ type: 'exit_requested' });
    deferred.calls[0].resolve();
    await active.waitForIdle();
  });

  it('records, aborts, approves, ignores, and rejects pending permissions', async () => {
    const runtime = createRuntime(root);
    const recorded: AgentRuntimeEvent[] = [];
    const controller = new AgentRuntimeController({
      runtime,
      eventSink: {
        emit: event => {
          recorded.push(event);
        },
      },
      runner: { runInput: jest.fn(async () => undefined) },
    });
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      controller.requestToolPermission({
        name: 'bash',
        args: {},
        abortSignal: alreadyAborted.signal,
      })
    ).resolves.toBe(false);

    const aborting = new AbortController();
    const denied = controller.requestToolPermission({
      name: 'write_file',
      args: { path: 'a' },
      reason: 'write',
      abortSignal: aborting.signal,
    });
    aborting.abort();
    await expect(denied).resolves.toBe(false);

    const approved = controller.requestToolPermission({ name: 'exec', args: {} });
    expect(
      controller.handle({
        type: 'permission_decision',
        requestId: 'permission-2',
        approved: true,
      })
    ).toEqual({ type: 'permission_decision_recorded' });
    await expect(approved).resolves.toBe(true);

    const pending = controller.requestToolPermission({ name: 'delete', args: {} });
    await controller.stopActiveTurn();
    await expect(pending).resolves.toBe(false);
    expect(recorded.some(event => event.type === 'permission_requested')).toBe(true);
  });

  it('covers goal-control actions and rich target status formatting with a fake coordinator', () => {
    const runtime = createRuntime(root);
    const recorded: AgentRuntimeEvent[] = [];
    const controller = new AgentRuntimeController({
      runtime,
      eventSink: {
        emit: event => {
          recorded.push(event);
        },
      },
      runner: { runInput: jest.fn(async () => undefined) },
    });
    const coord = fakeGoalCoordinator();
    controller.setGoalCoordinator(coord as never);

    expect(controller.handle({ type: 'goal_control', action: 'show' })).toEqual({ type: 'empty' });
    expect(controller.handle({ type: 'goal_control', action: 'create' })).toEqual({
      type: 'empty',
    });
    expect(
      controller.handle({ type: 'goal_control', action: 'create', payload: { objective: 'goal' } })
    ).toEqual({ type: 'interrupted' });
    expect(controller.handle({ type: 'goal_control', action: 'pause' })).toEqual({
      type: 'interrupted',
    });
    expect(controller.handle({ type: 'goal_control', action: 'resume' })).toEqual({
      type: 'interrupted',
    });
    expect(controller.handle({ type: 'goal_control', action: 'confirm' })).toEqual({
      type: 'interrupted',
    });
    expect(controller.handle({ type: 'goal_control', action: 'edit' })).toEqual({
      type: 'interrupted',
    });
    expect(
      controller.handle({ type: 'goal_control', action: 'edit', payload: { objective: 'edit' } })
    ).toEqual({ type: 'interrupted' });
    expect(controller.handle({ type: 'goal_control', action: 'replace' })).toEqual({
      type: 'interrupted',
    });
    expect(
      controller.handle({ type: 'goal_control', action: 'replace', payload: { objective: 'new' } })
    ).toEqual({ type: 'interrupted' });
    expect(controller.handle({ type: 'goal_control', action: 'set_budget' })).toEqual({
      type: 'interrupted',
    });
    expect(controller.handle({ type: 'goal_control', action: 'clear' })).toEqual({
      type: 'interrupted',
    });
    expect(
      controller.handle({ type: 'goal_control', action: 'clear', payload: { confirmed: true } })
    ).toEqual({ type: 'interrupted' });
    expect(controller.handle({ type: 'goal_control', action: 'unexpected' } as never)).toEqual({
      type: 'empty',
    });

    const rich = (
      controller as never as { formatTargetStatus(value: unknown): string }
    ).formatTargetStatus(coord);
    expect(rich).toContain('Criteria: 1 pending');
    expect(rich).toContain('Evidence:');
    const empty = fakeGoalCoordinator({ goal: null });
    expect(
      (controller as never as { formatTargetStatus(value: unknown): string }).formatTargetStatus(
        empty
      )
    ).toContain('no active goal');
  });

  it('covers target parsing, failure, success, confirmation, and exception paths', () => {
    const runtime = createRuntime(root);
    const recorded: AgentRuntimeEvent[] = [];
    const controller = new AgentRuntimeController({
      runtime,
      eventSink: {
        emit: event => {
          recorded.push(event);
        },
      },
      runner: { runInput: jest.fn(async () => undefined) },
    });
    expect(controller.handleTargetInput('/target confirm bad id').runtimeResult).toEqual({
      type: 'command_handled',
    });
    expect(controller.handleTargetInput('/target').statusText).toContain('unavailable');

    const failing = fakeGoalCoordinator({
      create: jest.fn(() => ({ ok: false, error: 'create failed' })),
      pause: jest.fn(() => false),
      resume: jest.fn(() => false),
      confirmCriterion: jest.fn(() => false),
      edit: jest.fn(() => false),
      replace: jest.fn(() => false),
      setBudget: jest.fn(() => false),
      clear: jest.fn(() => false),
    });
    controller.setGoalCoordinator(failing as never);
    for (const command of [
      '/target fail',
      '/target pause',
      '/target resume',
      '/target confirm c1',
      '/target edit revised',
      '/target replace replacement',
      '/target budget 1000',
      '/target clear',
      '/target clear --yes',
    ]) {
      expect(controller.handleTargetInput(command).handled).toBe(true);
    }

    const throwing = fakeGoalCoordinator({
      edit: jest.fn(() => {
        throw 'persist failed';
      }),
    });
    controller.setGoalCoordinator(throwing as never);
    expect(controller.handleTargetInput('/target edit throws').statusText).toBeDefined();

    const succeeding = fakeGoalCoordinator({
      buildContinuationRequest: jest.fn(() => null),
    });
    controller.setGoalCoordinator(succeeding as never);
    for (const command of [
      '/target created',
      '/target pause',
      '/target resume',
      '/target confirm c1',
      '/target edit revised',
      '/target replace replacement',
      '/target budget off',
      '/target clear --yes',
    ]) {
      expect(controller.handleTargetInput(command).handled).toBe(true);
    }
    expect(recorded.some(event => event.type === 'goal_event')).toBe(true);
  });

  it('builds chat options with permission, child usage, and provider budget callbacks', async () => {
    const runtime = createRuntime(root);
    const recorded: AgentRuntimeEvent[] = [];
    const configuredPreflight = jest
      .fn()
      .mockResolvedValueOnce({ available: false, reason: 'configured deny' })
      .mockResolvedValue({ available: true });
    const customVerification = jest.fn();
    const controller = new AgentRuntimeController({
      runtime,
      eventSink: {
        emit: event => {
          recorded.push(event);
        },
      },
      runner: { runInput: jest.fn(async () => undefined) },
      uiRenderer: 'terminal',
      uiCapabilities: { structuredPickers: false },
      useRuntimeToolPermissions: true,
      chatOptions: {
        uiRenderer: 'print',
        uiCapabilities: { inlineProgress: true },
        onVerificationStateChange: customVerification,
        beforeProviderRequest: configuredPreflight,
      },
    });
    const options = (
      controller as never as { createChatOptions(): Record<string, unknown> }
    ).createChatOptions() as any;

    expect(options.uiRenderer).toBe('print');
    expect(options.uiCapabilities).toMatchObject({
      structuredPickers: false,
      inlineProgress: true,
    });
    expect(options.hasPendingPermission()).toBe(false);
    expect(
      await options.beforeProviderRequest({
        operation: 'chat',
        attempt: 1,
        model: 'test-model',
        estimatedPromptTokens: 10,
      })
    ).toEqual({ available: false, reason: 'configured deny' });
    expect(
      await options.beforeProviderRequest({
        operation: 'chat',
        attempt: 2,
        model: 'test-model',
        estimatedPromptTokens: 10,
      })
    ).toEqual({ available: true });

    options.onVerificationStateChange('passed');
    expect(customVerification).toHaveBeenCalledWith('passed');
    options.onChildUsage(
      'child-1',
      'researcher',
      { promptTokens: 5, completionTokens: 2, toolCalls: 0, modelRequests: 1 },
      undefined
    );
    options.onChildUsage(
      'child-2',
      'implementer',
      {
        promptTokens: 8,
        completionTokens: 3,
        toolCalls: 1,
        modelRequests: 1,
        costUsd: 0.25,
      },
      'priced-model'
    );

    const permission = options.confirmToolUse({ name: 'write_file', args: { path: 'a.ts' } });
    expect(options.hasPendingPermission()).toBe(true);
    expect(
      controller.handle({
        type: 'permission_decision',
        requestId: 'permission-1',
        approved: false,
      })
    ).toEqual({ type: 'permission_decision_recorded' });
    await expect(permission).resolves.toBe(false);

    const coord = fakeGoalCoordinator();
    (coord.goal as any).lastTurn = { totalTokens: 25 };
    controller.setGoalCoordinator(coord as never);
    expect(
      await options.beforeProviderRequest({
        operation: 'chat',
        attempt: 3,
        model: 'test-model',
        estimatedPromptTokens: 20,
      })
    ).toEqual(expect.objectContaining({ available: true }));
    coord.goal.tokenBudget = 1;
    expect(
      await options.beforeProviderRequest({
        operation: 'chat',
        attempt: 4,
        model: 'test-model',
        estimatedPromptTokens: 20,
      })
    ).toEqual(expect.objectContaining({ available: false }));
    expect(coord.limitBudget).toHaveBeenCalled();
    expect(recorded.some(event => event.type === 'goal_event')).toBe(true);

    const defaults = new AgentRuntimeController({
      runtime,
      eventSink: { emit: () => undefined },
      runner: { runInput: jest.fn(async () => undefined) },
    });
    const defaultOptions = (
      defaults as never as { createChatOptions(): Record<string, unknown> }
    ).createChatOptions() as any;
    defaultOptions.onVerificationStateChange('gated');
    expect(defaults.getVerificationState()).toBe('gated');
  });

  it('finalizes current, stale, completed, audited, and blocked goal outcomes', () => {
    const runtime = createRuntime(root);
    const session = runtime.ensureSession();
    const recorded: AgentRuntimeEvent[] = [];
    const controller = new AgentRuntimeController({
      runtime,
      eventSink: {
        emit: event => {
          recorded.push(event);
        },
      },
      runner: { runInput: jest.fn(async () => undefined) },
    });
    const finalize = (
      coord: ReturnType<typeof fakeGoalCoordinator>,
      requestOverrides: Record<string, unknown> = {},
      context: Record<string, unknown> | undefined = undefined,
      aborted = false
    ) => {
      coord.boundSessionId = session.id;
      controller.setGoalCoordinator(coord as never);
      const request = {
        inputKind: 'goal_continuation',
        text: 'continue',
        sessionId: session.id,
        goal: { goalId: 'goal-1', revision: 3, continuationIndex: 4 },
        persistAsUserMessage: true,
        echoToTranscript: false,
        generation: 2,
        ...requestOverrides,
      };
      (
        controller as never as {
          finalizeGoalTurn(
            turnId: string,
            request: unknown,
            context: unknown,
            startedAt: number,
            fingerprint: string | undefined,
            aborted: boolean
          ): void;
        }
      ).finalizeGoalTurn(
        'turn-goal',
        request,
        { evidenceRecords: [], ...context },
        Date.now() - 5,
        'before',
        aborted
      );
    };

    runtime.store.setState({
      tokenUsage: { promptTokens: 30, completionTokens: 10 },
      lastLoopStats: {
        finishReason: 'completed',
        turnsStarted: 1,
        llmRequests: 1,
        toolCalls: 1,
        readOnlyToolCalls: 1,
        unsafeToolCalls: 0,
        toolResultBytes: 10,
        modelVisibleToolBytes: 10,
        summarizedBytes: 0,
        subagentPromptTokens: 5,
        subagentCompletionTokens: 2,
        subagentTotalTokens: 7,
        verificationPassedCommands: ['npm test'],
        verificationFailedCommands: [],
        verificationMissingCommands: [],
        singleReadOnlyStreak: 0,
        batchReadSuggestionCount: 0,
        localFastPathUsed: false,
      },
    });

    finalize(fakeGoalCoordinator(), { sessionId: 'stale-session' });

    const completed = fakeGoalCoordinator();
    completed.goal.completionAudit = { passed: true, remainingRequirements: [] } as never;
    completed.finalizeTurn.mockImplementation(() => {
      completed.goal.contract.planSnapshot.revision = 8;
    });
    completed.snapshot.mockReturnValue({
      goalId: 'goal-1',
      revision: 3,
      objective: 'done',
      status: 'complete',
      tokenBudget: 5000,
      tokensUsed: 40,
      timeUsedMs: 5,
      continuationCount: 4,
      updatedAt: Date.now(),
    });
    finalize(
      completed,
      {},
      {
        evidenceRecords: [{ id: 'evidence-1', result: 'passed' }],
        pendingPlanUpdate: { revision: 8 },
      }
    );

    const audited = fakeGoalCoordinator();
    audited.goal.completionAudit = {
      passed: false,
      remainingRequirements: ['coverage', 'build'],
    } as never;
    finalize(audited);

    const blocked = fakeGoalCoordinator();
    delete (blocked.goal as any).completionAudit;
    (blocked.goal as any).blocker = { consecutiveTurns: 2 };
    (blocked.goal as any).noProgressCount = 1;
    finalize(blocked, {}, { pendingTerminalRequest: { requestedStatus: 'blocked' } });

    const stale = fakeGoalCoordinator();
    stale.goal.status = 'paused';
    (stale.goal as any).lastTurn = undefined;
    runtime.store.setState({
      tokenUsage: null,
      lastLoopStats: {
        finishReason: 'failed',
        turnsStarted: 1,
        llmRequests: 1,
        toolCalls: 0,
        readOnlyToolCalls: 0,
        unsafeToolCalls: 0,
        toolResultBytes: 0,
        modelVisibleToolBytes: 0,
        summarizedBytes: 0,
        providerRetryCount: 1,
        providerFallbackCount: 1,
        providerLastRetryErrorType: 'rate_limit',
        singleReadOnlyStreak: 0,
        batchReadSuggestionCount: 0,
        localFastPathUsed: false,
        usageAccountingComplete: false,
      } as never,
    });
    finalize(stale, {}, { evidenceRecords: [] }, true);

    expect(completed.finalizeTurn).toHaveBeenCalled();
    expect(stale.accountStaleTurn).toHaveBeenCalled();
    expect(recorded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'goal_event' }),
        expect.objectContaining({ type: 'trace_event_recorded' }),
      ])
    );
  });

  it('schedules, invalidates, defers, and budget-gates goal continuations', async () => {
    const runtime = createRuntime(root);
    const session = runtime.ensureSession();
    const recorded: AgentRuntimeEvent[] = [];
    const makeController = (coord: ReturnType<typeof fakeGoalCoordinator>) => {
      coord.boundSessionId = session.id;
      const controller = new AgentRuntimeController({
        runtime,
        eventSink: {
          emit: event => {
            recorded.push(event);
          },
        },
        runner: { runInput: jest.fn(async () => undefined) },
      });
      controller.setGoalCoordinator(coord as never);
      return controller;
    };
    const schedule = (controller: AgentRuntimeController) =>
      (controller as never as { scheduleGoalContinuation(): void }).scheduleGoalContinuation();
    const nextTick = () => new Promise<void>(resolve => setImmediate(resolve));

    const ineligible = makeController(fakeGoalCoordinator({ canContinue: false }));
    schedule(ineligible);

    const invalidatedCoord = fakeGoalCoordinator({ canContinue: true });
    const invalidated = makeController(invalidatedCoord);
    schedule(invalidated);
    invalidated.emitShutdownRequested('invalidate');
    await nextTick();

    const noRequestCoord = fakeGoalCoordinator({ canContinue: true });
    const noRequest = makeController(noRequestCoord);
    schedule(noRequest);
    await nextTick();

    const stoppingCoord = fakeGoalCoordinator({ canContinue: true });
    const stopping = makeController(stoppingCoord);
    schedule(stopping);
    (stopping as any).stopping = true;
    await nextTick();
    (stopping as any).stopping = false;

    const inactiveCoord = fakeGoalCoordinator({ canContinue: true });
    const inactive = makeController(inactiveCoord);
    schedule(inactive);
    inactiveCoord.goal.status = 'paused';
    await nextTick();

    const request = {
      inputKind: 'goal_continuation',
      text: 'continue',
      sessionId: session.id,
      goal: { goalId: 'goal-1', revision: 3, continuationIndex: 5 },
      persistAsUserMessage: false,
      echoToTranscript: false,
      generation: 2,
    };
    const limitedCoord = fakeGoalCoordinator({
      canContinue: true,
      buildContinuationRequest: jest.fn(() => request),
    });
    limitedCoord.goal.tokensUsed = 100;
    limitedCoord.goal.tokenBudget = 1;
    (limitedCoord.goal as any).lastTurn = { totalTokens: 50 };
    const limited = makeController(limitedCoord);
    schedule(limited);
    await nextTick();
    expect(limitedCoord.limitBudget).toHaveBeenCalled();

    const permissionCoord = fakeGoalCoordinator({ canContinue: true });
    const permissionController = makeController(permissionCoord);
    const permission = permissionController.requestToolPermission({ name: 'write_file', args: {} });
    schedule(permissionController);
    await nextTick();
    permissionController.handle({
      type: 'permission_decision',
      requestId: 'permission-1',
      approved: false,
    });
    await permission;

    const throwing = fakeGoalCoordinator({
      deferContinuation: jest.fn(() => {
        throw new Error('defer persistence failed');
      }),
    });
    const deferred = makeController(throwing);
    deferred.emitShutdownRequested('defer');

    const reasons = recorded.flatMap(event =>
      event.type === 'goal_event' && event.event.type === 'goal_continuation'
        ? [event.event.reason]
        : []
    );
    expect(reasons).toEqual(
      expect.arrayContaining([
        'coordinator is not eligible to continue',
        'scheduled continuation was invalidated',
        'runtime is stopping',
        'goal is no longer active',
        'coordinator did not produce a continuation request',
      ])
    );
  });

  it('streams assistant segments through append, update, finalize, discard, and abort paths', () => {
    const { events, entries } = createEvents();
    const presenter = createAssistantStreamPresenter(events);
    presenter.appendChunk('');
    presenter.closeSegment();
    presenter.ensureMessage('hello');
    presenter.ensureMessage('ignored');
    presenter.appendChunk(' world');
    presenter.replaceMessage('replacement');
    presenter.closeSegment();
    presenter.appendChunk('discard me');
    presenter.discardSegment();
    presenter.ensureMessage('final');
    presenter.closeSegment();
    expect(entries.map(entry => entry.content)).toEqual(['replacement', 'final']);

    const abort = new AbortController();
    const aborted = createAssistantStreamPresenter(events, abort.signal);
    aborted.appendChunk('before abort');
    abort.abort();
    aborted.appendChunk('ignored');
    aborted.ensureMessage('ignored');
    aborted.replaceMessage('ignored');
    aborted.closeSegment();
    expect(entries.some(entry => entry.content === 'before abort')).toBe(false);
  });

  it('presents completed, orphaned, failed, artifact, and skipped tool events', () => {
    const { events, entries } = createEvents();
    const presenter = createToolEventPresenter(events, { projectPath: root, turnId: 'turn-1' });
    presenter.start({
      type: 'tool_call',
      callId: 'running',
      name: 'exec_command',
      args: { command: 'npm test' },
      batchCount: 2,
      batchIndex: 0,
    });
    presenter.finish({
      type: 'tool_result',
      callId: 'running',
      name: 'exec_command',
      args: { command: 'npm test' },
      result: JSON.stringify({ success: true, output: 'ok', summary: 'passed' }),
      modelVisibleResult: JSON.stringify({ success: true, output: 'ok' }),
      success: true,
      duration: 12,
      summary: 'passed\nmore',
      outputBytes: 2,
      batchCount: 2,
      batchIndex: 0,
    });
    presenter.finish({
      type: 'tool_result',
      callId: 'orphan',
      name: 'read_file',
      args: { path: 'a.ts' },
      result: JSON.stringify({ success: false, output: '', error: 'missing' }),
      modelVisibleResult: JSON.stringify({ success: false, output: '' }),
      success: false,
      duration: 1,
      error: 'missing',
      artifactRef: { id: 'artifact-existing', outputBytes: 99 },
    });
    presenter.start({
      type: 'tool_call',
      callId: 'skip-default',
      name: 'write_file',
      args: { path: 'a.ts' },
    });
    presenter.start({
      type: 'tool_call',
      callId: 'skip-custom',
      name: 'grep',
      args: { pattern: 'needle' },
    });
    presenter.finalizePendingAsSkipped();
    presenter.finalizePendingAsSkipped('cancelled');
    expect(entries.some(entry => entry.role === 'error')).toBe(true);
    expect(events.toolStarted).toHaveBeenCalled();
    expect(events.toolFinished).toHaveBeenCalled();
  });

  it('rebuilds transcript entries for synthetic, malformed, incomplete, and traced tool messages', () => {
    const session = createSession(root, 'test-model');
    appendSessionMessage(session.id, {
      role: 'system',
      content: '[Context Summary] hidden',
      timestamp: 1,
    });
    appendSessionMessage(session.id, { role: 'system', content: 'visible system', timestamp: 2 });
    appendSessionMessage(session.id, { role: 'user', content: 'question', timestamp: 3 });
    appendSessionMessage(session.id, {
      role: 'assistant',
      content: '',
      timestamp: 4,
      tool_calls: [
        {
          id: 'pending-call',
          type: 'function',
          function: { name: 'read_file', arguments: '{bad json' },
        },
        {
          id: 'done-call',
          type: 'function',
          function: { name: 'exec_command', arguments: '{"command":"npm test"}' },
        },
      ],
    });
    appendSessionMessage(session.id, {
      role: 'tool',
      content: JSON.stringify({
        schemaVersion: 1,
        success: false,
        output: 'full output',
        outputBytes: 11,
        error: 'failed',
        summary: 'summary',
        artifactRef: { id: 'artifact-1', outputBytes: 11 },
      }),
      modelVisibleContent: JSON.stringify({ success: false, output: 'preview' }),
      timestamp: 5,
      toolCallId: 'done-call',
    });
    appendSessionMessage(session.id, {
      role: 'tool',
      content: 'not json',
      timestamp: 6,
      toolCallId: 'missing-call',
    });
    appendSessionMessage(session.id, {
      role: 'tool',
      content: 'standalone',
      timestamp: 7,
    });
    appendSessionTraceEvent(session.id, {
      turnId: 'turn-1',
      type: 'tool_result',
      callId: 'done-call',
      duration: 9,
      outputBytes: 11,
      artifactId: 'artifact-trace',
    });

    const plain = sessionMessagesToTranscriptEntries(session.id);
    const rich = sessionMessagesToTranscriptEntries(session.id, { includeToolOutputViews: true });
    expect(plain.some(entry => entry.content.includes('Requested read_file'))).toBe(true);
    expect(rich.some(entry => entry.role === 'system')).toBe(true);
    expect(rich.some(entry => entry.toolActivity?.state === 'error')).toBe(true);
    expect(rich.some(entry => entry.content.includes('Tool result missing-call'))).toBe(true);
    expect(rich.some(entry => entry.content === 'standalone')).toBe(true);
  });

  it('routes chat controller command branches and restores command hooks', async () => {
    const runtime = createRuntime(root);
    const fullEvents = createEvents();
    const controller = new AgentChatController(runtime, fullEvents.events);
    await controller.runInput('   ');
    await controller.runInput('/clear');
    await controller.runInput('/exit');
    await controller.runInput('/quit');
    await controller.runInput('/q');
    await controller.runInput('/hlep');
    await controller.runInput('/zzzzzz');
    await controller.runInput('/help');
    expect(fullEvents.events.clearView).toHaveBeenCalled();
    expect(runtime.shutdown).toHaveBeenCalledTimes(3);
    expect(fullEvents.entries.some(entry => entry.title === 'unknown command')).toBe(true);
    expect(fullEvents.entries.some(entry => entry.title === '/help')).toBe(true);

    const fallbackEvents = createEvents();
    delete fallbackEvents.events.clearView;
    delete fallbackEvents.events.shutdownRequested;
    const fallback = new AgentChatController(runtime, fallbackEvents.events);
    await fallback.runInput('/clear');
    await fallback.runInput('/exit');
    expect(fallbackEvents.events.clearTranscript).toHaveBeenCalled();

    const command = findCommand('review')!;
    const original = command.execute;
    const runChat = jest
      .spyOn(controller as never as { runChat(input: string): Promise<void> }, 'runChat')
      .mockResolvedValue(undefined);
    try {
      command.execute = jest
        .fn()
        .mockReturnValueOnce({ success: true, output: 'direct output' })
        .mockReturnValueOnce({ success: false, error: 'direct error' })
        .mockReturnValueOnce({ success: true, continueAsChat: true })
        .mockReturnValueOnce({ success: true, continueAsChat: true, chatInput: 'custom chat' });
      await controller.runInput('/review first');
      await controller.runInput('/review second');
      await controller.runInput('/review fallback args');
      await controller.runInput('/review fourth');
      expect(runChat).toHaveBeenNthCalledWith(1, 'fallback args', expect.any(Object));
      expect(runChat).toHaveBeenNthCalledWith(2, 'custom chat', expect.any(Object));
    } finally {
      command.execute = original;
      runChat.mockRestore();
    }
  });

  it('projects command provider usage, diagnostics, picker, and edit-preview results', async () => {
    let preflight: ((context: Record<string, unknown>) => Promise<unknown>) | undefined;
    const restorePreflight = jest.fn();
    const unsubscribe = jest.fn();
    const llm = {
      getModel: jest.fn(() => 'test-model'),
      setProviderRequestPreflight: jest.fn(callback => {
        preflight = callback;
        return restorePreflight;
      }),
      subscribeUsage: jest.fn(observer => {
        observer({ usage: { promptTokens: 12, completionTokens: 4 } });
        return unsubscribe;
      }),
      getLastRequestDiagnostics: jest.fn(() => ({
        retryCount: 2,
        retryDelayMs: 50,
        retryErrorTypes: ['rate_limit'],
        lastRetryErrorType: 'rate_limit',
        lastRetryStatus: 429,
        fallbackTriggered: true,
        fallbackFromModel: 'primary',
        fallbackToModel: 'fallback',
        finalModel: 'fallback',
        usingFallback: true,
      })),
    };
    const runtime = createRuntime(root, { llm: llm as never });
    const { events, entries } = createEvents();
    const beforeProviderRequest = jest.fn(async () => ({ available: true }));
    const controller = new AgentChatController(runtime, events, { beforeProviderRequest });
    const command = findCommand('review')!;
    const original = command.execute;
    try {
      command.execute = jest
        .fn()
        .mockImplementationOnce(async () => {
          await preflight?.({
            operation: 'chat',
            attempt: 1,
            model: 'test-model',
            estimatedPromptTokens: 10,
          });
          console.log('captured failure output');
          return { success: false, output: 'result failure output', error: 'command failed' };
        })
        .mockReturnValueOnce({
          success: true,
          sessionPicker: { title: 'pick', sessions: [], maxVisibleItems: 10 },
        })
        .mockReturnValueOnce({
          success: true,
          editPreview: {
            path: 'a.ts',
            newString: 'next',
            kind: 'exact',
            candidates: [],
          },
        });
      await controller.runInput('/review one');
      await controller.runInput('/review two');
      await controller.runInput('/review three');
    } finally {
      command.execute = original;
    }

    expect(beforeProviderRequest).toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalled();
    expect(restorePreflight).toHaveBeenCalled();
    expect(runtime.store.getSnapshot().tokenUsage).toEqual({
      promptTokens: 12,
      completionTokens: 4,
    });
    expect(runtime.store.getSnapshot().lastLoopStats).toMatchObject({
      finishReason: 'completed',
      providerRetryCount: 2,
      providerFallbackCount: 1,
    });
    expect(entries.some(entry => entry.role === 'error')).toBe(true);
    expect(events.showSessionPicker).toHaveBeenCalled();
    expect(events.showEditPreview).toHaveBeenCalled();
  });

  it.each([
    ['provider quota timeout', 'provider'],
    ['tool exec_command failed', 'tool'],
    ['mcp transport failed', 'mcp'],
    ['session resume failed', 'session'],
    ['skills loader failed', 'skills'],
    ['memory vector store failed', 'memory'],
    ['terminal renderer failed', 'renderer'],
    ['operation interrupted', 'runtime'],
    ['unclassified failure', 'unknown'],
    ['code: 11210 NotEnoughCvError', 'provider'],
  ])('classifies chat failure %s as %s', async (message, layer) => {
    const llm = {
      getModel: jest.fn(() => 'test-model'),
      chatStream: jest.fn(async () => {
        throw new Error(message);
      }),
    };
    const runtime = createRuntime(root, {
      llm: llm as never,
      getSession: jest.fn(() => null),
      ensureSession: jest.fn(() => null as never),
    });
    const { events, entries } = createEvents();
    const controller = new AgentChatController(runtime, events);

    await expect(
      controller.runInput(`ordinary request ${layer}`, { persistAsUserMessage: false })
    ).resolves.toBeUndefined();
    expect(entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'error', errorLayer: layer })])
    );
    if (message.includes('11210')) {
      expect(entries.some(entry => entry.content.includes('quota or credit'))).toBe(true);
    }
  });

  it('executes local fast paths for reads, failures, large artifacts, grep, and blocked commands', async () => {
    writeFileSync(join(root, 'small.txt'), 'small result');
    writeFileSync(join(root, 'large.txt'), 'large-output\n'.repeat(400));
    const runtime = createRuntime(root, {
      getSession: jest.fn(() => null),
      ensureSession: jest.fn(() => null as never),
    });
    const { events, entries, statuses } = createEvents();
    const controller = new AgentChatController(runtime, events);

    await controller.runInput('read small.txt', {
      turnId: 'small',
      persistAsUserMessage: false,
    });
    await controller.runInput('读取 large.txt', { turnId: 'large' });
    await controller.runInput('read missing.txt', { turnId: 'missing' });
    await controller.runInput('grep small', { turnId: 'grep' });
    await controller.runInput('run test: printf ok', { turnId: 'exec' });

    const historyText = runtime.store
      .getSnapshot()
      .conversationHistory.map(message => message.content)
      .join('\n');
    expect(historyText).toContain('small result');
    expect(historyText).toContain('/artifacts show');
    expect(entries.some(entry => entry.role === 'error')).toBe(true);
    expect(statuses.some(status => status.startsWith('Completed local'))).toBe(true);
    expect(runtime.store.getSnapshot().lastLoopStats?.localFastPathUsed).toBe(true);
  });

  it('loads and closes session state with and without active sessions', () => {
    const runtime = createRuntime(root);
    expect(loadSessionIntoRuntime(runtime, 'missing-session')).toBe('Restored 0 messages');
    closeSession(runtime);

    const session = runtime.ensureSession();
    appendSessionMessage(session.id, { role: 'user', content: 'hello', timestamp: Date.now() });
    appendSessionMessage(session.id, {
      role: 'assistant',
      content: 'answer',
      timestamp: Date.now(),
    });
    expect(loadSessionIntoRuntime(runtime, session.id)).toBe('Restored 2 messages');
    expect(runtime.store.getSnapshot().conversationHistory).toHaveLength(2);
    closeSession(runtime);
    expect(readSessionMessages(session.id)).toHaveLength(2);
  });
});
