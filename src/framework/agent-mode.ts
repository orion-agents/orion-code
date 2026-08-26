import type { AgentMode } from '../commands/types';
import type { Store } from './store';

/** Stable cycle used by the product TUI. `interactive` is displayed as BUILD. */
export const AGENT_MODE_CYCLE: readonly AgentMode[] = ['interactive', 'plan', 'auto'];

export interface AgentModeSnapshot {
  baseMode: AgentMode;
  pendingBaseMode: AgentMode | null;
}

export type AgentModeListener = (snapshot: AgentModeSnapshot) => void;

export function nextAgentMode(mode: AgentMode): AgentMode {
  const index = AGENT_MODE_CYCLE.indexOf(mode);
  return AGENT_MODE_CYCLE[(index + 1) % AGENT_MODE_CYCLE.length];
}

/**
 * Single owner for BUILD / PLAN / AUTO lifecycle state.
 *
 * Commands, keyboard shortcuts and the plan completion tool all transition
 * through this runtime-owned controller. Store is a projection; no process
 * global mode registry participates in the transition.
 */
export class AgentModeLifecycleController {
  private pendingBaseMode: AgentMode | null = null;
  private completedPlanRevision = 0;
  private lastCompletedPlan: string | null = null;
  private fallbackBaseMode: AgentMode = 'interactive';
  private readonly listeners = new Set<AgentModeListener>();

  constructor(private readonly store: Store) {}

  snapshot(): AgentModeSnapshot {
    return {
      baseMode: this.currentMode(),
      pendingBaseMode: this.pendingBaseMode,
    };
  }

  subscribe(listener: AgentModeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Cycle immediately while idle, or stage the change for the next request. */
  cycle(options: { defer: boolean }): AgentModeSnapshot {
    const current = this.currentMode();
    const origin = this.pendingBaseMode ?? current;
    const next = nextAgentMode(origin);
    if (options.defer) {
      this.pendingBaseMode = next === current ? null : next;
      return this.notify();
    }
    return this.setMode(next);
  }

  /** Apply an explicit command-driven transition and supersede any pending shortcut. */
  setMode(mode: AgentMode): AgentModeSnapshot {
    this.pendingBaseMode = null;
    this.apply(mode);
    return this.notify();
  }

  /** Restore the pre-plan mode after saving the decision-complete plan. */
  completePlan(plan: string, returnMode: Exclude<AgentMode, 'plan'>): AgentModeSnapshot {
    const savedPlan = plan.trim();
    const executionMode =
      this.pendingBaseMode && this.pendingBaseMode !== 'plan' ? this.pendingBaseMode : returnMode;
    this.pendingBaseMode = null;
    this.completedPlanRevision += 1;
    this.lastCompletedPlan = savedPlan;
    this.store.setState({
      agentMode: executionMode,
      planMode: false,
      planReturnMode: executionMode,
      currentPlan: savedPlan,
    });
    return this.notify();
  }

  completionRevision(): number {
    return this.completedPlanRevision;
  }

  completedPlanSince(revision: number): string | null {
    return this.completedPlanRevision > revision ? this.lastCompletedPlan : null;
  }

  /** Apply a busy-turn shortcut at the logical-request boundary. */
  applyPending(): AgentModeSnapshot {
    const pending = this.pendingBaseMode;
    if (!pending) return this.snapshot();
    this.pendingBaseMode = null;
    this.apply(pending);
    return this.notify();
  }

  private apply(mode: AgentMode): void {
    this.fallbackBaseMode = mode;
    if (typeof this.store.getSnapshot !== 'function' || typeof this.store.setState !== 'function') {
      return;
    }
    const snapshot = this.store.getSnapshot();
    if (mode === 'plan') {
      const returnMode =
        snapshot.agentMode === 'auto'
          ? 'auto'
          : snapshot.agentMode === 'interactive'
            ? 'interactive'
            : snapshot.planReturnMode;
      this.store.setState({
        agentMode: 'plan',
        planMode: true,
        planReturnMode: returnMode,
        currentPlan: null,
      });
      return;
    }

    this.store.setState({
      agentMode: mode,
      planMode: false,
      planReturnMode: mode,
      currentPlan: snapshot.agentMode === 'plan' ? null : snapshot.currentPlan,
    });
  }

  private currentMode(): AgentMode {
    if (typeof this.store.getSnapshot !== 'function') return this.fallbackBaseMode;
    return this.store.getSnapshot().agentMode ?? this.fallbackBaseMode;
  }

  private notify(): AgentModeSnapshot {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }
}

/** Fallback for command-only callers that do not run through AgentRuntimeController. */
export function setAgentMode(store: Store, mode: AgentMode): AgentModeSnapshot {
  return new AgentModeLifecycleController(store).setMode(mode);
}
