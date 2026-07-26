/**
 * Rich text sanitizer.
 *
 * Delegates to the shared terminal sanitizer for control-character stripping,
 * then applies additional rich-text-specific normalization for Markdown
 * parsing safety.
 */

import { sanitizeTerminalText } from '../../tui-core/style';

/**
 * Sanitize raw model text before Markdown parsing.
 * Normalizes line endings first, then strips ANSI/escape sequences.
 */
export function sanitizeRichTextInput(text: string): string {
  // Normalize line endings BEFORE stripping control chars (so \r is preserved).
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Strip escape sequences and control chars (except \n, \t).
  return sanitizeTerminalText(normalized, 4);
}

/**
 * Sanitize a code block's content for display.
 * Preserves whitespace and indentation, strips escape sequences.
 */
export function sanitizeCodeContent(code: string): string {
  // Code blocks keep their content mostly intact but strip ANSI escape sequences.
  const normalized = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return sanitizeTerminalText(normalized, 4);
}
