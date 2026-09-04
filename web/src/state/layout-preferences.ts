export const PROJECT_NAVIGATION_MIN_WIDTH = 240;
export const PROJECT_NAVIGATION_DEFAULT_WIDTH = 280;
export const PROJECT_NAVIGATION_MAX_WIDTH = 480;
export const PROJECT_NAVIGATION_RAIL_WIDTH = 48;
export const WORK_PANEL_MIN_WIDTH = 320;
export const WORK_PANEL_DEFAULT_WIDTH = 420;
export const WORK_PANEL_MAX_WIDTH = 720;
export const WORK_PANEL_RAIL_WIDTH = 48;
export const CONVERSATION_MIN_WIDTH = 560;
export const WORKBENCH_LAYOUT_STORAGE_KEY = 'orion.web.workbench-layout.v2';
export const LEGACY_WORK_PANEL_STORAGE_KEY = 'orion.web.work-panel.v1';

export type WorkPanelId = 'agent' | 'review' | 'terminal' | 'files' | 'git';
export type AgentPanelId = 'goal' | 'activity' | 'integrations' | 'diagnostics';

/** v0.3.8 — Canonical panel order used when the stored preference has no order. */
export const DEFAULT_WORK_PANEL_ORDER: readonly WorkPanelId[] = [
  'agent',
  'review',
  'terminal',
  'files',
  'git',
];
export type WorkbenchColumnMode = 'dock' | 'rail' | 'drawer';

export interface WorkbenchLayoutPreferenceV2 {
  readonly schemaVersion: 2;
  readonly projectNavigation: {
    readonly expanded: boolean;
    readonly widthPx: number;
  };
  readonly workPanel: {
    readonly expanded: boolean;
    readonly widthPx: number;
    readonly activePanel: WorkPanelId;
    readonly agentPanel: AgentPanelId;
    /** v0.3.8 — Optional user-chosen icon order in the vertical rail. */
    readonly order?: readonly WorkPanelId[];
  };
}

export interface WorkbenchColumnsV1 {
  readonly projectNavigation: {
    readonly mode: WorkbenchColumnMode;
    readonly widthPx: number;
  };
  readonly conversationWidthPx: number;
  readonly workPanel: {
    readonly mode: WorkbenchColumnMode;
    readonly widthPx: number;
  };
}

export const defaultWorkbenchLayoutPreference: WorkbenchLayoutPreferenceV2 = Object.freeze({
  schemaVersion: 2,
  projectNavigation: Object.freeze({
    expanded: true,
    widthPx: PROJECT_NAVIGATION_DEFAULT_WIDTH,
  }),
  workPanel: Object.freeze({
    expanded: true,
    widthPx: WORK_PANEL_DEFAULT_WIDTH,
    activePanel: 'agent',
    agentPanel: 'goal',
  }),
});

/**
 * Solve the rendered columns without mutating the stored desktop preferences.
 * The right panel concedes first, then becomes a rail; below 760px both sides
 * become modal drawers and the conversation owns the full container width.
 */
export function computeWorkbenchColumns(
  containerWidth: number,
  preference: WorkbenchLayoutPreferenceV2
): WorkbenchColumnsV1 {
  const width = normalizeContainerWidth(containerWidth);
  const preferredNavigationWidth = clampProjectNavigationWidth(
    preference.projectNavigation.widthPx
  );
  const preferredWorkPanelWidth = clampStoredWorkPanelWidth(preference.workPanel.widthPx);

  if (width <= 760) {
    return Object.freeze({
      projectNavigation: Object.freeze({ mode: 'drawer', widthPx: 0 }),
      conversationWidthPx: width,
      workPanel: Object.freeze({ mode: 'drawer', widthPx: 0 }),
    });
  }

  if (width <= 1180) {
    const availableForNavigation = width - CONVERSATION_MIN_WIDTH;
    const navigationCanDock =
      preference.projectNavigation.expanded &&
      availableForNavigation >= PROJECT_NAVIGATION_MIN_WIDTH;
    const navigationMode: WorkbenchColumnMode = navigationCanDock
      ? 'dock'
      : preference.projectNavigation.expanded
        ? 'drawer'
        : 'rail';
    const navigationWidth =
      navigationMode === 'dock'
        ? Math.min(preferredNavigationWidth, availableForNavigation)
        : navigationMode === 'rail'
          ? PROJECT_NAVIGATION_RAIL_WIDTH
          : 0;
    return Object.freeze({
      projectNavigation: Object.freeze({
        mode: navigationMode,
        widthPx: navigationWidth,
      }),
      conversationWidthPx: Math.max(0, width - navigationWidth),
      workPanel: Object.freeze({ mode: 'drawer', widthPx: 0 }),
    });
  }

  const navigationWidth = preference.projectNavigation.expanded
    ? preferredNavigationWidth
    : PROJECT_NAVIGATION_RAIL_WIDTH;
  const availableForWorkPanel = width - navigationWidth - CONVERSATION_MIN_WIDTH;
  const workPanelCanDock =
    preference.workPanel.expanded && availableForWorkPanel >= WORK_PANEL_MIN_WIDTH;
  const workPanelWidth = workPanelCanDock
    ? Math.min(preferredWorkPanelWidth, availableForWorkPanel)
    : WORK_PANEL_RAIL_WIDTH;

  return Object.freeze({
    projectNavigation: Object.freeze({
      mode: preference.projectNavigation.expanded ? 'dock' : 'rail',
      widthPx: navigationWidth,
    }),
    conversationWidthPx: Math.max(0, width - navigationWidth - workPanelWidth),
    workPanel: Object.freeze({
      mode: workPanelCanDock ? 'dock' : 'rail',
      widthPx: workPanelWidth,
    }),
  });
}

