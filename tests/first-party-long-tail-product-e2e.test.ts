import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Store } from '../src/framework/store';
import { createProductionFirstPartyToolUniverseV1 } from '../src/runtime/first-party-tool-universe';
import { createProductOrionRuntimeV1 } from '../src/runtime/product-orion-runtime';
import type { OrionCodeCLIConfig } from '../src/services/config';
import type { LLMResponse, LLMService } from '../src/services/llm';
import { appendSessionMessage, createSession } from '../src/services/session-storage';

describe('first-party long-tail production composition', () => {
  let root: string;
  let projectPath: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-long-tail-product-'));
    projectPath = join(root, 'project');
    mkdirSync(projectPath, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: projectPath });
    previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
    rmSync(root, { recursive: true, force: true });
  });

  test('selects and executes only git_status through the product ToolGateway', async () => {
    const config: OrionCodeCLIConfig = {
      apiKey: '',
      model: 'model-test',
      toolConfirmation: 'allow',
      name: 'orion-long-tail-product-test',
      mode: 'development',
      logLevel: 'error',
    };
    const context = {
      cwd: projectPath,
      config: { name: config.name, mode: config.mode },
    };
    const universe = createProductionFirstPartyToolUniverseV1({ context });
    const store = new Store({
      config,
      tools: universe.catalog.entries.map(entry => entry.tool),
      currentModel: 'model-test',
    });
    const llm = createFakeLlm([
      {
        content: '',
        model: 'model-test',
        toolCalls: [
          {
            id: 'git-status-call',
            type: 'function',
            function: { name: 'git_status', arguments: '{}' },
          },
        ],
      },
      { content: 'The Git working tree is clean.', model: 'model-test' },
    ]);
    const session = createSession(projectPath, 'model-test');
    appendSessionMessage(session.id, {
      role: 'user',
      content: 'Existing durable context',
      timestamp: Date.now(),
    });
    const runtime = createProductOrionRuntimeV1(
      {
        cwd: projectPath,
        config,
        store,
        llm,
        toolCatalog: universe.catalog,
      },
      session.id
    );

    await runtime.start();
    runtime.thread.dispatch({
      type: 'turn.start',
      data: { input: 'Inspect git status and report the result', mode: 'build' },
    });
    await runtime.thread.waitForIdle();

    const visible = (
      llm.chatStream.mock.calls[0]?.[2] as Array<{ function: { name: string } }>
    ).map(tool => tool.function.name);
    expect(visible).toEqual([
      'edit_file',
      'exec_command',
      'git_status',
      'glob',
      'grep',
      'list_files',
      'read_file',
      'write_file',
    ]);
    const command = Object.values(runtime.thread.getProjection().items).find(
      item => item.kind === 'command' && item.name === 'git_status'
    );
    expect(command?.receipt && JSON.parse(command.receipt)).toMatchObject({
      terminal: 'completed',
      terminalPhase: 'execute',
      success: true,
    });
    expect(universe.longTail.stats()).toMatchObject({
      groupModuleLoads: 1,
      loadedGroups: ['git'],
      resolvedToolNames: ['git_status'],
    });
    expect(universe.core.stats()).toMatchObject({ shardModuleLoads: 0, resolvedExecutors: 0 });
    expect(
      runtime.graph.eventStore
        .replay(0)
        .events.filter(event => event.payload.type === 'capability.receipt')
    ).toHaveLength(2);

    await runtime.close('long-tail product test complete');
  });

  test('executes batch_read children through durable parent invocation lineage', async () => {
    writeFileSync(join(projectPath, 'README.md'), 'Orion batch evidence\n', 'utf8');
    const config: OrionCodeCLIConfig = {
      apiKey: '',
      model: 'model-test',
      toolConfirmation: 'allow',
      name: 'orion-batch-product-test',
      mode: 'development',
      logLevel: 'error',
    };
    const context = {
      cwd: projectPath,
      config: { name: config.name, mode: config.mode },
    };
    const universe = createProductionFirstPartyToolUniverseV1({ context });
    const store = new Store({
      config,
      tools: universe.catalog.entries.map(entry => entry.tool),
      currentModel: 'model-test',
    });
    const llm = createFakeLlm([
      {
        content: '',
        model: 'model-test',
        toolCalls: [
          {
            id: 'batch-read-call',
            type: 'function',
            function: {
              name: 'batch_read',
              arguments: JSON.stringify({
                steps: [
                  { tool: 'read_file', args: { path: 'README.md' } },
                  { tool: 'grep', args: { pattern: 'Orion', path: '.' } },
                ],
              }),
            },
          },
        ],
      },
      { content: 'Both local reads completed.', model: 'model-test' },
    ]);
    const session = createSession(projectPath, 'model-test');
    const runtime = createProductOrionRuntimeV1(
      { cwd: projectPath, config, store, llm, toolCatalog: universe.catalog },
      session.id
    );

    await runtime.start();
    runtime.thread.dispatch({
      type: 'turn.start',
      data: { input: 'Use batch_read to read README and grep Orion', mode: 'build' },
    });
    await runtime.thread.waitForIdle();

    const items = Object.entries(runtime.thread.getProjection().items).filter(
      ([, item]) => item.kind === 'command'
    );
    const parent = items.find(([, item]) => item.name === 'batch_read')?.[1];
    expect(parent?.receipt).toEqual(expect.any(String));
    const parentReceipt = JSON.parse(parent!.receipt!) as {
      invocationId: string;
      terminal: string;
      success: boolean;
      result: { output: string };
    };
    expect(parentReceipt).toMatchObject({ terminal: 'completed', success: true });
    const aggregate = JSON.parse(parentReceipt.result.output) as {
      steps: Array<{ invocationId: string; receiptDigest: string }>;
    };
    expect(aggregate.steps).toHaveLength(2);
    for (const step of aggregate.steps) {
      const child = items.find(([itemId]) => itemId === step.invocationId)?.[1];
      expect(child?.receipt && JSON.parse(child.receipt)).toMatchObject({
        parentInvocationId: parentReceipt.invocationId,
        terminal: 'completed',
        success: true,
        digest: step.receiptDigest,
      });
    }
    expect(
      runtime.graph.eventStore
        .replay(0)
        .events.filter(event => event.payload.type === 'tool.receipt')
    ).toHaveLength(3);
    expect(universe.core.stats()).toMatchObject({
      shardModuleLoads: 2,
      loadedShardNames: ['grep', 'read_file'],
    });
    expect(universe.longTail.stats()).toMatchObject({ groupModuleLoads: 0 });

    await runtime.close('batch product test complete');
  });
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
