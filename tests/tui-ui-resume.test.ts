/** Regression tests for shell-native `/resume` history ownership. */

import { InlineTerminalSurface } from '../src/tui-ui/inline-surface';
import { initialTuiUiState, tuiUiReducer, type TuiUiState } from '../src/tui-ui/state';
import { renderTuiLiveFrame } from '../src/tui-ui/layout';
import { renderFrameRows } from '../src/tui-core/frame';
import { TuiRunner } from '../src/tui-ui/runner';
import type { TranscriptEntry } from '../src/runtime/ui-events';
import { TerminalModelOutput, TerminalStateModel } from './terminal-state-model';

function makeEntries(count: number): TranscriptEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `e${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    // Zero-padded so substrings are unambiguous (e.g. "restored-005" vs "restored-05").
    content: `restored-${String(i).padStart(3, '0')}`,
  }));
}

/** Walk the reducer state to a post-resume shape, exactly as the runtime does. */
function resumeState(count: number): TuiUiState {
  return tuiUiReducer(initialTuiUiState, { type: 'replaceTranscript', entries: makeEntries(count) });
}

describe('resume: replaceTranscript creates an append-only committed prefix', () => {
  it.each([30, 60, 500])('marks all %i restored entries finalized and committable', count => {
    const state = resumeState(count);
    expect(state.transcript).toHaveLength(count);
    expect(state.transcript.every(entry => entry.finalized)).toBe(true);
    expect(state.committableTranscriptCount).toBe(count);
    expect(state.committedTranscriptCount).toBe(0);
    expect(state.queuedTranscriptCount).toBe(0);
  });

  it('does not let restored entries block a subsequent finalized turn', () => {
    const restored = resumeState(60);
    const next = tuiUiReducer(restored, {
      type: 'appendTranscript',
      entry: { id: 'new-user', role: 'user', content: 'new turn' },
    });
    expect(next.committableTranscriptCount).toBe(61);
  });
});

describe('resume: live frame geometry after restore', () => {
  it('keeps restored history out of the ephemeral frame while preserving prompt and status', () => {
    const state = resumeState(60);
    const frame = renderTuiLiveFrame(state, { width: 100, height: 8 });
    const rows = renderFrameRows(frame);
    const joined = rows.join('\n');
    expect(joined).not.toContain('restored-000');
    expect(joined).not.toContain('restored-059');
    expect(joined).toContain('ready');
    expect(joined).toContain('┌');
    expect(joined).toContain('└');
  });
});

describe('resume: end-to-end through TuiRunner + InlineTerminalSurface', () => {
  it('retains all restored history without leaking the prompt frame into scrollback', async () => {
    const terminal = new TerminalStateModel(100, 24);
    const output = new TerminalModelOutput(terminal);
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(100, 24);
    const runner = new TuiRunner({ output, width: 100, height: 24, surface });

    runner.dispatch({ type: 'replaceTranscript', entries: makeEntries(60) });
    runner.getScheduler().flush();
    await surface.whenIdle();

    expect(terminal.text()).toContain('restored-000');
    expect(terminal.text()).toContain('restored-059');
    expect(terminal.visibleRows().join('\n')).toContain('┌');
    expect(terminal.visibleRows().join('\n')).toContain('└');
    expect(terminal.scrollback.join('\n')).not.toContain('┌');
    expect(terminal.scrollback.join('\n')).not.toContain('└');

    runner.events.append({ role: 'user', content: 'new-after-resume' });
    await surface.whenIdle();
    expect(terminal.text()).toContain('new-after-resume');
  });
});
