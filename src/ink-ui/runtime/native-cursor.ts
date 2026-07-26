import stringWidth from 'string-width';
import { segmentGraphemes } from './grapheme';

export interface NativeCursorState {
  enabled: boolean;
  column: number;
  rowsUp: number;
  cursorLineIndex?: number;
  row?: number;
  absolute?: boolean;
}

interface InkYogaNode {
  getComputedLeft?: () => number;
  getComputedTop?: () => number;
  getComputedHeight?: () => number;
}

export interface InkDomNodeLike {
  yogaNode?: InkYogaNode;
  parentNode?: InkDomNodeLike | null;
}

export interface NativeCursorAnchor {
  column: number;
  rowsUp: number;
  row: number;
}

export interface CursorPosition {
  row: number;
  column: number;
}

export function nativeCursorUnparkSequence(rowsUp: number): string {
  return nativeCursorMoveSequence(
    { row: -Math.max(1, rowsUp), column: 0 },
    { row: 0, column: 0 }
  );
}

export function nativeCursorParkSequence(state: NativeCursorState): string {
  const rowsUp = Math.max(1, state.rowsUp);
  const column = Math.max(1, state.column);
  return `\x1b[?25h${nativeCursorMoveSequence(
    { row: 0, column: 0 },
    { row: -rowsUp, column: column - 1 }
  )}`;
}

export function nativeCursorAbsoluteMoveSequence(to: CursorPosition): string {
  const row = Math.max(0, Math.floor(to.row));
  const column = Math.max(0, Math.floor(to.column));
  return `\x1b[${row + 1};${column + 1}H`;
}

export function nativeCursorAbsoluteParkSequence(to: CursorPosition): string {
  return `\x1b[?25h${nativeCursorAbsoluteMoveSequence(to)}`;
}

export function nativeCursorMoveSequence(from: CursorPosition, to: CursorPosition): string {
  const rowDelta = to.row - from.row;
  let sequence = '';

  if (rowDelta < 0) {
    sequence += `\x1b[${Math.abs(rowDelta)}A`;
  } else if (rowDelta > 0) {
    sequence += `\x1b[${rowDelta}B`;
  }

  if (rowDelta !== 0 || from.column !== to.column) {
    sequence += '\r';
    if (to.column > 0) {
      sequence += `\x1b[${to.column + 1}G`;
    }
  }

  return sequence;
}

export class NativeCursorController {
  private cursorState: NativeCursorState = {
    enabled: false,
    column: 5,
    rowsUp: 2,
  };
  private cursorParked = false;
  private parkedState: NativeCursorState | null = null;
  private frameCursor: CursorPosition = { row: 0, column: 0 };
  private physicalCursor: CursorPosition = { row: 0, column: 0 };
  private restoreScheduled = false;
  private promptTopRow: number | null = null;
  private observedLines = new Map<number, string>();
  private parkedWithAbsoluteTarget = false;
  private restoreGeneration = 0;

  constructor(private readonly output: NodeJS.WriteStream) {}

  wrapStdout(): NodeJS.WriteStream {
    return new Proxy(this.output, {
      get: (target, property, receiver) => {
        if (property === 'write') {
          return (...args: Parameters<NodeJS.WriteStream['write']>) => {
            this.unpark(target);
            const result = target.write(...args);
            const observation = observeTerminalOutput(
              this.physicalCursor,
              args[0],
              target.columns || this.output.columns || 80,
              target.rows || this.output.rows || 24,
              this.observedLines
            );
            this.physicalCursor = observation.cursor;
            if (observation.promptTopRow !== null) {
              this.promptTopRow = observation.promptTopRow;
            }
            this.frameCursor = { ...this.physicalCursor };
            // Keep the native cursor synchronized with the rendered frame.
            // Once a prompt frame has been observed, even later control-only
            // chunks such as cursor-hide must re-park immediately so IME
            // composition has no visible window to attach to the frame tail.
            // Before the first prompt is seen, coalesce partial Ink writes.
            if (this.promptTopRow !== null) {
              this.restore();
            } else {
              this.scheduleRestore();
            }
            return result;
          };
        }

        const value = Reflect.get(target, property, receiver);
        if (typeof value === 'function') {
          return value.bind(target);
        }

        return value;
      },
      set(target, property, value, receiver) {
        return Reflect.set(target, property, value, receiver);
      },
    });
  }

