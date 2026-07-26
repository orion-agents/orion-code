import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentRuntimeController, type AgentRuntimeRunner } from '../src/runtime/agent-runtime-controller';
import {
  type AgentRuntimeEvent,
  createAgentRuntimeEventSinkFromUiEvents,
  createUiEventSinkFromAgentRuntimeEvents,
} from '../src/runtime/agent-runtime-protocol';
import { AgentChatController, createToolEventPresenter } from '../src/runtime/chat-controller';
import {
  resolveUiRendererCapabilities,
  type OpenHorseUiRuntime,
  type TranscriptAppendEntry,
  type UiEventSink,
} from '../src/runtime/ui-events';
import {
  appendSessionMessage,
  appendSessionMessages,
  createSession,
  loadSessionCompactCheckpoint,
  loadSessionHistory,
  readSessionMessages,
  readSessionTraceEvents,
  updateSessionHarnessState,
  type SessionMeta,
} from '../src/services/session-storage';
import { Store } from '../src/framework/store';
import { TOOLS } from '../src/tools';
import { loadConfig } from '../src/services/config';
import { listArtifacts, retrieveArtifact } from '../src/core/tool-artifacts';
import { listCheckpoints } from '../src/core/checkpoint';
import { createContextHarness } from '../src/harness';
import { CompactCoordinator } from '../src/services/compact/coordinator';
import { findCommand } from '../src/commands';
import type { CommandContext } from '../src/commands/types';
import { makeToolStartedEvent, makeToolFinishedEvent, resetToolEventSequence } from './test-helpers';

const stripAnsi = (text: string): string => text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

function createRuntime(overrides: Partial<OpenHorseUiRuntime> = {}): OpenHorseUiRuntime {
  return {
    cwd: '/tmp/openhorse',
    version: 'test',
    config: { model: 'test-model' } as OpenHorseUiRuntime['config'],
    store: {
      setProcessing: jest.fn(),
    } as unknown as OpenHorseUiRuntime['store'],
    llm: null,
    runtime: {} as OpenHorseUiRuntime['runtime'],
    isConfigured: true,
    ensureSession: jest.fn(),
    setSession: jest.fn(),
    getSession: jest.fn(() => null),
    shutdown: jest.fn(),
    ...overrides,
  };
}

function createEvents() {
  const appended: TranscriptAppendEntry[] = [];
  const statuses: string[] = [];
  const processing: boolean[] = [];
  const loopStats: unknown[] = [];
  const traceEvents: unknown[] = [];
  const harnessDiagnostics: unknown[] = [];
  const sessionRestoredEvents: unknown[] = [];
  const events: UiEventSink = {
    append: jest.fn(entry => {
      appended.push(entry);
      return `entry-${appended.length}`;
    }),
    update: jest.fn(),
    finalize: jest.fn(),
    remove: jest.fn(),
    replaceTranscript: jest.fn(),
    clearTranscript: jest.fn(),
    setStatus: jest.fn(message => statuses.push(message)),
    showSessionPicker: jest.fn(),
    showEditPreview: jest.fn(),
    toolStarted: jest.fn(),
    toolFinished: jest.fn(),
    sessionRestored: jest.fn(event => sessionRestoredEvents.push(event)),
    loopStatsUpdated: jest.fn(stats => loopStats.push(stats)),
    traceEventRecorded: jest.fn(event => traceEvents.push(event)),
    harnessDiagnosticsUpdated: jest.fn(diagnostics => harnessDiagnostics.push(diagnostics)),
    setProcessing: jest.fn(value => processing.push(value)),
  };

  return { events, appended, statuses, processing, loopStats, traceEvents, harnessDiagnostics, sessionRestoredEvents };
}

function createDeferredRunner(): AgentRuntimeRunner & {
  calls: Array<{ input: string; signal?: AbortSignal; resolve: () => void; reject: (error: unknown) => void }>;
} {
  const calls: Array<{ input: string; signal?: AbortSignal; resolve: () => void; reject: (error: unknown) => void }> = [];
  return {
    calls,
    runInput: jest.fn((input, options) => new Promise<void>((resolve, reject) => {
      calls.push({ input, signal: options?.abortSignal, resolve, reject });
    })),
  };
}

