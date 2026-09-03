import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Markdown } from '../web/src/components/Markdown';

function render(source: string): string {
  return renderToStaticMarkup(React.createElement(Markdown, { children: source }));
}

describe('Markdown component', () => {
  describe('GFM table support', () => {
    it('renders a basic two-column table with header and body', () => {
      const source = [
        '| 状态 | 数量 |',
        '| --- | --- |',
        '| ✅ 通过 | 139 |',
        '| ❌ 失败 | 3 |',
      ].join('\n');
      const html = render(source);
      expect(html).toContain('<table');
      expect(html).toContain('<thead>');
      expect(html).toContain('<th>状态</th>');
      expect(html).toContain('<th>数量</th>');
      expect(html).toContain('<tbody>');
      expect(html).toContain('<td>✅ 通过</td>');
      expect(html).toContain('<td>139</td>');
      expect(html).toContain('<td>❌ 失败</td>');
      expect(html).toContain('<td>3</td>');
    });

    it('renders inline code inside table cells without breaking layout', () => {
      const source = [
        '| 测试文件 | 失败原因 |',
        '| --- | --- |',
        '| `tui-ui-pty.test.ts` | 超时等不到 `stable terminal UI` |',
      ].join('\n');
      const html = render(source);
      expect(html).toContain('<td><code>tui-ui-pty.test.ts</code></td>');
      expect(html).toContain('超时等不到 <code>stable terminal UI</code>');
    });

    it('respects column alignment markers (left/center/right)', () => {
      const source = [
        '| 左对齐 | 居中 | 右对齐 |',
        '| :--- | :---: | ---: |',
        '| a | b | c |',
      ].join('\n');
      const html = render(source);
      // "left" is the default CSS text-align for Markdown tables, so we omit
      // the inline style for left-aligned columns. Only center/right emit styles.
      expect(html).toMatch(/<th[^>]*style="text-align:center"/);
      expect(html).toMatch(/<th[^>]*style="text-align:right"/);
      expect(html).not.toMatch(/<th[^>]*style="text-align:left"/);
    });

    it('falls back to plain paragraphs when separator column counts do not match', () => {
      const source = ['| a | b |', '| --- | --- | --- |', '| x | y |'].join('\n');
      const html = render(source);
      expect(html).not.toContain('<table');
      expect(html).toContain('<p>');
    });

    it('does not treat malformed separator lines as tables', () => {
      const source = ['| a | b |', '| not a separator |', '| x | y |'].join('\n');
      const html = render(source);
      expect(html).not.toContain('<table');
    });

    it('keeps preceding and following paragraphs intact', () => {
      const source = [
        '前面段落。',
        '',
        '| 状态 | 数量 |',
        '| --- | --- |',
        '| A | 1 |',
        '',
        '后面段落。',
      ].join('\n');
      const html = render(source);
      expect(html).toMatch(
        /<p>前面段落。<\/p>[\s\S]*<table[\s\S]*<\/table>[\s\S]*<p>后面段落。<\/p>/
      );
    });

    it('supports strong and link inline elements inside cells', () => {
      const source = [
        '| 名称 | 链接 |',
        '| --- | --- |',
        '| **bold** | [home](https://example.com) |',
      ].join('\n');
      const html = render(source);
      expect(html).toContain('<td><strong>bold</strong></td>');
      expect(html).toContain('href="https://example.com"');
    });

    it('accepts tables without leading/trailing pipes on rows', () => {
      const source = ['a | b', '--- | ---', '1 | 2'].join('\n');
      const html = render(source);
      expect(html).toContain('<table');
      expect(html).toContain('<th>a</th>');
      expect(html).toContain('<th>b</th>');
      expect(html).toContain('<td>1</td>');
    });

    it('renders a table that is the only content (no stray paragraphs)', () => {
      const source = ['| h |', '| --- |', '| v |'].join('\n');
      const html = render(source);
      expect(html).not.toContain('<p>');
      expect(html).toContain('<table');
    });

    it('handles multi-byte (CJK) content without crashing', () => {
      const source = ['| 阶段 | 通过率 |', '| --- | --- |', '| 实施 | 100% |'].join('\n');
      const html = render(source);
      expect(html).toContain('<th>阶段</th>');
      expect(html).toContain('<td>100%</td>');
    });
  });

  describe('regression: existing inline / block elements still work', () => {
    it('renders fenced code blocks', () => {
      const html = render('```ts\nconst x = 1;\n```');
      expect(html).toContain('<figure class="code-block"');
      expect(html).toContain('const x = 1;');
    });

    it('renders headings with inline code', () => {
      const html = render('## Fix `markdown` table');
      expect(html).toContain('<h2>Fix <code>markdown</code> table</h2>');
    });

    it('keeps heading levels aligned with the markdown source (off-by-one regression)', () => {
      // v0.3.6: heading level must equal the number of `#` (capped at 6). The
      // previous `+ 1` shifted `##` to <h3> and a lone `#` down to <h6>.
      expect(render('# One')).toContain('<h1>One</h1>');
      expect(render('## Two')).toContain('<h2>Two</h2>');
      expect(render('### Three')).toContain('<h3>Three</h3>');
      expect(render('#### Four')).toContain('<h4>Four</h4>');
      expect(render('##### Five')).toContain('<h5>Five</h5>');
      expect(render('###### Six')).toContain('<h6>Six</h6>');
    });

    it('treats more than six hashes as a plain paragraph (GFM cap)', () => {
      const html = render('####### Seven');
      expect(html).not.toContain('<h6>');
      expect(html).toContain('<p>####### Seven</p>');
    });
  });
});
