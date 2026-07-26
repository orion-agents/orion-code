import {
  createTuiFrame,
  writeFrameText,
  renderFrameRows,
  renderStyledFrameRow,
  diffTuiFrames,
  setFrameCursor,
  type TuiFrame,
} from '../src/tui-core/frame';
import {
  normalizeStyle,
  styleKey,
  stylesEqual,
  encodeStyleToSgr,
  SGR_RESET,
  sanitizeTerminalText,
  DEFAULT_THEME,
  DEFAULT_STYLE,
  type TuiStyle,
} from '../src/tui-core/style';

// ============================================================================
// Style normalization
// ============================================================================

describe('tui style: normalization', () => {
  it('removes falsy fields', () => {
    const result = normalizeStyle({ bold: false, dim: false, italic: undefined });
    expect(result).toEqual({});
  });

  it('clamps indexed color values', () => {
    const result = normalizeStyle({ foreground: { kind: 'indexed', value: 999 } });
    expect(result.foreground).toEqual({ kind: 'indexed', value: 255 });
  });

  it('clamps rgb values', () => {
    const result = normalizeStyle({ foreground: { kind: 'rgb', r: -10, g: 300, b: 128 } });
    expect(result.foreground).toEqual({ kind: 'rgb', r: 0, g: 255, b: 128 });
  });

  it('keeps named colors as-is', () => {
    const result = normalizeStyle({ foreground: { kind: 'named', value: 'red' } });
    expect(result.foreground).toEqual({ kind: 'named', value: 'red' });
  });
});

describe('tui style: equality', () => {
  it('stylesEqual returns true for same styles', () => {
    const a: TuiStyle = { bold: true, foreground: { kind: 'named', value: 'red' } };
    const b: TuiStyle = { foreground: { kind: 'named', value: 'red' }, bold: true };
    expect(stylesEqual(a, b)).toBe(true);
  });

  it('stylesEqual returns false for different styles', () => {
    expect(stylesEqual({ bold: true }, { bold: false })).toBe(false);
    expect(stylesEqual(
      { foreground: { kind: 'named', value: 'red' } },
      { foreground: { kind: 'named', value: 'green' } }
    )).toBe(false);
  });

  it('styleKey is stable for same input', () => {
    expect(styleKey({ bold: true, dim: true })).toBe(styleKey({ dim: true, bold: true }));
  });
});

// ============================================================================
// SGR encoding
// ============================================================================

describe('tui style: SGR encoding', () => {
  it('returns empty string for default style', () => {
    expect(encodeStyleToSgr(DEFAULT_STYLE)).toBe('');
  });

  it('encodes bold', () => {
    expect(encodeStyleToSgr({ bold: true })).toBe('\x1b[1m');
  });

  it('encodes named foreground color', () => {
    expect(encodeStyleToSgr({ foreground: { kind: 'named', value: 'red' } }, false)).toBe('\x1b[31m');
  });

  it('encodes multiple attributes in order', () => {
    const sgr = encodeStyleToSgr(
      { bold: true, foreground: { kind: 'named', value: 'green' } },
      false,
    );
    expect(sgr).toBe('\x1b[1;32m');
  });

  it('encodes indexed color', () => {
    const sgr = encodeStyleToSgr({ foreground: { kind: 'indexed', value: 208 } }, false);
    expect(sgr).toBe('\x1b[38;5;208m');
  });

  it('encodes rgb color', () => {
    const sgr = encodeStyleToSgr(
      { foreground: { kind: 'rgb', r: 10, g: 20, b: 30 } },
      false,
    );
    expect(sgr).toBe('\x1b[38;2;10;20;30m');
  });

  it('encodes background', () => {
    const sgr = encodeStyleToSgr({ background: { kind: 'named', value: 'blue' } }, false);
    expect(sgr).toBe('\x1b[44m');
  });

  it('suppresses color when flag set', () => {
    const sgr = encodeStyleToSgr({ bold: true, foreground: { kind: 'named', value: 'red' } }, true);
    // bold preserved, color suppressed
    expect(sgr).toBe('\x1b[1m');
    expect(sgr).not.toContain('31');
  });

  it('suppresses semantic foreground and background while preserving attributes', () => {
    const sgr = encodeStyleToSgr({
      ...DEFAULT_THEME.userMarker,
      ...DEFAULT_THEME.userBackground,
    }, true);
    expect(sgr).toBe('\x1b[1m');
    expect(sgr).not.toContain('38');
    expect(sgr).not.toContain('48');
  });

  it('SGR_RESET is the reset sequence', () => {
    expect(SGR_RESET).toBe('\x1b[0m');
  });
});

