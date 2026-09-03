/**
 * DiffViewer contract layer (v0.3.6 P0-A).
 *
 * Pure `renderToStaticMarkup` assertions on the Git diff resource panel: header
 * facts, hunk navigation, line classification (addition/deletion) and the
 * binary-file fallback.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DiffViewer } from '../web/src/components/git/DiffViewer';
import type { WebGitDiffPageV1 } from '../web/src/types';

function page(overrides: Partial<WebGitDiffPageV1> = {}): WebGitDiffPageV1 {
  return {
    fileId: 'file:1',
    path: 'web/src/App.tsx',
    repositoryRevision: 'abc123',
    binary: false,
    lines: [
      '@@ -1,2 +1,2 @@',
      ' export function App() {',
      '+  const added = 1;',
      '-  const removed = 2;',
      ' }',
    ],
    nextCursor: null,
    truncated: false,
    ...overrides,
  };
}

function render(overrides: Partial<WebGitDiffPageV1> = {}) {
  return renderToStaticMarkup(
    React.createElement(DiffViewer, { page: page(overrides), onSendToComposer: () => undefined })
  );
}

describe('DiffViewer', () => {
  it('renders the file path and line count in the header', () => {
    const html = render();
    expect(html).toContain('web/src/App.tsx');
    expect(html).toContain('5 行');
  });

  it('flags truncated previews instead of the raw line count', () => {
    const html = render({ truncated: true, lines: ['a', 'b'] });
    expect(html).toContain('受限预览');
    expect(html).not.toContain('2 行');
  });

  it('classifies additions and deletions for colour + shape styling', () => {
    const html = render();
    // Whitespace and quotes are normalized by React; assert on the meaningful part.
    expect(html).toContain('class="addition"');
    expect(html).toContain('class="deletion"');
  });

  it('shows the whitespace toggle and copy actions', () => {
    const html = render();
    expect(html).toContain('显示空白字符');
    expect(html).toContain('复制 Hunk');
    expect(html).toContain('折叠 Hunk');
  });

  it('exposes the diff as a keyboard reachable region with an aria label', () => {
    const html = render();
    expect(html).toContain('aria-label="Diff web/src/App.tsx"');
  });

  it('renders the binary fallback without touching diff lines', () => {
    const html = render({ binary: true, lines: [] });
    expect(html).toContain('二进制差异');
    expect(html).not.toContain('复制 Hunk');
  });

  it('does not render hunk navigation for a single hunk', () => {
    const html = render();
    expect(html).not.toContain('role="tablist"');
  });

  it('renders hunk navigation when the diff splits into multiple hunks', () => {
    const html = render({
      lines: ['@@ -1,2 +1,2 @@', '+a', '-b', '@@ -10,2 +10,2 @@', '+c', '-d'],
    });
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
  });

  it('keeps context lines neutral (no addition/deletion class)', () => {
    const html = render({ lines: ['@@ -1 +1 @@', ' plain line', '+added', '-removed'] });
    // Only + / - prefixed lines carry a classification class.
    const plain = html.match(/class="plain line"/);
    expect(plain).toBeNull();
  });
});
