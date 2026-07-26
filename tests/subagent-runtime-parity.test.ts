import {
  emitToUiEventSink,
  createUiEventSinkFromAgentRuntimeEvents,
  createAgentRuntimeEventSinkFromUiEvents,
  type AgentRuntimeEvent,
  type AgentRuntimeEventSink,
} from '../src/runtime/agent-runtime-protocol';
import type { UiEventSink } from '../src/runtime/ui-events';
import type { RuntimeSubtaskEvent } from '../src/runtime/subagents/types';

function subtaskEvent(state: RuntimeSubtaskEvent['state']): RuntimeSubtaskEvent {
  return {
    batchId: 'batch-1',
    taskId: 'task-1',
    role: 'research',
    state,
    objective: 'Investigate the runtime module cancel paths',
    summary: state === 'completed' ? 'Found 2 handlers' : undefined,
    durationMs: state === 'completed' ? 1500 : undefined,
  };
}

function normalize(event: AgentRuntimeEvent): string {
  if (event.type === 'subtask_event') {
    return `subtask:${event.event.state}:${event.event.role}:${event.event.taskId}`;
  }
  return `other:${event.type}`;
}

function makeUiSink(collector: string[]): UiEventSink {
  return {
    append: entry => { collector.push(`append:${entry.role}`); return 'id'; },
    update: () => {},
    finalize: () => {},
    remove: () => {},
    replaceTranscript: () => {},
    clearTranscript: () => {},
    setStatus: () => {},
    showSessionPicker: () => {},
    showEditPreview: () => {},
    subtaskEvent: e => collector.push(normalize({ type: 'subtask_event', event: e })),
    setProcessing: () => {},
  } as UiEventSink;
}

function makeRuntimeSink(collector: string[]): AgentRuntimeEventSink {
  return {
    emit: event => { collector.push(normalize(event)); return undefined; },
  };
}

