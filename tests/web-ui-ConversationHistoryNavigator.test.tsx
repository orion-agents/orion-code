/**
 * v0.3.13 S2 — ConversationHistoryNavigator render contract (SSR markup).
 *
 * The rail is a navigation landmark with decorative hidden ticks and exactly
 * one focusable, adjustable slider — never one focusable control per timeline
 * row. This pins the markup contracts that Playwright and screen readers rely
 * on.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ConversationHistoryNavigator } from '../web/src/components/ConversationHistoryNavigator';
import {
  buildHistoryNavigation,
  type HistoryAnchor,
} from '../web/src/components/history-navigation';

function anchor(order: number, kind: HistoryAnchor['kind']): HistoryAnchor {
  return {
    order,
    key: `a${order}`,
    kind,
    label: `${kind}#${order}`,
    priority:
      kind === 'user' || kind === 'assistant' ? 'turn' : kind === 'system' ? 'error' : 'activity',
  };
}

function renderRail(
  overrides: {
    readonly earlierInMemory?: number;
    readonly hasRemoteEarlier?: boolean;
    readonly loadBusy?: boolean;
    readonly activeOrder?: number | null;
    readonly span?: { readonly firstOrder: number; readonly lastOrder: number } | null;
    readonly count?: number;
    readonly reduceMotion?: boolean;
  } = {}
) {
  const items: HistoryAnchor[] = [];
  const count = overrides.count ?? 40;
  for (let index = 0; index < count; index += 1) {
    const mode = index % 4;
    items.push(
      anchor(index, mode === 0 ? 'user' : mode === 1 ? 'assistant' : mode === 2 ? 'tool' : 'system')
    );
  }
  const model = buildHistoryNavigation(items);
  return renderToStaticMarkup(
    React.createElement(ConversationHistoryNavigator, {
      model,
      activeOrder: overrides.activeOrder ?? null,
      span: overrides.span ?? null,
      earlierInMemory: overrides.earlierInMemory ?? 0,
      hasRemoteEarlier: overrides.hasRemoteEarlier ?? false,
      loadBusy: overrides.loadBusy ?? false,
      reduceMotion: overrides.reduceMotion ?? false,
      onLoadEarlier: () => undefined,
      onJumpToOrder: () => undefined,
      onJumpToLatest: () => undefined,
    })
  );
}

describe('ConversationHistoryNavigator markup (v0.3.13 S2)', () => {
  it('renders a labelled navigation landmark with a single slider', () => {
    const html = renderRail();
    expect(html).toContain('aria-label="会话历史定位"');
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-label="已加载会话历史位置"');
    expect((html.match(/role="slider"/gu) ?? []).length).toBe(1);
  });

  it('keeps ticks decorative: aria-hidden container, no per-tick controls', () => {
    const html = renderRail();
    expect(html).toContain('class="history-ticks" aria-hidden="true"');
    expect(html).toContain('history-tick ');
    // Decorative ticks never become buttons/links; the only interactive
    // affordance on the rail is the single slider.
    expect(html).not.toContain('role="button"');
    expect((html.match(/role="slider"/gu) ?? []).length).toBe(1);
  });

  it('reports the active reading position via aria-valuetext', () => {
    const html = renderRail({ activeOrder: 20 });
    expect(html).toContain('aria-valuetext=');
    expect(html).toContain('当前为');
  });

  it('draws the viewport range marker when a span is available', () => {
    const html = renderRail({ span: { firstOrder: 10, lastOrder: 22 } });
    expect(html).toContain('history-viewport-marker');
  });

  it('shows the load-earlier state on top of the rail', () => {
    const inMemory = renderRail({ earlierInMemory: 300 });
    expect(inMemory).toContain('加载更早 · 剩 300 项');
    const remote = renderRail({ hasRemoteEarlier: true });
    expect(remote).toContain('从持久记录加载更早内容');
    const busy = renderRail({ earlierInMemory: 300, loadBusy: true });
    expect(busy).toContain('disabled=""');
  });

  it('renders nothing for an empty model so no empty landmark shows', () => {
    const html = renderRail({ count: 0 });
    expect(html).toBe('');
  });

  it('honours reduced motion at the keyboard layer (smooth disabled)', () => {
    // Markup itself cannot exercise keys, but the slider must stay focusable
    // in both motion preferences.
    expect(renderRail({ reduceMotion: true })).toContain('tabindex="0"');
  });
});
