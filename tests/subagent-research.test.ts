import {
  CasMismatchError,
  SubagentBudgetLedger,
  SubagentProviderGate,
  buildResearchView,
  budgetLimitsFromConfig,
  createMemoryArtifactStore,
  createResearchRequestForSubtask,
  createSubtaskTool,
  filterToolsForRole,
  loadResearchPacket,
  resolveCitations,
  resumeResearchState,
  runSubtaskBatch,
  saveResearchPacket,
  subtaskResultToPacket,
  toLifecycleEvents,
  type SubagentSupervisorDeps,
  type SubtaskPacket,
  type SubtaskResearchResultContext,
  type SubtaskResult,
  type WebResearchResult,
} from '../src/runtime/subagents';
import { DEFAULT_SUBAGENT_CONFIG } from '../src/runtime/subagents/types';
import type { ExecuteChildQuery } from '../src/runtime/subagents/runner';

const EMPTY_TOOLS = { tools: [], toolExecutor: async () => '' };

function usage(modelRequests = 1, durationMs = 10) {
  return {
    modelRequests,
    toolCalls: 0,
    promptTokens: 11,
    completionTokens: 7,
    durationMs,
    usageComplete: true,
  };
}

function researchTask(objective: string, research?: SubtaskPacket['research']): SubtaskPacket {
  return {
    role: 'research',
    objective,
    reason: 'independent research direction',
    scope: { paths: [`src/${objective.startsWith('first') ? 'first' : 'second'}.ts`] },
    ...(research ? { research } : {}),
  };
}

function webResult(): WebResearchResult {
  return {
    sources: [
      {
        id: 'web-1',
        kind: 'web_page',
        canonicalUrl: 'https://example.com/docs',
        displayUrl: 'https://example.com/docs',
        title: 'Official docs',
        excerpt: 'documented behavior',
        provider: 'dedicated-web-test',
        retrievedAt: '2026-08-09T00:00:00.000Z',
        contentHash: 'abc123',
        status: 'retrieved',
      },
    ],
    skipped: [],
    blocked: [],
    provider: 'dedicated-web-test',
    bytesFetched: 19,
    durationMs: 5,
    truncatedDueToBytes: false,
    timedOut: false,
    aborted: false,
    notes: [],
  };
}

function makeDeps(
  executeQuery: ExecuteChildQuery,
  overrides: Partial<SubagentSupervisorDeps> = {}
): SubagentSupervisorDeps {
  const config = {
    ...DEFAULT_SUBAGENT_CONFIG,
    mode: 'explicit' as const,
    ...(overrides.config ?? {}),
  };
  return {
    cwd: '/tmp/orion-subagent-research',
    budget: new SubagentBudgetLedger(
      budgetLimitsFromConfig({
        maxModelRequestsPerTurn: config.maxModelRequestsPerTurn,
        maxModelRequestsPerTask: config.maxModelRequestsPerTask,
        maxToolCallsPerTask: config.maxToolCallsPerTask,
        timeoutMs: config.timeoutMs,
      })
    ),
    providerGate: new SubagentProviderGate({ maxConcurrent: config.maxParallel }),
    executeQuery,
    toolSet: EMPTY_TOOLS,
    rootObjectiveSummary: 'Research these independent subagent questions',
    ...overrides,
    config,
  };
}

function completedResult(id = 'task-fixture'): SubtaskResult {
  return {
    id,
    role: 'research',
    status: 'completed',
    summary: 'repository and external behavior confirmed',
    findings: [
      {
        title: 'runtime path',
        evidence: 'src/runtime/subagents/supervisor.ts',
        file: 'src/runtime/subagents/supervisor.ts',
      },
    ],
    files: ['src/runtime/subagents/supervisor.ts'],
    commands: [],
    verification: ['run focused contract test'],
    risks: [],
    usage: usage(),
  };
}

