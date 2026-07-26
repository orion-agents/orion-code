/**
 * Rich text block model: renderer-independent structured Markdown output.
 *
 * Parsed from model text via marked.lexer(), normalized into a fixed
 * block/span union. Layout consumes this model to produce StyledRow[]
 * without depending on React or JSX.
 */

import type { TuiStyle } from '../../tui-core/style';

export interface RichTextSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  linkUrl?: string;
}

export interface DiffLine {
  kind: 'add' | 'remove' | 'context' | 'hunk' | 'meta';
  content: string;
}

export type RichTextBlock =
  | { type: 'paragraph'; spans: RichTextSpan[] }
  | { type: 'heading'; level: number; spans: RichTextSpan[] }
  | { type: 'list'; ordered: boolean; items: RichTextBlock[][] }
  | { type: 'quote'; blocks: RichTextBlock[] }
  | { type: 'code'; language?: string; lines: string[] }
  | { type: 'diff'; lines: DiffLine[] }
  | { type: 'table'; headers: RichTextSpan[][]; rows: RichTextSpan[][][] }
  | { type: 'rule' };

export interface RichTextDocument {
  blocks: RichTextBlock[];
}

// Resource limits (deterministic degradation, never OOM)
export const MAX_RICH_TEXT_INPUT_BYTES = 1_000_000;
export const MAX_RICH_TEXT_BLOCKS = 2_000;
export const MAX_MARKDOWN_NESTING = 4;
export const MAX_TABLE_COLUMNS = 20;
export const MAX_TABLE_ROWS = 200;

// Semantic style mapping (resolved by layout using theme)
export type RichTextStyleToken =
  | 'assistantText'
  | 'heading'
  | 'code'
  | 'inlineCode'
  | 'link'
  | 'diffAdded'
  | 'diffRemoved'
  | 'diffHunk'
  | 'warning'
  | 'error'
  | 'muted';

/** Resolve a semantic token to a TuiStyle via theme. */
export type RichTextThemeResolver = (token: RichTextStyleToken) => TuiStyle;
