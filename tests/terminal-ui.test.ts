import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { EventEmitter } from 'events';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applySingleTerminalTabCompletion,
  applyTerminalTabCompletion,
  completeFileMention,
  completeSlashCommand,
  createTerminalCompleter,
} from '../src/terminal-ui/completion';
import {
  TerminalEventSink,
  TerminalInputComposer,
  formatTerminalEditPreviewCandidate,
  formatTerminalEditPreviewHeader,
  formatTerminalErrorMessage,
  formatTerminalPermissionPrompt,
  formatTerminalSessionRestored,
  formatTerminalSessionPickerHeader,
  formatTerminalSessionPickerItem,
  formatTerminalStatusMessage,
  inferTerminalErrorLayer,
  normalizeTerminalAnswer,
  parseEditInput,
  promptText,
  renderTerminalBanner,
  renderTerminalCapabilitySummary,
  renderTerminalContextStatus,
  renderTerminalShortcuts,
  resolveTerminalSessionPickerInput,
  terminalContentWidth,
  truncateTerminalText,
  visibleLength,
} from '../src/terminal-ui/launch';
import { RawTerminalEditor } from '../src/terminal-ui/raw-editor';
import { createToolEventPresenter } from '../src/runtime/chat-controller';
import type { OpenHorseUiRuntime } from '../src/runtime/ui-events';
import type { AppState } from '../src/framework/store';

function makeRawEditor(
  options: {
    cwd?: string;
    onSubmit?: (input: string) => void;
    onNotice?: (message: string) => void;
  } = {}
) {
  const writes: string[] = [];
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setEncoding: jest.fn(),
    resume: jest.fn(),
    pause: jest.fn(),
    setRawMode: jest.fn((mode: boolean) => {
      input.isRaw = mode;
      return input;
    }),
  }) as unknown as NodeJS.ReadStream & {
    isRaw: boolean;
    setRawMode: (mode: boolean) => NodeJS.ReadStream;
  };
  const output = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: (chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    },
  }) as NodeJS.WriteStream & EventEmitter & { columns: number; rows: number };

  const editor = new RawTerminalEditor({
    cwd: options.cwd ?? process.cwd(),
    input,
    output,
    onSubmit: options.onSubmit ?? (() => undefined),
    onCtrlC: () => undefined,
    onNotice: options.onNotice,
  });

  return { editor, input, output, writes, emitResize: () => output.emit('resize') };
}

function makeRuntime(
  overrides: {
    state?: Partial<AppState>;
    config?: Partial<OpenHorseUiRuntime['config']>;
  } = {}
): OpenHorseUiRuntime {
  const state = {
    tools: [],
    memoryContent: '',
    skillsContent: '',
    projectInstructionsContent: '',
    ...overrides.state,
  } as AppState;

  return {
    cwd: '/tmp/openhorse-terminal-renderer',
    version: 'test',
    config: {
      model: 'test-model',
      ui: { renderer: 'terminal' },
      ...overrides.config,
    } as OpenHorseUiRuntime['config'],
    store: {
      setProcessing: jest.fn(),
      getSnapshot: jest.fn(() => state),
    } as unknown as OpenHorseUiRuntime['store'],
    llm: null,
    runtime: {} as OpenHorseUiRuntime['runtime'],
    isConfigured: true,
    ensureSession: jest.fn(),
    setSession: jest.fn(),
    getSession: jest.fn(() => null),
    shutdown: jest.fn(),
  };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

function withStdoutColumns<T>(columns: number | undefined, fn: () => T): T {
  const original = process.stdout.columns;
  Object.defineProperty(process.stdout, 'columns', {
    configurable: true,
    value: columns,
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: original,
    });
  }
}

function makeTerminalSink() {
  const writes: string[] = [];
  const sink = new TerminalEventSink(makeRuntime(), {
    write: text => writes.push(text),
  });
  return { sink, writes };
}

describe('terminal UI input normalization', () => {
  it('applies DEL/backspace before submitting text', () => {
    expect(normalizeTerminalAnswer('/helpx\x7f')).toBe('/help');
    expect(normalizeTerminalAnswer('/helpx\b')).toBe('/help');
  });

  it('removes the previous unicode character for CJK input', () => {
    expect(normalizeTerminalAnswer('开源小?\x7f')).toBe('开源小');
    expect(normalizeTerminalAnswer('开源小\x7f')).toBe('开源');
  });

  it('supports common line editing control characters when terminals pass them through', () => {
    expect(normalizeTerminalAnswer('abc\x15next')).toBe('next');
    expect(normalizeTerminalAnswer('hello world\x17agent')).toBe('helloagent');
  });

  it('drops leaked terminal escape sequences', () => {
    expect(normalizeTerminalAnswer('/help\x1b[A')).toBe('/help');
    expect(normalizeTerminalAnswer('/help\x1b[3~')).toBe('/help');
  });
});

