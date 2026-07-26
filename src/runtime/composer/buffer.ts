/**
 * Shared input buffer reducer.
 *
 * Migrated from `src/ink-ui/runtime/input-buffer.ts` to provide a
 * renderer-independent single-line input buffer with grapheme-safe
 * cursor movement. Ink re-exports from here; TUI imports directly.
 *
 * v0.2.21 extensions (multiline, history, Alt+Enter/Ctrl+J) will be
 * added in `composer.ts` on top of this core; this file keeps the
 * original Ink-compatible API intact.
 */

import { nextGraphemeBoundary, previousGraphemeBoundary } from './grapheme';

export interface InputBuffer {
  value: string;
  cursor: number;
}

export type InputBufferAction =
  | { type: 'insert'; text: string }
  | { type: 'inputChunk'; text: string }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'move'; direction: 'left' | 'right' | 'home' | 'end' }
  | { type: 'set'; value: string; cursor?: number }
  | { type: 'clear' };

export const initialInputBuffer: InputBuffer = {
  value: '',
  cursor: 0,
};

export function reduceInputBuffer(state: InputBuffer, action: InputBufferAction): InputBuffer {
  switch (action.type) {
    case 'insert': {
      if (!action.text) return state;
      const cursor = clampInputCursor(state.value, state.cursor);
      const value = state.value.slice(0, cursor) + action.text + state.value.slice(cursor);
      return {
        value,
        cursor: cursor + action.text.length,
      };
    }

    case 'inputChunk':
      return reduceInputChunk(state, action.text);

    case 'backspace': {
      const cursor = clampInputCursor(state.value, state.cursor);
      if (cursor === 0) return { ...state, cursor };
      const previous = previousCursorPosition(state.value, cursor);
      return {
        value: state.value.slice(0, previous) + state.value.slice(cursor),
        cursor: previous,
      };
    }

    case 'delete': {
      const cursor = clampInputCursor(state.value, state.cursor);
      if (cursor >= state.value.length) return { ...state, cursor };
      const next = nextCursorPosition(state.value, cursor);
      return {
        value: state.value.slice(0, cursor) + state.value.slice(next),
        cursor,
      };
    }

    case 'move':
      return {
        ...state,
        cursor: moveInputCursor(state.value, state.cursor, action.direction),
      };

    case 'set': {
      const cursor = action.cursor ?? action.value.length;
      return {
        value: action.value,
        cursor: clampInputCursor(action.value, cursor),
      };
    }

    case 'clear':
      return initialInputBuffer;
  }
}

export function reduceInputChunk(state: InputBuffer, text: string): InputBuffer {
  let next = state;
  let buffer = '';

  const flush = () => {
    if (!buffer) return;
    next = reduceInputBuffer(next, { type: 'insert', text: buffer });
    buffer = '';
  };

  for (let index = 0; index < text.length;) {
    const slice = text.slice(index);

    if (slice.startsWith('\x1b[200~')) {
      flush();
      index += '\x1b[200~'.length;
      continue;
    }

    if (slice.startsWith('\x1b[201~')) {
      flush();
      index += '\x1b[201~'.length;
      continue;
    }

    if (slice.startsWith('\x1b[D')) {
      flush();
      next = reduceInputBuffer(next, { type: 'move', direction: 'left' });
      index += 3;
      continue;
    }

    if (slice.startsWith('\x1b[C')) {
      flush();
      next = reduceInputBuffer(next, { type: 'move', direction: 'right' });
      index += 3;
      continue;
    }

    if (slice.startsWith('\x1b[H') || slice.startsWith('\x1b[1~')) {
      flush();
      next = reduceInputBuffer(next, { type: 'move', direction: 'home' });
      index += slice.startsWith('\x1b[H') ? 3 : 4;
      continue;
    }

    if (slice.startsWith('\x1b[F') || slice.startsWith('\x1b[4~')) {
      flush();
      next = reduceInputBuffer(next, { type: 'move', direction: 'end' });
      index += slice.startsWith('\x1b[F') ? 3 : 4;
      continue;
    }

    if (slice.startsWith('\x1b[3~')) {
      flush();
      next = reduceInputBuffer(next, { type: 'delete' });
      index += 4;
      continue;
    }

    if (slice.startsWith('\x7f') || slice.startsWith('\x08')) {
      flush();
      next = reduceInputBuffer(next, { type: 'backspace' });
      index += 1;
      continue;
    }

    if (slice.startsWith('\x15')) {
      flush();
      next = reduceInputBuffer(next, { type: 'clear' });
      index += 1;
      continue;
    }

    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    if (codePoint < 32 && char !== '\n' && char !== '\t') {
      flush();
      index += char.length;
      continue;
    }
    buffer += char;
    index += char.length;
  }

  flush();
  return next;
}

export function clampInputCursor(value: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return value.length;
  return Math.min(Math.max(0, Math.floor(cursor)), value.length);
}

export function moveInputCursor(
  value: string,
  cursor: number,
  direction: Extract<InputBufferAction, { type: 'move' }>['direction']
): number {
  const current = clampInputCursor(value, cursor);

  switch (direction) {
    case 'left':
      return previousCursorPosition(value, current);
    case 'right':
      return nextCursorPosition(value, current);
    case 'home':
      return 0;
    case 'end':
      return value.length;
  }
}

function previousCursorPosition(value: string, cursor: number): number {
  return previousGraphemeBoundary(value, cursor);
}

function nextCursorPosition(value: string, cursor: number): number {
  return nextGraphemeBoundary(value, cursor);
}
