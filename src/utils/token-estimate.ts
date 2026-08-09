/**
 * orion code - Token estimation utilities
 *
 * Accurate token estimation that accounts for CJK characters,
 * which have significantly different token ratios than ASCII text.
 *
 * CJK characters: ~1.5 tokens/char (vs ~0.25 for ASCII words)
 * This is critical for bilingual (CN/EN) coding agents.
 */

/**
 * Check if a character is a CJK (Chinese/Japanese/Korean) character
 * These characters typically consume ~1.5 tokens each in most tokenizers
 */
function isCJK(char: string): boolean {
  const cp = char.codePointAt(0) || 0;
  return (
    // CJK Unified Ideographs
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    // CJK Extension A
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    // CJK Extension B
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    // CJK Extension C
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    // CJK Extension D
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    // CJK Compatibility Ideographs
    (cp >= 0xf900 && cp <= 0xfaff) ||
    // CJK Compatibility Ideographs Supplement
    (cp >= 0x2f800 && cp <= 0x2fa1f) ||
    // Hiragana (Japanese)
    (cp >= 0x3040 && cp <= 0x309f) ||
    // Katakana (Japanese)
    (cp >= 0x30a0 && cp <= 0x30ff) ||
    // Katakana Phonetic Extensions
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    // Hangul Syllables (Korean)
    (cp >= 0xac00 && cp <= 0xd7af) ||
    // Hangul Jamo
    (cp >= 0x1100 && cp <= 0x11ff) ||
    // Hangul Compatibility Jamo
    (cp >= 0x3130 && cp <= 0x318f) ||
    // Fullwidth Forms (CJK punctuation, etc.)
    (cp >= 0xff00 && cp <= 0xffef)
  );
}

/**
 * Check if a character is a whitespace/newline
 */
function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

/**
 * Estimate token count for a given text.
 *
 * Token ratios by character type (approximate, based on common tokenizers):
 * - CJK characters: ~1.5 tokens/char (each CJK char is typically 1-2 tokens)
 * - ASCII letters/digits: ~0.25 tokens/char (4 chars per token on average)
 * - Punctuation: ~1 token/char (each punctuation mark is often its own token)
 * - Whitespace: ~0.5 tokens/char (spaces often grouped, newlines are separate)
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated token count (integer)
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let tokens = 0;
  let asciiRun = 0;

  for (const char of text) {
    if (isCJK(char)) {
      // Flush any accumulated ASCII run
      if (asciiRun > 0) {
        tokens += Math.ceil(asciiRun / 4);
        asciiRun = 0;
      }
      // CJK characters: ~1.5 tokens each
      tokens += 1.5;
    } else if (isWhitespace(char)) {
      // Flush ASCII run
      if (asciiRun > 0) {
        tokens += Math.ceil(asciiRun / 4);
        asciiRun = 0;
      }
      // Newlines are typically their own token
      if (char === '\n') {
        tokens += 1;
      } else {
        tokens += 0.5;
      }
    } else if (char.codePointAt(0)! < 128) {
      // ASCII letter/digit - accumulate for word-level estimation
      asciiRun++;
    } else {
      // Non-ASCII punctuation/symbols - flush ASCII run first
      if (asciiRun > 0) {
        tokens += Math.ceil(asciiRun / 4);
        asciiRun = 0;
      }
      // Punctuation and symbols: ~1 token each
      tokens += 1;
    }
  }

  // Flush remaining ASCII run
  if (asciiRun > 0) {
    tokens += Math.ceil(asciiRun / 4);
  }

  return Math.ceil(tokens);
}

/**
 * Estimate tokens for an array of messages (for compact/autocompact fallback).
 *
 * @param messages - Array of message objects with content
 * @returns Estimated total token count
 */
export function estimateMessagesTokens(
  messages: Array<{
    content?: string | null;
    role?: string;
    tool_call_id?: string;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  }>
): number {
  let total = 0;
  for (const msg of messages) {
    // Charge framing even for the common assistant message whose content is
    // empty because it consists entirely of tool calls.
    total += 4;
    if (msg.content) total += estimateTokens(msg.content);
    if (msg.tool_call_id) total += estimateTokens(msg.tool_call_id);
    for (const toolCall of msg.tool_calls ?? []) {
      total += 4;
      if (toolCall.id) total += estimateTokens(toolCall.id);
      if (toolCall.function?.name) total += estimateTokens(toolCall.function.name);
      if (toolCall.function?.arguments) {
        total += estimateTokens(toolCall.function.arguments);
      }
    }
  }
  return total;
}

/**
 * Quick token estimate using character count as fallback.
 * Uses a more conservative ratio than text.length / 4.
 *
 * @param textLength - Character count of the text
 * @param hasCJK - Whether the text contains CJK characters
 * @returns Estimated token count
 */
export function quickTokenEstimate(textLength: number, hasCJK = false): number {
  if (hasCJK) {
    // CJK-heavy text: ~1.5 tokens per char
    return Math.ceil(textLength * 1.5);
  }
  // ASCII-heavy text: ~0.25 tokens per char
  return Math.ceil(textLength / 4);
}