describe('terminal UI renderer adapter', () => {
  it('renders a concise startup banner with renderer and capability summary', () => {
    const runtime = makeRuntime();
    const banner = stripAnsi(renderTerminalBanner(runtime));

    expect(banner).toContain('ORION CODE');
    expect(banner).toContain('vtest');
    expect(banner).toContain('stable terminal UI');
    expect(banner).toContain('Model test-model');
    expect(banner).toContain('Project /tmp/openhorse-terminal-renderer');
    expect(banner).toContain('Session new');
    expect(banner).toContain('Renderer terminal');
    expect(banner).toContain('Capabilities scrollback, CJK input, paste/edit, trace');
  });

  it('shows context percentage and compact reminder in the terminal prompt', () => {
    const runtime = makeRuntime({
      state: {
        contextUsage: {
          modelId: 'gpt-4o',
          usedTokens: 108800,
          contextWindow: 128000,
          percent: 85,
          source: 'estimated',
          warningThresholdPercent: 80,
          autoCompactThresholdPercent: 95,
          autoCompactEnabled: true,
        },
      },
    });

    expect(stripAnsi(renderTerminalContextStatus(runtime))).toBe('ctx=85% /compact');
    expect(stripAnsi(promptText(runtime))).toBe('[new] ctx=85% /compact › ');
  });

  it('summarizes loaded runtime capabilities in the startup banner', () => {
    const runtime = makeRuntime({
      config: {
        webSearch: {
          provider: 'test',
          endpoint: 'https://search.example.test/mcp',
        },
      },
      state: {
        projectInstructionsContent: 'Follow repo rules.',
        skillsContent: 'Available skills: code-review',
        memoryContent: 'Project memory',
        tools: [{ name: 'read_file' }, { name: 'mcp__github__search_issues' }] as AppState['tools'],
      },
    });

    const summary = renderTerminalCapabilitySummary(runtime);
    const banner = withStdoutColumns(88, () => stripAnsi(renderTerminalBanner(runtime)));

    expect(summary).toBe(
      'scrollback, CJK input, paste/edit, trace, repo rules, skills, memory, MCP, web search'
    );
    expect(banner).toContain('repo rules');
    expect(banner).toContain('...');
  });

  it('keeps startup capability summary safe with a minimal store snapshot', () => {
    const runtime = makeRuntime();
    runtime.store.getSnapshot = jest.fn(() => ({}) as AppState);

    expect(renderTerminalCapabilitySummary(runtime)).toBe(
      'scrollback, CJK input, paste/edit, trace'
    );
  });

  it('keeps startup banner rows within very narrow terminal widths', () => {
    const runtime = makeRuntime();
    const banner = withStdoutColumns(12, () => renderTerminalBanner(runtime));
    const rows = stripAnsi(banner).split('\n').filter(Boolean);

    expect(rows).toHaveLength(6);
    expect(rows.every(row => visibleLength(row) <= 12)).toBe(true);
  });

  it('maps session picker selections to runtime protocol inputs', () => {
    const { sink, writes } = makeTerminalSink();

    sink.showSessionPicker({
      title: 'Pick a Session',
      allProjects: true,
      showProject: true,
      sessions: [
        {
          id: '11111111-aaaa-bbbb-cccc-111111111111',
          projectPath: '/tmp/project-a',
          model: 'glm-5',
          startTime: 1,
          tokenCount: 0,
          cost: 0,
          messageCount: 4,
          historySizeBytes: 1536,
          taskSummary: 'older task',
        },
        {
          id: '22222222-aaaa-bbbb-cccc-222222222222',
          projectPath: '/tmp/project-b',
          model: 'glm-5',
          startTime: 2,
          tokenCount: 0,
          cost: 0,
          messageCount: 8,
          historySizeBytes: 2048,
          taskSummary: 'newer task',
        },
      ],
    });

    expect(writes.join('')).toContain('Pick a Session');
    expect(writes.join('')).toContain('newer task');
    expect(writes.join('')).toContain('session id prefix');
    expect(sink.consumePendingSelection('2')).toEqual({
      type: 'select_session',
      sessionId: '22222222-aaaa-bbbb-cccc-222222222222',
      allProjects: true,
      source: 'picker',
    });
  });

  it('resolves session picker input by index, id prefix, and unique title text', () => {
    const request = {
      title: 'Pick a Session',
      allProjects: true,
      sessions: [
        {
          id: '11111111-aaaa-bbbb-cccc-111111111111',
          projectPath: '/tmp/project-a',
          model: 'glm-5',
          startTime: 1,
          tokenCount: 0,
          cost: 0,
          messageCount: 4,
          historySizeBytes: 1536,
          taskSummary: 'storage cleanup work',
        },
        {
          id: '22222222-aaaa-bbbb-cccc-222222222222',
          projectPath: '/tmp/project-b',
          model: 'glm-5',
          startTime: 2,
          tokenCount: 0,
          cost: 0,
          messageCount: 8,
          historySizeBytes: 2048,
          name: 'terminal ui polish',
          taskSummary: 'newer task',
        },
      ],
    };

    expect(resolveTerminalSessionPickerInput('#2', request)).toEqual({
      type: 'selected',
      sessionId: '22222222-aaaa-bbbb-cccc-222222222222',
    });
    expect(resolveTerminalSessionPickerInput('11111111', request)).toEqual({
      type: 'selected',
      sessionId: '11111111-aaaa-bbbb-cccc-111111111111',
    });
    expect(resolveTerminalSessionPickerInput('terminal ui', request)).toEqual({
      type: 'selected',
      sessionId: '22222222-aaaa-bbbb-cccc-222222222222',
    });
  });

  it('prefers bare numeric row selection over numeric id-prefix matching', () => {
    const request = {
      title: 'Pick a Session',
      sessions: [
        {
          id: '22222222-aaaa-bbbb-cccc-222222222222',
          projectPath: '/tmp/project-a',
          model: 'glm-5',
          startTime: 1,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'numeric id prefix',
        },
        {
          id: 'aaaaaaaa-aaaa-bbbb-cccc-aaaaaaaaaaaa',
          projectPath: '/tmp/project-b',
          model: 'glm-5',
          startTime: 2,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'second visible row',
        },
      ],
    };

    expect(resolveTerminalSessionPickerInput('2', request)).toEqual({
      type: 'selected',
      sessionId: 'aaaaaaaa-aaaa-bbbb-cccc-aaaaaaaaaaaa',
    });
    expect(resolveTerminalSessionPickerInput('2222', request)).toEqual({
      type: 'selected',
      sessionId: '22222222-aaaa-bbbb-cccc-222222222222',
    });
  });

  it('limits visible picker rows while keeping hidden sessions selectable by id or title', () => {
    const { sink, writes } = makeTerminalSink();
    const request = {
      title: 'Pick a Session',
      maxVisibleItems: 2,
      sessions: [
        {
          id: '11111111-aaaa-bbbb-cccc-111111111111',
          projectPath: '/tmp/project-a',
          model: 'glm-5',
          startTime: 1,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'first task',
        },
        {
          id: '22222222-aaaa-bbbb-cccc-222222222222',
          projectPath: '/tmp/project-b',
          model: 'glm-5',
          startTime: 2,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'second task',
        },
        {
          id: '33333333-aaaa-bbbb-cccc-333333333333',
          projectPath: '/tmp/project-c',
          model: 'glm-5',
          startTime: 3,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'hidden task',
        },
      ],
    };

    sink.showSessionPicker(request);

    const output = writes.join('');
    expect(output).toContain('first task');
    expect(output).toContain('second task');
    expect(output).not.toContain('hidden task');
    expect(output).toContain('Showing 1-2 of 3');
    expect(resolveTerminalSessionPickerInput('3', request)).toEqual({
      type: 'selected',
      sessionId: '33333333-aaaa-bbbb-cccc-333333333333',
    });
    expect(resolveTerminalSessionPickerInput('3333', request)).toEqual({
      type: 'selected',
      sessionId: '33333333-aaaa-bbbb-cccc-333333333333',
    });
    expect(resolveTerminalSessionPickerInput('hidden', request)).toEqual({
      type: 'selected',
      sessionId: '33333333-aaaa-bbbb-cccc-333333333333',
    });
  });

  it('pages session picker output without changing global numeric selection', () => {
    const { sink, writes } = makeTerminalSink();
    const request = {
      title: 'Pick a Session',
      maxVisibleItems: 2,
      sessions: [
        {
          id: '11111111-aaaa-bbbb-cccc-111111111111',
          projectPath: '/tmp/project-a',
          model: 'glm-5',
          startTime: 1,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'first task',
        },
        {
          id: '22222222-aaaa-bbbb-cccc-222222222222',
          projectPath: '/tmp/project-b',
          model: 'glm-5',
          startTime: 2,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'second task',
        },
        {
          id: '33333333-aaaa-bbbb-cccc-333333333333',
          projectPath: '/tmp/project-c',
          model: 'glm-5',
          startTime: 3,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'third task',
        },
      ],
    };

    sink.showSessionPicker(request);
    expect(writes.join('')).toContain('page 1/2');
    expect(writes.join('')).not.toContain('third task');

    expect(sink.consumePendingSelection('n')).toBe('');
    expect(writes.join('')).toContain('page 2/2');
    expect(writes.join('')).toContain(' 3.');
    expect(writes.join('')).toContain('third task');

    expect(sink.consumePendingSelection('3')).toEqual({
      type: 'select_session',
      sessionId: '33333333-aaaa-bbbb-cccc-333333333333',
      allProjects: undefined,
      source: 'picker',
    });
  });

  it('handles session picker empty state, page boundaries, and slash escape locally', () => {
    const empty = makeTerminalSink();
    empty.sink.showSessionPicker({ title: 'Pick a Session', sessions: [] });

    expect(empty.writes.join('')).toContain('No saved sessions found.');
    expect(empty.sink.consumePendingSelection('')).toBe('');
    expect(empty.writes.join('')).toContain('Session picker cancelled.');

    const { sink, writes } = makeTerminalSink();
    const request = {
      title: 'Pick a Session',
      allProjects: true,
      maxVisibleItems: 1,
      sessions: [
        {
          id: '11111111-aaaa-bbbb-cccc-111111111111',
          projectPath: '/tmp/project-a',
          model: 'glm-5',
          startTime: 1,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'first task',
        },
        {
          id: '22222222-aaaa-bbbb-cccc-222222222222',
          projectPath: '/tmp/project-b',
          model: 'glm-5',
          startTime: 2,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'second task',
        },
      ],
    };

    sink.showSessionPicker(request);
    expect(sink.consumePendingSelection('p')).toBe('');
    expect(writes.join('')).toContain('Already at first session page.');

    expect(sink.consumePendingSelection('n')).toBe('');
    expect(writes.join('')).toContain('page 2/2');
    expect(writes.join('')).toContain('second task');

    expect(sink.consumePendingSelection('next')).toBe('');
    expect(writes.join('')).toContain('Already at last session page.');

    expect(sink.consumePendingSelection('/resume --last')).toBe('/resume --last');
  });

  it('formats session picker rows to fit narrow terminals', () => {
    const row = withStdoutColumns(48, () =>
      formatTerminalSessionPickerItem(
        {
          session: {} as never,
          globalIndex: 12,
          sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
          shortId: 'abcdef12',
          title: 'very long terminal user interface polishing session title',
          messageCount: 128,
          historySizeBytes: 153600,
          model: 'bailian/qwen3.7-plus',
          projectPath: '/Users/hope/ai-project/openhorse',
          showProject: true,
        },
        terminalContentWidth(120)
      )
    );

    const plain = stripAnsi(row);
    expect(visibleLength(plain)).toBeLessThanOrEqual(48);
    expect(plain).toContain('12. abcdef12');
    expect(plain).not.toContain('/Users/hope/ai-project/openhorse');
  });

  it('formats session picker headers to fit narrow terminals', () => {
    const header = withStdoutColumns(32, () =>
      formatTerminalSessionPickerHeader(
        'A very long all-project session picker heading',
        12,
        30,
        terminalContentWidth(120)
      )
    );
    const plain = stripAnsi(header);

    expect(visibleLength(plain)).toBeLessThanOrEqual(32);
    expect(plain).toContain('page 12/30');
  });

  it('keeps session picker output within narrow terminal widths', () => {
    const { sink, writes } = makeTerminalSink();

    withStdoutColumns(48, () =>
      sink.showSessionPicker({
        title: 'A very long all-project session picker heading',
        showProject: true,
        sessions: [
          {
            id: '11111111-aaaa-bbbb-cccc-111111111111',
            projectPath: '/Users/hope/ai-project/openhorse',
            model: 'bailian/qwen3.7-plus',
            startTime: 1,
            tokenCount: 0,
            cost: 0,
            messageCount: 128,
            historySizeBytes: 153600,
            taskSummary: 'very long terminal user interface polishing session title',
          },
        ],
      })
    );

    const rows = stripAnsi(writes.join('')).split('\n').filter(Boolean);
    expect(rows.every(row => visibleLength(row) <= 48)).toBe(true);
    expect(rows.join('\n')).toContain('Select number/id');
  });

  it('keeps all-project session picker flag when selecting after paging', () => {
    const { sink } = makeTerminalSink();
    sink.showSessionPicker({
      title: 'Pick a Session',
      allProjects: true,
      maxVisibleItems: 1,
      sessions: [
        {
          id: '11111111-aaaa-bbbb-cccc-111111111111',
          projectPath: '/tmp/project-a',
          model: 'glm-5',
          startTime: 1,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'first task',
        },
        {
          id: '22222222-aaaa-bbbb-cccc-222222222222',
          projectPath: '/tmp/project-b',
          model: 'glm-5',
          startTime: 2,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'second task',
        },
      ],
    });

    expect(sink.consumePendingSelection('n')).toBe('');
    expect(sink.consumePendingSelection('2')).toEqual({
      type: 'select_session',
      sessionId: '22222222-aaaa-bbbb-cccc-222222222222',
      allProjects: true,
      source: 'picker',
    });
  });

  it('prefers exact session title matches over picker navigation aliases', () => {
    const { sink } = makeTerminalSink();
    sink.showSessionPicker({
      title: 'Pick a Session',
      maxVisibleItems: 1,
      sessions: [
        {
          id: '11111111-aaaa-bbbb-cccc-111111111111',
          projectPath: '/tmp/project-a',
          model: 'glm-5',
          startTime: 1,
          tokenCount: 0,
          cost: 0,
          name: 'next',
          taskSummary: 'navigation alias title',
        },
        {
          id: '22222222-aaaa-bbbb-cccc-222222222222',
          projectPath: '/tmp/project-b',
          model: 'glm-5',
          startTime: 2,
          tokenCount: 0,
          cost: 0,
          name: 'previous',
          taskSummary: 'second task',
        },
      ],
    });

    expect(sink.consumePendingSelection('next')).toEqual({
      type: 'select_session',
      sessionId: '11111111-aaaa-bbbb-cccc-111111111111',
      allProjects: undefined,
      source: 'picker',
    });
  });

  it('keeps ambiguous session picker text local and shows a helpful error', () => {
    const { sink, writes } = makeTerminalSink();

    sink.showSessionPicker({
      title: 'Pick a Session',
      sessions: [
        {
          id: '11111111-aaaa-bbbb-cccc-111111111111',
          projectPath: '/tmp/project-a',
          model: 'glm-5',
          startTime: 1,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'ui polish',
        },
        {
          id: '22222222-aaaa-bbbb-cccc-222222222222',
          projectPath: '/tmp/project-b',
          model: 'glm-5',
          startTime: 2,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'ui review',
        },
      ],
    });

    expect(sink.consumePendingSelection('ui')).toBe('');
    expect(writes.join('')).toContain('Multiple sessions match "ui"');
    expect(writes.join('')).toContain('Type a number or a longer session id');
    expect(sink.consumePendingSelection('11111111')).toEqual({
      type: 'select_session',
      sessionId: '11111111-aaaa-bbbb-cccc-111111111111',
      allProjects: undefined,
      source: 'picker',
    });
  });

  it('keeps terminal scrollback transcript append-only for tool output', () => {
    const { sink, writes } = makeTerminalSink();

    const toolId = sink.append({
      role: 'tool',
      title: 'tool',
      content: 'Running read_file src/index.ts',
    });
    sink.finalize(toolId, {
      role: 'tool',
      title: 'tool',
      content: '✓ read_file src/index.ts (12ms)',
    });
    const assistantId = sink.append({
      role: 'assistant',
      content: 'Done.',
    });
    sink.finalize(assistantId);

    const output = writes.join('');
    expect(output).toContain('Running read_file src/index.ts');
    expect(output).toContain('✓ read_file src/index.ts (12ms)');
    expect(output).toContain('Done.');
    expect(output.indexOf('Running read_file')).toBeLessThan(output.indexOf('✓ read_file'));
    expect(output.indexOf('✓ read_file')).toBeLessThan(output.indexOf('Done.'));
  });

  it('keeps the full exec command visible after tool completion', () => {
    const { sink, writes } = makeTerminalSink();
    const presenter = createToolEventPresenter(sink);
    const command =
      'cd /Users/hope/ai-project/a2a-python && export PATH="$HOME/.local/bin:$PATH" && uv run pytest tests/test_url_validator.py --cov=a2a --cov-report=term-missing';

    presenter.start({
      type: 'tool_call',
      callId: 'call-exec',
      name: 'exec_command',
      args: { command },
    });
    presenter.finish({
      type: 'tool_result',
      callId: 'call-exec',
      name: 'exec_command',
      args: { command },
      result: JSON.stringify({ success: true, output: 'ok', summary: '🔧 exec (2B output)' }),
      modelVisibleResult: JSON.stringify({
        success: true,
        output: 'ok',
        summary: '🔧 exec (2B output)',
      }),
      success: true,
      duration: 12,
      summary: '🔧 exec (2B output)',
    });

    const output = writes.join('');
    expect(output).toContain(`$ ${command}`);
    expect(output).toContain('🔧 exec (2B output)');
  });

  it('renders tool artifact references for summarized long output', () => {
    const { sink, writes } = makeTerminalSink();
    const presenter = createToolEventPresenter(sink);

    presenter.start({
      type: 'tool_call',
      callId: 'call-read',
      name: 'read_file',
      args: { path: 'logs/huge-output.txt' },
    });
    presenter.finish({
      type: 'tool_result',
      callId: 'call-read',
      name: 'read_file',
      args: { path: 'logs/huge-output.txt' },
      result: JSON.stringify({ success: true, output: 'truncated' }),
      modelVisibleResult: JSON.stringify({ success: true, output: 'truncated' }),
      success: true,
      duration: 9,
      summary: '📄 read logs/huge-output.txt (truncated)',
      outputBytes: 150000,
      artifactRef: { id: 'read_file-abc123', outputBytes: 150000 },
    });

    const output = writes.join('');
    expect(output).toContain('Full output: /artifacts show read_file-abc123 --full (146 KB)');
  });

  it('marks batched tool calls in the terminal transcript', () => {
    const { sink, writes } = makeTerminalSink();
    const presenter = createToolEventPresenter(sink);

    presenter.start({
      type: 'tool_call',
      callId: 'call-a',
      name: 'read_file',
      args: { path: 'src/a.ts' },
      batchCount: 2,
      batchIndex: 0,
    });
    presenter.finish({
      type: 'tool_result',
      callId: 'call-a',
      name: 'read_file',
      args: { path: 'src/a.ts' },
      result: JSON.stringify({ success: true, output: 'alpha' }),
      modelVisibleResult: JSON.stringify({ success: true, output: 'alpha' }),
      success: true,
      duration: 7,
      outputBytes: 5,
      batchCount: 2,
      batchIndex: 0,
    });

    const output = stripAnsi(writes.join(''));
    expect(output).toContain('Batch 1/2 · Running read_file src/a.ts');
    expect(output).toContain('Batch 1/2 · ✓ read_file src/a.ts (7ms)');
  });

  it('ignores invalid batch metadata in the terminal transcript', () => {
    const { sink, writes } = makeTerminalSink();
    const presenter = createToolEventPresenter(sink);

    presenter.start({
      type: 'tool_call',
      callId: 'call-invalid-batch',
      name: 'read_file',
      args: { path: 'src/a.ts' },
      batchCount: 2,
      batchIndex: 9,
    });

    const output = stripAnsi(writes.join(''));
    expect(output).toContain('Running read_file src/a.ts');
    expect(output).not.toContain('Batch 10/2');
  });

  it('clears renderer view state without clearing terminal scrollback', () => {
    const { sink, writes } = makeTerminalSink();

    const assistantId = sink.append({ role: 'assistant', content: 'existing transcript' });
    sink.finalize(assistantId);
    sink.clearTranscript();

    const output = writes.join('');
    expect(output).toContain('existing transcript');
    expect(output).toContain('Terminal scrollback is preserved.');
  });

  it('adds a diagnostic layer to terminal error transcript entries', () => {
    const { sink, writes } = makeTerminalSink();

    sink.append({ role: 'error', content: 'Error: 404 status code (no body)' });
    sink.append({ role: 'error', content: 'Error: Command exited with code 1' });
    sink.append({ role: 'error', content: 'Error: MCP server github failed' });
    sink.append({ role: 'error', content: '[tool] Error: read_file failed' });

    const output = stripAnsi(writes.join(''));
    expect(output).toContain('[provider] Error: 404 status code (no body)');
    expect(output).toContain('[tool] Error: Command exited with code 1');
    expect(output).toContain('[MCP] Error: MCP server github failed');
    expect(output).toContain('[tool] Error: read_file failed');
    expect(output).not.toContain('[tool] [tool]');
  });

  it('infers terminal error layers without changing runtime semantics', () => {
    expect(inferTerminalErrorLayer('Error: status code 429 rate limit')).toBe('provider');
    expect(inferTerminalErrorLayer('Error: Path is a directory, not a file')).toBe('tool');
    expect(inferTerminalErrorLayer('Error: session restore failed')).toBe('session');
    expect(inferTerminalErrorLayer('Error: memory recall failed')).toBe('memory');
    expect(inferTerminalErrorLayer('Error: No frontmatter in skill file')).toBe('skills');
    expect(inferTerminalErrorLayer('Error: terminal resize failed')).toBe('renderer');
    expect(inferTerminalErrorLayer('Error: unexpected state transition')).toBe('runtime');
    expect(formatTerminalErrorMessage('Error [provider]: existing layer')).toBe(
      'Error [provider]: existing layer'
    );
    expect(formatTerminalErrorMessage('Error: [provider] existing layer')).toBe(
      'Error: [provider] existing layer'
    );
  });

  it('formats edit preview rows within narrow terminal widths', () => {
    const candidate = {
      index: 0,
      line: 42,
      match: 'const message = "这是一个非常长的中文匹配内容，需要按视觉宽度截断";',
      contextBefore: '',
      contextAfter: '',
      isReplaceAll: false,
    };

    const row = withStdoutColumns(48, () =>
      formatTerminalEditPreviewCandidate(
        candidate,
        'const message = "replacement with a very long value";',
        terminalContentWidth(120)
      )
    );

    expect(visibleLength(stripAnsi(row))).toBeLessThanOrEqual(48);
    expect(row).toContain('line  42');
  });

  it('keeps edit preview output within narrow terminal widths', () => {
    const { sink, writes } = makeTerminalSink();
    const request = {
      path: '/Users/hope/ai-project/openhorse/src/very/long/path/example.ts',
      newString: 'const message = "replacement with a very long value";',
      kind: 'fuzzy' as const,
      strategy: 'levenshtein',
      candidates: [
        {
          index: 0,
          line: 42,
          match: 'const message = "这是一个非常长的中文匹配内容，需要按视觉宽度截断";',
          contextBefore: '',
          contextAfter: '',
          isReplaceAll: false,
        },
      ],
    };

    withStdoutColumns(48, () => sink.showEditPreview(request));

    const rows = stripAnsi(writes.join('')).split('\n').filter(Boolean);
    expect(rows.every(row => visibleLength(row) <= 48)).toBe(true);
    expect(stripAnsi(formatTerminalEditPreviewHeader(request, 48))).toContain('Edit Preview');
  });

  it('renders restored session markers as terminal status transcript entries', () => {
    const { sink, writes } = makeTerminalSink();

    sink.sessionRestored?.({
      sessionId: '2571b283-9c8b-4501-a86e-5d2256e6db73',
      projectPath: '/Users/hope/ai-project/openhorse',
      model: 'glm-5',
      restoredMessages: 58,
      messageCount: 72,
      summary: '继续 UI target implementation',
    });

    const output = stripAnsi(writes.join(''));
    expect(output).toContain('Resumed session 2571b283 · restored 58/72 messages');
    expect(output).toContain('Model: glm-5');
    expect(output).toContain('Project: /Users/hope/ai-project/openhorse');
    expect(output).toContain('Summary: 继续 UI target implementation');
    expect(output).not.toContain('› Resumed session');
  });

  it('renders compact checkpoint provenance and detailed restore counts', () => {
    const rendered = stripAnsi(
      formatTerminalSessionRestored({
        sessionId: '2571b283-9c8b-4501-a86e-5d2256e6db73',
        projectPath: '/Users/hope/ai-project/openhorse',
        model: 'glm-5',
        restoredMessages: 8,
        messageCount: 25,
        transcriptMessages: 20,
        summary: 'durable summary',
        summaryGeneratedAt: 123456789,
        summarySource: 'llm',
        summaryCoveredMessages: 25,
        checkpointId: 'checkpoint-1',
      })
    );

    expect(rendered).toContain('restored 8 model-context / 20 transcript messages');
    expect(rendered).toContain('(compact checkpoint)');
    expect(rendered).toContain('Covers: 25 source messages');
  });

  it('bounds restored session marker width and redacts summary secrets', () => {
    const rendered = withStdoutColumns(72, () =>
      formatTerminalSessionRestored({
        sessionId: 'abcdef0123456789',
        projectPath: '/Users/hope/very/long/project/path/that/should/be/truncated/openhorse',
        model: 'test-model',
        restoredMessages: 3,
        summary: 'Authorization: Bearer secret-token-123456 should not leak',
      })
    );
    const lines = stripAnsi(rendered).split('\n');

    expect(lines.every(line => visibleLength(line) <= 72)).toBe(true);
    expect(rendered).toContain('[REDACTED_SECRET]');
    expect(rendered).not.toContain('secret-token-123456');
  });

  it('does not print duplicate consecutive status messages', () => {
    const { sink, writes } = makeTerminalSink();

    sink.setStatus('Working: thinking');
    sink.setStatus('Working: thinking');
    sink.setStatus('Working: running 2 tools');

    const output = writes.join('');
    expect(output.match(/Working: thinking/g)).toHaveLength(1);
    expect(output).toContain('Working: running 2 tools');
  });

  it('formats terminal status lines within narrow terminal widths', () => {
    const status = withStdoutColumns(40, () =>
      formatTerminalStatusMessage(
        'Working: running 12 tools with a very long provider diagnostic status message',
        terminalContentWidth(120)
      )
    );

    expect(visibleLength(status)).toBeLessThanOrEqual(40);
    expect(status).toContain('...');
  });

  it('bounds emitted terminal status lines to the active terminal width', () => {
    const { sink, writes } = makeTerminalSink();

    withStdoutColumns(40, () => {
      sink.setStatus(
        'Working: running 12 tools with a very long provider diagnostic status message'
      );
    });

    const output = stripAnsi(writes.join('')).trim();
    expect(visibleLength(output)).toBeLessThanOrEqual(40);
    expect(output).toContain('...');
  });

  it('renders local terminal shortcuts without requiring the model', () => {
    const shortcuts = renderTerminalShortcuts();

    expect(shortcuts).toContain('Terminal shortcuts');
    expect(shortcuts).toContain('Ctrl+U');
    expect(shortcuts).toContain('/resume');
    expect(shortcuts).toContain('n/p');
    expect(shortcuts).toContain('/last-tool');
    expect(shortcuts).toContain('/trace');
  });

  it('uses compact shortcut help on narrow terminals', () => {
    const shortcuts = withStdoutColumns(50, () => renderTerminalShortcuts());
    const rows = stripAnsi(shortcuts).split('\n').filter(Boolean);

    expect(rows).not.toContain('Terminal shortcuts');
    expect(rows).toContain('Shortcuts');
    expect(rows).toHaveLength(7);
    expect(rows.every(row => visibleLength(row) <= 50)).toBe(true);
    expect(shortcuts).toContain('Ctrl+C');
    expect(shortcuts).toContain('Alt+Enter/Ctrl+J');
    expect(shortcuts).toContain('/last-tool');
    expect(shortcuts).toContain('/trace');
  });

  it('keeps shortcut help readable on very narrow terminals', () => {
    const shortcuts = withStdoutColumns(32, () => renderTerminalShortcuts());
    const rows = stripAnsi(shortcuts).split('\n').filter(Boolean);

    expect(rows).toHaveLength(7);
    expect(rows.every(row => visibleLength(row) <= 32)).toBe(true);
    expect(shortcuts).toContain('Enter');
    expect(shortcuts).toContain('Ctrl+J');
    expect(shortcuts).toContain('/resume');
  });

  it('formats terminal permission prompts with scope, cwd, risk, and options', () => {
    const prompt = withStdoutColumns(180, () =>
      formatTerminalPermissionPrompt(
        {
          id: 'perm-1',
          name: 'exec_command',
          args: {
            command: 'echo Authorization: Bearer secret-token-123456',
          },
          reason: 'Command execution needs approval',
        },
        '/tmp/openhorse-terminal-renderer'
      )
    );
    const rendered = stripAnsi(prompt);

    expect(visibleLength(rendered)).toBeLessThanOrEqual(180);
    expect(rendered).toContain('Allow tool exec_command?');
    expect(rendered).toContain('cmd=$ echo');
    expect(rendered).toContain('Authorization: [REDACTED_SECRET]');
    expect(rendered).toContain('cwd=/tmp/openhorse-terminal-renderer');
    expect(rendered).toContain('risk=low: Command execution needs approval');
    expect(rendered).toContain('[y=yes n=no]');
    expect(rendered).not.toContain('secret-token-123456');
  });

  it('formats path-oriented permission prompts without changing runtime policy', () => {
    const prompt = withStdoutColumns(120, () =>
      stripAnsi(
        formatTerminalPermissionPrompt(
          {
            id: 'perm-2',
            name: 'edit_file',
            args: { path: 'src/terminal-ui/launch.ts' },
          },
          '/repo'
        )
      )
    );

    expect(prompt).toContain('Allow tool edit_file?');
    expect(prompt).toContain('path=src/terminal-ui/launch.ts');
    expect(prompt).toContain('cwd=/repo');
    expect(prompt).toContain('risk=HIGH: approval required');
    expect(prompt).toContain('[y=yes n=no]');
  });

  it('bounds terminal permission prompts to the active terminal width', () => {
    for (const columns of [80, 60, 40, 24]) {
      const prompt = withStdoutColumns(columns, () =>
        stripAnsi(
          formatTerminalPermissionPrompt(
            {
              id: 'perm-width',
              name: 'exec_command',
              args: {
                command: `npm test -- --runInBand ${'very-long-argument '.repeat(8)}`,
              },
              reason: 'Command execution needs approval',
            },
            '/tmp/openhorse-terminal-renderer/with/a/very/long/path'
          )
        )
      );

      expect(visibleLength(prompt)).toBeLessThanOrEqual(columns);
      expect(prompt).toContain('[y=yes n=no]');
    }
  });

  it('does not overflow extremely narrow terminal permission prompts', () => {
    for (const columns of [18, 12, 10, 1]) {
      const prompt = withStdoutColumns(columns, () =>
        stripAnsi(
          formatTerminalPermissionPrompt(
            {
              id: 'perm-tiny-width',
              name: 'exec_command',
              args: {
                command: `npm test -- --runInBand ${'very-long-argument '.repeat(8)}`,
              },
              reason: 'Command execution needs approval',
            },
            '/tmp/openhorse-terminal-renderer/with/a/very/long/path'
          )
        )
      );

      expect(visibleLength(prompt)).toBeLessThanOrEqual(columns);
    }
  });
});

