import {
  InlineTerminalSurface,
  MemoryOutput,
  type CommittedEntry,
  type TranscriptCommitBatch,
} from '../src/tui-ui/inline-surface';
import { createTuiFrame, writeFrameText, setFrameCursor, type TuiFrame } from '../src/tui-core/frame';
import {
  BackpressureOutput,
  TerminalModelOutput,
  TerminalStateModel,
} from './terminal-state-model';

function makeFrame(width: number, height: number, text: string, cursorRow = 0): TuiFrame {
  const frame = createTuiFrame(width, height);
  writeFrameText(frame, 0, 0, text);
  setFrameCursor(frame, cursorRow, text.length);
  return frame;
}

function makeRowsFrame(width: number, rows: string[], cursorRow = 0): TuiFrame {
  const frame = createTuiFrame(width, rows.length);
  rows.forEach((row, index) => writeFrameText(frame, index, 0, row));
  setFrameCursor(frame, cursorRow, 0);
  return frame;
}

function makeCommittedEntry(key: string, rows: string[][]): CommittedEntry {
  return {
    displayKey: key,
    rows: rows.map(r => r.map(text => ({ text }))),
  };
}

function makeBatch(entries: CommittedEntry[], generation = 1, reason: 'append' | 'finalize' | 'restore' | 'replace' | 'clear-divider' = 'append'): TranscriptCommitBatch {
  return { generation, reason, entries };
}

const noLiveFrame = () => null;

// ============================================================================
// Surface lifecycle
// ============================================================================

describe('inline surface: lifecycle', () => {
  it('mounts without entering alternate screen', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    expect(output.text()).not.toContain('\x1b[?1049h');
    output.assertNoForbidden();
  });

  it('unmounts without erasing scrollback', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    output.chunks.length = 0;
    await surface.unmount();
    const text = output.text();
    expect(text).not.toContain('\x1b[?1049l');
    expect(text).not.toContain('\x1b[2J');
    output.assertNoForbidden();
  });

  it('suspend disables bracketed paste and shows cursor', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    output.chunks = [];
    await surface.suspend();
    const text = output.text();
    expect(text).toContain('\x1b[?2004l'); // disable bracketed paste
    expect(text).toContain('\x1b[?25h'); // show cursor
  });

  it('restore re-enables bracketed paste', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    await surface.suspend();
    output.chunks = [];
    await surface.restore(noLiveFrame);
    expect(output.text()).toContain('\x1b[?2004h'); // enable bracketed paste
  });

  it('never emits forbidden sequences', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    const frame = makeFrame(40, 3, 'hello');
    await surface.renderLive(frame);
    const batch = makeBatch([makeCommittedEntry('e1', [['committed line']])]);
    await surface.commit(batch, () => frame);
    await surface.resize(60, 20, () => frame);
    await surface.suspend();
    await surface.restore(() => frame);
    await surface.unmount();
    output.assertNoForbidden();
  });
});

// ============================================================================
// Commit protocol
// ============================================================================

