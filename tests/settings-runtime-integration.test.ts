import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findCommand } from '../src/commands';
import type { CommandContext } from '../src/commands/types';
import { Store } from '../src/framework/store';
import { createProductUiRuntime } from '../src/runtime/product-bootstrap';
import type { OrionRuntimeV1 } from '../src/runtime/orion-runtime-v1';
import type { UiEventSink } from '../src/runtime/ui-events';
import { loadConfig } from '../src/services/config';
import { loadGlobalConfig, updateGlobalConfig } from '../src/services/global-config';
import {
  createSession,
  loadSessionMeta,
  updateSessionEffort,
  updateSessionModel,
} from '../src/services/session-storage';

describe('Settings runtime integration', () => {
  let root: string;
  let configRoot: string;
  let previousConfigRoot: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-settings-runtime-project-'));
    configRoot = mkdtempSync(join(tmpdir(), 'orion-settings-runtime-config-'));
    previousConfigRoot = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = configRoot;
  });

  afterEach(() => {
    if (previousConfigRoot === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = previousConfigRoot;
    rmSync(root, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
  });

  it('updates only the model field in locked Session metadata', () => {
    const session = createSession(root, 'model-before');
    expect(updateSessionEffort(session.id, 'high')).toMatchObject({ effortPreference: 'high' });

    const updated = updateSessionModel(session.id, ' model-after ');

    expect(updated).toMatchObject({ model: 'model-after', effortPreference: 'high' });
    expect(loadSessionMeta(session.id)).toMatchObject({
      model: 'model-after',
      effortPreference: 'high',
    });
    expect(() => updateSessionModel(session.id, '   ')).toThrow('must not be empty');
    expect(loadSessionMeta(session.id)?.model).toBe('model-after');
  });

  it('keeps ordinary /model Session-scoped and leaves the global default unchanged', async () => {
    updateGlobalConfig({ defaultModel: 'glm-5' });
    const config = loadConfig({ apiKey: 'test-key', model: 'glm-5' });
    const store = new Store({ config, tools: [], currentModel: 'glm-5' });
    const session = createSession(root, 'glm-5');
    const setModel = jest.fn();
    const ctx: CommandContext = {
      cwd: root,
      config,
      store,
      llm: { getModel: jest.fn(() => 'glm-5'), setModel } as unknown as CommandContext['llm'],
      getSession: () => session,
      ensureSession: () => session,
    };

    const result = await findCommand('model')!.execute(ctx, 'opus');

    expect(result).toMatchObject({ success: true });
    expect(setModel).toHaveBeenCalledWith('claude-opus-4-8');
    expect(store.getSnapshot().currentModel).toBe('claude-opus-4-8');
    expect(session.model).toBe('claude-opus-4-8');
    expect(loadSessionMeta(session.id)?.model).toBe('claude-opus-4-8');
    expect(loadGlobalConfig().defaultModel).toBe('glm-5');
  });

  it('bootstraps and restores effort as session > project > global > model default', async () => {
    writeRuntimeConfig({ globalEffort: 'low', projectEffort: 'high' });
    const projectRuntime = await createProductUiRuntime({ cwd: root });
    expect(projectRuntime.store.getSnapshot()).toMatchObject({
      effortPreference: 'high',
      resolvedEffort: { requested: 'high', effective: 'high', source: 'project' },
    });

    const session = createSession(root, 'reasoner');
    updateSessionEffort(session.id, 'minimal');
    projectRuntime.setSession(loadSessionMeta(session.id));
    expect(projectRuntime.store.getSnapshot()).toMatchObject({
      effortPreference: 'minimal',
      resolvedEffort: { requested: 'minimal', effective: 'minimal', source: 'session' },
    });
    projectRuntime.setSession(null);
    await projectRuntime.shutdown();

    writeRuntimeConfig({ globalEffort: 'low' });
    const globalRuntime = await createProductUiRuntime({ cwd: root });
    expect(globalRuntime.store.getSnapshot()).toMatchObject({
      effortPreference: 'low',
      resolvedEffort: { requested: 'low', effective: 'low', source: 'global' },
    });
    await globalRuntime.shutdown();

    writeRuntimeConfig({});
    const modelRuntime = await createProductUiRuntime({ cwd: root });
    expect(modelRuntime.store.getSnapshot()).toMatchObject({
      effortPreference: 'auto',
      resolvedEffort: { requested: 'auto', effective: 'medium', source: 'model-default' },
    });
    await modelRuntime.shutdown();
  });

  it('keeps default-model changes separate from current Sessions and restores the internal default on unset', async () => {
    writeRuntimeConfig({});
    const runtime = await createProductUiRuntime({ cwd: root });
    const current = runtime.ensureSession();
    expect(current.model).toBe('reasoner');

    const ctx: CommandContext = {
      cwd: root,
      config: runtime.config,
      store: runtime.store,
      llm: runtime.llm,
      compactCoordinator: runtime.compactCoordinator,
      modelCoordinator: runtime.modelCoordinator,
      getSession: runtime.getSession,
      ensureSession: runtime.ensureSession,
      describeSettings: runtime.describeSettings,
      updateSettings: runtime.updateSettings,
    };
    const changed = await findCommand('model')!.execute(ctx, 'alternate --default');

    expect(changed).toMatchObject({ success: true });
    expect(current.model).toBe('reasoner');
    expect(runtime.store.getSnapshot().currentModel).toBe('reasoner');
    expect(runtime.describeSettings!().sections.defaults.model.effectiveValue).toBe('alternate');

    runtime.setSession(null);
    const next = runtime.ensureSession();
    expect(next.model).toBe('alternate');

    const beforeReset = runtime.describeSettings!();
    await runtime.updateSettings!({
      requestId: 'test:default-model:unset',
      expectedRevision: beforeReset.revision,
      operations: [{ op: 'unset', key: 'defaults.model' }],
    });
    expect(next.model).toBe('alternate');
    expect(runtime.store.getSnapshot().currentModel).toBe('alternate');

    runtime.setSession(null);
    expect(runtime.ensureSession().model).toBe('gpt-4o');
    await runtime.shutdown();
  });

  it('uses the internal default immediately and after restart when an explicit default is unset', async () => {
    writeRuntimeConfig({ defaultModel: 'alternate' });
    const runtime = await createProductUiRuntime({ cwd: root });
    expect(runtime.describeSettings!().sections.defaults.model.effectiveValue).toBe('alternate');

    const before = runtime.describeSettings!();
    await runtime.updateSettings!({
      requestId: 'test:default-model:baseline-unset',
      expectedRevision: before.revision,
      operations: [{ op: 'unset', key: 'defaults.model' }],
    });

    expect(runtime.config.model).toBe('gpt-4o');
    expect(runtime.ensureSession().model).toBe('gpt-4o');
    await runtime.shutdown();

    const restarted = await createProductUiRuntime({ cwd: root });
    expect(restarted.config.model).toBe('gpt-4o');
    expect(restarted.ensureSession().model).toBe('gpt-4o');
    await restarted.shutdown();
  });

  it('validates a same-batch effort against the candidate default model before persistence', async () => {
    writeRuntimeConfig({ alternateSupportedLevels: ['low'] });
    const documentPath = join(configRoot, 'orion.json');
    const runtime = await createProductUiRuntime({ cwd: root });
    const before = runtime.describeSettings!();
    const originalBytes = readFileSync(documentPath, 'utf8');

    await expect(
      runtime.updateSettings!({
        requestId: 'test:model-effort:candidate-validation',
        expectedRevision: before.revision,
        operations: [
          { op: 'set', key: 'defaults.model', value: 'alternate' },
          { op: 'set', key: 'defaults.effort', value: 'high' },
        ],
      })
    ).rejects.toMatchObject({ status: 422, code: 'settings_rejected' });
    expect(readFileSync(documentPath, 'utf8')).toBe(originalBytes);
    expect(runtime.describeSettings!().sections.defaults.model.effectiveValue).toBe('reasoner');
    await runtime.shutdown();
  });

  it('does not overwrite invalid startup bytes while exposing last-good-free invalid state', async () => {
    const documentPath = join(configRoot, 'orion.json');
    const invalidBytes = '{"apiKey":"must-not-be-overwritten"';
    writeFileSync(documentPath, invalidBytes);

    const runtime = await createProductUiRuntime({ cwd: root });

    expect(readFileSync(documentPath, 'utf8')).toBe(invalidBytes);
    expect(runtime.describeSettings!()).toMatchObject({
      state: 'invalid',
      writable: false,
      diagnostic: { code: 'settings_document_invalid' },
    });
    await runtime.shutdown();
  });

  it('routes project and global effort mutations through the product Settings coordinator', async () => {
    writeRuntimeConfig({});
    const runtime = await createProductUiRuntime({ cwd: root });
    const session = runtime.ensureSession();
    const ctx: CommandContext = {
      cwd: root,
      config: runtime.config,
      store: runtime.store,
      llm: runtime.llm,
      getSession: () => session,
      ensureSession: () => session,
      describeSettings: runtime.describeSettings,
      updateSettings: runtime.updateSettings,
    };

    expect(await findCommand('effort')!.execute(ctx, 'high --project')).toMatchObject({
      success: true,
    });
    expect(loadGlobalConfig().projects?.[root]?.defaultEffort).toBe('high');
    expect(runtime.store.getSnapshot().resolvedEffort).toMatchObject({
      requested: 'high',
      source: 'project',
    });

    expect(await findCommand('effort')!.execute(ctx, 'auto --project')).toMatchObject({
      success: true,
    });
    expect(await findCommand('effort')!.execute(ctx, 'low --global')).toMatchObject({
      success: true,
    });
    expect(loadGlobalConfig().projects?.[root]?.defaultEffort).toBeUndefined();
    expect(loadGlobalConfig().defaultEffort).toBe('low');
    expect(runtime.store.getSnapshot().resolvedEffort).toMatchObject({
      requested: 'low',
      source: 'global',
    });
    await runtime.shutdown();
  });

  it('rebinds the active Session Runtime only after a tool-policy write commits', async () => {
    writeRuntimeConfig({});
    const activeRuntimes: OrionRuntimeV1[] = [];
    const runtime = await createProductUiRuntime({
      cwd: root,
      onActiveSessionRuntime: activeRuntime => {
        activeRuntimes.push(activeRuntime);
      },
    });
    runtime.ensureSession();
    const runner = runtime.createAgentRunner!(createUiEvents(), {
      approvalHandler: async () => false,
    });
    await runner.restoreSession!();
    expect(activeRuntimes).toHaveLength(1);
    expect(activeRuntimes[0].state).toBe('started');

    const before = runtime.describeSettings!();
    await runtime.updateSettings!({
      requestId: 'test:tool-policy:deny',
      expectedRevision: before.revision,
      operations: [{ op: 'set', key: 'permissions.toolConfirmation', value: 'deny' }],
    });

    expect(runtime.config.toolConfirmation).toBe('deny');
    expect(activeRuntimes).toHaveLength(2);
    expect(activeRuntimes[0].state).toBe('closed');
    expect(activeRuntimes[1].state).toBe('started');
    await runtime.shutdown();
  });

  it('restores pre-write live effort when policy rebind fails before durable rollback', async () => {
    writeRuntimeConfig({ globalEffort: 'low' });
    const documentPath = join(configRoot, 'orion.json');
    const runtime = await createProductUiRuntime({ cwd: root });
    runtime.ensureSession();
    const runner = runtime.createAgentRunner!(createUiEvents(), {
      approvalHandler: async () => false,
    });
    await runner.restoreSession!();
    const restoreSession = jest.spyOn(runner, 'restoreSession');
    restoreSession
      .mockRejectedValueOnce(new Error('controlled runtime rebind failure'))
      .mockResolvedValueOnce(undefined);
    const originalBytes = readFileSync(documentPath, 'utf8');
    const before = runtime.describeSettings!();

    await expect(
      runtime.updateSettings!({
        requestId: 'test:runtime-rollback:effort-and-policy',
        expectedRevision: before.revision,
        operations: [
          { op: 'set', key: 'defaults.effort', value: 'high' },
          { op: 'set', key: 'permissions.toolConfirmation', value: 'deny' },
        ],
      })
    ).rejects.toMatchObject({ status: 422, code: 'settings_rejected' });

    expect(restoreSession).toHaveBeenCalledTimes(2);
    expect(readFileSync(documentPath, 'utf8')).toBe(originalBytes);
    expect(runtime.config.toolConfirmation).toBe('ask');
    expect(runtime.store.getSnapshot().resolvedEffort).toMatchObject({
      requested: 'low',
      source: 'global',
    });
    await runtime.shutdown();
  });

  function writeRuntimeConfig(options: {
    globalEffort?: 'low';
    projectEffort?: 'high';
    defaultModel?: 'reasoner' | 'alternate';
    alternateSupportedLevels?: Array<'minimal' | 'low' | 'medium' | 'high'>;
  }): void {
    writeFileSync(
      join(configRoot, 'orion.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          defaultModel: options.defaultModel ?? 'reasoner',
          toolConfirmation: 'ask',
          ...(options.globalEffort ? { defaultEffort: options.globalEffort } : {}),
          providers: [
            {
              id: 'test-provider',
              baseUrl: 'https://example.invalid/v1',
              apiKey: 'test-key',
              protocol: 'openai-completions',
            },
          ],
          models: [
            {
              id: 'gpt-4o',
              provider: 'test-provider',
              model: 'gpt-4o-wire',
            },
            {
              id: 'reasoner',
              provider: 'test-provider',
              model: 'reasoner-wire',
              reasoningCapability: {
                kind: 'effort-level',
                supportedLevels: ['minimal', 'low', 'medium', 'high'],
                defaultLevel: 'medium',
                adapter: 'openai-chat-reasoning-effort',
                source: 'config',
              },
            },
            {
              id: 'alternate',
              provider: 'test-provider',
              model: 'alternate-wire',
              reasoningCapability: {
                kind: 'effort-level',
                supportedLevels: options.alternateSupportedLevels ?? [
                  'minimal',
                  'low',
                  'medium',
                  'high',
                ],
                defaultLevel: 'low',
                adapter: 'openai-chat-reasoning-effort',
                source: 'config',
              },
            },
          ],
          ...(options.projectEffort
            ? { projects: { [root]: { defaultEffort: options.projectEffort } } }
            : {}),
        },
        null,
        2
      )
    );
  }

  function createUiEvents(): UiEventSink {
    return {
      append: jest.fn(() => 'entry'),
      update: jest.fn(),
      finalize: jest.fn(),
      remove: jest.fn(),
      replaceTranscript: jest.fn(),
      clearTranscript: jest.fn(),
      setStatus: jest.fn(),
      showSessionPicker: jest.fn(),
      showEditPreview: jest.fn(),
      setProcessing: jest.fn(),
    };
  }
});
