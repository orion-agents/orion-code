import { marked } from 'marked';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Task, TaskResult } from '../src/core/agent';
import { Harness, MemorySystem, init } from '../src/init';
import {
  Markdown,
  decodeHtmlEntities,
  markdownBlockTypes,
} from '../src/ink-ui/components/Markdown';
import { PixelHorseBanner } from '../src/ink-ui/components/PixelHorseBanner';
import { SelectList } from '../src/ink-ui/components/SelectList';
import { StatusLine } from '../src/ink-ui/components/StatusLine';
import {
  editPreviewItems,
  editPreviewTitle,
  getFileQuery,
  isMultilinePasteValue,
  normalizePastedInput,
  permissionItems,
  sessionItems,
  visibleCommandItems,
  visibleFileItems,
} from '../src/ink-ui/screens/ReplScreen';
import {
  Transcript,
  TranscriptEntryBlock,
  renderTranscriptEntryText,
} from '../src/ink-ui/components/Transcript';
import {
  ToolActivityBlock,
  formatToolActivityLine,
  parseToolActivity,
  truncateVisual,
  type ParsedToolActivity,
} from '../src/ink-ui/components/ToolActivity';
import type { OrionCodeUiRuntime, TranscriptEntry } from '../src/ink-ui/types';
import { mcpManager } from '../src/tools/mcp';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'coverage task',
    description: 'exercise harness branches',
    priority: 'P1',
    status: 'pending',
    ...overrides,
  } as Task;
}

function result(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    success: true,
    output: 'ok',
    duration: 1,
    ...overrides,
  } as TaskResult;
}

function transcriptEntry(
  role: TranscriptEntry['role'],
  content: string,
  extra: Partial<TranscriptEntry> = {}
): TranscriptEntry {
  return { id: `${role}-${content}`, role, content, ...extra };
}

function fakeUiRuntime(
  options: {
    configured?: boolean;
    cwd?: string;
    currentModel?: string;
    configModel?: string;
    tokenUsage?: { promptTokens: number; completionTokens: number } | null;
    sessionId?: string;
  } = {}
): OrionCodeUiRuntime {
  const currentModel = options.currentModel ?? 'deepseek-v4';
  const configModel = options.configModel ?? 'fallback-model';
  return {
    cwd: options.cwd ?? '/tmp/orion-project',
    version: '0.1.2',
    isConfigured: options.configured ?? true,
    config: { model: configModel },
    store: {
      getSnapshot: () => ({
        currentModel,
        config: { model: configModel },
        tokenUsage: options.tokenUsage ?? null,
      }),
    },
    getSession: () =>
      options.sessionId
        ? ({ id: options.sessionId } as ReturnType<OrionCodeUiRuntime['getSession']>)
        : null,
  } as unknown as OrionCodeUiRuntime;
}

