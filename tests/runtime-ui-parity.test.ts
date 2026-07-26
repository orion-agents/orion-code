import { AgentRuntimeController, type AgentRuntimeRunner } from '../src/runtime/agent-runtime-controller';
import type { AgentRuntimeEvent, AgentRuntimeEventSink } from '../src/runtime/agent-runtime-protocol';
import type {
  OpenHorseUiRuntime,
  RuntimeToolFinishedEvent,
  RuntimeSessionRestoredEvent,
  RuntimeToolStartedEvent,
  ToolPermissionRequest,
  TranscriptAppendEntry,
  UiEventSink,
} from '../src/runtime/ui-events';

type SinkMode = 'ui-events' | 'runtime-events';

function createRuntime(): OpenHorseUiRuntime {
  return {
    cwd: '/tmp/openhorse-parity',
    version: 'test',
    config: { model: 'test-model', ui: { renderer: 'terminal' } } as OpenHorseUiRuntime['config'],
    store: {
      setProcessing: jest.fn(),
    } as unknown as OpenHorseUiRuntime['store'],
    llm: null,
    runtime: {} as OpenHorseUiRuntime['runtime'],
    isConfigured: true,
    ensureSession: jest.fn(),
    setSession: jest.fn(),
    getSession: jest.fn(() => null),
    shutdown: jest.fn(),
  };
}

function createDeferredRunner(): AgentRuntimeRunner & {
  calls: Array<{ input: string; signal?: AbortSignal; resolve: () => void }>;
} {
  const calls: Array<{ input: string; signal?: AbortSignal; resolve: () => void }> = [];
  return {
    calls,
    runInput: jest.fn((input, options) => new Promise<void>(resolve => {
      calls.push({ input, signal: options?.abortSignal, resolve });
    })),
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
    finalize: (id, patch) => events.push(normalizeEvent({ type: 'transcript_finalize', id, patch })),
    remove: id => events.push(normalizeEvent({ type: 'transcript_remove', id })),
    replaceTranscript: entries => events.push(normalizeEvent({ type: 'transcript_replace', entries })),
    clearTranscript: () => events.push(normalizeEvent({ type: 'transcript_clear' })),
    setStatus: message => events.push(normalizeEvent({ type: 'status_changed', message })),
    showSessionPicker: request => events.push(normalizeEvent({ type: 'session_picker_requested', request })),
    showEditPreview: request => events.push(normalizeEvent({ type: 'edit_preview_requested', request })),
    showPermissionRequest: request => events.push(normalizeEvent({ type: 'permission_requested', request })),
    toolStarted: (event: RuntimeToolStartedEvent) => events.push(normalizeEvent({ type: 'tool_started', event })),
    toolFinished: (event: RuntimeToolFinishedEvent) => events.push(normalizeEvent({ type: 'tool_finished', event })),
    sessionRestored: (event: RuntimeSessionRestoredEvent) => events.push(normalizeEvent({ type: 'session_restored', event })),
    loopStatsUpdated: stats => events.push(normalizeEvent({ type: 'loop_stats_updated', stats })),
    traceEventRecorded: event => events.push(normalizeEvent({ type: 'trace_event_recorded', event })),
    harnessDiagnosticsUpdated: diagnostics => events.push(normalizeEvent({ type: 'harness_diagnostics_updated', diagnostics })),
    setProcessing: processing => events.push(normalizeEvent({ type: 'processing_changed', processing })),
  };

  return {
    controller: new AgentRuntimeController({ runtime, events: uiEvents, runner }),
    runner,
    events,
  };
}

async function runRevisionScenario(mode: SinkMode): Promise<{ runnerInputs: string[]; firstAborted: boolean; events: string[] }> {
  const { controller, runner, events } = createRecordingController(mode);

  expect(controller.handle({ type: 'submit', text: 'first goal', source: 'composer' })).toEqual({ type: 'started' });
  expect(controller.handle({ type: 'submit', text: 'latest revision', source: 'composer' })).toEqual({ type: 'revision_requested' });
  const firstAborted = runner.calls[0].signal?.aborted === true;

  runner.calls[0].resolve();
  await Promise.resolve();
  runner.calls[1].resolve();
  await controller.waitForIdle();

  return {
    runnerInputs: runner.calls.map(call => call.input),
    firstAborted,
    events,
  };
}