// ============================================================================
// Sanitizer
// ============================================================================

describe('tui style: sanitizer', () => {
  it('strips ESC sequences', () => {
    const result = sanitizeTerminalText('hello\x1b[31mworld\x1b[0m');
    expect(result).toBe('helloworld');
  });

  it('strips DEL and C0 control chars', () => {
    const result = sanitizeTerminalText('a\x7fb\x01c');
    expect(result).toBe('abc');
  });

  it('preserves newlines', () => {
    const result = sanitizeTerminalText('line1\nline2');
    expect(result).toBe('line1\nline2');
  });

  it('expands tabs to spaces', () => {
    const result = sanitizeTerminalText('a\tb', 2);
    expect(result).toBe('a  b');
  });

  it('strips C1 control chars (0x80-0x9f)', () => {
    const result = sanitizeTerminalText('a\x9fb');
    expect(result).toBe('ab');
  });

  it('preserves unicode (CJK, emoji)', () => {
    const result = sanitizeTerminalText('你好👨‍👩‍👧');
    expect(result).toBe('你好👨‍👩‍👧');
  });

  it('prevents ANSI injection from model content', () => {
    const malicious = '\x1b[2J\x1b[Hhello\x1b[?25l';
    const result = sanitizeTerminalText(malicious);
    expect(result).toBe('hello');
    expect(result).not.toContain('\x1b');
  });
});

// ============================================================================
// Styled frame
// ============================================================================

describe('tui styled frame', () => {
  it('createTuiFrame produces cells with default style', () => {
    const frame = createTuiFrame(5, 2);
    expect(frame.rows[0][0].style).toBe(DEFAULT_STYLE);
  });

  it('writeFrameText applies style to written cells', () => {
    const frame = createTuiFrame(10, 1);
    const style: TuiStyle = { bold: true, foreground: { kind: 'named', value: 'red' } };
    writeFrameText(frame, 0, 0, 'hi', style);
    expect(stylesEqual(frame.rows[0][0].style, style)).toBe(true);
  });

  it('writeFrameText defaults to DEFAULT_STYLE when no style given', () => {
    const frame = createTuiFrame(10, 1);
    writeFrameText(frame, 0, 0, 'hi');
    expect(frame.rows[0][0].style).toBe(DEFAULT_STYLE);
  });

  it('CJK continuation cell inherits style', () => {
    const frame = createTuiFrame(10, 1);
    const style: TuiStyle = { foreground: { kind: 'named', value: 'cyan' } };
    writeFrameText(frame, 0, 0, '你', style);
    // First cell has the char, second is continuation with same style.
    expect(frame.rows[0][0].char).toBe('你');
    expect(frame.rows[0][0].width).toBe(2);
    expect(frame.rows[0][1].char).toBe('');
    expect(frame.rows[0][1].width).toBe(0);
    expect(stylesEqual(frame.rows[0][1].style, style)).toBe(true);
  });

  it('renderFrameRows still produces plain text (backward compat)', () => {
    const frame = createTuiFrame(10, 1);
    writeFrameText(frame, 0, 0, 'hello', { bold: true });
    // renderFrameRows pads to width with spaces
    expect(renderFrameRows(frame)[0].startsWith('hello')).toBe(true);
  });

  it('renderStyledFrameRow merges consecutive same-style cells', () => {
    const frame = createTuiFrame(10, 1);
    writeFrameText(frame, 0, 0, 'hello', { bold: true });
    const spans = renderStyledFrameRow(frame.rows[0]);
    // 10 cols: 'hello'(bold) + 5 spaces(default) = 2 spans
    expect(spans.length).toBe(2);
    expect(spans[0].text).toBe('hello');
    expect(spans[0].style.bold).toBe(true);
    expect(spans[1].text).toBe('     ');
  });

  it('renderStyledFrameRow produces separate spans for different styles', () => {
    const frame = createTuiFrame(10, 1);
    writeFrameText(frame, 0, 0, 'ab', { bold: true });
    writeFrameText(frame, 0, 2, 'cd', { foreground: { kind: 'named', value: 'red' } });
    const spans = renderStyledFrameRow(frame.rows[0]);
    // ab(bold) + cd(red) + 6 spaces(default) = 3 spans
    expect(spans.length).toBe(3);
    expect(spans[0].text).toBe('ab');
    expect(spans[1].text).toBe('cd');
  });

  it('diffTuiFrames detects style-only changes', () => {
    const frame1 = createTuiFrame(10, 1);
    writeFrameText(frame1, 0, 0, 'hi');
    const frame2 = createTuiFrame(10, 1);
    writeFrameText(frame2, 0, 0, 'hi', { bold: true });
    const diff = diffTuiFrames(frame1, frame2);
    expect(diff.changedRows).toContain(0);
  });

  it('diffTuiFrames returns no changes for identical frames', () => {
    const frame1 = createTuiFrame(10, 1);
    writeFrameText(frame1, 0, 0, 'hi', { bold: true });
    const frame2 = createTuiFrame(10, 1);
    writeFrameText(frame2, 0, 0, 'hi', { bold: true });
    const diff = diffTuiFrames(frame1, frame2);
    expect(diff.changedRows).toHaveLength(0);
  });
});

