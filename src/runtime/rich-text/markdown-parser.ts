/**
 * Markdown parser: convert model text to RichTextBlock[].
 *
 * Uses marked.lexer() to tokenize, then normalizes tokens into the
 * structured RichTextBlock model. Never calls marked.parse() (HTML),
 * never depends on React components.
 *
 * Resource limits enforce deterministic degradation on malformed or
 * oversized input - parser never throws, falls back to plain text.
 */

import { marked, type Tokens, type Token } from 'marked';
import {
  type RichTextBlock,
  type RichTextSpan,
  type DiffLine,
  type RichTextDocument,
  MAX_RICH_TEXT_INPUT_BYTES,
  MAX_RICH_TEXT_BLOCKS,
  MAX_MARKDOWN_NESTING,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
} from './types';
import { sanitizeRichTextInput, sanitizeCodeContent } from './sanitizer';

/**
 * Parse model text into a RichTextDocument.
 * Never throws - returns a plain-text paragraph on parse failure.
 */
export function parseRichText(rawText: string): RichTextDocument {
  if (!rawText || rawText.length === 0) {
    return { blocks: [] };
  }

  // Resource limit: truncate oversized input.
  const truncated = rawText.length > MAX_RICH_TEXT_INPUT_BYTES
    ? rawText.slice(0, MAX_RICH_TEXT_INPUT_BYTES)
    : rawText;

  const cleaned = sanitizeRichTextInput(truncated);

  try {
    const tokens = marked.lexer(cleaned);
    const blocks: RichTextBlock[] = [];
    for (const token of tokens) {
      if (blocks.length >= MAX_RICH_TEXT_BLOCKS) break;
      const block = tokenToBlock(token, 0);
      if (block) {
        if (Array.isArray(block)) {
          blocks.push(...block);
        } else {
          blocks.push(block);
        }
      }
    }
    return { blocks };
  } catch {
    // Fallback: treat entire text as a single paragraph.
    return { blocks: [{ type: 'paragraph', spans: [{ text: cleaned }] }] };
  }
}

function tokenToBlock(token: Token, depth: number): RichTextBlock | RichTextBlock[] | null {
  if (depth > MAX_MARKDOWN_NESTING) {
    // Flatten deep nesting: return text content as paragraph.
    const text = extractTokenText(token);
    return text ? { type: 'paragraph', spans: [{ text }] } : null;
  }

  switch (token.type) {
    case 'heading':
      return parseHeading(token as Tokens.Heading);
    case 'paragraph':
      return { type: 'paragraph', spans: parseInlineTokens(token.tokens ?? [], depth) };
    case 'list':
      return parseList(token as Tokens.List, depth);
    case 'blockquote':
      return parseQuote(token as Tokens.Blockquote, depth);
    case 'code':
      return parseCode(token as Tokens.Code);
    case 'hr':
      return { type: 'rule' };
    case 'table':
      return parseTable(token as Tokens.Table);
    case 'html':
      return parseHtml(token as Tokens.HTML);
    case 'space':
      return null;
    default:
      // Unknown token: use raw text as fallback, never silently drop.
      const raw = (token as { raw?: string }).raw;
      return raw ? { type: 'paragraph', spans: [{ text: raw.trim() }] } : null;
  }
}

function parseHeading(token: Tokens.Heading): RichTextBlock {
  return {
    type: 'heading',
    level: Math.max(1, Math.min(6, token.depth)),
    spans: parseInlineTokens(token.tokens ?? [], 0),
  };
}

function parseList(token: Tokens.List, depth: number): RichTextBlock {
  const items = (token.items ?? []).map(item => {
    const subBlocks: RichTextBlock[] = [];
    for (const subToken of item.tokens ?? []) {
      const block = tokenToBlock(subToken, depth + 1);
      if (block) {
        if (Array.isArray(block)) subBlocks.push(...block);
        else subBlocks.push(block);
      }
    }
    return subBlocks;
  });
  return { type: 'list', ordered: token.ordered, items };
}

function parseQuote(token: Tokens.Blockquote, depth: number): RichTextBlock {
  const blocks: RichTextBlock[] = [];
  for (const subToken of token.tokens ?? []) {
    const block = tokenToBlock(subToken, depth + 1);
    if (block) {
      if (Array.isArray(block)) blocks.push(...block);
      else blocks.push(block);
    }
  }
  return { type: 'quote', blocks };
}

