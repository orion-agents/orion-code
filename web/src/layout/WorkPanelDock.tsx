import { lazy, Suspense, useEffect, useId, useRef, type KeyboardEvent } from 'react';

import { AgentPanel, type AgentPanelTab } from '../components/Inspector';
import { Icon, type IconName } from '../components/Icon';
import type { WorkbenchState } from '../types';
import type { WorkbenchActions } from '../useWorkbench';
import type { WorkPanelId } from '../state/layout-preferences';
import { WorkPanelResizeHandle } from './WorkPanelResizeHandle';

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

type WorkPanelMode = 'dock' | 'overlay';

const PANELS: ReadonlyArray<{
  readonly id: WorkPanelId;
  readonly label: string;
  readonly icon: IconName;
}> = [
  { id: 'agent', label: 'Agent', icon: 'spark' },
  { id: 'review', label: '审阅', icon: 'edit' },
  { id: 'terminal', label: '终端', icon: 'terminal' },
  { id: 'files', label: '文件', icon: 'workspace' },
  { id: 'git', label: 'Git', icon: 'branch' },
];

export interface WorkPanelDockProps {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
  readonly mode: WorkPanelMode;
  readonly expanded: boolean;
  readonly activePanel: WorkPanelId;
  readonly agentPanel: AgentPanelTab;
  readonly onExpand: () => void;
  readonly onCollapse: () => void;
  readonly onPanelChange: (panel: WorkPanelId) => void;
  readonly onAgentPanelChange: (panel: AgentPanelTab) => void;
  readonly onWidthPreview: (width: number) => void;
  readonly onWidthCommit: (width: number) => void;
  readonly onSendToComposer: (text: string) => void;
}

