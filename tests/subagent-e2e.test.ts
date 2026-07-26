/**
 * End-to-end subagent test: root AgentChatController → subtask tool →
 * supervisor → child query (mock) → structured result → root continues.
 *
 * This is the "single ring" test: if it passes, the entire subagent pipeline
 * is wired end-to-end through the runtime, without a live LLM provider.
 *
 * The child LLM is mocked via `createProductionExecuteQuery` so no real HTTP
 * calls are made. The root LLM is a jest mock that issues tool_calls and then
 * synthesizes.
 */

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AgentChatController } from '../src/runtime/chat-controller';
import { loadConfig } from '../src/services/config';
import { Store } from '../src/framework/store';
import { TOOLS } from '../src/tools';
import { createContextHarness } from '../src/harness';
import {
  createSession,
  type SessionMeta,
} from '../src/services/session-storage';
import type { OpenHorseUiRuntime } from '../src/runtime/ui-events';
import { DEFAULT_SUBAGENT_CONFIG } from '../src/runtime/subagents/types';
import type { ExecuteChildQuery } from '../src/runtime/subagents/runner';

// ---------------------------------------------------------------------------
// Mock the production child-query factory so no real LLM calls are made.
// Each test can override `mockExecuteQuery` before creating the controller.
// ---------------------------------------------------------------------------
let mockExecuteQuery: ExecuteChildQuery = async () => ({
  content: JSON.stringify({
    summary: 'mock child result',
    findings: [{ title: 'found something', severity: 'low' as const, evidence: 'mock evidence for e2e test' }],
    files: [],
    commands: [],
    verification: [],
    risks: [],
  }),
  usage: { modelRequests: 1, toolCalls: 0, promptTokens: 50, completionTokens: 20, durationMs: 100 },
});

