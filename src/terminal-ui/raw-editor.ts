import readline from 'readline';
import stringWidth from 'string-width';
import {
  normalizePastedText,
  TuiInputParser,
  type TuiInputEvent,
  type TuiKey,
} from '../tui-core/input-parser';
import { applySingleTerminalTabCompletion, summarizeTerminalCompletions } from './completion';

const BRACKETED_PASTE_ENABLE = '\x1b[?2004h';
const BRACKETED_PASTE_DISABLE = '\x1b[?2004l';
/** v0.2.22: character-based limit (kept for backward compat, superseded by byte budget). */
const MAX_INPUT_CHARACTERS = 1_000_000;
const MAX_EDITOR_ROWS = 6;
const RENDER_DEBOUNCE_MS = 8;
/** v0.2.23: bounded input history (default 500). */
const MAX_HISTORY_SIZE = 500;
/** v0.2.23: UTF-8 byte budget — soft threshold triggers /edit hint, hard rejects new bytes. */
const INPUT_SOFT_BYTES = 64 * 1024; // 64 KiB
const INPUT_HARD_BYTES = 256 * 1024; // 256 KiB

type RawModeStream = NodeJS.ReadStream & {
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => NodeJS.ReadStream;
};

type RawOutputStream = NodeJS.WriteStream & {
  columns?: number;
  rows?: number;
};

export interface RawTerminalEditorOptions {
  input?: RawModeStream;
  output?: RawOutputStream;
  cwd: string;
  onSubmit: (input: string) => void;
  onCtrlC: () => void;
  onNotice?: (message: string) => void;
}

/** v0.2.23: Deep-copy snapshot of editor state for modal draft preservation. */
export interface TerminalEditorDraftSnapshot {
  value: string;
  cursor: number;
  parserState: {
    mode: 'normal' | 'paste';
    incompleteUtf8: Buffer;
    pasteBuffer: string;
    pendingEscape: string;
  };
  historyIndex: number | null;
  historyDraft: string;
  inputLimitNoticeShown: boolean;
  inputSoftNoticeShown: boolean;
}

export class RawTerminalEditor {
  private readonly input: RawModeStream;
  private readonly output: RawOutputStream;
  private readonly parser = new TuiInputParser();
  private value = '';
  private cursor = 0;
  private promptValue = '';
  private questionPrompt: string | null = null;
  private questionResolve: ((answer: string) => void) | null = null;
  private readonly history: string[] = [];
  private historyIndex: number | null = null;
  private historyDraft = '';
  private running = false;
  private wasRaw = false;
  private resizeListenerAttached = false;
  private renderedRows = 0;
  private renderedCursorRow = 0;
  private inputLimitNoticeShown = false;
  private inputSoftNoticeShown = false;
  private renderTimer: NodeJS.Timeout | null = null;
  /** v0.2.23: saved draft during modal interactions (permission, picker, etc.). */
  private savedDraft: TerminalEditorDraftSnapshot | null = null;