describe('init branch coverage', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('Harness covers blocked, whitelist, malformed and post-validation paths', () => {
    const defaults = new Harness();
    expect(defaults.preCheck(task())).toEqual({ passed: true, stage: 'pre-exec' });
    expect(defaults.preCheck(task({ params: { actions: 'not-an-array' } }))).toEqual({
      passed: true,
      stage: 'pre-exec',
    });
    expect(defaults.preCheck(task({ params: { actions: ['safe', 1] } }))).toEqual({
      passed: true,
      stage: 'pre-exec',
    });
    expect(defaults.preCheck(task({ params: { actions: ['eval', 'read'] } }))).toMatchObject({
      passed: false,
      reason: 'Blocked actions detected: eval',
    });

    const whitelist = new Harness({
      allowedActions: ['read'],
      blockedActions: [],
      timeout: 10,
    });
    expect(whitelist.preCheck(task({ params: { actions: ['read'] } })).passed).toBe(true);
    expect(whitelist.preCheck(task({ params: { actions: ['write'] } }))).toMatchObject({
      passed: false,
      reason: 'Actions not in whitelist: write',
    });
    expect(whitelist.preCheck(task({ params: { actions: [1] } })).passed).toBe(true);
    expect(whitelist.postValidate(result({ duration: 11 }), task())).toMatchObject({
      passed: false,
      reason: 'Execution exceeded timeout: 11ms > 10ms',
    });
    expect(whitelist.postValidate(result({ duration: 0 }), task()).passed).toBe(true);
    expect(
      new Harness({ resultValidation: false }).postValidate(result({ duration: 999 }), task())
        .passed
    ).toBe(true);
    expect(whitelist.getConfig()).toMatchObject({ allowedActions: ['read'], blockedActions: [] });
  });

  test('MemorySystem covers promotion, eviction, search, touch and clear paths', () => {
    const memory = new MemorySystem({ workingCapacity: 1, shortTermCapacity: 1 });
    const writeEvents: unknown[] = [];
    const evictedEvents: unknown[] = [];
    memory.on('write', event => writeEvents.push(event));
    memory.on('evicted', event => evictedEvents.push(event));

    const first = memory.writeToWorking({ text: 'Alpha' }, ['one']);
    memory.readWorking();
    memory.readWorking();
    memory.readWorking();
    const second = memory.writeToWorking({ text: 'Beta' }, ['two']);
    expect(memory.readShortTerm().map(entry => entry.id)).toContain(first.id);

    const third = memory.writeToShortTerm({ text: 'Gamma' }, ['three']);
    expect(memory.readLongTerm(first.id)).toMatchObject({ id: first.id });
    expect(memory.readLongTerm('missing')).toBeUndefined();
    const fourth = memory.writeToLongTerm({ text: 'Delta' }, ['four']);

    expect(memory.search('beta').map(entry => entry.id)).toContain(second.id);
    expect(memory.search('three', 'short-term').map(entry => entry.id)).toContain(third.id);
    expect(memory.search('four', 'long-term').map(entry => entry.id)).toContain(fourth.id);
    expect(memory.search('not-present')).toEqual([]);
    expect(memory.getStatus()).toEqual({ working: 1, 'short-term': 1, 'long-term': 2 });

    memory.clearWorking();
    expect(memory.readWorking()).toEqual([]);
    expect(memory.getStatus()['short-term']).toBe(1);
    expect(writeEvents.length).toBeGreaterThanOrEqual(4);
    expect(evictedEvents.length).toBeGreaterThanOrEqual(2);
  });

  test('init merges every config group, registers known agents and skips unknown agents', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const runtime = await init({
      name: 'coverage-runtime',
      mode: 'test',
      logLevel: 'debug',
      brain: { strategy: 'fifo', maxConcurrent: 2 },
      harness: {
        goalConstraint: true,
        maxSteps: 10,
        boundaryCheck: true,
        allowedActions: ['read'],
        blockedActions: ['danger'],
        resultValidation: true,
        sandbox: false,
        timeout: 5,
      },
      memory: { workingCapacity: 2, shortTermCapacity: 2, longTermBackend: 'memory' },
      safety: { enabled: true, policy: { blocked: ['danger'] } },
      agents: [{ type: 'leader' }, { type: 'coder' }, { type: 'unknown-agent' }],
    });

    expect(runtime.config).toMatchObject({
      name: 'coverage-runtime',
      mode: 'test',
      logLevel: 'debug',
      brain: { strategy: 'fifo', maxConcurrent: 2 },
    });
    expect(runtime.agents).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unknown agent type'));

    await runtime.start();
    runtime.agents[0].emit('task-started', task({ params: { actions: ['danger'] } }));
    runtime.agents[0].emit('task-started', task({ params: { actions: ['read'] } }));
    runtime.agents[0].emit('task-completed', {
      task: task(),
      result: result({ duration: 10 }),
    });
    runtime.agents[0].emit('task-completed', { task: task(), result: result({ duration: 1 }) });
    runtime.agents[0].emit('task-failed', { task: task(), error: 'boom' });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Harness blocked task'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Harness validation failed'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Task "coverage task" failed'));
    expect(runtime.memory.search('task-completed', 'short-term')).not.toHaveLength(0);

    await runtime.shutdown();
    expect(runtime.memory.getStatus().working).toBe(0);
  });

  test('init default configuration and empty agent registry remain startable', async () => {
    const defaultRuntime = await init({ agents: [] });
    expect(defaultRuntime.config.name).toBe('orion-code');
    await defaultRuntime.start();
    await defaultRuntime.shutdown();
  });
});