jest.mock('../src/runtime/subagents/production', () => ({
  ...jest.requireActual('../src/runtime/subagents/production'),
  createProductionExecuteQuery: (_deps: unknown) => mockExecuteQuery,
  createChildLlmConfig: jest.requireActual('../src/runtime/subagents/production').createChildLlmConfig,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeEvents() {
  const appended: Array<{ role: string; content: string }> = [];
  const subtaskEventLog: Array<{ state: string; role: string }> = [];
  return {
    appended,
    subtaskEventLog,
    events: {
      append: (entry: { role: string; content: string }) => {
        appended.push(entry);
        return `e-${appended.length}`;
      },
      update: jest.fn(),
      finalize: jest.fn(),
      remove: jest.fn(),
      replaceTranscript: jest.fn(),
      clearTranscript: jest.fn(),
      setStatus: jest.fn(),
      showSessionPicker: jest.fn(),
      showEditPreview: jest.fn(),
      showPermissionRequest: jest.fn(),
      toolStarted: jest.fn(),
      toolFinished: jest.fn(),
      sessionRestored: jest.fn(),
      loopStatsUpdated: jest.fn(),
      traceEventRecorded: jest.fn(),
      harnessDiagnosticsUpdated: jest.fn(),
      subtaskEvent: (e: { state: string; role: string }) => {
        subtaskEventLog.push(e);
      },
      setProcessing: jest.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subagent end-to-end', () => {
  let projectDir: string;
  let session: SessionMeta;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'openhorse-subagent-e2e-'));
    session = createSession(projectDir, 'test-model');

    // Default mock child query returns a valid structured result.
    mockExecuteQuery = async () => ({
      content: JSON.stringify({
        summary: 'mock child result',
        findings: [{ title: 'found something', severity: 'low' as const, evidence: 'mock evidence for e2e test' }],
        files: [],
        commands: [],
        verification: [],
        risks: [],
      }),
      usage: { modelRequests: 1, toolCalls: 0, promptTokens: 50, completionTokens: 20, durationMs: 100 },
    });
  });

  afterEach(() => {
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /**
   * The LLM issues a single `subtask` tool_call, the tool runs to completion
   * (mock child query returns a well-formed JSON result), the structured result
   * is returned to the root, and the root continues with its own response.
   */
  it('root LLM invokes subtask and receives structured batch result', async () => {
    const config = loadConfig({
      apiKey: 'test-key',
      model: 'test-model',
      subagents: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'auto' },
    });
    const store = new Store({ config, tools: TOOLS, currentModel: 'test-model' });
    const harness = createContextHarness({ cwd: projectDir, modelId: 'test-model' });
    harness.updateContractFromUserInput('parallel research of runtime, session, and tui modules for cancel-semantic regressions');
    store.setState({ harnessState: harness.toJSON() });

    // Mock root LLM: first response is a tool_call to `subtask`; second is the
    // root's synthesis after receiving the structured batch result.
    let turn = 0;
    const llm = {
      getModel: jest.fn(() => 'test-model'),
      chatStream: jest.fn(async (
        _messages: Array<{ role: string; content: string }>,
        callbacks?: { onChunk?: (chunk: string) => void },
        tools?: Array<{ function: { name: string } }>,
      ) => {
        turn += 1;
        if (turn === 1) {
          // The system prompt should contain subagent guidance because subtask
          // is in the tool list. Verify that invariant first.
          const systemMsgs = _messages.filter(m => m.role === 'system');
          const systemText = systemMsgs.map(m => m.content).join('\n');
          expect(systemText).toMatch(/Subagent capability/);
          expect(tools?.some(t => t.function.name === 'subtask')).toBe(true);

          // Issue a subtask tool call with 2 independent research packets.
          // Note: content must be '' (not null) because the harness calls
          // response.content.trim() on tool-call responses.
          callbacks?.onChunk?.('');
          return {
            content: '',
            model: 'test-model',
            toolCalls: [
              {
                index: 0,
                id: 'call-subtask-1',
                type: 'function' as const,
                function: {
                  name: 'subtask',
                  arguments: JSON.stringify({
                    tasks: [
                      {
                        role: 'research',
                        objective: 'Investigate cancel-signal handlers in the runtime module',
                        reason: 'independent module from session and tui',
                      },
                      {
                        role: 'review',
                        objective: 'Review the session-storage cancel path for dangling handles',
                        reason: 'independent from runtime module',
                      },
                    ],
                    execution: 'parallel',
                  }),
                },
              },
            ],
            usage: { promptTokens: 200, completionTokens: 30 },
          };
        }
        // Turn 2: root synthesizes after receiving the structured result.
        callbacks?.onChunk?.('synthesis of child findings');
        return {
          content: 'synthesis of child findings',
          model: 'test-model',
          usage: { promptTokens: 300, completionTokens: 20 },
        };
      }),
    };

    const runtime = createRuntime({
      cwd: projectDir,
      config,
      store,
      llm: llm as any,
      isConfigured: true,
      ensureSession: jest.fn(() => session),
      getSession: jest.fn(() => session),
      setSession: jest.fn(),
    });

    const evLog = makeEvents();
    const controller = new AgentChatController(runtime as unknown as OpenHorseUiRuntime, evLog.events);

    await expect(controller.runInput('parallel research of runtime, session, and tui modules for cancel-semantic regressions')).resolves.toBeUndefined();

    // 1. Two turns of LLM calls (subtask + synthesis)
    expect(llm.chatStream).toHaveBeenCalledTimes(2);

    // 2. Subtask lifecycle events were emitted (queued, running, completed ×2)
    expect(evLog.subtaskEventLog.length).toBeGreaterThanOrEqual(4);
    const states = evLog.subtaskEventLog.map(e => e.state);
    expect(states).toContain('queued');
    expect(states).toContain('running');
    expect(states.filter(s => s === 'completed')).toHaveLength(2);

    // 3. Transcript contains subtask start/completion summaries
    const transcriptText = evLog.appended.map(e => e.content).join('\n');
    expect(transcriptText).toMatch(/▸ subtask research started/);
    expect(transcriptText).toMatch(/◂ subtask research completed/);
    expect(transcriptText).toMatch(/▸ subtask review started/);
    expect(transcriptText).toMatch(/◂ subtask review completed/);

    // 4. Root's final response is in transcript
    expect(transcriptText).toMatch(/synthesis of child findings/);

    // 5. Loop stats include subagent usage
    const statsCalls = (evLog.events.loopStatsUpdated as jest.Mock).mock.calls;
    expect(statsCalls.length).toBeGreaterThanOrEqual(1);
    const finalStats = statsCalls[statsCalls.length - 1][0];
    // Child usage was folded in: modelRequests should be >0
    expect(finalStats.llmRequests).toBeGreaterThan(0);
    expect(finalStats.toolCalls).toBeGreaterThan(0);
    // continuationHint mentions subagents
    expect(finalStats.continuationHint).toMatch(/subagents:/);
  });

  /**
   * When subagent mode is `off`, the subtask tool is NOT in the tool list and
   * the system prompt does NOT contain subagent guidance. The LLM should not
   * even attempt to call it.
   */
  it('does not expose subtask tool when mode is off', async () => {
    const config = loadConfig({
      apiKey: 'test-key',
      model: 'test-model',
      subagents: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'off' },
    });
    const store = new Store({ config, tools: TOOLS, currentModel: 'test-model' });
    const llm = {
      getModel: jest.fn(() => 'test-model'),
      chatStream: jest.fn(async (
        _messages: Array<{ role: string; content: string }>,
        callbacks?: { onChunk?: (chunk: string) => void },
        tools?: Array<{ function: { name: string } }>,
      ) => {
        // subtask must not be in the tool list
        expect(tools?.some(t => t.function.name === 'subtask')).toBe(false);
        // system prompt must not mention subagents
        const systemText = _messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
        expect(systemText).not.toMatch(/Subagent capability/);
        callbacks?.onChunk?.('ok');
        return { content: 'ok', model: 'test-model', usage: { promptTokens: 10, completionTokens: 2 } };
      }),
    };

    const runtime = createRuntime({
      cwd: projectDir,
      config,
      store,
      llm: llm as any,
      isConfigured: true,
      ensureSession: jest.fn(() => session),
      getSession: jest.fn(() => session),
      setSession: jest.fn(),
    });

    const evLog2 = makeEvents();
    const controller = new AgentChatController(runtime as unknown as OpenHorseUiRuntime, evLog2.events);

    await controller.runInput('hello');
    expect(llm.chatStream).toHaveBeenCalledTimes(1);
    expect(evLog2.subtaskEventLog).toHaveLength(0);
  });

  /**
   * A skill-scoped turn must NOT receive the subtask tool (the skill owns the
   * scope). This protects skill-restricted tool sets from gaining a powerful
   * orchestration capability they didn't opt into.
   */
  it('does not expose subtask tool when a skill scope is active', async () => {
    const config = loadConfig({
      apiKey: 'test-key',
      model: 'test-model',
      subagents: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'auto' },
    });
    const store = new Store({ config, tools: TOOLS, currentModel: 'test-model' });
    const llm = {
      getModel: jest.fn(() => 'test-model'),
      chatStream: jest.fn(async (
        _messages: Array<{ role: string; content: string }>,
        callbacks?: { onChunk?: (chunk: string) => void },
        tools?: Array<{ function: { name: string } }>,
      ) => {
        expect(tools?.some(t => t.function.name === 'subtask')).toBe(false);
        callbacks?.onChunk?.('code review done');
        return { content: 'code review done', model: 'test-model', usage: { promptTokens: 10, completionTokens: 2 } };
      }),
    };

    const runtime = createRuntime({
      cwd: projectDir,
      config,
      store,
      llm: llm as any,
      isConfigured: true,
      ensureSession: jest.fn(() => session),
      getSession: jest.fn(() => session),
      setSession: jest.fn(),
    });

    const evLog3 = makeEvents();
    const controller = new AgentChatController(runtime as unknown as OpenHorseUiRuntime, evLog3.events);

    // /skill code-review activates a tool scope (only glob, grep, read_file)
    await controller.runInput('/skill code-review inspect src');
    expect(llm.chatStream).toHaveBeenCalledTimes(1);
    expect(evLog3.subtaskEventLog).toHaveLength(0);
  });

  /**
   * When a child fails (provider error), the root still receives the batch
   * result with mixed statuses and can continue from the successful child's
   * findings. This proves failure isolation.
   */
  it('isolates child failure so root continues from successful children', async () => {
    // Override: first child query succeeds, second throws (simulating provider error).
    let childCallCount = 0;
    mockExecuteQuery = async () => {
      childCallCount += 1;
      if (childCallCount === 1) {
        return {
          content: JSON.stringify({
            summary: 'first child found issues',
            findings: [{ title: 'cancel path has dangling handles', severity: 'high' as const, evidence: 'mock evidence' }],
            files: [],
            commands: [],
            verification: [],
            risks: [],
          }),
          usage: { modelRequests: 1, toolCalls: 1, promptTokens: 50, completionTokens: 30, durationMs: 100 },
        };
      }
      throw new Error('provider error: 503 service unavailable');
    };

    const config = loadConfig({
      apiKey: 'test-key',
      model: 'test-model',
      subagents: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'auto' },
    });
    const store = new Store({ config, tools: TOOLS, currentModel: 'test-model' });
    const harness = createContextHarness({ cwd: projectDir, modelId: 'test-model' });
    harness.updateContractFromUserInput('investigate runtime and session');
    store.setState({ harnessState: harness.toJSON() });

    let turn = 0;
    const llm = {
      getModel: jest.fn(() => 'test-model'),
      chatStream: jest.fn(async (
        _messages: Array<{ role: string; content: string }>,
        callbacks?: { onChunk?: (chunk: string) => void },
        _tools?: Array<{ function: { name: string } }>,
      ) => {
        turn += 1;
        if (turn === 1) {
          callbacks?.onChunk?.('');
          return {
            content: '',
            model: 'test-model',
            toolCalls: [{
              index: 0, id: 'call-1', type: 'function' as const,
              function: {
                name: 'subtask',
                arguments: JSON.stringify({
                  tasks: [
                    { role: 'research', objective: 'Investigate the runtime module cancel paths', reason: 'independent' },
                    { role: 'research', objective: 'Investigate the session module cancel paths', reason: 'independent' },
                  ],
                }),
              },
            }],
            usage: { promptTokens: 100, completionTokens: 20 },
          };
        }
        callbacks?.onChunk?.('root analysis after mixed results');
        return { content: 'root analysis after mixed results', model: 'test-model', usage: { promptTokens: 50, completionTokens: 10 } };
      }),
    };

    const runtime = createRuntime({
      cwd: projectDir,
      config,
      store,
      llm: llm as any,
      isConfigured: true,
      ensureSession: jest.fn(() => session),
      getSession: jest.fn(() => session),
      setSession: jest.fn(),
    });

    const evLog4 = makeEvents();
    const controller = new AgentChatController(runtime as unknown as OpenHorseUiRuntime, evLog4.events);

    await controller.runInput('investigate runtime and session in parallel');
    // Root continued after mixed child results.
    expect(llm.chatStream).toHaveBeenCalledTimes(2);
    const transcriptText = evLog4.appended.map(e => e.content).join('\n');
    expect(transcriptText).toMatch(/root analysis after mixed results/);
    // At least one child completed.
    expect(evLog4.subtaskEventLog.filter(e => e.state === 'completed').length).toBeGreaterThanOrEqual(1);
    // At least one child failed.
    expect(evLog4.subtaskEventLog.filter(e => e.state === 'failed').length).toBeGreaterThanOrEqual(1);
  });
});
