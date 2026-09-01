import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SettingsCoordinatorError,
  SettingsCoordinatorV1,
  type SettingsInvalidationV1,
  type SettingsOperationV1,
} from '../src/services/settings-coordinator';
import {
  SettingsDocumentRepository,
  SettingsDocumentRepositoryError,
} from '../src/services/settings-document-repository';

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Settings state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('SettingsCoordinatorV1', () => {
  let root: string;
  let documentPath: string;
  let revisionKeyPath: string;
  const coordinators: SettingsCoordinatorV1[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-settings-coordinator-'));
    documentPath = join(root, 'orion.json');
    revisionKeyPath = join(root, '.revision-key');
  });

  afterEach(() => {
    for (const coordinator of coordinators.splice(0)) coordinator.close();
    rmSync(root, { recursive: true, force: true });
  });

  function create(
    options: Partial<Parameters<typeof SettingsCoordinatorV1.create>[0]> = {}
  ): SettingsCoordinatorV1 {
    const coordinator = SettingsCoordinatorV1.create({
      workspace: '/repo/packages/web',
      repositoryOptions: { documentPath, revisionKeyPath, watchDebounceMs: 5 },
      documentOpener: () => undefined,
      ...options,
    });
    coordinators.push(coordinator);
    return coordinator;
  }

  test('describes field sources, scopes, applies semantics, and explicit reset eligibility', () => {
    writeFileSync(
      documentPath,
      JSON.stringify({
        schemaVersion: 1,
        defaultModel: 'configured-model',
        defaultEffort: 'low',
        toolConfirmation: 'deny',
        web: { appearance: { style: 'classic', theme: 'dark' } },
        projects: { '/repo/packages/web': { defaultEffort: 'high' } },
      })
    );
    const coordinator = create();
    const document = coordinator.describe({
      currentSession: {
        model: 'session-model',
        effort: 'xhigh',
        overridesProjectEffort: true,
      },
    });

    expect(document).toMatchObject({
      schemaVersion: 2,
      state: 'ready',
      writable: true,
      hasDocument: true,
      workspace: '/repo/packages/web',
      sections: {
        appearance: {
          style: {
            effectiveValue: 'classic',
            explicitValue: 'classic',
            source: 'global',
            scope: 'global',
            applies: 'live',
            overridden: false,
          },
          theme: {
            effectiveValue: 'dark',
            explicitValue: 'dark',
            source: 'global',
            scope: 'global',
            applies: 'live',
            overridden: false,
          },
          motion: {
            effectiveValue: 'system',
            inheritedValue: 'system',
            source: 'internal',
          },
        },
        defaults: {
          model: {
            effectiveValue: 'configured-model',
            explicitValue: 'configured-model',
            applies: 'new-session',
            overridden: true,
          },
          effort: {
            effectiveValue: 'high',
            explicitValue: 'high',
            inheritedValue: 'low',
            source: 'project',
            overridden: true,
          },
        },
        permissions: {
          toolConfirmation: {
            effectiveValue: 'deny',
            explicitValue: 'deny',
            overridden: false,
          },
        },
      },
    });
    expect(document.revision).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.sections.appearance.theme)).toBe(true);
  });

  test('defaults to Blocksmith and persists visual style independently from light/dark theme', async () => {
    const coordinator = create();
    const initial = coordinator.describe();
    expect(initial).toMatchObject({
      schemaVersion: 2,
      sections: {
        appearance: {
          style: {
            effectiveValue: 'orion-blocksmith',
            inheritedValue: 'orion-blocksmith',
            source: 'internal',
          },
          theme: { effectiveValue: 'system' },
        },
      },
    });

    const updated = await coordinator.update({
      expectedRevision: initial.revision,
      operations: [
        { op: 'set', key: 'appearance.style', value: 'classic' },
        { op: 'set', key: 'appearance.theme', value: 'light' },
      ],
    });
    expect(updated.appliedKeys).toEqual(['appearance.style', 'appearance.theme']);
    expect(updated.document.sections.appearance).toMatchObject({
      style: { effectiveValue: 'classic', explicitValue: 'classic' },
      theme: { effectiveValue: 'light', explicitValue: 'light' },
    });

    const reset = await coordinator.update({
      expectedRevision: updated.revision,
      operations: [{ op: 'unset', key: 'appearance.style' }],
    });
    expect(reset.document.sections.appearance).toMatchObject({
      style: { effectiveValue: 'orion-blocksmith', inheritedValue: 'orion-blocksmith' },
      theme: { effectiveValue: 'light', explicitValue: 'light' },
    });
  });

  test('projects the model catalog and credential readiness without returning secret values or env names', () => {
    process.env.ORION_SETTINGS_FIXTURE_TOKEN = 'fixture-value';
    writeFileSync(
      documentPath,
      JSON.stringify({
        schemaVersion: 1,
        providers: [
          {
            id: 'environment-provider',
            baseUrl: 'http://127.0.0.1/v1',
            apiKey: '$ORION_SETTINGS_FIXTURE_TOKEN',
            protocol: 'openai-completions',
          },
          {
            id: 'legacy-provider',
            baseUrl: 'http://127.0.0.1/v1',
            apiKey: 'legacy-secret-value',
            protocol: 'openai-completions',
          },
        ],
        models: [
          {
            id: 'fixture-model',
            displayName: 'Fixture Model',
            provider: 'environment-provider',
            model: 'wire-model',
          },
        ],
        defaultModel: 'fixture-model',
      })
    );
    const document = create().describe();
    delete process.env.ORION_SETTINGS_FIXTURE_TOKEN;

    expect(document.models).toEqual([
      { id: 'fixture-model', label: 'Fixture Model', provider: 'environment-provider' },
    ]);
    expect(document.credentials).toEqual([
      {
        providerId: 'environment-provider',
        state: 'ready',
        source: 'environment',
        writable: false,
      },
      {
        providerId: 'legacy-provider',
        state: 'ready',
        source: 'legacy',
        writable: false,
      },
    ]);
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain('fixture-value');
    expect(serialized).not.toContain('legacy-secret-value');
    expect(serialized).not.toContain('ORION_SETTINGS_FIXTURE_TOKEN');
  });

  test('serializes concurrent writers so the same revision commits only once', async () => {
    const coordinator = create();
    const revision = coordinator.describe().revision;
    const [first, second] = await Promise.allSettled([
      coordinator.update({
        expectedRevision: revision,
        operations: [{ op: 'set', key: 'appearance.theme', value: 'light' }],
      }),
      coordinator.update({
        expectedRevision: revision,
        operations: [{ op: 'set', key: 'appearance.theme', value: 'dark' }],
      }),
    ]);

    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = [first, second].find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    expect(rejected?.reason).toMatchObject({
      status: 409,
      code: 'settings_revision_conflict',
    });
  });

  test('a failed queue item does not poison the next valid update', async () => {
    const coordinator = create();
    const revision = coordinator.describe().revision;
    await expect(
      coordinator.update({
        expectedRevision: revision,
        operations: [
          { op: 'set', key: 'not.allowed', value: 'x' } as unknown as SettingsOperationV1,
        ],
      })
    ).rejects.toMatchObject({ status: 400, code: 'settings_invalid_operation' });

    await expect(
      coordinator.update({
        expectedRevision: revision,
        operations: [{ op: 'set', key: 'appearance.motion', value: 'reduced' }],
      })
    ).resolves.toMatchObject({ appliedKeys: ['appearance.motion'] });
  });

  test('checks idle only for runtime-sensitive batches and rejects a mixed batch atomically', async () => {
    const runtimeIdle = jest.fn(() => false);
    const coordinator = create({ runtimeIdle });
    const revision = coordinator.describe().revision;

    const appearance = await coordinator.update({
      expectedRevision: revision,
      operations: [{ op: 'set', key: 'appearance.theme', value: 'dark' }],
    });
    expect(runtimeIdle).not.toHaveBeenCalled();

    await expect(
      coordinator.update({
        expectedRevision: appearance.revision,
        operations: [
          { op: 'set', key: 'appearance.motion', value: 'reduced' },
          { op: 'set', key: 'permissions.toolConfirmation', value: 'ask' },
        ],
      })
    ).rejects.toMatchObject({ status: 409, code: 'runtime_busy' });
    expect(JSON.parse(readFileSync(documentPath, 'utf8')).web.appearance).toEqual({
      theme: 'dark',
    });
  });

  test('persists internal global effort and projects it as project inheritance', async () => {
    const coordinator = create({ runtimeIdle: () => true });
    const revision = coordinator.describe().revision;
    const result = await coordinator.update({
      expectedRevision: revision,
      operations: [{ op: 'set', key: 'defaults.globalEffort', value: 'medium' }],
    });

    expect(JSON.parse(readFileSync(documentPath, 'utf8')).defaultEffort).toBe('medium');
    expect(result.document.sections.defaults.effort).toMatchObject({
      effectiveValue: 'medium',
      inheritedValue: 'medium',
      source: 'global',
      scope: 'project',
    });
  });

  test('runs prepare before persistence and rejects without changing bytes', async () => {
    const original = '{ "schemaVersion": 1, "defaultModel": "gpt-4o" }\n';
    writeFileSync(documentPath, original);
    const coordinator = create({
      runtimePrepare: () => {
        throw new Error('semantic rejection');
      },
    });
    const revision = coordinator.describe().revision;

    await expect(
      coordinator.update({
        expectedRevision: revision,
        operations: [{ op: 'set', key: 'defaults.model', value: 'other' }],
      })
    ).rejects.toMatchObject({ status: 422, code: 'settings_rejected' });
    expect(readFileSync(documentPath, 'utf8')).toBe(original);
  });

  test('isolates a persistence failure before runtime apply and keeps the queue usable', async () => {
    const original = '{ "schemaVersion": 1, "future": { "retained": true } }\n';
    writeFileSync(documentPath, original);
    const repository = SettingsDocumentRepository.create({ documentPath, revisionKeyPath });
    const persist = jest.spyOn(repository, 'persist').mockImplementationOnce(() => {
      throw new SettingsDocumentRepositoryError(
        'settings_document_unavailable',
        'controlled persistence failure'
      );
    });
    const apply = jest.fn();
    const coordinator = create({ repository, runtimeApply: apply });
    const revision = coordinator.describe().revision;

    await expect(
      coordinator.update({
        requestId: '00000000-0000-4000-8000-000000000010',
        expectedRevision: revision,
        operations: [{ op: 'set', key: 'appearance.theme', value: 'dark' }],
      })
    ).rejects.toMatchObject({
      status: 503,
      code: 'settings_document_unavailable',
      message: 'controlled persistence failure',
    });
    expect(apply).not.toHaveBeenCalled();
    expect(readFileSync(documentPath, 'utf8')).toBe(original);

    await expect(
      coordinator.update({
        requestId: '00000000-0000-4000-8000-000000000011',
        expectedRevision: revision,
        operations: [{ op: 'set', key: 'appearance.theme', value: 'light' }],
      })
    ).resolves.toMatchObject({ appliedKeys: ['appearance.theme'] });
    expect(persist).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  test('rejects an unavailable configured default model before persistence', async () => {
    const original = '{"schemaVersion":1,"defaultModel":"available"}';
    writeFileSync(documentPath, original);
    const coordinator = create({ models: [{ id: 'available', label: 'Available' }] });
    const revision = coordinator.describe().revision;

    await expect(
      coordinator.update({
        expectedRevision: revision,
        operations: [{ op: 'set', key: 'defaults.model', value: 'missing' }],
      })
    ).rejects.toMatchObject({ status: 422, code: 'settings_rejected' });
    expect(readFileSync(documentPath, 'utf8')).toBe(original);
  });

  test('restores exact old bytes when runtime apply fails', async () => {
    const original = '{ "schemaVersion": 1, "defaultModel": "gpt-4o", "future": [1,2] }\n';
    writeFileSync(documentPath, original);
    const invalidations: SettingsInvalidationV1[] = [];
    const coordinator = create({
      onInvalidated: event => invalidations.push(event),
      runtimeApply: () => {
        throw new Error('apply failed');
      },
    });
    const revision = coordinator.describe().revision;

    await expect(
      coordinator.update({
        expectedRevision: revision,
        operations: [{ op: 'set', key: 'defaults.model', value: 'other' }],
      })
    ).rejects.toMatchObject({ status: 422, code: 'settings_rejected' });
    expect(readFileSync(documentPath, 'utf8')).toBe(original);
    expect(coordinator.describe().revision).toBe(revision);
    expect(invalidations.at(-1)).toMatchObject({ reason: 'local-write', state: 'ready' });
  });

  test('fails closed when runtime compensation cannot restore the committed Settings state', async () => {
    const original = '{ "schemaVersion": 1, "web": { "appearance": { "theme": "light" } } }\n';
    writeFileSync(documentPath, original);
    const invalidations: SettingsInvalidationV1[] = [];
    const coordinator = create({
      onInvalidated: event => invalidations.push(event),
      runtimeApply: () => {
        throw new SettingsCoordinatorError(
          503,
          'settings_recovery_required',
          'controlled compensation failure'
        );
      },
    });
    const revision = coordinator.describe().revision;

    await expect(
      coordinator.update({
        expectedRevision: revision,
        operations: [{ op: 'set', key: 'appearance.theme', value: 'dark' }],
      })
    ).rejects.toMatchObject({ status: 503, code: 'settings_recovery_required' });

    expect(readFileSync(documentPath, 'utf8')).toBe(original);
    expect(coordinator.describe()).toMatchObject({
      state: 'unavailable',
      writable: false,
      diagnostic: { code: 'settings_recovery_required' },
    });
    expect(invalidations.at(-1)).toMatchObject({ reason: 'local-write', state: 'invalid' });
    await expect(
      coordinator.update({
        expectedRevision: revision,
        operations: [{ op: 'set', key: 'appearance.theme', value: 'system' }],
      })
    ).rejects.toMatchObject({ status: 503, code: 'settings_recovery_required' });
  });

  test('fails recovery closed instead of overwriting a third-party edit after apply failure', async () => {
    writeFileSync(documentPath, JSON.stringify({ schemaVersion: 1, defaultModel: 'gpt-4o' }));
    const coordinator = create({
      runtimeApply: () => {
        writeFileSync(
          documentPath,
          JSON.stringify({ schemaVersion: 1, defaultModel: 'external-model' })
        );
        throw new Error('apply failed after external edit');
      },
    });
    const revision = coordinator.describe().revision;

    await expect(
      coordinator.update({
        expectedRevision: revision,
        operations: [{ op: 'set', key: 'defaults.model', value: 'other' }],
      })
    ).rejects.toMatchObject({ status: 503, code: 'settings_recovery_required' });
    expect(JSON.parse(readFileSync(documentPath, 'utf8')).defaultModel).toBe('external-model');
    expect(coordinator.describe()).toMatchObject({
      state: 'unavailable',
      writable: false,
      diagnostic: { code: 'settings_recovery_required' },
    });
  });

  test('replays an exact requestId once and rejects reuse with a different body', async () => {
    const apply = jest.fn();
    const coordinator = create({ runtimeApply: apply });
    const revision = coordinator.describe().revision;
    const request = {
      requestId: '00000000-0000-4000-8000-000000000001',
      expectedRevision: revision,
      operations: [{ op: 'set', key: 'appearance.theme', value: 'dark' }] as const,
    };
    const first = await coordinator.update(request);
    const replay = await coordinator.update(request);

    expect(replay).toBe(first);
    expect(apply).toHaveBeenCalledTimes(1);
    await expect(
      coordinator.update({
        ...request,
        operations: [{ op: 'set', key: 'appearance.theme', value: 'light' }],
      })
    ).rejects.toMatchObject({ status: 409, code: 'request_id_conflict' });
  });

  test('opens an invalid document for repair without overwriting it and creates a missing one safely', async () => {
    const opened: string[] = [];
    const coordinator = create({
      documentOpener: path => {
        opened.push(path);
      },
    });
    await coordinator.openDocument();
    expect(opened).toEqual([documentPath]);
    expect(statSync(documentPath).mode & 0o777).toBe(0o600);

    coordinator.close();
    coordinators.splice(coordinators.indexOf(coordinator), 1);
    writeFileSync(documentPath, '{bad-json');
    const repair = create({
      documentOpener: path => {
        opened.push(path);
      },
    });
    await repair.openDocument();
    expect(opened).toEqual([documentPath, documentPath]);
    expect(readFileSync(documentPath, 'utf8')).toBe('{bad-json');
  });

  test('surfaces invalid documents as last-good read-only state and never leaks invalid bytes', () => {
    writeFileSync(documentPath, JSON.stringify({ schemaVersion: 1, defaultModel: 'good-model' }));
    const coordinator = create();
    coordinator.describe();
    writeFileSync(documentPath, '{"apiKey":"do-not-leak"');
    const invalid = coordinator.describe();

    expect(invalid).toMatchObject({
      state: 'invalid',
      writable: false,
      sections: { defaults: { model: { effectiveValue: 'good-model' } } },
      diagnostic: { code: 'settings_document_invalid' },
    });
    expect(JSON.stringify(invalid)).not.toContain('do-not-leak');
  });

  test('automatically applies a valid external controlled diff without rewriting its bytes', async () => {
    const original = '{"schemaVersion":1,"defaultModel":"gpt-4o"}';
    writeFileSync(documentPath, original);
    const apply = jest.fn();
    const coordinator = create({ runtimeApply: apply });
    const external =
      '{ "schemaVersion": 1, "defaultModel": "gpt-4o", "web": { "appearance": { "theme": "dark" } } }\n';

    writeFileSync(documentPath, external);
    await waitUntil(() => apply.mock.calls.length === 1);

    expect(apply.mock.calls[0][0].operations).toEqual([
      { op: 'set', key: 'appearance.theme', value: 'dark' },
    ]);
    expect(readFileSync(documentPath, 'utf8')).toBe(external);
    expect(coordinator.hasPendingExternalChanges()).toBe(false);
  });

  test('keeps a busy runtime-sensitive external edit pending until explicit synchronization', async () => {
    let idle = false;
    const idleProbe = jest.fn(() => idle);
    const apply = jest.fn();
    const coordinator = create({ runtimeIdle: idleProbe, runtimeApply: apply });
    writeFileSync(documentPath, JSON.stringify({ schemaVersion: 1, toolConfirmation: 'deny' }));

    await expect(coordinator.synchronizeExternalChanges()).rejects.toMatchObject({
      status: 409,
      code: 'runtime_busy',
    });
    expect(idleProbe).toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(coordinator.hasPendingExternalChanges()).toBe(true);

    idle = true;
    const synchronized = await coordinator.synchronizeExternalChanges();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0].operations).toEqual([
      { op: 'set', key: 'permissions.toolConfirmation', value: 'deny' },
    ]);
    expect(synchronized.sections.permissions.toolConfirmation.effectiveValue).toBe('deny');
    expect(coordinator.hasPendingExternalChanges()).toBe(false);
  });

  test('folds multiple external edits into the latest revision', async () => {
    const apply = jest.fn();
    const coordinator = create({ runtimeApply: apply });
    writeFileSync(
      documentPath,
      JSON.stringify({ schemaVersion: 1, web: { appearance: { theme: 'light' } } })
    );
    writeFileSync(
      documentPath,
      JSON.stringify({ schemaVersion: 1, web: { appearance: { theme: 'dark' } } })
    );

    await coordinator.synchronizeExternalChanges();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0].operations).toEqual([
      { op: 'set', key: 'appearance.theme', value: 'dark' },
    ]);
  });

  test('never applies invalid external bytes and keeps the last-good runtime state', async () => {
    writeFileSync(documentPath, JSON.stringify({ schemaVersion: 1, defaultModel: 'good-model' }));
    const apply = jest.fn();
    const coordinator = create({ runtimeApply: apply });
    const invalidBytes = '{"apiKey":"do-not-apply"';
    writeFileSync(documentPath, invalidBytes);

    const view = await coordinator.synchronizeExternalChanges();
    expect(view.state).toBe('invalid');
    expect(view.sections.defaults.model.effectiveValue).toBe('good-model');
    expect(apply).not.toHaveBeenCalled();
    expect(readFileSync(documentPath, 'utf8')).toBe(invalidBytes);
  });

  test('marks external apply failure as recovery-required without writing back external bytes', async () => {
    writeFileSync(documentPath, JSON.stringify({ schemaVersion: 1, defaultModel: 'gpt-4o' }));
    const externalBytes = JSON.stringify({ schemaVersion: 1, defaultModel: 'external-model' });
    const coordinator = create({
      runtimeApply: () => {
        throw new Error('runtime rejected external settings');
      },
    });
    writeFileSync(documentPath, externalBytes);

    await expect(coordinator.synchronizeExternalChanges()).rejects.toMatchObject({
      status: 503,
      code: 'settings_recovery_required',
    });
    expect(readFileSync(documentPath, 'utf8')).toBe(externalBytes);
    expect(coordinator.describe()).toMatchObject({
      state: 'unavailable',
      writable: false,
      diagnostic: { code: 'settings_recovery_required' },
    });
  });

  test('exports the requested structured coordinator error shape', () => {
    const error = new SettingsCoordinatorError(409, 'settings_revision_conflict');
    expect(error).toMatchObject({ status: 409, code: 'settings_revision_conflict' });
  });
});
