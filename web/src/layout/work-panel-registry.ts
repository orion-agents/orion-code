import type { WorkPanelId } from '../state/layout-preferences';
import { isWorkPanel } from '../state/layout-preferences';
import type { IconName } from '../components/Icon';

export interface WorkPanelRegistration {
  readonly id: WorkPanelId;
  /** Human label used by rail tooltips, headers and aria-labels. */
  readonly label: string;
  /** Icon name understood by the shared `<Icon>` component. */
  readonly icon: IconName;
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

const PANEL_META: Readonly<
  Record<
    WorkPanelId,
    { readonly label: string; readonly icon: IconName; readonly kind: 'task' | 'resource' }
  >
> = Object.freeze({
  agent: { label: 'Agent', icon: 'spark', kind: 'task' },
  review: { label: '审阅', icon: 'edit', kind: 'resource' },
  terminal: { label: '终端', icon: 'terminal', kind: 'resource' },
  files: { label: '文件', icon: 'workspace', kind: 'resource' },
  git: { label: 'Git', icon: 'branch', kind: 'resource' },
});

export const WORK_PANEL_REGISTRY: ReadonlyMap<WorkPanelId, WorkPanelRegistration> = new Map(
  WORK_PANEL_ORDER.map(id => {
    const meta = PANEL_META[id];
    return [
      id,
      Object.freeze({
        id,
        label: meta.label,
        icon: meta.icon,
        kind: meta.kind,
      }) as WorkPanelRegistration,
    ];
  })
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
