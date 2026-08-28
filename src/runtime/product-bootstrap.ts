import { buildMemoryPromptContext } from '../memory/prompt-context';
import { Store } from '../framework/store';
import { CompactCoordinator } from '../services/compact';
import { isConfigured, loadConfig, type UIRenderer } from '../services/config';
import { ensureConfigDir } from '../services/config-dir';
import {
  getProjectConfig,
  incrementSessionCount,
  loadGlobalConfig,
  recordFirstStartTime,
} from '../services/global-config';
import { LLMService } from '../services/llm';
import { resolveProfileEffort, type ResolvedEffort } from '../services/effort';
import { discoverModelContexts } from '../services/model-context';
import { lookupProfile, type ResolvedModelProfile } from '../services/model-registry';
import { loadProjectInstructions } from '../services/project-instructions';
import { ProviderResilienceCoordinator } from '../services/provider-resilience';
import {
  SettingsCoordinatorV1,
  type SettingsInvalidationV1,
  type SettingsUpdateContextV1,
} from '../services/settings-coordinator';
import {
  createSession,
  endSession,
  readSessionMessages,
  updateSessionSummary,
  type SessionMeta,
} from '../services/session-storage';
import { appendUsageRecord } from '../services/usage-state';
import { PACKAGE_VERSION } from '../product/version';
import { createProductionFirstPartyToolUniverseV1 } from './first-party-tool-universe';
import { createFirstPartyMcpAdapterV1, loadFirstPartyMcpConfigurationV1 } from './mcp';
import { ModelCoordinator } from './model-coordinator';
import { OrionSessionRunnerV1 } from './orion-session-runner';
import type { OrionRuntimeV1 } from './orion-runtime-v1';
import type { ThreadSessionRuntimeActivationV1 } from './thread-session-view';
import { createProductOrionRuntimeV1 } from './product-orion-runtime';
import { createProductionFilesystemSkillProviderV1 } from './skills';
import type { OrionCodeUiRuntime } from './ui-events';

export interface ProductUiRuntimeBootstrapOptions {
  readonly cwd: string;
  readonly uiRenderer?: UIRenderer;
  /** Renderer-specific shutdown label used in durable diagnostics. */
  readonly shutdownReason?: string;
  readonly onActiveSessionRuntime?: (
    runtime: OrionRuntimeV1,
    sessionId: string,
    activation?: ThreadSessionRuntimeActivationV1
  ) => void | (() => void);
  /** Secret-free Settings invalidations projected by the renderer-owned host. */
  readonly onSettingsInvalidated?: (event: SettingsInvalidationV1) => void;
}

/**
 * Shared product composition root for TUI, terminal, print and Web surfaces.
 *
 * Renderers receive the same Store, session runner, OrionRuntime and permission
 * bridge. Presentation layers must not construct an alternate agent loop.
 */
