import {
  createTuiFrame,
  diffTuiFrames,
  renderFrameRows,
  setFrameCursor,
  writeFrameText,
} from '../src/tui-core/frame';
import { TuiInputParser } from '../src/tui-core/input-parser';
import {
  cursorHide,
  cursorShow,
  disableAutoWrap,
  enableAutoWrap,
  moveTo,
  renderTerminalFrame,
  TuiTerminalWriter,
} from '../src/tui-core/terminal-writer';

describe('tui-core input parser', () => {
  it('keeps split UTF-8 CJK bytes intact before emitting text', () => {
    const parser = new TuiInputParser();
    const bytes = Buffer.from('开源小？事收到', 'utf8');
    const first = bytes.subarray(0, 5);
    const second = bytes.subarray(5);

    expect(parser.feed(first)).toEqual([{ type: 'text', value: '开' }]);
    expect(parser.feed(second)).toEqual([{ type: 'text', value: '源小？事收到' }]);
  });

  it('detects split UTF-8 multiline paste after preserving byte boundaries', () => {
    const parser = new TuiInputParser();
    const bytes = Buffer.from('第一行\n第二行', 'utf8');
    const first = bytes.subarray(0, bytes.length - 1);
    const second = bytes.subarray(bytes.length - 1);

    expect(parser.feed(first, { detectUnbracketedMultilinePaste: true })).toEqual([
      { type: 'paste', value: '第一行\n第二' },
    ]);
    expect(parser.feed(second, { detectUnbracketedMultilinePaste: true })).toEqual([
      { type: 'text', value: '行' },
    ]);
  });

  it('parses deletion and control keys without confusing DEL backspace for forward delete', () => {
    const parser = new TuiInputParser();

    expect(parser.feed(Buffer.from('\x7f'))).toEqual([
      { type: 'key', key: 'backspace', raw: '\x7f' },
    ]);
    expect(parser.feed(Buffer.from('\b'))).toEqual([{ type: 'key', key: 'backspace', raw: '\b' }]);
    expect(parser.feed(Buffer.from('\x1b[3~'))).toEqual([
      { type: 'key', key: 'delete', raw: '\x1b[3~' },
    ]);
    expect(parser.feed(Buffer.from('\x03\x03'))).toEqual([
      { type: 'key', key: 'ctrl+c', raw: '\x03' },
      { type: 'key', key: 'ctrl+c', raw: '\x03' },
    ]);
  });

  it('coalesces text while preserving key order', () => {
    const parser = new TuiInputParser();

    expect(parser.feed(Buffer.from('ab\x1b[D中'))).toEqual([
      { type: 'text', value: 'ab' },
      { type: 'key', key: 'left', raw: '\x1b[D' },
      { type: 'text', value: '中' },
    ]);
  });

  it('emits bracketed paste as one normalized paste event', () => {
    const parser = new TuiInputParser();

    expect(parser.feed(Buffer.from('\x1b[200~one\r\ntwo\x1b[201~'))).toEqual([
      { type: 'paste', value: 'one\ntwo' },
    ]);
  });

  it('keeps split bracketed paste delimiters intact across chunks', () => {
    const parser = new TuiInputParser();

    expect(parser.feed(Buffer.from('\x1b[2'))).toEqual([]);
    expect(parser.feed(Buffer.from('00~one\n'))).toEqual([]);
    expect(parser.feed(Buffer.from('two\x1b[20'))).toEqual([]);
    expect(parser.feed(Buffer.from('1~'))).toEqual([{ type: 'paste', value: 'one\ntwo' }]);
  });

  it('keeps split CSI keys intact across chunks', () => {
    const parser = new TuiInputParser();

    expect(parser.feed(Buffer.from('\x1b['))).toEqual([]);
    expect(parser.feed(Buffer.from('D'))).toEqual([{ type: 'key', key: 'left', raw: '\x1b[D' }]);
  });

  // --- 切片2: emoji / grapheme / long input ---

  it('handles emoji as grapheme clusters without splitting', () => {
    const parser = new TuiInputParser();
    // 👋 = F0 9F 91 8B (4 bytes), 你好 = CJK
    const emoji = '👋你好';
    expect(parser.feed(Buffer.from(emoji, 'utf8'))).toEqual([{ type: 'text', value: emoji }]);
  });

  it('handles grapheme clusters with combining marks', () => {
    const parser = new TuiInputParser();
    // é as e + combining acute accent (U+0065 U+0301)
    const text = 'é';
    expect(parser.feed(Buffer.from(text, 'utf8'))).toEqual([{ type: 'text', value: text }]);
  });

  it('handles very long input without splitting key sequences', () => {
    const parser = new TuiInputParser();
    const long = 'A'.repeat(256) + '\x1b[D' + 'B'.repeat(256);
    const events = parser.feed(Buffer.from(long, 'utf8'));
    expect(events).toEqual([
      { type: 'text', value: 'A'.repeat(256) },
      { type: 'key', key: 'left', raw: '\x1b[D' },
      { type: 'text', value: 'B'.repeat(256) },
    ]);
  });

  it('handles delete (forward delete) for grapheme clusters', () => {
    // This validates the parser distinguishes backspace (\x7f) from forward delete (\x1b[3~)
    const parser = new TuiInputParser();
    const events = parser.feed(Buffer.from('\x1b[3~\x7f'));
    expect(events).toEqual([
      { type: 'key', key: 'delete', raw: '\x1b[3~' },
      { type: 'key', key: 'backspace', raw: '\x7f' },
    ]);
  });
});

