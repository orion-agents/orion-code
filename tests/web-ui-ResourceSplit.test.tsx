/**
 * v0.3.13 S2 — ResourceSplitLayout render contract.
 *
 * The shell renders content before the separator before the navigator so the
 * visual, reading and keyboard order all lead with the content, even though
 * the panel source (and this test's JSX) lists the navigator child first.
 * The separator carries the WCAG separator pattern via PanelResizeHandle.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ResourceSplitLayout } from '../web/src/layout/ResourceSplitLayout';

function renderShell(panelId: 'files' | 'review' | 'git') {
  return renderToStaticMarkup(
    React.createElement(ResourceSplitLayout, {
      panelId,
      navigatorWidthPx: 300,
      onNavigatorWidthCommit: () => undefined,
      contentLabel: '内容区',
      navigatorLabel: '导航区',
      handleLabel: '调整导航区宽度',
      contentClassName: `${panelId}-content`,
      navigatorClassName: `${panelId}-navigator`,
      children: [
        React.createElement('p', { key: 'n' }, 'navigator-child'),
        React.createElement('p', { key: 'c' }, 'content-child'),
      ],
    })
  );
}

describe('ResourceSplitLayout (v0.3.13 S2)', () => {
  it('renders content → separator → navigator in DOM order', () => {
    const html = renderShell('files');
    const content = html.indexOf('resource-split-content');
    const separator = html.indexOf('role="separator"');
    const navigator = html.indexOf('resource-split-navigator');
    expect(content).toBeGreaterThan(-1);
    expect(separator).toBeGreaterThan(-1);
    expect(navigator).toBeGreaterThan(-1);
    expect(content).toBeLessThan(separator);
    expect(separator).toBeLessThan(navigator);
  });

  it('labels the regions and the separator for assistive tech', () => {
    const html = renderShell('review');
    expect(html).toContain('aria-label="内容区"');
    expect(html).toContain('aria-label="导航区"');
    expect(html).toContain('aria-label="调整导航区宽度"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('tabindex="0"');
  });

  it('writes the navigator width as the sizing CSS variable', () => {
    const html = renderShell('git');
    // Server render has no ResizeObserver, so the dynamic ceiling falls back to
    // the 160px floor and the 300px preference is re-clamped on render — the
    // exact render-time clamp the plan requires.
    expect(html).toContain('--resource-navigator-width:160px');
  });

  it('keeps content first for every resource panel id', () => {
    for (const id of ['files', 'review', 'git'] as const) {
      const html = renderShell(id);
      const content = html.indexOf('resource-split-content');
      const navigator = html.indexOf('resource-split-navigator');
      expect(content).toBeLessThan(navigator);
    }
  });
});
