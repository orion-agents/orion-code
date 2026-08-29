import {
  Fragment,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

import type { WebSessionSummaryV1, WebWorkspaceSummaryV1, WorkbenchState } from '../../types';
import { Icon } from '../Icon';

const PROJECT_WINDOW_SIZE = 40;

export interface ProjectNavigatorProps {
  readonly state: WorkbenchState;
  readonly drawerOpen: boolean;
  readonly dockVisible: boolean;
  readonly onCloseDrawer: () => void;
  readonly onOpenWorkspaceDialog: () => void;
  readonly onLoadMoreWorkspaces: () => void;
  readonly onCreateSession: () => void;
  readonly onLoadWorkspaceSessions: (workspaceId: string, append?: boolean) => void;
  readonly onActivateContext: (workspaceId: string, sessionId: string | null) => void;
  readonly onSetPinned: (workspaceId: string, pinned: boolean) => void;
  readonly onRemoveWorkspace: (workspaceId: string) => void;
  readonly onRefreshSummary: (workspaceId: string) => void;
  readonly onRenameSession: (session: WebSessionSummaryV1) => void;
}

export function ProjectNavigator({
  state,
  drawerOpen,
  dockVisible,
  onCloseDrawer,
  onOpenWorkspaceDialog,
  onLoadMoreWorkspaces,
  onCreateSession,
  onLoadWorkspaceSessions,
  onActivateContext,
  onSetPinned,
  onRemoveWorkspace,
  onRefreshSummary,
  onRenameSession,
}: ProjectNavigatorProps) {
  const [query, setQuery] = useState('');
  const [projectWindowStart, setProjectWindowStart] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    new Set(state.workspaceId ? [state.workspaceId] : [])
  );
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const closeRef = useRef<HTMLButtonElement>(null);
  const transitionLocked = Boolean(state.pendingAction) || state.processing;

  useEffect(() => {
    if (drawerOpen) closeRef.current?.focus();
  }, [drawerOpen]);

  useEffect(() => {
    if (!state.workspaceId) return;
    setExpanded(current => new Set([...current, state.workspaceId]));
  }, [state.workspaceId]);

  useEffect(() => setProjectWindowStart(0), [deferredQuery]);

  const projects = useMemo(() => {
    const sorted = [...state.workspaces].sort(compareProjects);
    if (!deferredQuery) return sorted;
    return sorted.filter(project => {
      if (projectMatchesQuery(project, deferredQuery)) return true;
      return (state.workspaceSessions[project.id]?.items ?? []).some(session =>
        [session.name, session.taskSummary, session.id]
          .filter((value): value is string => Boolean(value))
          .some(value => value.toLocaleLowerCase().includes(deferredQuery))
      );
    });
  }, [deferredQuery, state.workspaceSessions, state.workspaces]);

  useEffect(() => {
    const activeIndex = projects.findIndex(project => project.id === state.workspaceId);
    if (activeIndex < 0) return;
    setProjectWindowStart(current =>
      activeIndex < current || activeIndex >= current + PROJECT_WINDOW_SIZE
        ? Math.floor(activeIndex / PROJECT_WINDOW_SIZE) * PROJECT_WINDOW_SIZE
        : current
    );
  }, [projects, state.workspaceId]);

  const windowedProjects = projects.slice(
    projectWindowStart,
    projectWindowStart + PROJECT_WINDOW_SIZE
  );
  const searchMayBeIncomplete = Boolean(
    deferredQuery &&
    (state.workspaceNextCursor ||
      Object.values(state.workspaceSessions).some(session => Boolean(session.nextCursor)))
  );

  const toggleProject = (project: WebWorkspaceSummaryV1) => {
    const next = new Set(expanded);
    if (next.has(project.id)) next.delete(project.id);
    else {
      next.add(project.id);
      if (!state.workspaceSessions[project.id]) onLoadWorkspaceSessions(project.id);
      else onRefreshSummary(project.id);
    }
    setExpanded(next);
  };

  return (
    <aside
      id="workspace-rail"
      className={`workspace-rail project-navigator ${drawerOpen ? 'drawer-open' : ''}`}
      aria-label="项目与会话"
      hidden={!dockVisible}
    >
      <div className="brand-row">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="brand-copy">
          <strong>ORION</strong>
          <span>CODE WORKBENCH</span>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="icon-button drawer-close"
          aria-label="关闭项目导航"
          onClick={onCloseDrawer}
        >
          <Icon name="close" />
        </button>
      </div>

      <div className="project-toolbar">
        <div>
          <span className="eyebrow">LOCAL PROJECTS</span>
          <h2>项目</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="选择其他工作区"
          title="打开其他项目"
          onClick={onOpenWorkspaceDialog}
          disabled={transitionLocked}
        >
          <Icon name="add" />
        </button>
      </div>

      <label className="project-search">
        <span className="sr-only">搜索项目和会话</span>
        <Icon name="search" size={15} />
        <input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="搜索项目和会话"
        />
        {query ? (
          <button type="button" aria-label="清除搜索" onClick={() => setQuery('')}>
            <Icon name="close" size={13} />
          </button>
        ) : null}
      </label>

      {searchMayBeIncomplete ? (
        <p className="project-search-scope" role="status">
          搜索仅覆盖已加载的项目和会话；仍有分页内容未加载。
        </p>
      ) : null}

      <nav className="project-tree" aria-label="已知项目">
        {windowedProjects.map((project, index) => {
          const projectIndex = projectWindowStart + index;
          const previous = projects[projectIndex - 1];
          const open = expanded.has(project.id) || Boolean(deferredQuery);
          const sessionState = state.workspaceSessions[project.id];
          const projectSummary = state.workspaceProjectSummaries[project.id];
          const sessions = projectMatchesQuery(project, deferredQuery)
            ? (sessionState?.items ?? [])
            : filterSessions(sessionState?.items ?? [], deferredQuery);
          return (
            <Fragment key={project.id}>
              {projectIndex === 0 ||
              (previous?.pinnedOrder !== undefined && project.pinnedOrder === undefined) ? (
                <h3 className="project-group-heading" role="presentation">
                  {project.pinnedOrder === undefined ? 'RECENT' : 'PINNED'}
                </h3>
              ) : null}
              <section
                className={`project-node ${project.active ? 'active' : ''} ${!project.available ? 'unavailable' : ''}`}
              >
                <div className="project-row">
                  <button
                    id={`project-${project.id}`}
                    type="button"
                    className="project-toggle"
                    aria-expanded={open}
                    aria-controls={`project-${project.id}-sessions`}
                    aria-current={project.active ? 'page' : undefined}
                    onClick={() => toggleProject(project)}
                    onKeyDown={event => {
                      if (event.key === 'ArrowRight') {
                        event.preventDefault();
                        if (!open) toggleProject(project);
                        else
                          event.currentTarget
                            .closest('.project-node')
                            ?.querySelector<HTMLButtonElement>('.project-session-main')
                            ?.focus();
                        return;
                      }
                      if (event.key === 'ArrowLeft' && open) {
                        event.preventDefault();
                        toggleProject(project);
                        return;
                      }
                      moveTreeFocus(event);
                    }}
                  >
                    <Icon name="chevron" size={13} />
                    <span className="workspace-icon">
                      <Icon name="workspace" size={15} />
                    </span>
                    <span className="project-copy">
                      <strong>{project.label}</strong>
                      <span title={project.path}>
                        {projectSummary
                          ? `${projectSummary.detached ? projectSummary.head || 'detached' : projectSummary.branch || 'Git'} · ${projectSummary.dirtyCount ? `M${projectSummary.dirtyCount}` : 'clean'}`
                          : compactPath(project.path)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-button project-pin"
                    aria-label={`${project.pinnedOrder === undefined ? '置顶' : '取消置顶'}项目 ${project.label}`}
                    aria-pressed={project.pinnedOrder !== undefined}
                    onClick={() => onSetPinned(project.id, project.pinnedOrder === undefined)}
                    disabled={transitionLocked}
                  >
                    <span aria-hidden="true">{project.pinnedOrder === undefined ? '○' : '●'}</span>
                  </button>
                  {!project.available && !project.active ? (
                    <button
                      type="button"
                      className="icon-button project-remove"
                      aria-label={`移除不可用项目 ${project.label}`}
                      onClick={() => onRemoveWorkspace(project.id)}
                      disabled={transitionLocked}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="icon-button project-add-session"
                      aria-label={`在 ${project.label} 新建会话`}
                      disabled={transitionLocked || !project.available || !project.active}
                      onClick={onCreateSession}
                      title={project.active ? '新建会话' : '先激活项目后新建会话'}
                    >
                      <Icon name="add" size={14} />
                    </button>
                  )}
                </div>

                {open ? (
                  <div
                    id={`project-${project.id}-sessions`}
                    className="project-sessions"
                    role="list"
                    aria-label={`${project.label} 的会话`}
                  >
                    {sessionState?.status === 'loading' && !sessionState.items.length ? (
                      <p className="project-loading" role="listitem">
                        正在加载会话…
                      </p>
                    ) : null}
                    {sessionState?.status === 'error' ? (
                      <div role="listitem">
                        <button
                          type="button"
                          className="project-load-error"
                          onClick={() => onLoadWorkspaceSessions(project.id)}
                        >
                          加载失败，重试
                        </button>
                      </div>
                    ) : null}
                    {sessions.map(session => {
                      const active = project.active && session.id === state.activeSessionId;
                      const activeStatuses = active
                        ? [
                            ...(state.processing ? ['运行中'] : []),
                            ...(state.permission ? ['等待审批'] : []),
                          ]
                        : [];
                      return (
                        <div
                          key={session.id}
                          className={`project-session-row ${active ? 'active' : ''}`}
                          role="listitem"
                        >
                          <button
                            type="button"
                            className="project-session-main"
                            aria-current={active ? 'page' : undefined}
                            aria-disabled={active || transitionLocked || !project.available}
                            onClick={() => {
                              if (!active) onActivateContext(project.id, session.id);
                            }}
                            disabled={transitionLocked || !project.available}
                            onKeyDown={event => {
                              if (event.key === 'ArrowLeft') {
                                event.preventDefault();
                                document.getElementById(`project-${project.id}`)?.focus();
                                return;
                              }
                              moveTreeFocus(event);
                            }}
                          >
                            <span
                              className={`session-state ${active && state.permission ? 'approval' : active && state.processing ? 'running' : active ? 'ready' : ''}`}
                              aria-hidden="true"
                            />
                            <span>
                              <strong>{sessionTitle(session)}</strong>
                              <small>
                                {relativeTime(session.updatedAt)} · {session.messageCount} 条
                              </small>
                              {activeStatuses.length ? (
                                <small className="project-session-status">
                                  {activeStatuses.join(' · ')}
                                </small>
                              ) : null}
                            </span>
                          </button>
                          {project.active ? (
                            <button
                              type="button"
                              className="icon-button session-rename"
                              aria-label={`重命名会话 ${sessionTitle(session)}`}
                              onClick={() => onRenameSession(session)}
                              disabled={transitionLocked}
                            >
                              <Icon name="edit" size={13} />
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                    {sessionState?.status === 'ready' && !sessions.length ? (
                      <div role="listitem">
                        <button
                          type="button"
                          className="project-empty-session"
                          disabled={transitionLocked || !project.available}
                          onClick={() => onActivateContext(project.id, null)}
                        >
                          {deferredQuery ? '没有匹配会话' : '打开项目'}
                        </button>
                      </div>
                    ) : null}
                    {sessionState?.nextCursor ? (
                      <div role="listitem">
                        <button
                          type="button"
                          className="text-button project-load-more"
                          onClick={() => onLoadWorkspaceSessions(project.id, true)}
                        >
                          加载更多会话
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>
            </Fragment>
          );
        })}
        {!projects.length ? (
          <div className="empty-rail">
            <Icon name="search" />
            <p>没有匹配的项目或会话</p>
          </div>
        ) : null}
        {projectWindowStart > 0 ? (
          <button
            type="button"
            className="text-button project-window-more"
            onClick={() => setProjectWindowStart(start => Math.max(0, start - PROJECT_WINDOW_SIZE))}
          >
            上一批项目
          </button>
        ) : null}
        {projectWindowStart + PROJECT_WINDOW_SIZE < projects.length ? (
          <button
            type="button"
            className="text-button project-window-more"
            onClick={() => setProjectWindowStart(start => start + PROJECT_WINDOW_SIZE)}
          >
            下一批项目
          </button>
        ) : state.workspaceNextCursor ? (
          <button
            type="button"
            className="text-button project-window-more"
            onClick={onLoadMoreWorkspaces}
          >
            加载更多项目
          </button>
        ) : null}
      </nav>

      <footer className="rail-footer">
        <span className={`connection-dot ${state.connection}`} aria-hidden="true" />
        <span>{connectionLabel(state.connection)}</span>
        <span className="version">v{state.bootstrap?.productVersion ?? '0.3.1'}</span>
      </footer>
    </aside>
  );
}

function moveTreeFocus(event: KeyboardEvent<HTMLButtonElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const tree = event.currentTarget.closest('.project-tree');
  if (!tree) return;
  const items = Array.from(
    tree.querySelectorAll<HTMLButtonElement>(
      '.project-toggle:not(:disabled), .project-session-main:not(:disabled)'
    )
  ).filter(item => item.getClientRects().length > 0);
  const current = items.indexOf(event.currentTarget);
  if (current < 0 || items.length === 0) return;
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : Math.max(0, Math.min(items.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
  event.preventDefault();
  items[next]?.focus();
}

function compareProjects(left: WebWorkspaceSummaryV1, right: WebWorkspaceSummaryV1): number {
  if (left.pinnedOrder !== undefined || right.pinnedOrder !== undefined) {
    if (left.pinnedOrder === undefined) return 1;
    if (right.pinnedOrder === undefined) return -1;
    return left.pinnedOrder - right.pinnedOrder;
  }
  return Date.parse(right.lastActivatedAt) - Date.parse(left.lastActivatedAt);
}

function projectMatchesQuery(project: WebWorkspaceSummaryV1, query: string): boolean {
  return Boolean(
    query &&
    (project.label.toLocaleLowerCase().includes(query) ||
      project.path.toLocaleLowerCase().includes(query))
  );
}

function filterSessions(
  sessions: readonly WebSessionSummaryV1[],
  query: string
): readonly WebSessionSummaryV1[] {
  if (!query) return sessions;
  return sessions.filter(session =>
    [session.name, session.taskSummary, session.id, session.model]
      .filter((value): value is string => Boolean(value))
      .some(value => value.toLocaleLowerCase().includes(query))
  );
}

export function sessionTitle(session: WebSessionSummaryV1): string {
  return session.name || session.taskSummary || `会话 ${session.id.slice(0, 8)}`;
}

export function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized;
}

function compactPath(path: string): string {
  if (path.length <= 31) return path;
  return `…${path.slice(-30)}`;
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '未知';
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days} 天前` : new Date(timestamp).toLocaleDateString('zh-CN');
}

function connectionLabel(connection: WorkbenchState['connection']): string {
  if (connection === 'live') return '本地 Runtime 已连接';
  if (connection === 'offline') return '离线';
  if (connection === 'replay-required') return '需要恢复';
  if (connection === 'closed') return 'Host 已关闭';
  return connection === 'connecting' ? '正在连接' : '正在重连';
}
