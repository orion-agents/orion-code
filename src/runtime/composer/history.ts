/**
 * Input history for the shared composer.
 *
 * v0.2.21: provides in-memory input history with deduplication and
 * a bounded LRU-like size limit. Not persisted to disk in v0.2.21.
 *
 * The history is only written on non-empty submit. Consecutive duplicate
 * entries are collapsed. When navigating history, a draft of the current
 * input is preserved and restored when returning to the present.
 */

export interface InputHistoryState {
  entries: string[];
  /** Index into entries, or null when at the present (draft). */
  index: number | null;
  /** Saved draft before first history navigation. */
  draft: string;
}

export const MAX_HISTORY_ENTRIES = 100;

export const initialHistoryState: InputHistoryState = {
  entries: [],
  index: null,
  draft: '',
};

/**
 * Push a submitted value into history. Deduplicates consecutive identical
 * entries. Trims to MAX_HISTORY_ENTRIES from the front (oldest evicted).
 */
export function pushHistoryEntry(state: InputHistoryState, value: string): InputHistoryState {
  if (!value) return state;
  // Deduplicate consecutive identical.
  const entries = state.entries[state.entries.length - 1] === value
    ? state.entries
    : [...state.entries, value];
  // Bound size.
  const trimmed = entries.length > MAX_HISTORY_ENTRIES
    ? entries.slice(entries.length - MAX_HISTORY_ENTRIES)
    : entries;
  return {
    entries: trimmed,
    index: null,
    draft: '',
  };
}

/**
 * Navigate to the previous (older) history entry.
 * Saves the current draft before first navigation.
 */
export function historyPrevious(state: InputHistoryState, currentDraft: string): InputHistoryState {
  if (state.entries.length === 0) return state;

  const draft = state.index === null ? currentDraft : state.draft;
  const currentIndex = state.index ?? state.entries.length;
  const newIndex = currentIndex > 0 ? currentIndex - 1 : 0;

  return {
    entries: state.entries,
    index: newIndex,
    draft,
  };
}

/**
 * Navigate to the next (newer) history entry.
 * Returns to draft when reaching the end.
 */
export function historyNext(state: InputHistoryState): InputHistoryState {
  if (state.index === null) return state;

  const newIndex = state.index + 1;
  if (newIndex >= state.entries.length) {
    // Back to present — restore draft.
    return {
      entries: state.entries,
      index: null,
      draft: state.draft,
    };
  }

  return {
    entries: state.entries,
    index: newIndex,
    draft: state.draft,
  };
}

/**
 * Get the value to display at the current history position.
 */
export function historyCurrentValue(state: InputHistoryState, currentDraft: string): string {
  if (state.index === null) return state.draft || currentDraft;
  return state.entries[state.index] ?? currentDraft;
}