  constructor(private readonly options: RawTerminalEditorOptions) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.wasRaw = this.input.isRaw === true;
    this.input.setEncoding('utf8');
    this.input.resume();
    if (this.input.isTTY && typeof this.input.setRawMode === 'function') {
      this.input.setRawMode(true);
    }
    if (this.output.isTTY !== false) {
      this.output.write(BRACKETED_PASTE_ENABLE);
    }
    this.input.on('data', this.handleData);
    this.attachResizeListener();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.cancelScheduledRender();
    this.input.off('data', this.handleData);
    this.detachResizeListener();
    if (this.output.isTTY !== false) {
      this.output.write(BRACKETED_PASTE_DISABLE);
    }
    if (this.input.isTTY && typeof this.input.setRawMode === 'function') {
      this.input.setRawMode(this.wasRaw);
    }
    if (!this.wasRaw) this.input.pause();
  }

  setPrompt(prompt: string): void {
    this.promptValue = prompt;
    this.render();
  }

  ask(prompt: string, abortSignal?: AbortSignal): Promise<string> {
    if (this.questionResolve) {
      this.questionResolve('');
    }

    // v0.2.23: Save current draft before entering question mode.
    if (!this.savedDraft) {
      this.savedDraft = this.captureDraft();
    }
    // The question owns a fresh parser. Restore the interrupted UTF-8/paste
    // state only after the modal answer has been consumed.
    this.parser.reset();

    this.questionPrompt = prompt;
    this.value = '';
    this.cursor = 0;
    this.render();

    return new Promise(resolve => {
      let settled = false;
      const finish = (answer: string): void => {
        if (settled) return;
        settled = true;
        abortSignal?.removeEventListener('abort', onAbort);
        // v0.2.23: Restore draft in finally via the caller.
        resolve(answer);
      };
      const onAbort = (): void => {
        this.cancelQuestion();
        finish('');
      };

      this.questionResolve = finish;
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      if (abortSignal?.aborted) onAbort();
    });
  }

  cancelQuestion(): void {
    if (!this.questionResolve && !this.questionPrompt) return;
    const resolve = this.questionResolve;
    this.questionPrompt = null;
    this.questionResolve = null;
    this.value = '';
    this.cursor = 0;
    resolve?.('');

    // v0.2.23: Restore the pre-question draft.
    if (this.savedDraft) {
      this.restoreDraft(this.savedDraft);
      this.savedDraft = null;
    }
    this.render();
  }

  writeExternal(text: string): void {
    this.writeExternalBatch([text]);
  }

  /** Write one external batch with a single prompt clear/redraw transaction. */
  writeExternalBatch(chunks: readonly string[]): boolean {
    const text = chunks.filter(Boolean).join('');
    if (!text) return true;
    this.clearPromptLine();
    const accepted = this.output.write(text.endsWith('\n') ? text : `${text}\n`);
    this.render();
    return accepted !== false;
  }

  feed(chunk: Buffer | string): TuiInputEvent[] {
    const events = this.parser.feed(chunk, { detectUnbracketedMultilinePaste: true });
    for (const event of events) {
      this.applyEvent(event);
    }
    return events;
  }

  getBuffer(): { value: string; cursor: number } {
    return { value: this.value, cursor: this.cursor };
  }

  // --- v0.2.23: Modal draft preservation ---

  /** Deep-copy the current editor state for modal restore. */
  captureDraft(): TerminalEditorDraftSnapshot {
    return {
      value: this.value,
      cursor: this.cursor,
      parserState: this.parser.getState(),
      historyIndex: this.historyIndex,
      historyDraft: this.historyDraft,
      inputLimitNoticeShown: this.inputLimitNoticeShown,
      inputSoftNoticeShown: this.inputSoftNoticeShown,
    };
  }

  /** Restore editor state from a snapshot. Null is a safe no-op. */
  restoreDraft(snapshot: TerminalEditorDraftSnapshot | null): void {
    if (!snapshot) return;
    this.value = snapshot.value;
    this.cursor = clampCursor(snapshot.value, snapshot.cursor);
    this.historyIndex = snapshot.historyIndex;
    this.historyDraft = snapshot.historyDraft;
    this.inputLimitNoticeShown = snapshot.inputLimitNoticeShown;
    this.inputSoftNoticeShown = snapshot.inputSoftNoticeShown;
    this.parser.setState(snapshot.parserState);
    this.scheduleRender();
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    this.feed(chunk);
  };

  private readonly handleResize = (): void => {
    if (!this.running) return;
    this.render();
  };

  private attachResizeListener(): void {
    if (this.resizeListenerAttached) return;
    const output = this.output as RawOutputStream & {
      on?: (event: string, listener: () => void) => unknown;
    };
    if (typeof output.on !== 'function') return;
    output.on('resize', this.handleResize);
    this.resizeListenerAttached = true;
  }

  private detachResizeListener(): void {
    if (!this.resizeListenerAttached) return;
    const output = this.output as RawOutputStream & {
      off?: (event: string, listener: () => void) => unknown;
      removeListener?: (event: string, listener: () => void) => unknown;
    };
    if (typeof output.off === 'function') {
      output.off('resize', this.handleResize);
    } else if (typeof output.removeListener === 'function') {
      output.removeListener('resize', this.handleResize);
    }
    this.resizeListenerAttached = false;
  }

  private applyEvent(event: TuiInputEvent): void {
    if (event.type === 'text' || event.type === 'paste') {
      this.insert(event.value);
      if (event.type === 'paste') {
        this.emitPasteNotice(event.value);
      }
      return;
    }
    this.applyKey(event.key);
  }

  private emitPasteNotice(value: string): void {
    const lines = normalizePastedText(value).split('\n').length;
    if (lines < 2) return;
    const suffix = lines >= 20 ? ' /edit is better for very long drafts.' : '';
    this.options.onNotice?.(`Pasted ${lines} lines. Enter sends once; Ctrl+U clears.${suffix}`);
  }

  private applyKey(key: TuiKey): void {
    switch (key) {
      case 'enter':
        this.submit();
        return;
      case 'newline':
        this.insert('\n');
        return;
      case 'tab':
        this.completeInput();
        return;
      case 'backspace':
        this.deleteBeforeCursor();
        return;
      case 'delete':
        this.deleteAfterCursor();
        return;
      case 'left':
        this.cursor = previousBoundary(this.value, this.cursor);
        this.scheduleRender();
        return;
      case 'right':
        this.cursor = nextBoundary(this.value, this.cursor);
        this.scheduleRender();
        return;
      case 'home':
        this.cursor = currentLineStart(this.value, this.cursor);
        this.scheduleRender();
        return;
      case 'end':
        this.cursor = currentLineEnd(this.value, this.cursor);
        this.scheduleRender();
        return;
      case 'up':
        if (this.moveCursorAcrossLines(-1)) return;
        this.moveHistory(-1);
        return;
      case 'down':
        if (this.moveCursorAcrossLines(1)) return;
        this.moveHistory(1);
        return;
      case 'ctrl+u':
        this.setValue('');
        return;
      case 'ctrl+w':
        this.deleteWordBeforeCursor();
        return;
      case 'ctrl+c':
        this.options.onCtrlC();
        return;
      case 'ctrl+l':
        this.redrawPrompt();
        return;
      case 'escape':
      case 'pageup':
      case 'pagedown':
        return;
    }
  }

  // --- v0.2.23: UTF-8 byte budget ---

  /** Current input size in UTF-8 bytes. */
  private byteLength(): number {
    return Buffer.byteLength(this.value, 'utf8');
  }

  /**
   * Try to accept text insertion. Returns the portion that fits within the
   * hard byte budget, or empty string if the budget is exhausted.
   */
  private acceptBytes(text: string): string {
    const current = this.byteLength();
    const remaining = Math.max(0, INPUT_HARD_BYTES - current);
    if (remaining <= 0) {
      // Hard limit: reject all new bytes.
      if (!this.inputSoftNoticeShown) {
        this.inputSoftNoticeShown = true;
        this.options.onNotice?.(
          `Input limit reached (${(INPUT_HARD_BYTES / 1024).toFixed(0)} KiB). Use /edit for larger drafts, or submit/clear existing content.`
        );
      }
      return '';
    }

    // Accept text up to remaining bytes.
    let accepted = '';
    let byteCount = 0;
    // Fast path: if all of text fits within remaining bytes, accept entire string.
    if (Buffer.byteLength(text, 'utf8') <= remaining) {
      accepted = text;
      byteCount = Buffer.byteLength(text, 'utf8');
    } else {
      for (const char of text) {
        const charBytes = Buffer.byteLength(char, 'utf8');
        if (byteCount + charBytes > remaining) break;
        accepted += char;
        byteCount += charBytes;
      }
    }

    // Soft threshold: show /edit hint once.
    const newTotal = current + byteCount;
    if (newTotal >= INPUT_SOFT_BYTES && !this.inputSoftNoticeShown) {
      this.inputSoftNoticeShown = true;
      this.options.onNotice?.(
        `Input is large (${(newTotal / 1024).toFixed(1)} KiB). Consider /edit for better editing.`
      );
    }

    if (accepted.length < text.length) {
      this.options.onNotice?.(
        `Input limit reached (${(INPUT_HARD_BYTES / 1024).toFixed(0)} KiB). Use /edit for larger drafts.`
      );
    }

    return accepted;
  }

  private insert(text: string): void {
    const safeCursor = clampCursor(this.value, this.cursor);

    // v0.2.23: UTF-8 byte budget check.
    const accepted = this.acceptBytes(text);

    // Also enforce the old character-based max as a safety net.
    const charRemaining = Math.max(0, MAX_INPUT_CHARACTERS - this.value.length);
    const finalAccepted = safeSlice(accepted, charRemaining);

    if (!finalAccepted) {
      this.scheduleRender();
      return;
    }
    this.value = `${this.value.slice(0, safeCursor)}${finalAccepted}${this.value.slice(safeCursor)}`;
    this.cursor = safeCursor + finalAccepted.length;
    this.historyIndex = null;
    this.scheduleRender();
  }

  private completeInput(): void {
    const result = applySingleTerminalTabCompletion(this.value, this.options.cwd);
    if (result.changed) {
      this.setValue(result.value);
      return;
    }

    if (result.matches.length > 0) {
      this.options.onNotice?.(summarizeTerminalCompletions(result.matches));
      this.scheduleRender();
    }
  }

  private submit(): void {
    const submitted = this.value;
    this.render();
    this.commitRenderedEditor();
    this.value = '';
    this.cursor = 0;
    this.historyIndex = null;
    this.historyDraft = '';
    this.inputLimitNoticeShown = false;
    this.inputSoftNoticeShown = false;

    if (this.questionPrompt) {
      const resolve = this.questionResolve;
      this.questionPrompt = null;
      this.questionResolve = null;
      // v0.2.23: Restore the pre-question draft after answering.
      if (this.savedDraft) {
        this.restoreDraft(this.savedDraft);
        this.savedDraft = null;
      }
      resolve?.(submitted);
      return;
    }

    if (submitted.trim()) {
      // v0.2.23: dedup adjacent entries and enforce history bound.
      if (this.history.length === 0 || this.history[this.history.length - 1] !== submitted) {
        this.history.push(submitted);
        if (this.history.length > MAX_HISTORY_SIZE) {
          this.history.shift();
        }
      }
    }
    this.options.onSubmit(submitted);
  }

  private setValue(value: string): void {
    this.value = safeSlice(value, MAX_INPUT_CHARACTERS);
    this.cursor = this.value.length;
    this.historyIndex = null;
    this.inputLimitNoticeShown = false;
    this.inputSoftNoticeShown = value.length > this.value.length;
    this.scheduleRender();
  }

  private deleteBeforeCursor(): void {
    const safeCursor = clampCursor(this.value, this.cursor);
    if (safeCursor === 0) return;
    const previous = previousBoundary(this.value, safeCursor);
    this.value = `${this.value.slice(0, previous)}${this.value.slice(safeCursor)}`;
    this.cursor = previous;
    this.scheduleRender();
  }

  private deleteAfterCursor(): void {
    const safeCursor = clampCursor(this.value, this.cursor);
    if (safeCursor >= this.value.length) return;
    const next = nextBoundary(this.value, safeCursor);
    this.value = `${this.value.slice(0, safeCursor)}${this.value.slice(next)}`;
    this.cursor = safeCursor;
    this.scheduleRender();
  }

  private deleteWordBeforeCursor(): void {
    const safeCursor = clampCursor(this.value, this.cursor);
    const before = this.value.slice(0, safeCursor).replace(/\s*\S+\s*$/u, '');
    this.value = `${before}${this.value.slice(safeCursor)}`;
    this.cursor = before.length;
    this.scheduleRender();
  }

  private moveHistory(delta: -1 | 1): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === null) {
      this.historyDraft = this.value;
      this.historyIndex = this.history.length;
    }

    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + delta));
    const next =
      this.historyIndex === this.history.length
        ? this.historyDraft
        : (this.history[this.historyIndex] ?? '');
    this.value = next;
    this.cursor = next.length;
    this.scheduleRender();
  }

  private moveCursorAcrossLines(delta: -1 | 1): boolean {
    if (!this.value.includes('\n')) return false;
    const safeCursor = clampCursor(this.value, this.cursor);
    const start = currentLineStart(this.value, safeCursor);
    const column = safeCursor - start;

    if (delta < 0) {
      if (start === 0) return true;
      const targetEnd = start - 1;
      const targetStart = currentLineStart(this.value, targetEnd);
      this.cursor = Math.min(targetStart + column, targetEnd);
    } else {
      const end = currentLineEnd(this.value, safeCursor);
      if (end >= this.value.length) return true;
      const targetStart = end + 1;
      const targetEnd = currentLineEnd(this.value, targetStart);
      this.cursor = Math.min(targetStart + column, targetEnd);
    }

    this.scheduleRender();
    return true;
  }

  private scheduleRender(): void {
    if (!this.running) {
      this.render();
      return;
    }
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      if (this.running) this.render();
    }, RENDER_DEBOUNCE_MS);
  }

  private cancelScheduledRender(): void {
    if (!this.renderTimer) return;
    clearTimeout(this.renderTimer);
    this.renderTimer = null;
  }

  private render(): void {
    this.cancelScheduledRender();
    const prompt = this.questionPrompt ?? this.promptValue;
    const width = Math.max(20, this.output.columns || 80);
    const terminalRows = Math.max(4, this.output.rows || 24);
    const frame = layoutEditorFrame({
      prompt,
      value: this.value,
      cursor: this.cursor,
      width,
      maxRows: Math.min(MAX_EDITOR_ROWS, Math.max(1, terminalRows - 3)),
    });

    this.clearPromptLine();
    for (let index = 0; index < frame.rows.length; index++) {
      this.output.write(frame.rows[index]);
      if (index < frame.rows.length - 1) this.output.write('\r\n');
    }
    const rowsBelowCursor = frame.rows.length - 1 - frame.cursorRow;
    if (rowsBelowCursor > 0 && this.output.isTTY !== false) {
      readline.moveCursor(this.output, 0, -rowsBelowCursor);
    }
    readline.cursorTo(this.output, frame.cursorColumn);
    this.renderedRows = frame.rows.length;
    this.renderedCursorRow = frame.cursorRow;
  }

  private clearPromptLine(): void {
    if (this.output.isTTY === false) return;
    if (this.renderedRows > 1 && this.renderedCursorRow > 0) {
      readline.moveCursor(this.output, 0, -this.renderedCursorRow);
    }
    readline.cursorTo(this.output, 0);
    const rows = Math.max(1, this.renderedRows);
    for (let index = 0; index < rows; index++) {
      readline.clearLine(this.output, 0);
      if (index < rows - 1) readline.moveCursor(this.output, 0, 1);
    }
    if (rows > 1) readline.moveCursor(this.output, 0, -(rows - 1));
    readline.cursorTo(this.output, 0);
    this.renderedRows = 0;
    this.renderedCursorRow = 0;
  }

  // --- v0.2.23: Ctrl+L prompt-only redraw ---

  /** Redraw only the editor-owned prompt rows without clearing native scrollback. */
  private redrawPrompt(): void {
    // Clear editor-owned rendered rows.
    this.clearPromptLine();
    // Invalidate layout snapshot and re-render current prompt + input.
    this.render();
  }

  private commitRenderedEditor(): void {
    if (this.output.isTTY !== false && this.renderedRows > 0) {
      const rowsBelowCursor = this.renderedRows - 1 - this.renderedCursorRow;
      if (rowsBelowCursor > 0) readline.moveCursor(this.output, 0, rowsBelowCursor);
      readline.cursorTo(this.output, 0);
    }
    this.output.write('\r\n');
    this.renderedRows = 0;
    this.renderedCursorRow = 0;
  }
}

