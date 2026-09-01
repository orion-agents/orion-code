/** Product-level coordinator for durable Settings reads and mutations. */

import { createHash } from 'crypto';
import { spawn } from 'child_process';
import type { EffortPreference } from './effort';
import type { ToolConfirmationPolicy } from './global-config';
import {
  SettingsDocumentRepository,
  SettingsDocumentRepositoryError,
  type SettingsDocumentRepositoryOptions,
  type SettingsKeyV1,
  type SettingsOperationV1,
  type SettingsRepositoryInvalidationV1,
  type SettingsRepositorySnapshotV1,
  validateSettingsOperationsV1,
} from './settings-document-repository';

export type { SettingsKeyV1, SettingsOperationV1 } from './settings-document-repository';

export type SettingsSourceV1 = 'internal' | 'model' | 'global' | 'project' | 'session';
export type SettingsScopeV1 = 'global' | 'project' | 'session';
export type SettingsAppliesV1 = 'live' | 'next-logical-request' | 'new-session' | 'restart';
export type SettingsStateV1 = 'ready' | 'invalid' | 'read-only' | 'unavailable';
export type SettingsThemeV1 = 'system' | 'light' | 'dark';
export type SettingsMotionV1 = 'system' | 'reduced';

export interface SettingsFieldViewV1<T> {
  readonly effectiveValue: T;
  readonly explicitValue?: T;
  readonly inheritedValue?: T;
  readonly source: SettingsSourceV1;
  readonly scope: SettingsScopeV1;
  readonly applies: SettingsAppliesV1;
  readonly overridden: boolean;
  readonly writable: boolean;
  readonly blockedReason?: 'runtime_busy' | 'read_only' | 'invalid_document';
}

export interface SettingsModelSummaryV1 {
  readonly id: string;
  readonly label: string;
  readonly provider?: string;
}

export interface SettingsCredentialSlotViewV1 {
  readonly providerId: string;
  readonly state: 'ready' | 'missing' | 'unavailable';
  readonly source: 'environment' | 'legacy' | 'none';
  readonly writable: false;
}

export interface SettingsCurrentSessionV1 {
  readonly model: string;
  readonly effort: EffortPreference;
  readonly overridesProjectEffort: boolean;
}

/** Secret-free settings description suitable for direct Web protocol projection. */
export interface SettingsDocumentViewV1 {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly state: SettingsStateV1;
  readonly writable: boolean;
  readonly hasDocument: boolean;
  readonly workspace: string;
  readonly sections: {
    readonly appearance: {
      readonly theme: SettingsFieldViewV1<SettingsThemeV1>;
      readonly motion: SettingsFieldViewV1<SettingsMotionV1>;
    };
    readonly defaults: {
      readonly model: SettingsFieldViewV1<string>;
      readonly effort: SettingsFieldViewV1<EffortPreference>;
    };
    readonly permissions: {
      readonly toolConfirmation: SettingsFieldViewV1<ToolConfirmationPolicy>;
    };
  };
  readonly models: readonly SettingsModelSummaryV1[];
  readonly credentials: readonly SettingsCredentialSlotViewV1[];
  readonly currentSession?: SettingsCurrentSessionV1;
  readonly diagnostic?: { readonly code: string; readonly message: string };
}

export interface SettingsInvalidationV1 {
  readonly revision: string;
  readonly reason: 'local-write' | 'external-edit' | 'workspace-change';
  readonly state: 'ready' | 'invalid';
}

export interface SettingsRuntimeStateV1 {
  readonly busy?: boolean;
}

export interface SettingsDescribeInputV1 {
  readonly currentSession?: SettingsCurrentSessionV1;
  readonly runtime?: SettingsRuntimeStateV1;
}

export interface SettingsUpdateContextV1 {
  readonly before: SettingsDocumentViewV1;
  readonly document: SettingsDocumentViewV1;
  readonly operations: readonly SettingsOperationV1[];
}

export interface SettingsUpdateInputV1 extends SettingsDescribeInputV1 {
  readonly requestId?: string;
  readonly expectedRevision: string;
  readonly operations: readonly SettingsOperationV1[];
  /** Side-effect-free runtime validation performed before persistence. */
  readonly runtimePrepare?: (
    context: Omit<SettingsUpdateContextV1, 'document'>
  ) => void | Promise<void>;
  /** Runtime transition applied only after the durable write commits. */
  readonly runtimeApply?: (context: SettingsUpdateContextV1) => void | Promise<void>;
}

