/**
 * v0.3.15 T4 — resource-panel copy + interaction SSR contracts.
 *
 * The workbench is server-rendered on first paint, so the copy-thinning pass
 * (plan §1.1) and the busy/confirm affordances (plan §1.2) are pinned at the
 * markup layer — no jsdom in this suite, following the v0.3.6 §4.1 pattern.
 * Keyboard semantics of the unified confirm modal (Esc cancels, Enter on the
 * focused cancel button closes) come from the native <dialog> element and are
 * exercised by the browser E2E layer.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FilesPanel } from '../web/src/components/files/FilesPanel';
import { GitPanel } from '../web/src/components/git/GitPanel';
import { ReviewPanel } from '../web/src/components/review/ReviewPanel';
import { ProjectNavigator } from '../web/src/components/projects/ProjectNavigator';
import { AgentPanel } from '../web/src/components/Inspector';
import { ConfirmDialog } from '../web/src/components/Dialogs';
import { initialWorkbenchState, type WorkbenchState } from '../web/src/types';
import type { WorkbenchActions } from '../web/src/useWorkbench';
import type { GoalView } from '../web/src/types';

const noop = () => undefined;
const actions = {} as WorkbenchActions;

function renderFiles(): string {
  return renderToStaticMarkup(
    React.createElement(FilesPanel, {
      workspaceId: 'workspace-test',
      refreshEpoch: 0,
      actions,
      navigatorWidthPx: 300,
      onNavigatorWidthCommit: noop,
    })
  );
}

function renderGit(): string {
  return renderToStaticMarkup(
    React.createElement(GitPanel, {
      workspaceId: 'workspace-test',
      refreshEpoch: 0,
      actions,
      onSendToComposer: noop,
      navigatorWidthPx: 300,
      onNavigatorWidthCommit: noop,
    })
  );
}

function renderReview(): string {
  return renderToStaticMarkup(
    React.createElement(ReviewPanel, {
      workspaceId: 'workspace-test',
      refreshEpoch: 0,
      actions,
      onSendToComposer: noop,
      navigatorWidthPx: 300,
      onNavigatorWidthCommit: noop,
    })
  );
}

function renderNavigator(state: WorkbenchState = initialWorkbenchState): string {
  return renderToStaticMarkup(
    React.createElement(ProjectNavigator, {
      state,
      drawerOpen: false,
      dockVisible: true,
      collapsed: false,
      resizable: true,
      width: 300,
      onCloseDrawer: noop,
      onExpand: noop,
      onCollapse: noop,
      onOpenWorkspaceDialog: noop,
      onOpenSettings: noop,
      onLoadMoreWorkspaces: noop,
      onCreateSession: noop,
      onLoadWorkspaceSessions: noop,
      onActivateContext: noop,
      onSetPinned: noop,
      onRemoveWorkspace: noop,
      onRefreshSummary: noop,
      onRenameSession: noop,
      onSessionTags: noop,
      onArchiveSession: noop,
      onDeleteSession: noop,
      onRestoreSession: noop,
      onWidthPreview: noop,
      onWidthCommit: noop,
    })
  );
}

function renderAgentPanel(state: WorkbenchState, tab: 'goal' | 'diagnostics'): string {
  return renderToStaticMarkup(
    React.createElement(AgentPanel, {
      state,
      actions,
      tab,
      onTabChange: noop,
    })
  );
}

describe('v0.3.15 T4 — thinned copy never returns to first paint', () => {
  it('FilesPanel: search scope is a title, not a hint paragraph', () => {
    const html = renderFiles();
    expect(html).toContain('title="搜索仅覆盖已加载的目录和文件"');
    expect(html).not.toContain('<p>搜索仅覆盖已加载的目录和文件。</p>');
  });

  it('FilesPanel: binary empty state keeps only icon + label', () => {
    const html = renderFiles();
    expect(html).not.toContain('<p>出于安全和性能考虑，只显示元数据。</p>');
  });

  it('FilesPanel: the selection empty state compresses to one short line', () => {
    const html = renderFiles();
    expect(html).toContain('选择文件预览');
    expect(html).toContain('>受限内容不会返回浏览器。</p>');
    expect(html).toContain('title="敏感文件、工作区外链接和二进制正文不会返回浏览器。"');
    expect(html).not.toContain('<p>敏感文件、工作区外链接和二进制正文不会返回浏览器。</p>');
  });

  it('GitPanel: the diff empty state no longer leaks the read-model detail', () => {
    const html = renderGit();
    expect(html).not.toContain('Diff 来自受限 Git read model');
    expect(html).not.toContain('Git 面板保持只读空状态');
  });

  it('ReviewPanel: the old hunk hint never reaches first paint (empty state is post-data)', () => {
    // ReviewPanel first-paints its loading state; the diff empty state (and
    // its compressed hint) render only once a snapshot exists, in the browser.
    const html = renderReview();
    expect(html).toContain('正在建立审阅快照');
    expect(html).not.toContain('你可以把某个 Hunk 作为草稿送回对话，提交前仍由你确认。');
  });

  it('ProjectNavigator: the pagination scope note is no longer a status paragraph', () => {
    const html = renderNavigator();
    expect(html).not.toContain('class="project-search-scope"');
    expect(html).not.toContain('<p>搜索仅覆盖已加载的项目和会话');
  });

  it('Inspector diagnostics: the security claim compresses to one short line', () => {
    const html = renderAgentPanel(initialWorkbenchState, 'diagnostics');
    expect(html).toContain('>诊断载荷由 Host 脱敏。</p>');
    expect(html).toContain('title="API Key、认证 Header 和环境值不会返回浏览器。"');
    expect(html).not.toContain('<p>诊断载荷由 Host 脱敏。API Key、认证 Header 和环境值不会返回浏览器。</p>');
  });
});

describe('v0.3.15 T4 — busy affordances without layout shift', () => {
  it('refresh buttons are idle (never aria-busy) on first paint', () => {
    for (const html of [renderFiles(), renderGit(), renderReview()]) {
      expect(html).not.toContain('aria-busy="true"');
    }
  });

  it('the files refresh control keeps its accessible name', () => {
    expect(renderFiles()).toContain('aria-label="刷新文件树"');
  });
});

describe('v0.3.15 T4 — unified confirm modal (Dialogs reuse)', () => {
  it('renders title, body, a focused cancel and the confirm action', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConfirmDialog, {
        open: true,
        onClose: noop,
        title: '放弃未保存的修改？',
        body: '当前草稿尚未保存，放弃后将回到文件的最新内容。',
        confirmLabel: '放弃修改',
        danger: true,
        onConfirm: noop,
      })
    );
    expect(html).toContain('放弃未保存的修改？');
    expect(html).toContain('当前草稿尚未保存，放弃后将回到文件的最新内容。');
    // Focus starts on 取消 so Enter can never confirm a destructive action.
    expect(html).toContain('autofocus');
    expect(html).toContain('>取消</button>');
    expect(html).toContain('danger-button');
    expect(html).toContain('放弃修改');
    // No window.confirm anywhere in the tree.
    expect(html).not.toContain('window.confirm');
  });

  it('renders the dialog shell closed until the client opens it', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConfirmDialog, {
        open: false,
        onClose: noop,
        title: '清除此 Goal？',
        body: 'Goal 的目标与进度会从当前会话移除，会话记录仍会保留。',
        confirmLabel: '清除 Goal',
        danger: true,
        onConfirm: noop,
      })
    );
    // The native <dialog> ships without the `open` attribute: the browser UA
    // stylesheet keeps it display:none (and out of the a11y tree) until
    // showModal() runs — static markup alone never shows it.
    expect(html).not.toContain('<dialog class="modal confirm-modal" open');
  });
});

describe('v0.3.15 T4 — goal clear goes through the modal, not window.confirm', () => {
  const goal: GoalView = {
    goalId: 'goal-1',
    revision: 3,
    objective: '发布 v0.3.15',
    status: 'active',
    tokensUsed: 1000,
    timeUsedMs: 60_000,
    continuationCount: 0,
    updatedAt: 0,
  };

  it('the goal panel keeps the 清除 control and mounts the modal shell', () => {
    const state: WorkbenchState = { ...initialWorkbenchState, goal };
    const html = renderAgentPanel(state, 'goal');
    expect(html).toContain('>清除</button>');
    expect(html).toContain('confirm-modal');
    expect(html).toContain('清除此 Goal？');
    // The modal ships closed; no window.confirm in the markup.
    expect(html).not.toContain('<dialog class="modal confirm-modal" open');
  });
});

describe('v0.3.15 T4 — icon tier stays inside 12/16/20 in resource panels', () => {
  it('files/git/review panel chrome renders 16px icons', () => {
    expect(renderFiles()).toContain('width="16" height="16"');
    expect(renderNavigator()).not.toContain('width="17"');
  });
});