describe('subagent runtime/UI parity', () => {
  const states: RuntimeSubtaskEvent['state'][] = ['queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out', 'rejected'];

  it('subtask_event round-trips identically through both adapter directions', () => {
    for (const state of states) {
      const event = subtaskEvent(state);

      // runtime-event -> ui-event
      const uiCollected: string[] = [];
      const uiSink = makeUiSink(uiCollected);
      const runtimeToUi = createUiEventSinkFromAgentRuntimeEvents(makeRuntimeSink(uiCollected));
      runtimeToUi.subtaskEvent!(event);
      expect(uiCollected).toContain(`subtask:${state}:research:task-1`);

      // ui-event -> runtime-event: a UiEventSink wrapping a runtime sink,
      // invoked via subtaskEvent, must arrive at the runtime sink.
      const rtCollected: string[] = [];
      const uiAdapter = createUiEventSinkFromAgentRuntimeEvents(makeRuntimeSink(rtCollected));
      uiAdapter.subtaskEvent!(event);
      expect(rtCollected).toContain(`subtask:${state}:research:task-1`);
    }
  });

  it('emitToUiEventSink dispatches subtask_event to the ui sink', () => {
    const collected: string[] = [];
    const sink = makeUiSink(collected);
    emitToUiEventSink(sink, { type: 'subtask_event', event: subtaskEvent('running') });
    expect(collected).toEqual(['subtask:running:research:task-1']);
  });

  it('createUiEventSinkFromAgentRuntimeEvents forwards subtask_event losslessly', () => {
    const collected: string[] = [];
    const uiAdapter = createUiEventSinkFromAgentRuntimeEvents(makeRuntimeSink(collected));
    uiAdapter.subtaskEvent!(subtaskEvent('completed'));
    expect(collected).toEqual(['subtask:completed:research:task-1']);
  });

  it('a full lifecycle sequence is preserved in order', () => {
    const collected: string[] = [];
    const sink = makeUiSink(collected);
    const lifecycle: RuntimeSubtaskEvent['state'][] = ['queued', 'running', 'completed'];
    for (const state of lifecycle) {
      emitToUiEventSink(sink, { type: 'subtask_event', event: subtaskEvent(state) });
    }
    expect(collected).toEqual([
      'subtask:queued:research:task-1',
      'subtask:running:research:task-1',
      'subtask:completed:research:task-1',
    ]);
  });

  it('subtask_event does not interfere with other event types', () => {
    const collected: string[] = [];
    const sink: UiEventSink = {
      ...makeUiSink(collected),
      setStatus: m => collected.push(`status:${m}`),
      setProcessing: () => {},
    };
    emitToUiEventSink(sink, { type: 'status_changed', message: 'running' });
    emitToUiEventSink(sink, { type: 'subtask_event', event: subtaskEvent('running') });
    emitToUiEventSink(sink, { type: 'status_changed', message: 'done' });
    expect(collected).toEqual([
      'status:running',
      'subtask:running:research:task-1',
      'status:done',
    ]);
  });

  // ==========================================================================
  // R8: real-sink subtaskEvent consumer parity
  // ==========================================================================
  describe('R8: real sink subtaskEvent consumers', () => {
    it('TerminalEventSink stores typed timeline entries', () => {
      // Dynamic import so the module loads cleanly in a Node test env.
      const { TerminalEventSink } = require('../src/terminal-ui/launch') as typeof import('../src/terminal-ui/launch');
      const runtime = { cwd: '/tmp', version: 'test' } as any;
      const sink = new TerminalEventSink(runtime, { write: () => {} } as any);
      // Full lifecycle: queued -> running -> completed.
      sink.subtaskEvent!(subtaskEvent('queued'));
      sink.subtaskEvent!(subtaskEvent('running'));
      sink.subtaskEvent!(subtaskEvent('completed'));
      const timeline = sink.getSubtaskTimeline();
      expect(timeline).toHaveLength(1);
      expect(timeline[0].state).toBe('completed');
      expect(timeline[0].role).toBe('research');
      expect(timeline[0].terminal).toBe(true);
    });

    it('TUI state reducer consumes subtaskEvent into timeline', () => {
      const { tuiUiReducer } = require('../src/tui-ui/state') as typeof import('../src/tui-ui/state');
      const initial = (require('../src/tui-ui/state') as typeof import('../src/tui-ui/state')).initialTuiUiState;
      let state = tuiUiReducer(initial, { type: 'subtaskEvent', event: subtaskEvent('queued') });
      state = tuiUiReducer(state, { type: 'subtaskEvent', event: subtaskEvent('running') });
      state = tuiUiReducer(state, { type: 'subtaskEvent', event: subtaskEvent('completed') });
      expect(state.subtaskTimeline).toHaveLength(1);
      expect(state.subtaskTimeline[0].state).toBe('completed');
      expect(state.subtaskTimeline[0].terminal).toBe(true);
    });

    it('TUI createTuiUiEventSink wires subtaskEvent dispatch', () => {
      const { createTuiUiEventSink } = require('../src/tui-ui/state') as typeof import('../src/tui-ui/state');
      const actions: any[] = [];
      const dispatch = (a: any) => { actions.push(a); };
      const sink = createTuiUiEventSink(dispatch);
      sink.subtaskEvent!(subtaskEvent('running'));
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('subtaskEvent');
      expect(actions[0].event.state).toBe('running');
    });

    it('subtaskTimelineLabel renders a human-readable label', () => {
      const { subtaskTimelineLabel, subtaskEventToTimelineEntry } = require('../src/runtime/ui-view-model') as typeof import('../src/runtime/ui-view-model');
      const event = subtaskEvent('completed');
      const entry = subtaskEventToTimelineEntry(event);
      const label = subtaskTimelineLabel(entry);
      expect(label).toMatch(/◂/);
      expect(label).toMatch(/research/);
      expect(label).toMatch(/completed/);
      expect(label).toMatch(/Found 2 handlers/);
      expect(label).toMatch(/1500ms/);
    });
  });
});
