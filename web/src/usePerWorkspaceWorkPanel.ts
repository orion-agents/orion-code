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
  resolveWorkPanelPreference,
  RIGHT_WORKSPACE_STORAGE_KEY,
  taskSubviewToAgentTab,
  toTaskSubview,
  withWorkPanelPreference,
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

export function usePerWorkspaceWorkPanel(
  workspaceId: string | null,
  legacy: LegacyV2WorkPanel
): {
  readonly value: PerWorkspaceWorkPanelValue;
  readonly update: (patch: PerWorkspaceWorkPanelPatch) => void;
} {
  const [stored, setStored] = useState<WorkbenchLayoutPreferenceV3 | null>(loadStored);

  const effectiveWorkspaceId = workspaceId ?? '__fallback__';
  const migratedSeed = useMemo(
    () => migrateWorkPanelV2ToV3(legacy),
    // legacy changes only at App mount (v2 layout loaded once).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

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
        };
        const next = withWorkPanelPreference(base, effectiveWorkspaceId, nextEntry);
        persist(next);
        return next;
      });
    },
    [effectiveWorkspaceId, migratedSeed]
  );

  return { value, update };
}