describe('terminal UI visual width helpers', () => {
  const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');

  afterEach(() => {
    if (originalColumns) {
      Object.defineProperty(process.stdout, 'columns', originalColumns);
    } else {
      delete (process.stdout as { columns?: number }).columns;
    }
  });

  function setStdoutColumns(columns: number | undefined): void {
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: columns,
    });
  }

  it('honors real narrow terminal widths while keeping a stable missing-width default', () => {
    setStdoutColumns(42);
    expect(terminalContentWidth(88)).toBe(42);

    setStdoutColumns(undefined);
    expect(terminalContentWidth(50)).toBe(60);
    expect(terminalContentWidth(88)).toBe(88);
  });

  it('counts CJK and emoji by terminal cell width instead of UTF-16 length', () => {
    expect(visibleLength('abc')).toBe(3);
    expect(visibleLength('开源')).toBe(4);
    expect(visibleLength('\x1b[36m开源\x1b[0m')).toBe(4);
    expect(visibleLength('小马🐎')).toBeGreaterThan('小马🐎'.length - 1);
  });

  it('truncates long terminal text without exceeding the requested visual width', () => {
    const truncated = truncateTerminalText('项目路径/开源小马/非常非常长的目录名', 16);

    expect(visibleLength(truncated)).toBeLessThanOrEqual(16);
    expect(truncated.endsWith('...')).toBe(true);
  });
});

