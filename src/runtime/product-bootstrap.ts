import { resolve } from 'path';

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
import {
  SettingsCoordinatorError,
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
import { SessionComposerControlServiceV1 } from './session-composer-control';
import { OrionSessionRunnerV1 } from './orion-session-runner';
import type { OrionRuntimeV1 } from './orion-runtime-v1';
import type { ThreadSessionRuntimeActivationV1 } from './thread-session-view';
import { createProductOrionRuntimeV1 } from './product-orion-runtime';
import { createProductionFilesystemSkillProviderV1 } from './skills';
import type { OrionCodeUiRuntime } from './ui-events';
import type { WorkspaceMutationCoordinatorV1 } from './step-snapshot';
import {
  WorkspaceRuntimeKernelV1,
  type WorkspaceSettingsRuntimeParticipantV1,
} from './workspace-runtime-kernel';

export interface CreateWorkspaceRuntimeKernelOptionsV1 {
  readonly cwd: string;
  readonly uiRenderer?: UIRenderer;
  readonly onSettingsInvalidated?: (event: SettingsInvalidationV1) => void;
}

/**
 * Composition root for one workspace-owned kernel. Web Hosts pool kernels per
 * canonical Workspace so a Context switch can keep running Session actors on
 * the config/Tool/MCP/Settings services they were created with, instead of
 * rebuilding them against whatever Workspace is active at actor-start time.
 */
export function createWorkspaceRuntimeKernelV1(
  options: CreateWorkspaceRuntimeKernelOptionsV1
): WorkspaceRuntimeKernelV1 {
  const canonicalCwd = resolve(options.cwd);
  ensureConfigDir();
  recordFirstStartTime();
  const kernelConfig = loadConfig(
    options.uiRenderer ? { ui: { renderer: options.uiRenderer } } : {}
  );
  const kernelTools = createProductionFirstPartyToolUniverseV1({
    context: {
      cwd: canonicalCwd,
      config: { name: kernelConfig.name, mode: kernelConfig.mode },
    },
  });
  const kernelSkillProvider = createProductionFilesystemSkillProviderV1({
    cwd: canonicalCwd,
    configuredPaths: kernelConfig.skills?.paths,
  });
  const kernelMcpAdapter = createFirstPartyMcpAdapterV1({
    config: loadFirstPartyMcpConfigurationV1(),
    baseDirectory: canonicalCwd,
  });
  return new WorkspaceRuntimeKernelV1({
    cwd: canonicalCwd,
    config: kernelConfig,
    toolUniverse: kernelTools,
    skillProvider: kernelSkillProvider,
    mcpAdapter: kernelMcpAdapter,
    onSettingsInvalidated: options.onSettingsInvalidated,
  });
}

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
  /** Optional Web-hosted FIFO for side effects shared by concurrent Session actors. */
  readonly workspaceMutationCoordinator?: WorkspaceMutationCoordinatorV1;
  /** Workspace-owned resources reused by Web Session actors. */
  readonly workspaceRuntimeKernel?: WorkspaceRuntimeKernelV1;
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
  const canonicalCwd = resolve(options.cwd);
  const cwd = canonicalCwd;
  const ownsWorkspaceRuntimeKernel = options.workspaceRuntimeKernel === undefined;
  let workspaceRuntimeKernel = options.workspaceRuntimeKernel;
  if (!workspaceRuntimeKernel) {
    workspaceRuntimeKernel = createWorkspaceRuntimeKernelV1({
      cwd: canonicalCwd,
      uiRenderer: options.uiRenderer,
      onSettingsInvalidated: options.onSettingsInvalidated,
    });
  } else if (workspaceRuntimeKernel.cwd !== canonicalCwd) {
    throw new Error('Workspace Runtime kernel does not match the requested working directory.');
  }

  let releaseSettingsRuntime: (() => void) | undefined;
  try {
    const config = workspaceRuntimeKernel.createRuntimeConfig();
    const memoryContent = buildMemoryPromptContext('', cwd).content;
    const projectInstructionsContent = loadProjectInstructions(cwd);
    const toolCatalog = workspaceRuntimeKernel.toolUniverse.catalog;
    const skillProvider = workspaceRuntimeKernel.skillProvider;
    const mcpAdapter = workspaceRuntimeKernel.mcpAdapter;

    const profileFor = (selector: string): ResolvedModelProfile | undefined =>
      config.modelRegistry
        ? (lookupProfile(config.modelRegistry, selector) ?? undefined)
        : undefined;
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
      llm.resilience = workspaceRuntimeKernel.providerResilience;

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
    let shutdownResult: Promise<void> | undefined;
    let projectToolConfirmation = config.toolConfirmation;

    const applySessionState = (
      session: SessionMeta | null,
      resolvedEffortOverride?: ResolvedEffort
    ): void => {
      const selector = session?.model ?? defaultModelSelector;
      const profile = profileFor(selector);
      const provider = profile ? config.modelRegistry?.providers.get(profile.provider) : undefined;
      const effort = resolvedEffortOverride ?? resolveRuntimeEffort(session);
      config.toolConfirmation = session?.toolConfirmationOverride ?? projectToolConfirmation;

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

    const applySettingsRuntime: WorkspaceSettingsRuntimeParticipantV1['runtimeApply'] =
      async context => {
        const previousDefaultModel = defaultModelSelector;
        const previousConfigModel = config.model;
        const previousGlobalEffort = config.defaultEffort;
        const previousToolConfirmation = config.toolConfirmation;
        const previousProjectToolConfirmation = projectToolConfirmation;
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
        const changesDefaultModel = context.operations.some(
          operation => operation.key === 'defaults.model'
        );
        const changesEffort = context.operations.some(
          operation =>
            operation.key === 'defaults.effort' || operation.key === 'defaults.globalEffort'
        );
        const changesToolConfirmation = context.operations.some(
          operation => operation.key === 'permissions.toolConfirmation'
        );
        let restored = false;
        const restore = async (): Promise<void> => {
          if (restored) return;
          restored = true;
          defaultModelSelector = previousDefaultModel;
          config.model = previousConfigModel;
          config.defaultEffort = previousGlobalEffort;
          projectToolConfirmation = previousProjectToolConfirmation;
          config.toolConfirmation = previousToolConfirmation;
          // Restore the live effort from the pre-write view instead of rereading
          // the still-new project/global bytes during the coordinator rollback.
          applySessionState(currentSession, previousResolvedEffort);
          if (changesToolConfirmation && sessionRunner && currentSession) {
            await sessionRunner.restoreSession().catch(() => undefined);
          }
        };

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
            projectToolConfirmation =
              context.document.sections.permissions.toolConfirmation.effectiveValue;
          }
          if (changesDefaultModel || changesEffort || changesToolConfirmation) {
            applySessionState(currentSession);
          }
          if (changesToolConfirmation && sessionRunner && currentSession) {
            await sessionRunner.restoreSession();
          }
          return restore;
        } catch (error) {
          try {
            await restore();
          } catch {
            throw new SettingsCoordinatorError(
              503,
              'settings_recovery_required',
              'The Session runtime could not restore its previous Settings state.'
            );
          }
          throw error;
        }
      };

    const settingsCoordinator = workspaceRuntimeKernel.settingsCoordinator;
    releaseSettingsRuntime = workspaceRuntimeKernel.registerSettingsRuntime({
      runtimeIdle: () => settingsRuntimeIdleProbe(),
      runtimePrepare: prepareSettingsRuntime,
      runtimeApply: applySettingsRuntime,
    });
    const initialSettingsDocument = settingsCoordinator.describe();
    defaultModelSelector = initialSettingsDocument.sections.defaults.model.effectiveValue;
    projectToolConfirmation =
      initialSettingsDocument.sections.permissions.toolConfirmation.effectiveValue;
    config.toolConfirmation = projectToolConfirmation;

    const describeSettings: NonNullable<OrionCodeUiRuntime['describeSettings']> = () =>
      settingsCoordinator.describe({
        currentSession: currentSessionSettings(),
        runtime: { busy: !workspaceRuntimeKernel.runtimeIdle() },
      });
    const updateSettings: NonNullable<OrionCodeUiRuntime['updateSettings']> = input =>
      settingsCoordinator.update({
        ...input,
        currentSession: currentSessionSettings(),
        runtime: { busy: !workspaceRuntimeKernel.runtimeIdle() },
      });
    const synchronizeSettings: NonNullable<OrionCodeUiRuntime['synchronizeSettings']> = () =>
      settingsCoordinator.synchronizeExternalChanges({
        currentSession: currentSessionSettings(),
        runtime: { busy: !workspaceRuntimeKernel.runtimeIdle() },
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

    const shutdown = (): Promise<void> => {
      if (shutdownResult) return shutdownResult;
      shutdownResult = (async () => {
        releaseSettingsRuntime?.();
        try {
          await sessionRunner?.close(options.shutdownReason ?? 'Orion product runtime shutdown');
          if (currentSession) {
            const messages = readSessionMessages(currentSession.id);
            if (messages.length > 0) updateSessionSummary(currentSession.id, messages);
            endSession(currentSession.id);
          }
        } finally {
          unsubscribeLlmUsage?.();
          if (ownsWorkspaceRuntimeKernel) workspaceRuntimeKernel.releaseOwner();
        }
      })();
      return shutdownResult;
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
                  workspaceMutationCoordinator: options.workspaceMutationCoordinator,
                  providerRequestGate: workspaceRuntimeKernel.providerRequestGate,
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

    const rebindSessionRuntime = async (): Promise<void> => {
      if (sessionRunner && currentSession) await sessionRunner.restoreSession();
    };
    const sessionComposerControls = new SessionComposerControlServiceV1({
      cwd,
      config,
      store,
      llm,
      compactCoordinator,
      modelCoordinator,
      getSession,
      ensureSession,
      projectToolConfirmation: () => projectToolConfirmation,
      applySessionState,
      rebindSessionRuntime,
      runtimeIdle: () => settingsRuntimeIdleProbe(),
    });

    return {
      cwd,
      version: PACKAGE_VERSION,
      config,
      store,
      llm,
      compactCoordinator,
      modelCoordinator,
      sessionComposerControls,
      workspaceRuntimeKernel,
      createAgentRunner,
      getHarnessDiagnostics: async () => sessionRunner?.diagnostics(),
      inspectSkills,
      inspectMcp: () => mcpAdapter.descriptors,
      rebindSessionRuntime,
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
  } catch (error) {
    releaseSettingsRuntime?.();
    if (ownsWorkspaceRuntimeKernel) workspaceRuntimeKernel.releaseOwner();
    throw error;
  }
}
