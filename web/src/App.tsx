import { useCallback, useEffect, useRef, useState } from 'react';

import { Conversation } from './components/Conversation';
import { RenameDialog, WorkspaceDialog } from './components/Dialogs';
import { Icon } from './components/Icon';
import { Inspector } from './components/Inspector';
import { SettingsDialog } from './components/SettingsDialog';
import { WorkspaceRail } from './components/WorkspaceRail';
import type { WebSessionSummaryV1 } from './types';
import { useWorkbench } from './useWorkbench';

const INSPECTOR_OVERLAY_QUERY = '(max-width: 1180px)';

type InspectorDockPreference = 'expanded' | 'collapsed';

export function App() {
  const { state, actions } = useWorkbench();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [desktopInspector, setDesktopInspector] = useState<InspectorDockPreference>('expanded');
  const [inspectorOverlayOpen, setInspectorOverlayOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<WebSessionSummaryV1 | null>(null);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const inspectorOverlay = useMediaQuery(INSPECTOR_OVERLAY_QUERY);
  const inspectorExpanded = inspectorOverlay
    ? inspectorOverlayOpen
    : desktopInspector === 'expanded';
  const inspectorModalOpen = inspectorOverlay && inspectorOverlayOpen;
  const drawersOpen = navigationOpen || inspectorModalOpen;
  const appearance =
    state.settings?.state === 'ready'
      ? state.settings
      : (state.settingsMirror.lastGood ?? state.settings);
  const theme = appearance?.sections.appearance.theme.effectiveValue;
  const motion = appearance?.sections.appearance.motion.effectiveValue;

  const rememberDrawerTrigger = useCallback(() => {
    drawerTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);

  const closeDrawers = useCallback(() => {
    setNavigationOpen(false);
    setInspectorOverlayOpen(false);
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
    setInspectorOverlayOpen(false);
    drawerTrigger.current = null;
  }, [state.activeSessionId, state.workspace]);

  useEffect(() => {
    setNavigationOpen(false);
    setInspectorOverlayOpen(false);
    drawerTrigger.current = null;
  }, [inspectorOverlay]);

  useEffect(() => {
    if (!drawersOpen) return undefined;
    const main = document.querySelector<HTMLElement>('.conversation-column');
    const rail = document.querySelector<HTMLElement>('.workspace-rail');
    const inspector = document.querySelector<HTMLElement>('.inspector');
    const notice = document.querySelector<HTMLElement>('.workbench-notice');
    const skipLink = document.querySelector<HTMLElement>('.skip-link');
    if (main) main.inert = true;
    if (rail) rail.inert = inspectorModalOpen;
    if (inspector) inspector.inert = navigationOpen;
    if (notice) notice.inert = true;
    if (skipLink) skipLink.inert = true;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDrawers();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      if (main) main.inert = false;
      if (rail) rail.inert = false;
      if (inspector) inspector.inert = false;
      if (notice) notice.inert = false;
      if (skipLink) skipLink.inert = false;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [closeDrawers, drawersOpen, inspectorModalOpen, navigationOpen, state.notice]);

  const createSession = () => {
    setNavigationOpen(false);
    void actions.createSession();
  };

  const activateSession = (sessionId: string) => {
    setNavigationOpen(false);
    void actions.activateSession(sessionId);
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
        className={`workbench-shell inspector-${desktopInspector}`}
        aria-busy={state.boot === 'loading'}
      >
        <WorkspaceRail
          state={state}
          drawerOpen={navigationOpen}
          onCloseDrawer={closeDrawers}
          onOpenWorkspaceDialog={() => setWorkspaceOpen(true)}
          onCreateSession={createSession}
          onActivateSession={activateSession}
          onRenameSession={setRenameTarget}
        />

        <Conversation
          state={state}
          actions={actions}
          navigationOpen={navigationOpen}
          inspectorExpanded={inspectorExpanded}
          settingsOpen={settingsOpen}
          onOpenNavigation={() => {
            rememberDrawerTrigger();
            setInspectorOverlayOpen(false);
            setNavigationOpen(true);
          }}
          onToggleInspector={() => {
            if (inspectorOverlay) {
              if (inspectorOverlayOpen) {
                closeDrawers();
                return;
              }
              rememberDrawerTrigger();
              setNavigationOpen(false);
              setInspectorOverlayOpen(true);
              return;
            }
            setDesktopInspector(current => (current === 'expanded' ? 'collapsed' : 'expanded'));
          }}
          onOpenSettings={() => setSettingsOpen(true)}
          onCreateSession={createSession}
        />

        <Inspector
          state={state}
          actions={actions}
          mode={inspectorOverlay ? 'overlay' : 'dock'}
          expanded={inspectorExpanded}
          settingsOpen={settingsOpen}
          onExpand={() => {
            if (inspectorOverlay) setInspectorOverlayOpen(true);
            else setDesktopInspector('expanded');
          }}
          onCollapse={() => {
            if (inspectorOverlay) closeDrawers();
            else setDesktopInspector('collapsed');
          }}
          onOpenSettings={() => setSettingsOpen(true)}
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
            <button
              type="button"
              className="icon-button"
              onClick={actions.dismissNotice}
              aria-label="关闭通知"
            >
              <Icon name="close" size={15} />
            </button>
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

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return matches;
}
