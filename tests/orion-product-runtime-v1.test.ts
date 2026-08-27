import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Store } from '../src/framework/store';
import { AgentModeLifecycleController } from '../src/framework/agent-mode';
import type { OrionCodeTool } from '../src/framework/tool';
import { createBuiltinToolCatalogV1 } from '../src/runtime/builtin-tool-provider';
import { createFirstPartyCoreToolProviderV1 } from '../src/runtime/first-party-core-provider';
import { getProjectThreadsV2Dir } from '../src/product/paths';
import { OrionSessionRunnerV1 } from '../src/runtime/orion-session-runner';
import { createProductOrionRuntimeV1 } from '../src/runtime/product-orion-runtime';
import {
  createFilesystemSkillProviderV1,
  type FilesystemSkillProviderV1,
} from '../src/runtime/skills';
import type { McpConnectionV1, McpConnectorV1 } from '../src/runtime/mcp';
import { resolveSessionStorageV1 } from '../src/runtime/legacy-thread-materializer';
import { ThreadEventStore } from '../src/runtime/thread-event-store';
import type { SubagentThreadReceiptV1 } from '../src/runtime/subagent-thread-runtime';
import { parsePlanReceiptV1, parseTurnCommitV1 } from '../src/runtime/turn-commit';
import type { UiEventSink } from '../src/runtime/ui-events';
import type { OrionCodeCLIConfig } from '../src/services/config';
import { CompactCoordinator } from '../src/services/compact/coordinator';
import { createGoal } from '../src/services/goal-storage';
import type { LLMResponse, LLMService, Message } from '../src/services/llm';
import {
  appendSessionMessage,
  createSession,
  type SessionMeta,
} from '../src/services/session-storage';