describe('tui-core frame model', () => {
  it('renders CJK text using terminal cell width', () => {
    const frame = createTuiFrame(10, 3);

    writeFrameText(frame, 0, 0, 'A你B');

    expect(renderFrameRows(frame)[0]).toBe('A你B      ');
    expect(frame.rows[0][1]).toMatchObject({ char: '你', width: 2 });
    expect(frame.rows[0][2]).toMatchObject({ char: '', width: 0 });
  });

  it('wraps before a full-width grapheme would overrun the row', () => {
    const frame = createTuiFrame(4, 3);

    writeFrameText(frame, 0, 0, 'abc你');

    expect(renderFrameRows(frame)).toEqual(['abc ', '你  ', '    ']);
  });

  it('keeps cursor as frame-owned state separate from row diffs', () => {
    const previous = createTuiFrame(8, 2);
    const next = createTuiFrame(8, 2);

    writeFrameText(previous, 0, 0, 'hello');
    writeFrameText(next, 0, 0, 'hello');
    setFrameCursor(next, 1, 3, true);

    expect(diffTuiFrames(previous, next)).toEqual({
      changedRows: [],
      cursorChanged: true,
    });
  });

  // --- 切片1: frame resize/diff edge cases ---

  it('detects all rows changed when dimensions differ', () => {
    const previous = createTuiFrame(10, 4);
    const next = createTuiFrame(20, 6);
    writeFrameText(previous, 0, 0, 'hello');
    writeFrameText(next, 0, 0, 'hello');

    const diff = diffTuiFrames(previous, next);
    expect(diff.changedRows).toEqual([0, 1, 2, 3, 4, 5]);
    expect(diff.cursorChanged).toBe(true);
  });

  it('detects all rows changed after resize (full redraw)', () => {
    // Simulate rapid resize: previous and next have same content but different sizes
    const prev = createTuiFrame(40, 10);
    const next = createTuiFrame(80, 24);
    writeFrameText(prev, 0, 0, 'same content');
    writeFrameText(next, 0, 0, 'same content');

    const diff = diffTuiFrames(prev, next);
    expect(diff.changedRows).toHaveLength(24);
    expect(diff.cursorChanged).toBe(true);
  });

  it('sets every row to default char after creation (no leftover state)', () => {
    const frame = createTuiFrame(8, 3);
    const rows = renderFrameRows(frame);
    expect(rows[0]).toBe('        ');
    expect(rows[1]).toBe('        ');
    expect(rows[2]).toBe('        ');
  });

  it('clamps cursor to frame bounds', () => {
    const frame = createTuiFrame(10, 4);
    setFrameCursor(frame, 99, 99, true);
    expect(frame.cursor.row).toBe(3); // max height - 1
    expect(frame.cursor.column).toBe(9); // max width - 1
    setFrameCursor(frame, -5, -5, true);
    expect(frame.cursor.row).toBe(0);
    expect(frame.cursor.column).toBe(0);
  });

  it('preserves CJK full-width cells after writeFrameText', () => {
    const frame = createTuiFrame(12, 2);
    writeFrameText(frame, 0, 0, '你好');
    // Cell [0][0] = '你' (width 2), [0][1] = '' (width 0, placeholder)
    expect(frame.rows[0][0]).toMatchObject({ char: '你', width: 2 });
    expect(frame.rows[0][1]).toMatchObject({ char: '', width: 0 });
    // Cell [0][2] = '好' (width 2), [0][3] = '' (width 0)
    expect(frame.rows[0][2]).toMatchObject({ char: '好', width: 2 });
    expect(frame.rows[0][3]).toMatchObject({ char: '', width: 0 });
  });

  it('does not leak frame rows between separate frame instances', () => {
    const a = createTuiFrame(8, 2);
    const b = createTuiFrame(8, 2);
    writeFrameText(a, 0, 0, 'frame-A');
    writeFrameText(b, 0, 0, 'frame-B');
    expect(renderFrameRows(a)[0]).toContain('frame-A');
    expect(renderFrameRows(a)[0]).not.toContain('frame-B');
    expect(renderFrameRows(b)[0]).toContain('frame-B');
    expect(renderFrameRows(b)[0]).not.toContain('frame-A');
  });
});

