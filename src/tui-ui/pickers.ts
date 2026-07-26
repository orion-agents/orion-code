import { getCommandCategoryLabel, getVisibleCommands } from '../commands';
import {
  createCommandPickerState,
  createFilePickerState,
  getFileMentionQuery,
} from '../runtime/ui-view-model';
import { matchFiles } from '../services/file-glob';

export interface TuiPickerItem {
  value: string;
  label: string;
  description?: string;
}

export interface TuiFileQuery {
  base: string;
  query: string;
}

export function visibleCommandItems(input: string): TuiPickerItem[] {
  return createCommandPickerState({
    input,
    commands: getVisibleCommands(),
    categoryLabel: getCommandCategoryLabel,
  }).visibleItems.map(item => ({
    value: item.value,
    label: item.label,
    description: item.description,
  }));
}

export function getFileQuery(input: string): TuiFileQuery | null {
  return getFileMentionQuery(input);
}

export function visibleFileItems(cwd: string, input: string): TuiPickerItem[] {
  const fileQuery = getFileQuery(input);
  if (!fileQuery) return [];
  const state = createFilePickerState({
    input,
    files: matchFiles(fileQuery.query, cwd, { limit: 80 }),
    maxVisibleItems: 80,
  });
  return state?.visibleItems.map(item => ({
    value: item.value,
    label: item.label,
    description: item.description,
  })) ?? [];
}