export interface SettingsUpdateResultV1 {
  readonly revision: string;
  readonly appliedKeys: readonly SettingsKeyV1[];
  readonly document: SettingsDocumentViewV1;
}

export interface SettingsCoordinatorCreateOptionsV1 {
  readonly workspace: string;
  readonly onInvalidated?: (event: SettingsInvalidationV1) => void;
  readonly repository?: SettingsDocumentRepository;
  readonly repositoryOptions?: SettingsDocumentRepositoryOptions;
  readonly models?: readonly SettingsModelSummaryV1[];
  readonly credentials?: readonly SettingsCredentialSlotViewV1[];
  readonly internalDefaultModel?: string;
  readonly modelDefaultEffort?: EffortPreference;
  readonly internalToolConfirmation?: ToolConfirmationPolicy;
  readonly readOnly?: boolean;
  /** Bound product Runtime hooks shared by Web, TUI, and commands. */
  readonly runtimeIdle?: () => boolean | Promise<boolean>;
  readonly runtimePrepare?: (
    context: Omit<SettingsUpdateContextV1, 'document'>
  ) => void | Promise<void>;
  readonly runtimeApply?: (context: SettingsUpdateContextV1) => void | Promise<void>;
  /** Injectable only for tests/product shell integration; callers never pass a path. */
  readonly documentOpener?: (documentPath: string) => void | Promise<void>;
}

interface IdempotencyEntry {
  readonly digest: string;
  readonly result: Promise<SettingsUpdateResultV1>;
  settled: boolean;
}

interface ControlledSettingsState {
  readonly theme?: SettingsThemeV1;
  readonly motion?: SettingsMotionV1;
  readonly defaultModel?: string;
  readonly projectEffort?: EffortPreference;
  readonly globalEffort?: EffortPreference;
  readonly toolConfirmation?: ToolConfirmationPolicy;
}

const MAX_IDEMPOTENCY_ENTRIES = 256;

export class SettingsCoordinatorError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code
  ) {
    super(message);
    this.name = 'SettingsCoordinatorError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function cloneFrozen<T>(value: T): Readonly<T> {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as T);
}

function getRecord(
  parent: Readonly<Record<string, unknown>>,
  key: string
): Record<string, unknown> {
  const value = parent[key];
  return isRecord(value) ? value : {};
}

function getString(parent: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = parent[key];
  return typeof value === 'string' ? value : undefined;
}

function fieldBlockedReason(
  state: SettingsStateV1,
  runtimeBusy: boolean
): SettingsFieldViewV1<unknown>['blockedReason'] | undefined {
  if (state === 'invalid') return 'invalid_document';
  if (state === 'read-only' || state === 'unavailable') return 'read_only';
  if (runtimeBusy) return 'runtime_busy';
  return undefined;
}

function controlledState(
  snapshot: SettingsRepositorySnapshotV1,
  workspace: string
): ControlledSettingsState {
  const document = snapshot.document;
  const appearance = getRecord(getRecord(document, 'web'), 'appearance');
  const project = getRecord(getRecord(document, 'projects'), workspace);
  return Object.freeze({
    ...(getString(appearance, 'theme')
      ? { theme: getString(appearance, 'theme') as SettingsThemeV1 }
      : {}),
    ...(getString(appearance, 'motion')
      ? { motion: getString(appearance, 'motion') as SettingsMotionV1 }
      : {}),
    ...(getString(document, 'defaultModel')
      ? { defaultModel: getString(document, 'defaultModel') }
      : {}),
    ...(getString(project, 'defaultEffort')
      ? { projectEffort: getString(project, 'defaultEffort') as EffortPreference }
      : {}),
    ...(getString(document, 'defaultEffort')
      ? { globalEffort: getString(document, 'defaultEffort') as EffortPreference }
      : {}),
    ...(getString(document, 'toolConfirmation')
      ? {
          toolConfirmation: getString(document, 'toolConfirmation') as ToolConfirmationPolicy,
        }
      : {}),
  });
}