describe('tui-core terminal writer', () => {
  it('renders the first frame as full changed rows plus frame-owned cursor', () => {
    const frame = createTuiFrame(8, 2);
    writeFrameText(frame, 0, 0, 'hello');
    writeFrameText(frame, 1, 0, '你');
    setFrameCursor(frame, 1, 2, true);

    const result = renderTerminalFrame(null, frame);

    expect(result.diff).toEqual({
      changedRows: [0, 1],
      cursorChanged: true,
    });
    expect(result.output).toBe(
      [
        disableAutoWrap(),
        cursorHide(),
        moveTo(0, 0),
        '\x1b[2K',
        'hello   ',
        moveTo(1, 0),
        '\x1b[2K',
        '你      ',
        moveTo(1, 2),
        cursorShow(),
        enableAutoWrap(),
      ].join('')
    );
  });

  it('updates only changed rows and then parks the cursor at the declared frame position', () => {
    const previous = createTuiFrame(12, 3);
    const next = createTuiFrame(12, 3);
    writeFrameText(previous, 0, 0, 'same');
    writeFrameText(previous, 1, 0, 'old');
    writeFrameText(next, 0, 0, 'same');
    writeFrameText(next, 1, 0, 'new');
    setFrameCursor(previous, 0, 4, true);
    setFrameCursor(next, 1, 3, true);

    const result = renderTerminalFrame(previous, next);

    expect(result.diff.changedRows).toEqual([1]);
    expect(result.output).toBe(
      [
        disableAutoWrap(),
        cursorHide(),
        moveTo(1, 0),
        '\x1b[2K',
        'new         ',
        moveTo(1, 3),
        cursorShow(),
        enableAutoWrap(),
      ].join('')
    );
  });

  it('can move only the cursor without rewriting transcript rows', () => {
    const previous = createTuiFrame(8, 2);
    const next = createTuiFrame(8, 2);
    writeFrameText(previous, 0, 0, 'stable');
    writeFrameText(next, 0, 0, 'stable');
    setFrameCursor(previous, 0, 1, true);
    setFrameCursor(next, 0, 5, true);

    const result = renderTerminalFrame(previous, next);

    expect(result.diff.changedRows).toEqual([]);
    expect(result.output).toBe(
      [disableAutoWrap(), cursorHide(), moveTo(0, 5), cursorShow(), enableAutoWrap()].join('')
    );
  });

  it('stores previous frames inside the writer before writing later diffs', () => {
    const writes: string[] = [];
    const writer = new TuiTerminalWriter({
      write: (chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      },
    } as Pick<NodeJS.WriteStream, 'write'>);

    const first = createTuiFrame(6, 1);
    const second = createTuiFrame(6, 1);
    writeFrameText(first, 0, 0, 'one');
    writeFrameText(second, 0, 0, 'two');

    writer.render(first);
    writer.render(second);

    expect(writes[0]).toContain('one   ');
    expect(writes[1]).toContain('two   ');
    expect(writes[1]).not.toContain(moveTo(1, 0));
  });
});
