import { parseRichText } from '../src/runtime/rich-text/markdown-parser';
import { layoutRichText } from '../src/runtime/rich-text/layout';
import { sanitizeRichTextInput } from '../src/runtime/rich-text/sanitizer';
import { DEFAULT_THEME } from '../src/tui-core/style';
import type { RichTextThemeResolver } from '../src/runtime/rich-text/types';
import { MAX_RICH_TEXT_INPUT_BYTES } from '../src/runtime/rich-text/types';
import stringWidth from 'string-width';

const themeResolver: RichTextThemeResolver = (token) => {
  switch (token) {
    case 'assistantText': return DEFAULT_THEME.assistantText;
    case 'heading': return DEFAULT_THEME.heading;
    case 'code': return DEFAULT_THEME.code;
    case 'inlineCode': return DEFAULT_THEME.inlineCode ?? DEFAULT_THEME.code;
    case 'link': return DEFAULT_THEME.link ?? DEFAULT_THEME.assistantText;
    case 'diffAdded': return DEFAULT_THEME.diffAdded;
    case 'diffRemoved': return DEFAULT_THEME.diffRemoved;
    case 'diffHunk': return DEFAULT_THEME.diffHunk;
    case 'warning': return DEFAULT_THEME.warning;
    case 'error': return DEFAULT_THEME.error;
    case 'muted': return DEFAULT_THEME.muted;
  }
};

// ============================================================================
// Sanitizer
// ============================================================================