function controlledDiff(
  before: ControlledSettingsState,
  after: ControlledSettingsState
): readonly SettingsOperationV1[] {
  const operations: SettingsOperationV1[] = [];
  if (before.theme !== after.theme) {
    operations.push(
      after.theme
        ? { op: 'set', key: 'appearance.theme', value: after.theme }
        : { op: 'unset', key: 'appearance.theme' }
    );
  }
  if (before.motion !== after.motion) {
    operations.push(
      after.motion
        ? { op: 'set', key: 'appearance.motion', value: after.motion }
        : { op: 'unset', key: 'appearance.motion' }
    );
  }
  if (before.defaultModel !== after.defaultModel) {
    operations.push(
      after.defaultModel
        ? { op: 'set', key: 'defaults.model', value: after.defaultModel }
        : { op: 'unset', key: 'defaults.model' }
    );
  }
  if (before.projectEffort !== after.projectEffort) {
    operations.push(
      after.projectEffort
        ? { op: 'set', key: 'defaults.effort', value: after.projectEffort }
        : { op: 'unset', key: 'defaults.effort' }
    );
  }
  if (before.globalEffort !== after.globalEffort) {
    operations.push(
      after.globalEffort
        ? { op: 'set', key: 'defaults.globalEffort', value: after.globalEffort }
        : { op: 'unset', key: 'defaults.globalEffort' }
    );
  }
  if (before.toolConfirmation !== after.toolConfirmation) {
    operations.push(
      after.toolConfirmation
        ? {
            op: 'set',
            key: 'permissions.toolConfirmation',
            value: after.toolConfirmation,
          }
        : { op: 'unset', key: 'permissions.toolConfirmation' }
    );
  }
  return Object.freeze(operations.map(operation => Object.freeze(operation)));
}

function isRuntimeSensitive(operations: readonly SettingsOperationV1[]): boolean {
  return operations.some(
    operation =>
      operation.key === 'defaults.effort' ||
      operation.key === 'defaults.globalEffort' ||
      operation.key === 'permissions.toolConfirmation'
  );
}

function mapRepositoryError(error: unknown): SettingsCoordinatorError {
  if (error instanceof SettingsCoordinatorError) return error;
  if (error instanceof SettingsDocumentRepositoryError) {
    const status =
      error.code === 'settings_invalid_operation'
        ? 400
        : error.code === 'settings_revision_conflict'
          ? 409
          : error.code === 'settings_rejected'
            ? 422
            : 503;
    return new SettingsCoordinatorError(status, error.code, error.message);
  }
  return new SettingsCoordinatorError(422, 'settings_rejected', 'The settings update failed.');
}

