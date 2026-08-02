import { marked } from 'marked';

jest.mock('../src/services/file-glob', () => ({
  matchFiles: jest.fn(),
}));

import { matchFiles } from '../src/services/file-glob';
import {
  completeFile,
  getBaseInput,
  getFileQuery,
  getFullInput,
  hideFileCompletion,
  isFileCompletionVisible,
  navigateFiles,
  redrawInputWithFile,
  selectFile,
  setFileCompletionPromptRenderer,
  showFileCompletion,
  updateFileQuery,
} from '../src/ui/file-completion';
import { renderMarkdown, renderMarkdownFallback } from '../src/ui/markdown';
import {
  clearProgressAndRestorePrompt,
  hideProgress,
  isProgressActive,
  showProgress,
  showToolProgress,
  updateProgress,
} from '../src/ui/progress';
import * as commandPanel from '../src/ui/command-panel';
import {
  createSpinner,
  renderFooterBar,
  renderHeaderBox,
  renderPromptArea,
  renderPromptSeparator,
  toolLine,
} from '../src/ui/box';
import { renderCompactStatusBar, renderStatusBar } from '../src/ui/status-bar';
import { StreamMarkdownRenderer } from '../src/ui/stream-markdown';
import {
  renderDiffPreview,
  renderReadPreview,
  renderToolCard,
  renderToolLine,
} from '../src/ui/tool-preview';
import {
  renderUserInputContent,
  renderUserInputEcho,
  renderUserInputEchoFrame,
} from '../src/ui/user-input';

type StdoutProperty = 'isTTY' | 'columns';

let envBeforeTest: Pick<NodeJS.ProcessEnv, 'NO_COLOR' | 'TERM'>;
let stdoutDescriptorsBeforeTest: Record<StdoutProperty, PropertyDescriptor | undefined>;
let resizeListenersBeforeTest: Set<(...args: unknown[]) => void>;
let markedTerminalMockActive = false;

function setStdoutProperty(name: StdoutProperty, value: unknown): void {
  Object.defineProperty(process.stdout, name, { value, configurable: true });
}

function restoreStdoutProperty(
  name: StdoutProperty,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) Object.defineProperty(process.stdout, name, descriptor);
  else delete (process.stdout as unknown as Record<string, unknown>)[name];
}