describe('inline surface: commit', () => {
  it('keeps committed rows in the visible screen or native scrollback', async () => {
    const terminal = new TerminalStateModel(40, 10);
    terminal.write('shell-before\r\n');
    const output = new TerminalModelOutput(terminal);
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(40, 10);
    await surface.renderLive(makeFrame(40, 8, 'live-before'));

    const batch = makeBatch([makeCommittedEntry('e1', [['hello'], ['world']])]);
    const result = await surface.commit(batch, () => makeFrame(40, 8, 'live-after'));

    expect(terminal.text()).toContain('shell-before');
    expect(terminal.text()).toContain('hello');
    expect(terminal.text()).toContain('world');
    expect(terminal.visibleRows().join('\n')).toContain('live-after');
    expect(result.committedEntries).toBe(1);
  });

  it('does not leak the previous prompt border into history when committing', async () => {
    const terminal = new TerminalStateModel(40, 10);
    const output = new TerminalModelOutput(terminal);
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(40, 10);
    await surface.renderLive(makeRowsFrame(40, [
      'OLD-LIVE',
      '',
      '',
      '',
      'ready',
      '┌OLD-PROMPT──────────────────────────┐',
      '│ › old input',
      '└OLD-PROMPT──────────────────────────┘',
    ], 6));

    const batch = makeBatch([makeCommittedEntry('e1', [['committed']])]);
    await surface.commit(batch, () => makeFrame(40, 8, 'NEW-LIVE'));

    expect(terminal.text()).toContain('committed');
    expect(terminal.visibleRows().join('\n')).toContain('NEW-LIVE');
    expect(terminal.text()).not.toContain('OLD-PROMPT');
    expect(terminal.text()).not.toContain('OLD-LIVE');
  });

  it('rebuilds live frame after commit using latest state', async () => {
    const terminal = new TerminalStateModel(40, 10);
    const output = new TerminalModelOutput(terminal);
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(40, 10);
    const latestFrame = makeFrame(40, 8, 'post-commit live');
    const batch = makeBatch([makeCommittedEntry('e1', [['committed']])]);
    await surface.commit(batch, () => latestFrame);
    expect(terminal.visibleRows().join('\n')).toContain('post-commit live');
  });

  it('retains incremental commits while keeping the latest live frame visible', async () => {
    const terminal = new TerminalStateModel(40, 10);
    const output = new TerminalModelOutput(terminal);
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(40, 10);
    await surface.renderLive(makeFrame(40, 8, 'anchor'));

    await surface.commit(
      makeBatch([makeCommittedEntry('e1', [['turn-1-line-a'], ['turn-1-line-b']])]),
      () => makeFrame(40, 8, 'live-1'),
    );
    await surface.commit(
      makeBatch([makeCommittedEntry('e2', [['turn-2']])]),
      () => makeFrame(40, 8, 'live-2'),
    );
    await surface.commit(
      makeBatch([makeCommittedEntry('e3', [['turn-3']])]),
      () => makeFrame(40, 8, 'live-3'),
    );

    expect(terminal.text()).toContain('turn-1-line-a');
    expect(terminal.text()).toContain('turn-1-line-b');
    expect(terminal.text()).toContain('turn-2');
    expect(terminal.text()).toContain('turn-3');
    expect(terminal.visibleRows().join('\n')).toContain('live-3');
  });

  it('resets styled committed rows before the newline', async () => {
    const previousNoColor = process.env.NO_COLOR;
    const previousForceColor = process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    try {
      const output = new MemoryOutput();
      const surface = new InlineTerminalSurface({ output });
      await surface.mount(40, 10);
      output.chunks = [];

      await surface.commit(makeBatch([{
        displayKey: 'user-1',
        rows: [[{
          text: '› question',
          style: {
            bold: true,
            foreground: { kind: 'named', value: 'white' },
            background: { kind: 'indexed', value: 236 },
          },
        }]],
      }]), noLiveFrame);

      expect(output.text()).toMatch(/\x1b\[[0-9;]*48;5;236m› question\x1b\[0m\n/);
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
      if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = previousForceColor;
    }
  });

  it('resets between adjacent committed spans so styles do not leak', async () => {
    const previousNoColor = process.env.NO_COLOR;
    const previousForceColor = process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    try {
      const output = new MemoryOutput();
      const surface = new InlineTerminalSurface({ output });
      await surface.mount(40, 10);
      output.chunks = [];

      await surface.commit(makeBatch([{
        displayKey: 'mixed',
        rows: [[
          { text: 'code', style: { background: { kind: 'named', value: 'blue' } } },
          { text: ' plain', style: {} },
        ]],
      }]), noLiveFrame);

      expect(output.text()).toContain('\x1b[44mcode\x1b[0m plain\x1b[0m\n');
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
      if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = previousForceColor;
    }
  });

  it('resets between adjacent live frame spans', async () => {
    const previousNoColor = process.env.NO_COLOR;
    const previousForceColor = process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    try {
      const output = new MemoryOutput();
      const surface = new InlineTerminalSurface({ output });
      await surface.mount(40, 10);
      output.chunks = [];
      const frame = createTuiFrame(40, 2);
      writeFrameText(frame, 0, 0, 'code', { background: { kind: 'named', value: 'blue' } });
      writeFrameText(frame, 0, 4, ' plain');

      await surface.renderLive(frame);

      expect(output.text()).toContain('\x1b[44mcode\x1b[0m plain');
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
      if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = previousForceColor;
    }
  });

  it('suppresses foreground and background SGR when NO_COLOR is set', async () => {
    const previousNoColor = process.env.NO_COLOR;
    const previousForceColor = process.env.FORCE_COLOR;
    process.env.NO_COLOR = '1';
    delete process.env.FORCE_COLOR;
    try {
      const output = new MemoryOutput();
      const surface = new InlineTerminalSurface({ output });
      await surface.mount(40, 10);
      output.chunks = [];

      await surface.commit(makeBatch([{
        displayKey: 'user-1',
        rows: [[{
          text: '› question',
          style: {
            bold: true,
            foreground: { kind: 'named', value: 'white' },
            background: { kind: 'indexed', value: 236 },
          },
        }]],
      }]), noLiveFrame);

      const committed = output.text();
      expect(committed).toContain('\x1b[1m› question\x1b[0m\n');
      expect(committed).not.toMatch(/\x1b\[[0-9;]*(?:3[0-9]|4[0-9]|38|48)(?:;|m)/);
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
      if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = previousForceColor;
    }
  });
});

// ============================================================================
// Live rendering
// ============================================================================

describe('inline surface: live render', () => {
  it('renders live frame content', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    output.chunks = [];
    await surface.renderLive(makeFrame(40, 2, 'streaming'));
    expect(output.text()).toContain('streaming');
  });

  it('uses relative cursor movement only', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    output.chunks = [];
    await surface.renderLive(makeFrame(40, 3, 'test'));
    output.assertNoForbidden();
  });

  it('restores cursor visibility at end of paint batch', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    output.chunks = [];
    await surface.renderLive(makeFrame(40, 2, 'test'));
    // Render restores cursor visibility (SHOW_CURSOR) based on frame.cursor.visible.
    expect(output.text()).toContain('\x1b[?25h');
  });
});

