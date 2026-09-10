/**
 * v0.3.15 — pixel-matrix wordmark.
 *
 * Renders short brand strings as real pixel art on a 5×7 dot-matrix grid,
 * instead of leaning on a monospace font (which reads as "code" but is still
 * a smooth anti-aliased font). Every lit cell becomes a hard-edged square, so
 * the label matches the blocksmith pixel UI at any scale.
 *
 * Decorative by contract like `OrionBrandMark`: the SVG carries an
 * `aria-label` with the plain text so assistive tech still reads the name.
 */
import { useMemo } from 'react';

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
/** One blank column between glyphs. */
const GLYPH_GAP = 1;

/**
 * 5×7 dot-matrix glyphs. `#` = lit pixel, `.` = empty.
 * Lowercase x-height fills rows 2–6; ascenders (`d`) and the `i` dot use the
 * top rows, the hyphen sits on the x-height midline.
 */
const GLYPHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  c: ['.....', '.....', '.###.', '#....', '#....', '#....', '.###.'],
  d: ['....#', '....#', '.####', '#...#', '#...#', '#...#', '.####'],
  e: ['.....', '.....', '.###.', '#...#', '#####', '#....', '.###.'],
  i: ['..#..', '.....', '..#..', '..#..', '..#..', '..#..', '..#..'],
  n: ['.....', '.....', '#.##.', '##..#', '#...#', '#...#', '#...#'],
  o: ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.'],
  r: ['.....', '.....', '#.##.', '##..#', '#....', '#....', '#....'],
  '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'],
});

interface PixelRun {
  readonly x: number;
  readonly y: number;
  readonly w: number;
}

/**
 * Collapses each glyph row into horizontal runs so a word costs ~40 rects
 * instead of one per lit cell (~150).
 */
function buildRuns(text: string): readonly PixelRun[] {
  const runs: PixelRun[] = [];
  let offset = 0;
  for (const character of text.toLocaleLowerCase()) {
    const glyph = GLYPHS[character];
    if (glyph) {
      glyph.forEach((row, y) => {
        let runStart = -1;
        for (let x = 0; x <= GLYPH_WIDTH; x += 1) {
          const lit = x < GLYPH_WIDTH && row[x] === '#';
          if (lit && runStart < 0) runStart = x;
          else if (!lit && runStart >= 0) {
            runs.push({ x: offset + runStart, y, w: x - runStart });
            runStart = -1;
          }
        }
      });
    }
    offset += GLYPH_WIDTH + GLYPH_GAP;
  }
  return runs;
}

export interface PixelWordmarkProps {
  readonly text: string;
  /** Integer device pixels per artboard pixel. Keeps edges crisp. */
  readonly scale?: number;
  readonly className?: string;
}

export function PixelWordmark({ text, scale = 2, className }: PixelWordmarkProps) {
  const runs = useMemo(() => buildRuns(text), [text]);
  const artboardWidth = text.length * (GLYPH_WIDTH + GLYPH_GAP) - GLYPH_GAP;
  if (!runs.length) return null;
  return (
    <svg
      className={className ? `pixel-wordmark ${className}` : 'pixel-wordmark'}
      viewBox={`0 0 ${artboardWidth} ${GLYPH_HEIGHT}`}
      width={artboardWidth * scale}
      height={GLYPH_HEIGHT * scale}
      shapeRendering="crispEdges"
      role="img"
      aria-label={text}
    >
      {runs.map(run => (
        <rect
          key={`${run.x}-${run.y}`}
          x={run.x}
          y={run.y}
          width={run.w}
          height={1}
          style={{ fill: 'var(--text)' }}
        />
      ))}
    </svg>
  );
}
