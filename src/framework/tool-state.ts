/**
 * orion code - Tool State
 *
 * Shared state for tools that need persistence across calls within a session
 * (todos, plan mode, current plan). Tools update this state; the CLI mirrors
 * it into the main Store so the UI and `/resume` can observe it.
 */

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

export interface ToolState {
  todos: TodoItem[];
  planMode: boolean;
  currentPlan: string | null;
  /** v0.2.24 — Goal target mode (set by create_goal / update_goal) */
  goalActive: boolean;
  goalId: string | null;
  goalStatus: string | null;
  lastEditFileArgs: {
    path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean;
    fuzzy_match?: boolean;
    /** Session id where this edit call happened */
    sessionId?: string;
    /** Turn id where this edit call happened */
    turnId?: number | string;
    /** Timestamp for stale edit-preview prevention */
    updatedAt: number;
  } | null;
}

const initialState: ToolState = {
  todos: [],
  planMode: false,
  currentPlan: null,
  goalActive: false,
  goalId: null,
  goalStatus: null,
  lastEditFileArgs: null,
};

let state: ToolState = { ...initialState };
let listeners: Array<(s: ToolState) => void> = [];

export function getToolState(): ToolState {
  return state;
}

export function setToolState(partial: Partial<ToolState>): void {
  state = { ...state, ...partial };
  for (const l of listeners) l(state);
}

export function subscribeToolState(fn: (s: ToolState) => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter(f => f !== fn);
  };
}

export function resetToolState(): void {
  state = { ...initialState };
  for (const l of listeners) l(state);
}
