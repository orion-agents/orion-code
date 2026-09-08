/**
 * v0.3.14 — ReviewPanel render contract (SSR markup, no jsdom in this suite)
 * and the localised summary copy.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ReviewPanel, reviewSummary } from '../web/src/components/review/ReviewPanel';
import type { WorkbenchActions } from '../web/src/useWorkbench';

function renderReview(): string {
  const actions = {} as WorkbenchActions;
  return renderToStaticMarkup(
    React.createElement(ReviewPanel, {
      workspaceId: 'workspace-test',
      refreshEpoch: 0,
      actions,
      onSendToComposer: () => undefined,
      navigatorWidthPx: 300,
      onNavigatorWidthCommit: () => undefined,
    })
  );
}

describe('ReviewPanel markup (v0.3.14)', () => {
  it('renders the loading state until a snapshot exists', () => {
    const html = renderReview();
    expect(html).toContain('正在建立审阅快照');
    expect(html).not.toContain('验证证据');
  });
});

describe('reviewSummary (v0.3.14)', () => {
  const base = {
    clean: false,
    totalChangedFiles: 4,
    stagedCount: 1,
    unstagedCount: 2,
    untrackedCount: 1,
    conflictCount: 0,
    truncated: false,
  };

  it('localises the counters and the headline', () => {
    const summary = reviewSummary(base);
    expect(summary.headline).toBe('4 个变更文件');
    expect(summary.counters).toBe('1 已暂存 · 2 未暂存 · 1 未跟踪 · 0 冲突');
  });

  it('reports a clean tree without a file count', () => {
    expect(reviewSummary({ ...base, clean: true, totalChangedFiles: 0 }).headline).toBe(
      '没有待审阅变更'
    );
  });

  it('prefixes the counters when the change list is truncated', () => {
    expect(reviewSummary({ ...base, truncated: true }).counters).toContain('当前显示 · ');
  });
});
