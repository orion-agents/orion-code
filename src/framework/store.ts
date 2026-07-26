/**
 * orion code - Centralized State Store
 *
 * Simple publish-subscribe state management.
 * No React dependency — just state + listeners.
 */

import type { Message } from '../services/llm';
import type { OpenHorseTool } from './tool';
import type { OpenHorseCLIConfig } from '../services/config';
import type { PermissionMode } from '../commands/types';
import { CostTracker } from '../core/cost-tracker';
import type { TodoItem } from './tool-state';
import type { HarnessState } from '../harness';
import type { LoopStats } from './query';
import type { ContextUsageSnapshot } from '../services/model-context';

// ============================================================================
// 状态结构
// ============================================================================

export interface AppState {
  config: OpenHorseCLIConfig;
  tools: OpenHorseTool[];
  conversationHistory: Message[];
  isProcessing: boolean;
  currentModel: string;
  tokenUsage: { promptTokens: number; completionTokens: number } | null;
  /** Current request context pressure. This is not cumulative session usage. */
  contextUsage: ContextUsageSnapshot | null;
  permissionMode: PermissionMode;
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
}
