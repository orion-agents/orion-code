import React from 'react';
import { Box, Text } from 'ink';
import { marked, type Token } from 'marked';
import stringWidth from 'string-width';
import { splitByVisualWidth } from '../runtime/prompt-layout';

const ACCENT = 'cyan';
const DIM = 'gray';
const CODE_BG = '#222831';
const CODE_TEXT = '#dbe7f3';
const INLINE_CODE_BG = '#50545c';

interface MarkdownProps {
  children: string;
  width?: number;
  dimColor?: boolean;
}

type AnyToken = Token & Record<string, any>;

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    }
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    }
    return HTML_ENTITIES[entity] ?? match;
  });
}

function padVisual(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)));
}

function truncateVisual(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  let result = '';
  for (const char of text) {
    if (stringWidth(`${result}…`) > width) break;
    result += char;
  }
  return `${result}…`;
}

function tokenText(token: AnyToken): string {
  if (typeof token.text === 'string') return decodeHtmlEntities(token.text);
  if (typeof token.raw === 'string') return decodeHtmlEntities(token.raw);
  return '';
}

function plainInlineText(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

function inlineChildren(tokens: AnyToken[] | undefined, fallback: string, keyPrefix: string): React.ReactNode {
  const source: AnyToken[] = tokens && tokens.length > 0
    ? tokens
    : [{ type: 'text', raw: fallback, text: fallback } as AnyToken];

  return source.map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.type) {
      case 'strong':
        return <Text key={key} bold>{inlineChildren(token.tokens, tokenText(token), key)}</Text>;
      case 'em':
        return <Text key={key} italic>{inlineChildren(token.tokens, tokenText(token), key)}</Text>;
      case 'codespan':
        return <Text key={key} color={CODE_TEXT} backgroundColor={INLINE_CODE_BG}> {tokenText(token)} </Text>;
      case 'link': {
        const label = inlineChildren(token.tokens, token.text || token.href || '', key);
        return (
          <Text key={key}>
            <Text color={ACCENT} underline>{label}</Text>
            {token.href ? <Text color={DIM}> ({decodeHtmlEntities(token.href)})</Text> : null}
          </Text>
        );
      }
      case 'del':
        return <Text key={key} dimColor>{inlineChildren(token.tokens, tokenText(token), key)}</Text>;
      case 'br':
        return '\n';
      default:
        return <Text key={key}>{tokenText(token)}</Text>;
    }
  });
}

function renderInline(tokens: AnyToken[] | undefined, fallback: string, keyPrefix: string): React.ReactNode {
  return inlineChildren(tokens, fallback, keyPrefix);
}

function renderCode(token: AnyToken, width: number, key: string): JSX.Element {
  const lang = String(token.lang || '').trim();
  const contentWidth = Math.max(8, width - 4);
  const lines = String(token.text || '').split('\n');
  const isDiff = lang === 'diff' || lang === 'patch';

  return (
    <Box key={key} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginY={1}>
      {lang ? <Text color={DIM}>{lang}</Text> : null}
      {lines.flatMap((line, lineIndex) => {
        const chunks = splitByVisualWidth(line || ' ', contentWidth);
        return chunks.map((chunk, chunkIndex) => {
          const color = isDiff && chunk.startsWith('+') ? 'green'
            : isDiff && chunk.startsWith('-') ? 'red'
              : isDiff && chunk.startsWith('@') ? ACCENT
                : CODE_TEXT;
          return (
            <Text
              key={`${lineIndex}:${chunkIndex}`}
              color={color}
              backgroundColor={CODE_BG}
              wrap="truncate"
            >
              {padVisual(chunk, contentWidth)}
            </Text>
          );
        });
      })}
    </Box>
  );
}