function defaultDocumentOpener(documentPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const command =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', documentPath] : [documentPath];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Single in-process write coordinator. Cross-process correctness remains in
 * SettingsDocumentRepository's lock-protected reread and CAS.
 */
export class SettingsCoordinatorV1 {
  private readonly workspace: string;
  private readonly repository: SettingsDocumentRepository;
  private readonly onInvalidated?: (event: SettingsInvalidationV1) => void;
  private readonly configuredModels?: readonly SettingsModelSummaryV1[];
  private readonly configuredCredentials?: readonly SettingsCredentialSlotViewV1[];
  private readonly internalDefaultModel: string;
  private readonly modelDefaultEffort: EffortPreference;
  private readonly internalToolConfirmation: ToolConfirmationPolicy;
  private readonly readOnly: boolean;
  private readonly documentOpener: (documentPath: string) => void | Promise<void>;
  private readonly runtimeIdle?: () => boolean | Promise<boolean>;
  private readonly runtimePrepare?: SettingsCoordinatorCreateOptionsV1['runtimePrepare'];
  private readonly runtimeApply?: SettingsCoordinatorCreateOptionsV1['runtimeApply'];
  private readonly stopWatching: () => void;
  private queue: Promise<void> = Promise.resolve();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private recoveryRequired = false;
  private externalRecoveryRequired = false;
  private externalSyncPending = false;
  private externalSyncScheduled = false;
  private lastAppliedSnapshot: SettingsRepositorySnapshotV1;
  private closed = false;

  private constructor(options: SettingsCoordinatorCreateOptionsV1) {
    this.workspace = options.workspace;
    this.repository =
      options.repository ?? SettingsDocumentRepository.create(options.repositoryOptions);
    this.onInvalidated = options.onInvalidated;
    this.configuredModels = options.models ? cloneFrozen(options.models) : undefined;
    this.configuredCredentials = options.credentials ? cloneFrozen(options.credentials) : undefined;
    this.internalDefaultModel = options.internalDefaultModel ?? 'gpt-4o';
    this.modelDefaultEffort = options.modelDefaultEffort ?? 'auto';
    this.internalToolConfirmation = options.internalToolConfirmation ?? 'allow';
    this.readOnly = options.readOnly ?? false;
    this.documentOpener = options.documentOpener ?? defaultDocumentOpener;
    this.runtimeIdle = options.runtimeIdle;
    this.runtimePrepare = options.runtimePrepare;
    this.runtimeApply = options.runtimeApply;

    // Establish last-good before installing the watcher, then close the
    // read-before-watch race inside repository.watch().
    this.lastAppliedSnapshot = this.repository.read();
    this.stopWatching = this.repository.watch(event => this.forwardExternalInvalidation(event));
  }

  static create(options: SettingsCoordinatorCreateOptionsV1): SettingsCoordinatorV1 {
    return new SettingsCoordinatorV1(options);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new SettingsCoordinatorError(
        503,
        'settings_document_unavailable',
        'The settings coordinator is closed.'
      );
    }
  }

  private forwardExternalInvalidation(event: SettingsRepositoryInvalidationV1): void {
    this.emitInvalidation(event);
    if (event.state === 'invalid') {
      this.externalSyncPending = false;
      this.externalRecoveryRequired = false;
      return;
    }
    this.externalSyncPending = true;
    this.scheduleExternalSynchronization();
  }

  private scheduleExternalSynchronization(): void {
    if (this.closed || this.recoveryRequired || this.externalSyncScheduled) return;
    this.externalSyncScheduled = true;
    void this.enqueue(async () => {
      this.externalSyncScheduled = false;
      await this.synchronizeExternalChangesInQueue(false);
    }).catch(() => undefined);
  }

  private emitInvalidation(event: SettingsInvalidationV1): void {
    try {
      this.onInvalidated?.(Object.freeze({ ...event }));
    } catch {
      // Invalidation is advisory; observers cannot poison durable state.
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private deriveModels(
    document: Readonly<Record<string, unknown>>
  ): readonly SettingsModelSummaryV1[] {
    if (this.configuredModels) return this.configuredModels;
    const models = document.models;
    if (!Array.isArray(models)) return Object.freeze([]);
    return Object.freeze(
      models.flatMap(model => {
        if (!isRecord(model) || typeof model.id !== 'string') return [];
        return [
          Object.freeze({
            id: model.id,
            label: typeof model.displayName === 'string' ? model.displayName : model.id,
            ...(typeof model.provider === 'string' ? { provider: model.provider } : {}),
          }),
        ];
      })
    );
  }

  private deriveCredentials(
    document: Readonly<Record<string, unknown>>
  ): readonly SettingsCredentialSlotViewV1[] {
    if (this.configuredCredentials) return this.configuredCredentials;
    const providers = document.providers;
    if (!Array.isArray(providers)) return Object.freeze([]);
    const result: SettingsCredentialSlotViewV1[] = [];
    for (const provider of providers) {
      if (!isRecord(provider) || typeof provider.id !== 'string') continue;
      const apiKey = typeof provider.apiKey === 'string' ? provider.apiKey : '';
      if (apiKey.startsWith('$')) {
        const environmentName = apiKey.slice(1);
        result.push(
          Object.freeze({
            providerId: provider.id,
            state: environmentName && process.env[environmentName] ? 'ready' : 'missing',
            source: 'environment',
            writable: false,
          })
        );
      } else {
        result.push(
          Object.freeze({
            providerId: provider.id,
            state: apiKey ? 'ready' : 'missing',
            source: apiKey ? 'legacy' : 'none',
            writable: false,
          })
        );
      }
    }
    return Object.freeze(result);
  }

  private buildView(
    snapshot: SettingsRepositorySnapshotV1,
    input: SettingsDescribeInputV1 = {}
  ): SettingsDocumentViewV1 {
    const document = snapshot.document;
    const web = getRecord(document, 'web');
    const appearance = getRecord(web, 'appearance');
    const projects = getRecord(document, 'projects');
    const project = getRecord(projects, this.workspace);
    const explicitTheme = getString(appearance, 'theme') as SettingsThemeV1 | undefined;
    const explicitMotion = getString(appearance, 'motion') as SettingsMotionV1 | undefined;
    const explicitModel = getString(document, 'defaultModel');
    const projectEffort = getString(project, 'defaultEffort') as EffortPreference | undefined;
    const globalEffort = getString(document, 'defaultEffort') as EffortPreference | undefined;
    const explicitToolConfirmation = getString(document, 'toolConfirmation') as
      | ToolConfirmationPolicy
      | undefined;
    const runtimeBusy = input.runtime?.busy === true;
    const recoveryRequired = this.recoveryRequired || this.externalRecoveryRequired;
    const storageWritable =
      !this.readOnly && !recoveryRequired && this.repository.isWritable(snapshot);
    const state: SettingsStateV1 = recoveryRequired
      ? 'unavailable'
      : snapshot.state === 'invalid'
        ? 'invalid'
        : snapshot.state === 'unavailable'
          ? 'unavailable'
          : storageWritable
            ? 'ready'
            : 'read-only';
    const generalBlocked = fieldBlockedReason(state, false);
    const runtimeBlocked = fieldBlockedReason(state, runtimeBusy);

    const effortInherited = globalEffort ?? this.modelDefaultEffort;
    const effortSource: SettingsSourceV1 = projectEffort
      ? 'project'
      : globalEffort
        ? 'global'
        : 'model';
    const currentSession = input.currentSession
      ? (Object.freeze({ ...input.currentSession }) as SettingsCurrentSessionV1)
      : undefined;
    const diagnostic = recoveryRequired
      ? Object.freeze({
          code: 'settings_recovery_required',
          message: 'Settings recovery is required before additional updates.',
        })
      : snapshot.diagnostic;

    return deepFreeze({
      schemaVersion: 1 as const,
      revision: snapshot.revision,
      state,
      writable: storageWritable,
      hasDocument: snapshot.hasDocument,
      workspace: this.workspace,
      sections: {
        appearance: {
          theme: {
            effectiveValue: explicitTheme ?? 'system',
            ...(explicitTheme
              ? { explicitValue: explicitTheme }
              : { inheritedValue: 'system' as const }),
            source: explicitTheme ? ('global' as const) : ('internal' as const),
            scope: 'global' as const,
            applies: 'live' as const,
            overridden: false,
            writable: storageWritable,
            ...(generalBlocked ? { blockedReason: generalBlocked } : {}),
          },
          motion: {
            effectiveValue: explicitMotion ?? 'system',
            ...(explicitMotion
              ? { explicitValue: explicitMotion }
              : { inheritedValue: 'system' as const }),
            source: explicitMotion ? ('global' as const) : ('internal' as const),
            scope: 'global' as const,
            applies: 'live' as const,
            overridden: false,
            writable: storageWritable,
            ...(generalBlocked ? { blockedReason: generalBlocked } : {}),
          },
        },
        defaults: {
          model: {
            effectiveValue: explicitModel ?? this.internalDefaultModel,
            ...(explicitModel
              ? { explicitValue: explicitModel }
              : { inheritedValue: this.internalDefaultModel }),
            source: explicitModel ? ('global' as const) : ('internal' as const),
            scope: 'global' as const,
            applies: 'new-session' as const,
            overridden: Boolean(
              currentSession &&
              currentSession.model !== (explicitModel ?? this.internalDefaultModel)
            ),
            writable: storageWritable,
            ...(generalBlocked ? { blockedReason: generalBlocked } : {}),
          },
          effort: {
            effectiveValue: projectEffort ?? effortInherited,
            ...(projectEffort
              ? { explicitValue: projectEffort, inheritedValue: effortInherited }
              : { inheritedValue: effortInherited }),
            source: effortSource,
            scope: 'project' as const,
            applies: 'next-logical-request' as const,
            overridden: currentSession?.overridesProjectEffort ?? false,
            writable: storageWritable && !runtimeBusy,
            ...(runtimeBlocked ? { blockedReason: runtimeBlocked } : {}),
          },
        },
        permissions: {
          toolConfirmation: {
            effectiveValue: explicitToolConfirmation ?? this.internalToolConfirmation,
            ...(explicitToolConfirmation
              ? { explicitValue: explicitToolConfirmation }
              : { inheritedValue: this.internalToolConfirmation }),
            source: explicitToolConfirmation ? ('global' as const) : ('internal' as const),
            scope: 'global' as const,
            applies: 'next-logical-request' as const,
            overridden: false,
            writable: storageWritable && !runtimeBusy,
            ...(runtimeBlocked ? { blockedReason: runtimeBlocked } : {}),
          },
        },
      },
      models: this.deriveModels(document),
      credentials: this.deriveCredentials(document),
      ...(currentSession ? { currentSession } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    }) as SettingsDocumentViewV1;
  }

  describe(input: SettingsDescribeInputV1 = {}): SettingsDocumentViewV1 {
    this.assertOpen();
    return this.buildView(this.repository.read(), input);
  }

  hasPendingExternalChanges(): boolean {
    return this.externalSyncPending;
  }

  /**
   * Reconcile the latest valid external bytes into Runtime state. Callers
   * should await this before starting a logical request or transition.
   */
  synchronizeExternalChanges(input: SettingsDescribeInputV1 = {}): Promise<SettingsDocumentViewV1> {
    this.assertOpen();
    return this.enqueue(async () => {
      await this.synchronizeExternalChangesInQueue(true);
      return this.describe(input);
    });
  }

  private async synchronizeExternalChangesInQueue(throwOnBlocked: boolean): Promise<void> {
    if (this.recoveryRequired) {
      if (throwOnBlocked) {
        throw new SettingsCoordinatorError(
          503,
          'settings_recovery_required',
          'Settings recovery is required before synchronizing external changes.'
        );
      }
      return;
    }

    const latest = this.repository.read();
    if (latest.state !== 'ready') {
      this.externalSyncPending = false;
      return;
    }
    if (latest.revision === this.lastAppliedSnapshot.revision) {
      this.externalSyncPending = false;
      this.externalRecoveryRequired = false;
      return;
    }
    this.externalSyncPending = true;

    const operations = controlledDiff(
      controlledState(this.lastAppliedSnapshot, this.workspace),
      controlledState(latest, this.workspace)
    );
    if (operations.length === 0) {
      this.lastAppliedSnapshot = latest;
      this.externalSyncPending = false;
      this.externalRecoveryRequired = false;
      return;
    }
    if (isRuntimeSensitive(operations) && this.runtimeIdle && !(await this.runtimeIdle())) {
      this.externalSyncPending = true;
      if (throwOnBlocked) {
        throw new SettingsCoordinatorError(409, 'runtime_busy', 'The runtime is busy.');
      }
      return;
    }

    const before = this.buildView(this.lastAppliedSnapshot);
    const document = this.buildView(latest);
    try {
      await this.runtimePrepare?.({ before, operations });
      await this.runtimeApply?.({ before, document, operations });
    } catch {
      this.externalSyncPending = false;
      this.externalRecoveryRequired = true;
      this.emitInvalidation({
        revision: latest.revision,
        reason: 'external-edit',
        state: 'invalid',
      });
      if (throwOnBlocked) {
        throw new SettingsCoordinatorError(
          503,
          'settings_recovery_required',
          'The external settings document could not be applied to the runtime.'
        );
      }
      return;
    }
    this.lastAppliedSnapshot = latest;
    this.externalSyncPending = false;
    this.externalRecoveryRequired = false;
  }

  private requestDigest(input: SettingsUpdateInputV1): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          expectedRevision: input.expectedRevision,
          operations: input.operations,
        })
      )
      .digest('hex');
  }

  update(input: SettingsUpdateInputV1): Promise<SettingsUpdateResultV1> {
    this.assertOpen();
    if (input.requestId) {
      const digest = this.requestDigest(input);
      const existing = this.idempotency.get(input.requestId);
      if (existing) {
        if (existing.digest !== digest) {
          return Promise.reject(
            new SettingsCoordinatorError(
              409,
              'request_id_conflict',
              'The request id was already used for a different settings update.'
            )
          );
        }
        return existing.result;
      }
      const result = this.enqueue(() => this.performUpdate(input));
      const entry: IdempotencyEntry = { digest, result, settled: false };
      this.idempotency.set(input.requestId, entry);
      result.then(
        () => {
          entry.settled = true;
          this.trimIdempotencyCache();
        },
        () => {
          if (this.idempotency.get(input.requestId!)?.result === result) {
            this.idempotency.delete(input.requestId!);
          }
        }
      );
      return result;
    }
    return this.enqueue(() => this.performUpdate(input));
  }

  private trimIdempotencyCache(): void {
    while (this.idempotency.size > MAX_IDEMPOTENCY_ENTRIES) {
      const settled = [...this.idempotency].find(([, entry]) => entry.settled);
      if (!settled) return;
      this.idempotency.delete(settled[0]);
    }
  }

  private async performUpdate(input: SettingsUpdateInputV1): Promise<SettingsUpdateResultV1> {
    try {
      validateSettingsOperationsV1(input.operations);
      const selectedModel = input.operations.find(
        operation => operation.op === 'set' && operation.key === 'defaults.model'
      );
      if (
        selectedModel?.op === 'set' &&
        this.configuredModels &&
        !this.configuredModels.some(model => model.id === selectedModel.value)
      ) {
        throw new SettingsCoordinatorError(
          422,
          'settings_rejected',
          'The selected default model is unavailable.'
        );
      }
      if (this.recoveryRequired) {
        throw new SettingsCoordinatorError(
          503,
          'settings_recovery_required',
          'Settings recovery is required before additional updates.'
        );
      }
      await this.synchronizeExternalChangesInQueue(true);
      if (this.readOnly) {
        throw new SettingsCoordinatorError(
          403,
          'settings_write_forbidden',
          'Settings updates are disabled for this host.'
        );
      }
      const before = this.describe(input);
      const runtimeSensitive = isRuntimeSensitive(input.operations);
      if (
        runtimeSensitive &&
        (input.runtime?.busy || (this.runtimeIdle && !(await this.runtimeIdle())))
      ) {
        throw new SettingsCoordinatorError(409, 'runtime_busy', 'The runtime is busy.');
      }
      const prepare = input.runtimePrepare ?? this.runtimePrepare;
      await prepare?.({ before, operations: input.operations });
      const persisted = this.repository.persist(
        this.workspace,
        input.expectedRevision,
        input.operations
      );
      const document = this.buildView(persisted.snapshot, input);
      try {
        const apply = input.runtimeApply ?? this.runtimeApply;
        await apply?.({ before, document, operations: input.operations });
      } catch {
        try {
          const restored = this.repository.rollback(persisted.rollbackToken);
          this.emitInvalidation({
            revision: restored.revision,
            reason: 'local-write',
            state: 'ready',
          });
        } catch {
          this.recoveryRequired = true;
          throw new SettingsCoordinatorError(
            503,
            'settings_recovery_required',
            'The durable settings write could not be reconciled with the runtime.'
          );
        }
        throw new SettingsCoordinatorError(
          422,
          'settings_rejected',
          'The runtime rejected the settings update; the document was restored.'
        );
      }
      this.lastAppliedSnapshot = persisted.snapshot;
      const result: SettingsUpdateResultV1 = deepFreeze({
        revision: persisted.revision,
        appliedKeys: [...persisted.appliedKeys],
        document,
      }) as SettingsUpdateResultV1;
      this.emitInvalidation({
        revision: result.revision,
        reason: 'local-write',
        state: 'ready',
      });
      return result;
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  openDocument(): Promise<void> {
    this.assertOpen();
    return this.enqueue(async () => {
      try {
        const current = this.repository.read();
        if (this.readOnly && !current.hasDocument) {
          throw new SettingsCoordinatorError(
            403,
            'settings_write_forbidden',
            'Creating the settings document is disabled for this host.'
          );
        }
        const ensured = this.repository.ensureDocument();
        if (ensured.created) {
          this.emitInvalidation({
            revision: ensured.snapshot.revision,
            reason: 'local-write',
            state: 'ready',
          });
        }
        try {
          await this.documentOpener(this.repository.documentPath);
        } catch {
          throw new SettingsCoordinatorError(
            503,
            'settings_document_unavailable',
            'The settings document could not be opened.'
          );
        }
      } catch (error) {
        throw mapRepositoryError(error);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopWatching();
    this.repository.close();
    this.idempotency.clear();
  }
}
