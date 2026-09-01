import { randomUUID } from 'crypto';

import type { OrionCodeCLIConfig } from '../services/config';
import { compactMessages, type CompactCoordinator } from '../services/compact';
import type { Store } from '../framework/store';
import type { LLMService } from '../services/llm';
import { createContextUsageSnapshot, type ContextUsageSnapshot } from '../services/model-context';
import {
  lookupProfile,
  resolveModelProfile,
  type ResolvedModelProfile,
} from '../services/model-registry';
import {
  isEffortPreference,
  resolveProfileEffort,
  type EffortLevel,
  type EffortPreference,
  type ResolvedEffort,
} from '../services/effort';
import {
  getProjectConfig,
  loadGlobalConfig,
  type ToolConfirmationPolicy,
} from '../services/global-config';
import {
  appendSessionTraceEvent,
  commitSessionCompactCheckpoint,
  loadSessionMeta,
  prepareSessionCompactSourceReceipt,
  projectSessionComposerPreferences,
  SessionComposerPreferencesConflictError,
  updateSessionComposerPreferences,
  type SessionComposerPreferencesV1,
  type SessionMeta,
} from '../services/session-storage';
import { estimateMessagesTokens } from '../utils/token-estimate';
import type {
  ModelSwitchCompactPreflightReceipt,
  ModelSwitchCompactPreflightRequest,
  ModelSwitchResult,
} from './model-coordinator';
import type { ModelCoordinator } from './model-coordinator';
import { digestRuntimeValue } from './protocol/canonical';

export type SessionControlValueSourceV1 = 'session' | 'project' | 'global' | 'model-default';

export interface SessionModelCatalogEntryV1 {
  readonly id: string;
  readonly label: string;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: boolean;
  readonly effortLevels: readonly EffortLevel[];
  readonly defaultEffort?: EffortLevel;
  readonly aliases: readonly string[];
  readonly fingerprint: string;
}

export interface SessionModelCatalogV1 {
  readonly revision: string;
  readonly models: readonly SessionModelCatalogEntryV1[];
  readonly unavailableProviders: readonly { readonly id: string; readonly reason: string }[];
}

export interface SessionPermissionSelectionV1 {
  readonly effective: ToolConfirmationPolicy;
  readonly override: ToolConfirmationPolicy | null;
  readonly projectDefault: ToolConfirmationPolicy;
  readonly source: 'session' | 'project';
}

export interface SessionModelSelectionV1 {
  readonly modelId: string;
  readonly providerId: string | null;
  readonly providerLabel: string | null;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly effort: {
    readonly requested: EffortPreference;
    readonly effective: EffortLevel | null;
    readonly source: ResolvedEffort['source'];
    readonly supported: boolean;
    readonly supportedLevels: readonly EffortLevel[];
    readonly warning?: string;
  };
}

export interface SessionComposerRuntimeStateV1 {
  readonly sessionId: string;
  readonly model: SessionModelSelectionV1;
  readonly permission: SessionPermissionSelectionV1;
  readonly contextUsage: ContextUsageSnapshot | null;
  readonly pending: {
    readonly model: {
      readonly modelId: string;
      readonly effort: EffortPreference;
    } | null;
    readonly permission: {
      readonly override: ToolConfirmationPolicy | null;
    } | null;
  };
  readonly lastError: {
    readonly code: SessionComposerControlError['code'];
    readonly message: string;
  } | null;
}

export interface SessionModelSwitchReceiptV1 {
  readonly receiptId: string;
  readonly fromModelId: string;
  readonly toModelId: string;
  readonly requestedEffort: EffortPreference;
  readonly compacted: boolean;
  readonly compactRequired: boolean;
  readonly compactPreflight: NonNullable<ModelSwitchResult['compactPreflight']> | 'deferred';
  readonly appliesFrom: 'immediate' | 'next-logical-request';
  readonly sessionPreferencesDigest: string;
}

export interface SessionPermissionReceiptV1 {
  readonly receiptId: string;
  readonly previous: SessionPermissionSelectionV1;
  readonly current: SessionPermissionSelectionV1;
  readonly appliesFrom: 'immediate' | 'next-tool-admission';
  readonly sessionPreferencesDigest: string;
}

