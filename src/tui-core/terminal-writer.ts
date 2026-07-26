import {
  diffTuiFrames,
  renderStyledFrameRow,
  type TuiFrame,
  type TuiFrameDiff,
} from './frame';
import { encodeStyleToSgr, SGR_RESET, shouldSuppressColor } from './style';

export interface TuiTerminalRenderResult {
  output: string;
  diff: TuiFrameDiff;
}

export interface TuiTerminalWriterOptions {
  /**
   * Hide the terminal cursor while row updates are written, then restore the
   * frame-declared cursor state at the end of the batch.
   */
  bracketCursor?: boolean;
  /**
   * Disable terminal autowrap while painting exact-width rows. Writing a full
   * border row into the last column can otherwise leave some terminals in a
   * pending-wrap state, which makes the real cursor drift away from the input.
   */
  bracketAutoWrap?: boolean;
}

export class TuiTerminalWriter {
  private previous: TuiFrame | null = null;

  constructor(
    private readonly output: Pick<NodeJS.WriteStream, 'write'>,
    private readonly options: TuiTerminalWriterOptions = {}
  ) {}

  render(frame: TuiFrame): TuiTerminalRenderResult {
    const result = renderTerminalFrame(this.previous, frame, this.options);
    if (result.output) {
      this.output.write(result.output);
    }
    this.previous = cloneFrame(frame);
    return result;
  }

  reset(): void {
    this.previous = null;
  }
}

export function renderTerminalFrame(
  previous: TuiFrame | null,
  next: TuiFrame,
  options: TuiTerminalWriterOptions = {}
): TuiTerminalRenderResult {
  const diff = diffTuiFrames(previous, next);
  const chunks: string[] = [];
  const bracketCursor = options.bracketCursor ?? true;
  const shouldPaint = diff.changedRows.length > 0 || diff.cursorChanged;
  const bracketAutoWrap = options.bracketAutoWrap ?? true;
  const suppressColor = shouldSuppressColor();

  if (shouldPaint && bracketAutoWrap) {
    chunks.push(disableAutoWrap());
  }

  if (bracketCursor && shouldPaint) {
    chunks.push(cursorHide());
  }

  for (const rowIndex of diff.changedRows) {
    chunks.push(moveTo(rowIndex, 0));
    chunks.push(clearLine());
    // Emit styled spans: SGR per span, SGR0 reset at end (only if styled).
    const spans = renderStyledFrameRow(next.rows[rowIndex] ?? []);
    let emittedSgr = false;
    for (const span of spans) {
      const sgr = encodeStyleToSgr(span.style, suppressColor);
      if (sgr) {
        chunks.push(sgr);
        emittedSgr = true;
      }
      chunks.push(span.text);
    }
    if (emittedSgr) chunks.push(SGR_RESET);
  }

  if (diff.cursorChanged || diff.changedRows.length > 0) {
    chunks.push(moveTo(next.cursor.row, next.cursor.column));
  }

  if (bracketCursor && shouldPaint) {
    chunks.push(next.cursor.visible ? cursorShow() : cursorHide());
  } else if (diff.cursorChanged && !next.cursor.visible) {
    chunks.push(cursorHide());
  }

  if (shouldPaint && bracketAutoWrap) {
    chunks.push(enableAutoWrap());
  }

  return {
    output: chunks.join(''),
    diff,
  };
}

export function moveTo(row: number, column: number): string {
  return `\x1b[${Math.max(1, Math.floor(row) + 1)};${Math.max(1, Math.floor(column) + 1)}H`;
}

export function clearLine(): string {
  return '\x1b[2K';
}

export function cursorHide(): string {
  return '\x1b[?25l';
}

export function cursorShow(): string {
  return '\x1b[?25h';
}

export function disableAutoWrap(): string {
  return '\x1b[?7l';
}

export function enableAutoWrap(): string {
  return '\x1b[?7h';
}

function cloneFrame(frame: TuiFrame): TuiFrame {
  return {
    width: frame.width,
    height: frame.height,
    cursor: { ...frame.cursor },
    rows: frame.rows.map(row => row.map(cell => ({ ...cell }))),
  };
}
