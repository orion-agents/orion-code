/**
 * orion code - Centralized State Store
 *
 * Simple publish-subscribe state management.
 * No React dependency — just state + listeners.
 */

import type { Message } from '../services/llm';
import type { OrionCodeTool } from './tool';
import type { OrionCodeCLIConfig } from '../services/config';
import type { AgentMode, PermissionMode } from '../commands/types';
import { CostTracker } from '../core/cost-tracker';
import type { TodoItem } from './tool-state';
import type { HarnessState } from '../harness';
import type { LoopStats } from './query';
import type { ContextUsageSnapshot } from '../services/model-context';
import type { EffortPreference, ResolvedEffort } from '../services/effort';

// ============================================================================
// 状态结构
// ============================================================================

export interface AppState {
  config: OrionCodeCLIConfig;
  tools: OrionCodeTool[];
  conversationHistory: Message[];
  isProcessing: boolean;
  currentModel: string;
  tokenUsage: { promptTokens: number; completionTokens: number } | null;
  /** Current request context pressure. This is not cumulative session usage. */
  contextUsage: ContextUsageSnapshot | null;
  permissionMode: PermissionMode;
  /** Agent working mode, independent from tool confirmation/edit policy. */
  agentMode: AgentMode;
  effortPreference: EffortPreference;
  resolvedEffort: ResolvedEffort | null;
  costTracker: CostTracker;
  /** Project memory content loaded at startup */
  memoryContent: string;
  /** Pre-rendered skills section for the system prompt */
  skillsContent: string;
  /** Repository guidance such as AGENTS.md / CLAUDE.md */
  projectInstructionsContent: string;
  /** Active todo list (mirrored from tool-state) */
  todos: TodoItem[];
  /** Whether the agent is in plan mode (mirrored from tool-state) */
  planMode: boolean;
  /** Latest plan from exit_plan_mode (mirrored from tool-state) */
  currentPlan: string | null;
  /** Context Harness serializable state */
  harnessState?: HarnessState;
  /** Last completed agent-loop stats for diagnostics. */
  lastLoopStats?: LoopStats;
}

// ============================================================================
// Store 类
// ============================================================================

type Listener = (state: AppState) => void;

export class Store {
  private state: AppState;
  private listeners: Set<Listener> = new Set();

  constructor(
    initial: Omit<
      AppState,
      | 'conversationHistory'
      | 'isProcessing'
      | 'tokenUsage'
      | 'contextUsage'
      | 'permissionMode'
      | 'agentMode'
      | 'effortPreference'
      | 'resolvedEffort'
      | 'costTracker'
      | 'memoryContent'
      | 'skillsContent'
      | 'projectInstructionsContent'
      | 'todos'
      | 'planMode'
      | 'currentPlan'
    > &
      Partial<AppState>
  ) {
    this.state = {
      conversationHistory: [],
      isProcessing: false,
      tokenUsage: null,
      contextUsage: null,
      permissionMode: 'default',
      agentMode: 'interactive',
      effortPreference: initial.config.defaultEffort ?? 'auto',
      resolvedEffort: null,
      costTracker: new CostTracker({
        pricing: initial.config.cost?.modelPricing,
        defaultPricing: initial.config.cost?.defaultPricing,
      }),
      memoryContent: '',
      skillsContent: '',
      projectInstructionsContent: '',
      todos: [],
      planMode: false,
      currentPlan: null,
      ...initial,
    } as AppState;
  }

  /** Get the current state snapshot */
  getSnapshot(): AppState {
    return this.state;
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Update state with a partial object and notify listeners */
  setState(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  /** Convenience: reset conversation history */
  resetConversation(): void {
    this.setState({
      conversationHistory: [],
      tokenUsage: null,
      contextUsage: null,
    });
  }

  /** Convenience: set processing state */
  setProcessing(val: boolean): void {
    this.setState({ isProcessing: val });
  }

  /** Convenience: append a message to conversation history */
  addMessage(msg: Message): void {
    this.setState({
      conversationHistory: [...this.state.conversationHistory, msg],
    });
  }

  /** Convenience: update token usage */
  setTokenUsage(usage: { promptTokens: number; completionTokens: number }): void {
    this.setState({ tokenUsage: usage });
  }

  /** Update the latest runtime-owned context pressure snapshot. */
  setContextUsage(usage: ContextUsageSnapshot): void {
    this.setState({ contextUsage: usage });
  }

  /** Convenience: update the latest agent-loop stats */
  setLastLoopStats(stats: LoopStats): void {
    this.setState({ lastLoopStats: stats });
  }

  /** Convenience: set permission mode */
  setPermissionMode(mode: PermissionMode): void {
    this.setState({ permissionMode: mode });
  }

  /** Convenience: cycle to next permission mode */
  cyclePermissionMode(): PermissionMode {
    const { getNextPermissionMode } = require('../commands/types');
    const nextMode = getNextPermissionMode(this.state.permissionMode);
    this.setState({ permissionMode: nextMode });
    return nextMode;
  }

  setAgentMode(mode: AgentMode): void {
    this.setState({ agentMode: mode });
  }

  setEffort(preference: EffortPreference, resolved: ResolvedEffort): void {
    this.setState({ effortPreference: preference, resolvedEffort: resolved });
  }

  /** Compatibility bridge used by the scheduler while legacy edit policy remains readable. */
  getEffectivePermissionMode(): PermissionMode {
    if (this.state.agentMode === 'auto') return 'auto';
    // PLAN is a workflow mode, not a permission boundary. Preserve the
    // independently selected BUILD edit/confirmation policy while planning.
    // A persisted legacy `plan` permission value now has default semantics.
    return this.state.permissionMode === 'plan' ? 'default' : this.state.permissionMode;
  }
}
