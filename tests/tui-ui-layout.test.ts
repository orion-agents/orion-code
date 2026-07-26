import { renderFrameRows } from '../src/tui-core/frame';
import {
  measureTuiLiveFrameHeight,
  renderTuiLiveFrame,
  renderTuiUiFrame,
} from '../src/tui-ui/layout';
import { initialTuiUiState, tuiUiReducer, type TuiUiAction } from '../src/tui-ui/state';
import type { SessionMeta } from '../src/services/session-storage';
import { makeToolFinishedEvent, makeToolStartedEvent, resetToolEventSequence } from './test-helpers';

function reduce(actions: TuiUiAction[]) {
  return actions.reduce(tuiUiReducer, initialTuiUiState);
}

describe('tui-ui layout', () => {
  beforeEach(() => resetToolEventSequence());

  it('renders transcript tail, status, and prompt into one frame with owned cursor', () => {
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: '你好' } },
      { type: 'appendTranscript', entry: { id: 'a1', role: 'assistant', content: '收到' } },
      { type: 'setStatus', message: 'model=glm-5' },
      { type: 'setPrompt', value: '开源小？事收到', cursor: '开源小？'.length },
    ]);

    const frame = renderTuiUiFrame(state, { width: 32, height: 10 });
    const rows = renderFrameRows(frame);

    expect(rows[0]).toContain('› 你好');
    expect(rows[1]).toContain('收到');
    expect(rows[6]).toContain('ready');
    expect(rows[6]).toContain('model=glm-5');
    expect(rows[7]).toBe('┌──────────────────────────────┐');
    expect(rows[8]).toContain('│ › 开源小？事收到');
    expect(rows[9]).toBe('└──────────────────────────────┘');
    expect(frame.cursor).toEqual({
      row: 8,
      column: 4 + 8,
      visible: true,
    });
  });

  it('preserves transcript semantic styles in frame cells', () => {
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'question' } },
      { type: 'appendTranscript', entry: { id: 'a1', role: 'assistant', content: '# Heading' } },
    ]);
    const frame = renderTuiUiFrame(state, { width: 40, height: 10 });
    const rows = renderFrameRows(frame);

    expect(rows[0]).toContain('› question');
    expect(frame.rows[0].slice(0, 40).every(cell => cell.style.background)).toBe(true);
    expect(rows[1]).toContain('Heading');
    expect(rows[1]).not.toContain('# Heading');
    expect(frame.rows[1].some(cell => cell.char === 'H' && cell.style.bold)).toBe(true);
  });

  it('shows session picker overlay in the frame without mutating transcript state', () => {
    const session: SessionMeta = {
      id: '12345678-aaaa-bbbb-cccc-123456789000',
      projectPath: '/tmp/project',
      model: 'glm-5',
      startTime: 1,
      tokenCount: 0,
      cost: 0,
      messageCount: 2,
      historySizeBytes: 2048,
      name: 'demo session',
    };
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'old transcript' } },
      { type: 'showSessionPicker', request: { title: 'Resume', sessions: [session] } },
    ]);

    const frame = renderTuiUiFrame(state, { width: 60, height: 9 });
    const rows = renderFrameRows(frame);

    expect(rows[0]).toContain('Sessions: Resume (1/1)');
    expect(rows[1]).toContain('›  1 12345678  demo session');
    expect(rows[1]).toContain('2.0 KB');
    expect(state.transcript.map(entry => entry.content)).toEqual(['old transcript']);
  });

  it('scrolls the session picker around the selected row and renders size metadata', () => {
    const sessions: SessionMeta[] = Array.from({ length: 12 }, (_, index) => ({
      id: `session-${String(index + 1).padStart(2, '0')}-aaaaaaaa`,
      projectPath: `/tmp/project-${index + 1}`,
      model: 'glm-5',
      startTime: index,
      tokenCount: 0,
      cost: 0,
      messageCount: index + 1,
      historySizeBytes: (index + 1) * 1024,
      name: `session ${index + 1}`,
    }));
    const state = reduce([
      { type: 'showSessionPicker', request: { title: 'Resume', sessions, maxVisibleItems: 4 } },
      { type: 'moveOverlaySelection', delta: 8 },
    ]);

    const frame = renderTuiUiFrame(state, { width: 72, height: 10 });
    const rows = renderFrameRows(frame);

    expect(rows[0]).toContain('Sessions: Resume (9/12)');
    expect(rows.join('\n')).toContain('›  9 session-');
    expect(rows.join('\n')).toContain('9 msgs');
    expect(rows.join('\n')).toContain('9.0 KB');
    expect(rows.join('\n')).not.toContain('  1 session-');
  });

  it('renders tool permission overlay without writing transcript entries', () => {
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'old transcript' } },
      {
        type: 'showPermissionRequest',
        request: {
          id: 'permission-1',
          name: 'exec_command',
          args: { command: 'npm publish --dry-run' },
          reason: 'requires confirmation',
        },
      },
      { type: 'moveOverlaySelection', delta: 1 },
    ]);

    const frame = renderTuiUiFrame(state, { width: 72, height: 10 });
    const rows = renderFrameRows(frame).join('\n');

    expect(rows).toContain('Tool Permission: exec_command');
    expect(rows).toContain('npm publish --dry-run');
    expect(rows).toContain('requires confirmation');
    expect(rows).toContain('› Deny');
    expect(state.transcript.map(entry => entry.content)).toEqual(['old transcript']);
  });

  it('renders command, file, and shortcut overlays without writing transcript entries', () => {
    const commandFrame = renderTuiUiFrame(reduce([
      {
        type: 'showCommandPalette',
        query: 's',
        items: [{ value: 'status', label: '/status', description: 'System  Show system status' }],
      },
    ]), { width: 72, height: 10 });
    const commandRows = renderFrameRows(commandFrame);
    expect(commandRows[0]).toContain('Commands "s"');
    expect(commandRows[1]).toContain('› /status');

    const fileFrame = renderTuiUiFrame(reduce([
      {
        type: 'showFilePicker',
        base: 'open ',
        query: 'src/c',
        items: [{ value: 'src/cli.ts', label: 'file src/cli.ts', description: 'file' }],
      },
    ]), { width: 72, height: 10 });
    expect(renderFrameRows(fileFrame).join('\n')).toContain('Files "src/c"');
    expect(renderFrameRows(fileFrame).join('\n')).toContain('file src/cli.ts');

    const shortcutFrame = renderTuiUiFrame(reduce([
      { type: 'showShortcuts' },
    ]), { width: 72, height: 10 });
    expect(renderFrameRows(shortcutFrame).join('\n')).toContain('/ commands');
    expect(renderFrameRows(shortcutFrame).join('\n')).toContain('Ctrl+C interrupt');
  });

  it('keeps only the visible transcript tail above the prompt', () => {
    const actions: TuiUiAction[] = [];
    for (let index = 0; index < 8; index += 1) {
      actions.push({
        type: 'appendTranscript',
        entry: { id: `m${index}`, role: 'assistant', content: `line-${index}` },
      });
    }

    const frame = renderTuiUiFrame(reduce(actions), { width: 24, height: 8, maxTranscriptRows: 3 });
    const rows = renderFrameRows(frame);

    expect(rows[0]).toContain('line-5');
    expect(rows[1]).toContain('line-6');
    expect(rows[2]).toContain('line-7');
    expect(rows.join('\n')).not.toContain('line-0');
  });

  it('renders tool timeline transcript rows without disturbing status or prompt', () => {
    const state = reduce([
      {
        type: 'appendTranscript',
        entry: {
          id: 'tool-1',
          role: 'tool',
          content: '#1 read_file src/index.ts (12 ms)\n  output 2.0 KB  artifact tool-1',
        },
      },
      { type: 'setStatus', message: 'model=gpt-4o' },
    ]);

    const rows = renderFrameRows(renderTuiUiFrame(state, { width: 72, height: 10 }));

    expect(rows.join('\n')).toContain('• #1 read_file src/index.ts (12 ms)');
    expect(rows.join('\n')).toContain('artifact tool-1');
    expect(rows[6]).toContain('model=gpt-4o');
    expect(rows[8]).toContain('│ ›');
  });

  it('shows only active tools in the live timeline and removes them after finish', () => {
    const started = reduce([
      {
        type: 'toolStarted',
        event: makeToolStartedEvent({
          callId: 'call_00_shared-prefix-a',
          name: 'exec_command',
          sequence: 7,
        }),
      },
    ]);
    const runningRows = renderFrameRows(renderTuiLiveFrame(started, { width: 72, height: 10 }));
    expect(runningRows.join('\n')).toContain('⚙ #7 exec_command running');
    expect(runningRows.join('\n')).not.toContain('call_00_');

    const finished = tuiUiReducer(started, {
      type: 'toolFinished',
      event: makeToolFinishedEvent({
        callId: 'call_00_shared-prefix-a',
        name: 'exec_command',
        sequence: 7,
        success: true,
      }),
    });
    const readyRows = renderFrameRows(renderTuiLiveFrame(finished, { width: 72, height: 10 }));
    expect(readyRows.join('\n')).not.toContain('exec_command running');
    expect(finished.statusState.activeTools).toBe(0);
  });

  // --- 切片1: golden frame tests ---

  it('renders correctly at minimum supported dimensions (24x8)', () => {
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'hello' } },
      { type: 'appendTranscript', entry: { id: 'a1', role: 'assistant', content: 'ok' } },
    ]);
    const frame = renderTuiUiFrame(state, { width: 24, height: 8 });
    const rows = renderFrameRows(frame);
    expect(rows).toHaveLength(8);
    // Prompt box must occupy the bottom 3 rows
    expect(rows[5]).toBe('┌──────────────────────┐');
    expect(rows[6]).toContain('│ ›');
    expect(rows[7]).toBe('└──────────────────────┘');
    // Status row is above prompt (height=8 → status row = 4)
    expect(rows[4]).toContain('ready');
  });

  it('keeps a long multi-line prompt inside a bounded, closed viewport', () => {
    const value = Array.from({ length: 20 }, (_, index) => `line-${index}`).join('\n');
    const state = reduce([
      { type: 'setPrompt', value, cursor: value.length },
    ]);
    const frame = renderTuiUiFrame(state, { width: 30, height: 8 });
    const rows = renderFrameRows(frame);

    expect(rows[0]).toContain('ready');
    expect(rows.filter(row => row.startsWith('┌'))).toHaveLength(1);
    expect(rows.filter(row => row.startsWith('└'))).toHaveLength(1);
    expect(rows[1]).toBe('┌────────────────────────────┐');
    expect(rows[7]).toBe('└────────────────────────────┘');
    for (const row of rows.slice(2, 7)) {
      expect(row.startsWith('│')).toBe(true);
      expect(row.endsWith('│')).toBe(true);
    }
    expect(rows.join('\n')).toContain('line-19');
    expect(frame.cursor.row).toBeGreaterThanOrEqual(2);
    expect(frame.cursor.row).toBeLessThan(7);
    expect(frame.cursor.column).toBeLessThan(29);
  });

  it('renders correctly at narrow width 30', () => {
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'hello' } },
      { type: 'setStatus', message: 'model=gpt-4o  ctx=50%' },
    ]);
    const frame = renderTuiUiFrame(state, { width: 30, height: 10 });
    const rows = renderFrameRows(frame);
    // Prompt box must be at fixed offset from bottom
    expect(rows[7]).toBe('┌────────────────────────────┐');
    expect(rows[8]).toContain('│ ›');
    expect(rows[9]).toBe('└────────────────────────────┘');
    // Status row must be above prompt
    expect(rows[6]).toContain('ready');
    expect(rows[6]).toContain('model=gpt-4o');
  });

  it('does not overlap status, prompt, and overlay regions', () => {
    // If an overlay is active, it must be rendered in the transcript area,
    // not overwriting the prompt or status rows.
    const session: SessionMeta = {
      id: '12345678-aaaa-bbbb-cccc-123456789000',
      projectPath: '/tmp/project',
      model: 'glm-5',
      startTime: 1,
      tokenCount: 0,
      cost: 0,
      messageCount: 2,
      historySizeBytes: 2048,
      name: 'demo session',
    };
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'resume' } },
      { type: 'showSessionPicker', request: { title: 'Resume', sessions: [session] } },
    ]);
    const frame = renderTuiUiFrame(state, { width: 72, height: 10 });
    const rows = renderFrameRows(frame);
    // Overlay occupies transcript rows, not status/prompt rows
    expect(rows[6]).toContain('ready'); // status
    expect(rows[7]).toContain('┌');     // prompt top border
    expect(rows[8]).toContain('│ ›');   // prompt input
    expect(rows[9]).toContain('└');     // prompt bottom border
    // Overlay is in the transcript area
    expect(rows[0]).toContain('Sessions');
  });

  it('clamps dimensions below minimum gracefully', () => {
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'hello' } },
    ]);
    const frame = renderTuiUiFrame(state, { width: 5, height: 3 });
    // Must not crash; frame has at least MIN_WIDTH x MIN_HEIGHT
    expect(frame.width).toBeGreaterThanOrEqual(24);
    expect(frame.height).toBeGreaterThanOrEqual(8);
  });

  it('handles wrap for entries containing CJK characters', () => {
    // CJK characters are width 2 each; ensure wrapping does not split a character
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'a1', role: 'assistant', content: '你好世界' } },
    ]);
    const frame = renderTuiUiFrame(state, { width: 24, height: 8 });
    const rows = renderFrameRows(frame);
    // Each CJK char = 2 cells wide, 10 cells = "你好世界" → 20 cells
    // With width 24 and no prefix, it should fit on one line
    const visible = rows.filter(row => row.includes('你好世界'));
    expect(visible.length).toBeGreaterThanOrEqual(1);
  });

  it('preserves prompt cursor position after resize', () => {
    const state = reduce([
      { type: 'setPrompt', value: 'hello world', cursor: 5 },
    ]);
    // Simulate two consecutive renders at different sizes
    const frame1 = renderTuiUiFrame(state, { width: 40, height: 12 });
    const frame2 = renderTuiUiFrame(state, { width: 80, height: 24 });
    // Cursor should be visible and on the prompt row in both frames
    expect(frame1.cursor.visible).toBe(true);
    expect(frame2.cursor.visible).toBe(true);
    // Prompt row is at height - 2 in both layouts
    expect(frame1.cursor.row).toBe(10); // 12 - 2
    expect(frame2.cursor.row).toBe(22); // 24 - 2
  });

  // --- v0.2.19 completion: long status truncation ---

  it('truncates super-long status text to fit the frame width', () => {
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'hello' } },
      { type: 'setStatus', message: 'model=gpt-4o-very-long-model-name  ctx=85%  tokens=123456/200000  session=abc-def-ghi-jkl-mno-pqr' },
    ]);
    const frame = renderTuiUiFrame(state, { width: 30, height: 10 });
    const rows = renderFrameRows(frame);
    // Status row must not exceed frame width
    const statusRow = rows[6];
    expect(statusRow.length).toBeLessThanOrEqual(30);
    // Status row must still contain the key prefix
    expect(statusRow).toContain('model=');
    // Prompt box must be intact
    expect(rows[7]).toBe('┌────────────────────────────┐');
    expect(rows[9]).toBe('└────────────────────────────┘');
  });

  // --- v0.2.19 completion: rapid consecutive resize ---

  // --- v0.2.22: renderTuiLiveFrame bandRows-aware tests ---

  it('measures an idle shell-like live block without reserving 75% of the viewport', () => {
    expect(measureTuiLiveFrameHeight(initialTuiUiState, 120, 23)).toBe(8);

    const streaming = reduce([
      {
        type: 'appendTranscript',
        entry: { id: 'live', role: 'tool', content: Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n') },
      },
    ]);
    expect(measureTuiLiveFrameHeight(streaming, 120, 23)).toBe(23);
  });

  it('renders live frame with prompt at bandRows-relative positions', () => {
    const state = reduce([
      // Tool entries are LIVE (not auto-finalized) — they appear in the live region.
      { type: 'appendTranscript', entry: { id: 't1', role: 'tool', content: '#1 grep pattern' } },
      { type: 'setStatus', message: 'model=glm-5' },
      { type: 'setPrompt', value: 'test', cursor: 4 },
    ]);

    // 24-row terminal → bandRows = round(24*0.75) = 18
    const bandRows = 18;
    const frame = renderTuiLiveFrame(state, { width: 40, height: bandRows });
    const rows = renderFrameRows(frame);

    expect(frame.height).toBe(bandRows);
    // prompt at bandRows-3 = 15
    expect(rows[15]).toBe('┌──────────────────────────────────────┐');
    expect(rows[16]).toContain('│ › test');
    expect(rows[17]).toBe('└──────────────────────────────────────┘');
    // status at bandRows-4 = 14
    expect(rows[14]).toContain('ready');
    expect(rows[14]).toContain('model=glm-5');
    // live transcript visible in rows above status
    expect(rows[0]).toContain('• #1 grep pattern');
    expect(frame.cursor.visible).toBe(true);
    expect(frame.cursor.row).toBe(16);
  });

  it('renderTuiLiveFrame handles minimum band size (8 rows)', () => {
    const state = reduce([
      { type: 'setPrompt', value: 'min', cursor: 3 },
    ]);

    // Very small terminal → band = max(8, round(8*0.75)) = 8
    const bandRows = 8;
    const frame = renderTuiLiveFrame(state, { width: 24, height: bandRows });

    expect(frame.height).toBe(8);
    const rows = renderFrameRows(frame);
    // prompt at bandRows-3 = 5
    expect(rows[5]).toContain('┌');
    expect(rows[6]).toContain('│ › min');
    expect(rows[7]).toContain('└');
    // status at bandRows-4 = 4
    expect(rows[4]).toContain('ready');
  });

  it('renderTuiLiveFrame excludes committed transcript entries', () => {
    // User entries are auto-finalized; assistant entries need explicit finalization.
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'old committed' } },
    ]);

    // Append a second finalized entry and manually advance committableTranscriptCount
    // to simulate what runner.tryCommit does after dispatch.
    const state2 = {
      ...tuiUiReducer(state, {
        type: 'appendTranscript',
        entry: { id: 'u2', role: 'user', content: 'more committed' },
      }),
      // Both user entries are auto-finalized. Make them committable.
      committableTranscriptCount: 2,
    };

    const frame = renderTuiLiveFrame(state2, { width: 40, height: 18 });
    const rows = renderFrameRows(frame).join('\n');

    // With committableTranscriptCount=2, no entries are in the live region.
    // Only status + prompt should be visible.
    expect(rows).not.toContain('old committed');
    expect(rows).not.toContain('more committed');
    // Status row still present
    expect(rows).toContain('ready');
  });
});
