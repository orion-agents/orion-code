import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Store } from '../src/framework/store';
import { ModelCoordinator } from '../src/runtime/model-coordinator';
import {
  SessionComposerControlError,
  SessionComposerControlServiceV1,
} from '../src/runtime/session-composer-control';
import { CompactCoordinator } from '../src/services/compact';
import { loadConfig } from '../src/services/config';
import { ModelClientPool } from '../src/services/model-client-pool';
import { createContextUsageSnapshot } from '../src/services/model-context';
import { buildRegistry } from '../src/services/model-registry';
import {
  createSession,
  loadSessionMeta,
  updateSessionComposerPreferences,
  type SessionMeta,
} from '../src/services/session-storage';

describe('SessionComposerControlServiceV1', () => {
  let root: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-session-composer-'));
    previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
    rmSync(root, { recursive: true, force: true });
  });

  test('persists and clears a Session permission override before rebinding policy', async () => {
    const fixture = createFixture(root);

    const selected = await fixture.controls.setPermissionOverride('allow');
    expect(selected.current).toMatchObject({
      effective: 'allow',
      override: 'allow',
      source: 'session',
    });
    expect(loadSessionMeta(fixture.session.id)?.toolConfirmationOverride).toBe('allow');
    expect(fixture.rebind).toHaveBeenCalledTimes(1);

    const inherited = await fixture.controls.setPermissionOverride(null);
    expect(inherited.current).toMatchObject({
      effective: 'ask',
      override: null,
      source: 'project',
    });
    expect(loadSessionMeta(fixture.session.id)?.toolConfirmationOverride).toBeUndefined();
    expect(fixture.rebind).toHaveBeenCalledTimes(2);
  });

  test('defers models to a logical boundary but applies permission at the next tool admission', async () => {
    const fixture = createFixture(root);
    fixture.setIdle(false);

    await expect(
      fixture.controls.selectModel({ modelId: 'small', effort: 'auto' })
    ).resolves.toMatchObject({
      appliesFrom: 'next-logical-request',
      compactPreflight: 'deferred',
    });
    await expect(fixture.controls.setPermissionOverride('allow')).resolves.toMatchObject({
      appliesFrom: 'next-tool-admission',
    });
    expect(loadSessionMeta(fixture.session.id)).toMatchObject({ model: 'large' });
    expect(loadSessionMeta(fixture.session.id)?.toolConfirmationOverride).toBe('allow');
    expect(fixture.controls.describe().pending).toEqual({
      model: { modelId: 'small', effort: 'auto' },
      permission: null,
    });

    fixture.setIdle(true);
    await fixture.controls.applyPendingAtLogicalBoundary();

    expect(loadSessionMeta(fixture.session.id)).toMatchObject({
      model: 'small',
      toolConfirmationOverride: 'allow',
    });
    expect(fixture.controls.describe()).toMatchObject({
      pending: { model: null, permission: null },
      lastError: null,
    });
  });

  test('keeps last-good metadata and exposes a deferred apply failure', async () => {
    const fixture = createFixture(root);
    fixture.setIdle(false);
    await fixture.controls.selectModel({ modelId: 'small' });
    jest.spyOn(fixture.modelCoordinator, 'switchToWithCompactPreflight').mockResolvedValue({
      success: false,
      error: 'deferred provider rejected',
    });

    fixture.setIdle(true);
    await expect(fixture.controls.applyPendingAtLogicalBoundary()).rejects.toMatchObject({
      code: 'model_unavailable',
    });

    expect(loadSessionMeta(fixture.session.id)).toMatchObject({ model: 'large' });
    expect(fixture.store.getSnapshot().currentModel).toBe('large');
    expect(fixture.controls.describe()).toMatchObject({
      pending: { model: null, permission: null },
      lastError: { code: 'model_unavailable', message: 'deferred provider rejected' },
    });
  });

  test('keeps an unavailable provider group in the secret-free model catalog', () => {
    delete process.env.ORION_TEST_MISSING_PROVIDER_KEY;
    const fixture = createFixture(root, '$ORION_TEST_MISSING_PROVIDER_KEY');

    const catalog = fixture.controls.catalog();

    expect(catalog.models).toHaveLength(2);
    expect(catalog.unavailableProviders).toEqual([
      { id: 'fixture', reason: 'The configured credential slot is unavailable.' },
    ]);
    expect(JSON.stringify(catalog)).not.toContain('ORION_TEST_MISSING_PROVIDER_KEY');
  });

  test('does not enter model compact/switch when the durable Session CAS is stale', async () => {
    const fixture = createFixture(root);
    updateSessionComposerPreferences(fixture.session.id, { model: 'external-model' });
    const switchSpy = jest.spyOn(fixture.modelCoordinator, 'switchToWithCompactPreflight');

    await expect(fixture.controls.selectModel({ modelId: 'small' })).rejects.toMatchObject({
      code: 'composer_control_conflict',
    });

    expect(switchSpy).not.toHaveBeenCalled();
    expect(loadSessionMeta(fixture.session.id)?.model).toBe('external-model');
    expect(fixture.session.model).toBe('external-model');
    expect(fixture.store.getSnapshot().currentModel).toBe('external-model');
  });

  test('rolls durable metadata and live state back when model preflight rejects', async () => {
    const fixture = createFixture(root);
    jest.spyOn(fixture.modelCoordinator, 'switchToWithCompactPreflight').mockResolvedValue({
      success: false,
      error: 'fixture compact rejection',
    });

    await expect(
      fixture.controls.selectModel({ modelId: 'small', effort: 'auto' })
    ).rejects.toMatchObject<Partial<SessionComposerControlError>>({ code: 'model_unavailable' });

    expect(loadSessionMeta(fixture.session.id)).toMatchObject({ model: 'large' });
    expect(fixture.session.model).toBe('large');
    expect(fixture.store.getSnapshot().currentModel).toBe('large');
  });

  test('persists the selected model only after a successful preflight receipt', async () => {
    const fixture = createFixture(root);
    fixture.store.setContextUsage(
      createContextUsageSnapshot({
        modelId: 'large-api-model',
        usedTokens: 4_000,
        outputReserveTokens: 4_000,
      })
    );
    jest.spyOn(fixture.modelCoordinator, 'switchToWithCompactPreflight').mockResolvedValue({
      success: true,
      compacted: true,
      compactRequired: true,
      compactPreflight: 'committed',
    });

    const receipt = await fixture.controls.selectModel({ modelId: 'small' });

    expect(receipt).toMatchObject({
      fromModelId: 'large',
      toModelId: 'small',
      compacted: true,
      compactRequired: true,
      compactPreflight: 'committed',
    });
    expect(loadSessionMeta(fixture.session.id)?.model).toBe('small');
    expect(fixture.store.getSnapshot().currentModel).toBe('small');
    expect(fixture.controls.describe().contextUsage).toBeNull();
  });
});

