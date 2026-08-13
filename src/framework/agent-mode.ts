import type { AgentMode } from '../commands/types';
import type { Store } from './store';
import type { ToolContext } from './tool';
import { getToolState, setToolState } from './tool-state';

/** Stable cycle used by the product TUI. `interactive` is displayed as BUILD. */
export const AGENT_MODE_CYCLE: readonly AgentMode[] = ['interactive', 'plan', 'auto'];

export interface AgentModeSnapshot {
  baseMode: AgentMode;
  pendingBaseMode: AgentMode | null;
}

export type AgentModeListener = (snapshot: AgentModeSnapshot) => void;

export function createPlanModeChangeHandler(
  store: Store,
  lifecycle?: AgentModeLifecycleController
): NonNullable<ToolContext['onPlanModeChange']> {
  return transition => {
    if (!transition.active && transition.currentPlan && lifecycle) {
      return lifecycle.completePlan(transition.currentPlan, transition.returnMode).baseMode as
        | 'interactive'
        | 'auto';
    }
    store.setState({
      agentMode: transition.active ? 'plan' : transition.returnMode,
      planMode: transition.active,
      currentPlan: transition.currentPlan,
    });
    return transition.returnMode;
  };
}

export function nextAgentMode(mode: AgentMode): AgentMode {
  const index = AGENT_MODE_CYCLE.indexOf(mode);
  return AGENT_MODE_CYCLE[(index + 1) % AGENT_MODE_CYCLE.length];
}

/**
 * Single owner for BUILD / PLAN / AUTO lifecycle state.
 *
 * Commands, keyboard shortcuts and the plan completion tool all transition
 * through this controller so Store and tool-state cannot drift apart.
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
    setToolState({
      planMode: false,
      currentPlan: savedPlan,
      planReturnMode: executionMode === 'auto' ? 'auto' : 'interactive',
    });
    this.store.setState({
      agentMode: executionMode,
      planMode: false,
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
    const toolState = getToolState();

    if (mode === 'plan') {
      const returnMode =
        snapshot.agentMode === 'auto'
          ? 'auto'
          : snapshot.agentMode === 'interactive'
            ? 'interactive'
            : (toolState.planReturnMode ?? 'interactive');
      setToolState({
        planMode: true,
        currentPlan: null,
        planReturnMode: returnMode,
      });
      this.store.setState({ agentMode: 'plan', planMode: true, currentPlan: null });
      return;
    }

    setToolState({
      planMode: false,
      currentPlan: snapshot.agentMode === 'plan' ? null : snapshot.currentPlan,
      planReturnMode: mode,
    });
    this.store.setState({
      agentMode: mode,
      planMode: false,
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