function parseCode(token: Tokens.Code): RichTextBlock {
  const language = token.lang?.trim() || undefined;
  const content = sanitizeCodeContent(token.text);

  // Detect diff/patch language for specialized rendering.
  if (language === 'diff' || language === 'patch') {
    return { type: 'diff', lines: parseDiffLines(content) };
  }

  const lines = content.split('\n');
  return { type: 'code', language, lines };
}

function parseDiffLines(content: string): DiffLine[] {
  const lines = content.split('\n');
  return lines.map(line => {
    if (line.startsWith('@@')) {
      return { kind: 'hunk' as const, content: line };
    }
    if (line.startsWith('+++') || line.startsWith('---')) {
      return { kind: 'meta' as const, content: line };
    }
    if (line.startsWith('+')) {
      return { kind: 'add' as const, content: line.slice(1) };
    }
    if (line.startsWith('-')) {
      return { kind: 'remove' as const, content: line.slice(1) };
    }
    return { kind: 'context' as const, content: line.startsWith(' ') ? line.slice(1) : line };
  });
}

function parseTable(token: Tokens.Table): RichTextBlock {
  const headers = (token.header ?? []).map(cell => parseInlineTokens(cell.tokens ?? [], 0)).slice(0, MAX_TABLE_COLUMNS);
  const rows = (token.rows ?? [])
    .slice(0, MAX_TABLE_ROWS)
    .map(row => row.slice(0, MAX_TABLE_COLUMNS).map(cell => parseInlineTokens(cell.tokens ?? [], 0)));
  return { type: 'table', headers, rows };
}

function parseHtml(token: Tokens.HTML): RichTextBlock {
  // Never interpret HTML tags - display as safe plain text.
  return { type: 'paragraph', spans: [{ text: token.text }] };
}

type RichTextSpanMarks = Omit<RichTextSpan, 'text'>;

function parseInlineTokens(
  tokens: Token[],
  depth: number,
  inherited: RichTextSpanMarks = {},
): RichTextSpan[] {
  if (depth > MAX_MARKDOWN_NESTING) {
    const text = tokens.map(extractTokenText).join('');
    return text ? [{ text, ...inherited }] : [];
  }

  const spans: RichTextSpan[] = [];
  for (const token of tokens) {
    spans.push(...inlineTokenToSpans(token, depth, inherited));
  }
  return spans;
}

function inlineTokenToSpans(
  token: Token,
  depth: number,
  inherited: RichTextSpanMarks,
): RichTextSpan[] {
  switch (token.type) {
    case 'text':
      return [{ text: extractTokenText(token), ...inherited }];
    case 'strong':
      return nestedInlineSpans(token, depth, { ...inherited, bold: true });
    case 'em':
      return nestedInlineSpans(token, depth, { ...inherited, italic: true });
    case 'codespan':
      return [{ text: (token as Tokens.Codespan).text, ...inherited, code: true }];
    case 'link': {
      const linkUrl = (token as Tokens.Link).href;
      return nestedInlineSpans(token, depth, { ...inherited, linkUrl });
    }
    case 'br':
      return [{ text: '\n', ...inherited }];
    case 'del':
      return nestedInlineSpans(token, depth, inherited);
    case 'image':
      return [{
        text: (token as Tokens.Image).text || (token as Tokens.Image).href,
        ...inherited,
        linkUrl: (token as Tokens.Image).href,
      }];
    default:
      // Unknown inline: use raw text.
      const raw = (token as { raw?: string }).raw;
      return raw ? [{ text: raw, ...inherited }] : [];
  }
}

function nestedInlineSpans(
  token: Token,
  depth: number,
  inherited: RichTextSpanMarks,
): RichTextSpan[] {
  const nested = (token as Token & { tokens?: Token[] }).tokens;
  if (nested?.length) return parseInlineTokens(nested, depth + 1, inherited);
  const text = extractTokenText(token);
  return text ? [{ text, ...inherited }] : [];
}

function extractTokenText(token: Token): string {
  const t = token as Token & { text?: string; raw?: string; tokens?: Token[] };
  if (typeof t.text === 'string') return t.text;
  if (typeof t.raw === 'string') return t.raw;
  if (Array.isArray(t.tokens)) {
    return t.tokens.map(extractTokenText).join('');
  }
  return '';
}