// ============================================================================
// Theme
// ============================================================================

describe('tui style: theme', () => {
  it('DEFAULT_THEME has all semantic tokens', () => {
    expect(DEFAULT_THEME.assistantText).toBeDefined();
    expect(DEFAULT_THEME.heading).toBeDefined();
    expect(DEFAULT_THEME.code).toBeDefined();
    expect(DEFAULT_THEME.diffAdded).toBeDefined();
    expect(DEFAULT_THEME.diffRemoved).toBeDefined();
    expect(DEFAULT_THEME.warning).toBeDefined();
    expect(DEFAULT_THEME.error).toBeDefined();
    expect(DEFAULT_THEME.activityRunning).toBeDefined();
    expect(DEFAULT_THEME.activitySuccess).toBeDefined();
    expect(DEFAULT_THEME.activityFailed).toBeDefined();
    expect(DEFAULT_THEME.muted).toBeDefined();
    expect(DEFAULT_THEME.userMarker).toBeDefined();
    expect(DEFAULT_THEME.userText).toBeDefined();
    expect(DEFAULT_THEME.userBackground).toBeDefined();
    expect(DEFAULT_THEME.inlineCode).toBeDefined();
    expect(DEFAULT_THEME.link).toBeDefined();
    expect(DEFAULT_THEME.toolRunning).toBeDefined();
    expect(DEFAULT_THEME.toolSuccess).toBeDefined();
    expect(DEFAULT_THEME.toolError).toBeDefined();
    expect(DEFAULT_THEME.toolSkipped).toBeDefined();
    expect(DEFAULT_THEME.toolName).toBeDefined();
    expect(DEFAULT_THEME.toolMeta).toBeDefined();
    expect(DEFAULT_THEME.systemText).toBeDefined();
    expect(DEFAULT_THEME.commandMarker).toBeDefined();
    expect(DEFAULT_THEME.commandText).toBeDefined();
    expect(DEFAULT_THEME.statusText).toBeDefined();
  });

  it('heading is bold cyan', () => {
    expect(DEFAULT_THEME.heading.bold).toBe(true);
    expect(DEFAULT_THEME.heading.foreground).toEqual({ kind: 'named', value: 'cyan' });
  });

  it('diffAdded is green, diffRemoved is red', () => {
    expect(DEFAULT_THEME.diffAdded.foreground).toEqual({ kind: 'named', value: 'green' });
    expect(DEFAULT_THEME.diffRemoved.foreground).toEqual({ kind: 'named', value: 'red' });
  });

  it('uses restrained backgrounds for user messages and code', () => {
    expect(DEFAULT_THEME.userBackground?.background?.kind).toBe('rgb');
    expect(DEFAULT_THEME.userBackground?.background).toEqual({
      kind: 'rgb',
      r: 218,
      g: 221,
      b: 226,
    });
    expect(DEFAULT_THEME.userText?.foreground).toEqual({
      kind: 'rgb',
      r: 32,
      g: 35,
      b: 40,
    });
    expect(DEFAULT_THEME.code.background?.kind).toBe('rgb');
    expect(DEFAULT_THEME.inlineCode?.background?.kind).toBe('rgb');
  });
});