function restoreEnvValue(name: 'NO_COLOR' | 'TERM', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function runCleanup(actions: Array<() => void>): void {
  const errors: unknown[] = [];
  for (const action of actions) {
    try {
      action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
}

function removeAddedResizeListeners(): void {
  for (const listener of process.stdout.listeners('resize')) {
    const typedListener = listener as (...args: unknown[]) => void;
    if (!resizeListenersBeforeTest.has(typedListener)) {
      process.stdout.removeListener('resize', typedListener);
    }
  }
}

function restoreMarkedTerminalMock(): void {
  if (!markedTerminalMockActive) return;
  try {
    jest.dontMock('marked-terminal');
  } finally {
    markedTerminalMockActive = false;
    jest.resetModules();
  }
}

beforeEach(() => {
  envBeforeTest = { NO_COLOR: process.env.NO_COLOR, TERM: process.env.TERM };
  stdoutDescriptorsBeforeTest = {
    isTTY: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
    columns: Object.getOwnPropertyDescriptor(process.stdout, 'columns'),
  };
  resizeListenersBeforeTest = new Set(
    process.stdout.listeners('resize') as Array<(...args: unknown[]) => void>
  );
});

afterEach(() => {
  runCleanup([
    removeAddedResizeListeners,
    () => hideFileCompletion(),
    () => setFileCompletionPromptRenderer('classic'),
    () => commandPanel.hideCommandPanel(),
    () => commandPanel.clearPendingCommand(),
    () => commandPanel.resetRenderLength(),
    () => commandPanel.setInputPromptRenderer('classic'),
    () => commandPanel.setInputRenderContextProvider(() => ({})),
    () => commandPanel.setInputStatusText(''),
    () => hideProgress(),
    () => restoreStdoutProperty('isTTY', stdoutDescriptorsBeforeTest.isTTY),
    () => restoreStdoutProperty('columns', stdoutDescriptorsBeforeTest.columns),
    () => restoreEnvValue('NO_COLOR', envBeforeTest.NO_COLOR),
    () => restoreEnvValue('TERM', envBeforeTest.TERM),
    restoreMarkedTerminalMock,
    () => jest.restoreAllMocks(),
    () => jest.useRealTimers(),
  ]);
});

describe('markdown rendering branches', () => {
  test('returns source markdown for non-TTY output', () => {
    setStdoutProperty('isTTY', false);
    expect(renderMarkdown('# raw')).toBe('# raw');
  });

  test('strips all supported markdown syntax when colors are disabled', () => {
    setStdoutProperty('isTTY', true);
    process.env.NO_COLOR = '1';
    const source = [
      '# Heading',
      '**bold** and *italic* and `code`',
      '[link](https://example.com)',
      '> quote',
      '- item',
      '1. ordered',
      '```ts',
      'const x = 1;',
      '```',
    ].join('\n');
    const output = renderMarkdown(source);
    expect(output).toContain('Heading');
    expect(output).toContain('bold and italic and code');
    expect(output).toContain('link');
    expect(output).not.toContain('```');
  });

  test('fallback renders code, headings, rules, quotes, lists, inline styles, and wrapping', () => {
    const source = [
      '```ts',
      'const answer = 42;',
      '```',
      '```',
      'plain code',
      '```',
      '',
      '---',
      '> a quote with enough words to wrap over several rows',
      '# Heading one',
      '### Heading three',
      '##### Heading five',
      '- **bold** `code` with enough words to wrap',
      '  * nested item',
      '1. *italic* with enough words to wrap over rows',
      'ordinary text with enough words to wrap over several terminal rows',
    ].join('\n');
    const output = renderMarkdownFallback(source, 20);
    expect(output).toContain('┌─ ts');
    expect(output).toContain('└');
    expect(output).toContain('Heading one');
    expect(output).toContain('│ a quote');
    expect(output).toContain('•');
    expect(output.split('\n').length).toBeGreaterThan(15);
  });

  test('fallback handles incomplete code fences and ANSI-aware wrapping', () => {
    const incomplete = renderMarkdownFallback('```js\nconst x = 1', 12);
    expect(incomplete).toContain('const x = 1');

    const ansi = renderMarkdownFallback('\x1b[31mabcdefghijk\x1b[0m', 4);
    expect(ansi).toContain('\x1b[0m');
    expect(ansi.split('\n').length).toBeGreaterThan(1);
    expect(renderMarkdownFallback('\x1b[31mx\x1b[0m', 80)).toContain('x');
    expect(renderMarkdownFallback('default width')).toBe('default width');
    expect(renderMarkdownFallback('short', 80)).toBe('short');
  });

  test('uses marked-terminal and falls back when marked parsing throws', () => {
    setStdoutProperty('isTTY', true);
    delete process.env.NO_COLOR;
    expect(renderMarkdown('# rendered')).toContain('rendered');
    expect(renderMarkdown('second pass')).toContain('second pass');

    const parse = jest.spyOn(marked, 'parse').mockImplementation(() => {
      throw new Error('parser failed');
    });
    expect(renderMarkdown('**fallback**', 20)).toContain('fallback');
    expect(parse).toHaveBeenCalled();
  });

  test('falls back when marked-terminal initialization fails', () => {
    setStdoutProperty('isTTY', true);
    delete process.env.NO_COLOR;
    jest.resetModules();
    jest.doMock('marked-terminal', () => ({
      __esModule: true,
      default: class BrokenRenderer {
        constructor() {
          throw new Error('renderer unavailable');
        }
      },
    }));
    markedTerminalMockActive = true;

    try {
      jest.isolateModules(() => {
        const isolated = require('../src/ui/markdown') as typeof import('../src/ui/markdown');
        expect(isolated.renderMarkdown('# fallback', 20)).toContain('fallback');
      });
    } finally {
      restoreMarkedTerminalMock();
    }
  });
});

describe('file completion state and rendering branches', () => {
  let output: string[];

  beforeEach(() => {
    output = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });
    (matchFiles as jest.Mock).mockReset();
    hideFileCompletion();
    setStdoutProperty('columns', 32);
  });

  afterEach(() => {
    hideFileCompletion();
  });

  test('handles hidden and empty-match no-op paths', () => {
    expect(selectFile()).toBeNull();
    expect(completeFile()).toBeNull();
    navigateFiles('up');
    navigateFiles('down');
    hideFileCompletion();

    (matchFiles as jest.Mock).mockReturnValue([]);
    showFileCompletion('none', 'read ');
    expect(isFileCompletionVisible()).toBe(true);
    expect(selectFile()).toBeNull();
    expect(completeFile()).toBeNull();
    navigateFiles('up');
    updateFileQuery('still-none');
    expect(isFileCompletionVisible()).toBe(false);
  });

  test('renders files and directories, truncates long paths, and clamps navigation', () => {
    (matchFiles as jest.Mock).mockReturnValue([
      { path: 'directory', isDirectory: true },
      { path: 'a-very-long-file-name-that-needs-truncation.ts', isDirectory: false },
    ]);
    showFileCompletion('', 'inspect ');
    expect(getBaseInput()).toBe('inspect ');
    expect(getFileQuery()).toBe('');
    expect(getFullInput()).toBe('inspect @');
    expect(output.join('')).toContain('📁');
    expect(output.join('')).toContain('📄');
    expect(output.join('')).toContain('...');

    navigateFiles('up');
    navigateFiles('down');
    navigateFiles('down');
    expect(selectFile()).toContain('a-very-long');
    expect(isFileCompletionVisible()).toBe(false);
  });

  test('directory completion refreshes matches while file completion returns the path', () => {
    (matchFiles as jest.Mock)
      .mockReturnValueOnce([{ path: 'src', isDirectory: true }])
      .mockReturnValueOnce([{ path: 'src/index.ts', isDirectory: false }])
      .mockReturnValueOnce([{ path: 'src/index.ts', isDirectory: false }]);
    showFileCompletion('s', 'open ');
    expect(completeFile()).toBeNull();
    expect(getFileQuery()).toBe('src/');
    expect(getFullInput()).toBe('open @src/');
    expect(completeFile()).toBe('src/index.ts');

    updateFileQuery('src/i');
    expect(isFileCompletionVisible()).toBe(true);
    hideFileCompletion();
  });

  test('supports classic, framed, v2, and legacy prompt aliases', () => {
    setFileCompletionPromptRenderer('classic');
    redrawInputWithFile('@src');
    setFileCompletionPromptRenderer('framed');
    redrawInputWithFile('@src');
    setFileCompletionPromptRenderer('v2');
    redrawInputWithFile('@src');
    setFileCompletionPromptRenderer('legacy');
    redrawInputWithFile('@src');
    const rendered = output.join('');
    expect(rendered).toContain('❯');
    expect(rendered).toContain('›');
  });

  test('uses the terminal width fallback when columns is unavailable', () => {
    setStdoutProperty('columns', 0);
    (matchFiles as jest.Mock).mockReturnValue([{ path: 'file.ts', isDirectory: false }]);
    showFileCompletion('f', '');
    expect(output.join('')).toContain('Files');
  });
});

describe('command panel state and cursor rendering branches', () => {
  let output: string[];

  beforeEach(() => {
    output = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });
    commandPanel.hideCommandPanel();
    commandPanel.clearPendingCommand();
    commandPanel.resetRenderLength();
    commandPanel.setInputPromptRenderer('classic');
    commandPanel.setInputRenderContextProvider(() => ({}));
    commandPanel.setInputStatusText('');
  });

  afterEach(() => {
    commandPanel.hideCommandPanel();
    commandPanel.resetRenderLength();
  });

  test('handles hidden, empty, navigation, selection, completion, and pending command state', () => {
    expect(commandPanel.selectCommand()).toBeNull();
    expect(commandPanel.completeSelectedCommand()).toBeNull();
    expect(commandPanel.getSelectedCommandName()).toBeNull();
    commandPanel.navigatePanel('up');
    commandPanel.navigatePanel('down');
    commandPanel.hideCommandPanel();

    commandPanel.showCommandPanel('definitely-no-command');
    expect(commandPanel.getSelectedCommandName()).toBeNull();
    commandPanel.navigatePanel('down');
    expect(output.join('')).toContain('No matching commands');

    commandPanel.updatePanelFilter('s');
    expect(commandPanel.getSelectedCommandName()).toBe('status');
    commandPanel.navigatePanel('up');
    commandPanel.navigatePanel('down');
    expect(commandPanel.selectCommand()).toMatch(/^\//);
    expect(commandPanel.getPendingCommand()).toMatch(/^\//);
    commandPanel.clearPendingCommand();
    expect(commandPanel.getPendingCommand()).toBeNull();

    commandPanel.showCommandPanel('m');
    expect(commandPanel.completeSelectedCommand()).toMatch(/^\/.* $/);
  });

  test('uses default filtering and clears a visible panel before classic input redraw', () => {
    commandPanel.showCommandPanel();
    expect(commandPanel.isPanelVisible()).toBe(true);
    output = [];
    commandPanel.redrawInputWithPrompt('hello', '[mode]');
    expect(output.join('')).toContain('\x1b[J');
    expect(output.join('')).toContain('hello');
    commandPanel.hideCommandPanel();
  });

  test('classic redraw clears exact-width and multi-row previous input', () => {
    commandPanel.redrawInputWithPrompt('x'.repeat(78));
    output = [];
    commandPanel.redrawInputWithPrompt('next');
    expect(output.join('')).toContain('\x1b[1A');

    commandPanel.resetRenderLength();
    commandPanel.redrawInputWithPrompt('x'.repeat(170));
    output = [];
    commandPanel.redrawInputWithPrompt('');
    expect(output.join('').split('\x1b[1A\x1b[2K').length).toBeGreaterThan(2);

    commandPanel.clearRenderedInput();
    expect(output.join('')).toContain('\x1b[2K\r');
  });

  test('framed redraw handles prefixes, status, cursor rows, leading output, and repeated clearing', () => {
    commandPanel.setInputPromptRenderer('v2');
    commandPanel.setInputRenderContextProvider(() => ({ prefixLines: ['first', 'second'] }));
    commandPanel.setInputStatusText('READY');
    commandPanel.writeOutputPreservingInput('partial');
    commandPanel.redrawInputWithPrompt('edit', 'mode');
    expect(output.join('')).toContain('\n');
    expect(output.join('')).toContain('READY');

    output = [];
    commandPanel.redrawInputWithPrompt('again', 'mode');
    expect(output.join('')).toContain('\x1b[2K');
    expect(output.join('')).toContain('\x1b[1B');

    output = [];
    commandPanel.writeOutputPreservingInput('line\rreplace\n' + 'z'.repeat(90));
    expect(output.join('')).toContain('line\rreplace\n');
    commandPanel.clearRenderedInput();
  });

  test('framed panel reserves offset space and writeLine uses its default argument', () => {
    commandPanel.setInputPromptRenderer('framed');
    commandPanel.redrawInputWithPrompt('/');
    output = [];
    commandPanel.showCommandPanel('s');
    expect(output.join('')).toContain('\x1b[2B\r');
    commandPanel.showCommandPanel('s');
    commandPanel.writeLinePreservingInput();
    expect(output.join('')).toContain('\n');
    commandPanel.hideCommandPanel();

    commandPanel.setInputPromptRenderer('legacy');
    commandPanel.resetRenderLength();
    commandPanel.writeLinePreservingInput('plain');
    expect(output.join('')).toContain('plain\n');

    commandPanel.setInputPromptRenderer('framed');
    commandPanel.resetRenderLength();
    commandPanel.clearRenderedInput();
  });

  test('module initialization covers NO_COLOR, TTY resize fallback, hidden and visible resize', () => {
    setStdoutProperty('isTTY', true);
    setStdoutProperty('columns', 0);
    delete process.env.NO_COLOR;
    process.env.TERM = 'dumb';
    jest.resetModules();

    let isolated!: typeof import('../src/ui/command-panel');
    try {
      jest.isolateModules(() => {
        isolated = require('../src/ui/command-panel');
        process.stdout.emit('resize');
        isolated.showCommandPanel('s');
        setStdoutProperty('columns', 44);
        process.stdout.emit('resize');
        isolated.hideCommandPanel();
      });

      removeAddedResizeListeners();
      setStdoutProperty('isTTY', false);
      delete process.env.NO_COLOR;
      process.env.TERM = 'xterm-256color';
      jest.resetModules();
      jest.isolateModules(() => {
        const colored =
          require('../src/ui/command-panel') as typeof import('../src/ui/command-panel');
        colored.resetRenderLength();
        expect(colored.isPanelVisible()).toBe(false);
      });
      expect(isolated.isPanelVisible()).toBe(false);
    } finally {
      removeAddedResizeListeners();
      jest.resetModules();
    }
  });
});

describe('progress indicator branches', () => {
  let output: string[];

  beforeEach(() => {
    output = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });
    delete process.env.NO_COLOR;
    setStdoutProperty('isTTY', false);
    hideProgress();
  });

  afterEach(() => {
    hideProgress();
  });

  test('ignores non-TTY progress and restore operations', () => {
    showProgress('hidden');
    updateProgress('still hidden');
    hideProgress();
    clearProgressAndRestorePrompt('> ');
    expect(output).toEqual([]);
    expect(isProgressActive()).toBe(false);
  });

  test('renders colored progress, updates it, formats totals, and restores the prompt', () => {
    setStdoutProperty('isTTY', true);
    showProgress('working');
    expect(isProgressActive()).toBe(true);
    updateProgress('updated');
    showToolProgress(1, 'read_file', 3);
    showToolProgress(2, 'write_file');
    clearProgressAndRestorePrompt('❯ ');
    hideProgress();
    expect(isProgressActive()).toBe(false);
    expect(output.join('')).toContain('Executing tool 1/3');
    expect(output.join('')).toContain('Executing tool 2');
    expect(output.join('')).toContain('❯ ');
  });

  test('renders the NO_COLOR form without activating the update state', () => {
    setStdoutProperty('isTTY', true);
    process.env.NO_COLOR = '1';
    showProgress('plain');
    updateProgress('not rendered');
    expect(output.join('')).toContain('⏳ plain');
    expect(output.join('')).not.toContain('not rendered');
  });
});