describe('research subagent end-to-end contract (#90/#100)', () => {
  it('defaults to local and asks the parent before a typed mixed capability', () => {
    const deps = makeDeps(async () => ({ content: '{"summary":"ok"}', usage: usage() }), {
      runWebResearch: async () => webResult(),
    });
    const tool = createSubtaskTool(deps);
    const context = { cwd: deps.cwd, config: { name: 'test', mode: 'test' } };

    const localArgs = {
      tasks: [{ role: 'research', objective: 'inspect local runtime', reason: 'independent' }],
    };
    const mixedArgs = {
      tasks: [
        {
          role: 'research',
          objective: 'inspect mixed runtime',
          reason: 'independent',
          research: {
            mode: 'mixed',
            domains: ['example.com'],
            maxSources: 4,
            maxFetchBytes: 4096,
            maxDurationMs: 5000,
          },
        },
      ],
    };

    expect(tool.checkPermissions?.(localArgs, context).behavior).toBe('allow');
    expect(tool.checkPermissions?.(mixedArgs, context)).toMatchObject({ behavior: 'ask' });
    expect(
      filterToolsForRole(
        ['read_file', 'web_search', 'web_fetch', 'mcp__remote', 'write_file'],
        'research'
      )
    ).toEqual(['read_file']);
  });

  it('preserves request order/packet identity and passes the original request plus web sources', async () => {
    const contexts = new Map<
      string,
      { result: SubtaskResult; research?: SubtaskResearchResultContext }
    >();
    let webCalls = 0;
    const executeQuery: ExecuteChildQuery = async messages => {
      const text = JSON.stringify(messages);
      const first = text.includes('first research objective');
      await new Promise(resolve => setTimeout(resolve, first ? 25 : 2));
      return {
        content: JSON.stringify({
          summary: first ? 'first result' : 'second result',
          findings: [
            {
              title: 'finding',
              evidence: first ? 'src/first.ts:1' : 'src/second.ts:1',
              file: first ? 'src/first.ts' : 'src/second.ts',
            },
          ],
          files: [first ? 'src/first.ts' : 'src/second.ts'],
        }),
        usage: usage(1, first ? 25 : 2),
      };
    };
    const deps = makeDeps(executeQuery, {
      runWebResearch: async request => {
        webCalls += 1;
        expect(request.mode).toBe('mixed');
        return webResult();
      },
      onSubtaskResult: (result, _batchId, objective, research) => {
        contexts.set(objective!, { result, research });
      },
    });
    const outcome = await runSubtaskBatch(
      {
        execution: 'parallel',
        tasks: [
          researchTask('first research objective'),
          researchTask('second mixed objective', {
            mode: 'mixed',
            domains: ['example.com'],
            maxSources: 5,
            maxFetchBytes: 4096,
            maxDurationMs: 5000,
          }),
        ],
      },
      deps
    );

    expect(outcome.rejected).toBe(false);
    expect(outcome.result.results.map(result => result.summary)).toEqual([
      'first result',
      'second result',
    ]);
    expect(new Set(outcome.result.results.map(result => result.id)).size).toBe(2);
    expect(outcome.result.aggregateUsage.modelRequests).toBe(2);
    expect(webCalls).toBe(1);

    const local = contexts.get('first research objective')!;
    const mixed = contexts.get('second mixed objective')!;
    expect(local.research?.request.mode).toBe('local');
    expect(mixed.research?.request).toMatchObject({
      mode: 'mixed',
      maxSources: 5,
      maxFetchBytes: 4096,
      scope: { projectRoot: deps.cwd, domains: ['example.com'] },
    });

    const packet = subtaskResultToPacket(
      mixed.result,
      mixed.research!.request,
      { projectPath: deps.cwd, sessionId: 'session-1' },
      { externalSources: mixed.research!.web?.sources }
    );
    expect(packet.packetId).toBe(`pkt-${mixed.result.id}`);
    expect(packet.sources.map(source => source.kind)).toEqual(['file', 'web_page']);
    expect(packet.request.mode).toBe('mixed');
  });

  it('fails closed for unavailable web, budget exhaustion, timeout, and parent cancellation', async () => {
    const task = researchTask('bounded mixed objective', {
      mode: 'mixed',
      maxSources: 2,
      maxFetchBytes: 100,
      maxDurationMs: 1000,
    });
    const unavailable = await runSubtaskBatch(
      { tasks: [task], execution: 'serial' },
      makeDeps(async () => ({ content: '{"summary":"should not run"}', usage: usage() }))
    );
    expect(unavailable).toMatchObject({
      rejected: true,
      rejectReason: 'external_research_unavailable',
    });

    const budgetDeps = makeDeps(
      async () => ({ content: '{"summary":"should not run"}', usage: usage() }),
      { config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'explicit', maxModelRequestsPerTurn: 1 } }
    );
    const budget = await runSubtaskBatch(
      {
        tasks: [researchTask('budget direction one'), researchTask('budget direction two')],
        execution: 'parallel',
      },
      budgetDeps
    );
    expect(budget.rejectReason).toBe('budget_exhausted');

    const waitForAbort: ExecuteChildQuery = async (_messages, _tools, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const timedOut = await runSubtaskBatch(
      { tasks: [researchTask('timeout research objective')], execution: 'serial' },
      makeDeps(waitForAbort, {
        config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'explicit', timeoutMs: 10 },
      })
    );
    expect(timedOut.result.results[0].status).toBe('timed_out');

    const controller = new AbortController();
    const cancelledPromise = runSubtaskBatch(
      { tasks: [researchTask('cancelled research objective')], execution: 'serial' },
      makeDeps(waitForAbort, { parentAbortSignal: controller.signal })
    );
    setTimeout(() => controller.abort(), 5);
    const cancelled = await cancelledPromise;
    expect(cancelled.result.results[0].status).toBe('cancelled');

    for (const result of [
      ...budget.result.results,
      ...timedOut.result.results,
      ...cancelled.result.results,
    ]) {
      const request = createResearchRequestForSubtask(
        researchTask('verification downgrade objective'),
        '/tmp/orion-subagent-research'
      );
      const packet = subtaskResultToPacket(result, request, {
        projectPath: '/tmp/orion-subagent-research',
        sessionId: 'failure-session',
      });
      expect(packet.claims.every(claim => claim.verification === 'unverified')).toBe(true);
    }
  });

  it('persists with CAS and resumes without replaying the external capability', async () => {
    let webCalls = 0;
    let captured: { result: SubtaskResult; research?: SubtaskResearchResultContext } | undefined;
    const deps = makeDeps(
      async () => ({
        content: JSON.stringify(completedResult()),
        usage: usage(),
      }),
      {
        runWebResearch: async () => {
          webCalls += 1;
          return webResult();
        },
        onSubtaskResult: (result, _batchId, _objective, research) => {
          captured = { result, research };
        },
      }
    );
    await runSubtaskBatch(
      {
        tasks: [
          researchTask('persist mixed research', {
            mode: 'mixed',
            maxSources: 5,
            maxFetchBytes: 4096,
            maxDurationMs: 5000,
          }),
        ],
        execution: 'serial',
      },
      deps
    );

    const packet = subtaskResultToPacket(
      captured!.result,
      captured!.research!.request,
      { projectPath: deps.cwd, sessionId: 'resume-session' },
      { externalSources: captured!.research!.web?.sources }
    );
    const store = createMemoryArtifactStore();
    const scope = {
      projectPath: deps.cwd,
      sessionId: 'resume-session',
      packetId: packet.packetId,
    };
    const first = saveResearchPacket(store, packet, scope);
    expect(() =>
      saveResearchPacket(store, { ...packet, summary: 'stale writer' }, scope, {
        expectedToken: 'stale-token',
      })
    ).toThrow(CasMismatchError);
    const loaded = loadResearchPacket(store, scope)!;
    expect(resumeResearchState(loaded)).toBe('completed');
    expect(webCalls).toBe(1);
    expect(
      saveResearchPacket(store, { ...loaded, summary: 'resumed safely' }, scope, {
        expectedToken: first.casToken,
      }).version
    ).toBe(2);
  });

  it('round-trips one real research lifecycle through Terminal/Print/TUI sinks', () => {
    const task = researchTask('sink mixed research', {
      mode: 'mixed',
      maxSources: 5,
      maxFetchBytes: 4096,
      maxDurationMs: 5000,
    });
    const request = createResearchRequestForSubtask(task, '/tmp/orion-subagent-research');
    const packet = subtaskResultToPacket(
      completedResult('sink-task'),
      request,
      { projectPath: request.scope.projectRoot, sessionId: 'sink-session' },
      { externalSources: webResult().sources }
    );
    const resolution = resolveCitations(packet);
    const events = toLifecycleEvents(buildResearchView(packet, resolution), resolution);

    const runtime = {
      cwd: request.scope.projectRoot,
      version: 'test',
      config: { model: 'test-model' },
      getSession: () => ({ id: 'sink-session' }),
      store: { getSnapshot: () => ({ currentModel: 'test-model' }) },
    } as never;
    const { TerminalEventSink } =
      require('../src/terminal-ui/launch') as typeof import('../src/terminal-ui/launch');
    const { PrintEventSink } =
      require('../src/print-ui/launch') as typeof import('../src/print-ui/launch');
    const { initialTuiUiState, tuiUiReducer } =
      require('../src/tui-ui/state') as typeof import('../src/tui-ui/state');
    const terminal = new TerminalEventSink(runtime, { write: () => {} } as never);
    const print = new PrintEventSink(runtime, 'json');
    let tui = initialTuiUiState;
    for (const event of events) {
      terminal.researchEvent(event);
      print.researchEvent(event);
      tui = tuiUiReducer(tui, { type: 'researchEvent', event });
    }

    expect(terminal.getResearchEvents()).toEqual(events);
    expect(print.result().researchEvents).toEqual(events);
    expect(tui.researchEvents).toEqual(events);
    expect(terminal.getResearchProjection()).toEqual(print.result().research);
    expect(tui.research?.packetId).toBe(packet.packetId);
    expect(events.some(event => event.type === 'research_source')).toBe(true);
  });
});
