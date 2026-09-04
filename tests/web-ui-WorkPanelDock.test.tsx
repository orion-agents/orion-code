/**
 * v0.3.8 — WorkPanelDock vertical-rail rendering contract: rail always present
 * in dock mode, active icon marked, content pane bound to the active panel,
 * re-click/collapse affordances and terminal status badge.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { WorkPanelDock } from '../web/src/layout/WorkPanelDock';
import {
  initialWorkbenchState,
  type WebSessionRuntimeSummaryV1,
  type WorkbenchState,
} from '../web/src/types';
import type { WorkPanelId } from '../web/src/state/layout-preferences';

const ACTIONS = {} as WorkbenchState extends never
  ? never
  : Parameters<typeof WorkPanelDock>[0]['actions'];

function runtime(phase: WebSessionRuntimeSummaryV1['phase']): WebSessionRuntimeSummaryV1 {
  return {
    workspaceId: 'ws-1',
    sessionId: 's1',
    runtimeRevision: 'r1',
    phase,
    pendingApprovalCount: 0,
    resident: false,
    estimatedBytes: 0,
    updatedAt: '2026-09-04T00:00:00.000Z',
  };
}

function stateWith(phase: WebSessionRuntimeSummaryV1['phase'] | undefined): WorkbenchState {
  return {
    ...initialWorkbenchState,
    workspaceId: 'ws-1',
    workspace: '/tmp/demo',
    activeSessionId: 's1',
    sessionRuntimeById: phase ? { s1: runtime(phase) } : {},
  };
}

function render(opts: {
  readonly expanded?: boolean;
  readonly activePanel?: WorkPanelId;
  readonly panelOrder?: readonly WorkPanelId[];
  readonly phase?: WebSessionRuntimeSummaryV1['phase'];
  readonly mode?: 'dock' | 'overlay';
}) {
  const noop = () => undefined;
  return renderToStaticMarkup(
    React.createElement(WorkPanelDock, {
      state: stateWith(opts.phase),
      actions: ACTIONS,
      mode: opts.mode ?? 'dock',
      expanded: opts.expanded ?? true,
      activePanel: opts.activePanel ?? 'review',
      panelOrder: opts.panelOrder,
      agentPanel: 'goal',
      onExpand: noop,
      onCollapse: noop,
      onPanelChange: noop,
      onAgentPanelChange: noop,
      onWidthPreview: noop,
      onWidthCommit: noop,
      width: 420,
      onSendToComposer: noop,
    })
  );
}

describe('WorkPanelDock vertical rail (v0.3.8)', () => {
  it('renders the vertical rail with five icons in canonical order in dock mode', () => {
    const html = render({});
    expect(html).toContain('class="work-panel-rail"');
    expect(html).toContain('aria-orientation="vertical"');
    const ids = [...html.matchAll(/data-work-panel-id="([^"]+)"/g)].map(match => match[1]);
    expect(ids).toEqual(['agent', 'review', 'terminal', 'files', 'git']);
  });

  it('marks the active panel with aria-current and shows its content pane', () => {
    const html = render({ activePanel: 'git' });
    const gitButton = html.slice(html.indexOf('data-work-panel-id="git"'));
    expect(gitButton.slice(0, 260)).toContain('aria-current="page"');
    expect(html).toContain('id="work-panel-detail"');
    expect(html).toContain('aria-label="工作面板内容"');
    expect(html).toContain('<h2>Git</h2>');
    expect(html).toContain('PROJECT WORKSPACE');
  });

  it('applies a stored custom icon order', () => {
    const html = render({ panelOrder: ['terminal', 'review', 'git', 'files', 'agent'] });
    const ids = [...html.matchAll(/data-work-panel-id="([^"]+)"/g)].map(match => match[1]);
    expect(ids).toEqual(['terminal', 'review', 'git', 'files', 'agent']);
  });

  it('keeps only the rail when the dock is collapsed (no detail, no tabs strip)', () => {
    const html = render({ expanded: false });
    expect(html).not.toContain('id="work-panel-detail"');
    expect(html).toContain('class="work-panel-rail"');
    // The old top tab strip is gone.
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tab"');
  });

  it('shows the collapse affordance with expanded=true on the active content', () => {
    const html = render({});
    expect(html).toContain('aria-label="收起工作面板"');
    expect(html).toContain('aria-expanded="true"');
  });

  it('renders the rail horizontally inside the overlay drawer', () => {
    const html = render({ mode: 'overlay', expanded: true });
    expect(html).toContain('class="work-panel-rail work-panel-rail-overlay"');
    expect(html).toContain('aria-orientation="horizontal"');
    expect(html).toContain('aria-label="关闭工作面板"');
  });

  it('lights the terminal icon badge while the foreground session is running', () => {
    const html = render({ phase: 'running' });
    expect(html).toContain('rail-status-dot');
  });

  it('omits the terminal badge for idle sessions', () => {
    const html = render({ phase: 'idle' });
    const terminalButton = html.slice(html.indexOf('data-work-panel-id="terminal"'));
    expect(terminalButton.slice(0, 260)).not.toContain('rail-status-dot');
  });
});
