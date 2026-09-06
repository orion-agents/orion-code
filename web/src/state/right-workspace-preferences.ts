/**
 * v0.3.12 S1 — per-workspace right-workspace preferences (schema v3).
 *
 * v2 stored one global `workPanel` block; v3 keeps the same fields per
 * workspace so a wide detail surface used in one project does not leak into
 * others. v1/v2 values migrate losslessly (old global width becomes the
 * fallback entry; unknown workspace ids use it too). Nothing here throws —
 * storage corruption falls back to safe defaults without blocking the
 * Workbench.
 */
import {
  clampStoredWorkPanelWidth,
  type WorkPanelId,
  WORK_PANEL_RAIL_WIDTH,
  isWorkPanel,
  type AgentPanelId,
} from './layout-preferences';

export const RIGHT_WORKSPACE_STORAGE_KEY = 'orion.web.right-workspace.v3';
export const RIGHT_WORKSPACE_SCHEMA_VERSION = 3;

export type TaskSubviewId = 'overview' | 'activity' | 'capabilities' | 'diagnostics';

export interface WorkPanelPerWorkspacePreference {
  readonly expanded: boolean;
  readonly activePanel: WorkPanelId;
  /** Detail surface width in px (does not include the 48px rail). */
  readonly detailWidthPx: number;
  readonly taskSubview: TaskSubviewId;
}

export interface WorkbenchLayoutPreferenceV3 {
  readonly schemaVersion: 3;
  readonly projectNavigation: {
    readonly expanded: boolean;
    readonly widthPx: number;
  };
  readonly workPanel: {
    readonly byWorkspace: Readonly<Record<string, WorkPanelPerWorkspacePreference>>;
    readonly fallback: WorkPanelPerWorkspacePreference;
  };
}

export const defaultPerWorkspacePreference: WorkPanelPerWorkspacePreference = Object.freeze({
  expanded: true,
  activePanel: 'agent',
  detailWidthPx: 560,
  taskSubview: 'overview',
});

const defaultFallback = defaultPerWorkspacePreference;

export function defaultWorkbenchLayoutPreferenceV3(): WorkbenchLayoutPreferenceV3 {
  return Object.freeze({
    schemaVersion: RIGHT_WORKSPACE_SCHEMA_VERSION,
    projectNavigation: Object.freeze({ expanded: true, widthPx: 280 }),
    workPanel: Object.freeze({
      byWorkspace: Object.freeze({}),
      fallback: defaultFallback,
    }),
  });
}

/** v2 → v3: one global workPanel entry becomes the fallback and the basis for a given workspace. */
export function migrateWorkPanelV2ToV3(value: {
  readonly expanded?: boolean;
  readonly widthPx?: number;
  readonly activePanel?: WorkPanelId;
  readonly agentPanel?: AgentPanelId;
}): WorkPanelPerWorkspacePreference {
  const taskSubview = toTaskSubview(value.agentPanel);
  return Object.freeze({
    expanded: value.expanded !== false,
    activePanel: isWorkPanel(value.activePanel) ? value.activePanel : 'agent',
    detailWidthPx: Math.max(
      320,
      clampStoredWorkPanelWidth(
        Number.isFinite(value.widthPx) ? Number(value.widthPx) - WORK_PANEL_RAIL_WIDTH : 560
      )
    ),
    taskSubview,
  });
}

export function resolveWorkPanelPreference(
  preference: WorkbenchLayoutPreferenceV3,
  workspaceId: string
): WorkPanelPerWorkspacePreference {
  return preference.workPanel.byWorkspace[workspaceId] ?? preference.workPanel.fallback;
}

export function withWorkPanelPreference(
  preference: WorkbenchLayoutPreferenceV3,
  workspaceId: string,
  update: WorkPanelPerWorkspacePreference
): WorkbenchLayoutPreferenceV3 {
  const next: WorkbenchLayoutPreferenceV3 = {
    schemaVersion: RIGHT_WORKSPACE_SCHEMA_VERSION,
    projectNavigation: preference.projectNavigation,
    workPanel: {
      ...preference.workPanel,
      byWorkspace: Object.freeze({
        ...preference.workPanel.byWorkspace,
        [workspaceId]: Object.freeze({ ...update }),
      }),
    },
  };
  return Object.freeze(next);
}

/**
 * Parse a stored v3 value. Returns null when the raw value is missing or not a
 * v3 envelope so callers can decide between migration and defaults.
 */
export function parseRightWorkspaceV3(raw: string | null): WorkbenchLayoutPreferenceV3 | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.schemaVersion !== RIGHT_WORKSPACE_SCHEMA_VERSION) return null;
    const projectNavigation = isRecord(value.projectNavigation) ? value.projectNavigation : {};
    const workPanel = isRecord(value.workPanel) ? value.workPanel : {};
    const byWorkspace = isRecord(workPanel.byWorkspace) ? workPanel.byWorkspace : {};
    const fallbackRaw = isRecord(workPanel.fallback) ? workPanel.fallback : {};
    const normalizedByWorkspace: Record<string, WorkPanelPerWorkspacePreference> = {};
    for (const [id, rawEntry] of Object.entries(byWorkspace)) {
      if (isRecord(rawEntry)) normalizedByWorkspace[id] = normalizeEntry(rawEntry);
    }
    return Object.freeze({
      schemaVersion: RIGHT_WORKSPACE_SCHEMA_VERSION,
      projectNavigation: Object.freeze({
        expanded: projectNavigation.expanded !== false,
        widthPx: clampStoredWorkPanelWidth(Number(projectNavigation.widthPx) || 280),
      }),
      workPanel: Object.freeze({
        byWorkspace: Object.freeze(normalizedByWorkspace),
        fallback: normalizeEntry(fallbackRaw),
      }),
    });
  } catch {
    return null;
  }
}

function normalizeEntry(value: Record<string, unknown>): WorkPanelPerWorkspacePreference {
  return Object.freeze({
    expanded: value.expanded !== false,
    activePanel: isWorkPanel(value.activePanel) ? value.activePanel : 'agent',
    detailWidthPx: sanitizeDetailWidth(Number(value.detailWidthPx)),
    taskSubview: toTaskSubview(value.taskSubview),
  });
}

export function sanitizeDetailWidth(width: number): number {
  if (!Number.isFinite(width)) return defaultPerWorkspacePreference.detailWidthPx;
  return Math.min(3200, Math.max(360, Math.round(width)));
}

export function toTaskSubview(value: unknown): TaskSubviewId {
  const text = String(value);
  // v2 Agent tab aliases migrate onto the v3 task subview vocabulary.
  if (text === 'goal' || text === 'overview') return 'overview';
  if (text === 'activity') return 'activity';
  if (text === 'integrations' || text === 'capabilities') return 'capabilities';
  if (text === 'diagnostics') return 'diagnostics';
  return 'overview';
}

export function taskSubviewToAgentTab(subview: TaskSubviewId): string {
  switch (subview) {
    case 'overview':
      return 'goal';
    case 'activity':
      return 'activity';
    case 'capabilities':
      return 'integrations';
    case 'diagnostics':
      return 'diagnostics';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
