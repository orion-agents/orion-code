/**
 * v0.3.12 — Context text helpers shared by the controller when resolving
 * version-bound references (file_range etc.). Pure and unit-tested.
 */

export interface ExtractedLines {
  readonly text: string;
  /** True when the requested range reached the end of the file before endLine. */
  readonly clampedAtEnd: boolean;
}

/** Extract a 1-based inclusive line range. Never throws for out-of-range input. */
export function extractLineRange(
  content: string,
  startLine: number,
  endLine: number
): ExtractedLines {
  const start = Math.max(1, Math.trunc(startLine));
  const end = Math.max(start, Math.trunc(endLine));
  const lines = content.split('\n');
  if (start > lines.length) {
    return Object.freeze({ text: '', clampedAtEnd: true });
  }
  const last = Math.min(end, lines.length);
  const slice = lines.slice(start - 1, last);
  return Object.freeze({
    text: slice.join('\n'),
    clampedAtEnd: end > lines.length,
  });
}

/** Soft per-reference byte budget for line content sent to the model context. */
export function enforceContextBudget(
  text: string,
  maxBytes: number
): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return Object.freeze({ text, truncated: false });
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return Object.freeze({ text: text.slice(0, low), truncated: true });
}
