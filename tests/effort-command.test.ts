import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findCommand } from '../src/commands';
import type { CommandContext } from '../src/commands/types';
import { Store } from '../src/framework/store';
import { loadConfig } from '../src/services/config';
import { buildRegistry } from '../src/services/model-registry';
import { createSession, deleteSession, loadSessionMeta } from '../src/services/session-storage';

describe('/effort command', () => {
  let root: string;
  let configRoot: string;
  let previousConfigRoot: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-effort-project-'));
    configRoot = mkdtempSync(join(tmpdir(), 'orion-effort-config-'));
    previousConfigRoot = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = configRoot;
  });

  afterEach(() => {
    if (previousConfigRoot === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = previousConfigRoot;
    rmSync(root, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
  });

  function context(withCapability: boolean): CommandContext {
    const registry = buildRegistry({
      providers: [
        {
          id: 'test-provider',
          baseUrl: 'https://example.invalid/v1',
          apiKey: 'test',
          protocol: 'openai-completions',
        },
      ],
      models: [
        {
          id: 'test-model',
          provider: 'test-provider',
          model: 'gpt-5',
          ...(withCapability
            ? {
                reasoningCapability: {
                  kind: 'effort-level' as const,
                  supportedLevels: ['low', 'medium', 'high'] as const as Array<
                    'low' | 'medium' | 'high'
                  >,
                  defaultLevel: 'medium' as const,
                  adapter: 'openai-chat-reasoning-effort' as const,
                  source: 'config' as const,
                },
              }
            : { reasoning: true }),
        },
      ],
      defaultModel: 'test-model',
    }).registry!;
    const config = loadConfig({ apiKey: 'test', model: 'test-model' });
    config.modelRegistry = registry;
    const store = new Store({ config, tools: [], currentModel: 'test-model' });
    const session = createSession(root, 'test-model');
    return {
      cwd: root,
      config,
      store,
      llm: null,
      getSession: () => session,
      ensureSession: () => session,
    };
  }

  it('reports legacy reasoning=true as unavailable instead of guessing a wire field', async () => {
    const ctx = context(false);
    const status = await findCommand('effort')!.execute(ctx, 'status');
    expect(status.output).toContain('Supported: unavailable');
    expect(status.output).toContain('capability');

    const set = await findCommand('effort')!.execute(ctx, 'high');
    expect(set).toMatchObject({ success: false });
    expect(loadSessionMeta(ctx.getSession!()!.id)?.effortPreference).toBeUndefined();
  });

  it('persists a supported session preference and resets it with auto', async () => {
    const ctx = context(true);
    const set = await findCommand('reasoning')!.execute(ctx, 'high');
    expect(set).toMatchObject({ success: true });
    expect(set.output).toContain('next logical request');
    expect(loadSessionMeta(ctx.getSession!()!.id)?.effortPreference).toBe('high');
    expect(ctx.store.getSnapshot().resolvedEffort).toMatchObject({
      requested: 'high',
      effective: 'high',
    });

    await findCommand('effort')!.execute(ctx, 'auto');
    expect(loadSessionMeta(ctx.getSession!()!.id)?.effortPreference).toBeUndefined();
  });

  it('shows supported and current effort in the canonical model picker', async () => {
    const ctx = context(true);
    await findCommand('effort')!.execute(ctx, 'high');

    const result = await findCommand('model')!.execute(ctx, '');

    expect(result.modelPicker?.models[0]).toMatchObject({
      name: 'test-model',
      effortSupportedLevels: ['low', 'medium', 'high'],
      effortCurrent: 'high',
    });
  });

  it('does not mutate runtime effort when session persistence fails', async () => {
    const ctx = context(true);
    const session = ctx.getSession!()!;
    expect(deleteSession(session.id)).toBe(true);

    const set = await findCommand('effort')!.execute(ctx, 'high');

    expect(set).toMatchObject({ success: false });
    expect(set.error).toContain('no longer available');
    expect(session.effortPreference).toBeUndefined();
    expect(ctx.store.getSnapshot().effortPreference).toBe('auto');
  });
});