// ============================================================================
// Resize
// ============================================================================

describe('inline surface: resize', () => {
  it('resizes without rewriting committed history', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    const batch = makeBatch([makeCommittedEntry('e1', [['committed line 1']])]);
    await surface.commit(batch, noLiveFrame);
    output.chunks = [];
    await surface.resize(60, 20, () => makeFrame(40, 2, 'live after resize'));
    const text = output.text();
    expect(text).not.toContain('committed line 1');
    output.assertNoForbidden();
  });

  it('clears every physical live row after terminal resize reflow', async () => {
    const terminal = new TerminalStateModel(40, 14);
    terminal.write([
      'history-1',
      'history-2',
      'history-3',
      'history-4',
      'history-5',
      '',
    ].join('\r\n'));
    const output = new TerminalModelOutput(terminal);
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(40, 14);
    const oldRows = ['old-status', 'OLD-TOP', 'OLD-INPUT', 'OLD-BOTTOM']
      .map(row => row.padEnd(40, '-'));
    await surface.renderLive(makeRowsFrame(40, oldRows, 2));
    expect(terminal.visibleRows().join('\n')).toContain('OLD-BOTTOM');

    // macOS Terminal can turn each old full-width live row into multiple
    // physical rows before the debounced SIGWINCH repaint runs.
    terminal.reflowRegion(5, 4, 20);

    await surface.resize(20, 14, () => makeRowsFrame(20, [
      'new-status',
      'NEW-TOP',
      'NEW-INPUT',
      'NEW-BOTTOM',
    ], 2));

    expect(terminal.visibleRows().join('\n')).not.toContain('OLD-BOTTOM');
    expect(terminal.visibleRows()).toContain('NEW-BOTTOM');
    expect(terminal.allRows()).toEqual(expect.arrayContaining([
      'history-1',
      'history-2',
      'history-3',
      'history-4',
      'history-5',
    ]));
  });

  it('uses blank viewport rows before moving reflowed live content into scrollback', async () => {
    const terminal = new TerminalStateModel(40, 14);
    terminal.write('history-only\r\n');
    const output = new TerminalModelOutput(terminal);
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(40, 14);
    const oldRows = ['OLD-STATUS', 'OLD-TOP', 'OLD-INPUT', 'OLD-BOTTOM']
      .map(row => row.padEnd(40, '-'));
    await surface.renderLive(makeRowsFrame(40, oldRows, 2));

    terminal.reflowRegion(1, 4, 20);
    await surface.resize(20, 14, () => makeRowsFrame(20, [
      'new-status',
      'NEW-TOP',
      'NEW-INPUT',
      'NEW-BOTTOM',
    ], 2));

    expect(terminal.scrollback.join('\n')).not.toMatch(/OLD-(?:STATUS|TOP|INPUT|BOTTOM)/u);
    expect(terminal.visibleRows().join('\n')).not.toMatch(/OLD-(?:STATUS|TOP|INPUT|BOTTOM)/u);
    expect(terminal.visibleRows()).toContain('NEW-BOTTOM');
  });

  it('suppresses stale-width live paints until resize rebuilds the surface', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(40, 14);
    await surface.renderLive(makeFrame(39, 4, 'before'));
    surface.beginResize();
    output.chunks = [];

    await surface.renderLive(makeFrame(39, 4, 'stale-width'));
    expect(output.text()).toBe('');

    await surface.resize(20, 14, () => makeFrame(19, 4, 'after'));
    expect(output.text()).toContain('after');
    expect(output.text()).not.toContain('stale-width');
  });

  it('keeps a newer resize pending while an older resize is blocked', async () => {
    const output = new BackpressureOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(40, 14);
    await surface.renderLive(makeFrame(39, 4, 'before'));
    output.chunks.length = 0;
    output.blocked = true;

    const firstGeneration = surface.beginResize(30);
    const firstResize = surface.resize(
      30,
      14,
      () => makeFrame(29, 4, 'intermediate'),
      firstGeneration,
    );
    await new Promise<void>(resolve => setImmediate(resolve));

    const finalGeneration = surface.beginResize(20);
    const finalResize = surface.resize(
      20,
      14,
      () => makeFrame(19, 4, 'final-frame'),
      finalGeneration,
    );
    const stalePaint = surface.renderLive(makeFrame(29, 4, 'STALE-LIVE'));

    output.drain();
    await Promise.all([firstResize, finalResize, stalePaint]);

    expect(surface.getState().width).toBe(20);
    expect(output.chunks.join('')).toContain('final-frame');
    expect(output.chunks.join('')).not.toContain('STALE-LIVE');
  });

  it('preserves an already-queued old-width commit across resize', async () => {
    const terminal = new TerminalStateModel(40, 14);
    terminal.write(['history-1', 'history-2', 'history-3', 'history-4', 'history-5', ''].join('\r\n'));
    const output = new TerminalModelOutput(terminal);
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(40, 14);
    await surface.renderLive(makeRowsFrame(39, ['status', 'top', 'input', 'bottom'], 2));

    const generation = surface.beginResize(20);
    terminal.reflowRegion(5, 4, 20);
    const content = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const commit = surface.commit(
      makeBatch([makeCommittedEntry('queued-before-resize', [[content]])]),
      () => makeFrame(19, 4, 'after-commit'),
    );
    const resize = surface.resize(
      20,
      14,
      () => makeFrame(19, 4, 'after-resize'),
      generation,
    );

    await Promise.all([commit, resize]);

    expect(terminal.text().replace(/\n/gu, '')).toContain(content);
  });
});

