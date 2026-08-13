import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  findCommand,
  getCommandCategoryLabel,
  getCommandNames,
  getCommands,
  getVisibleCommands,
  sortCommands,
} from '../src/commands';
import type { SlashCommand, CommandContext } from '../src/commands/types';
import { Store } from '../src/framework/store';
import { loadConfig } from '../src/services/config';

const stripAnsi = (text: string): string =>
  text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

const autoCompactStats = {
  modelId: 'gpt-4o',
  enabled: true,
  predictiveCompactThreshold: 0.7,
  threshold: 0.8,
  preCompactThreshold: 0.6,
  ctxPercent: 25,
  lastTokenCount: 1234,
  preCompactArmed: true,
  lastCompactMode: 'manual',
};

let commandOutputs: string[] = [];

function makeContext(root: string, overrides: Partial<CommandContext> = {}): CommandContext {
  const config = loadConfig({
    apiKey: 'test-key',
    model: 'gpt-4o',
    ui: { renderer: 'tui' },
  });
  const store = new Store({ config, tools: [], currentModel: 'gpt-4o' });
  const runtime = {
    brain: {
      getStatus: () => ({ agents: [], pendingTasks: 0, strategy: 'sequential' }),
      submitTask: jest.fn(),
    },
    memory: {
      getStatus: () => ({ working: 2, 'short-term': 3, 'long-term': 4 }),
    },
    store: {
      getStats: () => ({ working: 5, 'short-term': 6, 'long-term': 7 }),
    },
    config: {
      memory: { workingCapacity: 10, shortTermCapacity: 20 },
    },
    safety: {
      getPolicy: () => ({
        enabled: true,
        sandboxMode: true,
        blocked: ['rm -rf', 'shutdown'],
        dangerousPatterns: ['sudo', 'chmod'],
      }),
      getAuditSummary: () => ({ total: 5, passed: 4, blocked: 1 }),
    },
    harness: {
      getConfig: () => ({
        maxSteps: 12,
        boundaryCheck: true,
        goalConstraint: false,
        resultValidation: true,
        sandbox: false,
        timeout: 30_000,
        blockedActions: ['delete'],
      }),
    },
    agents: [],
    shutdown: jest.fn(async () => undefined),
  };

  return {
    cwd: root,
    config,
    store,
    llm: null,
    runtime: runtime as never,
    compactCoordinator: {
      configure: jest.fn(),
      getAutomatic: () => ({ getStats: () => autoCompactStats }),
    } as never,
    ...overrides,
  };
}

async function execute(ctx: CommandContext, name: string, args = '') {
  const command = findCommand(name);
  expect(command).toBeDefined();
  const result = await command!.execute(ctx, args);
  if (result.output) commandOutputs.push(result.output);
  return result;
}

