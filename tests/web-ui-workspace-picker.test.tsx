/**
 * v0.3.16 — LOCAL WORKSPACE picker: state machine invariants and the
 * confirmation card contract.
 *
 * The reducer is pure and the card is rendered with `renderToStaticMarkup`, so
 * both run without jsdom — matching the project's component-contract style.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { WorkspaceConfirmCard } from '../web/src/components/workspace/WorkspaceConfirmCard';
import type { WorkspaceOpenStageLabelV1 } from '../web/src/components/workspace/WorkspaceConfirmCard';
import {
  initialWorkspacePickerState,
  workspacePickerBusy,
  workspacePickerReducer,
} from '../web/src/components/workspace/workspace-picker-state';
import type { WebWorkspaceCandidateV1 } from '../web/src/types';

function candidate(overrides: Partial<WebWorkspaceCandidateV1> = {}): WebWorkspaceCandidateV1 {
  return {
    canonicalPath: '/tmp/project',
    label: 'project',
    availability: 'available',
    kind: 'git',
    source: 'picker',
    ...overrides,
  };
}

describe('workspacePickerReducer', () => {
  it('walks picker → inspect → confirm → activate', () => {
    let state = workspacePickerReducer(initialWorkspacePickerState, { type: 'picker-started' });
    expect(state.phase).toBe('picker-pending');
    state = workspacePickerReducer(state, { type: 'inspect-started', path: '/tmp/project' });
    expect(state.phase).toBe('inspect-pending');
    state = workspacePickerReducer(state, { type: 'inspect-succeeded', candidate: candidate() });
    expect(state.phase).toBe('confirm');
    state = workspacePickerReducer(state, { type: 'activate-started' });
    expect(state.phase).toBe('activate-pending');
  });

  it('refuses to activate without a confirmed candidate', () => {
    const inspecting = workspacePickerReducer(
      { ...initialWorkspacePickerState, phase: 'inspect-pending', pendingPath: '/tmp/project' },
      { type: 'activate-started' }
    );
    expect(inspecting.phase).toBe('inspect-pending');
    expect(workspacePickerReducer(initialWorkspacePickerState, { type: 'activate-started' }).phase).toBe(
      'browse'
    );
  });

  it('treats cancellation as a normal return to browse, not an error', () => {
    const state = workspacePickerReducer(
      { ...initialWorkspacePickerState, phase: 'picker-pending' },
      { type: 'picker-cancelled' }
    );
    expect(state.phase).toBe('browse');
    expect(state.error).toBeNull();
    expect(state.pickerReturned).toBe(true);
  });

  it('reports an unavailable picker with a reason and returns to browse', () => {
    const state = workspacePickerReducer(
      { ...initialWorkspacePickerState, phase: 'picker-pending' },
      { type: 'picker-unavailable', reason: 'picker_unavailable' }
    );
    expect(state.phase).toBe('browse');
    expect(state.error).toBe('picker_unavailable');
  });

  it('keeps the confirm card visible when activation fails', () => {
    const state = workspacePickerReducer(
      { ...initialWorkspacePickerState, phase: 'activate-pending', candidate: candidate() },
      { type: 'failed', message: 'boom' }
    );
    expect(state.phase).toBe('confirm');
    expect(state.error).toBe('boom');
  });

  it('only reports busy for outstanding phases', () => {
    expect(workspacePickerBusy({ ...initialWorkspacePickerState, phase: 'browse' })).toBe(false);
    expect(workspacePickerBusy({ ...initialWorkspacePickerState, phase: 'confirm' })).toBe(false);
    expect(workspacePickerBusy({ ...initialWorkspacePickerState, phase: 'picker-pending' })).toBe(
      true
    );
    expect(workspacePickerBusy({ ...initialWorkspacePickerState, phase: 'inspect-pending' })).toBe(
      true
    );
  });
});

describe('WorkspaceConfirmCard', () => {
  const render = (
    c: WebWorkspaceCandidateV1,
    busy = false,
    error: string | null = null,
    stage?: WorkspaceOpenStageLabelV1
  ) =>
    renderToStaticMarkup(
      React.createElement(WorkspaceConfirmCard, {
        candidate: c,
        busy,
        error,
        ...(stage ? { stage } : {}),
        onCancel: () => undefined,
        onOpen: () => undefined,
      })
    );

  it('shows the canonical path, kind and availability', () => {
    const html = render(candidate());
    expect(html).toContain('已选择本地项目');
    expect(html).toContain('/tmp/project');
    expect(html).toContain('Git 项目');
    expect(html).toContain('可用');
    expect(html).toContain('打开项目');
  });

  it('labels a plain folder without a Git badge', () => {
    const html = render(candidate({ kind: 'folder' }));
    expect(html).toContain('本地文件夹');
    expect(html).not.toContain('Git 项目');
  });

  it('blocks opening an unavailable candidate', () => {
    const html = render(candidate({ availability: 'missing' }));
    expect(html).toContain('目录不存在');
    expect(html).toContain('不可打开');
    expect(html).toContain('disabled=""');
  });

  it('marks the already-active candidate instead of offering to reopen it', () => {
    const html = render(candidate({ isActive: true }));
    expect(html).toContain('当前项目');
    expect(html).toContain('disabled=""');
  });

  it('shows discrete stages while opening instead of one vague label', () => {
    const html = render(candidate(), true, null, 'runtime');
    expect(html).toContain('aria-label="打开进度"');
    expect(html).toContain('准备项目');
    expect(html).toContain('加载本地 Runtime');
    expect(html).toContain('恢复会话（如有）');
    // Only the stage the Host actually reports is marked as current.
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('data-state="current"');
  });

  it('hides the stage list until the user confirms', () => {
    expect(render(candidate())).not.toContain('打开进度');
  });

  it('reports a deferred session count without blocking the card', () => {
    const html = render(candidate({ sessionCount: undefined, sessionCountStatus: 'deferred' }));
    expect(html).toContain('会话数读取中');
    // The confirmation button must stay available while the count is pending.
    expect(html).toContain('打开项目');
  });

  it('reports an activation failure once via role=alert', () => {
    const html = render(candidate(), false, '工作区切换失败。');
    expect(html).toContain('role="alert"');
    expect(html).toContain('工作区切换失败。');
  });
});
