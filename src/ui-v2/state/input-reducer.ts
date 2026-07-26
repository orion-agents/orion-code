/**
 * Prompt input reducer for UI v2.
 */

export interface InputState {
  value: string;
  cursor: number;
  multiline: boolean;
  historyIndex: number | null;
  searchQuery: string | null;
}

export type InputAction =
  | { type: 'insert'; text: string }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'move'; direction: 'left' | 'right' | 'home' | 'end' }
  | { type: 'set'; value: string; cursor?: number }
  | { type: 'clear' }
  | { type: 'setMultiline'; multiline: boolean }
  | { type: 'setHistoryIndex'; historyIndex: number | null }
  | { type: 'setSearchQuery'; searchQuery: string | null };

export const initialInputState: InputState = {
  value: '',
  cursor: 0,
  multiline: false,
  historyIndex: null,
  searchQuery: null,
};

export function reduceInput(state: InputState, action: InputAction): InputState {
  switch (action.type) {
    case 'insert': {
      if (!action.text) return state;
      const cursor = clampCursor(state.cursor, state.value);
      const value = state.value.slice(0, cursor) + action.text + state.value.slice(cursor);
      return {
        ...state,
        value,
        cursor: cursor + action.text.length,
        historyIndex: null,
      };
    }

    case 'backspace': {
      const cursor = clampCursor(state.cursor, state.value);
      if (cursor === 0) return state;
      const value = state.value.slice(0, cursor - 1) + state.value.slice(cursor);
      return { ...state, value, cursor: cursor - 1, historyIndex: null };
    }

    case 'delete': {
      const cursor = clampCursor(state.cursor, state.value);
      if (cursor >= state.value.length) return state;
      const value = state.value.slice(0, cursor) + state.value.slice(cursor + 1);
      return { ...state, value, cursor, historyIndex: null };
    }

    case 'move': {
      return { ...state, cursor: moveCursor(state.value, state.cursor, action.direction) };
    }

    case 'set': {
      const cursor = action.cursor ?? action.value.length;
      return {
        ...state,
        value: action.value,
        cursor: clampCursor(cursor, action.value),
      };
    }

    case 'clear':
      return { ...initialInputState };

    case 'setMultiline':
      return { ...state, multiline: action.multiline };

    case 'setHistoryIndex':
      return { ...state, historyIndex: action.historyIndex };

    case 'setSearchQuery':
      return { ...state, searchQuery: action.searchQuery };
  }
}

type MoveDirection = Extract<InputAction, { type: 'move' }>['direction'];

function moveCursor(value: string, cursor: number, direction: MoveDirection): number {
  const current = clampCursor(cursor, value);
  switch (direction) {
    case 'left':
      return Math.max(0, current - 1);
    case 'right':
      return Math.min(value.length, current + 1);
    case 'home':
      return 0;
    case 'end':
      return value.length;
  }
}

function clampCursor(cursor: number, value: string): number {
  if (!Number.isFinite(cursor)) return value.length;
  return Math.min(Math.max(0, Math.floor(cursor)), value.length);
}