// ============================================================================
// Serialized queue
// ============================================================================

describe('inline surface: serialized queue', () => {
  it('operations execute in FIFO order', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    const order: string[] = [];
    // Enqueue commits and renders - they should not interleave.
    const p1 = surface.commit(makeBatch([makeCommittedEntry('e1', [['first']])]), noLiveFrame)
      .then(() => order.push('commit1'));
    const p2 = surface.renderLive(makeFrame(40, 2, 'render1'))
      .then(() => order.push('render1'));
    await Promise.all([p1, p2]);
    expect(order).toEqual(['commit1', 'render1']);
  });

  it('waits for drain before resolving a blocked terminal write', async () => {
    const output = new BackpressureOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    output.blocked = true;

    let resolved = false;
    const render = surface.renderLive(makeFrame(40, 4, 'blocked'))
      .then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    output.drain();
    await render;
    expect(resolved).toBe(true);
  });

  it('rejects a blocked write when the terminal closes before drain', async () => {
    const output = new BackpressureOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    output.blocked = true;

    const render = surface.renderLive(makeFrame(40, 4, 'blocked'));
    await Promise.resolve();
    output.close();

    await expect(render).rejects.toThrow('terminal output closed before drain');
    expect(surface.getState().phase).toBe('failed');
  });
});

// ============================================================================
// State
// ============================================================================

describe('inline surface: state', () => {
  it('reports phase transitions', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    expect(surface.getState().phase).toBe('idle');
    await surface.mount(80, 24);
    expect(surface.getState().phase).toBe('mounted');
    await surface.suspend();
    expect(surface.getState().phase).toBe('suspended');
    await surface.restore(noLiveFrame);
    expect(surface.getState().phase).toBe('mounted');
    await surface.unmount();
    expect(surface.getState().phase).toBe('unmounted');
  });

  it('safeContentWidth avoids last column', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    expect(surface.safeContentWidth).toBe(79);
  });

  it('owns only the rows requested by the current live frame', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    // 24-row terminal -> band = round(24*0.75) = 18 rows.
    expect(surface.getLiveBandRows()).toBe(18);
    expect(surface.getState().liveBandRows).toBe(18);
    await surface.renderLive(makeFrame(40, 4, 'test'));
    expect(surface.getState().liveRegionCapacity).toBe(4);
    expect(surface.getState().liveRegionCapacity).toBeLessThanOrEqual(23);
  });
});

// ============================================================================
// MemoryOutput test double
// ============================================================================

describe('MemoryOutput test double', () => {
  it('collects chunks', () => {
    const out = new MemoryOutput();
    out.write('hello ');
    out.write('world');
    expect(out.text()).toBe('hello world');
  });

  it('assertNoForbidden throws on alternate screen', () => {
    const out = new MemoryOutput();
    out.write('\x1b[?1049h');
    expect(() => out.assertNoForbidden()).toThrow('alternate-screen');
  });

  it('assertNoForbidden throws on absolute positioning', () => {
    const out = new MemoryOutput();
    out.write('\x1b[10;20H');
    expect(() => out.assertNoForbidden()).toThrow('absolute cursor');
  });

  it('assertNoForbidden throws on full clear', () => {
    const out = new MemoryOutput();
    out.write('\x1b[2J');
    expect(() => out.assertNoForbidden()).toThrow('full-screen clear');
  });
});