  setState(state: NativeCursorState): void {
    this.cursorState = state;
  }

  restore(): void {
    if (!this.cursorState.enabled || this.output.isTTY === false) {
      this.unpark();
      return;
    }
    if (this.cursorParked && this.parkedState && nativeCursorStateEquals(this.parkedState, this.cursorState)) {
      return;
    }
    this.unpark();
    this.park();
  }

  disable(): void {
    this.cursorState = { ...this.cursorState, enabled: false };
    this.unpark();
  }

  resetForViewportClear(): void {
    this.restoreGeneration += 1;
    this.cursorParked = false;
    this.parkedState = null;
    this.frameCursor = { row: 0, column: 0 };
    this.physicalCursor = { row: 0, column: 0 };
    this.restoreScheduled = false;
    this.promptTopRow = null;
    this.observedLines.clear();
    this.parkedWithAbsoluteTarget = false;
  }

  private unpark(output: NodeJS.WriteStream = this.output): void {
    if (!this.cursorParked || output.isTTY === false) {
      this.cursorParked = false;
      this.parkedState = null;
      return;
    }

    const sequence = this.parkedWithAbsoluteTarget
      ? nativeCursorAbsoluteMoveSequence(this.frameCursor)
      : nativeCursorMoveSequence(this.physicalCursor, this.frameCursor);
    output.write(sequence);
    this.physicalCursor = applyTerminalOutputToCursor(
      this.physicalCursor,
      sequence,
      output.columns || this.output.columns || 80,
      output.rows || this.output.rows || 24
    );
    this.cursorParked = false;
    this.parkedWithAbsoluteTarget = false;
    this.parkedState = null;
  }

  private park(output: NodeJS.WriteStream = this.output): void {
    if (!this.cursorState.enabled || output.isTTY === false) {
      this.cursorParked = false;
      this.parkedState = null;
      return;
    }

    const target = this.cursorTargetFromFrame(this.cursorState);
    const sequence = target.absolute
      ? nativeCursorAbsoluteParkSequence(target.position)
      : `\x1b[?25h${nativeCursorMoveSequence(this.physicalCursor, target.position)}`;
    output.write(sequence);
    this.physicalCursor = applyTerminalOutputToCursor(
      this.physicalCursor,
      sequence,
      output.columns || this.output.columns || 80,
      output.rows || this.output.rows || 24
    );
    this.parkedState = { ...this.cursorState };
    this.cursorParked = true;
    this.parkedWithAbsoluteTarget = target.absolute;
  }

  private cursorTargetFromFrame(state: NativeCursorState): { position: CursorPosition; absolute: boolean } {
    if (state.absolute && this.promptTopRow !== null) {
      return {
        position: {
          row: this.promptTopRow + 1 + Math.max(0, state.cursorLineIndex ?? 0),
          column: Math.max(1, state.column) - 1,
        },
        absolute: true,
      };
    }

    if (state.absolute && Number.isFinite(state.row)) {
      return {
        position: {
          row: Math.max(0, Math.floor(state.row ?? 0)),
          column: Math.max(1, state.column) - 1,
        },
        absolute: true,
      };
    }

    return {
      position: {
        row: this.frameCursor.row - Math.max(1, state.rowsUp),
        column: Math.max(1, state.column) - 1,
      },
      absolute: false,
    };
  }

  private scheduleRestore(): void {
    if (this.restoreScheduled) return;
    this.restoreScheduled = true;
    const generation = this.restoreGeneration;
    queueMicrotask(() => {
      if (generation !== this.restoreGeneration) return;
      this.restoreScheduled = false;
      this.restore();
    });
  }
}

