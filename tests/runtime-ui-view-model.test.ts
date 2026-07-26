import {
  createCommandPickerState,
  createEditPreviewPickerState,
  createFilePickerState,
  createModelPickerState,
  createPermissionPromptState,
  createPermissionDecisionPickerState,
  createPromptState,
  createRuntimeCapabilitySummary,
  createSessionRestoredView,
  createSessionPickerState,
  createStatusSnapshot,
  contextUsageStatusText,
  formatToolActivityTranscript,
  getFileMentionQuery,
  movePickerPageOffset,
  permissionRiskDisplayValue,
  permissionScopeDisplayValue,
  rendererCapabilityLabels,
  rendererStatus,
  sessionPickerTitle,
  toolActivityBatchLabel,
  toolActivityFromFinished,
  toolActivityFromStarted,
  transcriptEntryToBlock,
} from '../src/runtime/ui-view-model';
import type {
  RuntimeToolFinishedEvent,
  RuntimeToolStartedEvent,
  TranscriptEntry,
} from '../src/runtime/ui-events';
import type { SlashCommand } from '../src/commands/types';

describe('runtime UI view model', () => {
  function command(command: Partial<SlashCommand> & Pick<SlashCommand, 'name'>): SlashCommand {
    return {
      description: `${command.name} description`,
      type: 'builtin',
      execute: jest.fn(),
      ...command,
    };
  }

  it('creates renderer-neutral command picker state with labels and category descriptions', () => {
    const state = createCommandPickerState({
      input: '/',
      commands: [
        command({ name: 'status', aliases: ['s'], category: 'diagnostics' }),
        command({ name: 'resume', argumentHint: '[session]', category: 'session' }),
      ],
    });

    expect(state).toMatchObject({
      kind: 'command',
      title: 'Commands',
      totalItems: 2,
      visibleStart: 0,
      visibleLimit: 2,
      page: 1,
      pageCount: 1,
      hasPreviousPage: false,
      hasNextPage: false,
    });
    expect(
      state.visibleItems.map(item => ({
        value: item.value,
        label: item.label,
        description: item.description,
        categoryLabel: item.categoryLabel,
        aliases: item.aliases,
        matchRank: item.matchRank,
      }))
    ).toEqual([
      {
        value: 'status',
        label: '/status (s)',
        description: 'Diagnostics  status description',
        categoryLabel: 'Diagnostics',
        aliases: ['s'],
        matchRank: 0,
      },
      {
        value: 'resume',
        label: '/resume [session]',
        description: 'Session  resume description',
        categoryLabel: 'Session',
        aliases: [],
        matchRank: 0,
      },
    ]);
  });

  it('filters and ranks command picker matches by name and alias', () => {
    const state = createCommandPickerState({
      input: '/s',
      commands: [
        command({ name: 'resume', aliases: ['s'] }),
        command({ name: 'status', aliases: ['stat'] }),
        command({ name: 'sessions' }),
        command({ name: 'help' }),
      ],
    });

    expect(
      state.visibleItems.map(item => ({
        value: item.value,
        rank: item.matchRank,
      }))
    ).toEqual([
      { value: 'resume', rank: 1 },
      { value: 'status', rank: 2 },
      { value: 'sessions', rank: 2 },
    ]);
  });

  it('pages command picker state and supports custom category labels', () => {
    const commands = Array.from({ length: 4 }, (_, index) =>
      command({ name: `cmd${index + 1}`, category: index === 0 ? 'tools' : 'system' })
    );
    const first = createCommandPickerState({
      title: 'Slash Commands',
      input: '/',
      commands,
      maxVisibleItems: 2,
      categoryLabel: category => `category:${category ?? 'system'}`,
    });
    const second = createCommandPickerState({
      title: 'Slash Commands',
      input: '/',
      commands,
      maxVisibleItems: 2,
      visibleStart: movePickerPageOffset(first, 1),
      categoryLabel: category => `category:${category ?? 'system'}`,
    });

    expect(first).toMatchObject({
      title: 'Slash Commands',
      visibleStart: 0,
      visibleLimit: 2,
      page: 1,
      pageCount: 2,
      hasNextPage: true,
    });
    expect(first.visibleItems[0].description).toBe('category:tools  cmd1 description');
    expect(second.visibleItems.map(item => item.value)).toEqual(['cmd3', 'cmd4']);
    expect(second.hasPreviousPage).toBe(true);
    expect(second.hasNextPage).toBe(false);
  });

  it('creates renderer-neutral prompt state with clamped cursor and line context', () => {
    const prompt = createPromptState({
      value: 'one\ntwo\nthree',
      cursor: 6,
      running: true,
      modeText: 'plan mode on',
    });

    expect(prompt).toMatchObject({
      value: 'one\ntwo\nthree',
      cursor: 6,
      modeText: 'plan mode on',
      running: true,
      isEmpty: false,
      lineCount: 3,
      currentLineIndex: 1,
      currentLine: 'two',
      cursorInCurrentLine: 2,
      textBeforeCursor: 'one\ntw',
      textAfterCursor: 'o\nthree',
      completion: { kind: 'none' },
    });

    expect(createPromptState({ value: 'abc', cursor: Number.NaN }).cursor).toBe(3);
    expect(createPromptState({ value: 'abc', cursor: -10 }).cursor).toBe(0);
    expect(createPromptState({ value: 'abc', cursor: 99 }).cursor).toBe(3);
  });

  it('detects prompt completion context for commands and file mentions', () => {
    expect(createPromptState({ value: '/sta', cursor: 4 }).completion).toEqual({
      kind: 'command',
      query: 'sta',
    });
    expect(createPromptState({ value: '/resume abc', cursor: 11 }).completion).toEqual({
      kind: 'none',
    });
    expect(createPromptState({ value: 'read @src/in', cursor: 12 }).completion).toEqual({
      kind: 'file',
      base: 'read ',
      query: 'src/in',
    });
  });

  it('tracks prompt history navigation state without owning renderer history storage', () => {
    expect(
      createPromptState({
        value: '',
        historyIndex: -1,
        historySize: 3,
      }).history
    ).toEqual({
      index: -1,
      size: 3,
      active: false,
      canMovePrevious: true,
      canMoveNext: false,
    });
    expect(
      createPromptState({
        value: 'older',
        historyIndex: 1,
        historySize: 3,
      }).history
    ).toEqual({
      index: 1,
      size: 3,
      active: true,
      canMovePrevious: true,
      canMoveNext: true,
    });
    expect(
      createPromptState({
        value: 'oldest',
        historyIndex: 2,
        historySize: 3,
      }).history.canMovePrevious
    ).toBe(false);
  });

  it('creates renderer-neutral model picker state with current model markers', () => {
    const state = createModelPickerState({
      currentModel: 'qwen',
      models: [
        {
          name: 'gpt-4o',
          alias: 'gpt4o',
          provider: 'OpenAI',
          contextWindow: 128000,
          maxOutputTokens: 16384,
          source: 'builtin',
        },
        {
          name: 'qwen3.5-plus',
          alias: 'qwen',
          provider: 'Bailian',
          contextWindow: 131072,
          maxOutputTokens: 8192,
          source: 'builtin',
        },
      ],
      maxVisibleItems: 1,
    });

    expect(state).toMatchObject({
      kind: 'model',
      title: 'Available Models',
      totalItems: 2,
      visibleLimit: 1,
      page: 1,
      pageCount: 2,
      hasNextPage: true,
    });
    expect(state.visibleItems[0]).toMatchObject({
      value: 'gpt-4o',
      label: 'gpt-4o (gpt4o)',
      description: 'OpenAI  128000 ctx  16384 output  builtin',
      isCurrent: false,
    });

    const second = createModelPickerState({
      currentModel: 'qwen',
      models: [
        {
          name: 'gpt-4o',
          alias: 'gpt4o',
          provider: 'OpenAI',
          contextWindow: 128000,
        },
        {
          name: 'qwen3.5-plus',
          alias: 'qwen',
          provider: 'Bailian',
          contextWindow: 131072,
        },
      ],
      maxVisibleItems: 1,
      visibleStart: movePickerPageOffset(state, 1),
    });
    expect(second.visibleItems[0]).toMatchObject({
      value: 'qwen3.5-plus',
      isCurrent: true,
    });
  });

  it('extracts the active @file mention query for renderer-neutral file pickers', () => {
    expect(getFileMentionQuery('open @src/cli')).toEqual({ base: 'open ', query: 'src/cli' });
    expect(getFileMentionQuery('@')).toEqual({ base: '', query: '' });
    expect(getFileMentionQuery('first @docs second @src/in')).toEqual({
      base: 'first @docs second ',
      query: 'src/in',
    });
    expect(getFileMentionQuery('no file token')).toBeNull();
  });

  it('creates renderer-neutral file picker state from matched files', () => {
    const state = createFilePickerState({
      input: 'read @src/',
      files: [
        { path: 'src/components', isDirectory: true },
        { path: 'src/index.ts', isDirectory: false },
      ],
    });

    expect(state).toMatchObject({
      kind: 'file',
      title: 'Files "src/"',
      totalItems: 2,
      visibleStart: 0,
      visibleLimit: 2,
      page: 1,
      pageCount: 1,
    });
    expect(
      state?.visibleItems.map(item => ({
        value: item.value,
        label: item.label,
        description: item.description,
        isDirectory: item.isDirectory,
      }))
    ).toEqual([
      {
        value: 'src/components/',
        label: 'dir src/components/',
        description: 'directory',
        isDirectory: true,
      },
      {
        value: 'src/index.ts',
        label: 'file src/index.ts',
        description: 'file',
        isDirectory: false,
      },
    ]);
  });

  it('pages file picker state and returns null when no active file mention exists', () => {
    expect(
      createFilePickerState({
        input: 'plain text',
        files: [{ path: 'src/index.ts', isDirectory: false }],
      })
    ).toBeNull();

    const first = createFilePickerState({
      input: '@',
      files: [
        { path: 'a.ts', isDirectory: false },
        { path: 'b.ts', isDirectory: false },
        { path: 'c.ts', isDirectory: false },
      ],
      maxVisibleItems: 2,
    });
    expect(first).toMatchObject({
      totalItems: 3,
      visibleLimit: 2,
      page: 1,
      pageCount: 2,
      hasNextPage: true,
    });

    const second = createFilePickerState({
      input: '@',
      files: [
        { path: 'a.ts', isDirectory: false },
        { path: 'b.ts', isDirectory: false },
        { path: 'c.ts', isDirectory: false },
      ],
      maxVisibleItems: 2,
      visibleStart: movePickerPageOffset(first!, 1),
    });
    expect(second?.visibleItems.map(item => item.value)).toEqual(['c.ts']);
    expect(second?.hasPreviousPage).toBe(true);
    expect(second?.hasNextPage).toBe(false);
  });

  it('creates renderer-neutral permission prompt state for command approvals', () => {
    const state = createPermissionPromptState(
      {
        id: 'perm-1',
        name: 'exec_command',
        args: {
          command: 'npm test -- --runInBand tests/status-command.test.ts',
        },
        reason: 'Command execution needs approval',
      },
      '/repo'
    );

    expect(state).toEqual({
      requestId: 'perm-1',
      toolName: 'exec_command',
      scope: {
        kind: 'command',
        value: '$ npm test -- --runInBand tests/status-command.test.ts',
      },
      cwd: '/repo',
      risk: {
        level: 'low',
        reason: 'Command execution needs approval',
      },
      options: {
        approve: 'y=yes',
        deny: 'n=no',
      },
    });
    expect(permissionScopeDisplayValue(state.scope)).toBe(
      'cmd=$ npm test -- --runInBand tests/status-command.test.ts'
    );
    expect(permissionRiskDisplayValue(state.risk)).toBe('low: Command execution needs approval');
  });

  it('creates permission prompt state for file-oriented and path-list approvals', () => {
    const edit = createPermissionPromptState(
      {
        id: 'perm-2',
        name: 'edit_file',
        args: { path: 'src/terminal-ui/launch.ts' },
      },
      '/repo'
    );
    expect(edit.scope).toEqual({ kind: 'path', value: 'src/terminal-ui/launch.ts' });
    expect(edit.risk).toEqual({ level: 'high', reason: 'approval required' });
    expect(permissionScopeDisplayValue(edit.scope)).toBe('path=src/terminal-ui/launch.ts');

    const readMany = createPermissionPromptState(
      {
        id: 'perm-3',
        name: 'batch_read',
        args: { paths: ['a.ts', 'b.ts'] },
      },
      '/repo'
    );
    expect(readMany.scope).toEqual({ kind: 'paths', count: 2 });
    expect(readMany.risk).toEqual({ level: 'low', reason: 'approval required' });
    expect(permissionScopeDisplayValue(readMany.scope)).toBe('paths=2');
  });

  it('falls back to compact args or unknown permission scope when needed', () => {
    const withArgs = createPermissionPromptState(
      {
        id: 'perm-4',
        name: 'custom_tool',
        args: { query: 'hello', nested: { value: true } },
      },
      '/repo'
    );
    expect(withArgs.scope).toEqual({
      kind: 'args',
      value: 'query=hello nested={"value":true}',
    });
    expect(permissionScopeDisplayValue(withArgs.scope)).toBe(
      'args=query=hello nested={"value":true}'
    );

    const unknown = createPermissionPromptState(
      {
        id: 'perm-5',
        name: 'custom_tool',
        args: {},
      },
      '/repo'
    );
    expect(unknown.scope).toEqual({ kind: 'unknown' });
    expect(permissionScopeDisplayValue(unknown.scope)).toBe('scope=unknown');
  });

  it('creates renderer-neutral permission decision picker items', () => {
    const state = createPermissionDecisionPickerState({
      id: 'permission-1',
      name: 'exec_command',
      args: { command: 'npm publish --dry-run' },
      reason: 'requires confirmation',
    });

    expect(state).toMatchObject({
      kind: 'permission',
      title: 'Tool Permission',
      totalItems: 2,
      page: 1,
      pageCount: 1,
      hasPreviousPage: false,
      hasNextPage: false,
    });
    expect(state.visibleItems).toEqual([
      {
        value: 'allow',
        label: 'Allow exec_command',
        description: 'cmd=$ npm publish --dry-run  requires confirmation',
        approved: true,
      },
      {
        value: 'deny',
        label: 'Deny exec_command',
        description: 'Do not run this tool call',
        approved: false,
      },
    ]);
  });

  it('creates renderer-neutral edit preview picker items', () => {
    const request = {
      path: 'src/index.ts',
      newString: 'replacement '.repeat(8),
      kind: 'fuzzy' as const,
      strategy: 'levenshtein',
      candidates: [
        {
          index: 0,
          line: 12,
          match: 'first candidate '.repeat(8),
          contextBefore: '',
          contextAfter: '',
          isReplaceAll: false,
        },
        {
          index: 1,
          line: 24,
          match: 'second candidate',
          contextBefore: '',
          contextAfter: '',
          isReplaceAll: false,
        },
      ],
    };
    const state = createEditPreviewPickerState({
      request,
      maxVisibleItems: 1,
      maxMatchLength: 24,
      maxReplacementLength: 20,
    });

    expect(state).toMatchObject({
      kind: 'edit-preview',
      title: 'Edit Preview: src/index.ts (fuzzy (levenshtein), 2 candidates)',
      totalItems: 2,
      visibleLimit: 1,
      page: 1,
      pageCount: 2,
      hasNextPage: true,
    });
    expect(state.visibleItems).toHaveLength(1);
    expect(state.visibleItems[0]).toMatchObject({
      value: '12',
      label: 'line 12: first candidate first...',
      description: '→ replacement repla...',
      line: 12,
      matchPreview: 'first candidate first...',
      replacementPreview: 'replacement repla...',
    });

    const second = createEditPreviewPickerState({
      request,
      maxVisibleItems: 1,
      visibleStart: movePickerPageOffset(state, 1),
    });
    expect(second.visibleItems.map(item => item.value)).toEqual(['24']);
    expect(second.hasPreviousPage).toBe(true);
  });

  it('creates renderer-neutral session picker state with global indexes and paging', () => {
    const sessions = [
      {
        id: '11111111-aaaa-bbbb-cccc-111111111111',
        projectPath: '/tmp/project-a',
        model: 'glm-5',
        startTime: 1,
        tokenCount: 0,
        cost: 0,
        taskSummary: 'first task',
        messageCount: 2,
        historySizeBytes: 1024,
      },
      {
        id: '22222222-aaaa-bbbb-cccc-222222222222',
        projectPath: '/tmp/project-b',
        model: 'glm-5',
        startTime: 2,
        tokenCount: 0,
        cost: 0,
        name: 'named session',
        taskSummary: 'second task',
        messageCount: 4,
        historySizeBytes: 2048,
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
    ];

    const firstPage = createSessionPickerState({
      title: 'Pick a Session',
      sessions,
      maxVisibleItems: 2,
      showProject: true,
    });
    expect(firstPage).toMatchObject({
      kind: 'session',
      title: 'Pick a Session',
      totalItems: 3,
      visibleStart: 0,
      visibleLimit: 2,
      page: 1,
      pageCount: 2,
      hasPreviousPage: false,
      hasNextPage: true,
    });
    expect(
      firstPage.visibleItems.map(item => ({
        globalIndex: item.globalIndex,
        shortId: item.shortId,
        title: item.title,
        messageCount: item.messageCount,
        historySizeBytes: item.historySizeBytes,
        showProject: item.showProject,
      }))
    ).toEqual([
      {
        globalIndex: 1,
        shortId: '11111111',
        title: 'first task',
        messageCount: 2,
        historySizeBytes: 1024,
        showProject: true,
      },
      {
        globalIndex: 2,
        shortId: '22222222',
        title: 'named session',
        messageCount: 4,
        historySizeBytes: 2048,
        showProject: true,
      },
    ]);

    const secondPageOffset = movePickerPageOffset(firstPage, 1);
    const secondPage = createSessionPickerState(
      { title: 'Pick a Session', sessions, maxVisibleItems: 2 },
      secondPageOffset
    );
    expect(secondPage.visibleStart).toBe(2);
    expect(secondPage.page).toBe(2);
    expect(secondPage.visibleItems).toHaveLength(1);
    expect(secondPage.visibleItems[0].globalIndex).toBe(3);
    expect(movePickerPageOffset(secondPage, 1)).toBe(2);
    expect(movePickerPageOffset(secondPage, -1)).toBe(0);
  });

  it('handles empty session picker state and untitled sessions', () => {
    const empty = createSessionPickerState({ title: 'Pick a Session', sessions: [] }, 50);

    expect(empty).toMatchObject({
      totalItems: 0,
      visibleStart: 0,
      visibleLimit: 1,
      page: 1,
      pageCount: 1,
      visibleItems: [],
      hasPreviousPage: false,
      hasNextPage: false,
    });
    expect(
      sessionPickerTitle({
        id: 'session-id',
        projectPath: '/tmp/project',
        model: 'glm-5',
        startTime: 1,
        tokenCount: 0,
        cost: 0,
      })
    ).toBe('(untitled)');
  });

  it('normalizes invalid session picker visible limits defensively', () => {
    const sessions = Array.from({ length: 3 }, (_, index) => ({
      id: `${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}-aaaa-bbbb-cccc-111111111111`,
      projectPath: '/tmp/project',
      model: 'glm-5',
      startTime: index,
      tokenCount: 0,
      cost: 0,
      taskSummary: `task ${index + 1}`,
    }));

    expect(
      createSessionPickerState({
        title: 'Pick',
        sessions,
        maxVisibleItems: Number.NaN,
      }).visibleLimit
    ).toBe(3);
    expect(
      createSessionPickerState({
        title: 'Pick',
        sessions,
        maxVisibleItems: -1,
      }).visibleLimit
    ).toBe(3);
    expect(
      createSessionPickerState({
        title: 'Pick',
        sessions,
        maxVisibleItems: 1.8,
      }).visibleLimit
    ).toBe(1);
  });

  it('creates renderer-neutral status snapshots with capability labels', () => {
    expect(rendererStatus('terminal')).toBe('stable');
    expect(rendererStatus('ink')).toBe('deprecated');
    expect(rendererStatus('tui')).toBe('beta');
    expect(rendererStatus('print')).toBe('non-interactive');
    expect(rendererStatus('third-party')).toBe('custom');

    const terminal = createStatusSnapshot({
      renderer: 'terminal',
      model: 'glm-5',
      sessionId: 'session-123',
      runningState: 'ready',
    });
    expect(terminal).toMatchObject({
      model: 'glm-5',
      sessionId: 'session-123',
      runningState: 'ready',
      renderer: {
        name: 'terminal',
        status: 'stable',
        capabilityLabels: [
          'pickers',
          'inline-progress',
          'clean-meta',
          'assistant-spacing',
          'quiet-abort',
        ],
      },
    });

    const print = createStatusSnapshot({ renderer: 'print' });
    expect(print.renderer.status).toBe('non-interactive');
    expect(print.renderer.capabilityLabels).toEqual([
      'text-pickers',
      'legacy-progress',
      'legacy-meta',
      'compact-spacing',
      'abort-notice',
    ]);
  });

  it('formats context pressure with compact reminders and automatic threshold state', () => {
    const base = {
      modelId: 'gpt-4o',
      usedTokens: 1000,
      contextWindow: 128000,
      source: 'estimated' as const,
      warningThresholdPercent: 80,
      autoCompactThresholdPercent: 95,
      autoCompactEnabled: true,
    };

    expect(contextUsageStatusText({ ...base, percent: 79 })).toBe('ctx=79%');
    expect(contextUsageStatusText({ ...base, percent: 80 })).toBe('ctx=80% /compact');
    expect(contextUsageStatusText({ ...base, percent: 95 })).toBe('ctx=95% auto-compact');
  });

  it('creates renderer-neutral runtime capability summaries', () => {
    const base = createRuntimeCapabilitySummary();
    expect(base).toEqual({
      labels: ['scrollback', 'CJK input', 'paste/edit', 'trace'],
      text: 'scrollback, CJK input, paste/edit, trace',
      hasProjectRules: false,
      hasSkills: false,
      hasMemory: false,
      hasMcp: false,
      hasWebSearch: false,
    });

    const full = createRuntimeCapabilitySummary({
      projectInstructionsContent: 'Follow repo rules.',
      skillsContent: 'Available skills: code-review',
      memoryContent: 'Project memory',
      tools: [{ name: 'read_file' }, { name: 'mcp__github__search_issues' }],
      webSearchConfigured: true,
    });

    expect(full.labels).toEqual([
      'scrollback',
      'CJK input',
      'paste/edit',
      'trace',
      'repo rules',
      'skills',
      'memory',
      'MCP',
      'web search',
    ]);
    expect(full.text).toBe(
      'scrollback, CJK input, paste/edit, trace, repo rules, skills, memory, MCP, web search'
    );
    expect(full).toMatchObject({
      hasProjectRules: true,
      hasSkills: true,
      hasMemory: true,
      hasMcp: true,
      hasWebSearch: true,
    });
  });

  it('allows explicit renderer capability overrides in status snapshots', () => {
    const snapshot = createStatusSnapshot({
      renderer: 'terminal',
      capabilities: {
        structuredPickers: false,
        suppressAbortNotice: false,
      },
      loop: {
        llmRequests: 2,
        toolCalls: 3,
        finishReason: 'completed',
        localFastPathUsed: false,
      },
    });

    expect(rendererCapabilityLabels(snapshot.renderer.capabilities)).toEqual([
      'text-pickers',
      'inline-progress',
      'clean-meta',
      'assistant-spacing',
      'abort-notice',
    ]);
    expect(snapshot.loop).toEqual(
      expect.objectContaining({
        llmRequests: 2,
        toolCalls: 3,
        finishReason: 'completed',
      })
    );
  });

  it('maps transcript entries into renderer-neutral blocks', () => {
    const resumeEntry: TranscriptEntry = {
      id: 'entry-1',
      role: 'status',
      title: 'resume',
      content: 'Resumed session abc',
    };
    const toolEntry: TranscriptEntry = {
      id: 'entry-2',
      role: 'tool',
      title: 'tool',
      content: 'Running read_file src/index.ts',
    };

    expect(transcriptEntryToBlock(resumeEntry)).toEqual({
      id: 'entry-1',
      kind: 'resume',
      role: 'status',
      title: 'resume',
      content: 'Resumed session abc',
      restored: true,
    });
    expect(transcriptEntryToBlock(toolEntry)).toEqual({
      id: 'entry-2',
      kind: 'tool',
      role: 'tool',
      title: 'tool',
      content: 'Running read_file src/index.ts',
      restored: undefined,
    });
  });

  it('creates renderer-neutral restored session views', () => {
    const view = createSessionRestoredView({
      sessionId: '2571b283-9c8b-4501-a86e-5d2256e6db73',
      projectPath: '/Users/hope/ai-project/openhorse',
      model: 'glm-5',
      restoredMessages: 58,
      messageCount: 72,
      summary: '  continue\nUI target\timplementation  ',
    });

    expect(view).toEqual({
      sessionId: '2571b283-9c8b-4501-a86e-5d2256e6db73',
      shortId: '2571b283',
      projectPath: '/Users/hope/ai-project/openhorse',
      model: 'glm-5',
      restoredMessages: 58,
      messageCount: 72,
      summary: 'continue UI target implementation',
      headline: 'Resumed session 2571b283 · restored 58/72 messages',
    });
  });

  it('formats running tool activity with batch and exec command details', () => {
    const event: RuntimeToolStartedEvent = {
      callId: 'call-1',
      name: 'exec_command',
      args: { command: 'npm test -- --runInBand tests/status-command.test.ts' },
      sequence: 1,
      batchCount: 2,
      batchIndex: 0,
    };

    const activity = toolActivityFromStarted(event, 'ignored for exec');

    expect(toolActivityBatchLabel(activity)).toBe('Batch 1/2 · ');
    expect(formatToolActivityTranscript(activity)).toBe(
      [
        'Batch 1/2 · Running exec_command',
        '  $ npm test -- --runInBand tests/status-command.test.ts',
      ].join('\n')
    );
  });

  it('formats finished tool activity with artifact, output bytes, and errors', () => {
    const event: RuntimeToolFinishedEvent = {
      callId: 'call-2',
      name: 'read_file',
      args: { path: 'src/index.ts' },
      success: false,
      duration: 12,
      outputBytes: 1200,
      artifactRef: { id: 'read_file-abc123', outputBytes: 1200 },
      error: 'failed to read',
      sequence: 2,
    };

    expect(formatToolActivityTranscript(toolActivityFromFinished(event, 'src/index.ts'))).toBe(
      [
        '✗ read_file src/index.ts (12ms)',
        '  Full output: /artifacts show read_file-abc123 --full (1.2 KB)',
        'Error: failed to read',
        '  Details: /last-tool or /trace latest',
      ].join('\n')
    );
  });

  it('formats skipped tool activity for permission-denied tools', () => {
    const event: RuntimeToolFinishedEvent = {
      callId: 'call-3',
      name: 'write_file',
      args: {},
      success: false,
      skipped: true,
      duration: 0,
      error: 'permission denied',
      sequence: 3,
    };

    const activity = toolActivityFromFinished(event);
    expect(activity.state).toBe('skipped');
    expect(formatToolActivityTranscript(activity)).toBe(
      [
        'Skipped write_file',
        'Error: permission denied',
        '  Details: /last-tool or /trace latest',
      ].join('\n')
    );
  });

  it('adds inspection hints when tool arguments are compacted', () => {
    expect(
      formatToolActivityTranscript({
        name: 'grep',
        state: 'running',
        detail: '/Users/hope/very/long/path/.../target.ts',
      })
    ).toBe(
      [
        'Running grep /Users/hope/very/long/path/.../target.ts',
        '  Details: /last-tool or /trace latest',
      ].join('\n')
    );
  });

  it('ignores invalid batch metadata in formatted activity', () => {
    expect(toolActivityBatchLabel({ batchCount: 2, batchIndex: 7 })).toBe('');
    expect(
      formatToolActivityTranscript({
        name: 'read_file',
        state: 'success',
        detail: 'src/a.ts',
        durationMs: 3,
        batchCount: 2,
        batchIndex: 7,
      })
    ).toBe('✓ read_file src/a.ts (3ms)');
  });
});
