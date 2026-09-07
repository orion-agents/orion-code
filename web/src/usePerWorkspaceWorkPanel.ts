/**
 * v0.3.12 S1.2 — per-workspace right-workspace preference (schema v3) adapter.
 *
 * The App keeps the v2 workPanel block only as the one-shot migration seed
 * (rail `order` stays global in v2). Every live read/write of expanded /
 * active panel / detail width / task subview goes through v3 keyed by the
 * current workspaceId, so a wide detail surface never leaks into other
 * projects. Unknown workspace values fall back to the v3 fallback entry.
 */
import { useCallback, useMemo, useState } from 'react';

import type { AgentPanelId, WorkPanelId } from './state/layout-preferences';
import {
  defaultWorkbenchLayoutPreferenceV3,
  migrateWorkPanelV2ToV3,
  parseRightWorkspaceV3,
  RIGHT_WORKSPACE_STORAGE_KEY,
  taskSubviewToAgentTab,
  toTaskSubview,
  withResourceNavigatorWidth,
  withWorkPanelPreference,
  type ResourceSplitPanelId,
  type WorkbenchLayoutPreferenceV3,
  type WorkPanelPerWorkspacePreference,
} from './state/right-workspace-preferences';

export interface LegacyV2WorkPanel {
  readonly expanded?: boolean;
  readonly widthPx?: number;
  readonly activePanel?: WorkPanelId;
  readonly agentPanel?: AgentPanelId;
}

export interface PerWorkspaceWorkPanelValue {
  readonly expanded: boolean;
  readonly activePanel: 'agent' | 'review' | 'terminal' | 'files' | 'git';
  readonly agentPanel: AgentPanelId;
  /** Detail surface width excluding the 48px rail. */
  readonly detailWidthPx: number;
  readonly workspaceId: string;
  /**
   * v0.3.13 — per-panel navigator column widths for the current workspace.
   * Stored as the navigator width; the live drag preview never persists until
   * the pointer is released.
   */
  readonly resourceNavigatorWidthPx: Readonly<Record<ResourceSplitPanelId, number>>;
}

export interface PerWorkspaceWorkPanelPatch {
  readonly expanded?: boolean;
  readonly activePanel?: PerWorkspaceWorkPanelValue['activePanel'];
  readonly agentPanel?: AgentPanelId;
  readonly detailWidthPx?: number;
}

function isWorkPanelId(value: string): value is PerWorkspaceWorkPanelValue['activePanel'] {
  return ['agent', 'review', 'terminal', 'files', 'git'].includes(value);
}

function loadStored(): WorkbenchLayoutPreferenceV3 | null {
  const browser = globalThis as typeof globalThis & {
    readonly window?: {
      readonly localStorage: {
        getItem(key: string): string | null;
        setItem(key: string, value: string): void;
      };
    };
  };
  try {
    return parseRightWorkspaceV3(
      browser.window?.localStorage.getItem(RIGHT_WORKSPACE_STORAGE_KEY) ?? null
    );
  } catch {
    return null;
  }
}

function persist(value: WorkbenchLayoutPreferenceV3): void {
  const browser = globalThis as typeof globalThis & {
    readonly window?: {
      readonly localStorage: {
        getItem(key: string): string | null;
        setItem(key: string, value: string): void;
      };
    };
  };
  try {
    browser.window?.localStorage.setItem(RIGHT_WORKSPACE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Optional preference; a blocked storage area must not break the Workbench.
  }
}

export interface PerWorkspaceWorkPanelApi {
  readonly value: PerWorkspaceWorkPanelValue;
  readonly update: (patch: PerWorkspaceWorkPanelPatch) => void;
  /**
   * v0.3.13 — persist one panel's navigator column width for the current
   * workspace only. Called on pointer-up / keyboard commit, never during a
   * drag preview.
   */
  readonly setResourceNavigatorWidth: (panel: ResourceSplitPanelId, width: number) => void;
}

export function usePerWorkspaceWorkPanel(
  workspaceId: string | null,
  legacy: LegacyV2WorkPanel
): PerWorkspaceWorkPanelApi {
  const [stored, setStored] = useState<WorkbenchLayoutPreferenceV3 | null>(loadStored);

  const effectiveWorkspaceId = workspaceId ?? '__fallback__';
  // legacy is the v2 layout read once at App mount, so the seed is computed once.
  const migratedSeed = useMemo(() => migrateWorkPanelV2ToV3(legacy), []);

  const value = useMemo<PerWorkspaceWorkPanelValue>(() => {
    const entry =
      stored?.workPanel.byWorkspace[effectiveWorkspaceId] ??
      stored?.workPanel.fallback ??
      migratedSeed;
    return {
      workspaceId: effectiveWorkspaceId,
      expanded: entry.expanded,
      activePanel: isWorkPanelId(entry.activePanel) ? entry.activePanel : 'agent',
      agentPanel: taskSubviewToAgentTab(entry.taskSubview) as AgentPanelId,
      detailWidthPx: entry.detailWidthPx,
      resourceNavigatorWidthPx: entry.resourceNavigatorWidthPx,
    };
  }, [stored, effectiveWorkspaceId, migratedSeed]);

  const update = useCallback(
    (patch: PerWorkspaceWorkPanelPatch) => {
      setStored(current => {
        const base: WorkbenchLayoutPreferenceV3 = current ?? defaultWorkbenchLayoutPreferenceV3();
        const previous =
          base.workPanel.byWorkspace[effectiveWorkspaceId] ??
          base.workPanel.fallback ??
          migratedSeed;
        const nextEntry: WorkPanelPerWorkspacePreference = {
          expanded: patch.expanded ?? previous.expanded,
          activePanel: patch.activePanel ?? previous.activePanel,
          detailWidthPx: patch.detailWidthPx ?? previous.detailWidthPx,
          taskSubview: patch.agentPanel ? toTaskSubview(patch.agentPanel) : previous.taskSubview,
          // v0.3.13 — a drag/detail patch must carry the per-panel navigator
          // widths through; they are only written by setResourceNavigatorWidth.
          resourceNavigatorWidthPx: previous.resourceNavigatorWidthPx,
        };
        const next = withWorkPanelPreference(base, effectiveWorkspaceId, nextEntry);
        persist(next);
        return next;
      });
    },
    [effectiveWorkspaceId, migratedSeed]
  );

  const setResourceNavigatorWidth = useCallback(
    (panel: ResourceSplitPanelId, width: number) => {
      setStored(current => {
        const base: WorkbenchLayoutPreferenceV3 = current ?? defaultWorkbenchLayoutPreferenceV3();
        const next = withResourceNavigatorWidth(base, effectiveWorkspaceId, panel, width);
        persist(next);
        return next;
      });
    },
    [effectiveWorkspaceId]
  );

  return { value, update, setResourceNavigatorWidth };
}
