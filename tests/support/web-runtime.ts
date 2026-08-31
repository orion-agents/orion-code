import { join } from 'path';

import { Store } from '../../src/framework/store';
import { CompactCoordinator } from '../../src/services/compact';
import { SessionComposerControlServiceV1 } from '../../src/runtime/session-composer-control';
import type { OrionCodeUiRuntime } from '../../src/runtime/ui-events';
import { loadConfig } from '../../src/services/config';
import { resolveProfileEffort } from '../../src/services/effort';
import { SettingsCoordinatorV1 } from '../../src/services/settings-coordinator';
import type { SessionMeta } from '../../src/services/session-storage';

/** Minimal product-shaped runtime for Web controller/Host unit tests. */
export function createFakeWebRuntime(cwd: string): OrionCodeUiRuntime {
  const config = loadConfig({ apiKey: 'test-key', model: 'test-model' });
  const store = new Store({ config, tools: [], currentModel: config.model });
  const compactCoordinator = new CompactCoordinator({ modelId: config.model });
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
  const applySessionState = (value: SessionMeta | null): void => {
    if (!value) return;
    store.setState({ currentModel: value.model });
    store.setEffort(
      value.effortPreference ?? 'auto',
      resolveProfileEffort(undefined, { session: value.effortPreference })
    );
    config.toolConfirmation = value.toolConfirmationOverride ?? 'ask';
  };
  const sessionComposerControls = new SessionComposerControlServiceV1({
    cwd,
    config,
    store,
    llm: null,
    compactCoordinator,
    getSession: () => session,
    ensureSession: () => {
      if (!session) throw new Error('No active test Session.');
      return session;
    },
    projectToolConfirmation: () => 'ask',
    applySessionState,
    rebindSessionRuntime: async () => undefined,
    runtimeIdle: () => true,
  });

  return {
    cwd,
    version: '0.3.2-test',
    config,
    store,
    llm: null,
    compactCoordinator,
    sessionComposerControls,
    isConfigured: true,
    ensureSession: jest.fn(() => {
      throw new Error('not used');
    }),
    setSession: value => {
      session = value;
      applySessionState(value);
    },
    getSession: () => session,
    activateSession: async value => {
      session = value;
      store.setState({ currentModel: value.model });
    },
    releaseSession: async () => {
      session = null;
    },
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
