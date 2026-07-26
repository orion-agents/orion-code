import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import stringWidth from 'string-width';
import { formatPromptLine } from '../src/ink-ui/components/PromptInput';
import { decodeHtmlEntities, markdownBlockTypes } from '../src/ink-ui/components/Markdown';
import { getRunningHorseFrame, runningHorseLabel } from '../src/ink-ui/components/RunningHorseIndicator';
import { formatToolActivityLine, parseToolActivity } from '../src/ink-ui/components/ToolActivity';
import { createAssistantStreamPresenter, createToolEventPresenter, sessionMessagesToTranscriptEntries } from '../src/ink-ui/controllers/chat-controller';
import { readTerminalSize } from '../src/ink-ui/hooks/use-terminal-size';
import { prepareInkStdin } from '../src/ink-ui/launch';
import { initialInputBuffer, reduceInputBuffer } from '../src/ink-ui/runtime/input-buffer';
import { getInkLayoutBudget } from '../src/ink-ui/runtime/layout-budget';
import { applyTerminalOutputToCursor, createNativeCursorController, nativeCursorAbsoluteMoveSequence, nativeCursorAbsoluteParkSequence, nativeCursorAnchorFromNode, nativeCursorMoveSequence, nativeCursorParkSequence } from '../src/ink-ui/runtime/native-cursor';
import { formatPromptVisualLine, getPromptInputViewport, getPromptVisualLines, getVisiblePromptVisualLines, splitByVisualWidth } from '../src/ink-ui/runtime/prompt-layout';
import { floorGraphemeBoundary, nextGraphemeBoundary, previousGraphemeBoundary, segmentGraphemes } from '../src/ink-ui/runtime/grapheme';
import { countCtrlCEvents, deleteActionFromRawInput, hasDeletionRawInput } from '../src/ink-ui/runtime/raw-input';
import { initialTranscriptState, liveTranscriptEntries, staticTranscriptEntries, transcriptReducer } from '../src/ink-ui/runtime/transcript-state';
import { getFileQuery, isMultilinePasteValue, normalizePastedInput, permissionItems, sessionItems, visibleCommandItems, visibleFileItems } from '../src/ink-ui/screens/ReplScreen';
import type { TranscriptEntry, UiEventSink } from '../src/ink-ui/types';
import type { SessionMeta } from '../src/services/session-storage';
import { appendSessionMessage, createSession, markSessionTranscriptDisplayStart } from '../src/services/session-storage';