export function WorkPanelDock({
  state,
  actions,
  mode,
  expanded,
  activePanel,
  agentPanel,
  onExpand,
  onCollapse,
  onPanelChange,
  onAgentPanelChange,
  onWidthPreview,
  onWidthCommit,
  onSendToComposer,
}: WorkPanelDockProps) {
  const surfaceRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousExpanded = useRef(expanded);
  const focusPanelAfterExpand = useRef(false);
  const visitedPanels = useRef(new Set<WorkPanelId>([activePanel]));
  visitedPanels.current.add(activePanel);
  const tabsId = useId();
  const resourceEpochs = state.workspaceResourceEpochs[state.workspaceId] ?? {
    files: 0,
    git: 0,
    review: 0,
  };

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
    if (!focusPanelAfterExpand.current) return;
    focusPanelAfterExpand.current = false;
    requestAnimationFrame(() => document.getElementById(`${tabsId}-${activePanel}`)?.focus());
  }, [activePanel, expanded, mode, tabsId]);

  useEffect(() => {
    const onShortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
      if (event.code === 'KeyB') {
        event.preventDefault();
        if (expanded) onCollapse();
        else {
          focusPanelAfterExpand.current = true;
          onExpand();
        }
        return;
      }
      const digit = /^Digit([1-5])$/u.exec(event.code)?.[1];
      const index = Number(digit) - 1;
      const panel = PANELS[index];
      if (!panel) return;
      event.preventDefault();
      focusPanelAfterExpand.current = true;
      onPanelChange(panel.id);
      onExpand();
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [expanded, onCollapse, onExpand, onPanelChange]);

  const onSurfaceKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.key === 'Escape' &&
      mode === 'overlay' &&
      expanded &&
      !(event.target as HTMLElement).closest('[role="alertdialog"], .terminal-host')
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

  const selectPanel = (panel: WorkPanelId) => {
    if (!expanded) focusPanelAfterExpand.current = true;
    onPanelChange(panel);
    if (!expanded) onExpand();
  };

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
      {mode === 'dock' && expanded ? (
        <WorkPanelResizeHandle onPreview={onWidthPreview} onCommit={onWidthCommit} />
      ) : null}
      {!expanded && mode === 'dock' ? (
        <nav className="work-panel-rail" aria-label="工作面板快捷入口">
          <button
            type="button"
            className="work-panel-rail-button"
            aria-label="展开工作面板"
            title="展开工作面板"
            onClick={() => {
              focusPanelAfterExpand.current = true;
              onExpand();
            }}
          >
            <Icon name="sidebar" />
          </button>
          <span className="work-panel-rail-divider" />
          {PANELS.map(item => (
            <button
              key={item.id}
              type="button"
              className="work-panel-rail-button"
              data-work-panel-id={item.id}
              aria-label={`打开${item.label}面板`}
              aria-current={activePanel === item.id ? 'page' : undefined}
              title={`${item.label} · ⌘⇧${PANELS.indexOf(item) + 1}`}
              onClick={() => selectPanel(item.id)}
            >
              <Icon name={item.icon} size={17} />
              {item.id === 'terminal' && state.processing ? (
                <span className="rail-status-dot" />
              ) : null}
            </button>
          ))}
        </nav>
      ) : null}

      <div id="work-panel-detail" className="work-panel-detail" hidden={!expanded}>
        <header className="work-panel-header">
          <div>
            <span className="eyebrow">PROJECT WORKSPACE</span>
            <h2>{PANELS.find(item => item.id === activePanel)?.label ?? 'Agent'}</h2>
          </div>
          <div className="work-panel-header-actions">
            <button
              ref={closeRef}
              type="button"
              className="icon-button"
              onClick={onCollapse}
              aria-label={mode === 'overlay' ? '关闭工作面板' : '折叠工作面板'}
              aria-controls="work-panel-detail"
              aria-expanded="true"
            >
              <Icon name={mode === 'overlay' ? 'close' : 'sidebar'} />
            </button>
          </div>
        </header>

        <div className="work-panel-tabs" role="tablist" aria-label="工作面板类别">
          {PANELS.map(item => (
            <button
              key={item.id}
              id={`${tabsId}-${item.id}`}
              type="button"
              role="tab"
              aria-label={`${item.label}，快捷键 Command 或 Control 加 Shift 加 ${PANELS.indexOf(item) + 1}`}
              aria-selected={activePanel === item.id}
              aria-controls={`${tabsId}-${item.id}-content`}
              tabIndex={activePanel === item.id ? 0 : -1}
              title={`⌘/Ctrl+Shift+${PANELS.indexOf(item) + 1}`}
              onClick={() => onPanelChange(item.id)}
              onKeyDown={event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const current = PANELS.findIndex(panel => panel.id === activePanel);
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? PANELS.length - 1
                      : (current + (event.key === 'ArrowRight' ? 1 : -1) + PANELS.length) %
                        PANELS.length;
                onPanelChange(PANELS[next].id);
                requestAnimationFrame(() =>
                  document.getElementById(`${tabsId}-${PANELS[next].id}`)?.focus()
                );
              }}
            >
              <Icon name={item.icon} size={15} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        <div className="work-panel-content">
          <Suspense fallback={<p className="resource-loading">正在加载工作面板…</p>}>
            {PANELS.map(item =>
              visitedPanels.current.has(item.id) ? (
                <div
                  key={item.id}
                  id={`${tabsId}-${item.id}-content`}
                  className="work-panel-pane"
                  role="tabpanel"
                  aria-labelledby={`${tabsId}-${item.id}`}
                  hidden={activePanel !== item.id}
                >
                  {item.id === 'agent' ? (
                    <AgentPanel
                      state={state}
                      actions={actions}
                      tab={agentPanel}
                      onTabChange={onAgentPanelChange}
                    />
                  ) : null}
                  {item.id === 'review' ? (
                    <ReviewPanel
                      workspaceId={state.workspaceId}
                      refreshEpoch={resourceEpochs.review}
                      actions={actions}
                      onSendToComposer={onSendToComposer}
                    />
                  ) : null}
                  {item.id === 'terminal' ? (
                    <TerminalPanel
                      workspaceId={state.workspaceId}
                      workspacePath={state.workspace}
                      styleNonce={state.bootstrap?.nonce ?? ''}
                      available={Boolean(state.bootstrap?.capabilities.terminal)}
                      actions={actions}
                    />
                  ) : null}
                  {item.id === 'files' ? (
                    <FilesPanel
                      workspaceId={state.workspaceId}
                      refreshEpoch={resourceEpochs.files}
                      actions={actions}
                    />
                  ) : null}
                  {item.id === 'git' ? (
                    <GitPanel
                      workspaceId={state.workspaceId}
                      refreshEpoch={resourceEpochs.git}
                      actions={actions}
                      onSendToComposer={onSendToComposer}
                    />
                  ) : null}
                </div>
              ) : null
            )}
          </Suspense>
        </div>
      </div>
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
