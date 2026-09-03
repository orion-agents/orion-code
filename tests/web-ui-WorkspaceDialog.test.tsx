/**
 * v0.3.7 — WorkspaceDialog (打开或新增项目) rendering contract: suggested list,
 * collapsible 其他工作区, state pills and the path form.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { WorkspaceDialog } from '../web/src/components/Dialogs';
import { initialWorkbenchState, type WebWorkspaceSummaryV1, type WorkbenchState } from '../web/src/types';

function workspace(id: string, overrides: Partial<WebWorkspaceSummaryV1> = {}): WebWorkspaceSummaryV1 {
  return {
    id,
    path: `/tmp/${id}`,
    label: `项目 ${id}`,
    active: false,
    available: true,
    sessionCount: 0,
    lastActivatedAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

function dialogState(overrides: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    ...initialWorkbenchState,
    workspace: '/tmp/w1',
    workspaces: [
      workspace('w1', { path: '/tmp/w1', active: true }),
      workspace('w2'),
      workspace('w3'),
      workspace('w4'),
    ],
    ...overrides,
  };
}

function render(overrides: Partial<WorkbenchState> = {}) {
  return renderToStaticMarkup(
    React.createElement(WorkspaceDialog, {
      open: true,
      onClose: () => undefined,
      state: dialogState(overrides),
      onSelect: async () => undefined,
      onLoadMore: async () => undefined,
    })
  );
}

describe('WorkspaceDialog', () => {
  it('opens under the 打开或新增项目 framing with its description', () => {
    const html = render();
    expect(html).toContain('打开或新增项目');
    expect(html).toContain('选择一个本地目录作为项目');
  });

  it('shows the first three workspaces as suggestions and folds the rest', () => {
    const html = render();
    expect(html).toContain('aria-label="常用工作区"');
    expect(html).toContain('项目 w1');
    expect(html).toContain('项目 w3');
    expect(html).toContain('其他工作区（1）');
    // The fourth entry stays collapsed until the toggle is expanded.
    expect(html).not.toContain('项目 w4');
    expect(html).toContain('aria-expanded="false"');
  });

  it('labels the current and unavailable workspaces explicitly', () => {
    const html = render({
      workspaces: [
        workspace('w1', { path: '/tmp/w1', active: true }),
        workspace('gone', { available: false }),
        workspace('w3'),
      ],
    });
    expect(html).toContain('当前');
    expect(html).toContain('不可用');
  });

  it('renders the path form with the submit disabled until input exists', () => {
    const html = render();
    expect(html).toContain('打开其他本地目录');
    expect(html).toContain('placeholder="/Users/name/project"');
    // Empty input -> disabled 打开 button.
    expect(html).toContain('disabled=""');
  });

  it('disables suggestion rows only while a mutation is pending', () => {
    const disabledRows = (html: string): number =>
      (html.match(/class="workspace-option[^"]*"\s+disabled=/g) ?? []).length;
    // Idle: only the active row is disabled (1); pending: every visible row is.
    expect(disabledRows(render())).toBe(1);
    expect(disabledRows(render({ pendingAction: 'switch' }))).toBe(3);
  });

  it('renders a load-more affordance when more workspaces exist', () => {
    const html = render({ workspaceNextCursor: 'next-page' });
    expect(html).toContain('加载更多工作区');
  });
});
