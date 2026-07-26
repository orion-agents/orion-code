import { parseAnsiToStyledSpans } from '../src/runtime/rich-text/ansi-parser';

describe('ansi-parser clear-attribute edge cases', () => {
  it('code 39 clears only foreground, keeps other attrs', () => {
    // red text, then code 39 (default fg) - should clear fg only
    const spans = parseAnsiToStyledSpans('\x1b[31mred\x1b[39mtext');
    expect(spans).toEqual([
      { text: 'red', style: { foreground: { kind: 'named', value: 'red' } } },
      { text: 'text', style: {} },
    ]);
  });

  it('code 49 clears only background, keeps foreground', () => {
    const spans = parseAnsiToStyledSpans('\x1b[31;44mAB\x1b[49mCD');
    expect(spans).toEqual([
      { text: 'AB', style: {
        foreground: { kind: 'named', value: 'red' },
        background: { kind: 'named', value: 'blue' },
      } },
      { text: 'CD', style: {
        foreground: { kind: 'named', value: 'red' },
      } },
    ]);
  });

  it('code 39 does not reset bold/dim', () => {
    const spans = parseAnsiToStyledSpans('\x1b[1;31mB\x1b[39mC');
    expect(spans).toEqual([
      { text: 'B', style: { bold: true, foreground: { kind: 'named', value: 'red' } } },
      { text: 'C', style: { bold: true } },
    ]);
  });

  it('applies reset and later attributes in source order', () => {
    expect(parseAnsiToStyledSpans('\x1b[1;0;31mred')).toEqual([
      { text: 'red', style: { foreground: { kind: 'named', value: 'red' } } },
    ]);
  });

  it('lets a later clear override an earlier color in the same sequence', () => {
    expect(parseAnsiToStyledSpans('\x1b[31;39mplain')).toEqual([
      { text: 'plain', style: {} },
    ]);
  });

  it('treats an empty SGR parameter list as reset', () => {
    expect(parseAnsiToStyledSpans('\x1b[31mred\x1b[mplain')).toEqual([
      { text: 'red', style: { foreground: { kind: 'named', value: 'red' } } },
      { text: 'plain', style: {} },
    ]);
  });
});
