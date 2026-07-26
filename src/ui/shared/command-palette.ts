import type { PaletteRenderOptions, SuggestionItem } from './types';
import { padEndVisible, truncateVisible, visualWidth } from './text';

const MIN_PALETTE_WIDTH = 28;
const MAX_PALETTE_WIDTH = 64;

export function renderCommandPalette(options: PaletteRenderOptions): string[] {
  const innerWidth = Math.max(
    MIN_PALETTE_WIDTH,
    Math.min(options.width - 4, MAX_PALETTE_WIDTH)
  );
  const title = truncateVisible(options.title, Math.max(8, innerWidth - 4));
  const titleWidth = visualWidth(title);
  const headerFill = Math.max(1, innerWidth - titleWidth - 3);
  const lines: string[] = [
    options.theme.dim(`┌─ ${title} ${'─'.repeat(headerFill)}┐`),
  ];

  if (options.items.length === 0) {
    lines.push(renderEmptyRow(options.emptyLabel ?? 'No matches', innerWidth, options.theme.dim));
  } else {
    options.items.forEach((item, index) => {
      lines.push(renderSuggestionRow({
        item,
        selected: index === options.selectedIndex,
        innerWidth,
        theme: options.theme,
      }));
    });
  }

  if (options.moreCount && options.moreCount > 0) {
    const more = `${options.moreCount} more results`;
    lines.push(options.theme.dim(`│ ${padEndVisible(more, innerWidth - 2)} │`));
  }

  lines.push(options.theme.dim(`└${'─'.repeat(innerWidth)}┘`));
  lines.push(options.theme.dim(options.footer ?? '  ↑↓ Select  Enter  Esc'));
  return lines;
}

function renderSuggestionRow(options: {
  item: SuggestionItem;
  selected: boolean;
  innerWidth: number;
  theme: PaletteRenderOptions['theme'];
}): string {
  const label = formatLabel(options.item);
  const detailWidth = Math.max(0, options.innerWidth - visualWidth(label) - 3);
  const detail = options.item.detail ? truncateVisible(options.item.detail, detailWidth) : '';
  const gapWidth = Math.max(1, options.innerWidth - visualWidth(label) - visualWidth(detail) - 2);
  const rowContent = label + ' '.repeat(gapWidth) + detail;
  const padded = padEndVisible(rowContent, options.innerWidth - 2);

  if (options.selected) {
    return options.theme.dim('│ ') + options.theme.selected(padded) + options.theme.dim(' │');
  }

  return options.theme.dim('│ ') + options.theme.accent(label) + ' '.repeat(gapWidth) + options.theme.dim(detail) + options.theme.dim(' │');
}

function renderEmptyRow(label: string, innerWidth: number, dim: (text: string) => string): string {
  return dim(`│ ${padEndVisible(truncateVisible(label, innerWidth - 2), innerWidth - 2)} │`);
}

function formatLabel(item: SuggestionItem): string {
  return item.shortcut ? `${item.label} (${item.shortcut})` : item.label;
}