describe('v0.2.0 product OrionRuntime cutover', () => {
  let root: string;
  let projectPath: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-product-runtime-'));
    projectPath = join(root, 'project');
    mkdirSync(projectPath, { recursive: true });
    previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
    rmSync(root, { recursive: true, force: true });
  });

  test('imports a legacy Session and commits one model turn through the sole runtime spine', async () => {
    const session = createLegacySession('legacy context');
    const llm = createFakeLlm([{ content: 'durable answer', model: 'model-test' }]);
    const fixture = createProductFixture(llm);
    const runtime = createProductOrionRuntimeV1(fixture, session.id);

    await runtime.start();
    expect(resolveSessionStorageV1(projectPath, session.id)).toMatchObject({ kind: 'thread' });
    expect(
      runtime.thread.dispatch({
        type: 'turn.start',
        data: { input: 'continue from the imported facts', mode: 'build' },
      })
    ).toMatchObject({ status: 'started' });
    await runtime.thread.waitForIdle();

    const request = llm.chatStream.mock.calls[0]?.[0] as Message[];
    expect(request).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'legacy context' }),
        expect.objectContaining({ role: 'user', content: 'continue from the imported facts' }),
      ])
    );
    const projection = runtime.thread.getProjection();
    const turn = Object.values(projection.turns).find(
      value => value.input === 'continue from the imported facts'
    );
    expect(turn).toMatchObject({ status: 'completed', commit: expect.any(Object) });
    expect(
      runtime.graph.eventStore
        .replay(0)
        .events.filter(event => event.payload.type === 'capability.receipt')
    ).toHaveLength(1);
    expect(fixture.store.getSnapshot()).toMatchObject({
      conversationHistory: expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', content: 'durable answer' }),
      ]),
      lastLoopStats: expect.objectContaining({ llmRequests: 1 }),
      contextUsage: expect.objectContaining({
        modelId: 'model-test',
        usedTokens: expect.any(Number),
        percent: expect.any(Number),
      }),
    });

    await runtime.close('integration complete');
    expect(runtime.state).toBe('closed');
  });

  test('switches Session ownership only after the previous Thread has drained and closed', async () => {
    const first = createLegacySession('first legacy turn');
    const second = createLegacySession('second legacy turn');
    const llm = createFakeLlm([
      { content: 'first answer', model: 'model-test' },
      { content: 'second answer', model: 'model-test' },
    ]);
    const fixture = createProductFixture(llm);
    const events = createUiSink();
    const runtimes: ReturnType<typeof createProductOrionRuntimeV1>[] = [];
    let sessionId = first.id;
    const runner = new OrionSessionRunnerV1({
      eventSink: events.sink,
      getSessionId: () => sessionId,
      createRuntime: id => {
        const runtime = createProductOrionRuntimeV1(fixture, id);
        runtimes.push(runtime);
        return runtime;
      },
      mode: 'auto',
    });

    await runner.runInput('work in first');
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0].state).toBe('started');

    sessionId = second.id;
    await runner.runInput('work in second');
    expect(runtimes).toHaveLength(2);
    expect(runtimes[0].state).toBe('closed');
    expect(runtimes[1].state).toBe('started');
    expect(events.appended.filter(entry => entry.title === 'you')).toHaveLength(2);
    expect(
      llm.chatStream.mock.calls.map(
        call => (call[0] as Message[]).filter(message => message.role === 'user').at(-1)?.content
      )
    ).toEqual(['work in first', 'work in second']);

    await runner.close('test complete');
    expect(runtimes[1].state).toBe('closed');
    await expect(runner.runInput('must not restart')).rejects.toThrow('closed');
  });

  test('replays a resumed v2 Thread exactly once without starting another model turn', async () => {
    const session = createLegacySession('legacy resume context');
    const llm = createFakeLlm([{ content: 'durable resume answer', model: 'model-test' }]);
    const fixture = createProductFixture(llm);
    const events = createUiSink();
    const runtimes: ReturnType<typeof createProductOrionRuntimeV1>[] = [];
    const runner = new OrionSessionRunnerV1({
      eventSink: events.sink,
      getSessionId: () => session.id,
      createRuntime: id => {
        const runtime = createProductOrionRuntimeV1(fixture, id);
        runtimes.push(runtime);
        return runtime;
      },
      mode: 'build',
    });

    await runner.runInput('durable user request');
    events.appended.splice(0);
    await runner.restoreSession();

    expect(events.clears).toHaveLength(1);
    expect(runtimes).toHaveLength(2);
    expect(runtimes[0].state).toBe('closed');
    expect(runtimes[1].state).toBe('started');
    expect(events.appended.filter(entry => entry.content === 'durable user request')).toHaveLength(
      1
    );
    expect(events.appended.filter(entry => entry.content === 'durable resume answer')).toHaveLength(
      1
    );
    expect(llm.chatStream).toHaveBeenCalledTimes(1);

    await runner.close('resume replay complete');
  });

  test('routes explicit compact through the active runtime maintenance turn', async () => {
    const session = createLegacySession('compact source');
    for (let index = 0; index < 8; index += 1) {
      appendSessionMessage(session.id, {
        role: 'user',
        content: `durable compact message ${index}`,
        timestamp: Date.now() + index,
      });
    }
    const llm = createFakeLlm([{ content: 'normal answer', model: 'model-test' }]);
    llm.chat.mockResolvedValue({ content: 'bounded compact summary', model: 'model-test' });
    const fixture = createProductFixture(llm);
    const runtime = createProductOrionRuntimeV1(
      {
        ...fixture,
        compactCoordinator: new CompactCoordinator({ modelId: 'model-test', llm }),
      },
      session.id
    );
    const events = createUiSink();
    const runner = new OrionSessionRunnerV1({
      eventSink: events.sink,
      getSessionId: () => session.id,
      createRuntime: () => runtime,
      mode: 'build',
    });

    await runner.runInput('establish an authoritative TurnCommit before compacting');
    const result = await runner.compact({ maxMessages: 1, focus: 'retain durable facts' });

    const compactEvents = runtime.graph.compactPersistence.listCompactEvents();
    expect({ result, compactEvents }).toMatchObject({
      result: { status: 'completed', turnId: expect.any(String) },
      compactEvents: [
        expect.objectContaining({ payload: expect.objectContaining({ type: 'compact.started' }) }),
        expect.objectContaining({
          payload: expect.objectContaining({ type: 'compact.completed' }),
        }),
      ],
    });
    expect(runtime.graph.compactPersistence.loadModelVisibleHistory()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('bounded compact summary') }),
      ])
    );

    await runner.close('compact integration complete');
  });

  test('routes an ask decision through the product approval channel before executing', async () => {
    const session = createLegacySession('approval context');
    const execute = jest.fn(async () => ({ success: true, output: 'written' }));
    const tool: OrionCodeTool = {
      ...readFileTool(),
      name: 'write_file',
      description: 'Write a workspace file',
      execute,
      checkPermissions: () => ({ behavior: 'ask', reason: 'writes workspace state' }),
      isReadOnly: () => false,
      isFileEdit: () => true,
    };
    const llm = createFakeLlm([
      {
        content: '',
        model: 'model-test',
        toolCalls: [
          {
            id: 'write-call-1',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: 'approval.txt', content: 'approved' }),
            },
          },
        ],
      },
      { content: 'write complete', model: 'model-test' },
    ]);
    const approvalHandler = jest.fn(async () => true);
    const config: OrionCodeCLIConfig = {
      apiKey: 'test-only',
      model: 'model-test',
      toolConfirmation: 'ask',
      name: 'orion-product-test',
      mode: 'development',
      logLevel: 'error',
    };
    const store = new Store({ config, tools: [tool], currentModel: 'model-test' });
    const runtime = createProductOrionRuntimeV1(
      {
        cwd: projectPath,
        config,
        store,
        llm,
        toolCatalog: createBuiltinToolCatalogV1([tool], {
          context: { cwd: projectPath, config: { name: config.name, mode: config.mode } },
        }),
        approvalHandler,
      },
      session.id
    );

    await runtime.start();
    expect(
      runtime.thread.dispatch({
        type: 'turn.start',
        data: { input: 'Use write_file to save approval.txt', mode: 'build' },
      })
    ).toMatchObject({ status: 'started' });
    await runtime.thread.waitForIdle();

    expect(approvalHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'write_file',
        args: { path: 'approval.txt', content: 'approved' },
        reason: 'writes workspace state',
      })
    );
    expect(execute).toHaveBeenCalledTimes(1);
    const item = Object.values(runtime.thread.getProjection().items).find(
      value => value.kind === 'command' && value.name === 'write_file'
    );
    expect(item?.receipt).toBeDefined();
    expect(JSON.parse(item!.receipt!)).toMatchObject({
      terminal: 'completed',
      approval: { approved: true, source: 'user' },
    });

    await runtime.close('approval integration complete');
  });

  test('commits PLAN with full tools, restores AUTO, then executes only in a new logical turn', async () => {
    const session = createLegacySession('plan lifecycle context');
    const config: OrionCodeCLIConfig = {
      apiKey: 'test-only',
      model: 'model-test',
      toolConfirmation: 'allow',
      name: 'orion-product-test',
      mode: 'development',
      logLevel: 'error',
    };
    const core = createFirstPartyCoreToolProviderV1({
      context: { cwd: projectPath, config: { name: config.name, mode: config.mode } },
    });
    const store = new Store({
      config,
      tools: core.catalog.entries.map(entry => entry.tool),
      currentModel: 'model-test',
    });
    const modes = new AgentModeLifecycleController(store);
    modes.setMode('auto');
    modes.setMode('plan');
    const plan = [
      '# Implementation plan',
      '1. Keep the prepared workspace artifacts.',
      '2. Implement the requested feature in AUTO.',
      '3. Run focused verification before completing.',
    ].join('\n');
    const llm = createFakeLlm([
      {
        content: '',
        model: 'model-test',
        toolCalls: [
          {
            id: 'plan-write-1',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: 'plan-prepared.txt', content: 'prepared' }),
            },
          },
          {
            id: 'plan-exec-1',
            type: 'function',
            function: {
              name: 'exec_command',
              arguments: JSON.stringify({ command: 'node --version' }),
            },
          },
        ],
      },
      { content: plan, model: 'model-test' },
      { content: 'Execution completed and verified.', model: 'model-test' },
    ]);
    const runtime = createProductOrionRuntimeV1(
      {
        cwd: projectPath,
        config,
        store,
        llm,
        toolCatalog: core.catalog,
      },
      session.id
    );

    await runtime.start();
    runtime.thread.dispatch({
      type: 'turn.start',
      data: { input: 'Prepare a plan and then implement it', mode: 'plan' },
    });
    await runtime.thread.waitForIdle();

    expect(readFileSync(join(projectPath, 'plan-prepared.txt'), 'utf8')).toBe('prepared');
    const turns = Object.values(runtime.thread.getProjection().turns)
      .sort((left, right) => left.startedSeq - right.startedSeq)
      .slice(-2);
    expect(turns.map(turn => turn.mode)).toEqual(['plan', 'auto']);
    expect(turns.map(turn => turn.status)).toEqual(['completed', 'completed']);
    const planCommit = parseTurnCommitV1(turns[0].commit!.receipt);
    const planReceipt = parsePlanReceiptV1(planCommit.planReceipt!);
    expect(planReceipt).toMatchObject({
      plan,
      returnMode: 'auto',
      historyDigest: planCommit.historyDigest,
      taskContextDigest: planCommit.taskContextDigest,
      taskContextRevision: planCommit.taskContextRevision,
      stopDecisionDigest: planCommit.stopDecisionDigest,
      capabilityReceiptDigests: planCommit.capabilityReceiptDigests,
    });
    expect(JSON.parse(planCommit.stopDecision!)).toMatchObject({
      status: 'completed',
      reason: { code: 'plan_ready' },
    });
    expect(store.getSnapshot()).toMatchObject({
      agentMode: 'auto',
      planMode: false,
      currentPlan: plan,
    });

    const visibleToolSets = llm.chatStream.mock.calls.map(call =>
      (call[2] as Array<{ function: { name: string } }>).map(tool => tool.function.name).sort()
    );
    expect(visibleToolSets[0]).toEqual(visibleToolSets[1]);
    expect(visibleToolSets[0]).toEqual(visibleToolSets[2]);
    expect(visibleToolSets[0]).toEqual([
      'edit_file',
      'exec_command',
      'glob',
      'grep',
      'list_files',
      'read_file',
      'subtask',
      'write_file',
    ]);
    expect(visibleToolSets.flat()).not.toContain('exit_plan_mode');
    const executionRequest = llm.chatStream.mock.calls[2]?.[0] as Message[];
    expect(executionRequest.some(message => message.content.includes(planReceipt.digest))).toBe(
      true
    );
    expect(
      executionRequest.some(message => message.role === 'system' && message.content.includes(plan))
    ).toBe(true);

    await runtime.close('plan execution lifecycle complete');
  });

  test('seeds the v2 Goal owner from a legacy sidecar without starting ghost work', async () => {
    const session = createLegacySession('goal context');
    const persisted = createGoal(projectPath, session.id, 'Finish the durable release');
    expect(persisted.ok).toBe(true);
    const llm = createFakeLlm([{ content: 'unused', model: 'model-test' }]);
    const runtime = createProductOrionRuntimeV1(createProductFixture(llm), session.id);

    await runtime.start();

    expect(runtime.services.goals.runtime.state).toMatchObject({
      version: 2,
      objective: 'Finish the durable release',
      status: 'active',
      continuationCount: 0,
    });
    expect(runtime.graph.goal).toBe(runtime.services.goals.runtime);
    expect(llm.chatStream).not.toHaveBeenCalled();

    await runtime.close('goal seed verified');
  });

  test('keeps Skill definitions and MCP transports dormant when the task selects neither', async () => {
    const session = createLegacySession('dormant capability context');
    const skill = createProjectSkill('pixel-ui', 'PIXEL_SKILL_BODY');
    const connection = createFakeMcpConnection();
    const connector: McpConnectorV1 = { connect: jest.fn(async () => connection) };
    const llm = createFakeLlm([{ content: 'plain answer', model: 'model-test' }]);
    const runtime = createProductOrionRuntimeV1(
      {
        ...createProductFixture(llm),
        skillProviders: [skill],
        mcpDescriptors: [mcpDescriptor('issue-tracker')],
        mcpConnector: connector,
      },
      session.id
    );

    await runtime.start();
    runtime.thread.dispatch({
      type: 'turn.start',
      data: { input: 'Explain the local TypeScript type', mode: 'build' },
    });
    await runtime.thread.waitForIdle();

    expect(skill.stats()).toMatchObject({ definitionReads: 0, resourceReads: 0 });
    expect(connector.connect).not.toHaveBeenCalled();
    expect(connection.listTools).not.toHaveBeenCalled();
    expect(JSON.stringify(llm.chatStream.mock.calls[0]?.[0])).not.toContain('PIXEL_SKILL_BODY');

    await runtime.close('dormant capability integration complete');
  });

  test('loads only an explicitly selected Skill definition into the bounded prompt', async () => {
    const session = createLegacySession('skill context');
    const skill = createProjectSkill('pixel-ui', 'PIXEL_SKILL_BODY');
    const llm = createFakeLlm([{ content: 'styled answer', model: 'model-test' }]);
    const runtime = createProductOrionRuntimeV1(
      { ...createProductFixture(llm), skillProviders: [skill] },
      session.id
    );

    await runtime.start();
    runtime.thread.dispatch({
      type: 'turn.start',
      data: { input: '$pixel-ui restyle the status line', mode: 'build' },
    });
    await runtime.thread.waitForIdle();

    const request = llm.chatStream.mock.calls[0]?.[0] as Message[];
    expect(
      request
        .filter(message => message.role === 'system')
        .map(message => message.content)
        .join('\n')
    ).toContain('PIXEL_SKILL_BODY');
    expect(skill.stats()).toMatchObject({ definitionReads: 1, resourceReads: 0 });
    const receipt = runtime.graph.eventStore
      .replay(0)
      .events.find(event => event.payload.type === 'capability.receipt');
    expect(receipt?.payload.type).toBe('capability.receipt');
    const receiptPayload =
      receipt?.payload.type === 'capability.receipt' ? receipt.payload.data : undefined;
    const capability = receiptPayload ? JSON.parse(receiptPayload.receipt) : undefined;
    expect(capability?.selectedSkillIds).toHaveLength(1);
    expect(Object.keys(capability?.loadedSkillDigests ?? {})).toHaveLength(1);
    expect(JSON.stringify(receipt?.payload)).not.toContain('PIXEL_SKILL_BODY');

    await runtime.close('selected Skill integration complete');
  });

  test('activates one selected MCP server, executes its exact binding, then releases the turn lease', async () => {
    const session = createLegacySession('MCP context');
    const connection = createFakeMcpConnection();
    const connector: McpConnectorV1 = { connect: jest.fn(async () => connection) };
    const llm = createFakeLlm([
      {
        content: '',
        model: 'model-test',
        toolCalls: [
          {
            id: 'mcp-call-1',
            type: 'function',
            function: {
              name: 'mcp__issue-tracker__lookup_issue',
              arguments: JSON.stringify({ id: 150 }),
            },
          },
        ],
      },
      { content: 'Issue loaded', model: 'model-test' },
    ]);
    const runtime = createProductOrionRuntimeV1(
      {
        ...createProductFixture(llm),
        mcpDescriptors: [mcpDescriptor('issue-tracker'), mcpDescriptor('unused-server')],
        mcpConnector: connector,
      },
      session.id
    );

    await runtime.start();
    runtime.thread.dispatch({
      type: 'turn.start',
      data: { input: '/mcp issue-tracker lookup_issue 150', mode: 'auto' },
    });
    await runtime.thread.waitForIdle();

    expect(connector.connect).toHaveBeenCalledTimes(1);
    expect(connector.connect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'issue-tracker' }),
      expect.any(AbortSignal)
    );
    expect(connection.callTool).toHaveBeenCalledWith(
      'lookup_issue',
      { id: 150 },
      expect.any(AbortSignal)
    );
    expect(runtime.graph.mcp.snapshot().servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serverId: 'issue-tracker', activeLeaseCount: 0 }),
        expect.objectContaining({ serverId: 'unused-server', state: 'dormant' }),
      ])
    );
    const command = Object.values(runtime.thread.getProjection().items).find(
      item => item.kind === 'command' && item.name === 'mcp__issue-tracker__lookup_issue'
    );
    expect(command?.receipt && JSON.parse(command.receipt)).toMatchObject({
      terminal: 'completed',
      approval: { approved: true },
    });

    await runtime.close('MCP integration complete');
  });

  test('runs product subtask through child AgentLoop and ToolGateway before root continues', async () => {
    const session = createLegacySession('subagent product context');
    writeFileSync(join(projectPath, 'sample.txt'), 'durable child evidence', 'utf8');
    const readFileExecute = jest.fn(async args => ({
      success: true,
      output: readFileSync(join(projectPath, String(args.path)), 'utf8'),
    }));
    const tool = readFileTool(readFileExecute);
    const config: OrionCodeCLIConfig = {
      apiKey: 'test-only',
      model: 'model-test',
      toolConfirmation: 'allow',
      name: 'orion-product-test',
      mode: 'development',
      logLevel: 'error',
      subagents: {
        mode: 'auto',
        maxParallel: 1,
        maxTasksPerTurn: 1,
        maxTurnsPerTask: 4,
        maxModelRequestsPerTask: 4,
        maxModelRequestsPerTurn: 4,
        maxToolCallsPerTask: 4,
        timeoutMs: 10_000,
        roles: ['review'],
      },
    };
    const store = new Store({ config, tools: [tool], currentModel: 'model-test' });
    const rootLlm = createFakeLlm([
      {
        content: '',
        model: 'model-test',
        toolCalls: [
          {
            id: 'root-subtask-1',
            type: 'function',
            function: {
              name: 'subtask',
              arguments: JSON.stringify({
                tasks: [
                  {
                    role: 'review',
                    objective: 'Review sample.txt and report the concrete durable evidence.',
                    reason: 'This bounded read-only review can run in an isolated child.',
                    scope: { paths: ['sample.txt'] },
                  },
                ],
                execution: 'serial',
              }),
            },
          },
        ],
      },
      { content: 'Root accepted the child evidence and completed.', model: 'model-test' },
    ]);
    const childLlm = createFakeLlm([
      {
        content: '',
        model: 'model-test',
        toolCalls: [
          {
            id: 'child-read-1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'sample.txt' }),
            },
          },
        ],
      },
      {
        content: JSON.stringify({
          summary: 'sample.txt contains durable child evidence.',
          findings: [
            {
              severity: 'info',
              title: 'Durable evidence found',
              evidence: 'sample.txt: durable child evidence',
              file: 'sample.txt',
              line: 1,
            },
          ],
          files: ['sample.txt'],
          commands: [],
          verification: ['Read sample.txt through the child ToolGateway receipt.'],
          risks: [],
        }),
        model: 'model-test',
      },
    ]);
    const receipts: SubagentThreadReceiptV1[] = [];
    const runtime = createProductOrionRuntimeV1(
      {
        cwd: projectPath,
        config,
        store,
        llm: rootLlm,
        toolCatalog: createBuiltinToolCatalogV1([tool], {
          context: { cwd: projectPath, config: { name: config.name, mode: config.mode } },
        }),
        createSubagentModelExecutor: () => childLlm,
        onSubagentReceipt: receipt => {
          receipts.push(receipt);
        },
      },
      session.id
    );

    await runtime.start();
    const admission = runtime.thread.dispatch({
      type: 'turn.start',
      data: { input: 'Review sample.txt independently and use the result.', mode: 'build' },
    });
    expect(admission).toMatchObject({ status: 'started' });
    await runtime.thread.waitForIdle();

    expect(readFileExecute).toHaveBeenCalledTimes(1);
    expect(rootLlm.chatStream).toHaveBeenCalledTimes(2);
    expect(childLlm.chatStream).toHaveBeenCalledTimes(2);
    expect(
      childLlm.chatStream.mock.calls.map(call =>
        (call[2] as Array<{ function: { name: string } }>).map(tool => tool.function.name)
      )
    ).toEqual([['read_file'], ['read_file']]);
    const continuedRootMessages = rootLlm.chatStream.mock.calls[1]?.[0] as Message[];
    expect(
      continuedRootMessages.some(
        message => message.role === 'tool' && message.content.includes('durable child evidence')
      )
    ).toBe(true);

    const rootEvents = runtime.graph.eventStore.replay(0).events;
    const rootCapabilityReceipts = rootEvents
      .filter(event => event.payload.type === 'capability.receipt')
      .map(event =>
        event.payload.type === 'capability.receipt'
          ? JSON.parse(event.payload.data.receipt)
          : undefined
      );
    expect(rootCapabilityReceipts[0]).toMatchObject({
      directToolNames: expect.arrayContaining(['read_file', 'subtask']),
    });
    expect(
      Object.values(runtime.graph.eventStore.loadProjection().items).some(
        item => item.kind === 'command' && item.name === 'subtask' && item.receipt
      )
    ).toBe(true);
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0];
    expect(receipt).toMatchObject({
      parentThreadId: runtime.graph.eventStore.threadId,
      parentTurnId: admission.status === 'started' ? admission.turnId : undefined,
      role: 'review',
      turnTerminal: 'completed',
    });
    const childStore = new ThreadEventStore(
      join(getProjectThreadsV2Dir(projectPath), 'subagents'),
      receipt.childThreadId
    );
    const childEvents = childStore.replay(0).events;
    expect(childEvents.map(event => event.payload.type)).toEqual(
      expect.arrayContaining([
        'thread.forked',
        'step.snapshot',
        'capability.receipt',
        'tool.receipt',
        'turn.committed',
      ])
    );
    const childProjection = childStore.loadProjection();
    expect(
      Object.values(childProjection.items).some(
        item => item.kind === 'command' && item.name === 'read_file' && item.receipt
      )
    ).toBe(true);
    expect(childProjection.turns[receipt.childTurnId]).toMatchObject({
      status: 'completed',
      commit: expect.any(Object),
    });

    await runtime.close('subagent product integration complete');
  });

  function createLegacySession(content: string): SessionMeta {
    const session = createSession(projectPath, 'model-test');
    appendSessionMessage(session.id, { role: 'user', content, timestamp: Date.now() });
    return session;
  }

  function createProductFixture(llm: jest.Mocked<LLMService>) {
    const config: OrionCodeCLIConfig = {
      apiKey: 'test-only',
      model: 'model-test',
      toolConfirmation: 'allow',
      name: 'orion-product-test',
      mode: 'development',
      logLevel: 'error',
    };
    const tool = readFileTool();
    const store = new Store({ config, tools: [tool], currentModel: 'model-test' });
    return {
      cwd: projectPath,
      config,
      store,
      llm,
      toolCatalog: createBuiltinToolCatalogV1([tool], {
        context: { cwd: projectPath, config: { name: config.name, mode: config.mode } },
      }),
    };
  }

  function createProjectSkill(name: string, body: string): FilesystemSkillProviderV1 {
    const root = join(projectPath, '.orion-code', 'skills');
    const directory = join(root, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Test ${name}\nmodelInvocable: true\nuserInvocable: true\n---\n\n${body}\n`,
      'utf8'
    );
    return createFilesystemSkillProviderV1({
      roots: [{ path: root, sourceScope: 'project' }],
      watch: false,
    });
  }
});

function createFakeLlm(responses: readonly LLMResponse[]): jest.Mocked<LLMService> {
  let index = 0;
  return {
    chat: jest.fn(async () => ({ content: 'summary', model: 'model-test' })),
    chatStream: jest.fn(async () => responses[index++] ?? responses.at(-1)!),
    getModel: jest.fn(() => 'model-test'),
    setModel: jest.fn(),
    getConfigSummary: jest.fn(() => ({ model: 'model-test' })),
    setProviderRequestPreflight: jest.fn(),
  } as unknown as jest.Mocked<LLMService>;
}

function readFileTool(
  execute: OrionCodeTool['execute'] = async args => ({ success: true, output: String(args.path) })
): OrionCodeTool {
  return {
    name: 'read_file',
    description: 'Read a workspace file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    execute,
    checkPermissions: () => ({ behavior: 'allow' }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isDestructive: () => false,
    isFileEdit: () => false,
  };
}

function mcpDescriptor(id: string) {
  return {
    id,
    name: id,
    description: `${id} test server`,
    transport: 'stdio' as const,
    configDigest: `sha256:${id}`,
    tags: [id],
  };
}

function createFakeMcpConnection(): {
  readonly listTools: jest.Mock;
  readonly callTool: jest.Mock;
  readonly close: jest.Mock;
} & McpConnectionV1 {
  return {
    listTools: jest.fn(async () => [
      {
        name: 'lookup_issue',
        description: 'Look up one issue',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'number' } },
          required: ['id'],
        },
      },
    ]),
    callTool: jest.fn(async (_name, args) => ({ issue: args.id })),
    close: jest.fn(async () => undefined),
  };
}

function createUiSink(): {
  readonly sink: UiEventSink;
  readonly appended: Array<{ readonly title: string; readonly content: string }>;
  readonly clears: string[];
} {
  const appended: Array<{ title: string; content: string }> = [];
  const entries = new Map<string, { title: string; content: string }>();
  const clears: string[] = [];
  let nextId = 0;
  return {
    appended,
    clears,
    sink: {
      append: entry => {
        const id = `entry-${++nextId}`;
        const projected = { title: entry.title ?? '', content: entry.content };
        appended.push(projected);
        entries.set(id, projected);
        return id;
      },
      update: (id, patch) => {
        const entry = entries.get(id);
        if (!entry) return;
        if (patch.title !== undefined) entry.title = patch.title;
        if (patch.content !== undefined) entry.content = patch.content;
      },
      finalize: (id, patch) => {
        const entry = entries.get(id);
        if (!entry || !patch) return;
        if (patch.title !== undefined) entry.title = patch.title;
        if (patch.content !== undefined) entry.content = patch.content;
      },
      remove: id => {
        const entry = entries.get(id);
        if (!entry) return;
        entries.delete(id);
        const index = appended.indexOf(entry);
        if (index >= 0) appended.splice(index, 1);
      },
      replaceTranscript: () => undefined,
      clearTranscript: () => {
        clears.push('clear');
        appended.splice(0);
        entries.clear();
      },
      setStatus: () => undefined,
      showSessionPicker: () => undefined,
      showEditPreview: () => undefined,
      setProcessing: () => undefined,
    },
  };
}
