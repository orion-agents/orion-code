/**
 * v0.3.12 S1 / v0.3.13 S1 — per-workspace right-workspace preferences (schema v4).
 *
 * v2 stored one global `workPanel` block; v3 keeps the same fields per
 * workspace so a wide detail surface used in one project does not leak into
 * others. v4 adds per-panel navigator column widths (`files` / `git` /
 * `review`) to each per-workspace entry so shrinking a directory tree in one
 * project never affects another panel or project.
 *
 * The storage key stays `.v3` on purpose: the envelope shape is unchanged and
 * old v3 entries simply lack the navigator record, which normalizes to the
 * three 300px defaults. A stored `schemaVersion: 3` parses fine and is
 * re-persisted as 4 on the next write. Nothing here throws — storage
 * corruption falls back to safe defaults without blocking the Workbench.
 */
import {
  clampStoredWorkPanelWidth,
  type WorkPanelId,
  WORK_PANEL_RAIL_WIDTH,
  isWorkPanel,
  type AgentPanelId,
} from './layout-preferences';

export const RIGHT_WORKSPACE_STORAGE_KEY = 'orion.web.right-workspace.v3';
export const RIGHT_WORKSPACE_SCHEMA_VERSION = 4;

export type TaskSubviewId = 'overview' | 'activity' | 'capabilities' | 'diagnostics';

export type ResourceSplitPanelId = 'files' | 'git' | 'review';

export interface WorkPanelPerWorkspacePreference {
  readonly expanded: boolean;
  readonly activePanel: WorkPanelId;
  /** Detail surface width in px (does not include the 48px rail). */
  readonly detailWidthPx: number;
  readonly taskSubview: TaskSubviewId;
  /**
   * v0.3.13 — per-panel navigator (tree / changes / review list) column width.
   * Storing the navigator width (not the content width) matches the intent of
   * "shrink the directory to give the content room".
   */
  readonly resourceNavigatorWidthPx: Readonly<Record<ResourceSplitPanelId, number>>;
}

export interface WorkbenchLayoutPreferenceV3 {
  /**
   * The envelope is currently written as v4 (per-panel navigator widths).
   * The `V3` type name is historical: the storage key stayed `.v3` and the
   * parser still accepts a stored `3` envelope, normalizing it to v4.
   */
  readonly schemaVersion: 4;
  readonly projectNavigation: {
    readonly expanded: boolean;
    readonly widthPx: number;
  };
  readonly workPanel: {
    readonly byWorkspace: Readonly<Record<string, WorkPanelPerWorkspacePreference>>;
    readonly fallback: WorkPanelPerWorkspacePreference;
  };
}

export const RESOURCE_NAVIGATOR_DEFAULT_WIDTH = 300;
export const RESOURCE_NAVIGATOR_MIN_WIDTH = 160;
export const RESOURCE_NAVIGATOR_MAX_WIDTH = 420;
/** Content must keep at least this much room in a wide panel. */
export const RESOURCE_CONTENT_MIN_WIDTH = 280;

export const RESOURCE_SPLIT_PANELS: readonly ResourceSplitPanelId[] = ['files', 'git', 'review'];

export const defaultResourceNavigatorWidths: Readonly<Record<ResourceSplitPanelId, number>> =
  Object.freeze({
    files: RESOURCE_NAVIGATOR_DEFAULT_WIDTH,
    git: RESOURCE_NAVIGATOR_DEFAULT_WIDTH,
    review: RESOURCE_NAVIGATOR_DEFAULT_WIDTH,
  });

/** Static store/render clamp for a navigator column width in a wide layout. */
export function clampResourceNavigatorWidth(width: number): number {
  if (!Number.isFinite(width)) return RESOURCE_NAVIGATOR_DEFAULT_WIDTH;
  return Math.min(
    RESOURCE_NAVIGATOR_MAX_WIDTH,
    Math.max(RESOURCE_NAVIGATOR_MIN_WIDTH, Math.round(width))
  );
}

/**
 * Dynamic ceiling while the split container is wide enough for two columns:
 * 48% of the content box, and never so wide the content drops below 280px.
 * Falls back to the 160px floor for callers that ask before the layout is
 * measured; the render layer hides the handle and goes single-column when the
 * container is <= 620px, so this is only authoritative in the wide layout.
 */