export function createNativeCursorController(output: NodeJS.WriteStream): NativeCursorController {
  return new NativeCursorController(output);
}

function nativeCursorStateEquals(left: NativeCursorState, right: NativeCursorState): boolean {
  return left.enabled === right.enabled
    && left.column === right.column
    && left.rowsUp === right.rowsUp
    && (left.cursorLineIndex ?? 0) === (right.cursorLineIndex ?? 0)
    && (left.row ?? null) === (right.row ?? null)
    && (left.absolute ?? false) === (right.absolute ?? false);
}

export function nativeCursorAnchorFromNode(
  node: InkDomNodeLike | null | undefined,
  options: { cursorColumn: number; cursorLineIndex: number }
): NativeCursorAnchor | null {
  if (!node?.yogaNode) return null;

  let current: InkDomNodeLike | null | undefined = node;
  let left = 0;
  let top = 0;
  let rootHeight = 0;

  while (current?.yogaNode) {
    left += current.yogaNode.getComputedLeft?.() ?? 0;
    top += current.yogaNode.getComputedTop?.() ?? 0;
    rootHeight = current.yogaNode.getComputedHeight?.() ?? rootHeight;
    current = current.parentNode;
  }

  if (!rootHeight) return null;

  // The prompt box has a top border. The first rendered input row starts one
  // row below that border, and cursorLineIndex is relative to the visible input
  // rows inside the box.
  const targetRow = top + 1 + options.cursorLineIndex;

  return {
    column: Math.max(1, Math.round(left + options.cursorColumn)),
    row: Math.max(0, Math.round(targetRow)),
    // Official Ink writes the dynamic frame and leaves the terminal cursor on
    // the line after the frame. Move back from that render baseline to the
    // declared input row, matching OpenClaude's renderer-owned declaration
    // model as closely as possible without forking Ink yet.
    rowsUp: Math.max(1, Math.round(rootHeight - targetRow)),
  };
}

export function applyTerminalOutputToCursor(
  position: CursorPosition,
  chunk: unknown,
  columns: number,
  rows = Number.MAX_SAFE_INTEGER
): CursorPosition {
  return observeTerminalOutput(position, chunk, columns, rows).cursor;
}

function observeTerminalOutput(
  position: CursorPosition,
  chunk: unknown,
  columns: number,
  rows = Number.MAX_SAFE_INTEGER,
  lineBuffers: Map<number, string> = new Map()
): { cursor: CursorPosition; promptTopRow: number | null } {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
  const cursor = { ...position };
  const width = Math.max(1, columns || 80);
  const graphemes = segmentGraphemes(text);
  let graphemeIndex = 0;
  let promptTopRow: number | null = null;

  for (let index = 0; index < text.length;) {
    const char = text[index];

    if (char === '\x1b') {
      index = consumeEscapeForObservation(text, index, cursor, width, rows, lineBuffers);
      continue;
    }

    if (char === '\r') {
      cursor.column = 0;
      index += 1;
      continue;
    }

    if (char === '\n') {
      cursor.row = clampCursorRow(cursor.row + 1, rows);
      index += 1;
      continue;
    }

    if (char === '\b') {
      cursor.column = Math.max(0, cursor.column - 1);
      index += 1;
      continue;
    }

    while (graphemeIndex < graphemes.length && graphemes[graphemeIndex].index < index) {
      graphemeIndex += 1;
    }

    const grapheme = graphemes[graphemeIndex];
    if (!grapheme || grapheme.index !== index) {
      const codePoint = text.codePointAt(index);
      if (codePoint === undefined) break;
      const printable = String.fromCodePoint(codePoint);
      index += printable.length;
      continue;
    }

    const firstCodePoint = grapheme.segment.codePointAt(0);
    if (firstCodePoint !== undefined && firstCodePoint >= 32) {
      const line = `${lineBuffers.get(cursor.row) ?? ''}${grapheme.segment}`;
      lineBuffers.set(cursor.row, line);
      const trimmed = line.trimEnd();
      if (isPromptTopBorderText(trimmed)) {
        promptTopRow = cursor.row;
      }

      cursor.column += Math.max(0, stringWidth(grapheme.segment));
      if (cursor.column >= width) {
        cursor.column = width - 1;
      }
    }
    index += grapheme.segment.length;
    graphemeIndex += 1;
  }

  return { cursor, promptTopRow };
}


