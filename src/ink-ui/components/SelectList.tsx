import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';

export interface SelectListItem {
  label: string;
  description?: string;
  value: string;
}

export interface SelectListProps {
  title: string;
  items: SelectListItem[];
  selectedIndex: number;
  maxVisibleItems?: number;
  emptyText?: string;
  footer?: string;
  width?: number;
}

function windowStartFor(selectedIndex: number, total: number, maxVisibleItems: number): number {
  if (total <= maxVisibleItems) return 0;
  const half = Math.floor(maxVisibleItems / 2);
  return Math.min(Math.max(0, selectedIndex - half), total - maxVisibleItems);
}

function truncateVisual(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text;
  if (maxWidth <= 3) return '.'.repeat(Math.max(0, maxWidth));

  let result = '';
  for (const char of text) {
    if (stringWidth(`${result}${char}...`) > maxWidth) break;
    result += char;
  }
  return `${result}...`;
}

export function SelectList({
  title,
  items,
  selectedIndex,
  maxVisibleItems = 10,
  emptyText = 'No matches',
  footer = '↑↓ navigate  Enter select  Esc cancel',
  width = 80,
}: SelectListProps): JSX.Element {
  const safeSelected = Math.max(0, Math.min(selectedIndex, Math.max(0, items.length - 1)));
  const start = windowStartFor(safeSelected, items.length, maxVisibleItems);
  const visible = items.slice(start, start + maxVisibleItems);
  const contentWidth = Math.max(12, width - 4);

  return (
    <Box width={width} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text color="cyan" wrap="truncate">{truncateVisual(title, contentWidth)}</Text>
      {items.length === 0 ? (
        <Text color="gray" wrap="truncate">{truncateVisual(emptyText, contentWidth)}</Text>
      ) : (
        visible.map((item, offset) => {
          const index = start + offset;
          const selected = index === safeSelected;
          const label = [
            selected ? '›' : ' ',
            item.label,
            item.description ? ` ${item.description}` : '',
          ].join(' ');
          return (
            <Text key={`${item.value}:${index}`} color={selected ? 'black' : undefined} backgroundColor={selected ? 'cyan' : undefined} wrap="truncate">
              {truncateVisual(label, contentWidth)}
            </Text>
          );
        })
      )}
      {items.length > maxVisibleItems ? (
        <Text color="gray" wrap="truncate">
          {safeSelected + 1}/{items.length}  {start + 1}–{Math.min(Math.max(1, start + maxVisibleItems), items.length)}
        </Text>
      ) : items.length > 0 ? (
        <Text color="gray" wrap="truncate">
          {safeSelected + 1}/{items.length}  ↑↓ to navigate  type to filter
        </Text>
      ) : null}
      <Text color="gray" wrap="truncate">{truncateVisual(footer, contentWidth)}</Text>
    </Box>
  );
}
