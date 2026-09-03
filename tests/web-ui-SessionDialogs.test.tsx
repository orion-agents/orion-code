/**
 * v0.3.7 — Session tag / delete dialogs rendering contract: chip editing
 * affordances and the irreversible-delete warning.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ConfirmDeleteSessionDialog, SessionTagsDialog } from '../web/src/components/Dialogs';

const SESSION = {
  id: 'session-1',
  projectPath: '/tmp/demo',
  name: '修复缓存 bug',
  model: 'test',
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  messageCount: 12,
  contextDigest: 'd',
  tags: ['bug', '前端'],
};

function noop(): void {
  /* no-op */
}

describe('SessionTagsDialog', () => {
  const save = async (_sessionId: string, _tags: readonly string[]): Promise<void> => undefined;

  it('renders the session name and current tags as chips', () => {
    const html = renderToStaticMarkup(
      React.createElement(SessionTagsDialog, {
        open: true,
        onClose: noop,
        session: SESSION,
        pending: false,
        onSave: save,
      })
    );
    expect(html).toContain('管理会话标签');
    expect(html).toContain('修复缓存 bug');
    expect(html).toContain('class="session-tag-chip"');
    expect(html).toContain('bug');
    expect(html).toContain('前端');
  });

  it('renders an empty-state hint when the session has no tags', () => {
    const html = renderToStaticMarkup(
      React.createElement(SessionTagsDialog, {
        open: true,
        onClose: noop,
        session: { ...SESSION, tags: [] },
        pending: false,
        onSave: save,
      })
    );
    expect(html).toContain('还没有标签，输入后回车添加。');
    expect(html).not.toContain('session-tag-chip');
  });

  it('gives every chip an accessible remove control', () => {
    const html = renderToStaticMarkup(
      React.createElement(SessionTagsDialog, {
        open: true,
        onClose: noop,
        session: SESSION,
        pending: false,
        onSave: save,
      })
    );
    expect(html).toContain('aria-label="移除标签 bug"');
    expect(html).toContain('aria-label="移除标签 前端"');
  });

  it('keeps the input single-purpose with an add hint', () => {
    const html = renderToStaticMarkup(
      React.createElement(SessionTagsDialog, {
        open: true,
        onClose: noop,
        session: SESSION,
        pending: false,
        onSave: save,
      })
    );
    expect(html).toContain('placeholder="回车或逗号添加"');
    expect(html).toContain('maxLength="32"');
  });
});

describe('ConfirmDeleteSessionDialog', () => {
  it('names the Session and the permanent consequences', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConfirmDeleteSessionDialog, {
        open: true,
        onClose: noop,
        session: SESSION,
        pending: false,
        onConfirm: async () => undefined,
      })
    );
    expect(html).toContain('删除会话');
    expect(html).toContain('修复缓存 bug');
    expect(html).toContain('不可恢复');
  });

  it('offers an explicit destructive confirm button', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConfirmDeleteSessionDialog, {
        open: true,
        onClose: noop,
        session: SESSION,
        pending: false,
        onConfirm: async () => undefined,
      })
    );
    expect(html).toContain('取消');
    expect(html).toContain('永久删除');
  });

  it('disables the destructive button while a mutation is pending', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConfirmDeleteSessionDialog, {
        open: true,
        onClose: noop,
        session: SESSION,
        pending: true,
        onConfirm: async () => undefined,
      })
    );
    const footer = html.slice(html.indexOf('modal-footer'));
    expect(footer).toContain('disabled=""');
    expect(footer).toContain('删除中…');
  });
});
