import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

import { Conversation } from './components/Conversation';
import {
  ConfirmDeleteSessionDialog,
  RenameDialog,
  SessionTagsDialog,
  WorkspaceDialog,
} from './components/Dialogs';
import { Icon } from './components/Icon';
import { SettingsDialog } from './components/SettingsDialog';
import { ShortcutHelpDialog } from './components/ShortcutHelpDialog';
import { ProjectNavigator } from './components/projects/ProjectNavigator';
import { WorkPanelDock } from './layout/WorkPanelDock';
import { requestId } from './api';
import { findShortcut, matchesShortcut } from './shortcuts';
import type { ThemePreference } from './settings/types';
import {
  computeWorkbenchColumns,
  loadWorkbenchLayoutPreference,
  saveWorkbenchLayoutPreference,
  type AgentPanelId,
  type WorkbenchLayoutPreferenceV2,
  type WorkPanelId,
} from './state/layout-preferences';
import { activeSessionSnapshotSync, type WebSessionSummaryV1, type WorkbenchNotice } from './types';
import { themeColorForAppearance } from './themes/theme-color';
import { useWorkbench } from './useWorkbench';

/** 通知堆叠上限：超出后丢弃最旧条目，避免遮挡整个工作区。 */
const NOTICE_STACK_LIMIT = 4;
/** 非关键通知自动消失时长（P1-C）。 */
const NOTICE_AUTO_DISMISS_MS = 5000;

export interface QueuedNotice {
  readonly uid: number;
  readonly notice: WorkbenchNotice;
}

/**
 * 自动消失策略：需用户恢复操作（重连/重试快照）或 error 级通知保持，
 * 其余（info / success / warning）5s 后自动消失。
 */
export function noticeAutoDismissDelayMs(
  notice: WorkbenchNotice,
  recoveryNeeded: boolean
): number | null {
  if (recoveryNeeded) return null;
  if (notice.tone === 'error') return null;
  return NOTICE_AUTO_DISMISS_MS;
}

interface NoticeCardProps {
  readonly uid: number;
  readonly notice: WorkbenchNotice;
  /** 连接层需要“重建连接”（connection === 'replay-required'）。 */
  readonly reconnectNeeded: boolean;
  /** 会话快照域需要“重试同步”（session-snapshot 且 sync failed）。 */
  readonly snapshotRetryNeeded: boolean;
  readonly pendingAction: boolean;
  readonly onDismiss: (uid: number) => void;
  readonly onRecover: (uid: number) => void;
}

function WorkbenchNoticeCard({
  uid,
  notice,
  reconnectNeeded,
  snapshotRetryNeeded,
  pendingAction,
  onDismiss,
  onRecover,
}: NoticeCardProps) {
  const recoveryNeeded = reconnectNeeded || snapshotRetryNeeded;
  const dismissable = !recoveryNeeded;
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  const delay = noticeAutoDismissDelayMs(notice, recoveryNeeded);
  useEffect(() => {
    if (delay === null) return undefined;
    const timer = window.setTimeout(() => dismissRef.current(uid), delay);
    return () => window.clearTimeout(timer);
  }, [delay, uid]);

  const titleId = `notice-${uid}`;
  const iconName =
    notice.tone === 'success' ? 'check' : notice.tone === 'info' ? 'info' : 'warning';
  return (
    <aside
      className={`workbench-notice notice-${notice.tone}`}
      role={notice.tone === 'error' ? 'alert' : 'status'}
      aria-labelledby={titleId}
    >
      <span className="notice-icon" aria-hidden="true">
        <Icon name={iconName} size={17} />
      </span>
      <div>
        <strong id={titleId}>{notice.title}</strong>
        {notice.detail ? <p>{notice.detail}</p> : null}
      </div>
      {reconnectNeeded ? (
        <button
          type="button"
          className="secondary-button"
          onClick={() => onRecover(uid)}
          disabled={pendingAction}
        >
          重建连接
        </button>
      ) : null}
      {snapshotRetryNeeded ? (
        <button
          type="button"
          className="secondary-button"
          onClick={() => onRecover(uid)}
          disabled={pendingAction}
        >
          重试同步
        </button>
      ) : null}
      {dismissable ? (
        <button
          type="button"
          className="icon-button"
          onClick={() => onDismiss(uid)}
          aria-label="关闭通知"
        >
          <Icon name="close" size={15} />
        </button>
      ) : null}
    </aside>
  );
}