interface EditorFrame {
  rows: string[];
  cursorRow: number;
  cursorColumn: number;
}

function layoutEditorFrame(input: {
  prompt: string;
  value: string;
  cursor: number;
  width: number;
  maxRows: number;
}): EditorFrame {
  const safeCursor = clampCursor(input.value, input.cursor);
  const promptCells = stringWidth(stripAnsi(input.prompt));
  const available = Math.max(1, input.width - promptCells - 1);
  const lines = input.value.split('\n');
  const beforeCursor = input.value.slice(0, safeCursor);
  const cursorLine = countNewlines(beforeCursor);
  const cursorLineStart = beforeCursor.lastIndexOf('\n') + 1;
  const cursorInLine = safeCursor - cursorLineStart;
  const visibleRows = Math.max(1, Math.min(input.maxRows, lines.length));
  const maxStart = Math.max(0, lines.length - visibleRows);
  const viewportStart = Math.max(0, Math.min(maxStart, cursorLine - Math.floor(visibleRows / 2)));
  const viewportEnd = Math.min(lines.length, viewportStart + visibleRows);
  const continuation = ' '.repeat(promptCells);
  const rows: string[] = [];
  let cursorRow = 0;
  let cursorColumn = promptCells;

  for (let lineIndex = viewportStart; lineIndex < viewportEnd; lineIndex++) {
    const prefix = rows.length === 0 ? input.prompt : continuation;
    const line = displayInputLine(lines[lineIndex] ?? '');
    if (lineIndex === cursorLine) {
      const displayCursor = displayInputLine(
        (lines[lineIndex] ?? '').slice(0, cursorInLine)
      ).length;
      const window = fitInputWindow(line, displayCursor, available);
      rows.push(`${prefix}${window.visible}`);
      cursorRow = rows.length - 1;
      cursorColumn = Math.min(input.width - 1, promptCells + window.cursorColumn);
    } else {
      rows.push(`${prefix}${clipInputLine(line, available)}`);
    }
  }

  return { rows, cursorRow, cursorColumn };
}

