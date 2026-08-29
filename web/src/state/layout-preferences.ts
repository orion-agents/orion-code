export const WORK_PANEL_MIN_WIDTH = 320;
export const WORK_PANEL_DEFAULT_WIDTH = 420;
export const WORK_PANEL_MAX_WIDTH = 720;
export const WORK_PANEL_VIEWPORT_RATIO = 0.55;
export const WORKSPACE_RAIL_WIDTH = 280;
export const CONVERSATION_MIN_WIDTH = 560;
export const WORK_PANEL_STORAGE_KEY = 'orion.web.work-panel.v1';

export type WorkPanelId = 'agent' | 'review' | 'terminal' | 'files' | 'git';
export type AgentPanelId = 'goal' | 'activity' | 'integrations' | 'diagnostics';

export interface WorkPanelPreferenceV1 {
  readonly schemaVersion: 1;
  readonly expanded: boolean;
  readonly widthPx: number;
  readonly activePanel: WorkPanelId;
  readonly agentPanel: AgentPanelId;
}

export const defaultWorkPanelPreference: WorkPanelPreferenceV1 = Object.freeze({
  schemaVersion: 1,
  expanded: true,
  widthPx: WORK_PANEL_DEFAULT_WIDTH,
  activePanel: 'agent',
  agentPanel: 'goal',
});

export function maximumWorkPanelWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return WORK_PANEL_MAX_WIDTH;
  const availableAfterPrimaryColumns = Math.floor(
    viewportWidth - WORKSPACE_RAIL_WIDTH - CONVERSATION_MIN_WIDTH
  );
  return Math.max(
    WORK_PANEL_MIN_WIDTH,
    Math.min(
      WORK_PANEL_MAX_WIDTH,
      Math.floor(viewportWidth * WORK_PANEL_VIEWPORT_RATIO),
      availableAfterPrimaryColumns
    )
  );
}

export function clampWorkPanelWidth(width: number, viewportWidth: number): number {
  const finite = Number.isFinite(width) ? Math.round(width) : WORK_PANEL_DEFAULT_WIDTH;
  return Math.min(maximumWorkPanelWidth(viewportWidth), Math.max(WORK_PANEL_MIN_WIDTH, finite));
}

export function parseWorkPanelPreference(
  raw: string | null,
  _viewportWidth: number
): WorkPanelPreferenceV1 {
  if (!raw) return defaultWorkPanelPreference;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.schemaVersion !== 1) {
      return defaultWorkPanelPreference;
    }
    return Object.freeze({
      schemaVersion: 1,
      expanded: typeof value.expanded === 'boolean' ? value.expanded : true,
      widthPx: clampStoredWorkPanelWidth(Number(value.widthPx)),
      activePanel: isWorkPanel(value.activePanel) ? value.activePanel : 'agent',
      agentPanel: isAgentPanel(value.agentPanel) ? value.agentPanel : 'goal',
    });
  } catch {
    return defaultWorkPanelPreference;
  }
}

export function loadWorkPanelPreference(): WorkPanelPreferenceV1 {
  const browser = browserEnvironment();
  if (!browser) return defaultWorkPanelPreference;
  try {
    return parseWorkPanelPreference(
      browser.localStorage.getItem(WORK_PANEL_STORAGE_KEY),
      browser.innerWidth
    );
  } catch {
    return defaultWorkPanelPreference;
  }
}

export function saveWorkPanelPreference(value: WorkPanelPreferenceV1): void {
  const browser = browserEnvironment();
  if (!browser) return;
  try {
    browser.localStorage.setItem(WORK_PANEL_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Preferences are optional. A blocked or full storage area must not break the Workbench.
  }
}

function clampStoredWorkPanelWidth(width: number): number {
  const finite = Number.isFinite(width) ? Math.round(width) : WORK_PANEL_DEFAULT_WIDTH;
  return Math.min(WORK_PANEL_MAX_WIDTH, Math.max(WORK_PANEL_MIN_WIDTH, finite));
}

function browserEnvironment(): {
  readonly innerWidth: number;
  readonly localStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
} | null {
  const candidate = globalThis as typeof globalThis & {
    readonly window?: {
      readonly innerWidth: number;
      readonly localStorage: {
        getItem(key: string): string | null;
        setItem(key: string, value: string): void;
      };
    };
  };
  return candidate.window ?? null;
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