describe('legacy Ink pure component branch coverage', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('Markdown handles entity variants and all common block/inline token families', () => {
    expect(decodeHtmlEntities('&amp; &apos; &gt; &lt; &nbsp; &quot;')).toBe('& \' > <   "');
    expect(decodeHtmlEntities('&#65; &#x41; &#X42;')).toBe('A A &#X42;');
    expect(decodeHtmlEntities('&#x110000; &#-1; &unknown;')).toBe('&#x110000; &#-1; &unknown;');

    const markdown = [
      '# Heading **bold** _em_ `code` [link](https://example.com)',
      '',
      'Paragraph ~~deleted~~  ',
      'next line',
      '',
      '> quoted **text**',
      '',
      '1. first',
      '2. second',
      '',
      '- bullet',
      '  - nested',
      '',
      '| A | B |',
      '|---|---|',
      '| long value | 2 |',
      '',
      '```diff',
      '+added',
      '-removed',
      '@@ context',
      'plain',
      '```',
      '',
      '---',
      '',
      '<span>html</span>',
    ].join('\n');

    expect(markdownBlockTypes(markdown)).toEqual(
      expect.arrayContaining(['heading', 'paragraph', 'blockquote', 'list', 'table', 'code'])
    );
    const rendered = Markdown({ children: markdown, width: 24 });
    expect(rendered.type).toBeDefined();
    expect(Markdown({ children: '***', width: 12 }).type).toBeDefined();
    expect(Markdown({ children: '<div>html</div>', width: 12 }).type).toBeDefined();
    expect(Markdown({ children: '   \n', width: 12 }).type).toBeDefined();

    const lexer = jest.spyOn(marked, 'lexer').mockImplementationOnce(() => {
      throw new Error('lexer failed');
    });
    expect(Markdown({ children: 'fallback', width: 8 }).type).toBeDefined();
    expect(lexer).toHaveBeenCalled();
  });

  test('tool activity parsing, formatting and rendering cover every state and error path', () => {
    expect(parseToolActivity('')).toBeNull();
    expect(parseToolActivity('not activity')).toBeNull();
    expect(parseToolActivity('Queued bash waiting')).toMatchObject({
      state: 'queued',
      detail: 'waiting',
    });
    expect(parseToolActivity('Running read_file')).toMatchObject({ state: 'running', detail: '' });
    expect(parseToolActivity('Skipped lint disabled')).toMatchObject({ state: 'skipped' });
    expect(parseToolActivity('Requested publish approval')).toMatchObject({ state: 'requested' });
    expect(parseToolActivity('✓ test all green (25ms)')).toMatchObject({
      state: 'success',
      duration: '25ms',
      detail: 'all green',
    });
    expect(parseToolActivity('✗ build failed\nError: compiler error')).toMatchObject({
      state: 'error',
      error: 'compiler error',
    });

    const states: ParsedToolActivity['state'][] = [
      'queued',
      'running',
      'success',
      'error',
      'skipped',
      'requested',
    ];
    for (const state of states) {
      expect(
        formatToolActivityLine(
          {
            state,
            name: 'tool',
            detail: 'detail',
            duration: '1ms',
            seq: 2,
            artifactHint: 'artifact',
          },
          120
        )
      ).toContain('tool');
    }
    expect(truncateVisual('abcdef', 10)).toBe('abcdef');
    expect(truncateVisual('abcdef', 0)).toBe('');
    expect(truncateVisual('abcdef', 2)).toBe('ab');
    expect(truncateVisual('abcdef', 5)).toBe('ab...');

    expect(
      ToolActivityBlock({ entry: transcriptEntry('tool', 'not activity'), width: 20 })
    ).toBeNull();
    expect(
      ToolActivityBlock({
        entry: transcriptEntry('tool', '', {
          toolActivity: { state: 'error', name: 'bash', detail: 'failed', error: 'boom' },
        }),
        width: 10,
      })?.type
    ).toBeDefined();
    expect(
      ToolActivityBlock({ entry: transcriptEntry('tool', 'Running read_file path'), width: 80 })
        ?.type
    ).toBeDefined();
  });

  test('transcript text and component projections cover every role and visibility branch', () => {
    const entries = [
      transcriptEntry('user', 'hello\n世界'),
      transcriptEntry('command', '/status'),
      transcriptEntry('assistant', '**answer**'),
      transcriptEntry('system', 'system'),
      transcriptEntry('status', 'working'),
      transcriptEntry('tool', 'plain tool output'),
      transcriptEntry('error', 'plain failure'),
      transcriptEntry('tool', '✓ bash done'),
    ];

    for (const entry of entries) {
      expect(renderTranscriptEntryText(entry, 8)).toEqual(expect.any(String));
      expect(TranscriptEntryBlock({ entry, width: 8 })?.type).toBeDefined();
    }
    expect(renderTranscriptEntryText(transcriptEntry('assistant', ''), 1)).toBe(' ');
    expect(Transcript({ entries, maxItems: 3, width: 20 }).type).toBeDefined();
    expect(Transcript({ entries, width: 20 }).type).toBeDefined();
    expect(Transcript({ entries: [], emptyMessage: 'ready' }).type).toBeDefined();
    expect(Transcript({ entries: [], emptyMessage: null }).type).toBeDefined();
  });

  test('banner covers compact/wide, configured/unconfigured, session/token and MCP variants', () => {
    const status = jest.spyOn(mcpManager, 'getStatus');
    status.mockReturnValue([]);
    expect(PixelHorseBanner({ runtime: fakeUiRuntime(), width: 40 }).type).toBeDefined();

    status.mockReturnValue([
      { name: 'one', connected: true, toolCount: 2, dead: false },
      { name: 'two', connected: false, toolCount: 0, dead: true },
    ]);
    expect(
      PixelHorseBanner({
        runtime: fakeUiRuntime({
          configured: false,
          cwd: '/',
          currentModel: '',
          tokenUsage: { promptTokens: 900, completionTokens: 100 },
          sessionId: '12345678-aaaa-bbbb-cccc-123456789000',
        }),
        width: 120,
      }).type
    ).toBeDefined();
    expect(PixelHorseBanner({ runtime: fakeUiRuntime(), width: 81 }).type).toBeDefined();
  });

  test('status line covers running, error, sizing and right-side fallback paths', () => {
    const status = jest.spyOn(mcpManager, 'getStatus');
    status.mockReturnValue([]);
    expect(
      StatusLine({ runtime: fakeUiRuntime(), running: true, statusMessage: 'thinking', width: 12 })
        .type
    ).toBeDefined();

    status.mockReturnValue([{ name: 'one', connected: true, toolCount: 2, dead: false }]);
    const runtime = fakeUiRuntime({
      tokenUsage: { promptTokens: 1000, completionTokens: 500 },
      sessionId: 'abcdefgh-aaaa-bbbb-cccc-123456789000',
    });
    expect(
      StatusLine({ runtime, running: false, statusMessage: 'ready', width: 160 }).type
    ).toBeDefined();
    expect(
      StatusLine({ runtime, running: false, errorLayer: 'provider', statusMessage: '', width: 30 })
        .type
    ).toBeDefined();
    expect(StatusLine({ runtime, running: false, width: 45 }).type).toBeDefined();
  });

  test('ReplScreen picker helpers cover empty, optional and populated paths', () => {
    expect(visibleCommandItems('/')).not.toHaveLength(0);
    expect(visibleCommandItems('/definitely-not-a-command')).toEqual([]);
    expect(getFileQuery('no mention')).toBeNull();
    expect(visibleFileItems('/tmp', 'no mention')).toEqual([]);

    const dir = mkdtempSync(join(tmpdir(), 'orion-ink-branches-'));
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'one.ts'), '');
      expect(visibleFileItems(dir, '@src/o').map(item => item.value)).toContain('src/one.ts');
      expect(visibleFileItems(dir, '@missing')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const baseSession = {
      id: '12345678-aaaa-bbbb-cccc-123456789000',
      projectPath: '/tmp/project',
      model: 'model',
      startTime: 1,
      tokenCount: 0,
      cost: 0,
    };
    const rows = sessionItems({
      title: 'sessions',
      showProject: true,
      sessions: [
        { ...baseSession, name: 'named', messageCount: 2, historySizeBytes: 1024 },
        { ...baseSession, id: '87654321-a', taskSummary: 'summary' },
        { ...baseSession, id: 'abcdefgh-a' },
      ],
    });
    expect(rows[0].description).toContain('/tmp/project');
    expect(rows[0].label).toContain('named');
    expect(rows[1].label).toContain('summary');
    expect(rows[2].label).toContain('(untitled)');
    expect(
      sessionItems({ title: 'sessions', sessions: [{ ...baseSession }] })[0].description
    ).not.toContain('/tmp/project');

    expect(permissionItems({ id: 'p', name: 'bash', args: {}, reason: '' })).toHaveLength(4);
    const preview = {
      path: '/tmp/file.ts',
      newString: 'replacement',
      kind: 'exact' as const,
      candidates: [
        {
          index: 0,
          line: 3,
          match: 'old',
          contextBefore: 'before',
          contextAfter: 'after',
          isReplaceAll: false,
        },
        {
          index: 1,
          line: 9,
          match: 'other',
          contextBefore: '',
          contextAfter: '',
          isReplaceAll: true,
        },
      ],
    };
    expect(editPreviewTitle(preview)).toContain('file.ts');
    expect(editPreviewItems(preview)).toHaveLength(2);

    expect(normalizePastedInput('\x1b[200~a\r\nb\r\x1b[201~')).toBe('a\nb\n');
    expect(normalizePastedInput('[200~x[201~')).toBe('x');
    expect(isMultilinePasteValue(undefined)).toBe(false);
    expect(isMultilinePasteValue('')).toBe(false);
    expect(isMultilinePasteValue('\n')).toBe(false);
    expect(isMultilinePasteValue('a\nb')).toBe(true);
  });

  test('SelectList covers empty, paged, compact and optional item branches', () => {
    expect(
      SelectList({
        title: 'A title that must be shortened',
        items: [],
        selectedIndex: -10,
        emptyText: 'Nothing here and this label is intentionally long',
        footer: 'A footer that must also be shortened',
        width: 8,
      }).type
    ).toBeDefined();

    const items = Array.from({ length: 6 }, (_, index) => ({
      value: `item-${index}`,
      label: index === 4 ? '献户座长标签✨'.repeat(3) : `item ${index}`,
      description: index % 2 === 0 ? `description ${index}` : undefined,
    }));
    expect(
      SelectList({
        title: 'Paged',
        items,
        selectedIndex: 99,
        maxVisibleItems: 3,
        width: 18,
      }).type
    ).toBeDefined();
    expect(
      SelectList({
        title: 'All visible',
        items: items.slice(0, 2),
        selectedIndex: -1,
        maxVisibleItems: 10,
        width: 80,
      }).type
    ).toBeDefined();
    expect(
      SelectList({
        title: 'Zero window',
        items: items.slice(0, 1),
        selectedIndex: 0,
        maxVisibleItems: 0,
      }).type
    ).toBeDefined();
  });
});