function renderTable(token: AnyToken, width: number, key: string): JSX.Element {
  const headers = (token.header || []).map((cell: AnyToken) => plainInlineText(tokenText(cell)));
  const rows = (token.rows || []).map((row: AnyToken[]) => row.map(cell => plainInlineText(tokenText(cell))));
  const columnCount = Math.max(headers.length, ...rows.map((row: string[]) => row.length), 1);
  const maxTableWidth = Math.max(20, width - 2);
  const availableCellWidth = Math.max(4, Math.floor((maxTableWidth - (columnCount - 1) * 3) / columnCount));
  const columnWidths = Array.from({ length: columnCount }, (_, index) => {
    const contentWidth = Math.max(
      stringWidth(headers[index] || ''),
      ...rows.map((row: string[]) => stringWidth(row[index] || ''))
    );
    return Math.min(availableCellWidth, Math.max(4, contentWidth));
  });
  const formatRow = (cells: string[]) => cells
    .map((cell, index) => padVisual(truncateVisual(cell || '', columnWidths[index] || 4), columnWidths[index] || 4))
    .join(' │ ');
  const separator = columnWidths.map(widthValue => '─'.repeat(widthValue)).join('─┼─');

  return (
    <Box key={key} flexDirection="column" marginY={1}>
      <Text color={ACCENT} bold>{formatRow(headers)}</Text>
      <Text color={DIM}>{separator}</Text>
      {rows.map((row: string[], index: number) => (
        <Text key={index}>{formatRow(row)}</Text>
      ))}
    </Box>
  );
}

function renderList(token: AnyToken, width: number, key: string): JSX.Element {
  const ordered = Boolean(token.ordered);
  const start = typeof token.start === 'number' ? token.start : 1;
  const items = token.items || [];

  return (
    <Box key={key} flexDirection="column" marginY={1}>
      {items.map((item: AnyToken, index: number) => {
        const marker = ordered ? `${start + index}.` : '•';
        const textToken = item.tokens?.find((child: AnyToken) => child.type === 'text');
        return (
          <Box key={index} flexDirection="row">
            <Box width={Math.max(3, stringWidth(marker) + 1)}>
              <Text color={ACCENT}>{marker}</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1}>
              <Text wrap="wrap">{renderInline(textToken?.tokens, item.text || tokenText(item), `${key}-item-${index}`)}</Text>
              {item.tokens
                ?.filter((child: AnyToken) => child.type !== 'text')
                .map((child: AnyToken, childIndex: number) => renderBlock(child, width - 4, `${key}-child-${index}-${childIndex}`))}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function renderBlock(token: AnyToken, width: number, key: string): React.ReactNode {
  switch (token.type) {
    case 'space':
      return null;
    case 'heading': {
      const depth = Number(token.depth || 1);
      const text = tokenText(token);
      const underlineWidth = Math.min(width, Math.max(8, stringWidth(text)));
      return (
        <Box key={key} flexDirection="column" marginTop={depth <= 2 ? 1 : 0}>
          <Text color={depth <= 2 ? ACCENT : undefined} bold={depth <= 4}>
            {renderInline(token.tokens, text, key)}
          </Text>
          {depth <= 2 ? <Text color={DIM}>{'─'.repeat(underlineWidth)}</Text> : null}
        </Box>
      );
    }
    case 'paragraph':
      return <Text key={key} wrap="wrap">{renderInline(token.tokens, tokenText(token), key)}</Text>;
    case 'list':
      return renderList(token, width, key);
    case 'blockquote': {
      const quote = String(token.text || token.raw || '').replace(/^>\s?/gm, '');
      return (
        <Box key={key} flexDirection="row" marginY={1}>
          <Text color={DIM}>│ </Text>
          <Box flexDirection="column" flexGrow={1}>
            <Markdown width={Math.max(8, width - 2)} dimColor>{quote}</Markdown>
          </Box>
        </Box>
      );
    }
    case 'code':
      return renderCode(token, width, key);
    case 'table':
      return renderTable(token, width, key);
    case 'hr':
      return <Text key={key} color={DIM}>{'─'.repeat(Math.max(8, width - 2))}</Text>;
    case 'html':
      return tokenText(token).trim() ? <Text key={key} dimColor>{tokenText(token)}</Text> : null;
    default:
      return tokenText(token).trim() ? <Text key={key}>{tokenText(token)}</Text> : null;
  }
}

export function markdownBlockTypes(markdown: string): string[] {
  return (marked.lexer(markdown) as Token[]).map(token => token.type);
}

export function Markdown({ children, width = 80 }: MarkdownProps): JSX.Element {
  let tokens: Token[];
  try {
    tokens = marked.lexer(children) as Token[];
  } catch {
    tokens = [{ type: 'paragraph', raw: children, text: children } as Token];
  }

  return (
    <Box flexDirection="column">
      {tokens.map((token, index) => {
        const rendered = renderBlock(token as AnyToken, width, `md-${index}`);
        return rendered ? (
          <Box key={index} flexDirection="column">
            {rendered}
          </Box>
        ) : null;
      })}
    </Box>
  );
}