export async function createProductUiRuntime(
  options: ProductUiRuntimeBootstrapOptions
): Promise<OrionCodeUiRuntime> {
  ensureConfigDir();
  recordFirstStartTime();

  const cwd = options.cwd;
  const config = loadConfig(options.uiRenderer ? { ui: { renderer: options.uiRenderer } } : {});
  const memoryContent = buildMemoryPromptContext('', cwd).content;
  const projectInstructionsContent = loadProjectInstructions(cwd);
  const firstPartyTools = createProductionFirstPartyToolUniverseV1({
    context: { cwd, config: { name: config.name, mode: config.mode } },
  });
  const toolCatalog = firstPartyTools.catalog;
  const skillProvider = createProductionFilesystemSkillProviderV1({
    cwd,
    configuredPaths: config.skills?.paths,
  });
  const mcpAdapter = createFirstPartyMcpAdapterV1({
    config: loadFirstPartyMcpConfigurationV1(),
    baseDirectory: cwd,
  });

  const profileFor = (selector: string): ResolvedModelProfile | undefined =>
    config.modelRegistry ? (lookupProfile(config.modelRegistry, selector) ?? undefined) : undefined;
  // `config.model` is already resolved through the explicit durable
  // `defaultModel`. Keep the product default separate so unset agrees with
  // loadConfig() on the next Host bootstrap.
  const internalDefaultModelSelector = 'gpt-4o';
  const initialProfile =
    profileFor(config.model) ?? config.modelRegistry?.defaultProfile ?? undefined;
  let defaultModelSelector = config.modelRegistry?.defaultProfile?.id ?? config.model;
  const resolveRuntimeEffort = (session?: SessionMeta | null) =>
    resolveProfileEffort(profileFor(session?.model ?? defaultModelSelector) ?? initialProfile, {
      session: session?.effortPreference,
      project: getProjectConfig(cwd).defaultEffort,
      global: loadGlobalConfig().defaultEffort ?? config.defaultEffort,
    });
  const initialEffort = resolveRuntimeEffort();

  const store = new Store({
    config,
    tools: toolCatalog.entries.map(entry => entry.tool),
    currentModel: config.model,
    effortPreference: initialEffort.requested,
    resolvedEffort: initialEffort,
    memoryContent,
    skillsContent: '',
    projectInstructionsContent,
  });

  let llm: LLMService | null = null;
  let modelCoordinator: ModelCoordinator | undefined;
  const configured = config.modelRegistry
    ? config.modelRegistry.defaultProfile !== null
    : isConfigured(config);
  if (configured) {
    const defaultProvider = initialProfile
      ? config.modelRegistry?.providers.get(initialProfile.provider)
      : null;
    llm = new LLMService({
      apiKey: defaultProvider
        ? defaultProvider.apiKey.startsWith('$')
          ? (process.env[defaultProvider.apiKey.slice(1)] ?? '')
          : defaultProvider.apiKey
        : config.apiKey,
      baseUrl: defaultProvider?.baseUrl ?? config.apiBaseUrl,
      model: initialProfile?.model ?? config.model,
      fallbackModel: config.modelRegistry?.fallbackProfile?.model ?? config.fallbackModel,
      providerProtocol: defaultProvider?.protocol,
      reasoningCapability: initialProfile?.reasoningCapability,
      fallbackReasoningCapability: config.modelRegistry?.fallbackProfile?.reasoningCapability,
      effortPreference: initialEffort.requested,
    });
    llm.resilience = new ProviderResilienceCoordinator();

    modelCoordinator = new ModelCoordinator();
    if (config.modelRegistry && config.modelClientPool) {
      modelCoordinator.bind(config.modelRegistry, config.modelClientPool);
      modelCoordinator.initModel(initialProfile?.id ?? config.model);
    }

    if (config.apiBaseUrl) {
      discoverModelContexts(config.apiBaseUrl, config.apiKey).catch(() => undefined);
    }
  }

  const compactCoordinator = new CompactCoordinator({
    modelId: llm?.getModel() ?? config.model,
    llm,
    outputReserveTokens: llm?.getMaxTokens?.(),
    compactInstructions: getProjectConfig(cwd).compactInstructions,
    getContextCapsule: () => store.getSnapshot().harnessState?.capsule,
    getHarnessState: () => store.getSnapshot().harnessState,
  });

  let currentSession: SessionMeta | null = null;
  let sessionRunner: OrionSessionRunnerV1 | undefined;
  let settingsRuntimeIdleProbe = (): boolean => true;
  let shuttingDown = false;

  const applySessionState = (
    session: SessionMeta | null,
    resolvedEffortOverride?: ResolvedEffort
  ): void => {
    const selector = session?.model ?? defaultModelSelector;
    const profile = profileFor(selector);
    const provider = profile ? config.modelRegistry?.providers.get(profile.provider) : undefined;
    const effort = resolvedEffortOverride ?? resolveRuntimeEffort(session);

    if (profile) {
      modelCoordinator?.initModel(profile.id);
      if (provider && config.modelClientPool) {
        llm?.setProviderClient(config.modelClientPool.getClient(provider));
      }
      llm?.setModel(profile.model);
    } else {
      llm?.setModel(selector);
    }
    if (provider) {
      llm?.setEffortContext({
        preference: effort.requested,
        protocol: provider.protocol,
        capability: profile?.reasoningCapability,
        fallbackCapability: config.modelRegistry?.fallbackProfile?.reasoningCapability,
      });
    }
    store.setState({ currentModel: profile?.id ?? selector });
    store.setEffort(effort.requested, effort);
    compactCoordinator.configure({
      modelId: profile?.model ?? selector,
      llm,
      outputReserveTokens: llm?.getMaxTokens?.(),
    });
  };
  const setSession = (session: SessionMeta | null): void => {
    applySessionState(session);
    currentSession = session;
  };
  const currentSessionSettings = () => {
    if (!currentSession) return undefined;
    return {
      model: currentSession.model,
      effort: resolveRuntimeEffort(currentSession).requested,
      overridesProjectEffort: currentSession.effortPreference !== undefined,
    } as const;
  };
  const ensureSession = (): SessionMeta => {
    if (!currentSession) {
      defaultModelSelector =
        settingsCoordinator?.describe().sections.defaults.model.effectiveValue ??
        defaultModelSelector;
      const created = createSession(cwd, defaultModelSelector);
      incrementSessionCount();
      setSession(created);
      return created;
    }
    return currentSession;
  };
  const getSession = (): SessionMeta | null => currentSession;

  const prepareSettingsRuntime = (context: Omit<SettingsUpdateContextV1, 'document'>): void => {
    const defaultModelOperation = context.operations.find(
      operation => operation.key === 'defaults.model'
    );
    const candidateDefaultModelSelector =
      defaultModelOperation?.op === 'set'
        ? defaultModelOperation.value
        : defaultModelOperation?.op === 'unset'
          ? internalDefaultModelSelector
          : defaultModelSelector;
    const effortModelSelector = currentSession?.model ?? candidateDefaultModelSelector;

    for (const operation of context.operations) {
      if (operation.key === 'defaults.model') {
        const candidate = operation.op === 'set' ? operation.value : internalDefaultModelSelector;
        const configured = config.modelRegistry?.enabledProfiles.some(
          profile => profile.id === candidate
        );
        if (config.modelRegistry && !configured) {
          throw new Error(`Model ${candidate} is not enabled in the configured registry.`);
        }
      }
      if (
        (operation.key === 'defaults.effort' || operation.key === 'defaults.globalEffort') &&
        operation.op === 'set' &&
        operation.value !== 'auto'
      ) {
        const profile = profileFor(effortModelSelector);
        const resolved = resolveProfileEffort(profile, { request: operation.value });
        if (!resolved.supported) {
          throw new Error(
            `Effort ${operation.value} is unavailable for ${profile?.id ?? 'the active model'}.`
          );
        }
      }
    }
  };

  const applySettingsRuntime = async (context: SettingsUpdateContextV1): Promise<void> => {
    const previousDefaultModel = defaultModelSelector;
    const previousConfigModel = config.model;
    const previousGlobalEffort = config.defaultEffort;
    const previousToolConfirmation = config.toolConfirmation;
    const changesDefaultModel = context.operations.some(
      operation => operation.key === 'defaults.model'
    );
    const changesEffort = context.operations.some(
      operation => operation.key === 'defaults.effort' || operation.key === 'defaults.globalEffort'
    );
    const changesToolConfirmation = context.operations.some(
      operation => operation.key === 'permissions.toolConfirmation'
    );

    try {
      if (changesDefaultModel) {
        defaultModelSelector = context.document.sections.defaults.model.effectiveValue;
        config.model = defaultModelSelector;
      }
      const globalEffortOperation = context.operations.find(
        operation => operation.key === 'defaults.globalEffort'
      );
      if (globalEffortOperation) {
        config.defaultEffort =
          globalEffortOperation.op === 'set' ? globalEffortOperation.value : undefined;
      }
      if (changesToolConfirmation) {
        config.toolConfirmation =
          context.document.sections.permissions.toolConfirmation.effectiveValue;
      }
      if (changesDefaultModel || changesEffort) applySessionState(currentSession);
      if (changesToolConfirmation && sessionRunner && currentSession) {
        await sessionRunner.restoreSession();
      }
    } catch (error) {
      const previousEffortField = context.before.sections.defaults.effort;
      const previousResolvedEffort = resolveProfileEffort(
        profileFor(currentSession?.model ?? previousDefaultModel) ?? initialProfile,
        {
          session: currentSession?.effortPreference,
          ...(previousEffortField.source === 'project'
            ? { project: previousEffortField.effectiveValue }
            : previousEffortField.source === 'global'
              ? { global: previousEffortField.effectiveValue }
              : {}),
        }
      );
      defaultModelSelector = previousDefaultModel;
      config.model = previousConfigModel;
      config.defaultEffort = previousGlobalEffort;
      config.toolConfirmation = previousToolConfirmation;
      // Coordinator rolls durable bytes back only after this callback rejects.
      // Restore the live effort from the pre-write view instead of rereading
      // the still-new project/global bytes during this catch path.
      applySessionState(currentSession, previousResolvedEffort);
      if (changesToolConfirmation && sessionRunner && currentSession) {
        await sessionRunner.restoreSession().catch(() => undefined);
      }
      throw error;
    }
  };

  const settingsCoordinator = SettingsCoordinatorV1.create({
    workspace: cwd,
    onInvalidated: options.onSettingsInvalidated,
    models: config.modelRegistry?.enabledProfiles.map(profile => ({
      id: profile.id,
      label: profile.displayName ?? profile.id,
      provider: profile.provider,
    })),
    internalDefaultModel: internalDefaultModelSelector,
    modelDefaultEffort: 'auto',
    internalToolConfirmation: 'allow',
    runtimeIdle: () => settingsRuntimeIdleProbe(),
    runtimePrepare: prepareSettingsRuntime,
    runtimeApply: applySettingsRuntime,
  });
  defaultModelSelector = settingsCoordinator.describe().sections.defaults.model.effectiveValue;

  const describeSettings: NonNullable<OrionCodeUiRuntime['describeSettings']> = () =>
    settingsCoordinator!.describe({
      currentSession: currentSessionSettings(),
      runtime: { busy: !settingsRuntimeIdleProbe() },
    });
  const updateSettings: NonNullable<OrionCodeUiRuntime['updateSettings']> = input =>
    settingsCoordinator!.update({
      ...input,
      currentSession: currentSessionSettings(),
      runtime: { busy: !settingsRuntimeIdleProbe() },
    });
  const synchronizeSettings: NonNullable<OrionCodeUiRuntime['synchronizeSettings']> = () =>
    settingsCoordinator!.synchronizeExternalChanges({
      currentSession: currentSessionSettings(),
      runtime: { busy: !settingsRuntimeIdleProbe() },
    });
  const bindSettingsRuntimeIdleProbe: NonNullable<
    OrionCodeUiRuntime['bindSettingsRuntimeIdleProbe']
  > = probe => {
    settingsRuntimeIdleProbe = probe;
    return () => {
      if (settingsRuntimeIdleProbe === probe) settingsRuntimeIdleProbe = () => true;
    };
  };

  const costTracker = store.getSnapshot().costTracker;
  costTracker.setRecordSink(record => {
    appendUsageRecord(record, { sessionId: currentSession?.id, projectPath: cwd });
  });
  const unsubscribeLlmUsage = llm?.subscribeUsage(event => {
    costTracker.record(event.usage, { model: event.model, requestKind: event.operation });
  });

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    settingsCoordinator?.close();
    await sessionRunner?.close(options.shutdownReason ?? 'Orion product runtime shutdown');
    if (currentSession) {
      const messages = readSessionMessages(currentSession.id);
      if (messages.length > 0) updateSessionSummary(currentSession.id, messages);
      endSession(currentSession.id);
    }
    unsubscribeLlmUsage?.();
  };

  const createAgentRunner: OrionCodeUiRuntime['createAgentRunner'] = llm
    ? (events, runnerOptions) => {
        if (sessionRunner) return sessionRunner;
        sessionRunner = new OrionSessionRunnerV1({
          eventSink: events,
          getSessionId: () => ensureSession().id,
          createRuntime: (sessionId, activation) =>
            createProductOrionRuntimeV1(
              {
                cwd,
                config,
                store,
                llm: llm as LLMService,
                compactCoordinator,
                toolCatalog,
                skillProviders: [skillProvider],
                mcpDescriptors: mcpAdapter.descriptors,
                mcpConnector: mcpAdapter.connector,
                approvalHandler: runnerOptions.approvalHandler,
              },
              sessionId,
              activation
            ),
          mode: () => {
            const mode = store.getSnapshot().agentMode;
            return mode === 'plan' ? 'plan' : mode === 'auto' ? 'auto' : 'build';
          },
          onActiveRuntime: options.onActiveSessionRuntime,
          replayHistoryOnRestore: runnerOptions.replayHistoryOnRestore,
        });
        return sessionRunner;
      }
    : undefined;

  const inspectSkills: NonNullable<OrionCodeUiRuntime['inspectSkills']> = async () => {
    const controller = new AbortController();
    const observation = await skillProvider.list(
      { id: `product:${cwd}`, sourceScopeOrder: undefined },
      controller.signal
    );
    return observation.descriptors;
  };

  return {
    cwd,
    version: PACKAGE_VERSION,
    config,
    store,
    llm,
    compactCoordinator,
    modelCoordinator,
    createAgentRunner,
    getHarnessDiagnostics: async () => sessionRunner?.diagnostics(),
    inspectSkills,
    inspectMcp: () => mcpAdapter.descriptors,
    rebindSessionRuntime: async () => {
      if (sessionRunner && currentSession) await sessionRunner.restoreSession();
    },
    settingsCoordinator,
    describeSettings,
    updateSettings,
    synchronizeSettings,
    bindSettingsRuntimeIdleProbe,
    isConfigured: isConfigured(config),
    ensureSession,
    setSession,
    getSession,
    shutdown,
  };
}
