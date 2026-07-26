import stringWidth from 'string-width';
import { layoutTranscriptEntry } from '../src/tui-ui/transcript-layout';
import { DEFAULT_TUI_THEME } from '../src/tui-ui/theme';
import type { StyledRow, TuiColor } from '../src/tui-core/style';
import type { StructuredToolActivity } from '../src/runtime/ui-events';

function rowText(row: StyledRow): string {
  return row.map(span => span.text).join('');
}

function allText(rows: StyledRow[]): string {
  return rows.map(rowText).join('\n');
}

function namedColor(color: TuiColor | undefined): string | undefined {
  return color?.kind === 'named' ? color.value : undefined;
}

function toolActivity(
  state: StructuredToolActivity['state'],
  overrides: Partial<StructuredToolActivity> = {},
): StructuredToolActivity {
  return {
    state,
    name: 'exec_command',
    detail: 'npm test',
    ...overrides,
  };
}

describe('tui transcript layout', () => {
  it('renders assistant Markdown semantically without source markers or ANSI', () => {
    const content = [
      '# Heading',
      '',
      '**bold** and *italic* with `inline` and [link](https://example.com)',
      '',
      '> quoted text',
      '',
      '- list item',
      '',
      '| Key | Value |',
      '| --- | --- |',
      '| one | two |',
      '',
      '```ts',
      'const answer = 42;',
      '```',
      '',
      '```diff',
      '+added',
      '-removed',
      '```',
    ].join('\n');
    const rows = layoutTranscriptEntry({ role: 'assistant', content }, { width: 80 });
    const rendered = allText(rows);
    const spans = rows.flat();

    expect(rendered).toContain('Heading');
    expect(rendered).not.toContain('# Heading');
    expect(rendered).not.toContain('**bold**');
    expect(rendered).not.toContain('```');
    expect(rendered).not.toContain('\x1b');
    expect(spans.some(span => span.text.includes('Heading') && span.style.bold)).toBe(true);
    expect(spans.some(span => span.text.includes('bold') && span.style.bold)).toBe(true);
    expect(spans.some(span => span.text.includes('italic') && span.style.italic)).toBe(true);
    expect(spans.some(span => span.text.includes('inline') && span.style.background)).toBe(true);
    expect(spans.some(span => span.text.includes('link') && span.style.underline)).toBe(true);
    expect(spans.some(span => span.text.includes('const answer') && span.style.background)).toBe(true);
    expect(spans.some(span => namedColor(span.style.foreground) === 'green')).toBe(true);
    expect(spans.some(span => namedColor(span.style.foreground) === 'red')).toBe(true);
  });

  it('renders combined emphasis as one bold italic span', () => {
    const rows = layoutTranscriptEntry({
      role: 'assistant',
      content: '***both***',
    }, { width: 40 });
    const combined = rows.flat().find(span => span.text === 'both');

    expect(allText(rows)).toBe('both');
    expect(combined?.style).toMatchObject({ bold: true, italic: true });
  });

  it('renders user text literally with full-width CJK and emoji-safe background rows', () => {
    const content = '**literal** 你好世界 👨‍👩‍👧 继续输入直到发生换行';
    const rows = layoutTranscriptEntry({
      role: 'user',
      content,
      revision: 3,
      finalized: true,
    }, { width: 24 });

    expect(rows.length).toBeGreaterThan(1);
    expect(rowText(rows[0]).startsWith(' › **literal**')).toBe(true);
    expect(allText(rows)).toContain('**literal**');
    for (const row of rows) {
      expect(stringWidth(rowText(row))).toBe(24);
      expect(row.length).toBeGreaterThan(0);
      expect(row.every(span => span.style.background !== undefined)).toBe(true);
    }
  });

  it.each([
    ['running', 'yellow'],
    ['success', 'green'],
    ['error', 'red'],
    ['skipped', undefined],
  ] as const)('renders %s tool state distinctly', (state, color) => {
    const rows = layoutTranscriptEntry({
      role: 'tool',
      content: 'output',
      toolActivity: toolActivity(state),
    }, { width: 40 });

    expect(rowText(rows[0])).toContain('exec_command');
    expect(namedColor(rows[0][0].style.foreground)).toBe(color);
    if (state === 'skipped') expect(rows[0][0].style.dim).toBe(true);
  });

  it('preserves safe tool SGR styles and removes unsafe control sequences and payloads', () => {
    const rows = layoutTranscriptEntry({
      role: 'tool',
      content: '\x1b[31mred\x1b[0m \x1b[2Jclean \x1b]0;owned\x07tail',
      toolActivity: toolActivity('success'),
    }, { width: 80 });
    const rendered = allText(rows);
    const redSpan = rows.flat().find(span => span.text.includes('red'));

    expect(namedColor(redSpan?.style.foreground)).toBe('red');
    expect(rendered).toContain('clean');
    expect(rendered).toContain('tail');
    expect(rendered).not.toContain('owned');
    expect(rendered).not.toContain('\x1b');
  });

  it('uses the tool presenter for title=tool even when role=error', () => {
    const rows = layoutTranscriptEntry({
      role: 'error',
      title: 'tool',
      content: 'command failed',
    }, { width: 40 });

    expect(rowText(rows[0])).toBe('✗ tool');
    expect(rowText(rows[0])).not.toContain('! ');
    expect(namedColor(rows[0][0].style.foreground)).toBe('red');
  });

  it('uses the tool presenter whenever typed toolActivity exists', () => {
    const rows = layoutTranscriptEntry({
      role: 'assistant',
      content: 'typed output',
      toolActivity: toolActivity('running', { name: 'read_file' }),
    }, { width: 40 });

    expect(rowText(rows[0])).toContain('read_file');
    expect(namedColor(rows[0][0].style.foreground)).toBe('yellow');
  });

  it('prefers structured tool metadata and body over duplicated legacy content', () => {
    const rows = layoutTranscriptEntry({
      role: 'tool',
      content: 'legacy duplicate header',
      toolActivity: toolActivity('success', {
        detail: 'src/index.ts',
        command: 'cat src/index.ts',
        duration: '12ms',
        summary: 'read complete',
        outputBytes: 2048,
        artifactHint: '/artifacts show tool-1 --full',
        body: '\x1b[32mstructured body\x1b[0m',
      }),
    }, { width: 160 });
    const rendered = allText(rows);

    expect(rendered).toContain('exec_command');
    expect(rendered).toContain('src/index.ts');
    expect(rendered).toContain('$ cat src/index.ts');
    expect(rendered).toContain('output 2.0 KB');
    expect(rendered).toContain('artifact /artifacts show tool-1 --full');
    expect(rendered).toContain('structured body');
    expect(rendered).not.toContain('legacy duplicate header');
  });

  it.each([
    ['error', '! '],
    ['system', 'system  '],
    ['command', '$ '],
    ['status', '· '],
  ] as const)('renders %s with an explicit semantic presenter', (role, prefix) => {
    const rows = layoutTranscriptEntry({ role, content: 'message' }, { width: 40 });
    expect(rowText(rows[0]).startsWith(prefix)).toBe(true);
    expect(rows[0].some(span => Object.keys(span.style).length > 0)).toBe(true);
  });

  it('renders typed warning status with warning theme', () => {
    const rows = layoutTranscriptEntry({
      role: 'status',
      statusTone: 'warning',
      content: 'Verification incomplete',
    }, { width: 40 });

    expect(namedColor(rows[0][0].style.foreground)).toBe('yellow');
  });

  it.each([24, 40, 120])('keeps every role within %i columns', width => {
    const entries = [
      { role: 'assistant' as const, content: '# Heading\n\nA long **Markdown** paragraph with `code`.' },
      { role: 'user' as const, content: '你好 👨‍👩‍👧 '.repeat(20) },
      {
        role: 'tool' as const,
        content: '\x1b[32mtool output\x1b[0m '.repeat(20),
        toolActivity: toolActivity('running'),
      },
      { role: 'system' as const, content: 'system message '.repeat(20) },
    ];

    for (const entry of entries) {
      const rows = layoutTranscriptEntry(entry, { width, theme: DEFAULT_TUI_THEME });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(stringWidth(rowText(row))).toBeLessThanOrEqual(width);
        expect(rowText(row)).not.toContain('\x1b');
      }
    }
  });

  it('degrades malformed Markdown deterministically without throwing', () => {
    const malformed = '#'.repeat(10_000) + '\n```\nunterminated\x1b[2J';
    expect(() => layoutTranscriptEntry({
      role: 'assistant',
      content: malformed,
    }, { width: 24 })).not.toThrow();

    const rows = layoutTranscriptEntry({ role: 'assistant', content: malformed }, { width: 24 });
    expect(rows.every(row => stringWidth(rowText(row)) <= 24)).toBe(true);
    expect(allText(rows)).not.toContain('\x1b');
  });
});