function consumeEscapeForObservation(
  text: string,
  index: number,
  cursor: CursorPosition,
  columns: number,
  rows: number,
  lineBuffers: Map<number, string>
): number {
  if (index + 1 >= text.length) return index + 1;
  const marker = text[index + 1];

  if (marker === '[') {
    let end = index + 2;
    while (end < text.length && !('@' <= text[end] && text[end] <= '~')) {
      end += 1;
    }
    if (end >= text.length) return text.length;
    const params = text.slice(index + 2, end);
    const final = text[end];
    applyCsiToCursor(params, final, cursor, columns, rows);
    applyCsiToObservedLines(params, final, cursor, lineBuffers);
    return end + 1;
  }

  if (marker === ']') {
    const endBel = text.indexOf('\x07', index + 2);
    const endSt = text.indexOf('\x1b\\', index + 2);
    const candidates = [endBel, endSt].filter(position => position >= 0);
    if (candidates.length === 0) return text.length;
    const end = Math.min(...candidates);
    return end + (end === endSt ? 2 : 1);
  }

  return Math.min(text.length, index + 2);
}

function applyCsiToObservedLines(
  params: string,
  final: string,
  cursor: CursorPosition,
  lineBuffers: Map<number, string>
): void {
  const clean = params.replace(/^[?=>]*/, '');
  const parts = clean
    .split(';')
    .filter(part => part !== '')
    .map(part => (/^\d+$/.test(part) ? Number(part) : 0));
  const first = parts[0] ?? 0;

  if (final === 'K') {
    lineBuffers.set(cursor.row, '');
    return;
  }

  if (final === 'J' && first !== 1) {
    lineBuffers.clear();
  }
}

function isPromptTopBorderText(line: string): boolean {
  return line.startsWith('┌') && line.endsWith('┐') && line.includes('─');
}

function applyCsiToCursor(
  params: string,
  final: string,
  cursor: CursorPosition,
  columns: number,
  rows = Number.MAX_SAFE_INTEGER
): void {
  const clean = params.replace(/^[?=>]*/, '');
  const parts = clean
    .split(';')
    .filter(part => part !== '')
    .map(part => (/^\d+$/.test(part) ? Number(part) : 0));
  const first = parts[0] ?? 0;
  const count = first || 1;

  switch (final) {
    case 'A':
      cursor.row = clampCursorRow(cursor.row - count, rows);
      break;
    case 'B':
      cursor.row = clampCursorRow(cursor.row + count, rows);
      break;
    case 'C':
      cursor.column = Math.min(columns - 1, cursor.column + count);
      break;
    case 'D':
      cursor.column = Math.max(0, cursor.column - count);
      break;
    case 'E':
      cursor.row = clampCursorRow(cursor.row + count, rows);
      cursor.column = 0;
      break;
    case 'F':
      cursor.row = clampCursorRow(cursor.row - count, rows);
      cursor.column = 0;
      break;
    case 'G':
      cursor.column = Math.min(columns - 1, Math.max(0, count - 1));
      break;
    case 'H':
    case 'f':
      cursor.row = clampCursorRow((parts[0] || 1) - 1, rows);
      cursor.column = Math.min(columns - 1, Math.max(0, (parts[1] || 1) - 1));
      break;
  }
}

function clampCursorRow(row: number, rows: number): number {
  if (!Number.isFinite(rows) || rows <= 0) return Math.max(0, row);
  return Math.min(rows - 1, Math.max(0, row));
}