function displayInputLine(value: string): string {
  return value.replace(/\t/g, '  ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '�');
}

function clipInputLine(value: string, available: number): string {
  if (stringWidth(value) <= available) return value;
  const marker = '›';
  return `${takeLeftCells(value, Math.max(0, available - stringWidth(marker)))}${marker}`;
}

function countNewlines(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) === 10) count++;
  }
  return count;
}

function fitInputWindow(
  value: string,
  cursor: number,
  available: number
): { visible: string; cursorColumn: number } {
  if (stringWidth(value) <= available) {
    return { visible: value, cursorColumn: stringWidth(value.slice(0, cursor)) };
  }

  const before = value.slice(0, cursor);
  const after = value.slice(cursor);
  const marker = '‹';
  const markerWidth = stringWidth(marker);
  const afterHead = takeLeftCells(
    after,
    Math.min(stringWidth(after), Math.max(0, Math.floor(available / 3)))
  );
  const beforeTail = takeRightCells(
    before,
    Math.max(0, available - markerWidth - stringWidth(afterHead))
  );
  const visible = `${marker}${beforeTail}${afterHead}`;
  return {
    visible,
    cursorColumn: markerWidth + stringWidth(beforeTail),
  };
}

function takeLeftCells(value: string, maxWidth: number): string {
  let output = '';
  for (const char of value) {
    if (stringWidth(`${output}${char}`) > maxWidth) break;
    output += char;
  }
  return output;
}