describe('rich-text sanitizer', () => {
  it('strips ANSI escape sequences', () => {
    expect(sanitizeRichTextInput('hello\x1b[31mworld')).toBe('helloworld');
  });

  it('normalizes line endings', () => {
    expect(sanitizeRichTextInput('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('expands tabs', () => {
    expect(sanitizeRichTextInput('a\tb')).toBe('a    b');
  });
});

// ============================================================================
// Parser
// ============================================================================

describe('rich-text parser', () => {
  it('parses heading', () => {
    const doc = parseRichText('# Title');
    expect(doc.blocks.length).toBeGreaterThan(0);
    const heading = doc.blocks.find(b => b.type === 'heading');
    expect(heading).toBeDefined();
    if (heading?.type === 'heading') {
      expect(heading.level).toBe(1);
    }
  });

  it('parses paragraph', () => {
    const doc = parseRichText('Hello world');
    const para = doc.blocks.find(b => b.type === 'paragraph');
    expect(para).toBeDefined();
  });

  it('parses code block', () => {
    const doc = parseRichText('```typescript\ncode line\n```');
    const code = doc.blocks.find(b => b.type === 'code');
    expect(code).toBeDefined();
    if (code?.type === 'code') {
      expect(code.lines).toContain('code line');
      expect(code.language).toBe('typescript');
    }
  });

  it('parses diff block', () => {
    const doc = parseRichText('```diff\n+added\n-removed\n@@ hunk @@\n```');
    const diff = doc.blocks.find(b => b.type === 'diff');
    expect(diff).toBeDefined();
    if (diff?.type === 'diff') {
      expect(diff.lines.length).toBe(3);
      expect(diff.lines[0].kind).toBe('add');
      expect(diff.lines[1].kind).toBe('remove');
      expect(diff.lines[2].kind).toBe('hunk');
    }
  });

  it('parses list', () => {
    const doc = parseRichText('- item 1\n- item 2');
    const list = doc.blocks.find(b => b.type === 'list');
    expect(list).toBeDefined();
    if (list?.type === 'list') {
      expect(list.ordered).toBe(false);
      expect(list.items.length).toBe(2);
    }
  });

  it('parses ordered list', () => {
    const doc = parseRichText('1. first\n2. second');
    const list = doc.blocks.find(b => b.type === 'list');
    expect(list).toBeDefined();
    if (list?.type === 'list') {
      expect(list.ordered).toBe(true);
      expect(list.items.length).toBe(2);
    }
  });

  it('parses blockquote', () => {
    const doc = parseRichText('> quoted text');
    const quote = doc.blocks.find(b => b.type === 'quote');
    expect(quote).toBeDefined();
  });

  it('parses horizontal rule', () => {
    const doc = parseRichText('---\n');
    const rule = doc.blocks.find(b => b.type === 'rule');
    expect(rule).toBeDefined();
  });

  it('parses inline bold', () => {
    const doc = parseRichText('**bold**');
    const para = doc.blocks.find(b => b.type === 'paragraph');
    if (para?.type === 'paragraph') {
      expect(para.spans.some(s => s.bold)).toBe(true);
    }
  });

  it('preserves nested bold and italic without leaking Markdown markers', () => {
    const doc = parseRichText('***both*** and **bold [link](https://example.com)**');
    const para = doc.blocks.find(b => b.type === 'paragraph');
    expect(para?.type).toBe('paragraph');
    if (para?.type === 'paragraph') {
      expect(para.spans).toContainEqual({ text: 'both', bold: true, italic: true });
      expect(para.spans.some(span => span.text.includes('**'))).toBe(false);
      expect(para.spans).toContainEqual({
        text: 'link',
        bold: true,
        linkUrl: 'https://example.com',
      });
    }
  });

  it('parses inline code', () => {
    const doc = parseRichText('`code`');
    const para = doc.blocks.find(b => b.type === 'paragraph');
    if (para?.type === 'paragraph') {
      expect(para.spans.some(s => s.code)).toBe(true);
    }
  });

  it('parses link', () => {
    const doc = parseRichText('[label](https://example.com)');
    const para = doc.blocks.find(b => b.type === 'paragraph');
    if (para?.type === 'paragraph') {
      const linkSpan = para.spans.find(s => s.linkUrl);
      expect(linkSpan).toBeDefined();
      expect(linkSpan?.linkUrl).toBe('https://example.com');
    }
  });

  it('falls back to plain text on parse failure', () => {
    const doc = parseRichText('plain text');
    expect(doc.blocks.length).toBeGreaterThan(0);
  });

  it('handles empty input', () => {
    const doc = parseRichText('');
    expect(doc.blocks).toEqual([]);
  });

  it('never throws on malformed input', () => {
    expect(() => parseRichText('#'.repeat(10000))).not.toThrow();
    expect(() => parseRichText('``')).not.toThrow();
    expect(() => parseRichText('[[[[')).not.toThrow();
  });

  it('deterministically truncates oversized input', () => {
    const doc = parseRichText('x'.repeat(MAX_RICH_TEXT_INPUT_BYTES + 100));
    const text = doc.blocks
      .flatMap(block => block.type === 'paragraph' ? block.spans.map(span => span.text) : [])
      .join('');

    expect(text.length).toBe(MAX_RICH_TEXT_INPUT_BYTES);
  });

  it('strips ANSI from model content before parsing', () => {
    const doc = parseRichText('\x1b[31m# Heading\x1b[0m');
    const heading = doc.blocks.find(b => b.type === 'heading');
    expect(heading).toBeDefined();
  });
});

// ============================================================================
// Layout
// ============================================================================

describe('rich-text layout', () => {
  it('produces rows within width constraint', () => {
    const doc = parseRichText('This is a long paragraph that should wrap to multiple lines when the width is small');
    const rows = layoutRichText(doc, { width: 20, theme: themeResolver });
    for (const row of rows) {
      const rowWidth = stringWidth(row.map(s => s.text).join(''));
      expect(rowWidth).toBeLessThanOrEqual(20);
    }
  });

  it('layouts heading with style', () => {
    const doc = parseRichText('# Title');
    const rows = layoutRichText(doc, { width: 40, theme: themeResolver });
    expect(rows.length).toBeGreaterThan(0);
  });

  it('layouts code block with continuation markers', () => {
    const longLine = 'x'.repeat(50);
    const doc = parseRichText('```\n' + longLine + '\n```');
    const rows = layoutRichText(doc, { width: 20, theme: themeResolver });
    expect(rows.length).toBeGreaterThan(1);
  });

  it('fills code block rows with a semantic background', () => {
    const doc = parseRichText('```ts\nconst value = 1;\n\n```');
    const rows = layoutRichText(doc, { width: 24, theme: themeResolver });

    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(stringWidth(row.map(span => span.text).join(''))).toBe(24);
      expect(row.every(span => span.style.background !== undefined)).toBe(true);
    }
  });

  it('renders a dim language label as code-block metadata', () => {
    const doc = parseRichText('```typescript\nconst value = 1;\n```');
    const rows = layoutRichText(doc, { width: 24, theme: themeResolver });

    expect(rows[0].map(span => span.text).join('').trim()).toBe('typescript');
    expect(rows[0].every(span => span.style.background !== undefined)).toBe(true);
    expect(rows[0].every(span => span.style.dim)).toBe(true);
    expect(stringWidth(rows[0].map(span => span.text).join(''))).toBe(24);
  });

  it('aligns nested list continuation rows under their content', () => {
    const doc = parseRichText([
      '- parent',
      '  - child with enough words to wrap across several rows',
    ].join('\n'));
    const rows = layoutRichText(doc, { width: 18, theme: themeResolver });
    const textRows = rows.map(row => row.map(span => span.text).join(''));
    const childIndex = textRows.findIndex(row => row.startsWith('  - child'));

    expect(childIndex).toBeGreaterThanOrEqual(0);
    expect(textRows[childIndex + 1]).toMatch(/^ {4}\S/);
    for (const row of textRows) expect(stringWidth(row)).toBeLessThanOrEqual(18);
  });

  it('uses distinct semantic styles for inline code and links', () => {
    const doc = parseRichText('Use `openhorse` and [docs](https://example.com).');
    const rows = layoutRichText(doc, { width: 80, theme: themeResolver });
    const spans = rows.flat();

    expect(spans.find(span => span.text.includes('openhorse'))?.style.background).toBeDefined();
    expect(spans.find(span => span.text.includes('docs'))?.style.underline).toBe(true);
  });

  it('layouts diff with colored prefixes', () => {
    const doc = parseRichText('```diff\n+added\n-removed\n```');
    const rows = layoutRichText(doc, { width: 40, theme: themeResolver });
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('layouts table without overflow', () => {
    const md = '| Col A | Col B |\n|---|---|\n| 1 | 2 |';
    const doc = parseRichText(md);
    const rows = layoutRichText(doc, { width: 40, theme: themeResolver });
    for (const row of rows) {
      const rowWidth = stringWidth(row.map(s => s.text).join(''));
      expect(rowWidth).toBeLessThanOrEqual(40);
    }
  });

  it('falls back to key/value layout at narrow widths', () => {
    const md = '| Header1 | Header2 |\n|---|---|\n| val1 | val2 |';
    const doc = parseRichText(md);
    const rows = layoutRichText(doc, { width: 8, theme: themeResolver });
    expect(rows.length).toBeGreaterThan(0);
  });

  it('handles CJK width correctly', () => {
    const doc = parseRichText('你好世界这是一段中文');
    const rows = layoutRichText(doc, { width: 10, theme: themeResolver });
    for (const row of rows) {
      const rowWidth = stringWidth(row.map(s => s.text).join(''));
      expect(rowWidth).toBeLessThanOrEqual(10);
    }
  });

  it.each([24, 40, 120])('keeps complex Markdown within %i columns', width => {
    const markdown = [
      '# Heading',
      '',
      '> quote with **bold** text',
      '',
      '- first list item with a long continuation',
      '- second item',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| 你好 | emoji 👨‍👩‍👧 |',
      '',
      '```diff',
      '+added line',
      '-removed line',
      '```',
    ].join('\n');
    const rows = layoutRichText(parseRichText(markdown), { width, theme: themeResolver });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(stringWidth(row.map(span => span.text).join(''))).toBeLessThanOrEqual(width);
    }
  });
});
