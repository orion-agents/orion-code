import { lazy, Suspense, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { AgentPanel, type AgentPanelTab } from '../components/Inspector';
import { Icon, type IconName } from '../components/Icon';
import { StateDot } from '../components/StateDot';
import type { WorkbenchState } from '../types';
import type { WorkbenchActions } from '../useWorkbench';
import { DEFAULT_WORK_PANEL_ORDER, type WorkPanelId } from '../state/layout-preferences';
import { findShortcut, matchesShortcut } from '../shortcuts';
import { WorkPanelResizeHandle } from './WorkPanelResizeHandle';

type WorkPanelMode = 'dock' | 'overlay';

const TerminalPanel = lazy(() =>
  import('../components/terminal/TerminalPanel').then(module => ({ default: module.TerminalPanel }))
);
const FilesPanel = lazy(() =>
  import('../components/files/FilesPanel').then(module => ({ default: module.FilesPanel }))
);
const GitPanel = lazy(() =>
  import('../components/git/GitPanel').then(module => ({ default: module.GitPanel }))
);
const ReviewPanel = lazy(() =>
  import('../components/review/ReviewPanel').then(module => ({ default: module.ReviewPanel }))
);

const PANEL_SHORTCUT_IDS = [
  'focus-work-panel-1',
  'focus-work-panel-2',
  'focus-work-panel-3',
  'focus-work-panel-4',
  'focus-work-panel-5',
] as const;

const PANEL_META: Readonly<
  Record<WorkPanelId, { readonly label: string; readonly icon: IconName }>
> = Object.freeze({
  agent: { label: 'Agent', icon: 'spark' },
  review: { label: '审阅', icon: 'edit' },
  terminal: { label: '终端', icon: 'terminal' },
  files: { label: '文件', icon: 'workspace' },
  git: { label: 'Git', icon: 'branch' },
});

/** v0.3.8 — Session phases that light up the terminal icon in the vertical rail. */
const RAIL_ACTIVE_PHASES = new Set([
  'starting',
  'running',
  'stopping',
  'queued',
  'waiting_approval',
  'interrupted',
  'failed',
]);

function railDotState(phase: string | undefined, processing: boolean): string | null {
  if (!phase) return processing ? 'running' : null;
  if (!RAIL_ACTIVE_PHASES.has(phase)) return null;
  if (phase === 'failed' || phase === 'interrupted') return 'failed';
  if (phase === 'queued' || phase === 'waiting_approval') return 'queued';
  return 'running';
}

export interface WorkPanelDockProps {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
  readonly mode: WorkPanelMode;
  readonly expanded: boolean;
  readonly activePanel: WorkPanelId;
  /** v0.3.8 — Optional user-chosen vertical rail order (defaults to canonical). */
  readonly panelOrder?: readonly WorkPanelId[];
  readonly agentPanel: AgentPanelTab;
  readonly onExpand: () => void;
  readonly onCollapse: () => void;
  readonly onPanelChange: (panel: WorkPanelId) => void;
  readonly onAgentPanelChange: (panel: AgentPanelTab) => void;
  readonly onWidthPreview: (width: number) => void;
  readonly onWidthCommit: (width: number) => void;
  /** Live dock width in px, used for the resize separator's `aria-valuenow`. */
  readonly width: number;
  readonly onSendToComposer: (text: string) => void;
}

export function WorkPanelDock({
  state,
  actions,
  mode,
  expanded,
  activePanel,
  panelOrder,
  agentPanel,
  onExpand,
  onCollapse,
  onPanelChange,
  onAgentPanelChange,
  onWidthPreview,
  onWidthCommit,
  width,
  onSendToComposer,
}: WorkPanelDockProps) {
  const surfaceRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const previousExpanded = useRef(expanded);
  const contentIdBase = useId();
  /** Panels ever opened (keeps the legacy keep-alive contract for the terminal). */
  const visitedPanels = useRef(new Set<WorkPanelId>([activePanel]));
  visitedPanels.current.add(activePanel);
  // v0.3.8 S4 — differential recycling. The terminal is the only heavy
  // interactive pane (host-backed xterm session): once opened it stays mounted.
  // Pure resource panes unmount when deactivated and reload through their
  // resource-epoch refresh on the next activation.
  const mountedTerminal = useRef(
    activePanel === 'terminal' || visitedPanels.current.has('terminal')
  );
  if (activePanel === 'terminal') mountedTerminal.current = true;
  const [openedWithFocus, setOpenedWithFocus] = useState(false);

  const orderedPanels =
    panelOrder && panelOrder.length === DEFAULT_WORK_PANEL_ORDER.length
      ? panelOrder
      : DEFAULT_WORK_PANEL_ORDER;
  const resourceEpochs = state.workspaceResourceEpochs[state.workspaceId] ?? {
    files: 0,
    git: 0,
    review: 0,
  };
  const foregroundPhase = state.sessionRuntimeById[state.activeSessionId ?? '']?.phase;
  const terminalDotState = railDotState(foregroundPhase, state.processing);

  useEffect(() => {
    if (mode !== 'overlay' || !expanded) return undefined;
    let attempts = 0;
    let interval = 0;
    const focusClose = () => {
      attempts += 1;
      closeRef.current?.focus();
      if (document.activeElement === closeRef.current || attempts >= 10) {
        window.clearInterval(interval);
      }
    };
    interval = window.setInterval(focusClose, 16);
    focusClose();
    return () => window.clearInterval(interval);
  }, [expanded, mode]);

  // v0.3.8 S2 — focus hand-off: collapsing returns focus to the rail icon of
  // the previously active panel; a freshly opened dock focuses the content.
  useEffect(() => {
    const wasExpanded = previousExpanded.current;
    previousExpanded.current = expanded;
    if (mode !== 'dock' || wasExpanded === expanded) return;
    if (!expanded) {
      requestAnimationFrame(() =>
        surfaceRef.current
          ?.querySelector<HTMLButtonElement>(`[data-work-panel-id="${activePanel}"]`)
          ?.focus()
      );
      return;
    }
    if (openedWithFocus) {
      setOpenedWithFocus(false);
      requestAnimationFrame(() => detailRef.current?.focus());
    }
  }, [activePanel, expanded, mode, openedWithFocus]);

  useEffect(() => {
    const togglePanel = findShortcut('toggle-work-panel');
    const onShortcut = (event: globalThis.KeyboardEvent) => {
      if (togglePanel && matchesShortcut(event, togglePanel.tokens)) {
        event.preventDefault();
        if (expanded) onCollapse();
        else {
          setOpenedWithFocus(true);
          onExpand();
        }
        return;
      }
      const index = PANEL_SHORTCUT_IDS.findIndex(id => {
        const binding = findShortcut(id);
        return binding ? matchesShortcut(event, binding.tokens) : false;
      });
      const panel = orderedPanels[index];
      if (!panel) return;
      event.preventDefault();
      if (expanded && activePanel === panel) return;
      onPanelChange(panel);
      if (!expanded) onExpand();
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [expanded, mode, onCollapse, onExpand, onPanelChange]);

  const onSurfaceKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.key === 'Escape' &&
      expanded &&
      !(event.target as HTMLElement).closest(
        '[role="alertdialog"], .terminal-host, input, textarea, [contenteditable]'
      )
    ) {
      event.preventDefault();
      onCollapse();
      return;
    }
    if (mode !== 'overlay' || !expanded || event.key !== 'Tab') return;
    const focusable = focusableElements(surfaceRef.current);
    if (!focusable.length) {
      event.preventDefault();
      surfaceRef.current?.focus();
      return;
    }
    const current = focusable.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey && current <= 0) {
      event.preventDefault();
      focusable.at(-1)?.focus();
    } else if (!event.shiftKey && (current < 0 || current === focusable.length - 1)) {
      event.preventDefault();
      focusable[0].focus();
    }
  };

  /** v0.3.8 S2 — rail semantics: switch to the clicked panel, or collapse the
   * content area again when the already-active icon is re-clicked. */
  const activate = (panel: WorkPanelId) => {
    if (mode === 'overlay') {
      onPanelChange(panel);
      if (!expanded) {
        setOpenedWithFocus(true);
        onExpand();
      }
      return;
    }
    if (expanded && activePanel === panel) {
      onCollapse();
      return;
    }
    if (!expanded) setOpenedWithFocus(true);
    onPanelChange(panel);
    onExpand();
  };

  const rail = (overlay = false) => (
    <nav
      className={overlay ? 'work-panel-rail work-panel-rail-overlay' : 'work-panel-rail'}
      aria-label="工作面板快捷入口"
      aria-orientation={overlay ? 'horizontal' : 'vertical'}
    >
      {orderedPanels.map((id, index) => {
        const meta = PANEL_META[id];
        const isActive = activePanel === id;
        return (
          <button
            key={id}
            type="button"
            className="work-panel-rail-button"
            data-work-panel-id={id}
            aria-label={`打开${meta.label}面板`}
            aria-current={isActive ? 'page' : undefined}
            title={`${meta.label} · ⌘⇧${index + 1}`}
            onClick={() => activate(id)}
          >
            <Icon name={meta.icon} size={17} />
            {id === 'terminal' && terminalDotState ? (
              <StateDot state={terminalDotState} className="rail-status-dot" describe={false} />
            ) : null}
          </button>
        );
      })}
    </nav>
  );

  const renderPane = (id: WorkPanelId) => (
    <div
      key={id}
      id={`${contentIdBase}-${id}`}
      className="work-panel-pane"
      role="tabpanel"
      aria-label={PANEL_META[id].label}
      hidden={id !== activePanel}
    >
      {id === 'agent' ? (
        <AgentPanel
          state={state}
          actions={actions}
          tab={agentPanel}
          onTabChange={onAgentPanelChange}
        />
      ) : null}
      {id === 'review' ? (
        <ReviewPanel
          workspaceId={state.workspaceId}
          refreshEpoch={resourceEpochs.review}
          actions={actions}
          onSendToComposer={onSendToComposer}
        />
      ) : null}
      {id === 'terminal' ? (
        <TerminalPanel
          workspaceId={state.workspaceId}
          workspacePath={state.workspace}
          styleNonce={state.bootstrap?.nonce ?? ''}
          available={Boolean(state.bootstrap?.capabilities.terminal)}
          actions={actions}
        />
      ) : null}
      {id === 'files' ? (
        <FilesPanel
          workspaceId={state.workspaceId}
          refreshEpoch={resourceEpochs.files}
          actions={actions}
        />
      ) : null}
      {id === 'git' ? (
        <GitPanel
          workspaceId={state.workspaceId}
          refreshEpoch={resourceEpochs.git}
          actions={actions}
          onSendToComposer={onSendToComposer}
        />
      ) : null}
    </div>
  );

  // v0.3.8 S4 — mount set: the active pane plus the terminal once it has been
  // opened (its xterm state lives on the host; remounting would drop the view).
  const paneIds: WorkPanelId[] =
    activePanel === 'terminal' || !mountedTerminal.current
      ? [activePanel]
      : [activePanel, 'terminal'];

  return (
    <aside
      ref={surfaceRef}
      id="work-panel"
      className={`work-panel work-panel-${mode} ${expanded ? 'drawer-open work-panel-expanded' : 'work-panel-collapsed'}`}
      role={mode === 'overlay' ? 'dialog' : undefined}
      aria-modal={mode === 'overlay' && expanded ? true : undefined}
      aria-label="工作面板"
      data-mode={mode}
      data-state={expanded ? 'expanded' : 'collapsed'}
      tabIndex={mode === 'overlay' && expanded ? -1 : undefined}
      onKeyDownCapture={onSurfaceKeyDown}
    >
      {mode === 'dock' ? (
        <div className="work-panel-dock-body">
          {expanded ? (
            <section
              ref={detailRef}
              id="work-panel-detail"
              className="work-panel-detail"
              aria-label="工作面板内容"
              tabIndex={-1}
            >
              <header className="work-panel-header">
                <div>
                  <span className="eyebrow">PROJECT WORKSPACE</span>
                  <h2>{PANEL_META[activePanel].label}</h2>
                </div>
                <div className="work-panel-header-actions">
                  <button
                    type="button"
                    className="icon-button"
                    onClick={onCollapse}
                    aria-label="收起工作面板"
                    aria-controls="work-panel-detail"
                    aria-expanded="true"
                    title="收起（Esc）"
                  >
                    <Icon name="sidebar" />
                  </button>
                </div>
              </header>
              <div className="work-panel-content">
                <Suspense fallback={<p className="resource-loading">正在加载工作面板…</p>}>
                  {paneIds.map(id => renderPane(id))}
                </Suspense>
              </div>
            </section>
          ) : null}
          {rail()}
        </div>
      ) : (
        <div id="work-panel-detail" className="work-panel-detail" hidden={!expanded}>
          <header className="work-panel-header">
            <div>
              <span className="eyebrow">PROJECT WORKSPACE</span>
              <h2>{PANEL_META[activePanel].label}</h2>
            </div>
            <div className="work-panel-header-actions">
              <button
                ref={closeRef}
                type="button"
                className="icon-button"
                onClick={onCollapse}
                aria-label="关闭工作面板"
                aria-controls="work-panel-detail"
                aria-expanded="true"
              >
                <Icon name="close" />
              </button>
            </div>
          </header>
          {rail(true)}
          <div className="work-panel-content">
            <Suspense fallback={<p className="resource-loading">正在加载工作面板…</p>}>
              {paneIds.map(id => renderPane(id))}
            </Suspense>
          </div>
        </div>
      )}
      {mode === 'dock' && expanded ? (
        <WorkPanelResizeHandle width={width} onPreview={onWidthPreview} onCommit={onWidthCommit} />
      ) : null}
    </aside>
  );
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'
    )
  ).filter(
    element =>
      !element.hasAttribute('disabled') &&
      !element.closest('[inert]') &&
      !element.closest('[hidden]') &&
      element.getClientRects().length > 0
  );
}