function takeRightCells(value: string, maxWidth: number): string {
  let output = '';
  const tailStart = Math.max(0, value.length - maxWidth * 4 - 16);
  for (const char of Array.from(value.slice(tailStart)).reverse()) {
    if (stringWidth(`${char}${output}`) > maxWidth) break;
    output = `${char}${output}`;
  }
  return output;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

function previousBoundary(value: string, cursor: number): number {
  const safeCursor = clampCursor(value, cursor);
  let previous = 0;
  for (const boundary of graphemeBoundaries(value)) {
    if (boundary >= safeCursor) break;
    previous = boundary;
  }
  return previous;
}

function nextBoundary(value: string, cursor: number): number {
  const safeCursor = clampCursor(value, cursor);
  for (const boundary of graphemeBoundaries(value)) {
    if (boundary > safeCursor) return boundary;
  }
  return value.length;
}

function graphemeBoundaries(value: string): number[] {
  const Segmenter = (Intl as any).Segmenter;
  if (!Segmenter) {
    const boundaries = [0];
    let index = 0;
    for (const char of Array.from(value)) {
      index += char.length;
      boundaries.push(index);
    }
    return boundaries;
  }

  const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
  const boundaries = [0];
  for (const part of segmenter.segment(value) as Iterable<{ index: number; segment: string }>) {
    boundaries.push(part.index + part.segment.length);
  }
  return Array.from(new Set(boundaries)).sort((left, right) => left - right);
}

function clampCursor(value: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return value.length;
  return Math.min(Math.max(0, Math.floor(cursor)), value.length);
}

function currentLineStart(value: string, cursor: number): number {
  const safeCursor = clampCursor(value, cursor);
  if (safeCursor === 0) return 0;
  return value.lastIndexOf('\n', safeCursor - 1) + 1;
}

function currentLineEnd(value: string, cursor: number): number {
  const safeCursor = clampCursor(value, cursor);
  const end = value.indexOf('\n', safeCursor);
  return end < 0 ? value.length : end;
}

function safeSlice(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let end = Math.max(0, maxLength);
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return value.slice(0, end);
}