export function resolveResourceNavigatorMaxWidth(panelContentWidthPx: number): number {
  const panelWidth = Number.isFinite(panelContentWidthPx) ? panelContentWidthPx : 0;
  const ceiling = Math.min(
    RESOURCE_NAVIGATOR_MAX_WIDTH,
    panelWidth * 0.48,
    panelWidth - RESOURCE_CONTENT_MIN_WIDTH
  );
  return Math.max(RESOURCE_NAVIGATOR_MIN_WIDTH, Math.floor(ceiling));
}

export const defaultPerWorkspacePreference: WorkPanelPerWorkspacePreference = Object.freeze({
  expanded: true,
  activePanel: 'agent',
  detailWidthPx: 560,
  taskSubview: 'overview',
  resourceNavigatorWidthPx: defaultResourceNavigatorWidths,
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

/** v2 → v4: one global workPanel entry becomes the fallback and the basis for a given workspace. */
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
    resourceNavigatorWidthPx: defaultResourceNavigatorWidths,
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
  const previous = preference.workPanel.byWorkspace[workspaceId] ?? preference.workPanel.fallback;
  const nextEntry = Object.freeze({
    // A caller patch built from a subset of fields (e.g. the hook's drag patch)
    // must not silently drop the per-panel navigator widths added in v4.
    ...previous,
    ...update,
    resourceNavigatorWidthPx: update.resourceNavigatorWidthPx ?? previous.resourceNavigatorWidthPx,
  });
  const next: WorkbenchLayoutPreferenceV3 = {
    schemaVersion: RIGHT_WORKSPACE_SCHEMA_VERSION,
    projectNavigation: preference.projectNavigation,
    workPanel: {
      ...preference.workPanel,
      byWorkspace: Object.freeze({
        ...preference.workPanel.byWorkspace,
        [workspaceId]: nextEntry,
      }),
    },
  };
  return Object.freeze(next);
}

/**
 * Per-workspace + per-panel navigator width update. Only the current panel's
 * value for the current workspace is written; other panels and workspaces are
 * left untouched. The stored value is clamped to the static [160, 420] range —
 * the render layer re-clamps against the live dynamic ceiling.
 */
export function withResourceNavigatorWidth(
  preference: WorkbenchLayoutPreferenceV3,
  workspaceId: string,
  panelId: ResourceSplitPanelId,
  navigatorWidthPx: number
): WorkbenchLayoutPreferenceV3 {
  const entry = resolveWorkPanelPreference(preference, workspaceId);
  return withWorkPanelPreference(preference, workspaceId, {
    ...entry,
    resourceNavigatorWidthPx: Object.freeze({
      ...entry.resourceNavigatorWidthPx,
      [panelId]: clampResourceNavigatorWidth(navigatorWidthPx),
    }),
  });
}

/**
 * Parse a stored value. Accepts both v3 and v4 envelopes (they share the
 * `.v3` storage key); v3 entries lack the navigator record and normalize to
 * the 300px defaults. Returns null when the raw value is missing, not an
 * object, or carries an older schemaVersion so callers can decide between
 * migration and defaults.
 */
export function parseRightWorkspaceV3(raw: string | null): WorkbenchLayoutPreferenceV3 | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return null;
    const version = value.schemaVersion;
    if (version !== 3 && version !== RIGHT_WORKSPACE_SCHEMA_VERSION) return null;
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
    resourceNavigatorWidthPx: normalizeNavigatorWidths(value.resourceNavigatorWidthPx),
  });
}

function normalizeNavigatorWidths(value: unknown): Readonly<Record<ResourceSplitPanelId, number>> {
  if (!isRecord(value)) return defaultResourceNavigatorWidths;
  const widths: Record<ResourceSplitPanelId, number> = {
    ...defaultResourceNavigatorWidths,
  };
  for (const panel of RESOURCE_SPLIT_PANELS) {
    const raw = Number(value[panel]);
    if (Number.isFinite(raw)) widths[panel] = clampResourceNavigatorWidth(raw);
  }
  return Object.freeze(widths);
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
