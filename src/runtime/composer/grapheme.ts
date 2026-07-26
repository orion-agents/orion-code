/**
 * Shared grapheme segmentation utilities.
 *
 * Migrated from `src/ink-ui/runtime/grapheme.ts` to provide a
 * renderer-independent grapheme boundary API. Ink re-exports from
 * here; TUI imports directly.
 *
 * Grapheme boundaries are the atomic unit of cursor movement, deletion
 * and visual width in both Ink and TUI prompt input.
 */

export interface GraphemeSegment {
  segment: string;
  index: number;
}

type SegmenterLike = new (
  locale?: string | string[],
  options?: { granularity?: 'grapheme' }
) => {
  segment(value: string): Iterable<GraphemeSegment>;
};

export function segmentGraphemes(value: string): GraphemeSegment[] {
  const SegmenterCtor = (Intl as unknown as { Segmenter?: SegmenterLike }).Segmenter;

  if (typeof SegmenterCtor === 'function') {
    try {
      return Array.from(new SegmenterCtor(undefined, { granularity: 'grapheme' }).segment(value));
    } catch {
      // Fall back to code point segmentation below.
    }
  }

  const segments: GraphemeSegment[] = [];
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index);
    const segment = codePoint === undefined ? '' : String.fromCodePoint(codePoint);
    if (!segment) break;
    segments.push({ segment, index });
    index += segment.length;
  }
  return segments;
}

export function previousGraphemeBoundary(value: string, cursor: number): number {
  const current = Math.min(Math.max(0, Math.floor(cursor)), value.length);
  let previous = 0;

  for (const part of segmentGraphemes(value)) {
    if (part.index >= current) break;
    previous = part.index;
  }

  return previous;
}

export function nextGraphemeBoundary(value: string, cursor: number): number {
  const current = Math.min(Math.max(0, Math.floor(cursor)), value.length);
  if (current >= value.length) return value.length;

  for (const part of segmentGraphemes(value)) {
    const end = part.index + part.segment.length;
    if (end > current) return end;
  }

  return value.length;
}

export function floorGraphemeBoundary(value: string, cursor: number): number {
  const current = Math.min(Math.max(0, Math.floor(cursor)), value.length);
  if (current >= value.length) return value.length;

  for (const part of segmentGraphemes(value)) {
    const end = part.index + part.segment.length;
    if (current < part.index) break;
    if (current <= end) {
      return current === end ? end : part.index;
    }
  }

  return value.length;
}
