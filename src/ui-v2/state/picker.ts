/**
 * Generic picker state reducer for UI v2 overlays.
 */

import type { SuggestionItem } from '../types';

export interface PickerState {
  visible: boolean;
  query: string;
  selectedIndex: number;
  items: SuggestionItem[];
}

export function createPickerState(items: SuggestionItem[] = [], query: string = '', visible: boolean = items.length > 0): PickerState {
  return {
    visible,
    query,
    selectedIndex: 0,
    items,
  };
}

export function updatePickerItems(state: PickerState, items: SuggestionItem[], query: string = state.query): PickerState {
  return {
    visible: state.visible,
    query,
    selectedIndex: clampIndex(state.selectedIndex, items.length),
    items,
  };
}

export function closePicker(state: PickerState): PickerState {
  return {
    ...state,
    visible: false,
    selectedIndex: 0,
  };
}

export function movePickerSelection(state: PickerState, direction: 'up' | 'down'): PickerState {
  if (!state.visible || state.items.length === 0) return state;

  const nextIndex = direction === 'up'
    ? Math.max(0, state.selectedIndex - 1)
    : Math.min(state.items.length - 1, state.selectedIndex + 1);

  return { ...state, selectedIndex: nextIndex };
}

export function getSelectedPickerItem(state: PickerState): SuggestionItem | null {
  if (!state.visible || state.items.length === 0) return null;
  return state.items[state.selectedIndex] ?? null;
}

function clampIndex(index: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  return Math.min(Math.max(index, 0), itemCount - 1);
}
