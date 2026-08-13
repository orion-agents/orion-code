import type { TuiStatusItem } from '../services/global-config';
import { contextUsageStatusText, researchProjectionLabel } from '../runtime/ui-view-model';
import type { TuiUiState } from './state';
import type { PixelHunterPose } from './pixel-mascot';

export interface TuiChromeSegment {
  id: TuiStatusItem;
  label: string;
  priority: number;
  critical?: boolean;
  tone?: 'mode-build' | 'mode-plan' | 'mode-auto' | 'mode-goal' | 'warning' | 'muted';
}

export interface TuiChromeViewModel {
  phase: 'ready' | 'working' | 'waiting' | 'error' | 'paused';
  pose: PixelHunterPose;
  promptMode: 'normal' | 'plan' | 'auto' | 'goal';
  segments: TuiChromeSegment[];
  hint: string;
}

const DEFAULT_ITEMS: TuiStatusItem[] = [
  'mode',
  'goal',
  'model',
  'effort',
  'context',
  'permission',
  'queue',
  'activity',
];

export function createTuiChromeViewModel(
  state: TuiUiState,
  requested: readonly TuiStatusItem[] = DEFAULT_ITEMS
): TuiChromeViewModel {
  const waiting = state.overlay?.type === 'permission';
  const errored = state.statusState.phase === 'error';
  const paused = state.goal?.status === 'paused';
  const phase = errored
    ? 'error'
    : waiting
      ? 'waiting'
      : paused
        ? 'paused'
        : state.processing
          ? 'working'
          : 'ready';
  const pose: PixelHunterPose = errored
    ? 'error'
    : waiting
      ? 'waiting'
      : paused
        ? 'paused'
        : state.statusState.activeTools > 0
          ? 'tool'
          : state.processing
            ? 'thinking'
            : state.statusMessage.toLowerCase().includes('success')
              ? 'success'
              : 'ready';

  const all = new Map<TuiStatusItem, TuiChromeSegment>();
  const baseModeLabel =
    state.agentMode.baseMode === 'interactive' ? 'BUILD' : state.agentMode.baseMode.toUpperCase();
  const pendingModeLabel = state.agentMode.pendingBaseMode
    ? state.agentMode.pendingBaseMode === 'interactive'
      ? 'BUILD'
      : state.agentMode.pendingBaseMode.toUpperCase()
    : null;
  const goalMode = Boolean(state.goal);
  const modeLabel = `MODE ${goalMode ? `GOAL · ${baseModeLabel}` : baseModeLabel}${pendingModeLabel ? ` → ${pendingModeLabel} NEXT` : ''}`;
  const baseTone =
    state.agentMode.baseMode === 'plan'
      ? 'mode-plan'
      : state.agentMode.baseMode === 'auto'
        ? 'mode-auto'
        : 'mode-build';
  all.set('mode', {
    id: 'mode',
    label: modeLabel,
    priority: Number.MAX_SAFE_INTEGER,
    critical: true,
    tone: goalMode ? 'mode-goal' : baseTone,
  });
  if (state.goal) {
    const progress = state.goal.criteria?.total
      ? ` ${state.goal.criteria.passed}/${state.goal.criteria.total}`
      : '';
    const objective = ` ${state.goal.objective}`;
    const plan = state.goal.planPhase ? ` ${state.goal.planPhase}` : '';
    const budget = state.goal.tokenBudget
      ? ` ${state.goal.tokensUsed}/${state.goal.tokenBudget}tok`
      : '';
    const statusShowsAudit = state.statusMessage.startsWith('Goal audit failed (');
    const audit =
      !statusShowsAudit && state.goal.auditRemaining?.[0]
        ? ` audit:${state.goal.auditRemaining[0]}`
        : '';
    const next =
      state.goal.nextAction && !state.statusMessage.includes(state.goal.nextAction)
        ? ` next:${state.goal.nextAction}`
        : '';
    const actions = state.goal.stopReason
      ? ` ${(state.goal.stopReason.match(/\/(?:goal|target)\s+(?:resume|exit)\b/giu) ?? []).join(' ')}`
      : '';
    all.set('goal', {
      id: 'goal',
      label: `GOAL goal:${state.goal.status}${actions}${progress}${objective}${plan}${budget}${audit}${next}`,
      priority: 95,
      critical: true,
    });
  }
  const snapshot = state.statusState.snapshot;
  const modelStatus = snapshot?.model
    ? `model=${snapshot.model}`
    : state.statusMessage.match(/\bmodel=[^\s]+/u)
      ? state.statusMessage
      : undefined;
  if (modelStatus) {
    all.set('model', {
      id: 'model',
      label: modelStatus,
      priority: 105,
      critical: true,
    });
  }
  if (state.effort) {
    const value = 'effective' in state.effort ? (state.effort.effective ?? 'auto') : 'off';
    all.set('effort', { id: 'effort', label: `EFFORT ${value}`, priority: 35 });
  }
  const context = contextUsageStatusText(snapshot?.context);
  if (context) all.set('context', { id: 'context', label: context.toUpperCase(), priority: 50 });
  all.set('permission', {
    id: 'permission',
    label: `PERM ${state.permissionMode}`,
    priority: waiting ? 110 : 90,
    critical: waiting,
    tone: waiting ? 'warning' : 'muted',
  });
  if (state.followupQueue.items.length > 0) {
    all.set('queue', {
      id: 'queue',
      label: `QUEUE ${state.followupQueue.items.length}/${state.followupQueue.limit}`,
      priority: 80,
      critical: true,
    });
  }
  const active = state.statusState.activeTools + state.statusState.activeSubtasks;
  const statusDuplicatesGoal = Boolean(
    state.goal &&
    (state.statusMessage.startsWith('Goal restored ') ||
      (state.goal.status !== 'complete' &&
        state.statusMessage.startsWith(`Goal ${state.goal.status}:`)))
  );
  const researchStatus = state.research ? researchProjectionLabel(state.research) : '';
  const activityParts = [
    researchStatus,
    !statusDuplicatesGoal && !state.statusMessage.startsWith(modelStatus ?? '\0') && !researchStatus
      ? state.statusMessage
      : '',
    active > 0 ? `ACTIVE ${active}` : '',
  ].filter(Boolean);
  if (activityParts.length > 0) {
    const lifecycleDecision =
      state.statusMessage.startsWith('Goal complete:') ||
      /^Goal (?:evidence|audit) (?:passed|failed)/u.test(state.statusMessage);
    all.set('activity', {
      id: 'activity',
      label: activityParts.join(' · '),
      // Evidence/audit decisions are state transitions, not decorative activity.
      // Keep them visible ahead of the model and Goal summary so operators and
      // PTY automation can observe the transition before the next tool prompt.
      priority: lifecycleDecision ? 120 : 70,
      critical: lifecycleDecision,
    });
  }

  return {
    phase,
    pose,
    promptMode: state.goal
      ? 'goal'
      : state.agentMode.baseMode === 'plan'
        ? 'plan'
        : state.agentMode.baseMode === 'auto'
          ? 'auto'
          : 'normal',
    segments: (['mode', ...requested.filter(id => id !== 'mode')] as TuiStatusItem[])
      .map(id => all.get(id))
      .filter((item): item is TuiChromeSegment => Boolean(item)),
    hint: state.processing
      ? 'Enter steer · Tab queue · Shift+Tab mode · Esc stop · ? help'
      : 'Enter send · Shift+Tab mode · / commands · @ files · ? help',
  };
}