async function withTempConfig<T>(fn: (paths: { configDir: string; projectDir: string }) => Promise<T> | T): Promise<T> {
  const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
  const root = mkdtempSync(join(tmpdir(), 'openhorse-runtime-test-'));
  const configDir = join(root, 'config');
  const projectDir = join(root, 'project');

  process.env.ORION_CODE_CONFIG_DIR = configDir;
  try {
    return await fn({ configDir, projectDir });
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.ORION_CODE_CONFIG_DIR;
    } else {
      process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function createRestorableSession(projectDir: string, content: string): SessionMeta {
  const session = createSession(projectDir, 'test-model');
  appendSessionMessage(session.id, {
    role: 'user',
    content,
    timestamp: Date.now(),
  });
  return session;
}

describe('AgentRuntimeController', () => {
  it('resolves UI renderer capabilities from runtime renderer names and adapter overrides', () => {
    expect(resolveUiRendererCapabilities()).toEqual({
      structuredPickers: true,
      inlineProgress: true,
      suppressLegacyTokenMeta: true,
      extraAssistantSpacing: true,
      suppressAbortNotice: true,
    });
    expect(resolveUiRendererCapabilities(undefined, 'terminal')).toEqual({
      structuredPickers: true,
      inlineProgress: true,
      suppressLegacyTokenMeta: true,
      extraAssistantSpacing: true,
      suppressAbortNotice: true,
    });
    expect(resolveUiRendererCapabilities(undefined, 'legacy')).toEqual(expect.objectContaining({
      structuredPickers: true,
      inlineProgress: true,
    }));
    expect(resolveUiRendererCapabilities(undefined, 'v2')).toEqual(expect.objectContaining({
      structuredPickers: true,
      inlineProgress: true,
    }));
    expect(resolveUiRendererCapabilities(undefined, 'print')).toEqual({
      structuredPickers: false,
      inlineProgress: false,
      suppressLegacyTokenMeta: false,
      extraAssistantSpacing: false,
      suppressAbortNotice: false,
    });
    expect(resolveUiRendererCapabilities({ structuredPickers: false }, 'terminal')).toEqual(expect.objectContaining({
      structuredPickers: false,
      inlineProgress: true,
    }));
  });

  it('uses structured resume pickers when the renderer adapter supports them', async () => {
    await withTempConfig(async ({ projectDir }) => {
      createRestorableSession(projectDir, 'older task');
      createRestorableSession(projectDir, 'newer task');

      const runtime = createRuntime({ cwd: projectDir });
      const { events, appended } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await controller.runInput('/resume');

      expect(events.showSessionPicker).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Pick a Session',
        sessions: expect.arrayContaining([
          expect.objectContaining({ projectPath: projectDir }),
        ]),
        maxVisibleItems: 10,
      }));
      expect(appended).toEqual([]);
    });
  });

  it('falls back to textual resume instructions when structured pickers are disabled', async () => {
    await withTempConfig(async ({ projectDir }) => {
      createRestorableSession(projectDir, 'older task');
      createRestorableSession(projectDir, 'newer task');

      const runtime = createRuntime({ cwd: projectDir });
      const { events, appended } = createEvents();
      const controller = new AgentChatController(runtime, events, {
        uiCapabilities: { structuredPickers: false },
      });

      await controller.runInput('/resume');

      expect(events.showSessionPicker).not.toHaveBeenCalled();
      expect(appended).toEqual([
        expect.objectContaining({
          role: 'system',
          title: '/resume',
          content: expect.stringContaining('Use /resume <number|session-id|name> or /resume --last.'),
        }),
      ]);
    });
  });

  it('continues from restored compact harness state after resume', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const rootObjective = '实现 agent-loop final form，确保 compact/resume 后继续正确目标';
      const activeInstruction = '补齐 compact/resume fixture 并保持 root objective';
      const harness = createContextHarness({ cwd: projectDir, modelId: 'test-model' });
      harness.updateContractFromUserInput(rootObjective);
      harness.updateContractFromUserInput(activeInstruction);
      const harnessState = harness.toJSON();
      const oldHiddenAssistant = 'RAW_ASSISTANT_TRANSCRIPT_SHOULD_NOT_BE_RESTORED';
      const history = [
        { role: 'user' as const, content: '旧问题 A' },
        { role: 'assistant' as const, content: oldHiddenAssistant },
        { role: 'user' as const, content: '旧问题 B' },
        { role: 'assistant' as const, content: '旧回答 B' },
        { role: 'user' as const, content: '最近问题 C' },
        { role: 'assistant' as const, content: '最近回答 C' },
      ];
      store.setState({
        conversationHistory: history,
        harnessState,
      });

      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async (
          messages: Array<{ role: string; content: string }>,
          callbacks?: { onChunk?: (chunk: string) => void },
        ) => {
          callbacks?.onChunk?.('继续处理 compact/resume');
          return {
            content: '继续处理 compact/resume',
            model: 'test-model',
            usage: { promptTokens: 100, completionTokens: 10 },
          };
        }),
      };
      let session = createSession(projectDir, 'test-model');
      appendSessionMessages(session.id, history.map((message, index) => ({
        ...message,
        timestamp: Date.now() - 10_000 + index,
      })));
      updateSessionHarnessState(session.id, harnessState);

      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => session),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          if (nextSession) session = nextSession;
        }),
      });
      const { events } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('/compact 2')).resolves.toBeUndefined();
      const persistedAfterCompact = readSessionMessages(session.id);
      expect(persistedAfterCompact).toHaveLength(history.length);
      expect(loadSessionCompactCheckpoint(session.id)).not.toBeNull();

      await expect(controller.runInput(`/resume ${session.id}`)).resolves.toBeUndefined();
      expect(store.getSnapshot().conversationHistory.map(message => message.content).join('\n'))
        .not.toContain(oldHiddenAssistant);

      await expect(controller.runInput('继续', { turnId: 'turn-resume-continue' })).resolves.toBeUndefined();

      expect(llm.chatStream).toHaveBeenCalledTimes(1);
      const modelMessages = (llm.chatStream as jest.Mock).mock.calls[0][0] as Array<{ role: string; content: string }>;
      const modelContext = modelMessages.map(message => message.content).join('\n');
      expect(modelContext).toContain(rootObjective);
      expect(modelContext).toContain(activeInstruction);
      expect(modelContext).toContain('[Orion Code Context State v2]');
      expect(modelContext).not.toContain(oldHiddenAssistant);
      expect(store.getSnapshot().harnessState).toMatchObject({
        rootObjective,
        activeInstruction,
      });
    });
  });

  it('persists automatic compact context and reuses it after runtime restart', async () => {
    await withTempConfig(async ({ projectDir }) => {
      const config = loadConfig({ apiKey: 'test-key', model: 'test-model' });
      const oldHiddenMessage = `old-hidden-${'x'.repeat(16000)}`;
      const history = Array.from({ length: 30 }, (_, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: index === 0 ? oldHiddenMessage : `large-${index}-${'x'.repeat(16000)}`,
      }));
      const session = createSession(projectDir, 'test-model');
      appendSessionMessages(
        session.id,
        history.map((message, index) => ({ ...message, timestamp: 1000 + index }))
      );
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        getMaxTokens: jest.fn(() => 8192),
        chat: jest.fn(async () => ({ content: 'durable automatic summary', model: 'test-model' })),
        chatStream: jest.fn(async () => ({
          content: 'automatic compact answer',
          model: 'test-model',
          usage: { promptTokens: 90000, completionTokens: 20 },
        })),
      };
      const makeRuntimeWithStore = (store: Store) => {
        const coordinator = new CompactCoordinator({
          modelId: 'test-model',
          llm: llm as any,
          outputReserveTokens: 8192,
        });
        return createRuntime({
          cwd: projectDir,
          config,
          store,
          llm: llm as any,
          compactCoordinator: coordinator,
          isConfigured: true,
          ensureSession: jest.fn(() => session),
          getSession: jest.fn(() => session),
          setSession: jest.fn(),
        });
      };
      const firstStore = new Store({ config, tools: TOOLS, currentModel: 'test-model' });
      firstStore.setState({ conversationHistory: history });
      const firstController = new AgentChatController(
        makeRuntimeWithStore(firstStore),
        createEvents().events
      );

      await firstController.runInput('trigger automatic compact', { turnId: 'auto-compact-turn' });

      const checkpoint = loadSessionCompactCheckpoint(session.id);
      expect(checkpoint).not.toBeNull();
      expect(checkpoint?.mode).toBe('predictive');
      expect(readSessionMessages(session.id)).toHaveLength(32);
      expect(firstStore.getSnapshot().conversationHistory).toEqual(checkpoint?.modelHistory);
      expect(loadSessionHistory(session.id).map(message => message.content).join('\n'))
        .not.toContain(oldHiddenMessage);

      const restartedStore = new Store({ config, tools: TOOLS, currentModel: 'test-model' });
      const restartedRuntime = makeRuntimeWithStore(restartedStore);
      const restartedController = new AgentChatController(
        restartedRuntime,
        createEvents().events
      );
      await restartedController.runInput(`/resume ${session.id}`);
      expect(restartedStore.getSnapshot().conversationHistory).toEqual(checkpoint?.modelHistory);

      await restartedController.runInput('continue after restart', { turnId: 'after-restart' });
      const resumedRequest = (llm.chatStream as jest.Mock).mock.calls.at(-1)?.[0] as Array<{
        content: string;
      }>;
      expect(resumedRequest.map(message => message.content).join('\n')).not.toContain(
        oldHiddenMessage
      );
    });
  });

  it('routes /skill commands and absolute path prompts through chat', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async (
          messages: Array<{ role: string; content: string }>,
          callbacks?: { onChunk?: (chunk: string) => void },
          tools?: Array<{ function: { name: string } }>,
        ) => {
          callbacks?.onChunk?.('done');
          return {
            content: 'done',
            model: 'test-model',
            usage: { promptTokens: 10, completionTokens: 2 },
          };
        }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, appended } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('/skill code-review inspect src')).resolves.toBeUndefined();

      expect(llm.chatStream).toHaveBeenCalled();
      const [messages, , scopedTools] = llm.chatStream.mock.calls[0];
      const systemPrompt = messages
        .filter((message: { role: string }) => message.role === 'system')
        .map((message: { content: string }) => message.content)
        .join('\n');
      expect(systemPrompt).toContain('## Active Skills');
      expect(systemPrompt).toContain('# Code Review Skill');
      expect(scopedTools).toBeDefined();
      expect(scopedTools!.map((tool: { function: { name: string } }) => tool.function.name).sort())
        .toEqual(['glob', 'grep', 'read_file']);

      const pathPrompt = '/Users/hope/linux2010/my-skills/vendor/skills 做啥的？';
      await expect(controller.runInput(pathPrompt)).resolves.toBeUndefined();

      expect(llm.chatStream).toHaveBeenCalledTimes(2);
      const [pathMessages] = llm.chatStream.mock.calls[1];
      expect(pathMessages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: pathPrompt }),
      ]));
      expect(appended).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'error', content: expect.stringContaining('Unknown command') }),
      ]));
    });
  });

  it('redacts secret-like text from harness diagnostics protocol events', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async () => ({
          content: 'done',
          model: 'test-model',
          usage: { promptTokens: 10, completionTokens: 2 },
        })),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, harnessDiagnostics } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput(
        'Use OPENAI_API_KEY=sk-secretvalue123456 and Authorization: Bearer token-secret-123456 to test diagnostics',
      )).resolves.toBeUndefined();

      const serialized = JSON.stringify(harnessDiagnostics);
      expect(serialized).toContain('[REDACTED_SECRET]');
      expect(serialized).not.toContain('sk-secretvalue123456');
      expect(serialized).not.toContain('token-secret-123456');
    });
  });

  it('runs explicit local read fast path without calling the LLM', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'package.json'), '{"name":"demo"}', 'utf-8');
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async () => ({ content: 'should not run', model: 'test-model' })),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, appended, statuses, loopStats, traceEvents } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('read package.json', { turnId: 'turn-fast' })).resolves.toBeUndefined();

      expect(llm.chatStream).not.toHaveBeenCalled();
      expect(appended).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          title: 'local',
          content: expect.stringContaining('read package.json'),
        }),
      ]));
      expect(statuses).toContain('Completed local read package.json');
      expect(store.getSnapshot().lastLoopStats).toMatchObject({
        localFastPathUsed: true,
        llmRequests: 0,
        toolCalls: 1,
        readOnlyToolCalls: 1,
      });
      expect(loopStats.at(-1)).toMatchObject({
        localFastPathUsed: true,
        llmRequests: 0,
        toolCalls: 1,
      });
      expect(session).not.toBeNull();
      expect(readSessionMessages(session!.id).map(message => message.role)).toEqual(['user', 'assistant']);
      expect(readSessionTraceEvents(session!.id).map(event => event.type)).toEqual([
        'turn_start',
        'workspace_snapshot',
        'local_fast_path',
        'tool_call',
        'tool_result',
        'workspace_snapshot',
        'workspace_delta',
        'complete',
      ]);
      expect(readSessionTraceEvents(session!.id).at(-1)).toMatchObject({
        turnId: 'turn-fast',
        type: 'complete',
        localFastPathUsed: true,
        llmRequests: 0,
        toolCalls: 1,
      });
      expect(traceEvents.map(event => (event as { type?: string }).type)).toEqual([
        'turn_start',
        'workspace_snapshot',
        'local_fast_path',
        'tool_call',
        'tool_result',
        'workspace_snapshot',
        'workspace_delta',
        'complete',
      ]);
    });
  });

  it('keeps large local fast path output compact in assistant history', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'large.txt'), 'x'.repeat(5000), 'utf-8');
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async () => ({ content: 'should not run', model: 'test-model' })),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('read large.txt', { turnId: 'turn-large-fast' })).resolves.toBeUndefined();

      expect(llm.chatStream).not.toHaveBeenCalled();
      expect(session).not.toBeNull();
      const assistantContent = readSessionMessages(session!.id).at(-1)?.content ?? '';
      expect(Buffer.byteLength(assistantContent, 'utf8')).toBeLessThan(3500);
      expect(assistantContent).toContain('Full output: /artifacts show');
      expect(assistantContent).toContain('Preview:');
      expect(listArtifacts(projectDir)).toHaveLength(1);
    });
  });

  it('does not fast-path ambiguous natural-language read requests', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async () => ({
          content: 'done',
          model: 'test-model',
          usage: { promptTokens: 10, completionTokens: 2 },
        })),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, appended } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('read both files')).resolves.toBeUndefined();

      expect(llm.chatStream).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot().lastLoopStats?.localFastPathUsed).toBe(false);
    });
  });

  it('blocks destructive local run-test fast path commands', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async () => ({ content: 'should not run', model: 'test-model' })),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, appended } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('run test: rm -rf /tmp/openhorse-fast-path-danger')).resolves.toBeUndefined();

      expect(llm.chatStream).not.toHaveBeenCalled();
      expect(appended).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'error',
          title: 'local',
          content: expect.stringContaining('destructive'),
        }),
      ]));
      expect(store.getSnapshot().conversationHistory.map(message => message.role)).toEqual(['user', 'assistant']);
      expect(store.getSnapshot().lastLoopStats).toMatchObject({
        finishReason: 'blocked',
        localFastPathUsed: true,
        llmRequests: 0,
        toolCalls: 0,
      });
      expect(session).not.toBeNull();
      expect(readSessionTraceEvents(session!.id).at(-1)).toMatchObject({
        type: 'complete',
        finishReason: 'blocked',
        localFastPathUsed: true,
      });
    });
  });

  it('marks failed local run-test fast paths as failed instead of completed', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async () => ({ content: 'should not run', model: 'test-model' })),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, appended, statuses, loopStats } = createEvents();
      const controller = new AgentChatController(runtime, events);
      const command = 'grep definitely-missing missing-file.txt';

      await expect(controller.runInput(`run test: ${command}`, { turnId: 'turn-fast-fail' }))
        .resolves.toBeUndefined();

      expect(llm.chatStream).not.toHaveBeenCalled();
      expect(appended).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'error',
          title: 'local',
          content: expect.stringContaining('Command exited with code'),
        }),
      ]));
      expect(statuses).toContain(`Failed local run test: ${command}`);
      expect(store.getSnapshot().conversationHistory.map(message => message.role)).toEqual([
        'user',
        'assistant',
      ]);
      expect(store.getSnapshot().lastLoopStats).toMatchObject({
        finishReason: 'failed',
        localFastPathUsed: true,
        llmRequests: 0,
        toolCalls: 1,
        unsafeToolCalls: 1,
      });
      expect(loopStats.at(-1)).toMatchObject({
        finishReason: 'failed',
        localFastPathUsed: true,
        llmRequests: 0,
        toolCalls: 1,
      });
      expect(session).not.toBeNull();
      const traceEvents = readSessionTraceEvents(session!.id);
      expect(traceEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_result',
          turnId: 'turn-fast-fail',
          name: 'exec_command',
          success: false,
        }),
        expect.objectContaining({
          type: 'complete',
          turnId: 'turn-fast-fail',
          finishReason: 'failed',
          localFastPathUsed: true,
          llmRequests: 0,
          toolCalls: 1,
        }),
      ]));
      expect(readSessionMessages(session!.id).at(-1)?.content).toContain('failed');
    });
  });

  it('persists budget exhaustion continuation guidance through the chat runtime', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'target.txt'), 'context', 'utf-8');
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
        agentLoop: {
          budget: {
            maxLlmRequestsPerUserTurn: 1,
          },
        },
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn()
          .mockResolvedValueOnce({
            content: '',
            model: 'test-model',
            toolCalls: [
              {
                id: 'call-read',
                type: 'function' as const,
                function: { name: 'read_file', arguments: '{"path":"target.txt"}' },
              },
            ],
            usage: { promptTokens: 10, completionTokens: 1 },
          })
          .mockResolvedValueOnce({
            content: 'should not run',
            model: 'test-model',
          }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, appended, loopStats, traceEvents } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('read repeatedly', { turnId: 'turn-budget' }))
        .resolves.toBeUndefined();

      expect(llm.chatStream).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot().lastLoopStats).toMatchObject({
        finishReason: 'budget_exceeded',
        budgetExceededReason: 'LLM request budget 1 reached',
        llmRequests: 1,
        toolCalls: 1,
        loopBudgetSource: 'config',
        loopBudgetBaseProfile: 'default',
        loopBudgetMaxLlmRequests: 1,
        continuationActions: [
          'reply_continue',
          'narrow_instruction',
          'inspect_loop_stats',
          'raise_budget',
        ],
      });
      expect(store.getSnapshot().lastLoopStats?.continuationHint).toContain('Reply `继续`');
      expect(loopStats.at(-1)).toMatchObject({
        finishReason: 'budget_exceeded',
        budgetExceededReason: 'LLM request budget 1 reached',
        loopBudgetSource: 'config',
        continuationActions: [
          'reply_continue',
          'narrow_instruction',
          'inspect_loop_stats',
          'raise_budget',
        ],
      });
      expect(session).not.toBeNull();
      const messages = readSessionMessages(session!.id);
      expect(messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: expect.stringContaining('Agent loop budget reached'),
      });
      expect(messages.at(-1)?.content).toContain('preserved the current session state');
      expect(messages.at(-1)?.content).toContain('reply `继续`');
      expect(messages.at(-1)?.content).toContain('raise agentLoop.budget');
      const persistedTrace = readSessionTraceEvents(session!.id);
      expect(persistedTrace).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'complete',
          turnId: 'turn-budget',
          finishReason: 'budget_exceeded',
          budgetExceededReason: 'LLM request budget 1 reached',
          continuationActions: [
            'reply_continue',
            'narrow_instruction',
            'inspect_loop_stats',
            'raise_budget',
          ],
          continuationHint: expect.stringContaining('Reply `继续`'),
          llmRequests: 1,
          toolCalls: 1,
        }),
      ]));
      expect(traceEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'complete',
          turnId: 'turn-budget',
          finishReason: 'budget_exceeded',
          continuationActions: [
            'reply_continue',
            'narrow_instruction',
            'inspect_loop_stats',
            'raise_budget',
          ],
        }),
      ]));
      const budgetNotice = appended.find(entry => entry.role === 'status' && entry.title === 'budget');
      expect(budgetNotice).toBeDefined();
      expect(budgetNotice?.content).toContain('Loop budget reached');
      expect(budgetNotice?.content).toContain('Progress:');
      expect(budgetNotice?.content).toContain('Next:');
    });
  });

  it('stops before executing tools when tool-call budget would be exceeded', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'one.txt'), 'one', 'utf-8');
      writeFileSync(join(projectDir, 'two.txt'), 'two', 'utf-8');
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
        agentLoop: {
          budget: {
            maxToolCallsPerUserTurn: 1,
          },
        },
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async (_messages: unknown, callbacks?: { onChunk?: (chunk: string) => void }) => {
          callbacks?.onChunk?.('Need two files');
          return {
            content: 'Need two files',
            model: 'test-model',
            toolCalls: [
              {
                id: 'call-one',
                type: 'function' as const,
                function: { name: 'read_file', arguments: '{"path":"one.txt"}' },
              },
              {
                id: 'call-two',
                type: 'function' as const,
                function: { name: 'read_file', arguments: '{"path":"two.txt"}' },
              },
            ],
            usage: { promptTokens: 10, completionTokens: 1 },
          };
        }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, loopStats, traceEvents } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('read both files', { turnId: 'turn-tool-budget' }))
        .resolves.toBeUndefined();

      expect(llm.chatStream).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot().lastLoopStats).toMatchObject({
        finishReason: 'budget_exceeded',
        budgetExceededReason: 'tool call budget 1 would be exceeded by 2 requested tools',
        llmRequests: 1,
        toolCalls: 0,
        loopBudgetSource: 'config',
        loopBudgetMaxToolCalls: 1,
        continuationActions: [
          'reply_continue',
          'narrow_instruction',
          'inspect_loop_stats',
          'raise_budget',
        ],
      });
      expect(loopStats.at(-1)).toMatchObject({
        finishReason: 'budget_exceeded',
        budgetExceededReason: 'tool call budget 1 would be exceeded by 2 requested tools',
        toolCalls: 0,
        continuationActions: [
          'reply_continue',
          'narrow_instruction',
          'inspect_loop_stats',
          'raise_budget',
        ],
      });
      expect(session).not.toBeNull();
      const messages = readSessionMessages(session!.id);
      expect(messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: expect.stringContaining('Agent loop budget reached'),
      });
      expect(messages.at(-1)?.content).toContain('reply `继续`');
      expect(events.update).toHaveBeenLastCalledWith(expect.any(String), {
        content: expect.stringContaining('Agent loop budget reached'),
      });
      const persistedTrace = readSessionTraceEvents(session!.id);
      expect(persistedTrace.some(event => event.type === 'assistant_tool_calls')).toBe(false);
      expect(persistedTrace.some(event => event.type === 'tool_call')).toBe(false);
      expect(persistedTrace.some(event => event.type === 'tool_result')).toBe(false);
      expect(persistedTrace).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'complete',
          turnId: 'turn-tool-budget',
          finishReason: 'budget_exceeded',
          budgetExceededReason: 'tool call budget 1 would be exceeded by 2 requested tools',
          continuationActions: [
            'reply_continue',
            'narrow_instruction',
            'inspect_loop_stats',
            'raise_budget',
          ],
          llmRequests: 1,
          toolCalls: 0,
        }),
      ]));
      expect(traceEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'complete',
          turnId: 'turn-tool-budget',
          finishReason: 'budget_exceeded',
          toolCalls: 0,
        }),
      ]));
    });
  });

  it('stores expandable full args artifacts for compacted local exec trace entries', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async () => ({ content: 'should not run', model: 'test-model' })),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events } = createEvents();
      const controller = new AgentChatController(runtime, events);
      const longFlag = `--filter=${'trace-command-argument-'.repeat(12)}`;
      const command = `grep trace-command ${longFlag} missing-file.txt`;

      await expect(controller.runInput(`run test: ${command}`, { turnId: 'turn-long-command' })).resolves.toBeUndefined();

      expect(llm.chatStream).not.toHaveBeenCalled();
      expect(session).not.toBeNull();
      const traceEvents = readSessionTraceEvents(session!.id);
      const toolCall = traceEvents.find(event => event.type === 'tool_call' && event.name === 'exec_command');
      expect(toolCall).toMatchObject({
        type: 'tool_call',
        argsSummary: expect.stringContaining('grep trace-command'),
        argsArtifactId: expect.any(String),
        argsBytes: expect.any(Number),
      });

      const artifact = listArtifacts(projectDir).find(item => item.id === toolCall!.argsArtifactId);
      expect(artifact).toBeDefined();
      const content = retrieveArtifact(artifact!.path);
      expect(content).toContain(`$ ${command}`);
      expect(content).toContain(longFlag);
      expect(content).not.toContain('[... ');
    });
  });

  it('records local fast-path output artifacts in tool events and trace', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'large-output.txt'), `${'local-fast-path-output\n'.repeat(160)}`, 'utf-8');
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async () => ({ content: 'should not run', model: 'test-model' })),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, appended } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('read large-output.txt', { turnId: 'turn-large-local-output' })).resolves.toBeUndefined();

      expect(llm.chatStream).not.toHaveBeenCalled();
      expect(session).not.toBeNull();
      expect(appended.at(-1)).toMatchObject({
        role: 'tool',
        content: expect.stringContaining('Full output: /artifacts show read_file-'),
      });
      expect(appended.at(-1)?.content).toContain('--full (3.6 KB)');

      const traceEvents = readSessionTraceEvents(session!.id);
      const toolResult = traceEvents.find(event => event.type === 'tool_result' && event.name === 'read_file');
      expect(toolResult).toMatchObject({
        type: 'tool_result',
        artifactId: expect.stringMatching(/^read_file-/),
        outputBytes: expect.any(Number),
        modelVisibleBytes: 0,
      });

      const artifact = listArtifacts(projectDir).find(item => item.id === toolResult!.artifactId);
      expect(artifact).toBeDefined();
      const content = retrieveArtifact(artifact!.path);
      expect(content).toContain('local-fast-path-output');
      expect(content).toBe(`${'local-fast-path-output\n'.repeat(160)}`);
      expect(Buffer.byteLength(content!, 'utf8')).toBe(toolResult!.outputBytes);
    });
  });

  it('derives command UI capabilities from the active renderer when no explicit override is supplied', async () => {
    await withTempConfig(async ({ projectDir }) => {
      const config = loadConfig({ apiKey: 'test-key', model: 'test-model' });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        runtime: ({
          brain: {
            getStatus: () => ({ agents: [], pendingTasks: 0, strategy: 'sequential' }),
          },
          memory: {
            getStatus: () => ({ working: 0, 'short-term': 0, 'long-term': 0 }),
          },
          store: {
            getStats: () => ({ working: 0, 'short-term': 0, 'long-term': 0 }),
          },
        } as unknown) as OpenHorseUiRuntime['runtime'],
      });
      const { events, appended } = createEvents();
      const controller = new AgentRuntimeController({
        runtime,
        events,
        uiRenderer: 'print',
      });

      expect(controller.submit('/status')).toEqual({ type: 'started' });
      await controller.waitForIdle();

      const status = appended.map(entry => entry.content).join('\n');
      expect(status).toContain('Renderer   print non-interactive');
      expect(status).toContain('text-pickers, legacy-progress, legacy-meta, compact-spacing, abort-notice');
    });
  });

  it('derives command UI capabilities from nested chat renderer options', async () => {
    await withTempConfig(async ({ projectDir }) => {
      const config = loadConfig({ apiKey: 'test-key', model: 'test-model' });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        runtime: ({
          brain: {
            getStatus: () => ({ agents: [], pendingTasks: 0, strategy: 'sequential' }),
          },
          memory: {
            getStatus: () => ({ working: 0, 'short-term': 0, 'long-term': 0 }),
          },
          store: {
            getStats: () => ({ working: 0, 'short-term': 0, 'long-term': 0 }),
          },
        } as unknown) as OpenHorseUiRuntime['runtime'],
      });
      const { events, appended } = createEvents();
      const controller = new AgentRuntimeController({
        runtime,
        events,
        chatOptions: {
          uiRenderer: 'print',
        },
      });

      expect(controller.submit('/status')).toEqual({ type: 'started' });
      await controller.waitForIdle();

      const status = appended.map(entry => entry.content).join('\n');
      expect(status).toContain('Renderer   print non-interactive');
      expect(status).toContain('text-pickers, legacy-progress, legacy-meta, compact-spacing, abort-notice');
    });
  });

  it('passes renderer capabilities from the runtime controller boundary into commands', async () => {
    await withTempConfig(async ({ projectDir }) => {
      createRestorableSession(projectDir, 'older task');
      createRestorableSession(projectDir, 'newer task');

      const runtime = createRuntime({ cwd: projectDir });
      const { events, appended } = createEvents();
      const controller = new AgentRuntimeController({
        runtime,
        events,
        uiCapabilities: { structuredPickers: false },
      });

      expect(controller.submit('/resume')).toEqual({ type: 'started' });
      await controller.waitForIdle();

      expect(events.showSessionPicker).not.toHaveBeenCalled();
      expect(appended).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          title: '/resume',
          content: expect.stringContaining('Use /resume <number|session-id|name> or /resume --last.'),
        }),
      ]));
    });
  });

  it('runs a submitted input through the shared runner and processing lifecycle', async () => {
    const runtime = createRuntime();
    const { events, appended, processing } = createEvents();
    const runner: AgentRuntimeRunner & { calls: string[] } = {
      calls: [],
      runInput: jest.fn(async (input, options) => {
        runner.calls.push(input);
        expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
      }),
    };
    const controller = new AgentRuntimeController({ runtime, events, runner });

    expect(controller.submit('hello')).toEqual({ type: 'started' });
    await controller.waitForIdle();

    expect(runner.calls).toEqual(['hello']);
    expect(appended).toEqual([
      expect.objectContaining({ role: 'user', content: 'hello' }),
    ]);
    expect(processing).toEqual([true, false]);
    expect(runtime.store.setProcessing).toHaveBeenCalledWith(true);
    expect(runtime.store.setProcessing).toHaveBeenCalledWith(false);
  });

  it('keeps the runtime alive when a runner throws', async () => {
    const runtime = createRuntime();
    const { events, appended, statuses, processing } = createEvents();
    const runner: AgentRuntimeRunner = {
      runInput: jest.fn(async () => {
        throw new Error('Xunfei request failed with Sid: sid code: 11210, msg: NotEnoughCvError');
      }),
    };
    const controller = new AgentRuntimeController({
      runtime,
      events,
      runner,
      readyStatus: 'ready',
    });

    expect(controller.submit('hello')).toEqual({ type: 'started' });
    await expect(controller.waitForIdle()).resolves.toBeUndefined();

    expect(appended).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'error', content: expect.stringContaining('NotEnoughCvError') }),
    ]));
    expect(processing).toEqual([true, false]);
    expect(statuses).toContain('ready');
    expect(controller.hasActiveTurn()).toBe(false);
  });

  it('aborts an active turn and restarts only the latest revision', async () => {
    const runtime = createRuntime();
    const { events, statuses } = createEvents();
    const runner = createDeferredRunner();
    const controller = new AgentRuntimeController({ runtime, events, runner });

    expect(controller.submit('first goal')).toEqual({ type: 'started' });
    expect(runner.calls).toHaveLength(1);

    expect(controller.submit('older revision')).toEqual({ type: 'revision_requested' });
    expect(controller.submit('latest revision')).toEqual({ type: 'revision_requested' });
    expect(runner.calls[0].signal?.aborted).toBe(true);

    runner.calls[0].resolve();
    await Promise.resolve();
    expect(runner.calls.map(call => call.input)).toEqual(['first goal', 'latest revision']);

    runner.calls[1].resolve();
    await controller.waitForIdle();

    expect(statuses).toContain('Revision received. Interrupting current response...');
    expect(statuses).toContain('Restarting with latest instruction...');
  });

  it('does not run slash commands concurrently during an active turn', () => {
    const runtime = createRuntime();
    const { events, statuses } = createEvents();
    const runner = createDeferredRunner();
    const controller = new AgentRuntimeController({ runtime, events, runner });

    expect(controller.submit('long task')).toEqual({ type: 'started' });
    expect(controller.submit('/status')).toEqual({ type: 'command_ignored' });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].signal?.aborted).toBe(false);
    expect(statuses).toContain('Command ignored while agent is running. Press Ctrl+C to interrupt first.');
  });

  it('uses double Ctrl+C semantics while running', () => {
    const runtime = createRuntime();
    const { events } = createEvents();
    const runner = createDeferredRunner();
    const controller = new AgentRuntimeController({
      runtime,
      events,
      runner,
      exitConfirmWindowMs: 2000,
    });

    controller.submit('long task');
    expect(controller.interrupt()).toEqual({ type: 'interrupted' });
    expect(runner.calls[0].signal?.aborted).toBe(true);
    expect(controller.interrupt()).toEqual({ type: 'exit_requested' });
  });

  it('can suppress submitted input echo for terminal-style renderers', async () => {
    const runtime = createRuntime();
    const { events, appended } = createEvents();
    const runner: AgentRuntimeRunner = {
      runInput: jest.fn(async () => undefined),
    };
    const controller = new AgentRuntimeController({
      runtime,
      events,
      runner,
      echoSubmittedInput: false,
    });

    controller.submit('terminal already echoed this');
    await controller.waitForIdle();

    expect(appended).toEqual([]);
    expect(runner.runInput).toHaveBeenCalledTimes(1);
  });

  it('accepts protocol inputs so renderers do not call lifecycle methods directly', async () => {
    const runtime = createRuntime();
    const { events } = createEvents();
    const runner = createDeferredRunner();
    const controller = new AgentRuntimeController({ runtime, events, runner });

    expect(controller.handle({ type: 'submit', text: 'protocol task', source: 'composer' })).toEqual({ type: 'started' });
    expect(controller.handle({ type: 'clear_exit_intent' })).toEqual({ type: 'exit_intent_cleared' });
    expect(controller.handle({ type: 'interrupt', source: 'keyboard' })).toEqual({ type: 'interrupted' });
    expect(runner.calls[0].signal?.aborted).toBe(true);
  });

  it('accepts session picker selections as protocol inputs', async () => {
    const runtime = createRuntime();
    const { events } = createEvents();
    const runner: AgentRuntimeRunner & { calls: string[] } = {
      calls: [],
      runInput: jest.fn(async input => {
        runner.calls.push(input);
      }),
    };
    const controller = new AgentRuntimeController({ runtime, events, runner });

    expect(controller.handle({
      type: 'select_session',
      sessionId: 'session-123',
      allProjects: true,
      source: 'picker',
    })).toEqual({ type: 'started' });
    await controller.waitForIdle();

    expect(runner.calls).toEqual(['/resume session-123 --all']);
  });

  it('requests tool permission through runtime events and records a decision input', async () => {
    const runtime = createRuntime();
    const emitted: AgentRuntimeEvent[] = [];
    const controller = new AgentRuntimeController({
      runtime,
      runner: { runInput: jest.fn(async () => undefined) },
      eventSink: {
        emit: event => {
          emitted.push(event);
        },
      },
    });

    const decision = controller.requestToolPermission({
      name: 'git_push',
      args: { remote: 'origin' },
      reason: 'updates remote repository',
    });
    const request = emitted.find((event): event is Extract<AgentRuntimeEvent, { type: 'permission_requested' }> =>
      event.type === 'permission_requested'
    );

    expect(request).toEqual(expect.objectContaining({
      type: 'permission_requested',
      request: expect.objectContaining({
        name: 'git_push',
        args: { remote: 'origin' },
        reason: 'updates remote repository',
      }),
    }));
    expect(controller.handle({
      type: 'permission_decision',
      requestId: request!.request.id,
      approved: true,
      source: 'keyboard',
    })).toEqual({ type: 'permission_decision_recorded' });
    await expect(decision).resolves.toBe(true);
  });

  it('ignores unknown permission decisions', () => {
    const runtime = createRuntime();
    const { events } = createEvents();
    const controller = new AgentRuntimeController({
      runtime,
      events,
      runner: { runInput: jest.fn(async () => undefined) },
    });

    expect(controller.handle({
      type: 'permission_decision',
      requestId: 'missing',
      approved: true,
    })).toEqual({ type: 'permission_decision_ignored' });
  });

  it('denies pending tool permission when its abort signal fires', async () => {
    const runtime = createRuntime();
    const emitted: AgentRuntimeEvent[] = [];
    const controller = new AgentRuntimeController({
      runtime,
      runner: { runInput: jest.fn(async () => undefined) },
      eventSink: {
        emit: event => {
          emitted.push(event);
        },
      },
    });
    const abortController = new AbortController();

    const decision = controller.requestToolPermission({
      name: 'exec_command',
      args: { command: 'npm publish' },
      abortSignal: abortController.signal,
    });
    abortController.abort();

    await expect(decision).resolves.toBe(false);
    const request = emitted.find((event): event is Extract<AgentRuntimeEvent, { type: 'permission_requested' }> =>
      event.type === 'permission_requested'
    );
    expect(controller.handle({
      type: 'permission_decision',
      requestId: request!.request.id,
      approved: true,
    })).toEqual({ type: 'permission_decision_ignored' });
  });

  it('can run with only a structured runtime event sink', async () => {
    const runtime = createRuntime();
    const emitted: AgentRuntimeEvent[] = [];
    const runner: AgentRuntimeRunner = {
      runInput: jest.fn(async () => undefined),
    };
    const controller = new AgentRuntimeController({
      runtime,
      runner,
      eventSink: {
        emit: event => {
          emitted.push(event);
          return event.type === 'transcript_append' ? `event-${emitted.length}` : undefined;
        },
      },
    });

    expect(controller.handle({ type: 'submit', text: 'event protocol task' })).toEqual({ type: 'started' });
    await controller.waitForIdle();

    expect(runner.runInput).toHaveBeenCalledWith('event protocol task', expect.objectContaining({
      abortSignal: expect.any(AbortSignal),
    }));
    expect(emitted.map(event => event.type)).toEqual([
      'transcript_append',
      'processing_changed',
      'processing_changed',
    ]);
  });

  it('renders provider request failures without throwing from chat runtime', async () => {
    await withTempConfig(async ({ projectDir }) => {
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'xopglm51',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'xopglm51',
      });
      const llm = {
        getModel: jest.fn(() => 'xopglm51'),
        chatStream: jest.fn(async () => {
          throw new Error('Xunfei request failed with Sid: cht000d6760 code: 11210, msg: NotEnoughCvError');
        }),
        getLastRequestDiagnostics: jest.fn(() => ({
          retryCount: 1,
          retryDelayMs: 500,
          retryErrorTypes: ['quota_or_credit_exhausted'],
          lastRetryErrorType: 'quota_or_credit_exhausted',
          lastRetryStatus: 402,
          fallbackTriggered: false,
          finalModel: 'xopglm51',
          usingFallback: false,
        })),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'xopglm51');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, appended, statuses, loopStats, traceEvents } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('hello', { turnId: 'turn-provider-failed' })).resolves.toBeUndefined();

      expect(llm.chatStream).toHaveBeenCalledTimes(1);
      expect(appended).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'error',
          content: expect.stringContaining('Provider quota or credit appears insufficient'),
        }),
      ]));
      expect(statuses).toContain('Turn failed. Ready for the next input.');
      expect(store.getSnapshot().lastLoopStats).toMatchObject({
        finishReason: 'failed',
        llmRequests: 1,
        toolCalls: 0,
        loopBudgetSource: 'default',
        loopBudgetMaxLlmRequests: 24,
        providerRetryCount: 1,
        providerRetryErrorTypes: ['quota_or_credit_exhausted'],
        providerFinalModel: 'xopglm51',
      });
      expect(loopStats.at(-1)).toMatchObject({
        finishReason: 'failed',
        llmRequests: 1,
        toolCalls: 0,
      });
      expect(session).not.toBeNull();
      expect(readSessionMessages(session!.id)).toHaveLength(0);
      const persistedTrace = readSessionTraceEvents(session!.id);
      expect(persistedTrace).toEqual(expect.arrayContaining([
        expect.objectContaining({
          turnId: 'turn-provider-failed',
          type: 'request_start',
          model: 'xopglm51',
        }),
        expect.objectContaining({
          turnId: 'turn-provider-failed',
          type: 'provider_retry',
          providerRetryCount: 1,
          providerRetryErrorTypes: ['quota_or_credit_exhausted'],
          providerLastRetryStatus: 402,
        }),
        expect.objectContaining({
          turnId: 'turn-provider-failed',
          type: 'error',
          error: expect.stringContaining('NotEnoughCvError'),
        }),
        expect.objectContaining({
          turnId: 'turn-provider-failed',
          type: 'complete',
          finishReason: 'failed',
          llmRequests: 1,
          toolCalls: 0,
          loopBudgetSource: 'default',
          loopBudgetMaxLlmRequests: 24,
        }),
      ]));
      expect(traceEvents.map(event => (event as { type?: string }).type))
        .toEqual(persistedTrace.map(event => event.type));
    });
  });

  it('preserves accumulated query stats when a later provider request fails', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'target.txt'), 'context', 'utf-8');
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'primary-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'primary-model',
      });
      const llm = {
        getModel: jest.fn(() => 'primary-model'),
        chatStream: jest.fn()
          .mockResolvedValueOnce({
            content: '',
            model: 'fallback-model',
            toolCalls: [{
              id: 'call-read',
              type: 'function' as const,
              function: { name: 'read_file', arguments: JSON.stringify({ path: 'target.txt' }) },
            }],
            usage: { promptTokens: 10, completionTokens: 1 },
          })
          .mockRejectedValueOnce(new Error('Xunfei request failed: provider busy')),
        getLastRequestDiagnostics: jest.fn()
          .mockReturnValueOnce({
            retryCount: 2,
            retryDelayMs: 1000,
            retryErrorTypes: ['rate_limit'],
            lastRetryErrorType: 'rate_limit',
            lastRetryStatus: 429,
            fallbackTriggered: true,
            fallbackFromModel: 'primary-model',
            fallbackToModel: 'fallback-model',
            finalModel: 'fallback-model',
            usingFallback: true,
          })
          .mockReturnValueOnce({
            retryCount: 1,
            retryDelayMs: 500,
            retryErrorTypes: ['provider_busy'],
            lastRetryErrorType: 'provider_busy',
            lastRetryStatus: 529,
            fallbackTriggered: false,
            finalModel: 'fallback-model',
            usingFallback: true,
          }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'primary-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, loopStats } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('inspect then answer', { turnId: 'turn-provider-late-fail' }))
        .resolves.toBeUndefined();

      expect(llm.chatStream).toHaveBeenCalledTimes(2);
      expect(store.getSnapshot().lastLoopStats).toMatchObject({
        finishReason: 'failed',
        llmRequests: 2,
        toolCalls: 1,
        readOnlyToolCalls: 1,
        providerRetryCount: 3,
        providerRetryDelayMs: 1500,
        providerRetryErrorTypes: ['rate_limit', 'provider_busy'],
        providerFallbackCount: 1,
        providerFallbackFromModel: 'primary-model',
        providerFallbackToModel: 'fallback-model',
        providerFinalModel: 'fallback-model',
        providerUsingFallback: true,
      });
      expect(loopStats.at(-1)).toMatchObject({
        finishReason: 'failed',
        llmRequests: 2,
        toolCalls: 1,
      });
      expect(session).not.toBeNull();
      expect(readSessionMessages(session!.id)).toHaveLength(0);
      expect(readSessionTraceEvents(session!.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          turnId: 'turn-provider-late-fail',
          type: 'tool_result',
          name: 'read_file',
          success: true,
        }),
        expect.objectContaining({
          turnId: 'turn-provider-late-fail',
          type: 'complete',
          finishReason: 'failed',
          llmRequests: 2,
          toolCalls: 1,
          readOnlyToolCalls: 1,
        }),
      ]));
    });
  });

  it('shows checkpoint recovery guidance when a failed turn changed files', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'target.ts'), 'export const value = 1;\n', 'utf-8');
      execFileSync('git', ['-C', projectDir, 'init'], { stdio: 'ignore' });
      execFileSync('git', ['-C', projectDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
      execFileSync('git', ['-C', projectDir, 'config', 'user.name', 'Test User'], { stdio: 'ignore' });
      execFileSync('git', ['-C', projectDir, 'add', '.'], { stdio: 'ignore' });
      execFileSync('git', ['-C', projectDir, 'commit', '-m', 'initial'], { stdio: 'ignore' });
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn()
          .mockResolvedValueOnce({
            content: '',
            model: 'test-model',
            toolCalls: [{
              id: 'call-write',
              type: 'function' as const,
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  path: 'src/target.ts',
                  content: 'export const value = 2;\n',
                }),
              },
            }],
            usage: { promptTokens: 10, completionTokens: 1 },
          })
          .mockRejectedValueOnce(new Error('provider busy after edit')),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, appended } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('edit target', { turnId: 'turn-failed-edit' }))
        .resolves.toBeUndefined();

      expect(appended).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'status',
          title: 'recovery',
          content: expect.stringContaining('Checkpoints: turn-failed-edit'),
        }),
      ]));
      expect(session).not.toBeNull();
      const traceEvents = readSessionTraceEvents(session!.id);
      expect(traceEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'checkpoint',
          turnId: 'turn-failed-edit',
          checkpointId: 'turn-failed-edit',
          checkpointFiles: ['src/target.ts'],
        }),
        expect.objectContaining({
          type: 'workspace_delta',
          turnId: 'turn-failed-edit',
          workspaceChangedByTurn: ['src/target.ts'],
        }),
        expect.objectContaining({
          type: 'error',
          turnId: 'turn-failed-edit',
          note: expect.stringContaining('Checkpoints: turn-failed-edit'),
        }),
        expect.objectContaining({
          type: 'complete',
          turnId: 'turn-failed-edit',
          finishReason: 'failed',
          llmRequests: 2,
          toolCalls: 1,
        }),
      ]));
      expect(listCheckpoints(projectDir)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          turnId: 'turn-failed-edit',
          files: [expect.objectContaining({ path: 'src/target.ts' })],
        }),
      ]));
      expect(readSessionMessages(session!.id)).toHaveLength(0);
    });
  });

  it('records provider retry and fallback diagnostics as trace events', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'primary-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'primary-model',
      });
      const llm = {
        getModel: jest.fn(() => 'primary-model'),
        chatStream: jest.fn(async () => ({
          content: 'recovered',
          model: 'fallback-model',
          usage: { promptTokens: 10, completionTokens: 2 },
        })),
        getLastRequestDiagnostics: jest.fn(() => ({
          retryCount: 3,
          retryDelayMs: 1500,
          retryErrorTypes: ['rate_limit', 'provider_busy', 'rate_limit'],
          lastRetryErrorType: 'provider_busy',
          lastRetryStatus: 529,
          fallbackTriggered: true,
          fallbackFromModel: 'primary-model',
          fallbackToModel: 'fallback-model',
          finalModel: 'fallback-model',
          usingFallback: true,
        })),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'primary-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, loopStats, traceEvents } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('hello provider status', { turnId: 'turn-provider' }))
        .resolves.toBeUndefined();

      expect(llm.chatStream).toHaveBeenCalledTimes(1);
      expect(loopStats.at(-1)).toMatchObject({
        providerRetryCount: 3,
        providerRetryDelayMs: 1500,
        providerRetryErrorTypes: ['rate_limit', 'provider_busy'],
        providerFallbackCount: 1,
        providerFallbackFromModel: 'primary-model',
        providerFallbackToModel: 'fallback-model',
        providerFinalModel: 'fallback-model',
        providerUsingFallback: true,
      });
      expect(session).not.toBeNull();
      const persistedTrace = readSessionTraceEvents(session!.id);
      expect(persistedTrace).toEqual(expect.arrayContaining([
        expect.objectContaining({
          turnId: 'turn-provider',
          type: 'provider_retry',
          providerRetryCount: 3,
          providerRetryDelayMs: 1500,
          providerRetryErrorTypes: ['rate_limit', 'provider_busy'],
          providerLastRetryErrorType: 'provider_busy',
          providerLastRetryStatus: 529,
          providerFinalModel: 'fallback-model',
          providerUsingFallback: true,
        }),
        expect.objectContaining({
          turnId: 'turn-provider',
          type: 'provider_fallback',
          providerFallbackCount: 1,
          providerFallbackFromModel: 'primary-model',
          providerFallbackToModel: 'fallback-model',
          providerFinalModel: 'fallback-model',
          providerUsingFallback: true,
        }),
      ]));
      const eventTypes = persistedTrace.map(event => event.type);
      expect(eventTypes.indexOf('provider_retry')).toBeGreaterThan(eventTypes.indexOf('request_start'));
      expect(eventTypes.indexOf('provider_fallback')).toBeGreaterThan(eventTypes.indexOf('provider_retry'));
      expect(eventTypes.indexOf('complete')).toBeGreaterThan(eventTypes.indexOf('provider_fallback'));
      expect(traceEvents.map(event => (event as { type?: string }).type)).toEqual(eventTypes);
    });
  });

  it('stops permission-denied tool turns with blocked finish reason', async () => {
    await withTempConfig(async ({ projectDir }) => {
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
        toolConfirmation: 'deny',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async () => ({
          content: '',
          model: 'test-model',
          toolCalls: [
            { id: 'call-search', type: 'function', function: { name: 'web_search', arguments: '{"query":"openhorse"}' } },
          ],
        })),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, loopStats } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('search openhorse', { turnId: 'turn-denied' })).resolves.toBeUndefined();

      expect(llm.chatStream).toHaveBeenCalledTimes(1);
      expect(loopStats.at(-1)).toMatchObject({
        finishReason: 'blocked',
        llmRequests: 1,
        toolCalls: 1,
      });
      const traceEvents = readSessionTraceEvents(session!.id);
      expect(traceEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'permission_decision',
          turnId: 'turn-denied',
          name: 'web_search',
          permissionApproved: false,
          permissionSource: 'config_deny',
        }),
        expect.objectContaining({
          type: 'complete',
          turnId: 'turn-denied',
          finishReason: 'blocked',
          llmRequests: 1,
          toolCalls: 1,
        }),
      ]));
    });
  });

  it('uses a higher adaptive loop budget for complex coding tasks', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'target.txt'), 'context', 'utf-8');
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const responses = [
        ...Array.from({ length: 25 }, (_, index) => ({
          content: '',
          model: 'test-model',
          toolCalls: [
            {
              id: `call-${index}`,
              type: 'function' as const,
              function: { name: 'read_file', arguments: '{"path":"target.txt"}' },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 1 },
        })),
        {
          content: 'completion gate acknowledged; finishing',
          model: 'test-model',
          usage: { promptTokens: 10, completionTokens: 2 },
        },
        {
          content: 'done after a large task',
          model: 'test-model',
          usage: { promptTokens: 10, completionTokens: 2 },
        },
      ];
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async () => responses.shift()),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, loopStats } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('完成本次开发，修复所有测试问题')).resolves.toBeUndefined();

      expect(llm.chatStream).toHaveBeenCalledTimes(27);
      expect(loopStats.at(-1)).toMatchObject({
        finishReason: 'completed',
        llmRequests: 27,
        toolCalls: 25,
        loopBudgetSource: 'complex',
        loopBudgetMaxLlmRequests: 48,
      });
      const completeTrace = readSessionTraceEvents(session!.id)
        .find(event => event.type === 'complete');
      expect(completeTrace).toMatchObject({
        type: 'complete',
        finishReason: 'completed',
        llmRequests: 27,
        toolCalls: 25,
        loopBudgetSource: 'complex',
        loopBudgetBaseProfile: 'complex',
        loopBudgetMaxLlmRequests: 48,
        loopBudgetMaxToolCalls: 180,
        loopBudgetMaxReadOnlyFragmentation: 3,
        loopBudgetMaxModelVisibleBytes: 96 * 1024,
        loopBudgetConfigOverride: false,
      });
      const traceLogs: string[] = [];
      const logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        traceLogs.push(args.join(' '));
      });
      try {
        const ctx: CommandContext = {
          cwd: projectDir,
          config,
          store,
          llm: null,
          runtime: {} as any,
          sessionId: session!.id,
          getSession: () => session,
        };
        const traceResult = await findCommand('trace')!.execute(ctx, completeTrace!.turnId);
        const rendered = stripAnsi(traceLogs.join('\n'));
        expect(traceResult.success).toBe(true);
        expect(rendered).toContain('complete finish=completed llm=27 tools=25 budgetProfile=complex(27/48llm,25/180tools,96 KBvisible,frag=3)');
      } finally {
        logSpy.mockRestore();
      }
      expect(readSessionMessages(session!.id).at(-1)?.content).toBe('done after a large task');
    });
  });

  it('uses restored harness objective to budget continuation turns', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'target.txt'), 'context', 'utf-8');
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const harness = createContextHarness({ cwd: projectDir, modelId: 'test-model' });
      harness.updateContractFromUserInput('完成一个大的任务：多步骤修复 agent-loop、harness、session 并验证');
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
        harnessState: harness.toJSON(),
      });
      const responses = [
        {
          content: '',
          model: 'test-model',
          toolCalls: [
            {
              id: 'call-read',
              type: 'function' as const,
              function: { name: 'read_file', arguments: '{"path":"target.txt"}' },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 1 },
        },
        {
          content: 'completion gate acknowledged; finishing',
          model: 'test-model',
          usage: { promptTokens: 10, completionTokens: 2 },
        },
        {
          content: 'continued large task',
          model: 'test-model',
          usage: { promptTokens: 10, completionTokens: 2 },
        },
      ];
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async () => responses.shift()),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, loopStats } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('继续')).resolves.toBeUndefined();

      expect(llm.chatStream).toHaveBeenCalledTimes(3);
      expect(loopStats.at(-1)).toMatchObject({
        finishReason: 'completed',
        llmRequests: 3,
        toolCalls: 1,
        loopBudgetSource: 'complex',
        loopBudgetMaxLlmRequests: 48,
      });
      expect(readSessionMessages(session!.id).at(-1)?.content).toBe('continued large task');
    });
  });

  it('emits intentful statuses for model thinking and batched tool phases', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'a.txt'), 'alpha', 'utf-8');
      writeFileSync(join(projectDir, 'b.txt'), 'bravo', 'utf-8');

      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const toolCalls = [
        {
          id: 'call-a',
          type: 'function' as const,
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
        },
        {
          id: 'call-b',
          type: 'function' as const,
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'b.txt' }) },
        },
      ];
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn()
          .mockResolvedValueOnce({
            content: '',
            model: 'test-model',
            toolCalls,
            usage: { promptTokens: 10, completionTokens: 1 },
          })
          .mockResolvedValueOnce({
            content: 'done',
            model: 'test-model',
            usage: { promptTokens: 12, completionTokens: 2 },
          }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, statuses } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('read both files', { turnId: 'turn-tools' })).resolves.toBeUndefined();

      expect(statuses).toEqual(expect.arrayContaining([
        'Working: thinking',
        'Working: running 2 tools',
        'Working: reading tool results',
      ]));
      expect(llm.chatStream).toHaveBeenCalledTimes(2);
      expect(session).not.toBeNull();
      expect(readSessionTraceEvents(session!.id).map(event => event.type)).toEqual(expect.arrayContaining([
        'turn_start',
        'workspace_snapshot',
        'request_start',
        'assistant_tool_calls',
        'tool_call',
        'tool_result',
        'message',
        'workspace_snapshot',
        'workspace_delta',
        'complete',
      ]));
      expect(readSessionTraceEvents(session!.id).filter(event => event.type === 'tool_result')).toHaveLength(2);
    });
  });

  it('emits a running status for a single model-requested tool', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'a.txt'), 'alpha', 'utf-8');

      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const toolCalls = [
        {
          id: 'call-a',
          type: 'function' as const,
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
        },
      ];
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn()
          .mockResolvedValueOnce({
            content: '',
            model: 'test-model',
            toolCalls,
            usage: { promptTokens: 10, completionTokens: 1 },
          })
          .mockResolvedValueOnce({
            content: 'done',
            model: 'test-model',
            usage: { promptTokens: 12, completionTokens: 2 },
          }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, statuses } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('read one file', { turnId: 'turn-one-tool' })).resolves.toBeUndefined();

      expect(statuses).toEqual(expect.arrayContaining([
        'Working: thinking',
        'Working: running tool',
        'Working: reading tool results',
      ]));
      expect(llm.chatStream).toHaveBeenCalledTimes(2);
      expect(session).not.toBeNull();
      expect(readSessionTraceEvents(session!.id).filter(event => event.type === 'tool_result')).toHaveLength(1);
    });
  });

  it('emits batching suggestion when 3+ read-only tools are requested', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'a.txt'), 'alpha', 'utf-8');
      writeFileSync(join(projectDir, 'b.txt'), 'bravo', 'utf-8');
      writeFileSync(join(projectDir, 'c.txt'), 'charlie', 'utf-8');

      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const toolCalls = [
        {
          id: 'call-a',
          type: 'function' as const,
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
        },
        {
          id: 'call-b',
          type: 'function' as const,
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'b.txt' }) },
        },
        {
          id: 'call-c',
          type: 'function' as const,
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'c.txt' }) },
        },
      ];
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn()
          .mockResolvedValueOnce({
            content: '',
            model: 'test-model',
            toolCalls,
            usage: { promptTokens: 10, completionTokens: 1 },
          })
          .mockResolvedValueOnce({
            content: 'done',
            model: 'test-model',
            usage: { promptTokens: 12, completionTokens: 2 },
          }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, appended } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('read three files', { turnId: 'turn-batch-read' })).resolves.toBeUndefined();

      const statusEntries = appended.filter(e => e.role === 'status');
      const batchingStatus = statusEntries.find(e => e.content?.includes('independent read-only tool calls'));
      expect(batchingStatus).toBeDefined();
      expect(batchingStatus!.content).toContain('3 independent read-only tool calls');
      expect(batchingStatus!.content).toContain('reduce model-tool roundtrips');
    });
  });

  it('does not emit batching suggestion for fewer than 3 read-only tools', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'a.txt'), 'alpha', 'utf-8');

      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const toolCalls = [
        {
          id: 'call-a',
          type: 'function' as const,
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
        },
      ];
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn()
          .mockResolvedValueOnce({
            content: '',
            model: 'test-model',
            toolCalls,
            usage: { promptTokens: 10, completionTokens: 1 },
          })
          .mockResolvedValueOnce({
            content: 'done',
            model: 'test-model',
            usage: { promptTokens: 12, completionTokens: 2 },
          }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, appended } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('read one file', { turnId: 'turn-single-read' })).resolves.toBeUndefined();

      const statusEntries = appended.filter(e => e.role === 'status');
      const batchingStatus = statusEntries.find(e => e.content?.includes('independent read-only tool calls'));
      expect(batchingStatus).toBeUndefined();
    });
  });

  it('creates a pre-edit checkpoint before batched file-writing tools execute', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
      writeFileSync(join(projectDir, 'src', 'b.ts'), 'export const b = 1;\n', 'utf-8');

      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const toolCalls = [
        {
          id: 'call-write-a',
          type: 'function' as const,
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'src/a.ts', content: 'export const a = 2;\n' }),
          },
        },
        {
          id: 'call-write-b',
          type: 'function' as const,
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'src/b.ts', content: 'export const b = 2;\n' }),
          },
        },
      ];
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn()
          .mockResolvedValueOnce({
            content: '',
            model: 'test-model',
            toolCalls,
            usage: { promptTokens: 10, completionTokens: 1 },
          })
          .mockResolvedValueOnce({
            content: 'updated',
            model: 'test-model',
            usage: { promptTokens: 12, completionTokens: 2 },
          }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('update two files', { turnId: 'turn-checkpoint' }))
        .resolves.toBeUndefined();

      expect(session).not.toBeNull();
      const traceEvents = readSessionTraceEvents(session!.id);
      const eventTypes = traceEvents.map(event => event.type);
      const checkpointIndex = eventTypes.indexOf('checkpoint');
      const firstToolCallIndex = eventTypes.indexOf('tool_call');

      expect(checkpointIndex).toBeGreaterThan(-1);
      expect(firstToolCallIndex).toBeGreaterThan(-1);
      expect(checkpointIndex).toBeLessThan(firstToolCallIndex);
      expect(traceEvents[checkpointIndex]).toMatchObject({
        type: 'checkpoint',
        turnId: 'turn-checkpoint',
        checkpointId: 'turn-checkpoint',
        checkpointFileCount: 2,
        checkpointFiles: ['src/a.ts', 'src/b.ts'],
        workspaceFiles: ['src/a.ts', 'src/b.ts'],
      });

      const checkpoints = listCheckpoints(projectDir);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]).toMatchObject({
        turnId: 'turn-checkpoint',
        files: [
          expect.objectContaining({ path: 'src/a.ts', content: 'export const a = 1;\n' }),
          expect.objectContaining({ path: 'src/b.ts', content: 'export const b = 1;\n' }),
        ],
      });
    });
  });

  it('flags risky multi-file checkpoint when a turn modifies 5+ files', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      execFileSync('git', ['-C', projectDir, 'init'], { stdio: 'ignore' });
      writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
        scripts: { build: 'node -e "process.exit(0)"' },
      }), 'utf-8');
      const files = ['a', 'b', 'c', 'd', 'e'];
      for (const name of files) {
        writeFileSync(join(projectDir, 'src', `${name}.ts`), `export const ${name} = 1;\n`, 'utf-8');
      }

      const config = loadConfig({ apiKey: 'test-key', model: 'test-model' });
      const store = new Store({ config, tools: TOOLS, currentModel: 'test-model' });
      const toolCalls = files.map(name => ({
        id: `call-write-${name}`,
        type: 'function' as const,
        function: {
          name: 'write_file',
          arguments: JSON.stringify({ path: `src/${name}.ts`, content: `export const ${name} = 2;\n` }),
        },
      }));
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn()
          .mockResolvedValueOnce({
            content: '',
            model: 'test-model',
            toolCalls,
            usage: { promptTokens: 10, completionTokens: 1 },
          })
          .mockResolvedValueOnce({
            content: 'updated all files',
            model: 'test-model',
            usage: { promptTokens: 12, completionTokens: 2 },
          }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, appended } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('update five files', { turnId: 'turn-risky' }))
        .resolves.toBeUndefined();

      expect(session).not.toBeNull();
      const traceEvents = readSessionTraceEvents(session!.id);
      const checkpointEvent = traceEvents.find(event => event.type === 'checkpoint');
      expect(checkpointEvent).toMatchObject({
        note: 'risky_multi_file_checkpoint',
        checkpointFileCount: 5,
      });
      const verificationProfileEvent = traceEvents.find(event => event.type === 'verification_profile');
      expect(verificationProfileEvent?.verificationRisky).toBe(true);
      const riskyNotice = appended.find(entry => entry.role === 'status' && entry.title === 'checkpoint');
      expect(riskyNotice?.content).toContain('Risky edit');
      expect(riskyNotice?.content).toContain('5 files');
    });
  });

  it('records verification profile trace after changed-file turns', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      execFileSync('git', ['-C', projectDir, 'init'], { stdio: 'ignore' });
      writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
        scripts: {
          build: 'node -e "process.exit(0)"',
          test: 'jest',
          lint: 'eslint src/',
        },
      }), 'utf-8');

      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const toolCalls = [
        {
          id: 'call-write',
          type: 'function' as const,
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'src/index.ts', content: 'export const value = 1;\n' }),
          },
        },
        {
          id: 'call-build',
          type: 'function' as const,
          function: {
            name: 'exec_command',
            arguments: JSON.stringify({ command: 'npm run build' }),
          },
        },
      ];
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn()
          .mockResolvedValueOnce({
            content: '',
            model: 'test-model',
            toolCalls,
            usage: { promptTokens: 10, completionTokens: 1 },
          })
          .mockResolvedValueOnce({
            content: 'updated',
            model: 'test-model',
            usage: { promptTokens: 12, completionTokens: 2 },
          }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const {
        events,
        appended,
        loopStats,
        traceEvents: emittedTraceEvents,
        harnessDiagnostics,
      } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('create index', { turnId: 'turn-write' })).resolves.toBeUndefined();

      expect(session).not.toBeNull();
      const traceEvents = readSessionTraceEvents(session!.id);
      const eventTypes = traceEvents.map(event => event.type);
      const promptIndex = eventTypes.indexOf('prompt_assembly');
      const deltaIndex = eventTypes.indexOf('workspace_delta');
      const profileIndex = eventTypes.indexOf('verification_profile');
      const resultIndex = eventTypes.indexOf('verification_result');
      const summaryIndex = eventTypes.indexOf('verification_summary');
      const completeIndex = eventTypes.indexOf('complete');

      expect(promptIndex).toBeGreaterThan(-1);
      expect(deltaIndex).toBeGreaterThan(-1);
      expect(promptIndex).toBeLessThan(deltaIndex);
      expect(profileIndex).toBeGreaterThan(deltaIndex);
      expect(resultIndex).toBeGreaterThan(-1);
      expect(resultIndex).toBeLessThan(profileIndex);
      expect(summaryIndex).toBeGreaterThan(profileIndex);
      expect(completeIndex).toBeGreaterThan(summaryIndex);
      expect(traceEvents[promptIndex]).toMatchObject({
        type: 'prompt_assembly',
        promptModelId: 'test-model',
        promptSections: expect.arrayContaining(['core']),
        promptIncludedEvidenceCount: expect.any(Number),
        promptOmittedEvidenceCount: expect.any(Number),
      });
      expect(traceEvents[deltaIndex]).toMatchObject({
        type: 'workspace_delta',
        workspaceNewByTurn: ['src/index.ts'],
        workspaceChangedByTurn: ['src/index.ts'],
        workspaceModifiedPreExistingByTurn: [],
        workspaceResolvedByTurn: [],
      });
      expect(traceEvents[resultIndex]).toMatchObject({
        type: 'verification_result',
        verificationCommand: 'npm run build',
        verificationPassed: true,
      });
      expect(traceEvents[profileIndex]).toMatchObject({
        type: 'verification_profile',
        verificationProfile: 'node',
        verificationRequired: true,
        verificationCommands: ['npm run build', 'npm test -- --runInBand', 'npm run lint'],
        verificationChangedFiles: ['src/index.ts'],
      });
      expect(traceEvents[summaryIndex]).toMatchObject({
        type: 'verification_summary',
        verificationProfile: 'node',
        verificationRequired: true,
        verificationPassedCommands: ['npm run build'],
        verificationFailedCommands: [],
        verificationMissingCommands: ['npm test -- --runInBand', 'npm run lint'],
        verificationClaimAllowed: false,
      });
      expect(traceEvents[completeIndex]).toMatchObject({
        type: 'complete',
        finishReason: 'completion_gate',
        note: 'verification_incomplete',
      });
      expect(store.getSnapshot().lastLoopStats).toMatchObject({
        finishReason: 'completion_gate',
        verificationProfile: 'node',
        verificationRequired: true,
        verificationClaimAllowed: false,
        verificationPassedCommands: ['npm run build'],
        verificationMissingCommands: ['npm test -- --runInBand', 'npm run lint'],
      });
      expect(loopStats).toHaveLength(1);
      expect(loopStats.at(-1)).toMatchObject({
        finishReason: 'completion_gate',
        verificationProfile: 'node',
        verificationClaimAllowed: false,
        verificationPassedCommands: ['npm run build'],
        verificationMissingCommands: ['npm test -- --runInBand', 'npm run lint'],
      });
      expect(harnessDiagnostics.at(-1)).toMatchObject({
        rootObjective: expect.stringContaining('create index'),
        activeInstruction: expect.stringContaining('create index'),
        taskEpoch: 1,
        ledgerSize: expect.any(Number),
        evidenceSize: expect.any(Number),
        turnSummaryCount: 1,
        promptAssembly: expect.objectContaining({
          modelId: 'test-model',
          includedEvidence: expect.any(Number),
          omittedEvidence: expect.any(Number),
        }),
      });
      expect(emittedTraceEvents.map(event => (event as { type?: string }).type)).toEqual(eventTypes);
      expect(appended).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'status',
          title: 'verification',
          content: expect.stringContaining('[Orion Code Verification Gate]'),
        }),
      ]));
      expect(readSessionMessages(session!.id).at(-1)?.content).toContain('[Orion Code Verification Gate]');
    });
  });

  it('classifies pre-existing dirty files modified again during a turn', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      execFileSync('git', ['-C', projectDir, 'init'], { stdio: 'ignore' });
      execFileSync('git', ['-C', projectDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
      execFileSync('git', ['-C', projectDir, 'config', 'user.name', 'Test User'], { stdio: 'ignore' });
      writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
        scripts: {
          build: 'node -e "process.exit(0)"',
        },
      }), 'utf-8');
      writeFileSync(join(projectDir, 'src', 'existing.ts'), 'export const value = 0;\n', 'utf-8');
      execFileSync('git', ['-C', projectDir, 'add', '.'], { stdio: 'ignore' });
      execFileSync('git', ['-C', projectDir, 'commit', '-m', 'initial'], { stdio: 'ignore' });
      writeFileSync(join(projectDir, 'src', 'existing.ts'), 'export const value = 1;\n', 'utf-8');

      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const toolCalls = [
        {
          id: 'call-write-existing',
          type: 'function' as const,
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'src/existing.ts', content: 'export const value = 2;\n' }),
          },
        },
        {
          id: 'call-build',
          type: 'function' as const,
          function: {
            name: 'exec_command',
            arguments: JSON.stringify({ command: 'npm run build' }),
          },
        },
      ];
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn()
          .mockResolvedValueOnce({
            content: '',
            model: 'test-model',
            toolCalls,
            usage: { promptTokens: 10, completionTokens: 1 },
          })
          .mockResolvedValueOnce({
            content: 'updated',
            model: 'test-model',
            usage: { promptTokens: 12, completionTokens: 2 },
          }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('update existing file', { turnId: 'turn-existing-dirty' })).resolves.toBeUndefined();

      expect(session).not.toBeNull();
      const delta = readSessionTraceEvents(session!.id).find(event => event.type === 'workspace_delta');
      expect(delta).toMatchObject({
        workspaceNewByTurn: [],
        workspaceChangedByTurn: ['src/existing.ts'],
        workspaceModifiedPreExistingByTurn: ['src/existing.ts'],
        workspaceResolvedByTurn: [],
      });
    });
  });

  it('does not gate completion when all expected verification checks passed', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      execFileSync('git', ['-C', projectDir, 'init'], { stdio: 'ignore' });
      writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
        scripts: {
          build: 'node -e "process.exit(0)"',
        },
      }), 'utf-8');

      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const toolCalls = [
        {
          id: 'call-write',
          type: 'function' as const,
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'src/index.ts', content: 'export const value = 1;\n' }),
          },
        },
        {
          id: 'call-build',
          type: 'function' as const,
          function: {
            name: 'exec_command',
            arguments: JSON.stringify({ command: 'npm run build' }),
          },
        },
      ];
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn()
          .mockResolvedValueOnce({
            content: '',
            model: 'test-model',
            toolCalls,
            usage: { promptTokens: 10, completionTokens: 1 },
          })
          .mockResolvedValueOnce({
            content: 'updated',
            model: 'test-model',
            usage: { promptTokens: 12, completionTokens: 2 },
          }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, appended, loopStats } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('create index', { turnId: 'turn-write-verified' })).resolves.toBeUndefined();

      expect(session).not.toBeNull();
      const traceEvents = readSessionTraceEvents(session!.id);
      const summary = traceEvents.find(event => event.type === 'verification_summary');
      const complete = traceEvents.find(event => event.type === 'complete');
      expect(summary).toMatchObject({
        verificationClaimAllowed: true,
        verificationPassedCommands: ['npm run build'],
        verificationMissingCommands: [],
      });
      expect(complete).toMatchObject({
        finishReason: 'completed',
      });
      expect(store.getSnapshot().lastLoopStats).toMatchObject({
        finishReason: 'completed',
        verificationProfile: 'node',
        verificationRequired: true,
        verificationClaimAllowed: true,
        verificationPassedCommands: ['npm run build'],
        verificationMissingCommands: [],
      });
      expect(loopStats).toHaveLength(1);
      expect(loopStats.at(-1)).toMatchObject({
        finishReason: 'completed',
        verificationProfile: 'node',
        verificationClaimAllowed: true,
        verificationPassedCommands: ['npm run build'],
        verificationMissingCommands: [],
      });
      expect(appended).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          title: 'verification',
        }),
      ]));
    });
  });

  it('bridges structured runtime events to the legacy UI event sink contract', () => {
    const {
      events,
      appended,
      statuses,
      processing,
      loopStats,
      traceEvents,
      harnessDiagnostics,
      sessionRestoredEvents,
    } = createEvents();
    const runtimeSink = createAgentRuntimeEventSinkFromUiEvents(events);

    expect(runtimeSink.emit({
      type: 'transcript_append',
      entry: { role: 'assistant', content: 'hello' },
    })).toBe('entry-1');
    runtimeSink.emit({ type: 'status_changed', message: 'ready' });
    runtimeSink.emit({ type: 'processing_changed', processing: true });
    runtimeSink.emit({
      type: 'tool_started',
      event: makeToolStartedEvent({ callId: 'call-1', name: 'read_file', args: { path: 'src/index.ts' } }),
    });
    runtimeSink.emit({
      type: 'tool_finished',
      event: makeToolFinishedEvent({
        callId: 'call-1',
        name: 'read_file',
        args: { path: 'src/index.ts' },
        success: true,
        duration: 12,
        summary: 'read file ok',
      }),
    });
    runtimeSink.emit({
      type: 'loop_stats_updated',
      stats: {
        turnsStarted: 1,
        llmRequests: 1,
        toolCalls: 0,
        readOnlyToolCalls: 0,
        unsafeToolCalls: 0,
        toolResultBytes: 0,
        modelVisibleToolBytes: 0,
        summarizedBytes: 0,
        finishReason: 'completed',
        singleReadOnlyStreak: 0,
        batchReadSuggestionCount: 0,
        localFastPathUsed: false,
      },
    });
    runtimeSink.emit({
      type: 'trace_event_recorded',
      event: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        timestamp: 1,
        type: 'complete',
        finishReason: 'completed',
      },
    });
    runtimeSink.emit({
      type: 'harness_diagnostics_updated',
      diagnostics: {
        taskEpoch: 2,
        rootObjective: 'ship agent loop',
        activeInstruction: 'verify runtime events',
        ledgerSize: 3,
        evidenceSize: 4,
        turnSummaryCount: 1,
      },
    });
    runtimeSink.emit({
      type: 'session_restored',
      event: {
        sessionId: 'session-1',
        projectPath: '/tmp/project',
        model: 'test-model',
        restoredMessages: 2,
        messageCount: 2,
        summary: 'restored task',
      },
    });

    expect(appended).toEqual([expect.objectContaining({ role: 'assistant', content: 'hello' })]);
    expect(statuses).toEqual(['ready']);
    expect(processing).toEqual([true]);
    expect(events.toolStarted).toHaveBeenCalledWith({ callId: 'call-1', name: 'read_file', args: { path: 'src/index.ts' }, sequence: 1 });
    expect(events.toolFinished).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call-1', success: true }));
    expect(loopStats).toEqual([expect.objectContaining({ finishReason: 'completed' })]);
    expect(traceEvents).toEqual([expect.objectContaining({ type: 'complete', turnId: 'turn-1' })]);
    expect(sessionRestoredEvents).toEqual([expect.objectContaining({
      sessionId: 'session-1',
      restoredMessages: 2,
    })]);
    expect(harnessDiagnostics).toEqual([expect.objectContaining({
      rootObjective: 'ship agent loop',
      evidenceSize: 4,
    })]);
  });

  it('prints full exec_command text in tool transcript entries', () => {
    const { events, appended } = createEvents();
    const presenter = createToolEventPresenter(events);
    const command = 'cd /Users/hope/ai-project/a2a-python && export PATH="$HOME/.local/bin:$PATH" && ./scripts/lint.sh --all';

    presenter.start({
      type: 'tool_call',
      callId: 'call-exec',
      name: 'exec_command',
      args: { command },
      batchCount: 1,
      batchIndex: 0,
    });

    expect(appended[0].content).toBe(`Running exec_command\n  $ ${command}`);
  });

  it('keeps long non-exec tool arguments visible in tool transcript entries', () => {
    const { events, appended } = createEvents();
    const presenter = createToolEventPresenter(events);
    const path = `/Users/hope/ai-project/openhorse/${'deep-directory/'.repeat(14)}target-file.ts`;

    presenter.start({
      type: 'tool_call',
      callId: 'call-read-long-path',
      name: 'read_file',
      args: { path },
      batchCount: 1,
      batchIndex: 0,
    });

    expect(path.length).toBeGreaterThan(160);
    expect(appended[0].content).toBe(`Running read_file ${path}`);
  });

  it('passes batch metadata through tool activity events', () => {
    const { events, appended } = createEvents();
    const presenter = createToolEventPresenter(events);

    presenter.start({
      type: 'tool_call',
      callId: 'call-batch',
      name: 'read_file',
      args: { path: 'src/a.ts' },
      batchCount: 3,
      batchIndex: 1,
    });
    presenter.finish({
      type: 'tool_result',
      callId: 'call-batch',
      name: 'read_file',
      args: { path: 'src/a.ts' },
      result: JSON.stringify({ success: true, output: 'alpha' }),
      modelVisibleResult: JSON.stringify({ success: true, output: 'alpha' }),
      success: true,
      duration: 11,
      batchCount: 3,
      batchIndex: 1,
    });

    expect(events.toolStarted).toHaveBeenCalledWith(expect.objectContaining({
      callId: 'call-batch',
      batchCount: 3,
      batchIndex: 1,
    }));
    expect(events.toolFinished).toHaveBeenCalledWith(expect.objectContaining({
      callId: 'call-batch',
      success: true,
      batchCount: 3,
      batchIndex: 1,
    }));
    expect(appended[0].content).toContain('Batch 2/3');
  });

  it('adapts a protocol event sink back into UiEventSink for renderer compatibility', () => {
    const emitted: Array<{ type: string }> = [];
    const uiEvents = createUiEventSinkFromAgentRuntimeEvents({
      emit: event => {
        emitted.push(event);
        return event.type === 'transcript_append' ? 'runtime-entry-1' : undefined;
      },
    });

    expect(uiEvents.append({ role: 'user', content: 'hello' })).toBe('runtime-entry-1');
    uiEvents.setStatus('working');
    uiEvents.toolStarted?.(makeToolStartedEvent({ callId: 'call-1', name: 'grep', args: { pattern: 'TODO' } }));
    uiEvents.toolFinished?.(makeToolFinishedEvent({
      callId: 'call-1',
      name: 'grep',
      args: { pattern: 'TODO' },
      success: false,
      duration: 34,
      error: 'not found',
    }));
    uiEvents.sessionRestored?.({
      sessionId: 'session-1',
      projectPath: '/tmp/project',
      model: 'test-model',
      restoredMessages: 2,
      messageCount: 2,
    });
    uiEvents.loopStatsUpdated?.({
      turnsStarted: 1,
      llmRequests: 0,
      toolCalls: 1,
      readOnlyToolCalls: 1,
      unsafeToolCalls: 0,
      toolResultBytes: 10,
      modelVisibleToolBytes: 5,
      summarizedBytes: 5,
      finishReason: 'completed',
      singleReadOnlyStreak: 1,
      batchReadSuggestionCount: 0,
      localFastPathUsed: true,
    });
    uiEvents.traceEventRecorded?.({
      sessionId: 'session-1',
      turnId: 'turn-1',
      timestamp: 1,
      type: 'tool_result',
      name: 'grep',
    });
    uiEvents.harnessDiagnosticsUpdated?.({
      taskEpoch: 1,
      rootObjective: 'stabilize runtime',
      ledgerSize: 2,
      evidenceSize: 3,
      turnSummaryCount: 1,
    });
    uiEvents.setProcessing(false);

    expect(emitted.map(event => event.type)).toEqual([
      'transcript_append',
      'status_changed',
      'tool_started',
      'tool_finished',
      'session_restored',
      'loop_stats_updated',
      'trace_event_recorded',
      'harness_diagnostics_updated',
      'processing_changed',
    ]);
  });

  it('sets finishReason to completion_gate when source files changed but verification not run', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      execFileSync('git', ['-C', projectDir, 'init'], { stdio: 'ignore' });
      writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
        scripts: {
          build: 'node -e "process.exit(0)"',
          test: 'node -e "process.exit(0)"',
        },
      }), 'utf-8');
      writeFileSync(join(projectDir, 'src', 'index.ts'), 'export const value = 1;\n', 'utf-8');

      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn()
          .mockResolvedValueOnce({
            content: '',
            model: 'test-model',
            toolCalls: [
              {
                id: 'call-write',
                type: 'function' as const,
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({ path: 'src/index.ts', content: 'export const value = 2;\n' }),
                },
              },
            ],
            usage: { promptTokens: 10, completionTokens: 1 },
          })
          .mockResolvedValueOnce({
            content: 'I have completed the task.',
            model: 'test-model',
            usage: { promptTokens: 12, completionTokens: 2 },
          }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, traceEvents } = createEvents();
      const verificationStates: Array<'pending' | 'running' | 'passed' | 'failed' | 'gated'> = [];
      const controller = new AgentChatController(runtime, events, {
        onVerificationStateChange: state => verificationStates.push(state),
      });

      await expect(controller.runInput('modify src/index.ts', { turnId: 'turn-gate-no-verify' })).resolves.toBeUndefined();

      expect(llm.chatStream).toHaveBeenCalledTimes(2);
      expect(store.getSnapshot().lastLoopStats).toMatchObject({
        finishReason: 'completion_gate',
        verificationClaimAllowed: false,
      });

      expect(session).not.toBeNull();
      const persistedTrace = readSessionTraceEvents(session!.id);
      expect(persistedTrace).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'verification_profile',
          verificationProfile: 'node',
          verificationRequired: true,
          verificationChangedFiles: ['src/index.ts'],
        }),
        expect.objectContaining({
          type: 'verification_summary',
          verificationClaimAllowed: false,
        }),
      ]));
      const completeEvent = persistedTrace.find(event => event.type === 'complete');
      expect(completeEvent).toMatchObject({
        turnId: 'turn-gate-no-verify',
        finishReason: 'completion_gate',
      });

      expect(traceEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'verification_profile',
        }),
        expect.objectContaining({
          type: 'verification_summary',
          verificationClaimAllowed: false,
        }),
      ]));

      const assistantMessage = readSessionMessages(session!.id).at(-1);
      expect(assistantMessage?.content).toContain('Verification Gate');

      // verificationState is wired through the chat flow: 'running' when verification
      // is required, then 'gated' when completion is blocked.
      expect(verificationStates).toContain('running');
      expect(verificationStates).toContain('gated');
    });
  });

  it('allows completion claim when changed-file turn runs verification and passes', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      execFileSync('git', ['-C', projectDir, 'init'], { stdio: 'ignore' });
      writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
        scripts: {
          build: 'node -e "process.exit(0)"',
        },
      }), 'utf-8');
      writeFileSync(join(projectDir, 'src', 'index.ts'), 'export const value = 1;\n', 'utf-8');

      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn()
          .mockResolvedValueOnce({
            content: '',
            model: 'test-model',
            toolCalls: [
              {
                id: 'call-write',
                type: 'function' as const,
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({ path: 'src/index.ts', content: 'export const value = 2;\n' }),
                },
              },
              {
                id: 'call-test',
                type: 'function' as const,
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({ command: 'npm run build' }),
                },
              },
            ],
            usage: { promptTokens: 10, completionTokens: 1 },
          })
          .mockResolvedValueOnce({
            content: 'All tests pass. Task complete.',
            model: 'test-model',
            usage: { promptTokens: 12, completionTokens: 2 },
          }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, loopStats } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('modify and verify', { turnId: 'turn-gate-verify-pass' })).resolves.toBeUndefined();

      expect(llm.chatStream).toHaveBeenCalledTimes(2);
      expect(store.getSnapshot().lastLoopStats).toMatchObject({
        finishReason: 'completed',
      });
      expect(store.getSnapshot().lastLoopStats?.finishReason).not.toBe('completion_gate');
      expect(store.getSnapshot().lastLoopStats?.verificationClaimAllowed).toBe(true);

      expect(session).not.toBeNull();
      const persistedTrace = readSessionTraceEvents(session!.id);
      expect(persistedTrace).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'verification_result',
          verificationCommand: 'npm run build',
          verificationPassed: true,
        }),
      ]));
      const completeEvent = persistedTrace.find(event => event.type === 'complete');
      expect(completeEvent).toMatchObject({
        turnId: 'turn-gate-verify-pass',
        finishReason: 'completed',
      });
      expect(loopStats.at(-1)).toMatchObject({
        finishReason: 'completed',
        verificationClaimAllowed: true,
      });
    });
  });

  it('restores harness objective through 20+ turns of compact and resume', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const rootObjective = '完成 agent-loop final form，确保 compact/resume 后继续正确目标';
      const activeInstruction = '补齐 compact/resume fixture 并保持 root objective';
      const harness = createContextHarness({ cwd: projectDir, modelId: 'test-model' });
      harness.updateContractFromUserInput(rootObjective);
      harness.updateContractFromUserInput(activeInstruction);
      const harnessState = harness.toJSON();

      // Build 20+ sequential user/assistant message pairs
      const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (let i = 1; i <= 22; i++) {
        history.push({ role: 'user', content: `Turn ${i} user request` });
        history.push({ role: 'assistant', content: `Turn ${i} assistant response with details about task ${i}` });
      }
      const oldHiddenAssistant = 'RAW_ASSISTANT_TRANSCRIPT_SHOULD_NOT_BE_RESTORED';
      // Add a marker message that must not appear after compact
      history.push({ role: 'user', content: 'marker question' });
      history.push({ role: 'assistant', content: oldHiddenAssistant });

      store.setState({
        conversationHistory: history,
        harnessState,
      });

      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async (
          messages: Array<{ role: string; content: string }>,
          callbacks?: { onChunk?: (chunk: string) => void },
        ) => {
          callbacks?.onChunk?.('继续处理 compact/resume 20-turn fixture');
          return {
            content: '继续处理 compact/resume 20-turn fixture',
            model: 'test-model',
            usage: { promptTokens: 100, completionTokens: 10 },
          };
        }),
      };
      let session = createSession(projectDir, 'test-model');
      appendSessionMessages(session.id, history.map((message, index) => ({
        ...message,
        timestamp: Date.now() - 10_000 + index,
      })));
      updateSessionHarnessState(session.id, harnessState);

      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => session),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          if (nextSession) session = nextSession;
        }),
      });
      const { events } = createEvents();
      const controller = new AgentChatController(runtime, events);

      // Compact the long session
      await expect(controller.runInput('/compact 2')).resolves.toBeUndefined();
      const persistedAfterCompact = readSessionMessages(session.id);
      expect(persistedAfterCompact).toHaveLength(history.length);
      expect(loadSessionCompactCheckpoint(session.id)).not.toBeNull();

      // Resume the compacted session
      await expect(controller.runInput(`/resume ${session.id}`)).resolves.toBeUndefined();
      // After resume, the store contains restored messages including compacted history.
      // The verification of exclusion happens at model-context time below.

      // Continue with 继续
      await expect(controller.runInput('继续', { turnId: 'turn-resume-20' })).resolves.toBeUndefined();

      expect(llm.chatStream).toHaveBeenCalledTimes(1);
      const modelMessages = (llm.chatStream as jest.Mock).mock.calls[0][0] as Array<{ role: string; content: string }>;
      const modelContext = modelMessages.map(message => message.content).join('\n');
      expect(modelContext).toContain(rootObjective);
      expect(modelContext).toContain('[Orion Code Context State v2]');
      // Raw assistant transcripts from compacted turns (not marker messages)
      // should not appear in the model context
      expect(modelContext).not.toContain('Turn 5 assistant response');
      expect(modelContext).not.toContain('Turn 10 assistant response');
      expect(modelContext).not.toContain('Turn 15 assistant response');
      expect(modelContext).toContain(activeInstruction);
      expect(store.getSnapshot().harnessState).toMatchObject({
        rootObjective,
        activeInstruction,
      });
      expect(store.getSnapshot().lastLoopStats?.finishReason).not.toBe('completion_gate');
    });
  });

  it('redacts prompt assembly trace events so raw prompt content never leaks', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async () => ({
          content: 'Here is my response with OPENAI_API_KEY=sk-leaked-secret-999',
          model: 'test-model',
          usage: { promptTokens: 10, completionTokens: 2 },
        })),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, traceEvents } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('show me API keys', { turnId: 'turn-prompt-leak' })).resolves.toBeUndefined();

      expect(session).not.toBeNull();
      const persistedTrace = readSessionTraceEvents(session!.id);
      const promptAssembly = persistedTrace.find(event => event.type === 'prompt_assembly');
      expect(promptAssembly).toBeDefined();
      expect(promptAssembly).toMatchObject({
        type: 'prompt_assembly',
        promptIncludedEvidenceCount: expect.any(Number),
        promptOmittedEvidenceCount: expect.any(Number),
      });

      // Verify prompt_assembly trace events do NOT contain the raw secret
      const promptAssemblyEvents = persistedTrace.filter(event => event.type === 'prompt_assembly');
      for (const event of promptAssemblyEvents) {
        const serialized = JSON.stringify(event);
        expect(serialized).not.toContain('sk-leaked-secret-999');
      }

      // Verify emitted trace events also do not contain the secret
      const emittedPromptEvents = traceEvents.filter(event => (event as { type?: string }).type === 'prompt_assembly');
      for (const event of emittedPromptEvents) {
        const serialized = JSON.stringify(event);
        expect(serialized).not.toContain('sk-leaked-secret-999');
      }
    });
  });

  it('prevents file mutation and records clear finish reason on permission denial', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'package.json'), '{"name":"test"}', 'utf-8');
      const targetPath = join(projectDir, 'target.txt');
      writeFileSync(targetPath, 'original content', 'utf-8');

      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
        toolConfirmation: 'deny',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async () => ({
          content: '',
          model: 'test-model',
          toolCalls: [
            {
              id: 'call-write-deny',
              type: 'function' as const,
              function: {
                name: 'write_file',
                arguments: JSON.stringify({ path: 'target.txt', content: 'malicious overwrite' }),
              },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 1 },
        })),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, loopStats } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('overwrite target', { turnId: 'turn-deny-mutation' })).resolves.toBeUndefined();

      // Verify no file was actually written
      expect(readFileSync(targetPath, 'utf-8')).toBe('original content');

      // Verify finishReason is blocked
      expect(store.getSnapshot().lastLoopStats).toMatchObject({
        finishReason: 'blocked',
      });
      expect(loopStats.at(-1)).toMatchObject({
        finishReason: 'blocked',
      });

      // Verify the denial trace event includes permissionSource
      expect(session).not.toBeNull();
      const persistedTrace = readSessionTraceEvents(session!.id);
      const denialEvent = persistedTrace.find(event => event.type === 'permission_decision');
      expect(denialEvent).toMatchObject({
        type: 'permission_decision',
        turnId: 'turn-deny-mutation',
        name: 'write_file',
        permissionApproved: false,
        permissionSource: 'config_deny',
      });

      // Verify no workspace_delta shows the denied file as changed
      const deltaEvent = persistedTrace.find(event => event.type === 'workspace_delta');
      if (deltaEvent) {
        const changedFiles = (deltaEvent as any).workspaceChangedByTurn || [];
        expect(changedFiles).not.toContain('target.txt');
      }

      const completeEvent = persistedTrace.find(event => event.type === 'complete');
      expect(completeEvent).toMatchObject({
        turnId: 'turn-deny-mutation',
        finishReason: 'blocked',
      });
    });
  });

  it('redacts secrets from trace events, prompt stats, summaries, and artifact indexes', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'secrets.env'), 'OPENAI_API_KEY=sk-secret123\nANTHROPIC_API_KEY=sk-ant-secret456\n', 'utf-8');

      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn()
          .mockResolvedValueOnce({
            content: '',
            model: 'test-model',
            toolCalls: [
              {
                id: 'call-grep-secret',
                type: 'function' as const,
                function: {
                  name: 'grep',
                  arguments: JSON.stringify({ pattern: 'OPENAI_API_KEY=sk-secret123' }),
                },
              },
            ],
            usage: { promptTokens: 10, completionTokens: 1 },
          })
          .mockResolvedValueOnce({
            content: 'Found the API key in the env file.',
            model: 'test-model',
            usage: { promptTokens: 12, completionTokens: 2 },
          }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, traceEvents } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('find API keys', { turnId: 'turn-secret-trace' })).resolves.toBeUndefined();

      expect(session).not.toBeNull();

      // Verify trace events do not contain the secret
      const persistedTrace = readSessionTraceEvents(session!.id);
      const traceSerialized = JSON.stringify(persistedTrace);
      expect(traceSerialized).not.toContain('sk-secret123');
      expect(traceSerialized).not.toContain('sk-ant-secret456');

      // Verify artifact indexes do not store the raw secret
      const artifacts = listArtifacts(projectDir);
      for (const artifact of artifacts) {
        const artifactContent = retrieveArtifact(artifact.path);
        if (artifactContent) {
          expect(artifactContent).not.toContain('sk-secret123');
          expect(artifactContent).not.toContain('sk-ant-secret456');
        }
      }

      // Verify assistant messages (non-tool) do not contain the secret in their content
      const messages = readSessionMessages(session!.id);
      for (const message of messages) {
        if (message.role === 'assistant' || message.role === 'user') {
          const msgContent = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
          expect(msgContent).not.toContain('sk-secret123');
          expect(msgContent).not.toContain('sk-ant-secret456');
        }
      }

      // Verify emitted trace events do not contain the secret
      const emittedSerialized = JSON.stringify(traceEvents);
      expect(emittedSerialized).not.toContain('sk-secret123');
      expect(emittedSerialized).not.toContain('sk-ant-secret456');
    });
  });

  it('transitions verification state through pending → running → passed during a turn', () => {
    const runtime = createRuntime();
    const { events } = createEvents();
    const runner = createDeferredRunner();
    const controller = new AgentRuntimeController({ runtime, events, runner });

    // Start a turn
    expect(controller.submit('verify this')).toEqual({ type: 'started' });

    // Set verification pending
    controller.setVerificationState('pending');
    expect(controller.getVerificationState()).toBe('pending');

    // Set verification running
    controller.setVerificationState('running');
    expect(controller.getVerificationState()).toBe('running');

    // Set verification passed
    controller.setVerificationState('passed');
    expect(controller.getVerificationState()).toBe('passed');

    // Resolve the turn
    runner.calls[0].resolve();
  });

  it('emits reconcile diagnostic when harness state is present but objective is missing', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      // Create harness state with empty objective
      const harness = createContextHarness({ cwd: projectDir, modelId: 'test-model' });
      const harnessState = harness.toJSON();
      // Explicitly clear the objective to simulate incomplete restoration
      harnessState.rootObjective = undefined as any;
      if (harnessState.contract) {
        harnessState.contract.objective = '';
      }
      store.setState({ harnessState });

      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async (
          _messages: unknown,
          callbacks?: { onChunk?: (chunk: string) => void },
        ) => {
          callbacks?.onChunk?.('I will continue working.');
          return {
            content: 'I will continue working.',
            model: 'test-model',
            usage: { promptTokens: 10, completionTokens: 2 },
          };
        }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, statuses } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('继续', { turnId: 'turn-reconcile' })).resolves.toBeUndefined();

      expect(statuses).toEqual(expect.arrayContaining([
        expect.stringContaining('Resume diagnostic: harness state restored but objective may be incomplete'),
      ]));
    });
  });

  it('classifies command safety levels correctly', () => {
    const { classifyCommandSafety } = require('../src/services/verification-profile');

    // High risk
    expect(classifyCommandSafety('rm -rf /tmp/test')).toEqual({ risk: 'high', reason: expect.any(String) });
    expect(classifyCommandSafety('sudo echo hi')).toEqual({ risk: 'high', reason: expect.any(String) });
    expect(classifyCommandSafety('git push --force origin main')).toEqual({ risk: 'high', reason: expect.any(String) });

    // Medium risk
    expect(classifyCommandSafety('npm install lodash')).toEqual({ risk: 'medium', reason: expect.any(String) });
    expect(classifyCommandSafety('git commit -m "fix"')).toEqual({ risk: 'medium', reason: expect.any(String) });
    expect(classifyCommandSafety('make build')).toEqual({ risk: 'medium', reason: expect.any(String) });

    // Low risk
    expect(classifyCommandSafety('npm test')).toEqual({ risk: 'low', reason: expect.any(String) });
    expect(classifyCommandSafety('ls -la')).toEqual({ risk: 'low', reason: expect.any(String) });
    expect(classifyCommandSafety('git status')).toEqual({ risk: 'low', reason: expect.any(String) });

    // Unknown
    expect(classifyCommandSafety('some-random-tool --flag')).toEqual({
      risk: 'unknown',
      reason: 'command does not match known safety patterns',
    });
  });

  it('records dirty worktree state before edits in a modified repo', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      execFileSync('git', ['-C', projectDir, 'init'], { stdio: 'ignore' });
      execFileSync('git', ['-C', projectDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
      execFileSync('git', ['-C', projectDir, 'config', 'user.name', 'Test User'], { stdio: 'ignore' });
      // Create a file and commit it
      writeFileSync(join(projectDir, 'src.ts'), 'export const x = 0;\n', 'utf-8');
      execFileSync('git', ['-C', projectDir, 'add', 'src.ts'], { stdio: 'ignore' });
      execFileSync('git', ['-C', projectDir, 'commit', '-m', 'initial'], { stdio: 'ignore' });
      // Modify the file without committing — makes the worktree dirty
      writeFileSync(join(projectDir, 'src.ts'), 'export const x = 1;\n', 'utf-8');

      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn()
          .mockResolvedValueOnce({
            content: '',
            model: 'test-model',
            toolCalls: [
              {
                id: 'call-edit',
                type: 'function' as const,
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({ path: 'src.ts', content: 'export const x = 2;\n' }),
                },
              },
            ],
            usage: { promptTokens: 10, completionTokens: 1 },
          })
          .mockResolvedValueOnce({
            content: 'done',
            model: 'test-model',
            usage: { promptTokens: 12, completionTokens: 2 },
          }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('edit src.ts', { turnId: 'turn-dirty' })).resolves.toBeUndefined();

      expect(session).not.toBeNull();
      const traceEvents = readSessionTraceEvents(session!.id);
      const snapshots = traceEvents.filter(event => event.type === 'workspace_snapshot');
      expect(snapshots.length).toBeGreaterThanOrEqual(2);

      // The pre_turn snapshot should show dirty: true
      const preSnapshot = snapshots.find(event => (event as any).workspacePhase === 'pre_turn');
      expect(preSnapshot).toBeDefined();
      expect((preSnapshot as any).workspaceDirty).toBe(true);

      // The pre_turn snapshot should capture the dirtied state correctly
      expect((preSnapshot as any).workspaceFiles).toEqual(expect.arrayContaining([
        expect.stringContaining('src.ts'),
      ]));
    });
  });


});