export function clampProjectNavigationWidth(width: number): number {
  const finite = Number.isFinite(width) ? Math.round(width) : PROJECT_NAVIGATION_DEFAULT_WIDTH;
  return Math.min(PROJECT_NAVIGATION_MAX_WIDTH, Math.max(PROJECT_NAVIGATION_MIN_WIDTH, finite));
}

export function clampStoredWorkPanelWidth(width: number): number {
  const finite = Number.isFinite(width) ? Math.round(width) : WORK_PANEL_DEFAULT_WIDTH;
  return Math.min(WORK_PANEL_MAX_WIDTH, Math.max(WORK_PANEL_MIN_WIDTH, finite));
}

export function parseWorkbenchLayoutPreference(
  raw: string | null,
  legacyRaw: string | null = null
): WorkbenchLayoutPreferenceV2 {
  if (!raw) return parseLegacyWorkPanelPreference(legacyRaw);
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.schemaVersion !== 2) {
      return defaultWorkbenchLayoutPreference;
    }
    const projectNavigation = isRecord(value.projectNavigation) ? value.projectNavigation : {};
    const workPanel = isRecord(value.workPanel) ? value.workPanel : {};
    return freezePreference({
      schemaVersion: 2,
      projectNavigation: {
        expanded:
          typeof projectNavigation.expanded === 'boolean' ? projectNavigation.expanded : true,
        widthPx: clampProjectNavigationWidth(Number(projectNavigation.widthPx)),
      },
      workPanel: {
        expanded: typeof workPanel.expanded === 'boolean' ? workPanel.expanded : true,
        widthPx: clampStoredWorkPanelWidth(Number(workPanel.widthPx)),
        activePanel: isWorkPanel(workPanel.activePanel) ? workPanel.activePanel : 'agent',
        agentPanel: isAgentPanel(workPanel.agentPanel) ? workPanel.agentPanel : 'goal',
        order: normalizeWorkPanelOrder(workPanel.order),
      },
    });
  } catch {
    return defaultWorkbenchLayoutPreference;
  }
}

export function loadWorkbenchLayoutPreference(): WorkbenchLayoutPreferenceV2 {
  const browser = browserEnvironment();
  if (!browser) return defaultWorkbenchLayoutPreference;
  try {
    return parseWorkbenchLayoutPreference(
      browser.localStorage.getItem(WORKBENCH_LAYOUT_STORAGE_KEY),
      browser.localStorage.getItem(LEGACY_WORK_PANEL_STORAGE_KEY)
    );
  } catch {
    return defaultWorkbenchLayoutPreference;
  }
}

export function saveWorkbenchLayoutPreference(value: WorkbenchLayoutPreferenceV2): void {
  const browser = browserEnvironment();
  if (!browser) return;
  try {
    browser.localStorage.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Preferences are optional. A blocked or full storage area must not break the Workbench.
  }
}

function parseLegacyWorkPanelPreference(raw: string | null): WorkbenchLayoutPreferenceV2 {
  if (!raw) return defaultWorkbenchLayoutPreference;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.schemaVersion !== 1) {
      return defaultWorkbenchLayoutPreference;
    }
    return freezePreference({
      schemaVersion: 2,
      projectNavigation: {
        expanded: true,
        widthPx: PROJECT_NAVIGATION_DEFAULT_WIDTH,
      },
      workPanel: {
        expanded: typeof value.expanded === 'boolean' ? value.expanded : true,
        widthPx: clampStoredWorkPanelWidth(Number(value.widthPx)),
        activePanel: isWorkPanel(value.activePanel) ? value.activePanel : 'agent',
        agentPanel: isAgentPanel(value.agentPanel) ? value.agentPanel : 'goal',
      },
    });
  } catch {
    return defaultWorkbenchLayoutPreference;
  }
}

function freezePreference(value: WorkbenchLayoutPreferenceV2): WorkbenchLayoutPreferenceV2 {
  return Object.freeze({
    schemaVersion: 2,
    projectNavigation: Object.freeze({ ...value.projectNavigation }),
    workPanel: Object.freeze({ ...value.workPanel }),
  });
}

function normalizeContainerWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 1440;
  return Math.max(320, Math.round(width));
}

function browserEnvironment(): {
  readonly localStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
} | null {
  const candidate = globalThis as typeof globalThis & {
    readonly window?: {
      readonly localStorage: {
        getItem(key: string): string | null;
        setItem(key: string, value: string): void;
      };
    };
  };
  return candidate.window ?? null;
}

/**
 * v0.3.8 — Accept a stored icon order only when it is a full permutation of the
 * five panels; anything shorter, duplicated or with unknown ids falls back to
 * the canonical order.
 */
export function normalizeWorkPanelOrder(value: unknown): readonly WorkPanelId[] | undefined {
  if (!Array.isArray(value) || value.length !== DEFAULT_WORK_PANEL_ORDER.length) return undefined;
  const seen = new Set<string>();
  for (const id of value) {
    if (!isWorkPanel(id) || seen.has(id)) return undefined;
    seen.add(id);
  }
  return Object.freeze([...value]) as readonly WorkPanelId[];
}

function isWorkPanel(value: unknown): value is WorkPanelId {
  return ['agent', 'review', 'terminal', 'files', 'git'].includes(String(value));
}

function isAgentPanel(value: unknown): value is AgentPanelId {
  return ['goal', 'activity', 'integrations', 'diagnostics'].includes(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