export interface SessionComposerControlServiceOptionsV1 {
  readonly cwd: string;
  readonly config: OrionCodeCLIConfig;
  readonly store: Store;
  readonly llm: LLMService | null;
  readonly compactCoordinator: CompactCoordinator;
  readonly modelCoordinator?: ModelCoordinator;
  readonly getSession: () => SessionMeta | null;
  readonly ensureSession: () => SessionMeta;
  readonly projectToolConfirmation: () => ToolConfirmationPolicy;
  readonly applySessionState: (session: SessionMeta | null) => void;
  readonly rebindSessionRuntime: () => Promise<void>;
  readonly runtimeIdle: () => boolean;
}

export class SessionComposerControlError extends Error {
  constructor(
    readonly code:
      | 'runtime_busy'
      | 'model_unavailable'
      | 'model_effort_unsupported'
      | 'model_switch_rolled_back'
      | 'permission_override_rejected'
      | 'composer_control_conflict'
      | 'composer_recovery_required'
      | 'session_unavailable',
    message: string
  ) {
    super(message);
    this.name = 'SessionComposerControlError';
  }
}

/** Product-owned Session control service shared by slash commands and Web. */
export class SessionComposerControlServiceV1 {
  private pendingModel:
    | {
        readonly sessionId: string;
        readonly modelId: string;
        readonly effort: EffortPreference;
      }
    | undefined;
  private lastError:
    | {
        readonly sessionId: string;
        readonly code: SessionComposerControlError['code'];
        readonly message: string;
      }
    | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: SessionComposerControlServiceOptionsV1) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  describe(): SessionComposerRuntimeStateV1 {
    const session = this.options.getSession() ?? this.options.ensureSession();
    return this.project(session, true);
  }

  describeSession(session: SessionMeta): SessionComposerRuntimeStateV1 {
    return this.project(session, this.options.getSession()?.id === session.id);
  }

  catalog(): SessionModelCatalogV1 {
    const registry = this.options.config.modelRegistry;
    const profiles = registry?.enabledProfiles ?? [this.legacyProfile(this.options.config.model)];
    const models = Object.freeze(
      profiles.map(profile => {
        const provider = registry?.providers.get(profile.provider);
        return Object.freeze({
          id: profile.id,
          label: profile.displayName ?? profile.id,
          providerId: profile.provider,
          providerLabel: provider?.displayName ?? profile.provider,
          contextWindow: profile.resolvedContextWindow,
          maxOutputTokens: profile.resolvedMaxOutputTokens,
          reasoning: Boolean(profile.reasoningCapability),
          effortLevels: Object.freeze([...(profile.reasoningCapability?.supportedLevels ?? [])]),
          ...(profile.reasoningCapability?.defaultLevel
            ? { defaultEffort: profile.reasoningCapability.defaultLevel }
            : {}),
          aliases: Object.freeze([...(profile.aliases ?? [])]),
          fingerprint: profile.fingerprint,
        });
      })
    );
    const unavailableProviders = Object.freeze(
      registry
        ? [...registry.providers.values()]
            .filter(provider => !providerCredentialAvailable(provider.apiKey))
            .map(provider =>
              Object.freeze({
                id: provider.id,
                reason: 'The configured credential slot is unavailable.',
              })
            )
        : []
    );
    return Object.freeze({
      revision: digestRuntimeValue({ models, unavailableProviders }),
      models,
      unavailableProviders,
    });
  }

  async selectModel(input: {
    readonly modelId: string;
    readonly effort?: EffortPreference;
  }): Promise<SessionModelSwitchReceiptV1> {
    if (input.effort !== undefined && !isEffortPreference(input.effort)) {
      throw new SessionComposerControlError(
        'model_effort_unsupported',
        `Unsupported effort preference: ${String(input.effort)}`
      );
    }
    const session = this.options.getSession() ?? this.options.ensureSession();
    const before = projectSessionComposerPreferences(session);
    const profile = this.resolveProfile(input.modelId);
    const requestedEffort = input.effort ?? session.effortPreference ?? 'auto';
    const resolvedEffort = this.resolveEffort(profile, requestedEffort);
    if (requestedEffort !== 'auto' && !resolvedEffort.supported) {
      throw new SessionComposerControlError(
        'model_effort_unsupported',
        resolvedEffort.warning ?? `Effort ${requestedEffort} is unavailable for ${profile.id}.`
      );
    }
    if (!this.options.runtimeIdle()) {
      this.pendingModel = Object.freeze({
        sessionId: session.id,
        modelId: profile.id,
        effort: requestedEffort,
      });
      this.lastError = undefined;
      this.emitChanged();
      return Object.freeze({
        receiptId: randomUUID(),
        fromModelId: session.model,
        toModelId: profile.id,
        requestedEffort,
        compacted: false,
        compactRequired:
          profile.resolvedContextWindow < this.project(session, true).model.contextWindow,
        compactPreflight: 'deferred',
        appliesFrom: 'next-logical-request',
        sessionPreferencesDigest: digestRuntimeValue({
          current: projectSessionComposerPreferences(session),
          pending: this.pendingModel,
        }),
      });
    }
    this.pendingModel = undefined;

    const previousCoordinatorModel = this.options.modelCoordinator?.getCurrent()?.id;
    let persisted: SessionMeta | null = null;
    let switchResult: ModelSwitchResult = {
      success: true,
      compacted: false,
      compactRequired: false,
      compactPreflight: 'not_required',
    };
    const effortValue = requestedEffort === 'auto' ? undefined : requestedEffort;
    try {
      // Commit the cheap, CAS-protected Session metadata first. A semantic
      // compact is append-only and cannot be honestly "undone" after its
      // checkpoint is installed, so it must never run before this write can
      // succeed. Any later preflight failure rolls this metadata write back.
      persisted = updateSessionComposerPreferences(session.id, {
        expected: before,
        model: profile.id,
        effort: { value: effortValue },
      });
      if (!persisted) {
        throw new SessionComposerControlError(
          'session_unavailable',
          `Session ${session.id} is no longer available.`
        );
      }
      copySessionPreferences(session, persisted);
      if (this.options.modelCoordinator) {
        switchResult = await this.options.modelCoordinator.switchToWithCompactPreflight(
          profile.id,
          request => this.commitCompact(request)
        );
        if (!switchResult.success) {
          throw new SessionComposerControlError(
            'model_unavailable',
            switchResult.error ?? `Model ${profile.id} could not be selected.`
          );
        }
      }
      this.options.applySessionState(session);
    } catch (error) {
      let rollbackFailed = false;
      if (persisted) {
        try {
          const restored = updateSessionComposerPreferences(session.id, {
            expected: projectSessionComposerPreferences(persisted),
            model: before.model,
            effort: { value: before.effortPreference },
          });
          if (restored) copySessionPreferences(session, restored);
          else rollbackFailed = true;
        } catch {
          rollbackFailed = true;
        }
      }
      if (previousCoordinatorModel)
        this.options.modelCoordinator?.initModel(previousCoordinatorModel);
      if (error instanceof SessionComposerPreferencesConflictError) {
        const latest = loadSessionMeta(session.id);
        if (latest) copySessionPreferences(session, latest);
        else restoreSessionObject(session, before);
        this.options.applySessionState(session);
        return this.failControl(
          session.id,
          new SessionComposerControlError('composer_control_conflict', error.message)
        );
      }
      restoreSessionObject(session, before);
      this.options.applySessionState(session);
      if (rollbackFailed) {
        return this.failControl(
          session.id,
          new SessionComposerControlError(
            'composer_recovery_required',
            'Model selection failed and its durable Session metadata could not be rolled back.'
          )
        );
      }
      if (error instanceof SessionComposerControlError) {
        return this.failControl(session.id, error);
      }
      return this.failControl(
        session.id,
        new SessionComposerControlError(
          'model_switch_rolled_back',
          `Model switch was rolled back: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }

    const current = projectSessionComposerPreferences(session);
    this.lastError = undefined;
    this.emitChanged();
    return Object.freeze({
      receiptId: randomUUID(),
      fromModelId: before.model,
      toModelId: profile.id,
      requestedEffort,
      compacted: switchResult.compacted === true,
      compactRequired: switchResult.compactRequired === true,
      compactPreflight: switchResult.compactPreflight ?? 'not_required',
      appliesFrom: 'immediate',
      sessionPreferencesDigest: digestRuntimeValue(current),
    });
  }

  async setEffort(effort: EffortPreference): Promise<SessionModelSwitchReceiptV1> {
    const session = this.options.getSession() ?? this.options.ensureSession();
    return this.selectModel({ modelId: session.model, effort });
  }

  async setPermissionOverride(
    override: ToolConfirmationPolicy | null
  ): Promise<SessionPermissionReceiptV1> {
    if (override !== null && !['ask', 'allow', 'deny'].includes(override)) {
      throw new SessionComposerControlError(
        'permission_override_rejected',
        `Unsupported tool confirmation policy: ${String(override)}`
      );
    }
    const session = this.options.getSession() ?? this.options.ensureSession();
    const previousState = this.project(session, true).permission;
    const idle = this.options.runtimeIdle();
    const before = projectSessionComposerPreferences(session);
    let persisted: SessionMeta | null = null;
    try {
      persisted = updateSessionComposerPreferences(session.id, {
        expected: before,
        permission: { value: override ?? undefined },
      });
      if (!persisted) {
        throw new SessionComposerControlError(
          'session_unavailable',
          `Session ${session.id} is no longer available.`
        );
      }
      copySessionPreferences(session, persisted);
      this.options.applySessionState(session);
      if (idle) await this.options.rebindSessionRuntime();
    } catch (error) {
      let rollbackFailed = false;
      if (persisted) {
        const applied = projectSessionComposerPreferences(persisted);
        try {
          const restored = updateSessionComposerPreferences(session.id, {
            expected: applied,
            permission: { value: before.toolConfirmationOverride },
          });
          if (restored) copySessionPreferences(session, restored);
          else rollbackFailed = true;
        } catch {
          rollbackFailed = true;
        }
      }
      if (error instanceof SessionComposerPreferencesConflictError) {
        const latest = loadSessionMeta(session.id);
        if (latest) copySessionPreferences(session, latest);
        else restoreSessionObject(session, before);
        this.options.applySessionState(session);
        if (idle) await this.options.rebindSessionRuntime().catch(() => undefined);
        return this.failControl(
          session.id,
          new SessionComposerControlError('composer_control_conflict', error.message)
        );
      }
      restoreSessionObject(session, before);
      this.options.applySessionState(session);
      if (idle) await this.options.rebindSessionRuntime().catch(() => undefined);
      if (rollbackFailed) {
        return this.failControl(
          session.id,
          new SessionComposerControlError(
            'composer_recovery_required',
            'Permission selection failed and its durable Session metadata could not be rolled back.'
          )
        );
      }
      if (error instanceof SessionComposerControlError) {
        return this.failControl(session.id, error);
      }
      return this.failControl(
        session.id,
        new SessionComposerControlError(
          'permission_override_rejected',
          `Permission override was rolled back: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }

    const currentState = this.project(session, true).permission;
    const current = projectSessionComposerPreferences(session);
    this.lastError = undefined;
    this.emitChanged();
    return Object.freeze({
      receiptId: randomUUID(),
      previous: previousState,
      current: currentState,
      appliesFrom: idle ? 'immediate' : 'next-tool-admission',
      sessionPreferencesDigest: digestRuntimeValue(current),
    });
  }

  /** Apply controls queued during an active turn before the next logical request starts. */
  async applyPendingAtLogicalBoundary(): Promise<void> {
    if (!this.options.runtimeIdle()) return;
    const session = this.options.getSession();
    if (!session) {
      this.pendingModel = undefined;
      this.emitChanged();
      return;
    }
    const pendingModel =
      this.pendingModel?.sessionId === session.id ? this.pendingModel : undefined;
    this.pendingModel = undefined;
    this.emitChanged();
    try {
      if (pendingModel) {
        await this.selectModel({ modelId: pendingModel.modelId, effort: pendingModel.effort });
      }
    } catch (error) {
      const normalized =
        error instanceof SessionComposerControlError
          ? error
          : new SessionComposerControlError(
              'composer_recovery_required',
              error instanceof Error ? error.message : String(error)
            );
      return this.failControl(session.id, normalized);
    }
  }

  private project(session: SessionMeta, active: boolean): SessionComposerRuntimeStateV1 {
    const profile = this.resolveProfile(session.model);
    const effort = this.resolveEffort(profile, session.effortPreference ?? 'auto');
    const provider = this.options.config.modelRegistry?.providers.get(profile.provider);
    const projectDefault = this.options.projectToolConfirmation();
    const observedUsage = this.options.store.getSnapshot().contextUsage;
    const contextUsage =
      active &&
      observedUsage &&
      (observedUsage.modelId === profile.id || observedUsage.modelId === profile.model)
        ? observedUsage
        : null;
    return Object.freeze({
      sessionId: session.id,
      model: Object.freeze({
        modelId: profile.id,
        providerId: profile.provider || null,
        providerLabel: provider?.displayName ?? profile.provider ?? null,
        contextWindow: profile.resolvedContextWindow,
        maxOutputTokens: profile.resolvedMaxOutputTokens,
        effort: Object.freeze({
          requested: effort.requested,
          effective: effort.effective ?? null,
          source: effort.source,
          supported: effort.supported,
          supportedLevels: Object.freeze([...effort.supportedLevels]),
          ...(effort.warning ? { warning: effort.warning } : {}),
        }),
      }),
      permission: Object.freeze({
        effective: session.toolConfirmationOverride ?? projectDefault,
        override: session.toolConfirmationOverride ?? null,
        projectDefault,
        source: session.toolConfirmationOverride === undefined ? 'project' : 'session',
      }),
      contextUsage,
      pending: Object.freeze({
        model:
          active && this.pendingModel?.sessionId === session.id
            ? Object.freeze({
                modelId: this.pendingModel.modelId,
                effort: this.pendingModel.effort,
              })
            : null,
        permission: null,
      }),
      lastError:
        active && this.lastError?.sessionId === session.id
          ? Object.freeze({ code: this.lastError.code, message: this.lastError.message })
          : null,
    });
  }

  private resolveProfile(selector: string): ResolvedModelProfile {
    const registry = this.options.config.modelRegistry;
    const profile = registry
      ? lookupProfile(registry, selector)
      : selector === this.options.config.model || selector === this.options.getSession()?.model
        ? this.legacyProfile(selector)
        : undefined;
    if (!profile) {
      throw new SessionComposerControlError(
        'model_unavailable',
        `Model ${selector} is not enabled in the configured registry.`
      );
    }
    return profile;
  }

  private legacyProfile(modelId: string): ResolvedModelProfile {
    return resolveModelProfile(
      {
        id: modelId,
        model: modelId,
        provider: 'legacy',
        enabled: true,
      },
      {
        id: 'legacy',
        baseUrl: this.options.config.apiBaseUrl ?? 'https://legacy.invalid',
        apiKey: '',
        protocol: 'openai-completions',
        displayName: 'Legacy provider',
      }
    );
  }

  private resolveEffort(
    profile: ResolvedModelProfile,
    requested: EffortPreference
  ): ResolvedEffort {
    return resolveProfileEffort(profile, {
      session: requested,
      project: getProjectConfig(this.options.cwd).defaultEffort,
      global: loadGlobalConfig().defaultEffort ?? this.options.config.defaultEffort,
    });
  }

  private emitChanged(): void {
    for (const listener of this.listeners) listener();
  }

  private failControl(sessionId: string, error: SessionComposerControlError): never {
    this.lastError = Object.freeze({
      sessionId,
      code: error.code,
      message: error.message,
    });
    this.emitChanged();
    throw error;
  }

  private async commitCompact(
    request: ModelSwitchCompactPreflightRequest
  ): Promise<ModelSwitchCompactPreflightReceipt> {
    const history = this.options.store.getSnapshot().conversationHistory;
    const currentTokens = estimateMessagesTokens(history);
    if (currentTokens <= request.safeInputBudget) {
      return { status: 'not_needed', currentTokens };
    }
    const session = this.options.getSession() ?? this.options.ensureSession();
    const prepareSource = prepareSessionCompactSourceReceipt(session.id);
    const result = await compactMessages(history, {
      maxMessages: 20,
      contextCapsule: this.options.store.getSnapshot().harnessState?.capsule,
      harnessState: this.options.store.getSnapshot().harnessState,
      llm: this.options.llm ?? undefined,
      compactMode: 'manual',
      safeInputBudget: request.safeInputBudget,
      targetRatio: 0.65,
    });
    if (result.afterTokens > request.targetTokens) {
      return {
        status: 'rejected',
        error: `Compact candidate uses ${result.afterTokens} tokens; target is ${request.targetTokens}.`,
      };
    }
    const afterUsage = {
      ...createContextUsageSnapshot({
        modelId: request.to.id,
        usedTokens: result.afterTokens,
        source: 'estimated',
        outputReserveTokens: request.to.resolvedMaxOutputTokens,
      }),
      contextWindow: request.to.resolvedContextWindow,
      safeInputBudget: request.safeInputBudget,
      percent: Math.min(100, Math.floor((result.afterTokens / request.safeInputBudget) * 100)),
      rawPercent: Math.min(
        100,
        Math.floor((result.afterTokens / request.to.resolvedContextWindow) * 100)
      ),
    };
    const traceTurnId = 'composer:model-switch';
    const traceDetails = {
      model: request.to.id,
      compactMode: 'manual' as const,
      compactStrategy: 'model-switch-semantic-v2',
      compactCandidateFingerprint: result.fingerprint,
      compactBeforeTokens: result.beforeTokens,
      compactAfterTokens: result.afterTokens,
      compactTargetTokens: result.plan.targetTokens,
      compactTargetRatio: result.plan.targetRatio,
      compactDiagnosticsCount: result.diagnostics.length,
      compactSourceMessageCount: prepareSource.sourceMessageCount,
    };
    appendSessionTraceEvent(session.id, {
      turnId: traceTurnId,
      type: 'compact_prepare',
      ...traceDetails,
    });
    const checkpoint = commitSessionCompactCheckpoint({
      sessionId: session.id,
      mode: 'manual',
      modelId: request.to.id,
      sourceMessageCount: prepareSource.sourceMessageCount,
      transcriptStartMessageIndex: Math.max(0, prepareSource.sourceMessageCount - 20),
      modelHistory: result.messages,
      summary: {
        text: result.summary,
        generatedAt: result.summaryGeneratedAt,
        source: result.summarySource,
      },
      beforeUsage: createContextUsageSnapshot({
        modelId: request.from.id,
        usedTokens: currentTokens,
        source: 'estimated',
        outputReserveTokens: request.from.resolvedMaxOutputTokens,
      }),
      afterUsage,
      strategy: 'model-switch-semantic-v2',
      harnessState: this.options.store.getSnapshot().harnessState,
      prepareSource,
      candidate: {
        fingerprint: result.fingerprint,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        plan: result.plan,
        semanticSummary: result.semanticSummary,
        diagnostics: result.diagnostics,
      },
    });
    for (const type of [
      'compact_validate',
      'compact_commit',
      'compact_boundary',
      'compact_completed',
    ] as const) {
      appendSessionTraceEvent(session.id, {
        turnId: traceTurnId,
        type,
        checkpointId: checkpoint.checkpointId,
        success: true,
        ...traceDetails,
      });
    }
    this.options.store.setState({ conversationHistory: checkpoint.modelHistory });
    this.options.store.setContextUsage(afterUsage);
    return {
      status: 'committed',
      afterTokens: checkpoint.candidateReceipt.afterTokens,
      candidateFingerprint: checkpoint.candidateReceipt.candidateFingerprint,
    };
  }
}

function copySessionPreferences(target: SessionMeta, source: SessionMeta): void {
  target.model = source.model;
  target.updatedAt = source.updatedAt;
  target.updatedAtIso = source.updatedAtIso;
  if (source.effortPreference === undefined) delete target.effortPreference;
  else target.effortPreference = source.effortPreference;
  if (source.toolConfirmationOverride === undefined) delete target.toolConfirmationOverride;
  else target.toolConfirmationOverride = source.toolConfirmationOverride;
}

function restoreSessionObject(target: SessionMeta, source: SessionComposerPreferencesV1): void {
  target.model = source.model;
  if (source.effortPreference === undefined) delete target.effortPreference;
  else target.effortPreference = source.effortPreference;
  if (source.toolConfirmationOverride === undefined) delete target.toolConfirmationOverride;
  else target.toolConfirmationOverride = source.toolConfirmationOverride;
}

function providerCredentialAvailable(apiKey: string): boolean {
  if (!apiKey.trim()) return false;
  if (!apiKey.startsWith('$')) return true;
  return Boolean(process.env[apiKey.slice(1)]?.trim());
}
