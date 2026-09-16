/**
 * v0.3.17 S2 — structured diff reader rendering.
 *
 * `renderToStaticMarkup` assertions on the real component: gutter line numbers, hunk
 * folding, side-by-side alignment, incomplete-hunk marking and the capability hint.
 * Interaction itself is exercised through the pure view model plus the browser suite.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { GitDiffDocumentV2 } from '../src/web/git-diff-document';
import { StructuredDiffViewer } from '../web/src/components/git/StructuredDiffViewer';
import type { GitDiffMode } from '../web/src/state/git-panel-state';

function document(overrides: Partial<GitDiffDocumentV2> = {}): GitDiffDocumentV2 {
  return {
    schemaVersion: 2,
    fileToken: 'git_token',
    path: 'web/src/App.tsx',
    source: 'unstaged',
    repositoryRevision: 'rev-1',
    kind: 'text',
    binary: false,
    hunks: [
      {
        hunkId: '0:10:10',
        header: '@@ -10,2 +10,3 @@ export function App() {',
        oldStart: 10,
        oldLines: 2,
        newStart: 10,
        newLines: 3,
        contextLabel: 'export function App() {',
        complete: true,
        lines: [
          {
            lineId: '0:10:10#0',
            kind: 'context',
            oldLineNumber: 10,
            newLineNumber: 10,
            text: 'const keep = 1;',
            raw: ' const keep = 1;',
          },
          {
            lineId: '0:10:10#1',
            kind: 'deletion',
            oldLineNumber: 11,
            newLineNumber: null,
            text: 'const removed = 2;',
            raw: '-const removed = 2;',
          },
          {
            lineId: '0:10:10#2',
            kind: 'addition',
            newLineNumber: 11,
            oldLineNumber: null,
            text: 'const added = 3;',
            raw: '+const added = 3;',
          },
        ],
      },
    ],
    meta: [],
    completeness: 'complete',
    additions: 1,
    deletions: 1,
    lineCount: 3,
    nextCursor: null,
    capabilities: {
      stageFile: true,
      unstageFile: false,
      stageHunk: false,
      unstageHunk: false,
      stageLines: false,
      reason: 'Hunk 与选中行级写入将在 S3 提供。',
    },
    ...overrides,
  };
}

function render(
  overrides: {
    document?: Partial<GitDiffDocumentV2>;
    mode?: GitDiffMode;
    collapsedHunks?: readonly string[];
    wrap?: boolean;
    stale?: boolean;
    onLoadMore?: () => void;
  } = {}
) {
  return renderToStaticMarkup(
    React.createElement(StructuredDiffViewer, {
      document: document(overrides.document),
      mode: overrides.mode ?? 'unified',
      wrap: overrides.wrap ?? false,
      showWhitespace: false,
      collapsedHunks: overrides.collapsedHunks ?? [],
      anchorLineId: null,
      stale: overrides.stale ?? false,
      onChangeMode: () => undefined,
      onToggleWrap: () => undefined,
      onToggleWhitespace: () => undefined,
      onToggleHunk: () => undefined,
      onSetAllFolded: () => undefined,
      onAnchorChange: () => undefined,
      onNotice: () => undefined,
      onSendToComposer: () => undefined,
      ...(overrides.onLoadMore ? { onLoadMore: overrides.onLoadMore } : {}),
    })
  );
}

describe('StructuredDiffViewer', () => {
  test('states the path, comparison source and change counts', () => {
    const html = render();
    expect(html).toContain('web/src/App.tsx');
    expect(html).toContain('索引 → 工作区');
    expect(html).toContain('+1');
    expect(html).toContain('-1');
    expect(html).toContain('1 个 Hunk');
  });

  test('renders both gutter line numbers and the hunk header', () => {
    const html = render();
    expect(html).toContain('@@ -10,2 +10,3 @@ export function App() {');
    // Old side line 11 (the deletion) and new side line 11 (the addition).
    expect(html).toContain('>11<');
    expect(html).toContain('>10<');
    expect(html).toContain('data-line-id="0:10:10#1"');
    expect(html).toContain('data-line-id="0:10:10#2"');
  });

  test('classifies additions and deletions for styling', () => {
    const html = render();
    expect(html).toContain('diff-line-deletion');
    expect(html).toContain('diff-line-addition');
  });

  test('folds a hunk into a single expandable row', () => {
    const html = render({ collapsedHunks: ['0:10:10'] });
    expect(html).toContain('已折叠 3 行');
    expect(html).not.toContain('const removed = 2;');
    expect(html).toContain('aria-expanded="false"');
  });

  test('renders aligned rows in side-by-side mode', () => {
    const html = render({ mode: 'side-by-side' });
    expect(html).toContain('diff-body-side-by-side');
    expect(html).toContain('diff-sbs-row');
    // Both sides of the replacement are present in the same row.
    expect(html).toContain('const removed = 2;');
    expect(html).toContain('const added = 3;');
  });

  test('adds the wrap class only when wrapping is on', () => {
    expect(render({ wrap: true })).toContain('diff-wrap');
    expect(render({ wrap: false })).not.toContain('diff-wrap');
  });

  test('marks a stale document instead of pretending it is current', () => {
    expect(render({ stale: true })).toContain('已变化');
    expect(render({ stale: false })).not.toContain('diff-stale');
  });

  test('warns that paged content cannot be written and offers the continuation', () => {
    const withoutHandler = render({ document: { completeness: 'paged', nextCursor: 'cursor-1' } });
    expect(withoutHandler).toContain('当前为分页预览');
    // No handler, no button — the reader is never offered a dead control.
    expect(withoutHandler).not.toContain('加载更多 Diff');

    const withHandler = render({
      document: { completeness: 'paged', nextCursor: 'cursor-1' },
      onLoadMore: () => undefined,
    });
    expect(withHandler).toContain('加载更多 Diff');
  });

  test('flags an incomplete hunk', () => {
    const doc = document();
    const html = render({
      document: {
        completeness: 'limited',
        hunks: [{ ...doc.hunks[0], complete: false }],
      },
    });
    expect(html).toContain('未完整加载');
  });

  test('reports write capability and its reason', () => {
    const html = render();
    expect(html).toContain('可暂存此文件');
    expect(html).toContain('S3');

    const staged = render({
      document: {
        source: 'staged',
        capabilities: {
          stageFile: false,
          unstageFile: true,
          stageHunk: false,
          unstageHunk: false,
          stageLines: false,
        },
      },
    });
    expect(staged).toContain('可取消暂存此文件');
  });

  test('shows a metadata-only document without inventing hunks', () => {
    const html = render({
      document: {
        kind: 'metadata',
        hunks: [],
        meta: ['old mode 100644', 'new mode 100755'],
        additions: 0,
        deletions: 0,
      },
    });
    expect(html).toContain('仅有元数据变化');
    expect(html).toContain('old mode 100644');
  });

  test('shows a binary document without rendering lines', () => {
    const html = render({
      document: { kind: 'binary', binary: true, hunks: [], additions: 0, deletions: 0, meta: ['Binary files a/logo.png and b/logo.png differ'] },
    });
    expect(html).toContain('二进制差异');
    expect(html).not.toContain('diff-body');
  });
});