async function runPermissionScenario(mode: SinkMode): Promise<{ result: boolean; events: string[] }> {
  const { controller, events } = createRecordingController(mode);
  const decision = controller.requestToolPermission({
    name: 'exec_command',
    args: { command: 'npm publish' },
    reason: 'publishing changes external state',
  });

  expect(controller.handle({
    type: 'permission_decision',
    requestId: 'permission-1',
    approved: false,
    source: 'programmatic',
  })).toEqual({ type: 'permission_decision_recorded' });

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
      'append:user:first goal',
      'processing:true',
      'status:Revision received. Interrupting current response...',
      'status:Restarting with latest instruction...',
      'append:user:latest revision',
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
      'status:Waiting: permission required for exec_command',
      'permission:exec_command:publishing changes external state',
    ]);
  });

  it('maps session picker selections to identical runtime command input', async () => {
    const ui = createRecordingController('ui-events');
    const runtime = createRecordingController('runtime-events');

    expect(ui.controller.handle({
      type: 'select_session',
      sessionId: 'session-abc',
      allProjects: true,
      source: 'picker',
    })).toEqual({ type: 'started' });
    expect(runtime.controller.handle({
      type: 'select_session',
      sessionId: 'session-abc',
      allProjects: true,
      source: 'picker',
    })).toEqual({ type: 'started' });

    ui.runner.calls[0].resolve();
    runtime.runner.calls[0].resolve();
    await ui.controller.waitForIdle();
    await runtime.controller.waitForIdle();

    expect(ui.runner.calls.map(call => call.input)).toEqual(runtime.runner.calls.map(call => call.input));
    expect(ui.runner.calls.map(call => call.input)).toEqual(['/resume session-abc --all']);
    expect(ui.events).toEqual(runtime.events);
  });

  it('routes plain text submit through both adapters identically', async () => {
    const ui = createRecordingController('ui-events');
    const runtime = createRecordingController('runtime-events');

    expect(ui.controller.handle({ type: 'submit', text: 'hello', source: 'composer' })).toEqual({ type: 'started' });
    expect(runtime.controller.handle({ type: 'submit', text: 'hello', source: 'composer' })).toEqual({ type: 'started' });

    ui.runner.calls[0].resolve();
    runtime.runner.calls[0].resolve();
    await ui.controller.waitForIdle();
    await runtime.controller.waitForIdle();

    expect(ui.runner.calls.map(call => call.input)).toEqual(['hello']);
    expect(runtime.runner.calls.map(call => call.input)).toEqual(['hello']);
    expect(ui.events).toEqual(runtime.events);
    expect(ui.events).toEqual([
      'append:user:hello',
      'processing:true',
      'processing:false',
    ]);
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
      update: (id, patch) => ui.events.push(normalizeEvent({ type: 'transcript_update', id, patch })),
      finalize: (id, patch) => ui.events.push(normalizeEvent({ type: 'transcript_finalize', id, patch })),
      remove: id => ui.events.push(normalizeEvent({ type: 'transcript_remove', id })),
      replaceTranscript: entries => ui.events.push(normalizeEvent({ type: 'transcript_replace', entries })),
      clearTranscript: () => ui.events.push(normalizeEvent({ type: 'transcript_clear' })),
      setStatus: message => ui.events.push(normalizeEvent({ type: 'status_changed', message })),
      showSessionPicker: request => ui.events.push(normalizeEvent({ type: 'session_picker_requested', request })),
      showEditPreview: request => ui.events.push(normalizeEvent({ type: 'edit_preview_requested', request })),
      showPermissionRequest: request => ui.events.push(normalizeEvent({ type: 'permission_requested', request })),
      toolStarted: tool => ui.events.push(normalizeEvent({ type: 'tool_started', event: tool })),
      toolFinished: tool => ui.events.push(normalizeEvent({ type: 'tool_finished', event: tool })),
      sessionRestored: restored => ui.events.push(normalizeEvent({ type: 'session_restored', event: restored })),
      loopStatsUpdated: stats => ui.events.push(normalizeEvent({ type: 'loop_stats_updated', stats })),
      traceEventRecorded: trace => ui.events.push(normalizeEvent({ type: 'trace_event_recorded', event: trace })),
      harnessDiagnosticsUpdated: diagnostics => ui.events.push(normalizeEvent({ type: 'harness_diagnostics_updated', diagnostics })),
      setProcessing: processing => ui.events.push(normalizeEvent({ type: 'processing_changed', processing })),
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
      update: (id, patch) => ui.events.push(normalizeEvent({ type: 'transcript_update', id, patch })),
      finalize: (id, patch) => ui.events.push(normalizeEvent({ type: 'transcript_finalize', id, patch })),
      remove: id => ui.events.push(normalizeEvent({ type: 'transcript_remove', id })),
      replaceTranscript: replaced => ui.events.push(normalizeEvent({ type: 'transcript_replace', entries: replaced })),
      clearTranscript: () => ui.events.push(normalizeEvent({ type: 'transcript_clear' })),
      setStatus: message => ui.events.push(normalizeEvent({ type: 'status_changed', message })),
      showSessionPicker: request => ui.events.push(normalizeEvent({ type: 'session_picker_requested', request })),
      showEditPreview: request => ui.events.push(normalizeEvent({ type: 'edit_preview_requested', request })),
      showPermissionRequest: request => ui.events.push(normalizeEvent({ type: 'permission_requested', request })),
      toolStarted: tool => ui.events.push(normalizeEvent({ type: 'tool_started', event: tool })),
      toolFinished: tool => ui.events.push(normalizeEvent({ type: 'tool_finished', event: tool })),
      sessionRestored: restored => ui.events.push(normalizeEvent({ type: 'session_restored', event: restored })),
      loopStatsUpdated: stats => ui.events.push(normalizeEvent({ type: 'loop_stats_updated', stats })),
      traceEventRecorded: trace => ui.events.push(normalizeEvent({ type: 'trace_event_recorded', event: trace })),
      harnessDiagnosticsUpdated: diagnostics => ui.events.push(normalizeEvent({ type: 'harness_diagnostics_updated', diagnostics })),
      setProcessing: processing => ui.events.push(normalizeEvent({ type: 'processing_changed', processing })),
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
      update: (id, patch) => ui.events.push(normalizeEvent({ type: 'transcript_update', id, patch })),
      finalize: (id, patch) => ui.events.push(normalizeEvent({ type: 'transcript_finalize', id, patch })),
      remove: id => ui.events.push(normalizeEvent({ type: 'transcript_remove', id })),
      replaceTranscript: entries => ui.events.push(normalizeEvent({ type: 'transcript_replace', entries })),
      clearTranscript: () => ui.events.push(normalizeEvent({ type: 'transcript_clear' })),
      setStatus: message => ui.events.push(normalizeEvent({ type: 'status_changed', message })),
      showSessionPicker: request => ui.events.push(normalizeEvent({ type: 'session_picker_requested', request })),
      showEditPreview: request => ui.events.push(normalizeEvent({ type: 'edit_preview_requested', request })),
      showPermissionRequest: request => ui.events.push(normalizeEvent({ type: 'permission_requested', request })),
      toolStarted: started => ui.events.push(normalizeEvent({ type: 'tool_started', event: started })),
      toolFinished: finished => ui.events.push(normalizeEvent({ type: 'tool_finished', event: finished })),
      sessionRestored: restored => ui.events.push(normalizeEvent({ type: 'session_restored', event: restored })),
      loopStatsUpdated: stats => ui.events.push(normalizeEvent({ type: 'loop_stats_updated', stats })),
      traceEventRecorded: trace => ui.events.push(normalizeEvent({ type: 'trace_event_recorded', event: trace })),
      harnessDiagnosticsUpdated: diagnostics => ui.events.push(normalizeEvent({ type: 'harness_diagnostics_updated', diagnostics })),
      setProcessing: processing => ui.events.push(normalizeEvent({ type: 'processing_changed', processing })),
    };
    uiSink.sessionRestored?.(event);

    runtime.events.push(normalizeEvent({ type: 'session_restored', event }));

    expect(ui.events).toEqual(runtime.events);
    expect(ui.events).toEqual([
      'session_restored:session-abc:3:7:123456:checkpoint-1',
    ]);
  });

  // --- v0.2.19 completion: TUI-vs-terminal capability parity ---

  it('resolves identical capabilities for tui and terminal renderers', () => {
    const { resolveUiRendererCapabilities } = require('../src/runtime/ui-events');
    const tuiCaps = resolveUiRendererCapabilities(undefined, 'tui');
    const terminalCaps = resolveUiRendererCapabilities(undefined, 'terminal');

    // TUI must have the same interactive capabilities as the default terminal renderer
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