describe('command index branch coverage', () => {
  let root: string;
  let configRoot: string;
  let priorConfigDir: string | undefined;
  let logs: string[];
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-command-index-'));
    configRoot = mkdtempSync(join(tmpdir(), 'orion-command-config-'));
    priorConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = configRoot;
    logs = [];
    commandOutputs = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (priorConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = priorConfigDir;
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    if (existsSync(configRoot)) rmSync(configRoot, { recursive: true, force: true });
  });

  it('sorts commands, resolves aliases, and filters renderer-scoped commands', () => {
    const commands: SlashCommand[] = [
      {
        name: 'zulu',
        description: 'z',
        category: 'system',
        priority: 2,
        type: 'builtin',
        execute: () => ({ success: true }),
      },
      {
        name: 'alpha',
        description: 'a',
        category: 'system',
        priority: 1,
        type: 'builtin',
        execute: () => ({ success: true }),
      },
      {
        name: 'beta',
        description: 'b',
        category: 'workflow',
        type: 'builtin',
        execute: () => ({ success: true }),
      },
      {
        name: 'able',
        description: 'same priority',
        category: 'system',
        priority: 1,
        type: 'builtin',
        execute: () => ({ success: true }),
      },
    ];

    expect(sortCommands(commands).map(command => command.name)).toEqual([
      'beta',
      'able',
      'alpha',
      'zulu',
    ]);
    expect(getCommandCategoryLabel(undefined)).toBe('System');
    expect(getCommandCategoryLabel('workflow')).toBe('Workflow');
    expect(findCommand('goal')?.name).toBe('goal');
    expect(findCommand('TARGET')?.id).toBe('builtin.workflow.goal');
    expect(findCommand('audit')?.name).toBe('security');
    expect(findCommand('missing')).toBeUndefined();
    expect(getCommandNames()).toContain('help');
    expect(getCommandNames()).not.toContain('chat');
    expect(getCommands().some(command => command.name === 'chat')).toBe(true);
    expect(getVisibleCommands('tui').some(command => command.name === 'clear')).toBe(true);
    expect(getVisibleCommands('terminal').some(command => command.name === 'tool-output')).toBe(
      false
    );
    expect(getVisibleCommands('print').some(command => command.rendererScope)).toBe(false);
  });

  it('renders help across renderer scopes and all command metadata branches', async () => {
    for (const renderer of [undefined, 'tui', 'terminal', 'ink', 'print'] as const) {
      const ctx = makeContext(root, { uiRenderer: renderer });
      expect((await execute(ctx, 'help')).success).toBe(true);
    }
    expect((await execute(makeContext(root), 'help', '--all')).success).toBe(true);

    const output = stripAnsi([...logs, ...commandOutputs].join('\n'));
    expect(output).toContain('Workflow');
    expect(output).not.toContain('/context-clear');
    expect(output).toContain('/storage');
    expect(output).toContain('deprecated since');
    expect(output).toContain('destructive');
  });

  it('routes workflow commands and their aliases without mutating state', async () => {
    const ctx = makeContext(root);

    await expect(execute(ctx, 'target', 'ship')).resolves.toEqual({
      success: false,
      error: '/goal must be routed through the shared AgentRuntimeController.',
    });
    await expect(execute(ctx, 'review', '')).resolves.toMatchObject({
      success: true,
      continueAsChat: true,
      chatInput: '/review',
    });
    await expect(execute(ctx, 'audit', ' src')).resolves.toMatchObject({
      chatInput: '/security src',
    });
    await expect(execute(ctx, 'tests', ' unit')).resolves.toMatchObject({
      chatInput: '/test-gen unit',
    });
    await expect(execute(ctx, 'chat', 'hello')).resolves.toMatchObject({
      chatInput: 'hello',
    });
  });

  it('covers permission help and invalid input without a mode-command compatibility path', async () => {
    const ctx = makeContext(root);

    for (const arg of ['', '?', 'help', 'show', 'audit']) {
      expect((await execute(ctx, 'permissions', arg)).success).toBe(true);
    }
    const invalid = await execute(ctx, 'permissions', 'danger');
    expect(invalid).toMatchObject({ success: false });
    expect(invalid.error).toContain('Unknown tool policy');
  });

  it('prints agents, memory, safety, and configuration with rich runtime data', async () => {
    const llm = {
      getModel: jest.fn(() => 'gpt-4o'),
      getConfigSummary: jest.fn(() => ({ provider: 'test', retries: 2 })),
    };
    const ctx = makeContext(root, { llm: llm as never });
    ctx.runtime.agents = [
      { getStatus: () => ({ status: 'idle', name: 'one', id: 'a', capabilities: ['code'] }) },
      { getStatus: () => ({ status: 'busy', name: 'two', id: 'b', capabilities: [] }) },
    ] as never;

    for (const command of ['agents', 'memory', 'safety', 'config']) {
      expect((await execute(ctx, command)).success).toBe(true);
    }

    const output = stripAnsi([...logs, ...commandOutputs].join('\n'));
    expect(output).toContain('Registered Agents');
    expect(output).toContain('Short-term 3 / 20');
    expect(output).toContain('Blocked patterns');
    expect(output).toContain('provider');
  });

  it('covers absent, compact, and rich explain harness states', async () => {
    const ctx = makeContext(root, {
      getSession: () =>
        ({
          id: 'session-1',
          transcriptDisplayStartTime: Date.now(),
        }) as never,
    });

    expect((await execute(ctx, 'harness')).success).toBe(true);
    ctx.store.setState({
      harnessState: {
        version: 2,
        taskEpoch: 3,
        rootObjective: 'Ship reliable CLI',
        activeInstruction: 'add coverage',
        activeConstraints: ['no source changes', 'real branches'],
        contract: {
          objective: 'Ship reliable CLI',
          userIntent: 'test command routing',
          requirements: ['tests', 'coverage'],
          prohibitions: ['ignore pragmas'],
          successCriteria: ['green Jest'],
        },
        ledger: [{ id: 'ledger-1' }],
        evidenceIndex: [
          { id: 'e1', kind: 'test' },
          { id: 'e2', kind: 'test' },
          { id: 'e3', kind: '' },
        ],
        intentHistory: [
          { kind: 'continue', confidence: 0.91, summary: 'keep going' },
          { kind: 'correct', summary: '' },
        ],
        turnSummaries: [{ id: 'turn-1' }],
        capsule: {
          nextAction: 'measure coverage',
          completed: ['write tests'],
          openTodos: ['run coverage'],
          changedFiles: ['tests/command-index-branch-coverage.test.ts'],
          verification: { passed: ['jest'], failed: ['coverage'] },
        },
        diagnostics: ['diagnostic one', 'diagnostic two'],
        promptAssemblyStats: {
          modelId: 'gpt-4o',
          estimatedTokens: 1000,
          budgetTokens: 4000,
          sections: ['contract', 'evidence'],
          includedEvidence: [{ id: 'e1', kind: 'test', score: 10, tokens: 20, reason: 'recent' }],
          omittedEvidence: [{ id: 'e2', kind: 'log', score: 1, tokens: 50, reason: 'budget' }],
        },
      } as never,
    });

    expect((await execute(ctx, 'harness')).success).toBe(true);
    expect((await execute(ctx, 'harness', 'explain')).success).toBe(true);

    const output = stripAnsi([...logs, ...commandOutputs].join('\n'));
    expect(output).toContain('Context State');
    expect(output).toContain('restored session');
    expect(output).toContain('Included Evidence');
    expect(output).toContain('Omitted Evidence');
    expect(output).toContain('Armed');
  });

  it('covers sparse harness explain fallbacks', async () => {
    const ctx = makeContext(root, { compactCoordinator: undefined });
    ctx.store.setState({
      harnessState: {
        ledger: [],
        evidenceIndex: [],
        intentHistory: [],
        turnSummaries: [],
      } as never,
    });

    expect((await execute(ctx, 'harness', 'explain')).success).toBe(true);
    const output = stripAnsi([...logs, ...commandOutputs].join('\n'));
    expect(output).toContain('(no contract established)');
    expect(output).toContain('(no evidence records yet)');
    expect(output).toContain('(no capsule yet)');
    expect(output).toContain('No prompt assembly stats');
  });

  it('covers model info, listing, help, unavailable, and switching branches', async () => {
    const noLlm = makeContext(root);
    for (const args of ['', '?', 'info', 'list', 'ls', 'help', 'sonnet']) {
      const result = await execute(noLlm, 'model', args);
      expect(result.success).toBe(args !== 'sonnet');
    }

    const llm = {
      getModel: jest.fn(() => 'claude-3-5-sonnet'),
      setModel: jest.fn(),
      getMaxTokens: jest.fn(() => 4096),
    };
    const configured = makeContext(root, { llm: llm as never });
    expect((await execute(configured, 'model')).success).toBe(true);
    expect((await execute(configured, 'model', 'sonnet')).success).toBe(true);
    expect(llm.setModel).toHaveBeenCalled();
  });

  it('renders todo and usage state variants', async () => {
    const ctx = makeContext(root);
    expect((await execute(ctx, 'todos')).success).toBe(true);
    expect((await execute(ctx, 'usage')).success).toBe(true);

    ctx.store.setState({
      todos: [
        { content: 'done', activeForm: 'done', status: 'completed' },
        { content: 'working', activeForm: 'actively working', status: 'in_progress' },
        { content: 'later', activeForm: 'later', status: 'pending' },
      ],
      tokenUsage: { promptTokens: 200, completionTokens: 50 },
      conversationHistory: [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'answer' },
        { role: 'tool', content: 'result' },
      ] as never,
    });
    ctx.llm = { getModel: () => 'active-model' } as never;

    expect((await execute(ctx, 'todos')).success).toBe(true);
    expect((await execute(ctx, 'stats')).success).toBe(true);
    const output = stripAnsi([...logs, ...commandOutputs].join('\n'));
    expect(output).toContain('actively working');
    expect(output).toContain('Ratio');
    expect(output).toContain('active-model');
  });

  it('guards and confirms context clearing', async () => {
    const ctx = makeContext(root);
    expect((await execute(ctx, 'context-clear')).success).toBe(true);
    ctx.store.setState({ conversationHistory: [{ role: 'user', content: 'keep me' }] as never });

    const preview = await execute(ctx, 'context-clear', '--force');
    expect(preview.success).toBe(false);
    expect(ctx.store.getSnapshot().conversationHistory).toHaveLength(1);
    expect((await execute(ctx, 'clear-history', ' --yes ')).success).toBe(true);
    expect(ctx.store.getSnapshot().conversationHistory).toEqual([]);
  });

  it('covers compact empty, threshold, success, and error paths', async () => {
    const ctx = makeContext(root);
    expect((await execute(ctx, 'compact')).success).toBe(true);

    ctx.store.setState({
      conversationHistory: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'three' },
      ] as never,
    });
    expect((await execute(ctx, 'compact', 'invalid')).success).toBe(true);
    expect((await execute(ctx, 'compact', '10')).success).toBe(true);

    const coordinator = {
      configure: jest.fn(),
      getAutomatic: () => ({ getStats: () => autoCompactStats }),
      compactManual: jest.fn(async () => ({
        messages: [{ role: 'assistant', content: 'summary' }],
        summary: 'summary',
        summaryGeneratedAt: Date.now(),
        summarySource: 'manual',
      })),
    };
    ctx.compactCoordinator = coordinator as never;
    expect((await execute(ctx, 'compact', '1')).success).toBe(true);
    expect(ctx.store.getSnapshot().conversationHistory).toHaveLength(1);

    ctx.store.setState({
      conversationHistory: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
      ] as never,
    });
    coordinator.compactManual.mockRejectedValueOnce('boom' as never);
    expect((await execute(ctx, 'compact', '1')).success).toBe(false);
  });

  it('validates storage grammar and previews non-destructive maintenance plans', async () => {
    const ctx = makeContext(root);
    const cases = [
      ['doctor --yes', 'Unknown /storage option'],
      ['cleanup --bogus', 'Unknown /storage option'],
      ['cleanup --plan=', 'Unknown /storage option'],
      ['cleanup --plan=a --plan=b', 'Unknown /storage option'],
      ['cleanup --plan=corrupt', 'Invalid or corrupted'],
      ['cleanup --yes', 'requires the exact preview plan'],
      ['repair --yes', 'requires the exact preview plan'],
      ['unknown', 'Usage:'],
    ];

    for (const [args, error] of cases) {
      const result = await execute(ctx, 'storage', args);
      expect(result.success).toBe(false);
      expect(result.error).toContain(error);
    }
    expect((await execute(ctx, 'storage', 'cleanup --dry-run')).success).toBe(true);
    expect((await execute(ctx, 'storage', 'repair --dry-run')).success).toBe(true);
    expect((await execute(ctx, 'storage', 'doctor')).success).toBe(true);
    expect((await execute(ctx, 'storage', 'status')).success).toBe(true);
  });

  it('covers session argument parsing and empty or missing session paths', async () => {
    const ctx = makeContext(root);
    for (const args of ['', '--all', '-a', '--project ./nested', '-p ./other']) {
      expect((await execute(ctx, 'sessions', args)).success).toBe(true);
    }
    expect((await execute(ctx, 'sessions', 'not-found-query')).success).toBe(true);
    expect((await execute(ctx, 'resume')).success).toBe(false);
    expect((await execute(ctx, 'resume', '#0')).success).toBe(false);
    expect((await execute(ctx, 'resume', 'missing --all')).success).toBe(false);
    expect((await execute(ctx, 'session-rename')).success).toBe(false);
    expect((await execute(ctx, 'rename-session', 'missing new-name --all')).success).toBe(false);
  });

  it('covers task, run, diff, commit, clear, and exit error or fallback paths', async () => {
    const ctx = makeContext(root, {
      clearView: jest.fn(),
      requestShutdown: jest.fn(),
    });

    expect((await execute(ctx, 'task', '')).success).toBe(true);
    expect((await execute(ctx, 'task', 'list')).success).toBe(true);
    expect((await execute(ctx, 'task', 'ls')).success).toBe(true);
    expect((await execute(ctx, 'run')).success).toBe(false);

    const noConfig = makeContext(root);
    noConfig.config.apiKey = '';
    expect((await execute(noConfig, 'run', 'do work')).success).toBe(false);
    expect((await execute(ctx, 'run', 'do work')).success).toBe(false);

    expect((await execute(ctx, 'diff')).success).toBe(false);
    expect((await execute(ctx, 'diff', '--max-files=3')).success).toBe(false);
    expect((await execute(ctx, 'commit')).success).toBe(false);
    expect((await execute(ctx, 'commit', '--max-files 2')).success).toBe(false);
    expect((await execute(ctx, 'clear')).success).toBe(true);
    expect((await execute(ctx, 'exit')).success).toBe(true);
    expect(ctx.requestShutdown).toHaveBeenCalledWith('user request');
    expect(ctx.runtime.shutdown).toHaveBeenCalled();
  });
});