function createFixture(
  root: string,
  providerApiKey = 'fixture-key'
): {
  readonly session: SessionMeta;
  readonly store: Store;
  readonly controls: SessionComposerControlServiceV1;
  readonly modelCoordinator: ModelCoordinator;
  readonly rebind: jest.Mock<Promise<void>, []>;
  readonly setIdle: (value: boolean) => void;
} {
  const built = buildRegistry({
    providers: [
      {
        id: 'fixture',
        baseUrl: 'https://example.invalid/v1',
        apiKey: providerApiKey,
        protocol: 'openai-completions',
      },
    ],
    models: [
      {
        id: 'large',
        provider: 'fixture',
        model: 'large-api-model',
        contextWindow: 100_000,
        maxOutputTokens: 4_000,
      },
      {
        id: 'small',
        provider: 'fixture',
        model: 'small-api-model',
        contextWindow: 8_000,
        maxOutputTokens: 1_000,
      },
    ],
    defaultModel: 'large',
  });
  if (!built.registry) throw new Error('model registry fixture failed');
  const config = loadConfig({ apiKey: 'fixture-key', model: 'large' });
  config.modelRegistry = built.registry;
  config.modelClientPool = new ModelClientPool();
  const store = new Store({ config, tools: [], currentModel: 'large' });
  const session = createSession(root, 'large');
  const modelCoordinator = new ModelCoordinator();
  modelCoordinator.bind(built.registry, config.modelClientPool);
  modelCoordinator.initModel('large');
  const rebind = jest.fn(async () => undefined);
  let idle = true;
  const applySessionState = (value: SessionMeta | null): void => {
    if (value) store.setState({ currentModel: value.model });
  };
  const controls = new SessionComposerControlServiceV1({
    cwd: root,
    config,
    store,
    llm: null,
    compactCoordinator: new CompactCoordinator({ modelId: 'large' }),
    modelCoordinator,
    getSession: () => session,
    ensureSession: () => session,
    projectToolConfirmation: () => 'ask',
    applySessionState,
    rebindSessionRuntime: rebind,
    runtimeIdle: () => idle,
  });
  return {
    session,
    store,
    controls,
    modelCoordinator,
    rebind,
    setIdle: value => void (idle = value),
  };
}