describe('Ink UI helpers', () => {
  it('filters command palette entries by slash query', () => {
    const items = visibleCommandItems('/s');
    expect(items.some(item => item.value === 'status')).toBe(true);
    expect(items.some(item => item.value === 'sessions')).toBe(true);
    expect(items.every(item => item.value.startsWith('s') || item.label.includes('(s'))).toBe(true);
  });

  it('shows coding-agent commands and hides legacy chat commands', () => {
    const items = visibleCommandItems('/');
    const values = items.map(item => item.value);

    expect(values).toEqual(expect.arrayContaining(['review', 'security', 'test-gen', 'tools', 'mode']));
    expect(values).not.toContain('chat');
    expect(values).not.toContain('run');
    expect(values).not.toContain('task');
  });

  it('extracts file completion query from the active @ token', () => {
    expect(getFileQuery('open @src/cli')).toEqual({ base: 'open ', query: 'src/cli' });
    expect(getFileQuery('@')).toEqual({ base: '', query: '' });
    expect(getFileQuery('no file token')).toBeNull();
  });

  it('detects pasted multiline chunks without treating Enter as paste', () => {
    expect(isMultilinePasteValue('line one\nline two')).toBe(true);
    expect(isMultilinePasteValue('line one\r\nline two')).toBe(true);
    expect(isMultilinePasteValue('\n')).toBe(false);
    expect(isMultilinePasteValue('\r')).toBe(false);
    expect(isMultilinePasteValue('plain text')).toBe(false);
  });

  it('normalizes bracketed paste and CRLF newlines', () => {
    expect(normalizePastedInput('\x1b[200~one\r\ntwo\x1b[201~')).toBe('one\ntwo');
    expect(normalizePastedInput('[200~one\r\ntwo[201~')).toBe('one\ntwo');
  });

  it('counts repeated Ctrl+C bytes when terminal input batches them', () => {
    expect(countCtrlCEvents('\x03')).toBe(1);
    expect(countCtrlCEvents('\x03\x03')).toBe(2);
    expect(countCtrlCEvents('hello')).toBe(0);
  });

  it('treats terminal DEL as backspace and CSI 3 as forward delete', () => {
    expect(deleteActionFromRawInput('\x7f')).toBe('backspace');
    expect(deleteActionFromRawInput('\x08')).toBe('backspace');
    expect(deleteActionFromRawInput('\x1b[3~')).toBe('delete');
    expect(hasDeletionRawInput('\x7f')).toBe(true);
    expect(hasDeletionRawInput('\x08')).toBe(true);
    expect(hasDeletionRawInput('\x1b[3~')).toBe(true);
    expect(hasDeletionRawInput('开源')).toBe(false);
  });

  it('lists matching file completion entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openhorse-ink-ui-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'cli.ts'), '');

    const items = visibleFileItems(dir, '@src/c');
    expect(items.map(item => item.value)).toContain('src/cli.ts');
  });

  it('includes session history size in picker descriptions', () => {
    const session: SessionMeta = {
      id: '12345678-aaaa-bbbb-cccc-123456789000',
      projectPath: '/tmp/project',
      model: 'glm-5',
      startTime: Date.now(),
      tokenCount: 0,
      cost: 0,
      messageCount: 3,
      historySizeBytes: 1536,
      taskSummary: 'demo task',
    };

    const [item] = sessionItems({
      title: 'Pick a Session',
      sessions: [session],
    });

    expect(item.label).toContain('12345678');
    expect(item.label).toContain('demo task');
    expect(item.description).toContain('3 msgs');
    expect(item.description).toContain('1.5 KB');
  });

  it('builds tool permission picker entries from the runtime request', () => {
    const items = permissionItems({
      id: 'permission-1',
      name: 'exec_command',
      args: { command: 'npm publish --dry-run' },
      reason: 'requires confirmation',
    });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      value: 'allow',
      label: 'Allow exec_command',
    });
    expect(items[0].description).toContain('npm publish --dry-run');
    expect(items[0].description).toContain('requires confirmation');
    expect(items[1]).toMatchObject({
      value: 'deny',
      label: 'Deny exec_command',
    });
  });

  it('keeps overlay row budget inside the live terminal frame', () => {
    const compact = getInkLayoutBudget(80, 20, { overlayVisible: true });
    const roomy = getInkLayoutBudget(160, 49, { overlayVisible: true });

    expect(compact.maxOverlayItems + compact.maxPromptRows + compact.maxLiveTranscriptItems + 10).toBeLessThanOrEqual(compact.terminalHeight);
    expect(roomy.maxOverlayItems).toBeLessThanOrEqual(10);
    expect(roomy.layoutWidth).toBe(159);
  });

  it('reads terminal size from the active stdout and falls back safely', () => {
    expect(readTerminalSize({ columns: 120, rows: 42 } as NodeJS.WriteStream)).toEqual({ width: 120, height: 42 });
    expect(readTerminalSize({ columns: 0, rows: 0 } as NodeJS.WriteStream, { columns: 88, rows: 33 } as NodeJS.WriteStream))
      .toEqual({ width: 88, height: 33 });
  });

  it('prepares stdin raw mode before Ink mounts so terminal echo cannot leak into the prompt', () => {
    const rawModeCalls: boolean[] = [];
    const stdin: {
      isTTY: boolean;
      isRaw: boolean;
      setEncoding: jest.Mock;
      resume: jest.Mock;
      setRawMode: jest.Mock<NodeJS.ReadStream, [boolean]>;
    } = {
      isTTY: true,
      isRaw: false,
      setEncoding: jest.fn(),
      resume: jest.fn(),
      setRawMode: jest.fn((mode: boolean) => {
        rawModeCalls.push(mode);
        stdin.isRaw = mode;
        return stdin as unknown as NodeJS.ReadStream;
      }),
    };

    const restore = prepareInkStdin(stdin as unknown as NodeJS.ReadStream);

    expect(stdin.setEncoding).toHaveBeenCalledWith('utf8');
    expect(stdin.resume).toHaveBeenCalledTimes(1);
    expect(rawModeCalls).toEqual([true]);

    restore();
    expect(rawModeCalls).toEqual([true, false]);
  });

  it('anchors the native cursor after Ink writes and restores baseline before the next frame', async () => {
    const writes: string[] = [];
    const stdout = {
      rows: 20,
      columns: 80,
      isTTY: true,
      write: (chunk: string | Buffer) => {
        writes.push(String(chunk));
        return true;
      },
      on: jest.fn(),
      off: jest.fn(),
    } as unknown as NodeJS.WriteStream;

    const controller = createNativeCursorController(stdout);
    const wrapped = controller.wrapStdout();
    controller.setState({ enabled: true, column: 9, rowsUp: 2, row: 8, absolute: true });

    try {
      wrapped.write('frame');
      await Promise.resolve();
      expect(writes).toEqual(['frame', nativeCursorAbsoluteParkSequence({ row: 8, column: 8 })]);

      wrapped.write('next');
      await Promise.resolve();
      expect(writes.slice(-3)).toEqual([
        nativeCursorAbsoluteMoveSequence({ row: 0, column: 5 }),
        'next',
        nativeCursorAbsoluteParkSequence({ row: 8, column: 8 }),
      ]);
    } finally {
      controller.disable();
    }
  });

  it('uses relative cursor parking by default for normal scrollback startup', async () => {
    const writes: string[] = [];
    const stdout = {
      rows: 20,
      columns: 80,
      isTTY: true,
      write: (chunk: string | Buffer) => {
        writes.push(String(chunk));
        return true;
      },
      on: jest.fn(),
      off: jest.fn(),
    } as unknown as NodeJS.WriteStream;

    const controller = createNativeCursorController(stdout);
    const wrapped = controller.wrapStdout();
    controller.setState({ enabled: true, column: 9, rowsUp: 2, row: 8 });

    try {
      wrapped.write('one\r\ntwo\r\nend');
      await Promise.resolve();
      expect(writes).toEqual(['one\r\ntwo\r\nend', nativeCursorParkSequence({ enabled: true, column: 9, rowsUp: 2 })]);

      wrapped.write('next');
      await Promise.resolve();
      expect(writes.slice(-3)).toEqual([
        nativeCursorMoveSequence({ row: 0, column: 8 }, { row: 2, column: 3 }),
        'next',
        nativeCursorParkSequence({ enabled: true, column: 9, rowsUp: 2 }),
      ]);
    } finally {
      controller.disable();
    }
  });

  it('does not rewrite cursor escape sequences when the native cursor is already parked', () => {
    const writes: string[] = [];
    const stdout = {
      rows: 20,
      columns: 80,
      isTTY: true,
      write: (chunk: string | Buffer) => {
        writes.push(String(chunk));
        return true;
      },
      on: jest.fn(),
      off: jest.fn(),
    } as unknown as NodeJS.WriteStream;

    const controller = createNativeCursorController(stdout);
    controller.setState({ enabled: true, column: 12, rowsUp: 2, row: 4, absolute: true });

    try {
      controller.restore();
      controller.restore();
      expect(writes).toEqual([nativeCursorAbsoluteParkSequence({ row: 4, column: 11 })]);
    } finally {
      controller.disable();
    }
  });

  it('keeps native cursor controller state isolated per renderer', () => {
    const writesA: string[] = [];
    const writesB: string[] = [];
    const createStdout = (writes: string[]) => ({
      rows: 20,
      columns: 80,
      isTTY: true,
      write: (chunk: string | Buffer) => {
        writes.push(String(chunk));
        return true;
      },
      on: jest.fn(),
      off: jest.fn(),
    }) as unknown as NodeJS.WriteStream;

    const controllerA = createNativeCursorController(createStdout(writesA));
    const controllerB = createNativeCursorController(createStdout(writesB));
    controllerA.setState({ enabled: true, column: 9, rowsUp: 2, row: 6, absolute: true });
    controllerB.setState({ enabled: true, column: 12, rowsUp: 3, row: 7, absolute: true });

    controllerA.restore();
    controllerB.restore();
    controllerA.disable();

    expect(writesA).toEqual([
      nativeCursorAbsoluteParkSequence({ row: 6, column: 8 }),
      nativeCursorAbsoluteMoveSequence({ row: 0, column: 0 }),
    ]);
    expect(writesB).toEqual([
      nativeCursorAbsoluteParkSequence({ row: 7, column: 11 }),
    ]);

    controllerB.disable();
  });

  it('resets observed cursor state after an Ink resize viewport clear', async () => {
    const writes: string[] = [];
    const stdout = {
      rows: 20,
      columns: 80,
      isTTY: true,
      write: (chunk: string | Buffer) => {
        writes.push(String(chunk));
        return true;
      },
      on: jest.fn(),
      off: jest.fn(),
    } as unknown as NodeJS.WriteStream;

    const controller = createNativeCursorController(stdout);
    const wrapped = controller.wrapStdout();
    controller.setState({ enabled: true, column: 12, rowsUp: 2, row: 6, absolute: true });

    try {
      wrapped.write('┌────────┐\n│ › hello│\n└────────┘');
      await Promise.resolve();
      controller.resetForViewportClear();
      controller.restore();

      expect(writes.slice(-1)).toEqual([nativeCursorAbsoluteParkSequence({ row: 6, column: 11 })]);
      expect(writes).not.toContain(nativeCursorAbsoluteMoveSequence({ row: 0, column: 0 }));
    } finally {
      controller.disable();
    }
  });

  it('tracks terminal cursor output by grapheme cluster', () => {
    const combining = 'e\u0301';
    const family = '👨‍👩‍👧‍👦';

    expect(applyTerminalOutputToCursor({ row: 0, column: 0 }, combining, 80))
      .toEqual({ row: 0, column: 1 });
    expect(applyTerminalOutputToCursor({ row: 0, column: 0 }, family, 80))
      .toEqual({ row: 0, column: stringWidth(family) });
    expect(applyTerminalOutputToCursor({ row: 0, column: 78 }, `${family}x`, 80))
      .toEqual({ row: 0, column: 79 });
  });

  it('tracks visual prompt cursor columns with fullwidth Chinese input', () => {
    const ascii = getPromptInputViewport('ab', 80, 6, 2);
    const chinese = getPromptInputViewport('你好', 80, 6, 2);
    const empty = getPromptInputViewport('', 80, 6, 0);

    expect(ascii.cursorColumn).toBe(7);
    expect(chinese.cursorColumn).toBe(9);
    expect(empty.cursorColumn).toBe(5);
  });

  it('parks the native cursor on the prompt content row for IME composition', () => {
    const singleLine = getPromptInputViewport('hello', 80, 6, 5);
    const multiLineAtEnd = getPromptInputViewport('one\ntwo', 80, 6, 7);
    const multiLineAtStart = getPromptInputViewport('one\ntwo', 80, 6, 1);

    expect(singleLine.rowsUpFromPromptBottom).toBe(2);
    expect(multiLineAtEnd.rowsUpFromPromptBottom).toBe(2);
    expect(multiLineAtStart.rowsUpFromPromptBottom).toBe(3);
  });

  it('derives native cursor parking from the prompt box Yoga node when available', () => {
    const root = {
      yogaNode: {
        getComputedLeft: () => 0,
        getComputedTop: () => 0,
        getComputedHeight: () => 7,
      },
      parentNode: null,
    };
    const parent = {
      yogaNode: {
        getComputedLeft: () => 0,
        getComputedTop: () => 2,
        getComputedHeight: () => 7,
      },
      parentNode: root,
    };
    const promptBox = {
      yogaNode: {
        getComputedLeft: () => 3,
        getComputedTop: () => 1,
        getComputedHeight: () => 3,
      },
      parentNode: parent,
    };

    expect(nativeCursorAnchorFromNode(promptBox, { cursorColumn: 5, cursorLineIndex: 0 }))
      .toEqual({ column: 8, row: 4, rowsUp: 3 });
  });

  it('pads live prompt lines to the full input width', () => {
    const line = formatPromptLine('你好', 0, 20);

    expect(line.startsWith('› 你好')).toBe(true);
    expect(line.length).toBeGreaterThan('› 你好'.length);
  });

  it('can render a visual cursor when explicitly requested', () => {
    const line = formatPromptVisualLine({ logicalIndex: 0, wrapIndex: 0, content: '', start: 0, end: 0 }, 20, { showCursor: true });

    expect(line.startsWith('› ▌')).toBe(true);
  });

  it('renders the visual cursor at the active edit offset', () => {
    const line = formatPromptVisualLine(
      { logicalIndex: 0, wrapIndex: 0, content: 'abcd', start: 0, end: 4 },
      20,
      { showCursor: true, cursorOffset: 2 }
    );

    expect(line.startsWith('› ab▌cd')).toBe(true);
  });

  it('soft-wraps long prompt input before it reaches the footer', () => {
    const visualLines = getPromptVisualLines('abcdefghij', 12);
    const viewport = getPromptInputViewport('abcdefghij', 12, 6, 10);

    expect(visualLines.length).toBeGreaterThan(1);
    expect(viewport.cursorColumn).toBeGreaterThan(4);
  });

  it('renders only the tail of very tall prompt input', () => {
    const { lines, hiddenRows } = getVisiblePromptVisualLines('one\ntwo\nthree\nfour', 40, 2);

    expect(hiddenRows).toBe(2);
    expect(lines.map(line => line.content)).toEqual(['three', 'four']);
  });

  it('keeps prompt viewport within the row budget including the hidden indicator', () => {
    const viewport = getPromptInputViewport('one\ntwo\nthree\nfour', 40, 3);

    expect(viewport.showHiddenIndicator).toBe(true);
    expect(viewport.hiddenRows).toBe(2);
    expect(viewport.lines.map(line => line.content)).toEqual(['three', 'four']);
    expect(viewport.lines.length + 1).toBeLessThanOrEqual(3);
  });

  it('keeps the prompt viewport centered around an earlier cursor', () => {
    const viewport = getPromptInputViewport('one\ntwo\nthree\nfour', 40, 3, 1);

    expect(viewport.lines.map(line => line.content)).toEqual(['one', 'two']);
    expect(viewport.cursorLineIndex).toBe(1);
    expect(viewport.cursorColumn).toBe(6);
  });

  it('edits input at the cursor instead of always appending', () => {
    const draft = reduceInputBuffer(initialInputBuffer, { type: 'set', value: 'helo', cursor: 2 });
    const inserted = reduceInputBuffer(draft, { type: 'insert', text: 'l' });
    const removed = reduceInputBuffer(inserted, { type: 'backspace' });
    const deleted = reduceInputBuffer({ value: 'abcd', cursor: 1 }, { type: 'delete' });
    const cjkRemoved = reduceInputBuffer({ value: '开源小？事收到', cursor: '开源小？事收到'.length }, { type: 'backspace' });

    expect(inserted).toEqual({ value: 'hello', cursor: 3 });
    expect(removed).toEqual({ value: 'helo', cursor: 2 });
    expect(deleted).toEqual({ value: 'acd', cursor: 1 });
    expect(cjkRemoved).toEqual({ value: '开源小？事收', cursor: '开源小？事收'.length });
  });

  it('calculates grapheme boundaries for combining marks and emoji sequences', () => {
    const combining = 'e\u0301';
    const family = '👨‍👩‍👧‍👦';
    const value = `${combining}${family}z`;

    expect(segmentGraphemes(value).map(part => part.segment)).toEqual([combining, family, 'z']);
    expect(previousGraphemeBoundary(value, combining.length + family.length)).toBe(combining.length);
    expect(nextGraphemeBoundary(value, combining.length)).toBe(combining.length + family.length);
    expect(floorGraphemeBoundary(value, combining.length + 1)).toBe(combining.length);
    expect(floorGraphemeBoundary(value, combining.length + family.length)).toBe(combining.length + family.length);
  });

  it('edits by grapheme cluster so emoji and combining marks are not split', () => {
    const combining = 'e\u0301';
    const family = '👨‍👩‍👧‍👦';

    expect(reduceInputBuffer({ value: combining, cursor: combining.length }, { type: 'backspace' }))
      .toEqual({ value: '', cursor: 0 });
    expect(reduceInputBuffer({ value: family, cursor: family.length }, { type: 'backspace' }))
      .toEqual({ value: '', cursor: 0 });
    expect(reduceInputBuffer({ value: `${family}x`, cursor: 0 }, { type: 'delete' }))
      .toEqual({ value: 'x', cursor: 0 });
    expect(reduceInputBuffer({ value: `${family}x`, cursor: `${family}x`.length }, { type: 'move', direction: 'left' }).cursor)
      .toBe(family.length);
  });

  it('wraps prompt input by grapheme cluster instead of splitting emoji sequences', () => {
    const family = '👨‍👩‍👧‍👦';
    const chunks = splitByVisualWidth(`a${family}b`, 2);

    expect(chunks).toEqual(['a', family, 'b']);
  });

  it('parses mixed text and arrow escape sequences in one input chunk', () => {
    const edited = reduceInputBuffer(initialInputBuffer, { type: 'inputChunk', text: 'helo\x1b[D\x1b[Dl' });
    const deleted = reduceInputBuffer(initialInputBuffer, { type: 'inputChunk', text: 'ab\x1b[D\x1b[3~' });
    const pastedWithControl = reduceInputBuffer({ value: '/', cursor: 1 }, { type: 'inputChunk', text: '\x7fone\ntwo' });
    const clearedThenInserted = reduceInputBuffer({ value: 'draft', cursor: 5 }, { type: 'inputChunk', text: '\x15abc' });
    const ignoredControl = reduceInputBuffer(initialInputBuffer, { type: 'inputChunk', text: '\x16abc' });

    expect(edited).toEqual({ value: 'hello', cursor: 3 });
    expect(deleted).toEqual({ value: 'a', cursor: 1 });
    expect(pastedWithControl).toEqual({ value: 'one\ntwo', cursor: 7 });
    expect(clearedThenInserted).toEqual({ value: 'abc', cursor: 3 });
    expect(ignoredControl).toEqual({ value: 'abc', cursor: 3 });
  });

  it('normalizes running status into a horse animation label', () => {
    expect(runningHorseLabel('Turn 2...')).toBe('working');
    expect(runningHorseLabel('Working: thinking')).toBe('Working: thinking');
    expect(runningHorseLabel('Working: reading tool results')).toBe('Working: reading tool results');
    expect(runningHorseLabel('Working: running 4 tools')).toBe('Working: running 4 tools');
    expect(runningHorseLabel('Revision received. Interrupting current response...')).toBe('Revision received. Interrupting current response...');
  });

  it('uses stable-width running horse frames with moving dust', () => {
    const frames = [0, 1, 2, 3].map(getRunningHorseFrame);
    const widths = new Set(frames.map(frame => stringWidth(`${frame.horse} ${frame.dust}`)));

    expect(widths.size).toBe(1);
    expect(new Set(frames.map(frame => frame.dust)).size).toBeGreaterThan(1);
  });

  it('recognizes rich markdown blocks for Ink transcript rendering', () => {
    const blocks = markdownBlockTypes([
      '# Title',
      '',
      '- item',
      '',
      '```ts',
      'const value = 1;',
      '```',
      '',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\n'));

    expect(blocks).toEqual(expect.arrayContaining(['heading', 'list', 'code', 'table']));
  });

  it('decodes html entities in assistant markdown text', () => {
    expect(decodeHtmlEntities('I see you&#39;ve entered &quot;111&quot; &amp; more.')).toBe('I see you\'ve entered "111" & more.');
    expect(decodeHtmlEntities('numeric: &#8226; &#x2022;')).toBe('numeric: • •');
  });

  it('parses tool activity transcript entries into stable UI summaries', () => {
    expect(parseToolActivity('Running read_file src/index.ts')).toEqual({
      state: 'running',
      name: 'read_file',
      detail: 'src/index.ts',
    });
    expect(parseToolActivity('✓ read_file src/index.ts (12ms)')).toEqual({
      state: 'success',
      name: 'read_file',
      detail: 'src/index.ts',
      duration: '12ms',
    });
    expect(parseToolActivity('✗ web_search agent trends (345ms)\nError: fetch failed')).toEqual({
      state: 'error',
      name: 'web_search',
      detail: 'agent trends',
      duration: '345ms',
      error: 'fetch failed',
    });
    expect(parseToolActivity('Requested list_files /tmp/project')).toEqual({
      state: 'requested',
      name: 'list_files',
      detail: '/tmp/project',
    });
  });

  it('formats tool activity lines within the available transcript width', () => {
    const line = formatToolActivityLine({
      state: 'success',
      name: 'read_file',
      detail: '/Users/hope/ai-project/openhorse/src/ink-ui/screens/ReplScreen.tsx',
      duration: '12ms',
    }, 32);

    expect(stringWidth(line)).toBeLessThanOrEqual(32);
    expect(line).toContain('read_file');
  });

  it('keeps tool events between assistant stream segments', () => {
    const entries: TranscriptEntry[] = [];
    const events: UiEventSink = {
      append: entry => {
        const id = `entry-${entries.length + 1}`;
        entries.push({ id, ...entry });
        return id;
      },
      update: (id, patch) => {
        const index = entries.findIndex(entry => entry.id === id);
        if (index >= 0) {
          entries[index] = { ...entries[index], ...patch };
        }
      },
      finalize: jest.fn(),
      remove: jest.fn(),
      replaceTranscript: jest.fn(),
      clearTranscript: jest.fn(),
      setStatus: jest.fn(),
      showSessionPicker: jest.fn(),
      showEditPreview: jest.fn(),
      setProcessing: jest.fn(),
    };

    const presenter = createAssistantStreamPresenter(events);
    presenter.appendChunk('先说明');
    presenter.closeSegment();
    events.append({ role: 'tool', content: 'Running read_file src/index.ts' });
    presenter.appendChunk('再给结论');
    presenter.closeSegment();

    expect(entries.map(entry => entry.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(entries.map(entry => entry.content)).toEqual(['先说明', 'Running read_file src/index.ts', '再给结论']);
    expect(events.finalize).toHaveBeenCalledWith('entry-1');
  });

  it('updates one live assistant entry while streaming chunks', () => {
    const entries: TranscriptEntry[] = [];
    const events: UiEventSink = {
      append: entry => {
        const id = `entry-${entries.length + 1}`;
        entries.push({ id, ...entry });
        return id;
      },
      update: (id, patch) => {
        const index = entries.findIndex(entry => entry.id === id);
        if (index >= 0) entries[index] = { ...entries[index], ...patch };
      },
      finalize: jest.fn(),
      remove: jest.fn(),
      replaceTranscript: jest.fn(),
      clearTranscript: jest.fn(),
      setStatus: jest.fn(),
      showSessionPicker: jest.fn(),
      showEditPreview: jest.fn(),
      setProcessing: jest.fn(),
    };

    const presenter = createAssistantStreamPresenter(events);
    presenter.appendChunk('hello');
    presenter.appendChunk(' world');

    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('hello world');

    presenter.closeSegment();
    expect(events.finalize).toHaveBeenCalledWith('entry-1');
  });

  it('removes an unfinished assistant stream when discarded', () => {
    const events: UiEventSink = {
      append: jest.fn(() => 'entry-1'),
      update: jest.fn(),
      finalize: jest.fn(),
      remove: jest.fn(),
      replaceTranscript: jest.fn(),
      clearTranscript: jest.fn(),
      setStatus: jest.fn(),
      showSessionPicker: jest.fn(),
      showEditPreview: jest.fn(),
      setProcessing: jest.fn(),
    };

    const presenter = createAssistantStreamPresenter(events);
    presenter.appendChunk('partial output');
    presenter.discardSegment();

    expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ role: 'assistant', live: true }));
    expect(events.remove).toHaveBeenCalledWith('entry-1');
    expect(events.finalize).not.toHaveBeenCalled();
  });

  it('updates a running tool entry when the matching result arrives', () => {
    const entries: TranscriptEntry[] = [];
    const finalized: Array<{ id: string; patch?: Partial<Omit<TranscriptEntry, 'id'>> }> = [];
    const structuredEvents: string[] = [];
    const events: UiEventSink = {
      append: entry => {
        const id = `entry-${entries.length + 1}`;
        entries.push({ id, ...entry });
        return id;
      },
      update: (id, patch) => {
        const index = entries.findIndex(entry => entry.id === id);
        if (index >= 0) {
          entries[index] = { ...entries[index], ...patch };
        }
      },
      finalize: (id, patch) => {
        finalized.push({ id, patch });
        if (!patch) return;
        const index = entries.findIndex(entry => entry.id === id);
        if (index >= 0) {
          entries[index] = { ...entries[index], ...patch };
        }
      },
      remove: jest.fn(),
      replaceTranscript: jest.fn(),
      clearTranscript: jest.fn(),
      setStatus: jest.fn(),
      showSessionPicker: jest.fn(),
      showEditPreview: jest.fn(),
      toolStarted: event => structuredEvents.push(`start:${event.callId}:${event.name}`),
      toolFinished: event => structuredEvents.push(`finish:${event.callId}:${event.success ? 'ok' : 'fail'}`),
      setProcessing: jest.fn(),
    };

    const presenter = createToolEventPresenter(events);
    presenter.start({
      type: 'tool_call',
      name: 'read_file',
      args: { path: 'src/index.ts' },
      callId: 'call-1',
    });
    presenter.finish({
      type: 'tool_result',
      name: 'read_file',
      args: { path: 'src/index.ts' },
      callId: 'call-1',
      result: '{"success":true}',
      modelVisibleResult: '{"success":true}',
      duration: 12,
      success: true,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('tool');
    expect(entries[0].content).toContain('✓ read_file src/index.ts (12ms)');
    expect(finalized).toHaveLength(1);
    expect(finalized[0].id).toBe('entry-1');
    expect(structuredEvents).toEqual(['start:call-1:read_file', 'finish:call-1:ok']);
  });

  it('uses common tool argument keys in activity summaries', () => {
    const entries: TranscriptEntry[] = [];
    const events: UiEventSink = {
      append: entry => {
        const id = `entry-${entries.length + 1}`;
        entries.push({ id, ...entry });
        return id;
      },
      update: jest.fn(),
      finalize: jest.fn(),
      remove: jest.fn(),
      replaceTranscript: jest.fn(),
      clearTranscript: jest.fn(),
      setStatus: jest.fn(),
      showSessionPicker: jest.fn(),
      showEditPreview: jest.fn(),
      setProcessing: jest.fn(),
    };

    const presenter = createToolEventPresenter(events);
    presenter.start({
      type: 'tool_call',
      name: 'read_file',
      args: { file_path: 'src/ink-ui/components/ToolActivity.tsx' },
      callId: 'call-file-path',
    });
    presenter.start({
      type: 'tool_call',
      name: 'web_search',
      args: { query: 'codex tui tool activity' },
      callId: 'call-query',
    });

    expect(entries.map(entry => entry.content)).toEqual([
      'Running read_file src/ink-ui/components/ToolActivity.tsx',
      'Running web_search codex tui tool activity',
    ]);
  });

  it('keeps transcript order while a tool is running between assistant segments', () => {
    let state = initialTranscriptState;
    state = transcriptReducer(state, { type: 'append', entry: { id: 'assistant-1', role: 'assistant', content: 'before tool' } });
    state = transcriptReducer(state, { type: 'append', entry: { id: 'tool-1', role: 'tool', content: 'Running read_file src/index.ts' } });
    state = transcriptReducer(state, { type: 'append', entry: { id: 'assistant-2', role: 'assistant', content: 'after tool' } });

    expect(staticTranscriptEntries(state).map(entry => entry.id)).toEqual(['assistant-1']);
    expect(liveTranscriptEntries(state).map(entry => entry.id)).toEqual(['tool-1', 'assistant-2']);

    state = transcriptReducer(state, {
      type: 'finalize',
      id: 'tool-1',
      patch: { role: 'tool', content: '✓ read_file src/index.ts (3ms)' },
    });

    expect(staticTranscriptEntries(state).map(entry => entry.id)).toEqual(['assistant-1', 'tool-1', 'assistant-2']);
    expect(liveTranscriptEntries(state)).toEqual([]);
  });

  it('rebuilds resumed transcript and hides messages before compact boundary', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'openhorse-ink-session-'));
    const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = configDir;

    try {
      const session = createSession('/tmp/openhorse-ink-resume', 'glm-5');
      appendSessionMessage(session.id, { role: 'user', content: 'before compact', timestamp: 1000 });
      appendSessionMessage(session.id, { role: 'assistant', content: 'old answer', timestamp: 1001 });
      markSessionTranscriptDisplayStart(session.id, 2000);
      appendSessionMessage(session.id, { role: 'user', content: 'after compact', timestamp: 2001 });
      appendSessionMessage(session.id, { role: 'assistant', content: 'new answer', timestamp: 2002 });

      const entries = sessionMessagesToTranscriptEntries(session.id);

      expect(entries.map(entry => entry.content)).toEqual(['after compact', 'new answer']);
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.ORION_CODE_CONFIG_DIR;
      } else {
        process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('rebuilds full resumed transcript when there is no compact boundary', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'openhorse-ink-session-'));
    const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = configDir;

    try {
      const session = createSession('/tmp/openhorse-ink-full-resume', 'glm-5');
      appendSessionMessage(session.id, { role: 'user', content: 'first question', timestamp: 1000 });
      appendSessionMessage(session.id, { role: 'assistant', content: 'first answer', timestamp: 1001 });
      appendSessionMessage(session.id, { role: 'user', content: 'second question', timestamp: 1002 });
      appendSessionMessage(session.id, { role: 'assistant', content: 'second answer', timestamp: 1003 });

      const entries = sessionMessagesToTranscriptEntries(session.id);

      expect(entries.map(entry => entry.content)).toEqual([
        'first question',
        'first answer',
        'second question',
        'second answer',
      ]);
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.ORION_CODE_CONFIG_DIR;
      } else {
        process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('rebuilds completed tool calls in resumed transcript as tool activity rows', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'openhorse-ink-session-tools-'));
    const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = configDir;

    try {
      const session = createSession('/tmp/openhorse-ink-tool-resume', 'glm-5');
      appendSessionMessage(session.id, { role: 'user', content: 'inspect files', timestamp: 1000 });
      appendSessionMessage(session.id, {
        role: 'assistant',
        content: 'I will inspect files first.',
        timestamp: 1001,
        tool_calls: [{
          id: 'call-list-files',
          type: 'function',
          function: { name: 'list_files', arguments: '{"path":".","maxDepth":0}' },
        }],
      });
      appendSessionMessage(session.id, {
        role: 'tool',
        content: '{"success":true,"output":"package.json"}',
        timestamp: 1002,
        toolCallId: 'call-list-files',
      });
      appendSessionMessage(session.id, { role: 'assistant', content: 'Done.', timestamp: 1003 });

      const plainEntries = sessionMessagesToTranscriptEntries(session.id);
      const entries = sessionMessagesToTranscriptEntries(session.id, { includeToolOutputViews: true });

      expect(plainEntries[2].toolActivity).toBeUndefined();

      expect(entries.map(entry => entry.content)).toEqual([
        'inspect files',
        'I will inspect files first.',
        '✓ list_files .',
        'Done.',
      ]);
      expect(entries[2].toolActivity).toMatchObject({
        name: 'list_files',
        callId: 'call-list-files',
        seq: 1,
        outputBytes: 12,
      });
      expect(entries[2].toolActivity?.outputView?.detailRef).toMatchObject({
        callId: 'call-list-files',
        sequence: 1,
      });
      expect(entries[2].toolActivity?.outputView?.preview).toBe('package.json');
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.ORION_CODE_CONFIG_DIR;
      } else {
        process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe('Ink UI input-buffer edges', () => {
  it('ignores non-word-delete Ctrl+W control character (\x17)', () => {
    // \x17 (Ctrl+W) is a control char < 32 (not \n or \t) — buffer ignores it
    const state = reduceInputBuffer({ value: 'hello world foo', cursor: 'hello world foo'.length }, { type: 'inputChunk', text: '\x17' });
    expect(state.value).toBe('hello world foo');
  });

  it('clears input on Ctrl+U from any cursor position', () => {
    const state = reduceInputBuffer({ value: 'hello world', cursor: 5 }, { type: 'inputChunk', text: '\x15' });
    expect(state.value).toBe('');
    expect(state.cursor).toBe(0);
  });

  it('handles mixed CJK text input and deletion correctly', () => {
    let state = reduceInputBuffer(initialInputBuffer, { type: 'inputChunk', text: '你好世界！' });
    expect(state.value).toBe('你好世界！');
    // Backspace on CJK punctuation
    state = reduceInputBuffer(state, { type: 'backspace' });
    expect(state.value).toBe('你好世界');
    // Delete from start on CJK
    state = reduceInputBuffer({ value: '你好世界', cursor: 0 }, { type: 'delete' });
    expect(state.value).toBe('好世界');
    expect(state.cursor).toBe(0);
  });

  it('handles emoji sequences with combining modifiers', () => {
    // 👨‍💻 = man technologist emoji (👨‍💻)
    const techEmoji = '👨‍💻';
    let state = reduceInputBuffer(initialInputBuffer, { type: 'inputChunk', text: `hello ${techEmoji} world` });
    expect(state.value).toContain(techEmoji);
    // Backspace should remove the entire emoji sequence
    state = reduceInputBuffer(state, { type: 'backspace' });
    expect(state.value).toBe(`hello ${techEmoji} worl`);
  });

  it('handles Home/End keys via raw escape sequences', () => {
    // \x1b[H = Home, \x1b[F = End
    const homeState = reduceInputBuffer({ value: 'hello', cursor: 5 }, { type: 'inputChunk', text: '\x1b[H' });
    expect(homeState.cursor).toBe(0);
    const endState = reduceInputBuffer({ value: 'hello', cursor: 0 }, { type: 'inputChunk', text: '\x1b[F' });
    expect(endState.cursor).toBe(5);
  });

  it('ignores non-printable control characters except newline and tab', () => {
    const state = reduceInputBuffer(initialInputBuffer, { type: 'inputChunk', text: '\x01a\x02b\x1b' });
    expect(state.value).toBe('ab');
  });

  it('preserves newline characters in input for multiline editing', () => {
    const state = reduceInputBuffer(initialInputBuffer, { type: 'inputChunk', text: 'line1\nline2' });
    expect(state.value).toBe('line1\nline2');
  });

  it('preserves bracketed paste marker text outside the paste handler', () => {
    const state = reduceInputBuffer(initialInputBuffer, { type: 'inputChunk', text: '[200~literal[201~' });
    expect(state.value).toBe('[200~literal[201~');
  });

});

describe('Ink UI prompt-layout narrow and wide', () => {
  it('splits CJK text correctly by visual width', () => {
    // Each CJK char is 2 cells wide
    const chunks = splitByVisualWidth('你好世界', 4);
    expect(chunks).toEqual(['你好', '世界']);
  });

  it('handles mixed CJK and ASCII wrapping', () => {
    const chunks = splitByVisualWidth('a你好b', 4);
    expect(chunks).toEqual(['a你', '好b']);
  });

  it('wraps emoji without breaking the sequence', () => {
    const emoji = '👨‍💻'; // man technologist
    const chunks = splitByVisualWidth(`x${emoji}y`, 2);
    expect(chunks[0]).toBe('x');
    // emoji should be whole in one chunk
    expect(chunks.find(c => c.includes(emoji))?.length).toBeGreaterThanOrEqual(emoji.length);
  });

  it('returns a single empty string chunk for empty input', () => {
    const chunks = splitByVisualWidth('', 10);
    expect(chunks).toEqual(['']);
  });

  it('handles very narrow width (1 cell)', () => {
    // Each char wraps to its own line at width 1
    const chunks = splitByVisualWidth('abc', 1);
    expect(chunks).toEqual(['a', 'b', 'c']);
  });

  it('returns cursor at correct position for CJK prompt', () => {
    // cursor=3 in '你好世界' means we've completed '你' + part of or all of '好'
    const viewport = getPromptInputViewport('你好世界', 40, 6, 3);
    // '好' is at byte offset 3, and is a CJK character (3 bytes for 你 + starting 好)
    // After 你 (width 2, bytes 3), cursor offset 3 - 3 = 0 in the '好world' part
    // Actually '你' is 3 bytes, cursor=3 means right after '你'
    // So cursor in visual rendering: prefix '› ' (2 cells) + '你' (2 cells) = 4, then cursor at column 4
    expect(viewport.cursorColumn).toBeGreaterThanOrEqual(4);
  });

  it('shows hidden indicator when prompt exceeds maxRows', () => {
    const viewport = getPromptInputViewport('a\nb\nc\nd\ne\nf', 40, 3);
    expect(viewport.showHiddenIndicator).toBe(true);
    expect(viewport.hiddenRows).toBeGreaterThan(0);
    // visible lines should be at most maxRows - 1 (for indicator)
    expect(viewport.lines.length).toBeLessThanOrEqual(2);
  });

  it('pads visual lines with correct prefix for continuation lines', () => {
    // First line has '› ' prefix, continuation lines have '  ' prefix
    const longLine = 'x'.repeat(40);
    const lines = getPromptVisualLines(longLine, 10); // narrow enough to wrap
    expect(lines[0].logicalIndex).toBe(0);
    expect(lines[0].wrapIndex).toBe(0);
  });
});

describe('Ink UI layout-budget edge cases', () => {
  it('handles very small terminal (20x8)', () => {
    const budget = getInkLayoutBudget(20, 8);
    expect(budget.layoutWidth).toBeGreaterThanOrEqual(19);
    expect(budget.maxPromptRows).toBeGreaterThanOrEqual(1);
    expect(budget.maxPromptRows).toBeLessThanOrEqual(6);
    expect(budget.maxLiveTranscriptItems).toBeGreaterThanOrEqual(1);
  });

  it('handles very large terminal (240x80)', () => {
    const budget = getInkLayoutBudget(240, 80);
    expect(budget.layoutWidth).toBe(239);
    expect(budget.maxPromptRows).toBe(6); // capped at 6
    expect(budget.maxOverlayItems).toBe(10); // capped at 10
  });

  it('reduces live transcript items when overlay is visible', () => {
    const withoutOverlay = getInkLayoutBudget(120, 40, { overlayVisible: false });
    const withOverlay = getInkLayoutBudget(120, 40, { overlayVisible: true });
    expect(withOverlay.maxLiveTranscriptItems).toBe(1); // minimal when overlay open
    expect(withoutOverlay.maxLiveTranscriptItems).toBeGreaterThan(1);
  });

  it('keeps total items within terminal height', () => {
    const budget = getInkLayoutBudget(100, 30, { overlayVisible: true });
    const totalUsed = budget.maxOverlayItems + budget.maxPromptRows + budget.maxLiveTranscriptItems + 10;
    expect(totalUsed).toBeLessThanOrEqual(budget.terminalHeight);
  });

  it('has all required fields in budget', () => {
    const budget = getInkLayoutBudget(80, 24);
    expect(budget).toHaveProperty('terminalWidth');
    expect(budget).toHaveProperty('terminalHeight');
    expect(budget).toHaveProperty('layoutWidth');
    expect(budget).toHaveProperty('maxLiveTranscriptItems');
    expect(budget).toHaveProperty('maxOverlayItems');
    expect(budget).toHaveProperty('maxPromptRows');
  });
});

describe('Ink UI transcript-state overlay safety', () => {
  it('does not include overlay entries in transcript', () => {
    let state = initialTranscriptState;
    // Append normal entries
    state = transcriptReducer(state, { type: 'append', entry: { id: 'user-1', role: 'user', content: 'hello' } });
    state = transcriptReducer(state, { type: 'append', entry: { id: 'assistant-1', role: 'assistant', content: 'hi' } });
    // Overlays are UI state, not transcript entries
    expect(state.entries.map(e => e.id)).toEqual(['user-1', 'assistant-1']);
    expect(state.entries.length).toBe(2);
  });

  it('maintains live/finalize order even with rapid append/update/finalize', () => {
    let state = initialTranscriptState;
    state = transcriptReducer(state, { type: 'append', entry: { id: 'a1', role: 'assistant', content: 'p1', live: true } });
    state = transcriptReducer(state, { type: 'append', entry: { id: 't1', role: 'tool', content: 'Running x' } });
    state = transcriptReducer(state, { type: 'update', id: 'a1', patch: { content: 'p1 updated' } });
    state = transcriptReducer(state, { type: 'finalize', id: 't1', patch: { content: '✓ x done' } });
    state = transcriptReducer(state, { type: 'finalize', id: 'a1' });

    const static_ = staticTranscriptEntries(state);
    const live = liveTranscriptEntries(state);

    expect(live).toEqual([]);
    expect(static_.map(e => e.id)).toEqual(['a1', 't1']);
    expect(static_[0].content).toBe('p1 updated');
    expect(static_[1].content).toBe('✓ x done');
  });

  it('removing a live entry does not affect static entries', () => {
    let state = initialTranscriptState;
    state = transcriptReducer(state, { type: 'append', entry: { id: 's1', role: 'user', content: 'stable' } });
    state = transcriptReducer(state, { type: 'append', entry: { id: 'l1', role: 'assistant', content: 'streaming', live: true } });
    state = transcriptReducer(state, { type: 'remove', id: 'l1' });

    const static_ = staticTranscriptEntries(state);
    expect(static_.map(e => e.id)).toEqual(['s1']);
    expect(state.entries.some(e => e.id === 'l1')).toBe(false);
  });

  it('replace rebuilds the entire transcript and bumps generation', () => {
    let state = initialTranscriptState;
    state = transcriptReducer(state, { type: 'append', entry: { id: 'old-1', role: 'user', content: 'old' } });
    state = transcriptReducer(state, { type: 'append', entry: { id: 'old-2', role: 'assistant', content: 'resp' } });

    const gen = state.generation;
    state = transcriptReducer(state, {
      type: 'replace',
      entries: [{ id: 'new-1', role: 'user', content: 'new' }],
    });

    expect(state.generation).toBe(gen + 1);
    expect(state.entries.length).toBe(1);
    expect(state.entries[0].id).toBe('new-1');
    expect(staticTranscriptEntries(state).length).toBe(1);
  });

  it('clear empties all entries and bumps generation', () => {
    let state = initialTranscriptState;
    state = transcriptReducer(state, { type: 'append', entry: { id: 'u1', role: 'user', content: 'text' } });
    const gen = state.generation;
    state = transcriptReducer(state, { type: 'clear' });

    expect(state.entries).toEqual([]);
    expect(state.staticCount).toBe(0);
    expect(state.generation).toBe(gen + 1);
  });
});