describe('raw terminal editor', () => {
  it('keeps CJK input in its buffer and deletes one grapheme with Backspace', () => {
    const { editor } = makeRawEditor();
    editor.setPrompt('› ');

    editor.feed(Buffer.from('开源小？事收到', 'utf8'));
    expect(editor.getBuffer().value).toBe('开源小？事收到');

    editor.feed(Buffer.from('\x7f'));
    expect(editor.getBuffer().value).toBe('开源小？事收');
  });

  it('restores the current input after external assistant output', () => {
    const { editor, writes } = makeRawEditor();
    editor.setPrompt('› ');
    editor.feed(Buffer.from('输入中事地方', 'utf8'));

    editor.writeExternal('assistant chunk');

    const output = writes.join('');
    expect(output).toContain('assistant chunk\n');
    expect(output).toContain('› 输入中事地方');
  });

  it('redraws the current input when the terminal is resized', () => {
    const { editor, output, writes, emitResize } = makeRawEditor();
    editor.start();
    editor.setPrompt('› ');
    editor.feed(Buffer.from('abcdefghijklmnopqrstuvwxyz', 'utf8'));
    writes.length = 0;

    output.columns = 18;
    emitResize();

    const resized = writes.join('');
    expect(editor.getBuffer().value).toBe('abcdefghijklmnopqrstuvwxyz');
    expect(resized).toContain('› ');
    expect(resized).toContain('‹');

    writes.length = 0;
    editor.stop();
    output.columns = 80;
    emitResize();

    expect(writes.join('')).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('submits the current buffer on Enter and clears it', () => {
    const submitted: string[] = [];
    const { editor } = makeRawEditor({ onSubmit: input => submitted.push(input) });
    editor.setPrompt('› ');

    editor.feed(Buffer.from('hello\r'));

    expect(submitted).toEqual(['hello']);
    expect(editor.getBuffer().value).toBe('');
  });

  it('keeps bracketed multiline paste in the buffer and submits it once', () => {
    const submitted: string[] = [];
    const notices: string[] = [];
    const { editor, writes } = makeRawEditor({
      onSubmit: input => submitted.push(input),
      onNotice: message => notices.push(message),
    });
    editor.setPrompt('› ');

    editor.feed(Buffer.from('\x1b[200~first line\nsecond line\x1b[201~', 'utf8'));

    expect(submitted).toEqual([]);
    expect(editor.getBuffer().value).toBe('first line\nsecond line');
    expect(stripAnsi(writes.join(''))).toContain('› first line\r\n  second line');
    expect(notices).toEqual(['Pasted 2 lines. Enter sends once; Ctrl+U clears.']);

    editor.feed(Buffer.from('\r'));

    expect(submitted).toEqual(['first line\nsecond line']);
    expect(editor.getBuffer().value).toBe('');
  });

  it('inserts real newlines with Alt+Enter and submits the full buffer with Enter', () => {
    const submitted: string[] = [];
    const { editor, writes } = makeRawEditor({ onSubmit: input => submitted.push(input) });
    editor.setPrompt('› ');

    editor.feed(Buffer.from('first line\x1b\rsecond line', 'utf8'));

    expect(submitted).toEqual([]);
    expect(editor.getBuffer().value).toBe('first line\nsecond line');
    expect(stripAnsi(writes.join(''))).toContain('› first line\r\n  second line');

    editor.feed(Buffer.from('\r'));
    expect(submitted).toEqual(['first line\nsecond line']);
  });

  it('inserts a newline when Escape and Enter arrive in separate chunks', () => {
    const { editor } = makeRawEditor();
    editor.setPrompt('› ');

    editor.feed(Buffer.from('first'));
    editor.feed(Buffer.from('\x1b'));
    editor.feed(Buffer.from('\r'));
    editor.feed(Buffer.from('second'));

    expect(editor.getBuffer().value).toBe('first\nsecond');
  });

  it('uses Ctrl+J as a newline without submitting', () => {
    const submitted: string[] = [];
    const { editor } = makeRawEditor({ onSubmit: input => submitted.push(input) });
    editor.setPrompt('› ');

    editor.feed(Buffer.from('first\nsecond'));

    expect(submitted).toEqual([]);
    expect(editor.getBuffer().value).toBe('first\nsecond');
  });

  it('navigates logical lines with arrows and keeps Home/End line-local', () => {
    const { editor } = makeRawEditor();
    editor.setPrompt('› ');
    editor.feed(Buffer.from('\x1b[200~abcd\nxy\n12345\x1b[201~'));

    editor.feed(Buffer.from('\x1b[A'));
    expect(editor.getBuffer().cursor).toBe(7);
    editor.feed(Buffer.from('\x1b[A'));
    expect(editor.getBuffer().cursor).toBe(2);
    editor.feed(Buffer.from('\x1b[B'));
    expect(editor.getBuffer().cursor).toBe(7);
    editor.feed(Buffer.from('\x1b[H'));
    expect(editor.getBuffer().cursor).toBe(5);
    editor.feed(Buffer.from('\x1b[F'));
    expect(editor.getBuffer().cursor).toBe(7);
  });

  it('keeps large single-line input bounded and visible without throwing', () => {
    const notices: string[] = [];
    const { editor, writes } = makeRawEditor({ onNotice: notice => notices.push(notice) });
    editor.setPrompt('› ');
    writes.length = 0;

    // v0.2.23: 256 KiB hard limit in UTF-8 bytes. For ASCII, 256 KiB = 262,144 chars.
    expect(() => editor.feed(Buffer.from('x'.repeat(300_000)))).not.toThrow();

    const buf = editor.getBuffer();
    expect(Buffer.byteLength(buf.value, 'utf8')).toBeLessThanOrEqual(256 * 1024);
    expect(writes.join('').length).toBeLessThan(500);
    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(notices.some(n => n.includes('/edit'))).toBe(true);
  });

  it('limits multiline rendering to a stable viewport', () => {
    const { editor, writes } = makeRawEditor();
    editor.setPrompt('› ');
    writes.length = 0;

    const value = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
    editor.feed(Buffer.from(`\x1b[200~${value}\x1b[201~`, 'utf8'));

    const rendered = stripAnsi(writes.join(''));
    expect(editor.getBuffer().value).toBe(value);
    expect((rendered.match(/\r\n/g) ?? [])).toHaveLength(5);
    expect(rendered).toContain('line 19');
  });

  it('keeps split bracketed paste chunks inside the parser before applying paste heuristics', () => {
    const submitted: string[] = [];
    const notices: string[] = [];
    const { editor } = makeRawEditor({
      onSubmit: input => submitted.push(input),
      onNotice: message => notices.push(message),
    });
    editor.setPrompt('› ');

    editor.feed(Buffer.from('\x1b[200~', 'utf8'));
    editor.feed(Buffer.from('first line\nsecond line', 'utf8'));

    expect(editor.getBuffer().value).toBe('');
    expect(notices).toEqual([]);

    editor.feed(Buffer.from('\x1b[201~', 'utf8'));

    expect(submitted).toEqual([]);
    expect(editor.getBuffer().value).toBe('first line\nsecond line');
    expect(notices).toEqual(['Pasted 2 lines. Enter sends once; Ctrl+U clears.']);
  });

  it('treats unbracketed multiline paste chunks as one buffer insert', () => {
    const submitted: string[] = [];
    const notices: string[] = [];
    const { editor } = makeRawEditor({
      onSubmit: input => submitted.push(input),
      onNotice: message => notices.push(message),
    });
    editor.setPrompt('› ');

    editor.feed(Buffer.from('one\ntwo\nthree', 'utf8'));

    expect(submitted).toEqual([]);
    expect(editor.getBuffer().value).toBe('one\ntwo\nthree');
    expect(notices).toEqual(['Pasted 3 lines. Enter sends once; Ctrl+U clears.']);

    editor.feed(Buffer.from('\r'));

    expect(submitted).toEqual(['one\ntwo\nthree']);
  });

  it('suggests editor mode for very long pasted drafts', () => {
    const notices: string[] = [];
    const { editor } = makeRawEditor({ onNotice: message => notices.push(message) });
    editor.setPrompt('› ');

    editor.feed(
      Buffer.from(Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n'), 'utf8')
    );

    expect(notices[0]).toContain('Pasted 20 lines');
    expect(notices[0]).toContain('/edit is better');
  });

  it('shows completion candidates when Tab has no unique completion', () => {
    const notices: string[] = [];
    const { editor } = makeRawEditor({ onNotice: message => notices.push(message) });
    editor.setPrompt('› ');

    editor.feed(Buffer.from('/s\t'));

    expect(editor.getBuffer().value).toBe('/s');
    expect(notices.join('\n')).toContain('Completions:');
    expect(notices.join('\n')).toContain('/status');
  });
});

describe('terminal UI multiline composer', () => {
  it('submits explicit /paste blocks when /end is received', () => {
    const composer = new TerminalInputComposer();

    expect(composer.receive('/paste').input).toBeUndefined();
    expect(composer.isActive()).toBe(true);
    expect(composer.prompt('› ')).toContain('[paste 1L]');
    expect(composer.receive('第一行').input).toBeUndefined();
    expect(composer.prompt('› ')).toContain('[paste 2L]');
    expect(composer.receive('second line').input).toBeUndefined();
    expect(composer.prompt('› ')).toContain('[paste 3L]');

    expect(composer.receive('/end')).toEqual({ input: '第一行\nsecond line' });
    expect(composer.isActive()).toBe(false);
  });

  it('cancels explicit multiline input without submitting content', () => {
    const composer = new TerminalInputComposer();

    composer.receive('/paste');
    composer.receive('draft');

    const result = composer.receive('/cancel');
    expect(result.cancelled).toBe(true);
    expect(result.input).toBeUndefined();
    expect(composer.isActive()).toBe(false);
  });

  it('submits backslash continuations as one multiline input', () => {
    const composer = new TerminalInputComposer();

    expect(composer.receive('line one\\').input).toBeUndefined();
    expect(composer.isActive()).toBe(true);
    expect(composer.receive('line two')).toEqual({ input: 'line one\nline two' });
    expect(composer.isActive()).toBe(false);
  });

  it('passes normal single-line input through', () => {
    const composer = new TerminalInputComposer();

    expect(composer.receive('/help')).toEqual({ input: '/help' });
  });
});

describe('terminal UI edit command parsing', () => {
  it('detects /edit and optional initial content', () => {
    expect(parseEditInput('/edit')).toEqual({ isEdit: true, initialContent: '' });
    expect(parseEditInput('   /edit write a plan')).toEqual({
      isEdit: true,
      initialContent: 'write a plan',
    });
  });

  it('does not treat similar commands as editor mode', () => {
    expect(parseEditInput('/editor')).toEqual({ isEdit: false, initialContent: '' });
    expect(parseEditInput('/editors hello')).toEqual({ isEdit: false, initialContent: '' });
  });
});

describe('terminal UI readline completion', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orion-code-terminal-completion-'));
    mkdirSync(join(tempDir, 'src'));
    mkdirSync(join(tempDir, 'docs'));
    writeFileSync(join(tempDir, 'src', 'terminal.ts'), '');
    writeFileSync(join(tempDir, 'docs', 'plan.md'), '');
    writeFileSync(join(tempDir, '.hidden'), '');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('completes visible slash commands with a trailing space', () => {
    const [matches, token] = completeSlashCommand('/mod');

    expect(token).toBe('/mod');
    expect(matches).toContain('/model ');
  });

  it('does not try slash completion after command arguments begin', () => {
    const [matches] = completeSlashCommand('/resume abc');

    expect(matches).toEqual([]);
  });

  it('completes @ file mentions in chat text', () => {
    const [matches, token] = completeFileMention('read @src/ter', tempDir);

    expect(token).toBe('read @src/ter');
    expect(matches).toEqual(['read @src/terminal.ts ']);
  });

  it('completes @ directories with a slash and ignores hidden files', () => {
    const [matches] = completeFileMention('open @', tempDir);

    expect(matches).toContain('open @src/');
    expect(matches).toContain('open @docs/');
    expect(matches.some(item => item.includes('.hidden'))).toBe(false);
  });

  it('creates one readline completer for slash and file paths', () => {
    const completer = createTerminalCompleter(tempDir);

    expect(completer('/stat')[0]).toContain('/status ');
    expect(completer('look @docs/pl')[0]).toEqual(['look @docs/plan.md ']);
  });

  it('applies tab completion when a cooked terminal passes tab through as text', () => {
    expect(applyTerminalTabCompletion('/stat\t', tempDir)).toBe('/status ');
    expect(applyTerminalTabCompletion('look @docs/pl\t', tempDir)).toBe('look @docs/plan.md ');
  });

  it('returns completion candidates for ambiguous terminal Tab', () => {
    const result = applySingleTerminalTabCompletion('/s', tempDir);

    expect(result.changed).toBe(false);
    expect(result.matches).toContain('/status ');
  });

  it('uses the common prefix for ambiguous tab completion', () => {
    expect(applyTerminalTabCompletion('/s\t', tempDir)).toBe('/s');
  });
});
