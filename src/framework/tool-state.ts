/**
 * orion code - Tool State
 *
 * Explicit task-scoped state for the remaining legacy todo/goal/edit adapters.
 * PLAN is owned by the durable runtime and is deliberately absent here.
 */

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

export interface ToolState {
  todos: TodoItem[];
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

const initialState: Readonly<ToolState> = {
  todos: [],
  goalActive: false,
  goalId: null,
  goalStatus: null,
  lastEditFileArgs: null,
};

/** Explicit task-scoped state for legacy plan/todo tool adapters. */
export class ToolStateStore {
  private value: ToolState = cloneInitialState();
  private listeners: Array<(state: ToolState) => void> = [];

  getSnapshot(): ToolState {
    return structuredClone(this.value);
  }

  set(partial: Partial<ToolState>): void {
    this.value = { ...this.value, ...structuredClone(partial) };
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  subscribe(listener: (state: ToolState) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(candidate => candidate !== listener);
    };
  }

  reset(): void {
    this.value = cloneInitialState();
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

export function createToolStateStore(): ToolStateStore {
  return new ToolStateStore();
}

function cloneInitialState(): ToolState {
  return structuredClone(initialState);
}
