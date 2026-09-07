/**
 * v0.3.13-plan-1 — ConversationHistoryNavigator render contract (SSR markup).
 *
 * The rail is a Codex-style mini-map: dense decorative ticks (three length
 * tiers, viewport range lit, error ticks red), ONE focusable slider, a white
 * live bar while processing — and absolutely no other chrome (no tooltip, no
 * caps, no dots, no buttons).
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ConversationHistoryNavigator } from '../web/src/components/ConversationHistoryNavigator';
import { buildHistoryNavigation, type HistoryAnchor } from '../web/src/components/history-navigation';

function anchor(order: number, kind: HistoryAnchor['kind']): HistoryAnchor {
  return {
    order,
    key: `a${order}`,
    kind,
    // Assistant turns carry long bodies so all three length tiers appear.
    label: kind === 'assistant' ? `回复内容 ${'x'.repeat(160)}` : `${kind}#${order}`,
    priority:
      kind === 'user' || kind === 'assistant' ? 'turn' : kind === 'system' ? 'error' : 'activity',
  };
}

function renderRail(
  overrides: {
    readonly hasEarlierHistory?: boolean;
    readonly processing?: boolean;
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
      hasEarlierHistory: overrides.hasEarlierHistory ?? false,
      processing: overrides.processing ?? false,
      reduceMotion: overrides.reduceMotion ?? false,
      onJumpToOrder: () => undefined,
      onJumpToLatest: () => undefined,
    })
  );
}

describe('ConversationHistoryNavigator markup (v0.3.13-plan-1 mini-map)', () => {
  it('renders a labelled landmark with a single slider and zero buttons', () => {
    const html = renderRail();
    expect(html).toContain('aria-label="会话历史定位"');
    expect((html.match(/role="slider"/gu) ?? []).length).toBe(1);
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('<button');
    expect(html).toContain('tabindex="0"');
  });

  it('emits dense decorative ticks with three length tiers', () => {
    const html = renderRail({ count: 40 });
    expect(html).toContain('class="history-ticks" aria-hidden="true"');
    expect((html.match(/history-tick-s/gu) ?? []).length).toBeGreaterThan(0);
    expect((html.match(/history-tick-m/gu) ?? []).length).toBeGreaterThan(0);
    expect((html.match(/history-tick-l/gu) ?? []).length).toBeGreaterThan(0);
  });

  it('has NO tooltip, cap, dot or marker chrome anywhere', () => {
    const html = renderRail({
      activeOrder: 10,
      span: { firstOrder: 2, lastOrder: 12 },
      hasEarlierHistory: true,
    });
    for (const forbidden of [
      'history-tooltip',
      'history-earlier-cap',
      'history-active-dot',
      'history-viewport-marker',
    ]) {
      expect(html).not.toContain(forbidden);
    }
    // The hover preview card is interaction-only; static markup never has it.
    expect(html).not.toContain('history-preview-card');
  });

  it('lights the viewport range and marks error ticks', () => {
    const html = renderRail({ span: { firstOrder: 2, lastOrder: 12 } });
    expect(html).toContain('is-viewport');
    expect(html).toContain('is-error');
  });

  it('announces position and the older-history footnote via aria-valuetext', () => {
    const html = renderRail({ hasEarlierHistory: true, activeOrder: 8 });
    expect(html).toContain('aria-valuetext=');
    expect(html).toContain('关键节点');
    expect(html).toContain('更早历史可在正文顶部加载');
  });

  it('shows the white live bar only while processing', () => {
    expect(renderRail({ processing: true })).toContain('history-live-bar');
    expect(renderRail({ processing: false })).not.toContain('history-live-bar');
  });

  it('renders nothing for an empty model', () => {
    expect(renderRail({ count: 0 })).toBe('');
  });

  it('compacts huge timelines to the tick density limit', () => {
    const html = renderRail({ count: 1000 });
    expect((html.match(/class="history-tick /gu) ?? []).length).toBeLessThanOrEqual(220);
    expect((html.match(/class="history-tick /gu) ?? []).length).toBeGreaterThan(180);
  });
});
