import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

import { Conversation } from './components/Conversation';
import { RenameDialog, WorkspaceDialog } from './components/Dialogs';
import { Icon } from './components/Icon';
import { SettingsDialog } from './components/SettingsDialog';
import { ProjectNavigator } from './components/projects/ProjectNavigator';
import { WorkPanelDock } from './layout/WorkPanelDock';
import {
  computeWorkbenchColumns,
  loadWorkbenchLayoutPreference,
  saveWorkbenchLayoutPreference,
  type AgentPanelId,
  type WorkbenchLayoutPreferenceV2,
  type WorkPanelId,
} from './state/layout-preferences';
import type { WebSessionSummaryV1 } from './types';
import { useWorkbench } from './useWorkbench';

export function App() {
  const { state, actions } = useWorkbench();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [layoutPreference, setLayoutPreference] = useState(loadWorkbenchLayoutPreference);
  const [panelOverlayOpen, setPanelOverlayOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<WebSessionSummaryV1 | null>(null);
  const [composerInsertion, setComposerInsertion] = useState<{
    readonly id: number;
    readonly text: string;
  } | null>(null);
  const drawerTrigger = useRef<HTMLElement | null>(null);
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

  const closeDrawers = useCallback(() => {
    setNavigationOpen(false);
    setPanelOverlayOpen(false);
    const trigger = drawerTrigger.current;
    drawerTrigger.current = null;
    if (trigger) requestAnimationFrame(() => trigger.focus());
  }, []);

  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (motion) document.documentElement.dataset.motion = motion;
  }, [motion]);

  useEffect(() => {
    setNavigationOpen(false);
    setPanelOverlayOpen(false);
    drawerTrigger.current = null;
  }, [state.activeSessionId, state.workspace]);

  useEffect(() => {
    setNavigationOpen(false);
    setPanelOverlayOpen(false);
    drawerTrigger.current = null;
  }, [columns.projectNavigation.mode, columns.workPanel.mode, navigationOverlay, panelOverlay]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.code !== 'KeyB') return;
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
        requestAnimationFrame(() =>
          document.querySelector<HTMLButtonElement>('.mobile-nav-toggle')?.focus()
        );
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

  useEffect(() => {
    if (!drawersOpen) return undefined;
    const main = document.querySelector<HTMLElement>('.conversation-column');
    const rail = document.querySelector<HTMLElement>('.workspace-rail');
    const inspector = document.querySelector<HTMLElement>('.work-panel');
    const notice = document.querySelector<HTMLElement>('.workbench-notice');
    const skipLink = document.querySelector<HTMLElement>('.skip-link');
    if (main) main.inert = true;
    if (rail) rail.inert = panelModalOpen;
    if (inspector) inspector.inert = navigationOpen;
    if (notice) notice.inert = true;
    if (skipLink) skipLink.inert = true;
    const focusTimer = window.setTimeout(() => {
      const target = panelModalOpen
        ? inspector?.querySelector<HTMLButtonElement>('[aria-label="关闭工作面板"]')
        : rail?.querySelector<HTMLButtonElement>('.drawer-close');
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
        className={`workbench-shell project-navigation-${columns.projectNavigation.mode} work-panel-${columns.workPanel.mode} ${panelDerivedRail && panelOverlayOpen ? 'work-panel-transient-overlay' : ''}`}
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
          onOpenSettings={() => setSettingsOpen(true)}
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
          settingsOpen={settingsOpen}
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
          onOpenSettings={() => setSettingsOpen(true)}
          onCreateSession={createSession}
          composerInsertion={composerInsertion}
        />

        <WorkPanelDock
          state={state}
          actions={actions}
          mode={panelSurfaceOverlay ? 'overlay' : 'dock'}
          expanded={panelExpanded}
          activePanel={layoutPreference.workPanel.activePanel}
          agentPanel={layoutPreference.workPanel.agentPanel}
          settingsOpen={settingsOpen}
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
          onOpenSettings={() => setSettingsOpen(true)}
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

        {state.notice ? (
          <aside
            className={`workbench-notice notice-${state.notice.tone}`}
            role={state.notice.tone === 'error' ? 'alert' : 'status'}
            aria-labelledby={`notice-${state.notice.id}`}
          >
            <span className="notice-icon">
              <Icon
                name={
                  state.notice.tone === 'success'
                    ? 'check'
                    : state.notice.tone === 'info'
                      ? 'info'
                      : 'warning'
                }
                size={17}
              />
            </span>
            <div>
              <strong id={`notice-${state.notice.id}`}>{state.notice.title}</strong>
              {state.notice.detail ? <p>{state.notice.detail}</p> : null}
            </div>
            {state.connection === 'replay-required' ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void actions.recoverSession()}
                disabled={Boolean(state.pendingAction)}
              >
                恢复
              </button>
            ) : null}
            {state.connection !== 'replay-required' ? (
              <button
                type="button"
                className="icon-button"
                onClick={actions.dismissNotice}
                aria-label="关闭通知"
              >
                <Icon name="close" size={15} />
              </button>
            ) : null}
          </aside>
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
        onClose={() => setSettingsOpen(false)}
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
