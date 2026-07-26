/**
 * UI v2 edit preview picker renderer.
 * Displays edit_file preview candidates in a structured picker UI.
 */

import type { PaletteTheme, SuggestionItem } from '../types';
import { renderCommandPalette } from './command-palette';

export interface EditPreviewCandidate {
  index: number;
  line: number;
  match: string;
  contextBefore: string;
  contextAfter: string;
  isReplaceAll: boolean;
}

export interface RenderEditPreviewOptions {
  title?: string;
  path: string;
  newString: string;
  kind: 'exact' | 'fuzzy';
  candidates: EditPreviewCandidate[];
  selectedIndex?: number;
  maxVisibleItems?: number;
  width: number;
  theme: PaletteTheme;
}

export function renderEditPreview(options: RenderEditPreviewOptions): string[] {
  const selectedIndex = clamp(options.selectedIndex ?? 0, 0, Math.max(0, options.candidates.length - 1));
  const maxVisibleItems = options.maxVisibleItems && options.maxVisibleItems > 0
    ? Math.floor(options.maxVisibleItems)
    : options.candidates.length;

  const items = buildCandidateItems(options);
  const windowStart = getPickerWindowStart(selectedIndex, items.length, maxVisibleItems);
  const windowEnd = Math.min(items.length, windowStart + maxVisibleItems);
  const visibleItems = items.slice(windowStart, windowEnd);

  const viewportLabel = items.length > visibleItems.length
    ? `Showing ${windowStart + 1}-${windowEnd}/${items.length}`
    : undefined;

  const header = `${options.path} (${options.kind})`;
  const title = options.title ?? `Edit Preview: ${header}`;

  const footer = [
    '  ↑↓ Select  Enter Apply  Esc Cancel',
    viewportLabel,
  ].filter(Boolean).join('  ');

  return renderCommandPalette({
    title,
    items: visibleItems,
    selectedIndex: selectedIndex - windowStart,
    width: options.width,
    emptyLabel: 'No matches found',
    footer,
    theme: options.theme,
  });
}

function buildCandidateItems(options: RenderEditPreviewOptions): SuggestionItem[] {
  const { candidates, newString } = options;
  const maxMatchPreview = 60;

  return candidates.map(c => {
    const matchPreview = c.match.length > maxMatchPreview
      ? c.match.slice(0, maxMatchPreview) + '...'
      : c.match;
    const newPreview = newString.length > maxMatchPreview
      ? newString.slice(0, maxMatchPreview) + '...'
      : newString;

    const lines: string[] = [];
    if (c.contextBefore) {
      lines.push(c.contextBefore.split('\n').slice(-2).join(' | '));
    }
    lines.push(`→ ${matchPreview}`);
    if (c.contextAfter) {
      lines.push(c.contextAfter.split('\n').slice(0, 2).join(' | '));
    }

    const label = `Line ${c.line}`;
    const description = c.isReplaceAll ? 'replace all' : `→ ${newPreview}`;

    return {
      id: `candidate-${c.index}`,
      kind: 'edit' as const,
      label,
      description,
      detail: lines.join(' | '),
    };
  });
}

function getPickerWindowStart(selectedIndex: number, total: number, maxVisibleItems: number): number {
  if (total <= 0 || maxVisibleItems <= 0 || total <= maxVisibleItems) return 0;
  const clamped = clamp(selectedIndex, 0, total - 1);
  if (clamped < maxVisibleItems) return 0;
  return Math.min(total - maxVisibleItems, clamped - maxVisibleItems + 1);
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}