export function App() {
  const { state, actions } = useWorkbench();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [layoutPreference, setLayoutPreference] = useState(loadWorkbenchLayoutPreference);
  const [panelOverlayOpen, setPanelOverlayOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<WebSessionSummaryV1 | null>(null);
  const [sessionTagsTarget, setSessionTagsTarget] = useState<WebSessionSummaryV1 | null>(null);
  const [sessionDeleteTarget, setSessionDeleteTarget] = useState<WebSessionSummaryV1 | null>(null);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [noticeQueue, setNoticeQueue] = useState<readonly QueuedNotice[]>([]);
  const noticeSeq = useRef(0);
  const storeNoticeRef = useRef(state.notice);
  const lastEnqueuedNoticeId = useRef<number | null>(null);
  const [composerInsertion, setComposerInsertion] = useState<{
    readonly id: number;
    readonly text: string;
  } | null>(null);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const settingsOpenedFromDrawer = useRef(false);
  const restoreProjectSettingsFocus = useRef(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const shellWidth = useElementWidth(shellRef);
  const columns = computeWorkbenchColumns(shellWidth, layoutPreference);
  const navigationOverlay = columns.projectNavigation.mode === 'drawer';
  const panelOverlay = columns.workPanel.mode === 'drawer';
  const panelDerivedRail = columns.workPanel.mode === 'rail' && layoutPreference.workPanel.expanded;
  const panelSurfaceOverlay = panelOverlay || (panelDerivedRail && panelOverlayOpen);
  const panelExpanded =
    panelOverlay || panelDerivedRail ? panelOverlayOpen : columns.workPanel.mode === 'dock';
  const panelModalOpen = panelSurfaceOverlay && panelOverlayOpen;
  const navigationModalOpen = navigationOverlay && navigationOpen;
  const drawersOpen = navigationModalOpen || panelModalOpen;
  const appearance =
    state.settings?.state === 'ready'
      ? state.settings
      : (state.settingsMirror.lastGood ?? state.settings);
  const theme = appearance?.sections.appearance.theme.effectiveValue;
  const motion = appearance?.sections.appearance.motion.effectiveValue;
  const uiStyle = appearance?.sections.appearance.style.effectiveValue ?? 'orion-blocksmith';
  const sessionSync = activeSessionSnapshotSync(state);

  const cycleTheme = useCallback(() => {
    if (!state.workspace) return;
    const revision = appearance?.revision;
    if (!revision) return;
    const current = appearance?.sections.appearance.theme.effectiveValue ?? 'system';
    const next: ThemePreference =
      current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system';
    actions
      .updateSettings(revision, [{ op: 'set', key: 'appearance.theme', value: next }], requestId())
      .catch(error => {
        console.warn('[theme] 主题切换写入失败', error);
      });
  }, [actions, appearance, state.workspace]);

  const updateProjectNavigationPreference = useCallback(
    (patch: Partial<WorkbenchLayoutPreferenceV2['projectNavigation']>) => {
      setLayoutPreference(current => {
        const next: WorkbenchLayoutPreferenceV2 = {
          ...current,
          projectNavigation: { ...current.projectNavigation, ...patch },
        };
        saveWorkbenchLayoutPreference(next);
        return next;
      });
    },
    []
  );

  const updatePanelPreference = useCallback(
    (patch: Partial<WorkbenchLayoutPreferenceV2['workPanel']>) => {
      setLayoutPreference(current => {
        const next: WorkbenchLayoutPreferenceV2 = {
          ...current,
          workPanel: { ...current.workPanel, ...patch },
        };
        saveWorkbenchLayoutPreference(next);
        return next;
      });
    },
    []
  );

  const rememberDrawerTrigger = useCallback(() => {
    drawerTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);

  const focusProjectSearch = useCallback(() => {
    requestAnimationFrame(() =>
      document.querySelector<HTMLInputElement>('.project-search input')?.focus()
    );
  }, []);

  const focusProjectSettingsEntry = useCallback(() => {
    requestAnimationFrame(() =>
      document.querySelector<HTMLButtonElement>('.workspace-rail [aria-label="打开设置"]')?.focus()
    );
  }, []);

  const focusProjectSettings = useCallback(() => {
    if (navigationOverlay) {
      rememberDrawerTrigger();
      setPanelOverlayOpen(false);
      setNavigationOpen(true);
    }
    focusProjectSettingsEntry();
  }, [focusProjectSettingsEntry, navigationOverlay, rememberDrawerTrigger]);

  const openSettingsFromProjectNavigation = useCallback(() => {
    settingsOpenedFromDrawer.current = navigationModalOpen;
    if (navigationModalOpen) {
      setNavigationOpen(false);
      setPanelOverlayOpen(false);
      drawerTrigger.current = null;
    }
    setSettingsOpen(true);
  }, [navigationModalOpen]);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    if (!settingsOpenedFromDrawer.current) return;
    settingsOpenedFromDrawer.current = false;
    restoreProjectSettingsFocus.current = true;
    setNavigationOpen(true);
  }, []);

  const closeDrawers = useCallback(() => {
    setNavigationOpen(false);
    setPanelOverlayOpen(false);
    restoreProjectSettingsFocus.current = false;
    const trigger = drawerTrigger.current;
    drawerTrigger.current = null;
    if (trigger) requestAnimationFrame(() => trigger.focus());
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme ?? 'system';
    document.documentElement.dataset.motion = motion ?? 'system';
    document.documentElement.dataset.uiStyle = uiStyle;
  }, [motion, theme, uiStyle]);

  // P1-C: 通知堆叠 —— 观察 store 单条 notice，按 id 去重入队。
  useEffect(() => {
    storeNoticeRef.current = state.notice;
    const current = state.notice;
    if (!current) return;
    if (lastEnqueuedNoticeId.current === current.id) return;
    lastEnqueuedNoticeId.current = current.id;
    setNoticeQueue(prev =>
      prev.some(entry => entry.notice.id === current.id)
        ? prev
        : [...prev, { uid: ++noticeSeq.current, notice: current }].slice(-NOTICE_STACK_LIMIT)
    );
  }, [state.notice]);

  // v0.3.7: eagerly load the archived listing once the foreground workspace
  // session list is ready, so the rail archive section opens without a hitch.
  useEffect(() => {
    const workspaceId = state.workspaceId;
    if (!workspaceId) return;
    const sessions = state.workspaceSessions[workspaceId];
    const archived = state.archivedSessions;
    if (sessions?.status !== 'ready') return;
    if (archived.ownerWorkspaceId === workspaceId && archived.status !== 'idle') return;
    void actions.loadArchivedWorkspaceSessions(workspaceId);
  }, [actions, state.archivedSessions, state.workspaceId, state.workspaceSessions]);

  const dismissQueuedNotice = useCallback(
    (uid: number) => {
      const entry = noticeQueue.find(item => item.uid === uid);
      if (!entry) return;
      if (storeNoticeRef.current?.id === entry.notice.id) void actions.dismissNotice();
      setNoticeQueue(prev => prev.filter(item => item.uid !== uid));
    },
    [actions, noticeQueue]
  );

  const recoverQueuedNotice = useCallback(
    (uid: number) => {
      const entry = noticeQueue.find(item => item.uid === uid);
      if (!entry) return;
      if (storeNoticeRef.current?.id === entry.notice.id) void actions.dismissNotice();
      setNoticeQueue(prev => prev.filter(item => item.uid !== uid));
      void actions.recoverSession();
    },
    [actions, noticeQueue]
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const update = () => {
      if (meta) meta.content = themeColorForAppearance(uiStyle, theme ?? 'system', media.matches);
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [theme, uiStyle]);

  useEffect(() => {
    setNavigationOpen(false);
    setPanelOverlayOpen(false);
    drawerTrigger.current = null;
    settingsOpenedFromDrawer.current = false;
    restoreProjectSettingsFocus.current = false;
  }, [state.activeSessionId, state.workspace]);

  useLayoutEffect(() => {
    setNavigationOpen(false);
    setPanelOverlayOpen(false);
    drawerTrigger.current = null;
    restoreProjectSettingsFocus.current = false;
  }, [columns.projectNavigation.mode, columns.workPanel.mode, navigationOverlay, panelOverlay]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      const toggleNavigation = findShortcut('toggle-project-navigation');
      if (toggleNavigation && matchesShortcut(event, toggleNavigation.tokens)) {
        event.preventDefault();
        if (navigationOverlay) {
          if (navigationOpen) {
            closeDrawers();
            return;
          }
          rememberDrawerTrigger();
          setPanelOverlayOpen(false);
          setNavigationOpen(true);
          return;
        }
        const next = !layoutPreference.projectNavigation.expanded;
        const restoreToggleFocus = Boolean(
          !next && document.activeElement?.closest('.workspace-rail')
        );
        updateProjectNavigationPreference({ expanded: next });
        if (next) focusProjectSearch();
        else if (restoreToggleFocus) {
          requestAnimationFrame(() => {
            const railToggle = document.querySelector<HTMLButtonElement>(
              '.project-navigator-collapsed [aria-label="展开项目导航"]'
            );
            (
              railToggle ?? document.querySelector<HTMLButtonElement>('.mobile-nav-toggle')
            )?.focus();
          });
        }
      }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [
    closeDrawers,
    focusProjectSearch,
    navigationOpen,
    navigationOverlay,
    layoutPreference.projectNavigation.expanded,
    rememberDrawerTrigger,
    updateProjectNavigationPreference,
  ]);

  // `Mod+/` toggles the shortcut reference. Bound at the window level so it works
  // regardless of which region currently owns focus (including the composer).
  useEffect(() => {
    const helpShortcut = findShortcut('open-shortcut-help');
    if (!helpShortcut) return undefined;
    const onShortcut = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, helpShortcut.tokens)) return;
      event.preventDefault();
      setShortcutHelpOpen(open => !open);
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, []);

  useEffect(() => {
    if (!drawersOpen) return undefined;
    const main = document.querySelector<HTMLElement>('.conversation-column');
    const rail = document.querySelector<HTMLElement>('.workspace-rail');
    const inspector = document.querySelector<HTMLElement>('.work-panel');
    const notice = document.querySelector<HTMLElement>('.workbench-notice-stack');
    const skipLink = document.querySelector<HTMLElement>('.skip-link');
    if (main) main.inert = true;
    if (rail) rail.inert = panelModalOpen;
    if (inspector) inspector.inert = navigationOpen;
    if (notice) notice.inert = true;
    if (skipLink) skipLink.inert = true;
    const focusTimer = window.setTimeout(() => {
      const target = panelModalOpen
        ? inspector?.querySelector<HTMLButtonElement>('[aria-label="关闭工作面板"]')
        : restoreProjectSettingsFocus.current
          ? rail?.querySelector<HTMLButtonElement>('[aria-label="打开设置"]')
          : rail?.querySelector<HTMLButtonElement>('.drawer-close');
      restoreProjectSettingsFocus.current = false;
      target?.focus();
    }, 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !(event.target as HTMLElement | null)?.closest?.('[role="alertdialog"]')
      ) {
        closeDrawers();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      if (main) main.inert = false;
      if (rail) rail.inert = false;
      if (inspector) inspector.inert = false;
      if (notice) notice.inert = false;
      if (skipLink) skipLink.inert = false;
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [closeDrawers, drawersOpen, navigationOpen, panelModalOpen, state.notice]);

  const focusConversationContext = useCallback(() => {
    requestAnimationFrame(() => document.querySelector<HTMLElement>('#main-content h1')?.focus());
  }, []);

  const createSession = () => {
    setNavigationOpen(false);
    void actions.createSession().then(focusConversationContext, focusConversationContext);
  };

  const goToSessionControls = () => {
    settingsOpenedFromDrawer.current = false;
    restoreProjectSettingsFocus.current = false;
    setSettingsOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('#orion-composer')?.focus());
  };

  return (
    <>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <div
        ref={shellRef}
        className={`workbench-shell project-navigation-${columns.projectNavigation.mode} work-panel-mode-${columns.workPanel.mode} ${panelDerivedRail && panelOverlayOpen ? 'work-panel-transient-overlay' : ''}`}
        style={
          {
            '--project-navigation-width': `${columns.projectNavigation.widthPx}px`,
            '--project-navigation-preferred-width': `${layoutPreference.projectNavigation.widthPx}px`,
            '--work-panel-width': `${columns.workPanel.widthPx}px`,
            '--work-panel-preferred-width': `${layoutPreference.workPanel.widthPx}px`,
          } as CSSProperties
        }
        aria-busy={state.boot === 'loading'}
      >
        <ProjectNavigator
          state={state}
          drawerOpen={navigationModalOpen}
          dockVisible
          collapsed={columns.projectNavigation.mode === 'rail'}
          resizable={columns.projectNavigation.mode === 'dock'}
          width={columns.projectNavigation.widthPx}
          onCloseDrawer={closeDrawers}
          onExpand={() => {
            if (navigationOverlay) {
              rememberDrawerTrigger();
              setPanelOverlayOpen(false);
              setNavigationOpen(true);
            } else {
              updateProjectNavigationPreference({ expanded: true });
              focusProjectSearch();
            }
          }}
          onCollapse={() => {
            if (navigationOverlay) closeDrawers();
            else updateProjectNavigationPreference({ expanded: false });
          }}
          onOpenWorkspaceDialog={() => setWorkspaceOpen(true)}
          onOpenSettings={openSettingsFromProjectNavigation}
          onLoadMoreWorkspaces={() => void actions.loadMoreWorkspaces()}
          onCreateSession={createSession}
          onLoadWorkspaceSessions={(workspaceId, append) =>
            void actions.loadWorkspaceSessions(workspaceId, append)
          }
          onActivateContext={(workspaceId, sessionId) => {
            setNavigationOpen(false);
            void actions
              .activateContext(workspaceId, sessionId)
              .then(focusConversationContext, focusConversationContext);
          }}
          onSetPinned={(workspaceId, pinned) =>
            void actions.setWorkspacePinned(workspaceId, pinned)
          }
          onRemoveWorkspace={workspaceId => void actions.removeWorkspace(workspaceId)}
          onRefreshSummary={workspaceId => void actions.refreshWorkspaceProjectSummary(workspaceId)}
          onRenameSession={setRenameTarget}
          onSessionTags={setSessionTagsTarget}
          onArchiveSession={session => void actions.archiveSession(session.id)}
          onDeleteSession={setSessionDeleteTarget}
          onRestoreSession={session => void actions.restoreSession(session.id)}
          onWidthPreview={width => {
            const preview = computeWorkbenchColumns(shellWidth, {
              ...layoutPreference,
              projectNavigation: { ...layoutPreference.projectNavigation, widthPx: width },
            });
            shellRef.current?.style.setProperty(
              '--project-navigation-width',
              `${preview.projectNavigation.widthPx}px`
            );
          }}
          onWidthCommit={width => updateProjectNavigationPreference({ widthPx: width })}
        />

        <Conversation
          state={state}
          actions={actions}
          navigationOpen={
            navigationOverlay ? navigationModalOpen : columns.projectNavigation.mode === 'dock'
          }
          inspectorExpanded={panelExpanded}
          onOpenNavigation={() => {
            if (!navigationOverlay) {
              updateProjectNavigationPreference({ expanded: true });
              focusProjectSearch();
              return;
            }
            rememberDrawerTrigger();
            setPanelOverlayOpen(false);
            setNavigationOpen(true);
          }}
          onToggleInspector={() => {
            if (panelOverlay || panelDerivedRail) {
              if (panelOverlayOpen) {
                closeDrawers();
                return;
              }
              rememberDrawerTrigger();
              setNavigationOpen(false);
              setPanelOverlayOpen(true);
              return;
            }
            updatePanelPreference({ expanded: !layoutPreference.workPanel.expanded });
          }}
          onRevealSettings={focusProjectSettings}
          onCreateSession={createSession}
          themePreference={theme}
          onCycleTheme={cycleTheme}
          onShowShortcuts={() => setShortcutHelpOpen(true)}
          composerInsertion={composerInsertion}
        />

        <WorkPanelDock
          state={state}
          actions={actions}
          mode={panelSurfaceOverlay ? 'overlay' : 'dock'}
          expanded={panelExpanded}
          activePanel={layoutPreference.workPanel.activePanel}
          agentPanel={layoutPreference.workPanel.agentPanel}
          onExpand={() => {
            if (panelOverlay || panelDerivedRail) setPanelOverlayOpen(true);
            else updatePanelPreference({ expanded: true });
          }}
          onCollapse={() => {
            if (panelSurfaceOverlay) closeDrawers();
            else updatePanelPreference({ expanded: false });
          }}
          onPanelChange={(activePanel: WorkPanelId) => updatePanelPreference({ activePanel })}
          onAgentPanelChange={(agentPanel: AgentPanelId) => updatePanelPreference({ agentPanel })}
          onWidthPreview={width => {
            const preview = computeWorkbenchColumns(shellWidth, {
              ...layoutPreference,
              workPanel: { ...layoutPreference.workPanel, widthPx: width },
            });
            shellRef.current?.style.setProperty(
              '--work-panel-width',
              `${preview.workPanel.widthPx}px`
            );
          }}
          onWidthCommit={width => updatePanelPreference({ widthPx: width })}
          width={columns.workPanel.widthPx}
          onSendToComposer={text => {
            setComposerInsertion({ id: Date.now(), text });
            if (panelOverlay) closeDrawers();
            requestAnimationFrame(() =>
              document.querySelector<HTMLElement>('#orion-composer')?.focus()
            );
          }}
        />

        {drawersOpen ? (
          <button
            type="button"
            className="drawer-scrim"
            aria-label="关闭侧边面板"
            tabIndex={-1}
            onClick={closeDrawers}
          />
        ) : null}

        {noticeQueue.length > 0 ? (
          <div className="workbench-notice-stack" aria-live="polite">
            {noticeQueue.map(entry => (
              <WorkbenchNoticeCard
                key={entry.uid}
                uid={entry.uid}
                notice={entry.notice}
                reconnectNeeded={state.connection === 'replay-required'}
                snapshotRetryNeeded={
                  entry.notice.domain === 'session-snapshot' && sessionSync.status === 'failed'
                }
                pendingAction={Boolean(state.pendingAction)}
                onDismiss={dismissQueuedNotice}
                onRecover={recoverQueuedNotice}
              />
            ))}
          </div>
        ) : null}

        {state.boot !== 'ready' ? (
          <section className="boot-screen" role={state.boot === 'error' ? 'alert' : 'status'}>
            <div className="boot-mark" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            {state.boot === 'loading' ? (
              <>
                <h1>正在启动 Orion Workbench</h1>
                <p>建立本地安全握手并恢复工作区状态…</p>
                <span className="boot-loader" aria-hidden="true" />
              </>
            ) : (
              <>
                <h1>无法连接本地 Web Host</h1>
                <p>{state.bootError || '请确认 Orion Web Host 仍在运行。'}</p>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void actions.retryBoot()}
                  disabled={Boolean(state.pendingAction)}
                >
                  <Icon name="refresh" size={15} />
                  重新连接
                </button>
              </>
            )}
          </section>
        ) : null}

        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {state.announcement}
        </div>
      </div>

      <SettingsDialog
        open={settingsOpen}
        onClose={closeSettings}
        state={state}
        actions={actions}
        onGoToSessionControls={goToSessionControls}
      />
      <WorkspaceDialog
        open={workspaceOpen}
        onClose={() => setWorkspaceOpen(false)}
        state={state}
        onSelect={actions.switchWorkspace}
        onLoadMore={actions.loadMoreWorkspaces}
      />
      <RenameDialog
        open={Boolean(renameTarget)}
        onClose={() => setRenameTarget(null)}
        session={renameTarget}
        pending={Boolean(state.pendingAction)}
        onRename={actions.renameSession}
      />
      <SessionTagsDialog
        open={Boolean(sessionTagsTarget)}
        onClose={() => setSessionTagsTarget(null)}
        session={sessionTagsTarget}
        pending={Boolean(state.pendingAction)}
        onSave={actions.updateSessionTags}
      />
      <ConfirmDeleteSessionDialog
        open={Boolean(sessionDeleteTarget)}
        onClose={() => setSessionDeleteTarget(null)}
        session={sessionDeleteTarget}
        pending={Boolean(state.pendingAction)}
        onConfirm={actions.deleteSession}
      />
      <ShortcutHelpDialog open={shortcutHelpOpen} onClose={() => setShortcutHelpOpen(false)} />
    </>
  );
}

function useElementWidth(ref: { readonly current: HTMLElement | null }): number {
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : Math.max(320, Math.round(window.innerWidth))
  );
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const update = () => {
      const next = Math.max(320, Math.round(element.getBoundingClientRect().width));
      setWidth(current => (current === next ? current : next));
    };
    update();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(update);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [ref]);
  return width;
}
