/**
 * v0.3.14 — FilesPanel render contract (SSR markup, no jsdom in this suite).
 *
 * The panel is server-rendered on first paint, so the read-only removal is
 * pinned here: no jump/copy/wrap controls and no line-number gutter spans.
 * The editor gate itself is a pure function (`canEditFileContent`) so the
 * rule can be asserted without a DOM.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  FilesPanel,
  canEditFileContent,
  FILE_EDIT_MAX_BYTES,
} from '../web/src/components/files/FilesPanel';
import type { WebFileNodeV1 } from '../web/src/types';
import type { WorkbenchActions } from '../web/src/useWorkbench';

function node(overrides: Partial<WebFileNodeV1> = {}): WebFileNodeV1 {
  return {
    id: 'file_test',
    name: 'notes.txt',
    displayPath: 'notes.txt',
    kind: 'file',
    sizeBytes: 128,
    modifiedAt: '2026-09-08T00:00:00.000Z',
    sensitive: false,
    readable: true,
    ...overrides,
  };
}

function renderPanel(): string {
  const actions = {} as WorkbenchActions;
  return renderToStaticMarkup(
    React.createElement(FilesPanel, {
      workspaceId: 'workspace-test',
      refreshEpoch: 0,
      actions,
      navigatorWidthPx: 300,
      onNavigatorWidthCommit: () => undefined,
    })
  );
}

describe('FilesPanel markup (v0.3.14)', () => {
  it('renders the tree surface with search and refresh controls', () => {
    const html = renderPanel();
    expect(html).toContain('class="work-resource-panel files-panel"');
    expect(html).toContain('resource-search');
    expect(html).toContain('aria-label="刷新文件树"');
  });

  it('never emits the removed read-only toolbar or the line gutter', () => {
    const html = renderPanel();
    for (const removed of [
      '跳转',
      '自动换行',
      'file-code-line',
      'file-line-number',
      'file-line-content',
    ]) {
      expect(html).not.toContain(removed);
    }
    expect(html).not.toContain('wrap');
  });

  it('has no editor until a file is selected', () => {
    const html = renderPanel();
    expect(html).not.toContain('file-editor');
    expect(html).not.toContain('>编辑<');
    expect(html).toContain('选择文件预览');
  });
});

describe('canEditFileContent (v0.3.14)', () => {
  it('allows a small readable text file that is fully paged in', () => {
    expect(canEditFileContent({ selected: node(), binary: false, hasMorePages: false })).toBe(true);
  });

  it('rejects nothing selected, binary, sensitive, unreadable or paged content', () => {
    expect(canEditFileContent({ selected: null, binary: false, hasMorePages: false })).toBe(false);
    expect(canEditFileContent({ selected: node(), binary: true, hasMorePages: false })).toBe(false);
    expect(
      canEditFileContent({
        selected: node({ sensitive: true }),
        binary: false,
        hasMorePages: false,
      })
    ).toBe(false);
    expect(
      canEditFileContent({
        selected: node({ readable: false }),
        binary: false,
        hasMorePages: false,
      })
    ).toBe(false);
    expect(canEditFileContent({ selected: node(), binary: false, hasMorePages: true })).toBe(false);
  });

  it('rejects files above the 512 KiB editor cap and accepts the boundary', () => {
    expect(
      canEditFileContent({
        selected: node({ sizeBytes: FILE_EDIT_MAX_BYTES + 1 }),
        binary: false,
        hasMorePages: false,
      })
    ).toBe(false);
    expect(
      canEditFileContent({
        selected: node({ sizeBytes: FILE_EDIT_MAX_BYTES }),
        binary: false,
        hasMorePages: false,
      })
    ).toBe(true);
  });

  it('treats an unknown size as empty text', () => {
    expect(
      canEditFileContent({
        selected: node({ sizeBytes: undefined }),
        binary: false,
        hasMorePages: false,
      })
    ).toBe(true);
  });
});
