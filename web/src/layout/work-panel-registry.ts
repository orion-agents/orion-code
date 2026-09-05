/**
 * v0.3.12 S1 — single source of truth for the five right-side panels.
 *
 * `WorkPanelDock` and friends used to hard-code panel order/labels/icons in a
 * few places. Everything a rail / detail surface / keyboard shortcut needs is
 * declared once here so five panels stay in exactly one registry.
 */
import type { WorkPanelId } from '../state/layout-preferences';
import { isWorkPanel } from '../state/layout-preferences';

export interface WorkPanelRegistration {
  readonly id: WorkPanelId;
  /** i18n message key or literal label used by rail tooltips and headers. */
  readonly labelKey: string;
  /** Icon name understood by the shared `<Icon>` component. */
  readonly icon: string;
  /** Keyboard shortcut token, matched like other `findShortcut` entries. */
  readonly shortcutId: string;
  /**
   * 'task' panels supervise the agent session; 'resource' panels show
   * repository/runtime state. Resources mount active-only and unmount their DOM
   * when inactive; the terminal is treated as a resource that keeps its PTY.
   */
  readonly kind: 'task' | 'resource';
}

export const WORK_PANEL_ORDER: readonly WorkPanelId[] = [
  'agent',
  'review',
  'terminal',
  'files',
  'git',
];

export const WORK_PANEL_REGISTRY: ReadonlyMap<WorkPanelId, WorkPanelRegistration> = new Map(
  WORK_PANEL_ORDER.map(id => [id, Object.freeze(registrationFor(id)) as WorkPanelRegistration])
);

export function workPanelRegistration(id: WorkPanelId): WorkPanelRegistration {
  const entry = WORK_PANEL_REGISTRY.get(id);
  if (!entry) throw new Error(`Unknown work panel: ${id}`);
  return entry;
}

export function workPanelById(value: unknown): WorkPanelRegistration | null {
  if (!isWorkPanel(value)) return null;
  return workPanelRegistration(value);
}

export function isResourcePanel(id: WorkPanelId): boolean {
  return workPanelRegistration(id).kind === 'resource';
}

function registrationFor(id: WorkPanelId): WorkPanelRegistration {
  switch (id) {
    case 'agent':
      return {
        id,
        labelKey: 'panel.agent',
        icon: 'sparkles',
        shortcutId: 'focus-agent-panel',
        kind: 'task',
      };
    case 'review':
      return {
        id,
        labelKey: 'panel.review',
        icon: 'check-circle',
        shortcutId: 'focus-review-panel',
        kind: 'resource',
      };
    case 'terminal':
      return {
        id,
        labelKey: 'panel.terminal',
        icon: 'terminal',
        shortcutId: 'focus-terminal-panel',
        kind: 'resource',
      };
    case 'files':
      return {
        id,
        labelKey: 'panel.files',
        icon: 'folder',
        shortcutId: 'focus-files-panel',
        kind: 'resource',
      };
    case 'git':
      return {
        id,
        labelKey: 'panel.git',
        icon: 'git-branch',
        shortcutId: 'focus-git-panel',
        kind: 'resource',
      };
  }
}
