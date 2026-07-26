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
    (cp >= 0x4E00 && cp <= 0x9FFF) ||
    // CJK Extension A
    (cp >= 0x3400 && cp <= 0x4DBF) ||
    // CJK Extension B
    (cp >= 0x20000 && cp <= 0x2A6DF) ||
    // CJK Extension C
    (cp >= 0x2A700 && cp <= 0x2B73F) ||
    // CJK Extension D
    (cp >= 0x2B740 && cp <= 0x2B81F) ||
    // CJK Compatibility Ideographs
    (cp >= 0xF900 && cp <= 0xFAFF) ||
    // CJK Compatibility Ideographs Supplement
    (cp >= 0x2F800 && cp <= 0x2FA1F) ||
    // Hiragana (Japanese)
    (cp >= 0x3040 && cp <= 0x309F) ||
    // Katakana (Japanese)
    (cp >= 0x30A0 && cp <= 0x30FF) ||
    // Katakana Phonetic Extensions
    (cp >= 0x31F0 && cp <= 0x31FF) ||
    // Hangul Syllables (Korean)
    (cp >= 0xAC00 && cp <= 0xD7AF) ||
    // Hangul Jamo
    (cp >= 0x1100 && cp <= 0x11FF) ||
    // Hangul Compatibility Jamo
    (cp >= 0x3130 && cp <= 0x318F) ||
    // Fullwidth Forms (CJK punctuation, etc.)
    (cp >= 0xFF00 && cp <= 0xFFEF)
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
  messages: Array<{ content?: string | null; role?: string }>
): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.content) {
      // Add overhead for message framing (~4 tokens per message)
      total += estimateTokens(msg.content) + 4;
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