describe('additional pure UI branch surfaces', () => {
  test('stream markdown covers all line kinds, code variants, incomplete flush, and reset', () => {
    const renderer = new StreamMarkdownRenderer();
    expect(renderer.feed('')).toBe('');
    expect(renderer.feed('buffered')).toBe('');
    expect(
      renderer.feed('\n---\n# one\n### three\n##### five\n> quote\n>tight\n- item\n  2. ordered\n')
    ).toContain('ordered');
    expect(renderer.feed('**bold** __strong__ *italic* _em_ `code` [link](https://x)\n')).toContain(
      'link'
    );
    expect(renderer.feed('before\n```\n')).toContain('┌─');
    expect(renderer.feed('line one\nline two\npartial')).toContain('line one');
    expect(renderer.feed('tail\n```after')).toContain('after');

    const incomplete = new StreamMarkdownRenderer();
    incomplete.feed('```ts\n');
    incomplete.feed('\ncode\n\npartial');
    expect(incomplete.flush()).toContain('incomplete');
    incomplete.reset();
    expect(incomplete.flush()).toBe('');
  });

  test('tool previews cover long, empty, failed, and multi-line results and argument kinds', () => {
    const long = 'x'.repeat(80);
    expect(
      renderToolCard({
        name: 'tool',
        args: { pattern: long },
        result: Array.from({ length: 8 }, (_, index) => `${index}-${long}`).join('\n'),
        success: false,
        duration: 0,
      })
    ).toContain('2 more lines');
    expect(
      renderToolCard({ name: 'empty', args: {}, result: '', success: true, duration: 1 })
    ).toContain('empty');
    expect(renderToolLine('path', { path: long }, true)).toContain('...');
    expect(renderToolLine('command', { command: long }, false, 12)).toContain('12ms');
    expect(renderToolLine('pattern', { pattern: long }, true)).toContain('...');
    expect(renderToolLine('file', { file_path: long }, false)).toContain('...');
    expect(
      renderDiffPreview({ file: 'x.ts', oldLines: [long, 'short'], newLines: [long, 'short'] })
    ).toContain('...');
    expect(renderReadPreview(long, `${long}\n${Array(9).fill('line').join('\n')}`, true)).toContain(
      '2 more lines'
    );
    expect(renderReadPreview('missing', '', false)).toContain('missing');
  });

  test('status bars cover token tiers, context tiers, MCP states, and compact emptiness', () => {
    const base = {
      model: 'model',
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      mcpConnected: 0,
      mcpTotal: 0,
    };
    expect(renderStatusBar({ ...base, tokens: 999, ctxPercent: 0 })).toContain('999 tok');
    expect(renderStatusBar({ ...base, tokens: 1_000, ctxPercent: 79 })).toContain('1.0K tok');
    expect(
      renderStatusBar({ ...base, tokens: 1_000_000, ctxPercent: 80, mcpConnected: 2, mcpTotal: 2 })
    ).toContain('1.0M tok');
    expect(
      renderStatusBar({ ...base, tokens: 10, ctxPercent: 90, mcpConnected: 1, mcpTotal: 2 })
    ).toContain('MCP 1/2');
    expect(renderCompactStatusBar({ ...base, tokens: 0, ctxPercent: 0 })).toBe('');
    expect(renderCompactStatusBar({ ...base, tokens: 10, ctxPercent: 0 })).toContain('10 tok');
    expect(renderCompactStatusBar({ ...base, tokens: 0, ctxPercent: 10 })).toContain('ctx');
  });

  test('box helpers cover providers, status icons, widths, truncation, args, and spinner lifecycle', () => {
    for (const provider of ['Alibaba Cloud', 'Anthropic', 'OpenAI', '', 'Other']) {
      for (const status of ['ready', 'loading', 'error', 'processing', 'other']) {
        expect(
          renderHeaderBox({ provider, model: 'm', status: status as never, version: '1.0.0' })
        ).toContain('orion');
      }
    }
    setStdoutProperty('columns', 20);
    expect(renderPromptArea().promptLine).toContain('❯');
    expect(renderPromptArea('plan').promptLine).toContain('plan');
    expect(renderPromptSeparator()).toContain('❯');
    expect(renderPromptSeparator('a very long mode')).toContain('mode');
    expect(renderFooterBar()).toContain('shortcuts');
    expect(renderFooterBar('/a/very/long/path/' + 'x'.repeat(40), 'high')).toContain('...');
    expect(toolLine('read', { path: 'x'.repeat(60) }, true)).toContain('...');
    expect(toolLine('exec', { command: 'x'.repeat(60) }, false, 7)).toContain('7ms');
    expect(toolLine('other', { value: 'x'.repeat(60) }, true, 0)).toContain('0ms');
    expect(toolLine('empty', { value: 1 }, false)).toContain('empty');

    const writes = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.useFakeTimers();
    const spinner = createSpinner();
    spinner.stop();
    spinner.start();
    spinner.start('ignored');
    spinner.update('');
    spinner.update('working');
    jest.advanceTimersByTime(220);
    spinner.stop();
    spinner.stop();
    expect(writes).toHaveBeenCalled();
  });

  test('user input covers color modes, width fallbacks, padding floor, and wide code-point ranges', () => {
    delete process.env.NO_COLOR;
    process.env.TERM = 'xterm-256color';
    setStdoutProperty('columns', 0);
    const wide = [
      '\u1100',
      '\u2329',
      '\u2e80',
      '\u303f',
      '\uac00',
      '\uf900',
      '\ufe10',
      '\ufe30',
      '\uff01',
      '\uffe0',
      String.fromCodePoint(0x20000),
      String.fromCodePoint(0x30000),
      'a',
    ].join('');
    expect(renderUserInputContent(wide)).toContain('\x1b[48;2;');
    expect(renderUserInputContent('long text', 1)).toContain('long text');
    expect(renderUserInputEcho('one\ntwo', 10).split('\n')).toHaveLength(2);
    expect(renderUserInputEchoFrame('frame', 10)).toBe(renderUserInputEcho('frame', 10));

    process.env.TERM = 'dumb';
    expect(renderUserInputContent('plain', 10)).not.toContain('\x1b[');
  });
});
