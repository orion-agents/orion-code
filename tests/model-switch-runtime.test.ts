import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findCommand } from '../src/commands';
import type { CommandContext } from '../src/commands/types';
import { Store } from '../src/framework/store';
import { ModelCoordinator } from '../src/runtime/model-coordinator';
import { CompactCoordinator } from '../src/services/compact';
import { loadConfig } from '../src/services/config';
import { ModelClientPool } from '../src/services/model-client-pool';
import { buildRegistry } from '../src/services/model-registry';
import {
  appendSessionMessages,
  createSession,
  loadSessionCompactCheckpoint,
  readSessionTraceEvents,
} from '../src/services/session-storage';

describe('runtime model-switch compact transaction', () => {
  const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-model-switch-runtime-'));
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  test('commits semantic context before switching to a smaller configured model', async () => {
    const built = buildRegistry({
      providers: [
        {
          id: 'provider',
          baseUrl: 'https://example.com/v1',
          apiKey: 'sk-test',
          protocol: 'openai-completions',
        },
      ],
      models: [
        {
          id: 'large',
          provider: 'provider',
          model: 'large-api-model',
          contextWindow: 100_000,
          maxOutputTokens: 4_000,
        },
        {
          id: 'small',
          provider: 'provider',
          model: 'small-api-model',
          contextWindow: 8_000,
          maxOutputTokens: 1_000,
        },
      ],
      defaultModel: 'large',
    });
    if (!built.registry) throw new Error('registry fixture failed');

    const pool = new ModelClientPool();
    const config = loadConfig({ apiKey: 'sk-test', model: 'large' });
    config.modelRegistry = built.registry;
    config.modelClientPool = pool;
    const history = Array.from({ length: 36 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `${index}:${'context '.repeat(180)}`,
    }));
    const store = new Store({ config, tools: [], currentModel: 'large' });
    store.setState({ conversationHistory: history });
    const session = createSession(root, 'large');
    appendSessionMessages(
      session.id,
      history.map((message, index) => ({ ...message, timestamp: index + 1 }))
    );

    const coordinator = new ModelCoordinator();
    coordinator.bind(built.registry, pool);
    coordinator.initModel('large');
    const setModel = jest.fn();
    const setProviderClient = jest.fn();
    const llm = {
      getModel: jest.fn(() => 'large-api-model'),
      getMaxTokens: jest.fn(() => 4_000),
      chat: jest.fn(async () => ({ content: 'Durable semantic summary.', model: 'large' })),
      setModel,
      setProviderClient,
      setEffortContext: jest.fn(),
    } as unknown as CommandContext['llm'];
    const compactCoordinator = new CompactCoordinator({ modelId: 'large', llm });
    const ctx: CommandContext = {
      cwd: root,
      config,
      store,
      llm,
      compactCoordinator,
      modelCoordinator: coordinator,
      getSession: () => session,
      ensureSession: () => session,
      getActiveGoal: () => null,
    };

    const result = await findCommand('model')!.execute(ctx, 'small');
    const checkpoint = loadSessionCompactCheckpoint(session.id);

    expect(result).toMatchObject({ success: true });
    expect(coordinator.getCurrent()?.id).toBe('small');
    expect(setProviderClient).toHaveBeenCalledTimes(1);
    expect(setModel).toHaveBeenCalledWith('small-api-model');
    expect(store.getSnapshot().currentModel).toBe('small');
    expect(store.getSnapshot().conversationHistory.length).toBeLessThan(history.length);
    expect(checkpoint).toMatchObject({
      version: 2,
      modelId: 'small',
      summary: { strategy: 'model-switch-semantic-v2' },
      candidateReceipt: { source: 'semantic_candidate' },
      validation: { targetMet: true },
    });
    if (checkpoint?.version === 2) {
      expect(checkpoint.candidateReceipt.afterTokens).toBeLessThanOrEqual(
        checkpoint.candidateReceipt.targetTokens!
      );
    }
    expect(
      readSessionTraceEvents(session.id)
        .filter(event => event.type.startsWith('compact_'))
        .map(event => event.type)
    ).toEqual([
      'compact_prepare',
      'compact_validate',
      'compact_commit',
      'compact_boundary',
      'compact_completed',
    ]);
  });
});
