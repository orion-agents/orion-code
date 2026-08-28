import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';

import type { WebSessionSummaryV1, WorkbenchState } from '../types';
import { Icon } from './Icon';

export interface WorkspaceRailProps {
  readonly state: WorkbenchState;
  readonly drawerOpen: boolean;
  readonly onCloseDrawer: () => void;
  readonly onOpenWorkspaceDialog: () => void;
  readonly onCreateSession: () => void;
  readonly onActivateSession: (sessionId: string) => void;
  readonly onRenameSession: (session: WebSessionSummaryV1) => void;
}

export function WorkspaceRail({
  state,
  drawerOpen,
  onCloseDrawer,
  onOpenWorkspaceDialog,
  onCreateSession,
  onActivateSession,
  onRenameSession,
}: WorkspaceRailProps) {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const closeRef = useRef<HTMLButtonElement>(null);
  const sessions = useMemo(
    () => filterSessions(state.sessions, deferredQuery),
    [deferredQuery, state.sessions]
  );
  const transitionLocked = Boolean(state.pendingAction) || state.processing;

  useEffect(() => {
    if (drawerOpen) closeRef.current?.focus();
  }, [drawerOpen]);

  return (
    <aside
      id="workspace-rail"
      className={`workspace-rail ${drawerOpen ? 'drawer-open' : ''}`}
      aria-label="工作区与会话"
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
          aria-label="关闭会话导航"
          onClick={onCloseDrawer}
        >
          <Icon name="close" />
        </button>
      </div>

      <section className="workspace-switcher" aria-labelledby="workspace-heading">
        <div className="section-label-row">
          <h2 id="workspace-heading">工作区</h2>
          <button
            type="button"
            className="icon-button subtle"
            aria-label="选择其他工作区"
            onClick={onOpenWorkspaceDialog}
            disabled={transitionLocked}
          >
            <Icon name="more" />
          </button>
        </div>
        <button
          type="button"
          className="workspace-current"
          onClick={onOpenWorkspaceDialog}
          disabled={transitionLocked}
          aria-describedby="workspace-path"
        >
          <span className="workspace-icon">
            <Icon name="workspace" size={17} />
          </span>
          <span className="workspace-copy">
            <strong>{basename(state.workspace) || '选择工作区'}</strong>
            <span id="workspace-path" title={state.workspace}>
              {compactPath(state.workspace)}
            </span>
          </span>
          <Icon name="chevron" size={15} />
        </button>
      </section>

      <section className="session-section" aria-labelledby="sessions-heading">
        <div className="section-label-row">
          <h2 id="sessions-heading">会话</h2>
          <button
            type="button"
            className="icon-button new-session"
            aria-label="新建会话"
            onClick={onCreateSession}
            disabled={transitionLocked}
          >
            <Icon name="add" />
          </button>
        </div>
        <div className="search-box" role="search">
          <label className="sr-only" htmlFor="session-search">
            搜索会话
          </label>
          <Icon name="search" size={15} />
          <input
            id="session-search"
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="搜索会话"
            aria-controls="session-list"
          />
          {query ? (
            <button type="button" aria-label="清除搜索" onClick={() => setQuery('')}>
              <Icon name="close" size={14} />
            </button>
          ) : null}
        </div>

        <div id="session-list" className="session-list" role="list" aria-label="当前工作区的会话">
          {sessions.map(session => {
            const active = session.id === state.activeSessionId;
            return (
              <div
                key={session.id}
                className={`session-row ${active ? 'active' : ''}`}
                role="listitem"
              >
                <button
                  type="button"
                  className="session-main"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onActivateSession(session.id)}
                  disabled={active || transitionLocked}
                >
                  <span
                    className={`session-state ${active && state.processing ? 'running' : active ? 'ready' : ''}`}
                    aria-hidden="true"
                  />
                  <span className="session-copy">
                    <strong>{sessionTitle(session)}</strong>
                    <span>
                      {relativeTime(session.updatedAt)} · {session.messageCount} 条
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-button session-rename"
                  aria-label={`重命名会话 ${sessionTitle(session)}`}
                  onClick={() => onRenameSession(session)}
                  disabled={transitionLocked}
                >
                  <Icon name="edit" size={14} />
                </button>
              </div>
            );
          })}
          {sessions.length === 0 ? (
            <div className="empty-rail">
              <Icon name={deferredQuery ? 'search' : 'terminal'} size={20} />
              <p>{deferredQuery ? '没有匹配的会话' : '还没有会话'}</p>
              {!deferredQuery ? (
                <button
                  type="button"
                  className="text-button"
                  onClick={onCreateSession}
                  disabled={transitionLocked}
                >
                  创建第一个会话
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <footer className="rail-footer">
        <span className={`connection-dot ${state.connection}`} aria-hidden="true" />
        <span>{connectionLabel(state.connection)}</span>
        <span className="version">v{state.bootstrap?.productVersion ?? '0.3.0'}</span>
      </footer>
    </aside>
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
  if (!path) return '尚未选择';
  if (path.length <= 36) return path;
  return `…${path.slice(-35)}`;
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '未知时间';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
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
