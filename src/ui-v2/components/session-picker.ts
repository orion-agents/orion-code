/**
 * UI v2 session picker renderer.
 */

import type { SessionMeta } from '../../services/session-storage';
import type { PaletteTheme } from '../types';
import { renderCommandPalette } from './command-palette';
import { buildSessionSuggestions } from '../state/sessions';

export interface RenderSessionPickerOptions {
  title?: string;
  sessions: SessionMeta[];
  selectedIndex?: number;
  maxVisibleItems?: number;
  width: number;
  showProject?: boolean;
  moreCount?: number;
  footer?: string;
  theme: PaletteTheme;
}

export function renderSessionPicker(options: RenderSessionPickerOptions): string[] {
  const selectedIndex = clamp(options.selectedIndex ?? 0, 0, Math.max(0, options.sessions.length - 1));
  const maxVisibleItems = options.maxVisibleItems && options.maxVisibleItems > 0
    ? Math.floor(options.maxVisibleItems)
    : options.sessions.length;
  const windowStart = getSessionWindowStart(selectedIndex, options.sessions.length, maxVisibleItems);
  const windowEnd = Math.min(options.sessions.length, windowStart + maxVisibleItems);
  const allItems = buildSessionSuggestions(options.sessions, {
    showProject: options.showProject,
  });
  const visibleItems = allItems.slice(windowStart, windowEnd);
  const viewportLabel = options.sessions.length > visibleItems.length
    ? `Showing ${windowStart + 1}-${windowEnd}/${options.sessions.length}`
    : undefined;
  const footer = [
    options.footer ?? '  ↑↓ Select  Enter Resume  Esc Cancel',
    viewportLabel,
  ].filter(Boolean).join('  ');

  return renderCommandPalette({
    title: options.title ?? 'Pick a Session',
    items: visibleItems,
    selectedIndex: selectedIndex - windowStart,
    width: options.width,
    moreCount: options.moreCount,
    emptyLabel: 'No sessions found',
    footer,
    theme: options.theme,
  });
}

export function getSessionWindowStart(selectedIndex: number, total: number, maxVisibleItems: number): number {
  if (total <= 0 || maxVisibleItems <= 0 || total <= maxVisibleItems) return 0;
  const clamped = clamp(selectedIndex, 0, total - 1);
  if (clamped < maxVisibleItems) return 0;
  return Math.min(total - maxVisibleItems, clamped - maxVisibleItems + 1);
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}
