import type { SurfaceOutput, SurfaceOutputEvent } from '../src/tui-ui/inline-surface';

function blankRow(width: number): string[] {
  return Array.from({ length: width }, () => ' ');
}

/** Minimal terminal emulator for the relative cursor protocol used by the TUI. */
export class TerminalStateModel {
  width: number;
  height: number;
  readonly scrollback: string[] = [];
  private screen: string[][];
  private cursorRow = 0;
  private cursorColumn = 0;
  private autowrap = true;
  private pendingWrap = false;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.screen = Array.from({ length: height }, () => blankRow(width));
  }

  write(chunk: string): void {
    let index = 0;
    while (index < chunk.length) {
      if (chunk[index] === '\x1b' && chunk[index + 1] === '[') {
        const match = chunk.slice(index).match(/^\x1b\[([?0-9;]*)([A-Za-z])/);
        if (!match) throw new Error(`unsupported terminal sequence at offset ${index}`);
        this.applyCsi(match[1], match[2]);
        index += match[0].length;
        continue;
      }

      const char = String.fromCodePoint(chunk.codePointAt(index)!);
      index += char.length;
      if (char === '\r') {
        this.cursorColumn = 0;
        this.pendingWrap = false;
      } else if (char === '\n') {
        this.lineFeed();
      } else {
        this.putChar(char);
      }
    }
  }

  resize(width: number, height: number): void {
    const nextWidth = Math.max(1, width);
    const nextHeight = Math.max(1, height);
    this.screen = this.screen.map(row => [
      ...row.slice(0, nextWidth),
      ...blankRow(Math.max(0, nextWidth - row.length)),
    ]);

    if (nextHeight < this.height) {
      const removed = this.screen.splice(0, this.height - nextHeight);
      this.scrollback.push(...removed.map(row => row.join('').trimEnd()));
      this.cursorRow = Math.max(0, this.cursorRow - removed.length);
    } else {
      while (this.screen.length < nextHeight) this.screen.push(blankRow(nextWidth));
    }

    this.width = nextWidth;
    this.height = nextHeight;
    this.cursorRow = Math.min(this.cursorRow, nextHeight - 1);
    this.cursorColumn = Math.min(this.cursorColumn, nextWidth - 1);
    this.pendingWrap = false;
  }

  /**
   * Reflow a known cursor-owned region as full terminal rows. This models the
   * primary-screen behavior that matters to resize recovery without pretending
   * to be a complete terminal reflow implementation.
   */
  reflowRegion(startRow: number, rowCount: number, width: number): void {
    const nextWidth = Math.max(1, width);
    const safeStart = Math.max(0, Math.min(startRow, this.screen.length));
    const safeCount = Math.max(0, Math.min(rowCount, this.screen.length - safeStart));
    const before = this.screen.slice(0, safeStart).map(row => row.join(''));
    const region = this.screen.slice(safeStart, safeStart + safeCount).map(row => row.join(''));
    const after = this.screen.slice(safeStart + safeCount).map(row => row.join(''));
    const cursorRegionRow = Math.max(0, Math.min(safeCount - 1, this.cursorRow - safeStart));
    const physicalRowsPerLogical = Math.max(1, Math.ceil(this.width / nextWidth));
    const nextCursorRow = safeStart
      + cursorRegionRow * physicalRowsPerLogical
      + Math.floor(this.cursorColumn / nextWidth);
    const nextCursorColumn = this.cursorColumn % nextWidth;
    const split = (line: string): string[] => {
      const chunks: string[] = [];
      for (let offset = 0; offset < line.length; offset += nextWidth) {
        chunks.push(line.slice(offset, offset + nextWidth));
      }
      return chunks.length > 0 ? chunks : [''];
    };
    const expandedRegion = region.flatMap(split);
    const growth = Math.max(0, expandedRegion.length - region.length);
    let reclaimableTrailingRows = 0;
    for (let index = after.length - 1; index >= 0; index -= 1) {
      if (after[index].trim().length > 0) break;
      reclaimableTrailingRows += 1;
    }
    const reclaimedRows = Math.min(growth, reclaimableTrailingRows);
    const remainingAfter = reclaimedRows > 0
      ? after.slice(0, after.length - reclaimedRows)
      : after;
    const rows = [
      ...before.map(line => line.slice(0, nextWidth)),
      ...expandedRegion,
      ...remainingAfter.map(line => line.slice(0, nextWidth)),
    ];
    const overflow = Math.max(0, rows.length - this.height);
    if (overflow > 0) {
      this.scrollback.push(...rows.slice(0, overflow).map(line => line.trimEnd()));
    }
    this.screen = rows.slice(overflow).map(line => [
      ...Array.from(line),
      ...blankRow(Math.max(0, nextWidth - Array.from(line).length)),
    ].slice(0, nextWidth));
    while (this.screen.length < this.height) this.screen.push(blankRow(nextWidth));
    this.width = nextWidth;
    this.cursorRow = Math.max(0, Math.min(this.height - 1, nextCursorRow - overflow));
    this.cursorColumn = Math.min(nextWidth - 1, nextCursorColumn);
    this.pendingWrap = false;
  }

  visibleRows(): string[] {
    return this.screen.map(row => row.join('').trimEnd());
  }

  allRows(): string[] {
    return [...this.scrollback, ...this.visibleRows()];
  }

  text(): string {
    return this.allRows().join('\n');
  }

  private applyCsi(parameters: string, final: string): void {
    const amount = Number(parameters || '1') || 1;
    switch (final) {
      case 'A':
        this.cursorRow = Math.max(0, this.cursorRow - amount);
        this.pendingWrap = false;
        return;
      case 'B':
        this.cursorRow = Math.min(this.height - 1, this.cursorRow + amount);
        this.pendingWrap = false;
        return;
      case 'C':
        this.cursorColumn = Math.min(this.width - 1, this.cursorColumn + amount);
        this.pendingWrap = false;
        return;
      case 'K':
        if (parameters !== '2') throw new Error(`unsupported EL mode: ${parameters}`);
        this.screen[this.cursorRow] = blankRow(this.width);
        this.pendingWrap = false;
        return;
      case 'h':
      case 'l':
        if (parameters === '?7') this.autowrap = final === 'h';
        return;
      case 'm':
        return;
      default:
        throw new Error(`unsupported CSI sequence: ${parameters}${final}`);
    }
  }

  private lineFeed(): void {
    this.pendingWrap = false;
    if (this.cursorRow < this.height - 1) {
      this.cursorRow += 1;
      return;
    }
    const removed = this.screen.shift() ?? blankRow(this.width);
    this.scrollback.push(removed.join('').trimEnd());
    this.screen.push(blankRow(this.width));
  }

  private putChar(char: string): void {
    if (this.pendingWrap && this.autowrap) {
      this.cursorColumn = 0;
      this.lineFeed();
    }
    this.pendingWrap = false;
    this.screen[this.cursorRow][this.cursorColumn] = char;
    if (this.cursorColumn === this.width - 1) {
      this.pendingWrap = this.autowrap;
      return;
    }
    this.cursorColumn += 1;
  }
}

