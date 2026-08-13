import {
  AgentRuntimeController,
  type AgentRuntimeRunner,
} from '../src/runtime/agent-runtime-controller';
import type {
  AgentRuntimeEvent,
  AgentRuntimeEventSink,
} from '../src/runtime/agent-runtime-protocol';
import type { AgentTurnRequest } from '../src/runtime/goals/types';
import type { ResearchLifecycleEvent } from '../src/runtime/subagents/research-renderer';
import type {
  OrionCodeUiRuntime,
  RuntimeToolFinishedEvent,
  RuntimeSessionRestoredEvent,
  RuntimeToolStartedEvent,
  ToolPermissionRequest,
  TranscriptAppendEntry,
  UiEventSink,
} from '../src/runtime/ui-events';

type SinkMode = 'ui-events' | 'runtime-events';

function createRuntime(): OrionCodeUiRuntime {
  let session: ReturnType<OrionCodeUiRuntime['getSession']> = null;
  return {
    cwd: `/tmp/orion-parity-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    version: 'test',
    config: { model: 'test-model', ui: { renderer: 'terminal' } } as OrionCodeUiRuntime['config'],
    store: {
      setProcessing: jest.fn(),
    } as unknown as OrionCodeUiRuntime['store'],
    llm: null,
    runtime: {} as OrionCodeUiRuntime['runtime'],
    isConfigured: true,
    ensureSession: jest.fn(() => {
      session ??= { id: 'session-parity' } as NonNullable<typeof session>;
      return session;
    }),
    setSession: jest.fn(nextSession => {
      session = nextSession;
    }),
    getSession: jest.fn(() => session),
    shutdown: jest.fn(),
  };
}

function createDeferredRunner(): AgentRuntimeRunner & {
  calls: Array<{
    input: string;
    request?: AgentTurnRequest;
    signal?: AbortSignal;
    resolve: () => void;
  }>;
} {
  const calls: Array<{
    input: string;
    request?: AgentTurnRequest;
    signal?: AbortSignal;
    resolve: () => void;
  }> = [];
  return {
    calls,
    runInput: jest.fn(
      (input, options) =>
        new Promise<void>(resolve => {
          calls.push({ input, signal: options?.abortSignal, resolve });
        })
    ),
    runRequest: jest.fn(
      (request, options) =>
        new Promise<void>(resolve => {
          calls.push({ input: request.text ?? '', request, signal: options?.abortSignal, resolve });
        })
    ),
  };
}

function normalizeEvent(event: AgentRuntimeEvent): string {
  switch (event.type) {
    case 'transcript_append':
      return `append:${event.entry.role}:${event.entry.content}`;
    case 'status_changed':
      return `status:${event.message}`;
    case 'processing_changed':
      return `processing:${event.processing}`;
    case 'agent_mode_changed':
      return `agent_mode:${event.snapshot.baseMode}:${event.snapshot.pendingBaseMode ?? ''}`;
    case 'permission_requested':
      return `permission:${event.request.name}:${event.request.reason ?? ''}`;
    case 'tool_started':
      return `tool_started:${event.event.callId}:${event.event.name}`;
    case 'tool_finished':
      return `tool_finished:${event.event.callId}:${event.event.name}:${event.event.success}`;
    case 'session_restored':
      return `session_restored:${event.event.sessionId}:${event.event.restoredMessages}:${event.event.transcriptMessages ?? ''}:${event.event.summaryGeneratedAt ?? ''}:${event.event.checkpointId ?? ''}`;
    case 'loop_stats_updated':
      return `loop_stats:${event.stats.finishReason}:${event.stats.llmRequests}:${event.stats.toolCalls}`;
    case 'trace_event_recorded':
      return `trace:${event.event.turnId}:${event.event.type}`;
    case 'harness_diagnostics_updated':
      return `harness:${event.diagnostics.taskEpoch ?? '?'}:${event.diagnostics.evidenceSize}:${event.diagnostics.turnSummaryCount}`;
    case 'subtask_event':
      return `subtask:${event.event.state}:${event.event.role}:${event.event.taskId}`;
    case 'research_event':
      return event.event.type === 'research_source'
        ? `research:${event.event.type}:${event.event.packetId}:${event.event.sourceId}:${event.event.kind ?? ''}:${event.event.displayUrl ?? event.event.canonicalUrl ?? ''}:${event.event.contentHash ?? ''}`
        : `research:${event.event.type}:${event.event.packetId}`;
    case 'goal_event':
      return `goal:${event.event.type}`;
    case 'effort_event':
      return `effort:${event.event.type}:${event.event.requested}`;
    case 'followup_queue_changed':
      return `followup_queue:${event.snapshot.items.length}:${event.snapshot.limit}`;
    case 'session_picker_requested':
      return `session_picker:${event.request.title}:${event.request.sessions.length}`;
    case 'edit_preview_requested':
      return `edit_preview:${event.request.path}:${event.request.candidates.length}`;
    case 'transcript_update':
      return `update:${event.id}:${event.patch.content ?? ''}`;
    case 'transcript_finalize':
      return `finalize:${event.id}`;
    case 'transcript_remove':
      return `remove:${event.id}`;
    case 'transcript_replace':
      return `replace:${event.entries.length}`;
    case 'transcript_clear':
      return 'clear';
    case 'clear_view':
      return 'clear_view';
    case 'shutdown_requested':
      return `shutdown_requested:${event.reason ?? ''}`;
    case 'model_picker_requested':
      return `model_picker:${event.request.title ?? ''}:${event.request.models.length}`;
  }
}

function createRecordingController(mode: SinkMode): {
  controller: AgentRuntimeController;
  runner: ReturnType<typeof createDeferredRunner>;
  events: string[];
} {
  const runtime = createRuntime();
  const runner = createDeferredRunner();
  const events: string[] = [];

  if (mode === 'runtime-events') {
    const eventSink: AgentRuntimeEventSink = {
      emit: event => {
        events.push(normalizeEvent(event));
        return event.type === 'transcript_append' ? `event-${events.length}` : undefined;
      },
    };
    return {
      controller: new AgentRuntimeController({ runtime, eventSink, runner }),
      runner,
      events,
    };
  }

  const uiEvents: UiEventSink = {
    append: (entry: TranscriptAppendEntry) => {
      events.push(normalizeEvent({ type: 'transcript_append', entry }));
      return `ui-${events.length}`;
    },
    update: (id, patch) => events.push(normalizeEvent({ type: 'transcript_update', id, patch })),
    finalize: (id, patch) =>
      events.push(normalizeEvent({ type: 'transcript_finalize', id, patch })),
    remove: id => events.push(normalizeEvent({ type: 'transcript_remove', id })),
    replaceTranscript: entries =>
      events.push(normalizeEvent({ type: 'transcript_replace', entries })),
    clearTranscript: () => events.push(normalizeEvent({ type: 'transcript_clear' })),
    setStatus: message => events.push(normalizeEvent({ type: 'status_changed', message })),
    showSessionPicker: request =>
      events.push(normalizeEvent({ type: 'session_picker_requested', request })),
    showEditPreview: request =>
      events.push(normalizeEvent({ type: 'edit_preview_requested', request })),
    showPermissionRequest: request =>
      events.push(normalizeEvent({ type: 'permission_requested', request })),
    toolStarted: (event: RuntimeToolStartedEvent) =>
      events.push(normalizeEvent({ type: 'tool_started', event })),
    toolFinished: (event: RuntimeToolFinishedEvent) =>
      events.push(normalizeEvent({ type: 'tool_finished', event })),
    sessionRestored: (event: RuntimeSessionRestoredEvent) =>
      events.push(normalizeEvent({ type: 'session_restored', event })),
    loopStatsUpdated: stats => events.push(normalizeEvent({ type: 'loop_stats_updated', stats })),
    traceEventRecorded: event =>
      events.push(normalizeEvent({ type: 'trace_event_recorded', event })),
    harnessDiagnosticsUpdated: diagnostics =>
      events.push(normalizeEvent({ type: 'harness_diagnostics_updated', diagnostics })),
    goalEvent: event => events.push(normalizeEvent({ type: 'goal_event', event })),
    researchEvent: event => events.push(normalizeEvent({ type: 'research_event', event })),
    setProcessing: processing =>
      events.push(normalizeEvent({ type: 'processing_changed', processing })),
    agentModeChanged: snapshot =>
      events.push(normalizeEvent({ type: 'agent_mode_changed', snapshot })),
    clearView: () => events.push(normalizeEvent({ type: 'clear_view' })),
    shutdownRequested: reason =>
      events.push(normalizeEvent({ type: 'shutdown_requested', reason })),
  };

  return {
    controller: new AgentRuntimeController({ runtime, events: uiEvents, runner }),
    runner,
    events,
  };
}

async function runRevisionScenario(
  mode: SinkMode
): Promise<{ runnerInputs: string[]; firstAborted: boolean; events: string[] }> {
  const { controller, runner, events } = createRecordingController(mode);

  expect(controller.handle({ type: 'submit', text: 'first goal', source: 'composer' })).toEqual({
    type: 'started',
  });
  expect(
    controller.handle({ type: 'submit', text: 'latest revision', source: 'composer' })
  ).toEqual({ type: 'revision_requested' });
  const firstAborted = runner.calls[0].signal?.aborted === true;

  runner.calls[0].resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  runner.calls[1].resolve();
  await controller.waitForIdle();

  return {
    runnerInputs: runner.calls.map(call => call.input),
    firstAborted,
    events,
  };
}

async function runPermissionScenario(
  mode: SinkMode
): Promise<{ result: boolean; events: string[] }> {
  const { controller, events } = createRecordingController(mode);
  const decision = controller.requestToolPermission({
    name: 'exec_command',
    args: { command: 'npm publish' },
    reason: 'publishing changes external state',
  });

  expect(
    controller.handle({
      type: 'permission_decision',
      requestId: 'permission-1',
      approved: false,
      source: 'programmatic',
    })
  ).toEqual({ type: 'permission_decision_recorded' });

  return { result: await decision, events };
}

describe('runtime/UI renderer parity contract', () => {
  it('preserves live revision turn semantics through both renderer event adapters', async () => {
    const ui = await runRevisionScenario('ui-events');
    const runtime = await runRevisionScenario('runtime-events');

    expect(ui).toEqual(runtime);
    expect(ui.runnerInputs).toEqual(['first goal', 'latest revision']);
    expect(ui.firstAborted).toBe(true);
    expect(ui.events).toEqual([
      'agent_mode:interactive:',
      'append:user:first goal',
      'processing:true',
      'append:user:latest revision',
      'status:已接收补充，正在中断当前轮…',
      'status:根据补充调整方向中…',
      'processing:true',
      'processing:false',
    ]);
  });

  it('routes permission requests and decisions through the same runtime contract', async () => {
    const ui = await runPermissionScenario('ui-events');
    const runtime = await runPermissionScenario('runtime-events');

    expect(ui).toEqual(runtime);
    expect(ui.result).toBe(false);
    expect(ui.events).toEqual([
      'agent_mode:interactive:',
      'status:Waiting: permission required for exec_command',
      'permission:exec_command:publishing changes external state',
    ]);
  });

  it('maps session picker selections to identical runtime command input', async () => {
    const ui = createRecordingController('ui-events');
    const runtime = createRecordingController('runtime-events');

    expect(
      ui.controller.handle({
        type: 'select_session',
        sessionId: 'session-abc',
        allProjects: true,
        source: 'picker',
      })
    ).toEqual({ type: 'started' });
    expect(
      runtime.controller.handle({
        type: 'select_session',
        sessionId: 'session-abc',
        allProjects: true,
        source: 'picker',
      })
    ).toEqual({ type: 'started' });

    ui.runner.calls[0].resolve();
    runtime.runner.calls[0].resolve();
    await ui.controller.waitForIdle();
    await runtime.controller.waitForIdle();

    expect(ui.runner.calls.map(call => call.input)).toEqual(
      runtime.runner.calls.map(call => call.input)
    );
    expect(ui.runner.calls.map(call => call.input)).toEqual(['/resume session-abc --all']);
    expect(ui.events).toEqual(runtime.events);
  });

  it('routes plain text submit through both adapters identically', async () => {
    const ui = createRecordingController('ui-events');
    const runtime = createRecordingController('runtime-events');

    expect(ui.controller.handle({ type: 'submit', text: 'hello', source: 'composer' })).toEqual({
      type: 'started',
    });
    expect(
      runtime.controller.handle({ type: 'submit', text: 'hello', source: 'composer' })
    ).toEqual({ type: 'started' });

    ui.runner.calls[0].resolve();
    runtime.runner.calls[0].resolve();
    await ui.controller.waitForIdle();
    await runtime.controller.waitForIdle();

    expect(ui.runner.calls.map(call => call.input)).toEqual(['hello']);
    expect(runtime.runner.calls.map(call => call.input)).toEqual(['hello']);
    expect(ui.events).toEqual(runtime.events);
    expect(ui.events).toEqual([
      'agent_mode:interactive:',
      'append:user:hello',
      'processing:true',
      'processing:false',
    ]);
  });

  it('routes clear and shutdown system events through both adapters identically', () => {
    const ui = createRecordingController('ui-events');
    const runtime = createRecordingController('runtime-events');

    expect(ui.controller.handle({ type: 'submit', text: '/clear', source: 'composer' })).toEqual({
      type: 'command_handled',
    });
    expect(
      runtime.controller.handle({ type: 'submit', text: '/clear', source: 'composer' })
    ).toEqual({ type: 'command_handled' });
    expect(ui.controller.handle({ type: 'submit', text: '/exit', source: 'composer' })).toEqual({
      type: 'exit_requested',
    });
    expect(
      runtime.controller.handle({ type: 'submit', text: '/exit', source: 'composer' })
    ).toEqual({ type: 'exit_requested' });

    expect(ui.events).toEqual(runtime.events);
    expect(ui.events).toEqual([
      'agent_mode:interactive:',
      'clear_view',
      'status:View cleared. Conversation context is preserved.',
      'shutdown_requested:user request',
    ]);
  });

  it('routes /target through the shared controller for every renderer adapter', async () => {
    const ui = createRecordingController('ui-events');
    const runtime = createRecordingController('runtime-events');

    expect(
      ui.controller.handle({
        type: 'submit',
        text: '/target verify renderer parity',
        source: 'composer',
      })
    ).toEqual({ type: 'started' });
    expect(
      runtime.controller.handle({
        type: 'submit',
        text: '/target verify renderer parity',
        source: 'composer',
      })
    ).toEqual({ type: 'started' });

    expect(ui.runner.calls.map(call => call.request?.inputKind)).toEqual(['goal_continuation']);
    expect(runtime.runner.calls.map(call => call.request?.inputKind)).toEqual([
      'goal_continuation',
    ]);
    expect(ui.runner.calls[0].request).toMatchObject({
      persistAsUserMessage: false,
      echoToTranscript: false,
      goal: { continuationIndex: 1 },
    });
    expect(ui.runner.calls[0].input).not.toContain('[goal continuation');
    expect(ui.events).toEqual(runtime.events);
    const targetStatus = ui.events.find(event => event.startsWith('append:system:Target:'));
    expect(targetStatus).toContain('Target: [active] verify renderer parity | 0 turns | 0 tokens');
    expect(targetStatus).toContain('\nPlan: r0 initial');
    expect(targetStatus).toContain('\nCriteria: 1 pending | 0/1 passed | 0 failed | 0 stale');

    ui.runner.calls[0].resolve();
    runtime.runner.calls[0].resolve();
    await ui.controller.stopActiveTurn();
    await runtime.controller.stopActiveTurn();
  });

  it('reports pending, passed, failed, and stale criteria explicitly', async () => {
    const recording = createRecordingController('runtime-events');
    expect(recording.controller.submit('/target verify mixed criterion states')).toEqual({
      type: 'started',
    });

    const coordinator = (
      recording.controller as unknown as {
        goalCoordinator: import('../src/runtime/goals/coordinator').GoalCoordinator;
      }
    ).goalCoordinator;
    const primary = coordinator.goal!.contract!.successCriteria[0];
    primary.status = 'passed';
    coordinator.goal!.contract!.successCriteria.push(
      { ...primary, id: 'criterion:pending', status: 'pending' },
      { ...primary, id: 'criterion:failed', status: 'failed' },
      { ...primary, id: 'criterion:stale', status: 'stale' }
    );

    const status = recording.controller.handleTargetInput('/target status').statusText;
    expect(status).toContain('Criteria: 1 pending | 1/4 passed | 1 failed | 1 stale');
    expect(recording.events).toEqual(
      expect.arrayContaining([
        'append:system:/target is deprecated; use /goal. It will be removed in v0.3.0.',
      ])
    );

    recording.runner.calls[0].resolve();
    await recording.controller.stopActiveTurn();
  });

  it('adapts tool started and finished events identically across runtime and UI sinks', () => {
    const ui = createRecordingController('ui-events');
    const runtime = createRecordingController('runtime-events');
    const started: RuntimeToolStartedEvent = {
      callId: 'call-123',
      name: 'read_file',
      args: { path: 'src/index.ts' },
      sequence: 1,
      batchCount: 1,
      batchIndex: 0,
    };
    const finished: RuntimeToolFinishedEvent = {
      callId: 'call-123',
      name: 'read_file',
      args: { path: 'src/index.ts' },
      success: true,
      duration: 12,
      sequence: 1,
      batchCount: 1,
      batchIndex: 0,
    };

    ui.events.length = 0;
    runtime.events.length = 0;

    const uiSink: UiEventSink = {
      append: entry => {
        ui.events.push(normalizeEvent({ type: 'transcript_append', entry }));
        return 'ui-entry';
      },
      update: (id, patch) =>
        ui.events.push(normalizeEvent({ type: 'transcript_update', id, patch })),
      finalize: (id, patch) =>
        ui.events.push(normalizeEvent({ type: 'transcript_finalize', id, patch })),
      remove: id => ui.events.push(normalizeEvent({ type: 'transcript_remove', id })),
      replaceTranscript: entries =>
        ui.events.push(normalizeEvent({ type: 'transcript_replace', entries })),
      clearTranscript: () => ui.events.push(normalizeEvent({ type: 'transcript_clear' })),
      setStatus: message => ui.events.push(normalizeEvent({ type: 'status_changed', message })),
      showSessionPicker: request =>
        ui.events.push(normalizeEvent({ type: 'session_picker_requested', request })),
      showEditPreview: request =>
        ui.events.push(normalizeEvent({ type: 'edit_preview_requested', request })),
      showPermissionRequest: request =>
        ui.events.push(normalizeEvent({ type: 'permission_requested', request })),
      toolStarted: tool => ui.events.push(normalizeEvent({ type: 'tool_started', event: tool })),
      toolFinished: tool => ui.events.push(normalizeEvent({ type: 'tool_finished', event: tool })),
      sessionRestored: restored =>
        ui.events.push(normalizeEvent({ type: 'session_restored', event: restored })),
      loopStatsUpdated: stats =>
        ui.events.push(normalizeEvent({ type: 'loop_stats_updated', stats })),
      traceEventRecorded: trace =>
        ui.events.push(normalizeEvent({ type: 'trace_event_recorded', event: trace })),
      harnessDiagnosticsUpdated: diagnostics =>
        ui.events.push(normalizeEvent({ type: 'harness_diagnostics_updated', diagnostics })),
      setProcessing: processing =>
        ui.events.push(normalizeEvent({ type: 'processing_changed', processing })),
    };
    uiSink.toolStarted?.(started);
    uiSink.toolFinished?.(finished);

    runtime.events.push(normalizeEvent({ type: 'tool_started', event: started }));
    runtime.events.push(normalizeEvent({ type: 'tool_finished', event: finished }));

    expect(ui.events).toEqual(runtime.events);
    expect(ui.events).toEqual([
      'tool_started:call-123:read_file',
      'tool_finished:call-123:read_file:true',
    ]);
  });

  it('preserves typed research_source payload across runtime and UI sink adapters', () => {
    const ui = createRecordingController('ui-events');
    const runtime = createRecordingController('runtime-events');
    const event: ResearchLifecycleEvent = {
      type: 'research_source',
      packetId: 'pkt-parity',
      sourceId: 'src-1',
      status: 'retrieved',
      provider: 'ddg',
      kind: 'web_page',
      displayUrl: 'https://example.com/doc',
      contentHash: 'abcdef1234567890',
    };

    ui.events.length = 0;
    runtime.events.length = 0;
    (ui.controller as unknown as { eventSink: AgentRuntimeEventSink }).eventSink.emit({
      type: 'research_event',
      event,
    });
    (runtime.controller as unknown as { eventSink: AgentRuntimeEventSink }).eventSink.emit({
      type: 'research_event',
      event,
    });

    expect(ui.events).toEqual(runtime.events);
    expect(ui.events).toEqual([
      'research:research_source:pkt-parity:src-1:web_page:https://example.com/doc:abcdef1234567890',
    ]);
  });

  it('adapts transcript replacement identically across runtime and UI sinks', () => {
    const ui = createRecordingController('ui-events');
    const runtime = createRecordingController('runtime-events');
    const entries = [
      { id: 'entry-1', role: 'user' as const, content: 'hello' },
      { id: 'entry-2', role: 'assistant' as const, content: 'world' },
    ];

    ui.events.length = 0;
    runtime.events.length = 0;

    const uiSink: UiEventSink = {
      append: entry => {
        ui.events.push(normalizeEvent({ type: 'transcript_append', entry }));
        return 'ui-entry';
      },
      update: (id, patch) =>
        ui.events.push(normalizeEvent({ type: 'transcript_update', id, patch })),
      finalize: (id, patch) =>
        ui.events.push(normalizeEvent({ type: 'transcript_finalize', id, patch })),
      remove: id => ui.events.push(normalizeEvent({ type: 'transcript_remove', id })),
      replaceTranscript: replaced =>
        ui.events.push(normalizeEvent({ type: 'transcript_replace', entries: replaced })),
      clearTranscript: () => ui.events.push(normalizeEvent({ type: 'transcript_clear' })),
      setStatus: message => ui.events.push(normalizeEvent({ type: 'status_changed', message })),
      showSessionPicker: request =>
        ui.events.push(normalizeEvent({ type: 'session_picker_requested', request })),
      showEditPreview: request =>
        ui.events.push(normalizeEvent({ type: 'edit_preview_requested', request })),
      showPermissionRequest: request =>
        ui.events.push(normalizeEvent({ type: 'permission_requested', request })),
      toolStarted: tool => ui.events.push(normalizeEvent({ type: 'tool_started', event: tool })),
      toolFinished: tool => ui.events.push(normalizeEvent({ type: 'tool_finished', event: tool })),
      sessionRestored: restored =>
        ui.events.push(normalizeEvent({ type: 'session_restored', event: restored })),
      loopStatsUpdated: stats =>
        ui.events.push(normalizeEvent({ type: 'loop_stats_updated', stats })),
      traceEventRecorded: trace =>
        ui.events.push(normalizeEvent({ type: 'trace_event_recorded', event: trace })),
      harnessDiagnosticsUpdated: diagnostics =>
        ui.events.push(normalizeEvent({ type: 'harness_diagnostics_updated', diagnostics })),
      setProcessing: processing =>
        ui.events.push(normalizeEvent({ type: 'processing_changed', processing })),
    };
    uiSink.replaceTranscript?.(entries);

    runtime.events.push(normalizeEvent({ type: 'transcript_replace', entries }));

    expect(ui.events).toEqual(runtime.events);
    expect(ui.events).toEqual(['replace:2']);
  });

  it('adapts session restored events identically across runtime and UI sinks', () => {
    const ui = createRecordingController('ui-events');
    const runtime = createRecordingController('runtime-events');
    const event = {
      sessionId: 'session-abc',
      projectPath: '/tmp/project',
      model: 'test-model',
      restoredMessages: 3,
      messageCount: 3,
      summary: 'restored summary',
      transcriptMessages: 7,
      summaryGeneratedAt: 123456,
      summarySource: 'llm' as const,
      summaryCoveredMessages: 9,
      checkpointId: 'checkpoint-1',
    };

    ui.events.length = 0;
    runtime.events.length = 0;

    const uiSink: UiEventSink = {
      append: entry => {
        ui.events.push(normalizeEvent({ type: 'transcript_append', entry }));
        return 'ui-entry';
      },
      update: (id, patch) =>
        ui.events.push(normalizeEvent({ type: 'transcript_update', id, patch })),
      finalize: (id, patch) =>
        ui.events.push(normalizeEvent({ type: 'transcript_finalize', id, patch })),
      remove: id => ui.events.push(normalizeEvent({ type: 'transcript_remove', id })),
      replaceTranscript: entries =>
        ui.events.push(normalizeEvent({ type: 'transcript_replace', entries })),
      clearTranscript: () => ui.events.push(normalizeEvent({ type: 'transcript_clear' })),
      setStatus: message => ui.events.push(normalizeEvent({ type: 'status_changed', message })),
      showSessionPicker: request =>
        ui.events.push(normalizeEvent({ type: 'session_picker_requested', request })),
      showEditPreview: request =>
        ui.events.push(normalizeEvent({ type: 'edit_preview_requested', request })),
      showPermissionRequest: request =>
        ui.events.push(normalizeEvent({ type: 'permission_requested', request })),
      toolStarted: started =>
        ui.events.push(normalizeEvent({ type: 'tool_started', event: started })),
      toolFinished: finished =>
        ui.events.push(normalizeEvent({ type: 'tool_finished', event: finished })),
      sessionRestored: restored =>
        ui.events.push(normalizeEvent({ type: 'session_restored', event: restored })),
      loopStatsUpdated: stats =>
        ui.events.push(normalizeEvent({ type: 'loop_stats_updated', stats })),
      traceEventRecorded: trace =>
        ui.events.push(normalizeEvent({ type: 'trace_event_recorded', event: trace })),
      harnessDiagnosticsUpdated: diagnostics =>
        ui.events.push(normalizeEvent({ type: 'harness_diagnostics_updated', diagnostics })),
      setProcessing: processing =>
        ui.events.push(normalizeEvent({ type: 'processing_changed', processing })),
    };
    uiSink.sessionRestored?.(event);

    runtime.events.push(normalizeEvent({ type: 'session_restored', event }));

    expect(ui.events).toEqual(runtime.events);
    expect(ui.events).toEqual(['session_restored:session-abc:3:7:123456:checkpoint-1']);
  });

  // --- v0.2.19 completion: TUI-vs-terminal capability parity ---

  it('resolves identical capabilities for tui and terminal renderers', () => {
    const { resolveUiRendererCapabilities } = require('../src/runtime/ui-events');
    const tuiCaps = resolveUiRendererCapabilities(undefined, 'tui');
    const terminalCaps = resolveUiRendererCapabilities(undefined, 'terminal');

    // TUI must have the same interactive capabilities as the technical terminal renderer
    expect(tuiCaps).toEqual(terminalCaps);
    expect(tuiCaps.structuredPickers).toBe(true);
    expect(tuiCaps.inlineProgress).toBe(true);
  });

  it('resolves different capabilities for print vs interactive renderers', () => {
    const { resolveUiRendererCapabilities } = require('../src/runtime/ui-events');
    const printCaps = resolveUiRendererCapabilities(undefined, 'print');
    const tuiCaps = resolveUiRendererCapabilities(undefined, 'tui');

    // Print renderer is non-interactive; TUI is interactive
    expect(printCaps.structuredPickers).toBe(false);
    expect(tuiCaps.structuredPickers).toBe(true);
    expect(printCaps).not.toEqual(tuiCaps);
  });
});
