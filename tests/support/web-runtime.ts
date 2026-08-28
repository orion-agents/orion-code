import { join } from 'path';

import { Store } from '../../src/framework/store';
import type { OrionCodeUiRuntime } from '../../src/runtime/ui-events';
import { loadConfig } from '../../src/services/config';
import { resolveProfileEffort } from '../../src/services/effort';
import { SettingsCoordinatorV1 } from '../../src/services/settings-coordinator';
import type { SessionMeta } from '../../src/services/session-storage';

/** Minimal product-shaped runtime for Web controller/Host unit tests. */
export function createFakeWebRuntime(cwd: string): OrionCodeUiRuntime {
  const config = loadConfig({ apiKey: 'test-key', model: 'test-model' });
  const store = new Store({ config, tools: [], currentModel: config.model });
  let session: SessionMeta | null = null;
  const coordinator = SettingsCoordinatorV1.create({
    workspace: cwd,
    repositoryOptions: {
      documentPath: join(cwd, '.orion-web-test.json'),
      revisionKeyPath: join(cwd, '.orion-web-test-revision.key'),
    },
    models: [
      { id: config.model, label: config.model, provider: 'test' },
      { id: 'next-model', label: 'next-model', provider: 'test' },
    ],
    credentials: [{ providerId: 'test', state: 'ready', source: 'legacy', writable: false }],
    internalDefaultModel: config.model,
    internalToolConfirmation: config.toolConfirmation,
    runtimeIdle: () => true,
    runtimeApply: ({ document }) => {
      config.toolConfirmation = document.sections.permissions.toolConfirmation.effectiveValue;
      if (!session?.effortPreference) {
        const preference = document.sections.defaults.effort.effectiveValue;
        store.setEffort(preference, resolveProfileEffort(undefined, { project: preference }));
      }
    },
    documentOpener: async () => undefined,
  });
  const describeSettings: NonNullable<OrionCodeUiRuntime['describeSettings']> = () =>
    coordinator.describe({
      ...(session
        ? {
            currentSession: {
              model: store.getSnapshot().currentModel,
              effort: store.getSnapshot().effortPreference,
              overridesProjectEffort: session.effortPreference !== undefined,
            },
          }
        : {}),
      runtime: { busy: false },
    });

  return {
    cwd,
    version: '0.3.0-test',
    config,
    store,
    llm: null,
    isConfigured: true,
    ensureSession: jest.fn(() => {
      throw new Error('not used');
    }),
    setSession: value => {
      session = value;
      if (value) store.setState({ currentModel: value.model });
    },
    getSession: () => session,
    settingsCoordinator: coordinator,
    describeSettings,
    updateSettings: input =>
      coordinator.update({
        ...input,
        ...(session
          ? {
              currentSession: {
                model: store.getSnapshot().currentModel,
                effort: store.getSnapshot().effortPreference,
                overridesProjectEffort: session.effortPreference !== undefined,
              },
            }
          : {}),
      }),
    shutdown: jest.fn(async () => coordinator.close()),
    inspectSkills: async () => [],
    inspectMcp: () => [],
  };
}