export class TerminalModelOutput implements SurfaceOutput {
  readonly chunks: string[] = [];
  writable = true;
  private drainListeners: Array<(error?: unknown) => void> = [];

  constructor(readonly terminal: TerminalStateModel) {}

  write(chunk: string | Uint8Array): boolean {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    this.chunks.push(text);
    this.terminal.write(text);
    return true;
  }

  on(event: SurfaceOutputEvent, listener: (error?: unknown) => void): this {
    if (event === 'drain') this.drainListeners.push(listener);
    return this;
  }

  off(event: SurfaceOutputEvent, listener: (error?: unknown) => void): this {
    if (event === 'drain') {
      this.drainListeners = this.drainListeners.filter(candidate => candidate !== listener);
    }
    return this;
  }
}

export class BackpressureOutput implements SurfaceOutput {
  readonly chunks: string[] = [];
  writable = true;
  blocked = false;
  private listeners: Record<SurfaceOutputEvent, Array<(error?: unknown) => void>> = {
    drain: [],
    error: [],
    close: [],
  };

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return !this.blocked;
  }

  on(event: SurfaceOutputEvent, listener: (error?: unknown) => void): this {
    this.listeners[event].push(listener);
    return this;
  }

  off(event: SurfaceOutputEvent, listener: (error?: unknown) => void): this {
    this.listeners[event] = this.listeners[event].filter(candidate => candidate !== listener);
    return this;
  }

  drain(): void {
    this.blocked = false;
    for (const listener of [...this.listeners.drain]) listener();
  }

  close(): void {
    this.writable = false;
    for (const listener of [...this.listeners.close]) listener();
  }

  fail(error: Error): void {
    for (const listener of [...this.listeners.error]) listener(error);
  }
}
