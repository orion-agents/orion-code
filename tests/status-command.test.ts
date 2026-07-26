import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findCommand } from '../src/commands';
import { Store } from '../src/framework/store';
import { loadConfig } from '../src/services/config';
import { appendSessionTraceEvent, createSession, readSessionTraceEvents } from '../src/services/session-storage';
import { getProjectSessionTracePath } from '../src/services/config-dir';
import { storeArtifact } from '../src/core/tool-artifacts';
import { createCheckpoint } from '../src/core/checkpoint';
import { TOOLS } from '../src/tools';
import type { CommandContext } from '../src/commands/types';

const stripAnsi = (text: string): string => text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

function makeRuntime() {
  return {
    brain: {
      getStatus: () => ({ agents: [], pendingTasks: 0, strategy: 'sequential' }),
    },
    memory: {
      getStatus: () => ({ working: 0, 'short-term': 0, 'long-term': 0 }),
    },
    store: {
      getStats: () => ({ working: 0, 'short-term': 0, 'long-term': 0 }),
    },
  };
}

describe('/status context diagnostics', () => {
  let root: string;
  let logs: string[];
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openhorse-status-command-'));
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'packages', 'cli'), { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'Root rules');
    writeFileSync(join(root, 'packages', 'cli', 'AGENTS.md'), 'Package rules');
    logs = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('shows loaded project instruction files and prompt context sizes', async () => {
    const cwd = join(root, 'packages', 'cli');
    const config = loadConfig({ apiKey: 'test-key' });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: 'gpt-4o',
      memoryContent: 'memory',
      skillsContent: 'skills',
    });
    const ctx: CommandContext = {
      cwd,
      config,
      store,
      llm: null,
      runtime: makeRuntime() as any,
    };

    const result = await findCommand('status')!.execute(ctx, '');
    const rendered = stripAnsi(logs.join('\n'));

    expect(result.success).toBe(true);
    expect(rendered).toContain('Context:');
    expect(rendered).toContain('Renderer   terminal stable');
    expect(rendered).toContain('pickers, inline-progress, clean-meta, assistant-spacing, quiet-abort');
    expect(rendered).toContain('Project rules 2 files');
    expect(rendered).toContain('AGENTS.md');
    expect(rendered).toContain('packages/cli/AGENTS.md');
    expect(rendered).toContain('Prompt rules');
    expect(rendered).toContain('Project memory 6 chars');
    expect(rendered).toContain('Skills index   6 chars');
    expect(store.getSnapshot().projectInstructionsContent).toContain('Root rules');
    expect(store.getSnapshot().projectInstructionsContent).toContain('Package rules');
  });

  it('shows renderer layer diagnostics from /status', async () => {
    const cwd = join(root, 'packages', 'cli');
    const config = loadConfig({
      apiKey: 'test-key',
      ui: { renderer: 'ink' },
    });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: 'gpt-4o',
    });
    const ctx: CommandContext = {
      cwd,
      config,
      store,
      llm: null,
      runtime: makeRuntime() as any,
      uiCapabilities: {
        structuredPickers: false,
        inlineProgress: false,
        suppressLegacyTokenMeta: false,
        extraAssistantSpacing: false,
        suppressAbortNotice: false,
      },
    };

    const result = await findCommand('status')!.execute(ctx, '');
    const rendered = stripAnsi(logs.join('\n'));

    expect(result.success).toBe(true);
    expect(rendered).toContain('Renderer   ink deprecated');
    expect(rendered).toContain('text-pickers, legacy-progress, legacy-meta, compact-spacing, abort-notice');
  });

  it('uses the active renderer adapter identity for print-mode /status diagnostics', async () => {
    const cwd = join(root, 'packages', 'cli');
    const config = loadConfig({
      apiKey: 'test-key',
      ui: { renderer: 'terminal' },
    });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: 'gpt-4o',
    });
    const ctx: CommandContext = {
      cwd,
      config,
      store,
      llm: null,
      runtime: makeRuntime() as any,
      uiRenderer: 'print',
      uiCapabilities: {
        structuredPickers: false,
        inlineProgress: false,
        suppressLegacyTokenMeta: false,
        extraAssistantSpacing: false,
        suppressAbortNotice: false,
      },
    };

    const result = await findCommand('status')!.execute(ctx, '');
    const rendered = stripAnsi(logs.join('\n'));

    expect(result.success).toBe(true);
    expect(rendered).toContain('Renderer   print non-interactive');
    expect(rendered).not.toContain('Renderer   terminal stable text-pickers');
  });

  it('renders /model list from shared model picker state', async () => {
    const cwd = join(root, 'packages', 'cli');
    const config = loadConfig({ apiKey: 'test-key', model: 'glm-5' });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: 'glm-5',
    });
    const ctx: CommandContext = {
      cwd,
      config,
      store,
      llm: {
        getModel: jest.fn(() => 'glm-5'),
      } as any,
      runtime: makeRuntime() as any,
    };

    const result = await findCommand('model')!.execute(ctx, 'list');
    const rendered = stripAnsi(logs.join('\n'));

    expect(result.success).toBe(true);
    expect(rendered).toContain('Available Models');
    expect(rendered).toContain('glm-5');
    expect(rendered).toContain('(glm)');
    expect(rendered).toContain('(current)');
    expect(rendered).toContain('203K ctx');
    expect(rendered).toContain('Bailian (Zhipu)');
    expect(rendered).toContain('claude-opus-4-8');
    expect(rendered).toContain('200K ctx');
    expect(rendered).not.toContain('claude-opus-4-7');
  });

  it('switches /model aliases to known model ids', async () => {
    const cwd = join(root, 'packages', 'cli');
    const config = loadConfig({ apiKey: 'test-key', model: 'glm-5' });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: 'glm-5',
    });
    const setModel = jest.fn();
    const ctx: CommandContext = {
      cwd,
      config,
      store,
      llm: {
        getModel: jest.fn(() => 'glm-5'),
        setModel,
      } as any,
      runtime: makeRuntime() as any,
    };

    const result = await findCommand('model')!.execute(ctx, 'opus');
    const rendered = stripAnsi(logs.join('\n'));

    expect(result.success).toBe(true);
    expect(setModel).toHaveBeenCalledWith('claude-opus-4-8');
    expect(store.getSnapshot().currentModel).toBe('claude-opus-4-8');
    expect(rendered).toContain('Model changed to claude-opus-4-8');
    expect(rendered).toContain('Context window 200K tokens (builtin)');
  });

  it('renders /model help aliases from the shared model catalog', async () => {
    const cwd = join(root, 'packages', 'cli');
    const config = loadConfig({ apiKey: 'test-key', model: 'glm-5' });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: 'glm-5',
    });
    const ctx: CommandContext = {
      cwd,
      config,
      store,
      llm: null,
      runtime: makeRuntime() as any,
    };

    const result = await findCommand('model')!.execute(ctx, 'help');
    const rendered = stripAnsi(logs.join('\n'));

    expect(result.success).toBe(true);
    expect(rendered).toContain('Aliases:');
    expect(rendered).toContain('codernext');
    expect(rendered).toContain('gpt35');
    expect(rendered).toContain('qwenplus');
    expect(rendered).toContain('minimax');
  });

  it('shows last agent-loop stats when available', async () => {
    const cwd = join(root, 'packages', 'cli');
    const config = loadConfig({ apiKey: 'test-key' });
    const store = new Store({
      config,
      tools: TOOLS,
        currentModel: 'gpt-4o',
      });
      store.setLastLoopStats({
      turnsStarted: 2,
      llmRequests: 2,
      toolCalls: 3,
      readOnlyToolCalls: 2,
      unsafeToolCalls: 1,
      toolResultBytes: 12_000,
      modelVisibleToolBytes: 2_000,
      summarizedBytes: 10_000,
      compactTrigger: 'pre_turn',
      finishReason: 'completed',
      loopBudgetSource: 'complex',
      loopBudgetBaseProfile: 'complex',
      loopBudgetMaxLlmRequests: 48,
      loopBudgetMaxToolCalls: 180,
      loopBudgetMaxReadOnlyFragmentation: 3,
      loopBudgetMaxModelVisibleBytes: 96 * 1024,
      loopBudgetConfigOverride: false,
      providerRetryCount: 2,
      providerRetryDelayMs: 1500,
      providerRetryErrorTypes: ['rate_limit'],
      providerLastRetryErrorType: 'rate_limit',
      providerLastRetryStatus: 429,
      providerFallbackCount: 1,
      providerFallbackFromModel: 'primary-model',
      providerFallbackToModel: 'fallback-model',
      providerFinalModel: 'fallback-model',
      providerUsingFallback: true,
      verificationProfile: 'node',
      verificationRequired: true,
      verificationClaimAllowed: false,
      verificationPassedCommands: ['npm run build'],
      verificationFailedCommands: [],
      verificationMissingCommands: ['npm test -- --runInBand', 'npm run lint'],
      verificationSkippedReason: 'Some expected verification commands have not passed yet.',
      singleReadOnlyStreak: 3,
      batchReadSuggestionCount: 1,
      localFastPathUsed: false,
    });
    const ctx: CommandContext = {
      cwd,
      config,
      store,
      llm: null,
      runtime: makeRuntime() as any,
    };

    const result = await findCommand('status')!.execute(ctx, '');
    const rendered = stripAnsi(logs.join('\n'));

    expect(result.success).toBe(true);
    expect(rendered).toContain('Last loop:');
    expect(rendered).toContain('Finish     completed');
    expect(rendered).toContain('Requests   2 LLM / 2 turns');
    expect(rendered).toContain('Tools      3 total (2 read-only, 1 unsafe)');
    expect(rendered).toContain('Saved');
    expect(rendered).toContain('Compact    pre_turn');
    expect(rendered).toContain('Budget cap 2/48 LLM, 3/180 tools');
    expect(rendered).toContain('(complex)');
    expect(rendered).toContain('Provider   2 retries, delay 1.5s, last rate_limit/429');
    expect(rendered).toContain('Fallback   primary-model -> fallback-model');
    expect(rendered).toContain('Verify     node required=yes passed=1 failed=0 missing=2 claim=no');
    expect(rendered).toContain('Read-only  streak 3, batch_read hints 1');
  });

  it('shows detailed loop stats from /loop-stats', async () => {
    const cwd = join(root, 'packages', 'cli');
    const config = loadConfig({ apiKey: 'test-key' });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: 'gpt-4o',
    });
    store.setLastLoopStats({
      turnsStarted: 1,
      llmRequests: 0,
      toolCalls: 1,
      readOnlyToolCalls: 1,
      unsafeToolCalls: 0,
      toolResultBytes: 500,
      modelVisibleToolBytes: 0,
      summarizedBytes: 500,
      finishReason: 'budget_exceeded',
      budgetExceededReason: 'LLM request budget 96 reached',
      continuationActions: ['reply_continue', 'narrow_instruction', 'inspect_loop_stats', 'raise_budget'],
      continuationHint: 'Reply `继续` to continue the same objective, give a narrower next step, inspect /loop-stats, or raise agentLoop.budget for intentional long work.',
      loopBudgetSource: 'config',
      loopBudgetBaseProfile: 'release',
      loopBudgetMaxLlmRequests: 96,
      loopBudgetMaxToolCalls: 360,
      loopBudgetMaxReadOnlyFragmentation: 4,
      loopBudgetMaxModelVisibleBytes: 128 * 1024,
      loopBudgetConfigOverride: true,
      providerRetryCount: 1,
      providerRetryDelayMs: 500,
      providerRetryErrorTypes: ['provider_busy'],
      providerLastRetryErrorType: 'provider_busy',
      providerLastRetryStatus: 529,
      providerFallbackCount: 0,
      providerFinalModel: 'fallback-model',
      providerUsingFallback: true,
      verificationProfile: 'node',
      verificationRequired: true,
      verificationClaimAllowed: false,
      verificationPassedCommands: ['npm run build'],
      verificationFailedCommands: ['npm run lint'],
      verificationMissingCommands: ['npm test -- --runInBand'],
      verificationSkippedReason: 'Some expected verification commands have not passed yet.',
      singleReadOnlyStreak: 0,
      batchReadSuggestionCount: 0,
      localFastPathUsed: true,
    });
    const ctx: CommandContext = {
      cwd,
      config,
      store,
      llm: null,
      runtime: makeRuntime() as any,
    };

    const result = await findCommand('loop-stats')!.execute(ctx, '');
    const rendered = stripAnsi(logs.join('\n'));

    expect(result.success).toBe(true);
    expect(rendered).toContain('Agent Loop Stats');
    expect(rendered).toContain('Requests   0 LLM / 1 turns');
    expect(rendered).toContain('Fast path  yes');
    expect(rendered).toContain('Provider   1 retries, delay 500ms, last provider_busy/529');
    expect(rendered).toContain('Fallback   final fallback-model');
    expect(rendered).toContain('Verify     node required=yes passed=1 failed=1 missing=1 claim=no');
    expect(rendered).toContain('Budget     LLM request budget 96 reached');
    expect(rendered).toContain('Next       reply_continue, narrow_instruction, inspect_loop_stats, raise_budget');
    expect(rendered).toContain('Budget cap 0/96 LLM, 1/360 tools');
    expect(rendered).toContain('(config over release)');
    expect(rendered).toContain('Retry type provider_busy');
    expect(rendered).toContain('Failed     npm run lint');
    expect(rendered).toContain('Missing    npm test -- --runInBand');
    expect(rendered).toContain('Verify why Some expected verification commands have not passed yet.');
    expect(rendered).toContain('Next why   Reply `继续` to continue the same objective');
    expect(rendered).toContain('Budget hit yes');
  });

  it('shows a structured turn timeline from /trace', async () => {
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');
    try {
      const cwd = join(root, 'packages', 'cli');
      const config = loadConfig({ apiKey: 'test-key' });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });
      const session = createSession(cwd, 'gpt-4o');
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-7',
        type: 'turn_start',
        inputBytes: 11,
      });
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-7',
        type: 'request_start',
        model: 'gpt-4o',
        turn: 1,
      });
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-7',
        type: 'provider_retry',
        providerRetryCount: 2,
        providerRetryDelayMs: 1500,
        providerRetryErrorTypes: ['rate_limit', 'provider_busy'],
        providerLastRetryErrorType: 'provider_busy',
        providerLastRetryStatus: 529,
        providerFinalModel: 'fallback-model',
        providerUsingFallback: true,
      });
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-7',
        type: 'provider_fallback',
        providerFallbackCount: 1,
        providerFallbackFromModel: 'primary-model',
        providerFallbackToModel: 'fallback-model',
        providerFinalModel: 'fallback-model',
        providerUsingFallback: true,
      });
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-7',
        type: 'prompt_assembly',
        promptModelId: 'gpt-4o',
        promptEstimatedTokens: 512,
        promptBudgetTokens: 2048,
        promptCoreTokens: 128,
        promptEvidenceBudgetTokens: 400,
        promptRecentTurnBudgetTokens: 300,
        promptSections: ['core', 'ranked_evidence'],
        promptIncludedEvidence: ['ledger-1:user_requirement:score=42:tokens=20'],
        promptOmittedEvidence: ['ledger-2:tool_result:score=2:tokens=50'],
        promptIncludedEvidenceCount: 1,
        promptOmittedEvidenceCount: 1,
      });
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-7',
        type: 'workspace_snapshot',
        workspacePhase: 'pre_turn',
        workspaceGitAvailable: true,
        workspaceDirty: true,
        workspaceBranch: 'main',
        workspaceFileCount: 1,
        workspaceFiles: ['?? pre-existing.txt'],
      });
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-7',
        type: 'checkpoint',
        checkpointId: 'turn-7',
        checkpointFileCount: 2,
        checkpointFiles: ['src/a.ts', 'src/b.ts'],
        workspaceFiles: ['src/a.ts', 'src/b.ts'],
        note: 'pre_edit_checkpoint',
      });
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-7',
        type: 'tool_call',
        name: 'read_file',
        callId: 'call-1',
        argsSummary: 'src/index.ts {"apiKey":"dashscope-secret-value"} Authorization: Bearer secret-token-123456',
        argsArtifactId: 'read_file-args-123',
        argsBytes: 4096,
      });
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-7',
        type: 'permission_decision',
        name: 'read_file',
        callId: 'call-1',
        permissionBehavior: 'ask',
        permissionApproved: true,
        permissionSource: 'user',
        permissionReason: 'Authorization: Bearer secret-token-123456',
        permissionDuration: 9,
      });
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-7',
        type: 'tool_result',
        name: 'read_file',
        callId: 'call-1',
        success: true,
        duration: 12,
        outputBytes: 2048,
        modelVisibleBytes: 256,
      });
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-7',
        type: 'workspace_delta',
        workspaceFileCount: 2,
        workspaceFiles: ['pre-existing.txt', 'new-file.ts'],
        workspaceNewByTurn: ['new-file.ts'],
        workspaceChangedByTurn: ['pre-existing.txt', 'new-file.ts'],
        workspaceModifiedPreExistingByTurn: ['pre-existing.txt'],
        workspaceResolvedByTurn: [],
        note: 'pre_existing=1',
      });
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-7',
        type: 'verification_profile',
        verificationProfile: 'node',
        verificationRequired: true,
        verificationCommands: ['npm run build', 'npm test -- --runInBand'],
        verificationChangedFiles: ['new-file.ts'],
        note: 'Node/TypeScript project changes detected.',
      });
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-7',
        type: 'verification_result',
        verificationCommand: 'npm run build',
        verificationPassed: true,
        outputBytes: 512,
      });
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-7',
        type: 'verification_summary',
        verificationProfile: 'node',
        verificationRequired: true,
        verificationCommands: ['npm run build'],
        verificationPassedCommands: ['npm run build'],
        verificationFailedCommands: [],
        verificationMissingCommands: ['npm test -- --runInBand'],
        verificationChangedFiles: ['new-file.ts'],
        verificationClaimAllowed: false,
        note: 'Some expected verification commands have not passed yet.',
      });
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-7',
        type: 'complete',
        finishReason: 'budget_exceeded',
        loopBudgetSource: 'config',
        loopBudgetBaseProfile: 'release',
        loopBudgetMaxLlmRequests: 96,
        loopBudgetMaxToolCalls: 360,
        loopBudgetMaxReadOnlyFragmentation: 4,
        loopBudgetMaxModelVisibleBytes: 128 * 1024,
        loopBudgetConfigOverride: true,
        budgetExceededReason: 'LLM request budget 24 reached',
        continuationActions: ['reply_continue', 'narrow_instruction', 'inspect_loop_stats', 'raise_budget'],
        continuationHint: 'Reply `继续` to continue the same objective.',
        llmRequests: 1,
        toolCalls: 1,
      });
      const ctx: CommandContext = {
        cwd,
        config,
        store,
        llm: null,
        runtime: makeRuntime() as any,
        sessionId: session.id,
        getSession: () => session,
      };

      const result = await findCommand('trace')!.execute(ctx, 'turn-7');
      const rendered = stripAnsi(logs.join('\n'));
      const storedTrace = JSON.stringify(readSessionTraceEvents(session.id));

      expect(result.success).toBe(true);
      expect(rendered).toContain('Trace turn-7');
      expect(rendered).toContain('request_start model=gpt-4o iteration=1');
      expect(rendered).toContain('provider_retry count=2 delay=1.5s last=provider_busy/529 types=rate_limit,provider_busy final=fallback-model');
      expect(rendered).toContain('provider_fallback count=1 path=primary-model->fallback-model using=yes');
      expect(rendered).toContain('prompt_assembly model=gpt-4o tokens=512/2048 core=128 evidenceBudget=400 recentBudget=300 included=1 omitted=1');
      expect(rendered).toContain('sections=core,ranked_evidence');
      expect(rendered).toContain('evidence=ledger-1:user_requirement:score=42:tokens=20');
      expect(rendered).toContain('workspace_snapshot pre_turn dirty count=1 branch=main');
      expect(rendered).toContain('checkpoint id=turn-7 saved=2 files=src/a.ts, src/b.ts');
      expect(rendered).toContain('tool_call read_file src/index.ts');
      expect(rendered).toContain('args=/artifacts show read_file-args-123 --full (4.0 KB)');
      expect(rendered).toContain('permission_decision approved read_file source=user behavior=ask 9ms');
      expect(rendered).toContain('[REDACTED_SECRET]');
      expect(rendered).not.toContain('secret-token-123456');
      expect(rendered).not.toContain('dashscope-secret-value');
      expect(storedTrace).not.toContain('secret-token-123456');
      expect(storedTrace).not.toContain('dashscope-secret-value');
      expect(rendered).toContain('tool_result ok read_file');
      expect(rendered).toContain('workspace_delta after=2 new=1 changed=2 pre-existing-modified=1 resolved=0');
      expect(rendered).toContain('new: new-file.ts');
      expect(rendered).toContain('changed: pre-existing.txt, new-file.ts');
      expect(rendered).toContain('pre-existing modified: pre-existing.txt');
      expect(rendered).toContain('verification_profile profile=node required=yes commands=2 files=1');
      expect(rendered).toContain('cmds: npm run build && npm test -- --runInBand');
      expect(rendered).toContain('verification_result passed npm run build');
      expect(rendered).toContain('verification_summary profile=node required=yes passed=1 failed=0 missing=1 claimAllowed=no');
      expect(rendered).toContain('missing: npm test -- --runInBand');
      expect(rendered).toContain('complete finish=budget_exceeded llm=1 tools=1 budgetProfile=config/release(1/96llm,1/360tools,128 KBvisible,frag=4,override=yes) budget=LLM request budget 24 reached next=reply_continue,narrow_instruction,inspect_loop_stats,raise_budget hint=Reply `继续` to continue the same objective.');
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.ORION_CODE_CONFIG_DIR;
      } else {
        process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  it('shows the latest tool details and inspection hints from /last-tool', async () => {
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config-last-tool');
    try {
      const cwd = join(root, 'packages', 'cli');
      const config = loadConfig({ apiKey: 'test-key' });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });
      const session = createSession(cwd, 'gpt-4o');
      const argsArtifact = storeArtifact(
        cwd,
        'exec_command-args',
        'cd /repo && Authorization: Bearer secret-token-123456 && npm test',
        Buffer.byteLength('cd /repo && Authorization: Bearer secret-token-123456 && npm test', 'utf8'),
      )!;
      const outputArtifact = storeArtifact(
        cwd,
        'exec_command',
        'test output\nAuthorization: Bearer secret-token-123456 failed',
        Buffer.byteLength('test output\nAuthorization: Bearer secret-token-123456 failed', 'utf8'),
      )!;
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-8',
        type: 'tool_call',
        name: 'read_file',
        callId: 'call-old',
        argsSummary: 'src/old.ts',
      });
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-8',
        type: 'tool_result',
        name: 'read_file',
        callId: 'call-old',
        success: true,
        duration: 5,
        outputBytes: 12,
        modelVisibleBytes: 12,
      });
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-9',
        type: 'tool_call',
        name: 'exec_command',
        callId: 'call-exec',
        argsSummary: 'cd /repo && Authorization: Bearer secret-token-123456 && npm test',
        argsArtifactId: argsArtifact.id,
        argsBytes: argsArtifact.outputBytes,
      });
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-9',
        type: 'tool_result',
        name: 'exec_command',
        callId: 'call-exec',
        success: false,
        duration: 1250,
        outputBytes: 50 * 1024,
        modelVisibleBytes: 1024,
        artifactId: outputArtifact.id,
        error: 'Authorization: Bearer secret-token-123456 failed',
      });
      const ctx: CommandContext = {
        cwd,
        config,
        store,
        llm: null,
        runtime: makeRuntime() as any,
        sessionId: session.id,
        getSession: () => session,
      };

      const result = await findCommand('last-tool')!.execute(ctx, '');
      const rendered = stripAnsi(logs.join('\n'));

      expect(result.success).toBe(true);
      expect(rendered).toContain('Last Tool');
      expect(rendered).toContain('Tool        exec_command');
      expect(rendered).toContain('Turn        turn-9');
      expect(rendered).toContain('Call        call-exec');
      expect(rendered).toContain('Status      error');
      expect(rendered).toContain('Time        1.3s');
      expect(rendered).toContain('Command      cd /repo && Authorization: [REDACTED_SECRET] && npm test');
      expect(rendered).toContain(`Command full /artifacts show ${argsArtifact.id} --full`);
      expect(rendered).toContain('Output      50 KB, model-visible 1.0 KB');
      expect(rendered).toContain(`Output full /artifacts show ${outputArtifact.id} --full`);
      expect(rendered).toContain('Error       Authorization: [REDACTED_SECRET] failed');
      expect(rendered).toContain('Command preview');
      expect(rendered).toContain('cd /repo && Authorization: [REDACTED_SECRET] && npm test');
      expect(rendered).toContain('Output preview');
      expect(rendered).toContain('test output');
      expect(rendered).toContain('Use /last-tool --full for redacted full previews');
      expect(rendered).not.toContain('secret-token-123456');
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.ORION_CODE_CONFIG_DIR;
      } else {
        process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  it('supports /last-tool preview controls for full and metadata-only output', async () => {
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config-last-tool-preview-controls');
    try {
      const cwd = join(root, 'packages', 'cli');
      const config = loadConfig({ apiKey: 'test-key' });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });
      const longOutput = `head\n${'x'.repeat(5000)}\ntail-marker Authorization: Bearer secret-token-123456`;
      const artifact = storeArtifact(cwd, 'exec_command', longOutput, Buffer.byteLength(longOutput, 'utf8'))!;
      const session = createSession(cwd, 'gpt-4o');
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-preview',
        type: 'tool_result',
        name: 'exec_command',
        callId: 'call-preview',
        success: true,
        duration: 10,
        outputBytes: artifact.outputBytes,
        modelVisibleBytes: 1024,
        artifactId: artifact.id,
      });
      const ctx: CommandContext = {
        cwd,
        config,
        store,
        llm: null,
        runtime: makeRuntime() as any,
        sessionId: session.id,
        getSession: () => session,
      };

      const metadataOnly = await findCommand('last-tool')!.execute(ctx, '--no-preview');
      let rendered = stripAnsi(logs.join('\n'));
      expect(metadataOnly.success).toBe(true);
      expect(rendered).toContain(`Output full /artifacts show ${artifact.id} --full`);
      expect(rendered).not.toContain('head');
      expect(rendered).not.toContain('tail-marker');

      logs = [];
      const full = await findCommand('last-tool')!.execute(ctx, '--full');
      rendered = stripAnsi(logs.join('\n'));
      expect(full.success).toBe(true);
      expect(rendered).toContain('Output preview');
      expect(rendered).toContain('head');
      expect(rendered).toContain('tail-marker Authorization: [REDACTED_SECRET]');
      expect(rendered).not.toContain('secret-token-123456');
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.ORION_CODE_CONFIG_DIR;
      } else {
        process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  it('keeps /last-tool argument labels for non-command tools', async () => {
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config-last-tool-non-command');
    try {
      const cwd = join(root, 'packages', 'cli');
      const config = loadConfig({ apiKey: 'test-key' });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });
      const session = createSession(cwd, 'gpt-4o');
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-read',
        type: 'tool_call',
        name: 'read_file',
        callId: 'call-read',
        argsSummary: 'src/index.ts',
      });
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-read',
        type: 'tool_result',
        name: 'read_file',
        callId: 'call-read',
        success: true,
        duration: 8,
        outputBytes: 512,
        modelVisibleBytes: 512,
      });
      const ctx: CommandContext = {
        cwd,
        config,
        store,
        llm: null,
        runtime: makeRuntime() as any,
        sessionId: session.id,
        getSession: () => session,
      };

      const result = await findCommand('last-tool')!.execute(ctx, '');
      const rendered = stripAnsi(logs.join('\n'));

      expect(result.success).toBe(true);
      expect(rendered).toContain('Tool        read_file');
      expect(rendered).toContain('Args         src/index.ts');
      expect(rendered).not.toContain('Command      src/index.ts');
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.ORION_CODE_CONFIG_DIR;
      } else {
        process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  it('handles /last-tool before any tool trace exists', async () => {
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config-last-tool-empty');
    try {
      const cwd = join(root, 'packages', 'cli');
      const config = loadConfig({ apiKey: 'test-key' });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });
      const session = createSession(cwd, 'gpt-4o');
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-1',
        type: 'turn_start',
        inputBytes: 4,
      });
      const ctx: CommandContext = {
        cwd,
        config,
        store,
        llm: null,
        runtime: makeRuntime() as any,
        sessionId: session.id,
        getSession: () => session,
      };

      const result = await findCommand('last-tool')!.execute(ctx, '');
      const rendered = stripAnsi(logs.join('\n'));

      expect(result.success).toBe(true);
      expect(rendered).toContain(`No tool trace events recorded for session ${session.id.slice(0, 8)} yet.`);
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.ORION_CODE_CONFIG_DIR;
      } else {
        process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  it('uses result-carried args details when /last-tool cannot find a matching tool call', async () => {
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config-last-tool-result-only');
    try {
      const cwd = join(root, 'packages', 'cli');
      const config = loadConfig({ apiKey: 'test-key' });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });
      const session = createSession(cwd, 'gpt-4o');
      appendSessionTraceEvent(session.id, {
        turnId: 'turn-result-only',
        type: 'tool_result',
        name: 'exec_command',
        callId: 'call-result-only',
        argsSummary: 'npm test -- --runInBand',
        argsArtifactId: 'exec_command-args-result-only',
        argsBytes: 2048,
        success: true,
        duration: 40,
        outputBytes: 512,
        modelVisibleBytes: 256,
      });
      const ctx: CommandContext = {
        cwd,
        config,
        store,
        llm: null,
        runtime: makeRuntime() as any,
        sessionId: session.id,
        getSession: () => session,
      };

      const result = await findCommand('last-tool')!.execute(ctx, '');
      const rendered = stripAnsi(logs.join('\n'));

      expect(result.success).toBe(true);
      expect(rendered).toContain('Tool        exec_command');
      expect(rendered).toContain('Turn        turn-result-only');
      expect(rendered).toContain('Command      npm test -- --runInBand');
      expect(rendered).toContain('Command full /artifacts show exec_command-args-result-only --full (2.0 KB)');
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.ORION_CODE_CONFIG_DIR;
      } else {
        process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  it('redacts legacy raw trace strings and marks missing complete counters unknown', async () => {
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config-legacy-trace');
    try {
      const cwd = join(root, 'packages', 'cli');
      const config = loadConfig({ apiKey: 'test-key' });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });
      const session = createSession(cwd, 'gpt-4o');
      const tracePath = getProjectSessionTracePath(session.projectPath, session.id);
      appendFileSync(tracePath, `${JSON.stringify({
        sessionId: session.id,
        turnId: 'legacy-turn',
        timestamp: Date.now(),
        type: 'tool_call',
        name: 'exec_command',
        callId: 'legacy-call',
        argsSummary: 'curl -H "Authorization: Bearer secret-token-123456" https://example.test',
      })}\n`);
      appendFileSync(tracePath, `${JSON.stringify({
        sessionId: session.id,
        turnId: 'legacy-turn',
        timestamp: Date.now(),
        type: 'permission_decision',
        name: 'exec_command',
        callId: 'legacy-call',
        permissionApproved: false,
        permissionSource: 'user',
        permissionBehavior: 'ask',
        permissionReason: 'apiKey=dashscope-secret-value',
      })}\n`);
      appendFileSync(tracePath, `${JSON.stringify({
        sessionId: session.id,
        turnId: 'legacy-turn',
        timestamp: Date.now(),
        type: 'complete',
        finishReason: 'completed',
      })}\n`);
      const ctx: CommandContext = {
        cwd,
        config,
        store,
        llm: null,
        runtime: makeRuntime() as any,
        sessionId: session.id,
        getSession: () => session,
      };

      const result = await findCommand('trace')!.execute(ctx, 'legacy-turn');
      const rendered = stripAnsi(logs.join('\n'));
      const readBack = JSON.stringify(readSessionTraceEvents(session.id));

      expect(result.success).toBe(true);
      expect(rendered).toContain('[REDACTED_SECRET]');
      expect(rendered).not.toContain('secret-token-123456');
      expect(rendered).not.toContain('dashscope-secret-value');
      expect(readBack).not.toContain('secret-token-123456');
      expect(readBack).not.toContain('dashscope-secret-value');
      expect(rendered).toContain('complete finish=completed llm=unknown tools=unknown');
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.ORION_CODE_CONFIG_DIR;
      } else {
        process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  it('lists and previews saved tool artifacts', async () => {
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');
    try {
      const cwd = join(root, 'packages', 'cli');
      const config = loadConfig({ apiKey: 'test-key' });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });
      const artifact = storeArtifact(cwd, 'exec_command', 'full command output', Buffer.byteLength('full command output', 'utf8'))!;
      const ctx: CommandContext = {
        cwd,
        config,
        store,
        llm: null,
        runtime: makeRuntime() as any,
      };

      const listResult = await findCommand('artifacts')!.execute(ctx, '');
      let rendered = stripAnsi(logs.join('\n'));
      expect(listResult.success).toBe(true);
      expect(rendered).toContain('Artifacts');
      expect(rendered).toContain(artifact.id);
      expect(rendered).toContain(artifact.path);

      logs = [];
      const showResult = await findCommand('artifacts')!.execute(ctx, `show ${artifact.id}`);
      rendered = stripAnsi(logs.join('\n'));
      expect(showResult.success).toBe(true);
      expect(rendered).toContain(`Artifact ${artifact.id}`);
      expect(rendered).toContain('full command output');
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.ORION_CODE_CONFIG_DIR;
      } else {
        process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  it('redacts secret-like values from artifact indexes and headers', async () => {
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config-sk-secretvalue123456');
    try {
      const cwd = join(root, 'packages', 'cli');
      const config = loadConfig({ apiKey: 'test-key' });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });
      const artifact = storeArtifact(
        cwd,
        'exec_command-Bearer-sk-secretvalue123456',
        'safe artifact output',
        Buffer.byteLength('safe artifact output', 'utf8'),
      )!;
      expect(artifact.path).toContain('sk-secretvalue123456');
      expect(artifact.id).not.toContain('sk-secretvalue123456');
      const ctx: CommandContext = {
        cwd,
        config,
        store,
        llm: null,
        runtime: makeRuntime() as any,
      };

      const listResult = await findCommand('artifacts')!.execute(ctx, '');
      let rendered = stripAnsi(logs.join('\n'));
      expect(listResult.success).toBe(true);
      expect(rendered).toContain(artifact.id);
      expect(rendered).toContain('[REDACTED_SECRET]');
      expect(rendered).not.toContain('sk-secretvalue123456');
      expect(rendered).not.toContain('Bearer-sk-secretvalue123456');

      logs = [];
      const showResult = await findCommand('artifacts')!.execute(ctx, `show ${artifact.id}`);
      rendered = stripAnsi(logs.join('\n'));
      expect(showResult.success).toBe(true);
      expect(rendered).toContain('safe artifact output');
      expect(rendered).toContain('[REDACTED_SECRET]');
      expect(rendered).not.toContain('sk-secretvalue123456');
      expect(rendered).not.toContain('Bearer-sk-secretvalue123456');
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.ORION_CODE_CONFIG_DIR;
      } else {
        process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  it('lists and restores file checkpoints with explicit confirmation', async () => {
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config-checkpoints');
    try {
      const cwd = join(root, 'packages', 'cli');
      const target = join(cwd, 'restore-me.txt');
      writeFileSync(target, 'before\n', 'utf-8');
      const checkpoint = createCheckpoint(cwd, 'turn-restore', [target])!;
      writeFileSync(target, 'after\n', 'utf-8');
      const config = loadConfig({ apiKey: 'test-key' });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });
      const ctx: CommandContext = {
        cwd,
        config,
        store,
        llm: null,
        runtime: makeRuntime() as any,
      };

      const listResult = await findCommand('checkpoint')!.execute(ctx, '');
      let rendered = stripAnsi(logs.join('\n'));
      expect(listResult.success).toBe(true);
      expect(rendered).toContain('Checkpoints');
      expect(rendered).toContain(checkpoint.turnId);
      expect(rendered).toContain('restore-me.txt');

      logs = [];
      const previewResult = await findCommand('checkpoint')!.execute(ctx, 'restore turn-rest');
      rendered = stripAnsi(logs.join('\n'));
      expect(previewResult.success).toBe(true);
      expect(rendered).toContain('This will overwrite current files');
      expect(readFileSync(target, 'utf-8')).toBe('after\n');

      logs = [];
      const restoreResult = await findCommand('checkpoint')!.execute(ctx, 'restore turn-rest --yes');
      rendered = stripAnsi(logs.join('\n'));
      expect(restoreResult.success).toBe(true);
      expect(rendered).toContain('Restored 1 file(s)');
      expect(readFileSync(target, 'utf-8')).toBe('before\n');
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.ORION_CODE_CONFIG_DIR;
      } else {
        process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      }
    }
  });
});
