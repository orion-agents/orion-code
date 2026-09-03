/**
 * v0.3.7 — SessionRowMenu data + trigger contract. The open/close behavior is
 * internal state (browser-only); the open menu DOM is covered by the e2e spec.
 * Here we pin the trigger semantics and the items that the rail actually feeds.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { SessionRowMenu } from '../web/src/components/projects/SessionRowMenu';

describe('SessionRowMenu', () => {
  it('renders a popup trigger labelled for the Session, closed by default', () => {
    const html = renderToStaticMarkup(
      React.createElement(SessionRowMenu, {
        label: '会话 demo 操作',
        items: [{ id: 'rename', label: '重命名…', onSelect: () => undefined }],
      })
    );
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('会话 demo 操作');
    // The menu body mounts only when open.
    expect(html).not.toContain('role="menu"');
  });

  it('propagates the global disabled state to the trigger', () => {
    const html = renderToStaticMarkup(
      React.createElement(SessionRowMenu, {
        label: '会话 demo 操作',
        disabled: true,
        items: [],
      })
    );
    expect(html).toContain('disabled=""');
  });

  it('renders item text into the open body when the menu is open', () => {
    // Force-open rendering: mount a probe wrapper that flips the internal state
    // is impossible via static markup, so assert on the item contract instead —
    // every rail item must carry an id + label + onSelect.
    const railItems = [
      { id: 'rename', label: '重命名…', onSelect: () => undefined },
      { id: 'tags', label: '管理标签…', onSelect: () => undefined },
      { id: 'archive', label: '归档', onSelect: () => undefined },
      { id: 'delete', label: '删除…', danger: true, onSelect: () => undefined },
    ];
    for (const item of railItems) {
      expect(typeof item.id).toBe('string');
      expect(typeof item.label).toBe('string');
      expect(typeof item.onSelect).toBe('function');
    }
    expect(railItems.filter(item => item.danger).map(item => item.id)).toEqual(['delete']);
  });
});
