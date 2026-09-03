/**
 * ApprovalCard contract layer (v0.3.6 P0-A).
 *
 * The tool permission card is rendered from a permission request on the
 * WorkbenchState. These tests pin the ask text, the four decision actions and
 * the fallback reason so the approval UI cannot silently lose its affordances.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ApprovalCard } from '../web/src/components/Conversation';
import { initialWorkbenchState, type WorkbenchState } from '../web/src/types';
import type { WorkbenchActions } from '../web/src/useWorkbench';

const actions = {} as unknown as WorkbenchActions;

function withPermission(permission: {
  readonly id: string;
  readonly eventId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly reason?: string;
}): WorkbenchState {
  return {
    ...initialWorkbenchState,
    permission: { ...permission },
  } as unknown as WorkbenchState;
}

function renderAsk(permission: Parameters<typeof withPermission>[0]) {
  return renderToStaticMarkup(
    React.createElement(ApprovalCard, { state: withPermission(permission), actions })
  );
}

describe('ApprovalCard', () => {
  const base = {
    id: 'perm-1',
    eventId: 'event-1',
    name: 'read_file',
    args: { path: '/tmp/a.txt' },
    reason: '读取项目文件以回答问题。',
  };

  it('asks for the tool by name', () => {
    const html = renderAsk(base);
    expect(html).toContain('需要你的确认');
    expect(html).toContain('允许 read_file？');
  });

  it('renders the supplied reason verbatim', () => {
    const html = renderAsk(base);
    expect(html).toContain('读取项目文件以回答问题。');
  });

  it('falls back to a neutral sentence when no reason is given', () => {
    const html = renderAsk({ ...base, reason: undefined });
    expect(html).toContain('该工具需要在当前权限策略下获得明确授权。');
  });

  it('renders all four decision actions', () => {
    const html = renderAsk(base);
    expect(html).toContain('拒绝');
    expect(html).toContain('仅本次');
    expect(html).toContain('允许此项目');
    expect(html).toContain('始终允许');
  });

  it('keeps the project/global grant footnote', () => {
    const html = renderAsk(base);
    expect(html).toContain('项目与全局授权会写入 Orion 配置；拒绝不会丢失当前会话。');
  });

  it('exposes the card as an assertive live region', () => {
    const html = renderAsk(base);
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('aria-labelledby="approval-title"');
    expect(html).toContain('aria-describedby="approval-reason"');
  });

  it('disables decisions while the snapshot is not ready', () => {
    // initialWorkbenchState has no active session -> decisions are disabled.
    const html = renderAsk(base);
    expect(html).toContain('disabled=""');
  });

  it('renders the sanitised arguments inside the collapsible detail', () => {
    const html = renderAsk(base);
    expect(html).toContain('查看脱敏参数');
    expect(html).toContain('path');
    expect(html).toContain('/tmp/a.txt');
  });

  it('renders the "always allow" primary action last', () => {
    const html = renderAsk(base);
    const lastButton = html.lastIndexOf('始终允许');
    const firstDanger = html.indexOf('拒绝');
    expect(lastButton).toBeGreaterThan(firstDanger);
  });
});
