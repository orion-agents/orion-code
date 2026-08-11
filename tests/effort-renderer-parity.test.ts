import {
  createUiEventSinkFromAgentRuntimeEvents,
  type AgentRuntimeEvent,
} from '../src/runtime/agent-runtime-protocol';
import type { RuntimeEffortEvent } from '../src/runtime/ui-events';
import { PrintEventSink } from '../src/print-ui/launch';
import { TerminalEventSink } from '../src/terminal-ui/launch';
import { initialTuiUiState, tuiUiReducer } from '../src/tui-ui/state';

const event: RuntimeEffortEvent = {
  type: 'effort_changed',
  requested: 'high',
  scope: 'session',
  previous: 'auto',
  effective: 'high',
  appliesFrom: 'next-logical-request',
};

const runtime = {
  getSession: () => null,
  store: { getSnapshot: () => ({ currentModel: 'test-model' }) },
  config: { model: 'test-model' },
} as never;

describe('effort renderer parity', () => {
  it('preserves the same typed event across protocol, Print, terminal, and TUI', () => {
    const protocolEvents: AgentRuntimeEvent[] = [];
    const bridge = createUiEventSinkFromAgentRuntimeEvents({
      emit: emitted => {
        protocolEvents.push(emitted);
      },
    });
    bridge.effortEvent?.(event);
    expect(protocolEvents).toEqual([{ type: 'effort_event', event }]);

    const print = new PrintEventSink(runtime, 'json');
    print.effortEvent(event);
    expect(print.result().effortEvents).toEqual([event]);

    const writes: string[] = [];
    const terminal = new TerminalEventSink(runtime, {
      write: (text: string) => writes.push(text),
    } as never);
    terminal.effortEvent(event);
    expect(terminal.getEffortEvents()).toEqual([event]);
    expect(writes.join('')).toContain('effort:high/high');

    const tui = tuiUiReducer(initialTuiUiState, { type: 'effortEvent', event });
    expect(tui.effort).toEqual(event);
    expect(tui.statusMessage).toContain('high');
  });
});
