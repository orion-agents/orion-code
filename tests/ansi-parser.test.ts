import { parseAnsiToStyledSpans } from '../src/runtime/rich-text/ansi-parser';

describe('ansi-to-style parser', () => {
  it('returns a single plain span for text without ANSI codes', () => {
    expect(parseAnsiToStyledSpans('hello world')).toEqual([
      { text: 'hello world', style: {} },
    ]);
  });

  it('parses basic SGR foreground colours', () => {
    const spans = parseAnsiToStyledSpans('\x1b[32mok\x1b[0m');
    expect(spans).toEqual([
      { text: 'ok', style: { foreground: { kind: 'named', value: 'green' } } },
    ]);
  });

  it('parses red/bold combination', () => {
    const spans = parseAnsiToStyledSpans('\x1b[1;31mFAIL\x1b[0m');
    expect(spans).toEqual([
      { text: 'FAIL', style: { foreground: { kind: 'named', value: 'red' }, bold: true } },
    ]);
  });

  it('handles interleaved plain and styled text', () => {
    const spans = parseAnsiToStyledSpans('text \x1b[31mred\x1b[0m text');
    expect(spans).toEqual([
      { text: 'text ', style: {} },
      { text: 'red', style: { foreground: { kind: 'named', value: 'red' } } },
      { text: ' text', style: {} },
    ]);
  });

  it('strips non-SGR escape sequences (cursor up)', () => {
    const spans = parseAnsiToStyledSpans('\x1b[2Ahello');
    // Cursor up (CSI 2 A) is not SGR — should be stripped.
    expect(spans).toEqual([
      { text: 'hello', style: {} },
    ]);
  });

  it('handles jest-style test output (red FAIL, green PASS)', () => {
    const input = '\x1b[31m●\x1b[0m \x1b[32m✓\x1b[0m';
    const spans = parseAnsiToStyledSpans(input);
    expect(spans).toEqual([
      { text: '●', style: { foreground: { kind: 'named', value: 'red' } } },
      { text: ' ', style: {} },
      { text: '✓', style: { foreground: { kind: 'named', value: 'green' } } },
    ]);
  });

  it('strips C0 control characters and keeps newlines', () => {
    const spans = parseAnsiToStyledSpans('a\r\nb');
    expect(spans).toEqual([
      { text: 'a\nb', style: {} },
    ]);
  });

  it('keeps multi-span output with different colours', () => {
    const input = '\x1b[33mWARN\x1b[0m \x1b[31mERR\x1b[0m';
    const spans = parseAnsiToStyledSpans(input);
    expect(spans).toEqual([
      { text: 'WARN', style: { foreground: { kind: 'named', value: 'yellow' } } },
      { text: ' ', style: {} },
      { text: 'ERR', style: { foreground: { kind: 'named', value: 'red' } } },
    ]);
  });

  it('handles bright foreground colors (90-97) without setting bold', () => {
    const spans = parseAnsiToStyledSpans('\x1b[91mBRIGHT RED\x1b[0m');
    expect(spans).toEqual([
      { text: 'BRIGHT RED', style: { foreground: { kind: 'named', value: 'red' } } },
    ]);
  });
});
