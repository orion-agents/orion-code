/**
 * Durable, secret-preserving storage seam for the v0.3.0 Settings subsystem.
 *
 * `orion.json` remains the only settings document. The sidecar key is solely
 * local revision entropy and never contains settings or leaves this service.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  watch as watchDirectory,
  type FSWatcher,
} from 'fs';
import { basename, dirname, join } from 'path';
import { atomicWriteFileSync } from './atomic-write';
import { withFileLockSync } from './file-lock';
import { getConfigHome, getGlobalConfigPath } from '../product/paths';
import {
  GlobalConfigDocumentValidationError,
  parseGlobalConfigDocumentStrict,
  validateGlobalConfigDocumentStrict,
  type GlobalConfigDocument,
} from './global-config';
import { isEffortPreference, type EffortPreference } from './effort';

export const SETTINGS_REVISION_KEY_FILE = '.orion-settings-revision.key';
export const SETTINGS_REVISION_PREFIX = 'hmac-sha256:';

const REVISION_KEY_BYTES = 32;
const MISSING_DOCUMENT_SENTINEL = Buffer.from('missing-document-v1', 'utf8');
const DEFAULT_WATCH_DEBOUNCE_MS = 30;
const DEFAULT_LOCK_WAIT_MS = 10_000;

export type SettingsKeyV1 =
  | 'appearance.style'
  | 'appearance.theme'
  | 'appearance.motion'
  | 'defaults.model'
  | 'defaults.effort'
  | 'defaults.globalEffort'
  | 'permissions.toolConfirmation';

export type SettingsOperationV1 =
  | {
      readonly op: 'set';
      readonly key: 'appearance.style';
      readonly value: 'classic' | 'orion-blocksmith';
    }
  | { readonly op: 'unset'; readonly key: 'appearance.style' }
  | {
      readonly op: 'set';
      readonly key: 'appearance.theme';
      readonly value: 'system' | 'light' | 'dark';
    }
  | { readonly op: 'unset'; readonly key: 'appearance.theme' }
  | { readonly op: 'set'; readonly key: 'appearance.motion'; readonly value: 'system' | 'reduced' }
  | { readonly op: 'unset'; readonly key: 'appearance.motion' }
  | { readonly op: 'set'; readonly key: 'defaults.model'; readonly value: string }
  | { readonly op: 'unset'; readonly key: 'defaults.model' }
  | { readonly op: 'set'; readonly key: 'defaults.effort'; readonly value: EffortPreference }
  | { readonly op: 'unset'; readonly key: 'defaults.effort' }
  /** Internal command/TUI operation. The Web protocol intentionally omits this key. */
  | { readonly op: 'set'; readonly key: 'defaults.globalEffort'; readonly value: EffortPreference }
  | { readonly op: 'unset'; readonly key: 'defaults.globalEffort' }
  | {
      readonly op: 'set';
      readonly key: 'permissions.toolConfirmation';
      readonly value: 'ask' | 'allow' | 'deny';
    }
  | { readonly op: 'unset'; readonly key: 'permissions.toolConfirmation' };

export type SettingsDocumentRepositoryErrorCode =
  | 'settings_invalid_operation'
  | 'settings_revision_conflict'
  | 'settings_document_invalid'
  | 'settings_document_unavailable'
  | 'settings_rejected'
  | 'settings_recovery_required';

export class SettingsDocumentRepositoryError extends Error {
  constructor(
    readonly code: SettingsDocumentRepositoryErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'SettingsDocumentRepositoryError';
  }
}

export interface SettingsRepositorySnapshotV1 {
  readonly revision: string;
  readonly state: 'ready' | 'invalid' | 'unavailable';
  readonly hasDocument: boolean;
  /** Current valid document, or the last-good document while state is invalid/unavailable. */
  readonly document: Readonly<GlobalConfigDocument>;
  readonly lastGoodRevision?: string;
  readonly diagnostic?: {
    readonly code: 'settings_document_invalid' | 'settings_document_unavailable';
    readonly message: string;
  };
}

export interface SettingsRepositoryInvalidationV1 {
  readonly revision: string;
  readonly reason: 'external-edit';
  readonly state: 'ready' | 'invalid';
}

export interface SettingsDocumentRepositoryOptions {
  readonly documentPath?: string;
  readonly revisionKeyPath?: string;
  readonly lockWaitMs?: number;
  readonly watchDebounceMs?: number;
  /** Additional semantic validation, invoked inside the file lock before write. */
  readonly validateCandidate?: (candidate: Readonly<GlobalConfigDocument>) => void;
}

interface LastGoodSnapshot {
  readonly revision: string;
  readonly hasDocument: boolean;
  readonly document: Readonly<GlobalConfigDocument>;
}

interface DiskRead {
  readonly snapshot: SettingsRepositorySnapshotV1;
  readonly bytes: Buffer | null;
  readonly currentDocument: GlobalConfigDocument | null;
}

interface SettingsRollbackToken {
  readonly committedRevision: string;
  readonly previousBytes: Buffer | null;
}

export interface SettingsPersistResultV1 {
  readonly revision: string;
  readonly appliedKeys: readonly SettingsKeyV1[];
  readonly snapshot: SettingsRepositorySnapshotV1;
  /** Opaque to callers other than SettingsCoordinatorV1. */
  readonly rollbackToken: unknown;
}

export interface SettingsEnsureDocumentResultV1 {
  readonly created: boolean;
  readonly snapshot: SettingsRepositorySnapshotV1;
}

function cloneDocument<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function immutableDocument(document: GlobalConfigDocument): Readonly<GlobalConfigDocument> {
  return deepFreeze(cloneDocument(document));
}

function cloneSnapshot(snapshot: SettingsRepositorySnapshotV1): SettingsRepositorySnapshotV1 {
  return Object.freeze({
    ...snapshot,
    document: immutableDocument(snapshot.document as GlobalConfigDocument),
    ...(snapshot.diagnostic ? { diagnostic: Object.freeze({ ...snapshot.diagnostic }) } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pruneEmptyObject(parent: Record<string, unknown>, key: string): void {
  const value = parent[key];
  if (isRecord(value) && Object.keys(value).length === 0) delete parent[key];
}

function invalidOperation(): never {
  throw new SettingsDocumentRepositoryError(
    'settings_invalid_operation',
    'The settings operation is invalid.'
  );
}

function withRedactedFileLock<T>(
  targetPath: string,
  waitMs: number,
  failureCode: SettingsDocumentRepositoryErrorCode,
  failureMessage: string,
  operation: () => T
): T {
  try {
    return withFileLockSync(targetPath, operation, { waitMs });
  } catch (error) {
    if (error instanceof SettingsDocumentRepositoryError) throw error;
    throw new SettingsDocumentRepositoryError(failureCode, failureMessage);
  }
}

/** Validate bounded public path operations without ever accepting arbitrary paths. */
export function validateSettingsOperationsV1(
  operations: readonly SettingsOperationV1[]
): readonly SettingsOperationV1[] {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 20) {
    invalidOperation();
  }
  const keys = new Set<SettingsKeyV1>();
  for (const operation of operations) {
    if (!isRecord(operation) || (operation.op !== 'set' && operation.op !== 'unset')) {
      invalidOperation();
    }
    if (
      operation.key !== 'appearance.style' &&
      operation.key !== 'appearance.theme' &&
      operation.key !== 'appearance.motion' &&
      operation.key !== 'defaults.model' &&
      operation.key !== 'defaults.effort' &&
      operation.key !== 'defaults.globalEffort' &&
      operation.key !== 'permissions.toolConfirmation'
    ) {
      invalidOperation();
    }
    if (keys.has(operation.key)) invalidOperation();
    keys.add(operation.key);
    if (operation.op === 'unset') {
      if (Object.prototype.hasOwnProperty.call(operation, 'value')) invalidOperation();
      continue;
    }
    switch (operation.key) {
      case 'appearance.style':
        if (operation.value !== 'classic' && operation.value !== 'orion-blocksmith') {
          invalidOperation();
        }
        break;
      case 'appearance.theme':
        if (
          operation.value !== 'system' &&
          operation.value !== 'light' &&
          operation.value !== 'dark'
        ) {
          invalidOperation();
        }
        break;
      case 'appearance.motion':
        if (operation.value !== 'system' && operation.value !== 'reduced') invalidOperation();
        break;
      case 'defaults.model':
        if (
          typeof operation.value !== 'string' ||
          operation.value.trim().length === 0 ||
          operation.value.length > 256
        ) {
          invalidOperation();
        }
        break;
      case 'defaults.effort':
      case 'defaults.globalEffort':
        if (!isEffortPreference(operation.value)) invalidOperation();
        break;
      case 'permissions.toolConfirmation':
        if (
          operation.value !== 'ask' &&
          operation.value !== 'allow' &&
          operation.value !== 'deny'
        ) {
          invalidOperation();
        }
        break;
      default:
        invalidOperation();
    }
  }
  return operations;
}

function applyOperations(
  source: GlobalConfigDocument,
  workspace: string,
  operations: readonly SettingsOperationV1[]
): GlobalConfigDocument {
  const candidate = cloneDocument(source);
  for (const operation of operations) {
    switch (operation.key) {
      case 'appearance.style': {
        if (operation.op === 'set') {
          const web = isRecord(candidate.web) ? candidate.web : {};
          const appearance = isRecord(web.appearance) ? web.appearance : {};
          appearance.style = operation.value;
          web.appearance = appearance;
          candidate.web = web;
        } else if (isRecord(candidate.web) && isRecord(candidate.web.appearance)) {
          delete candidate.web.appearance.style;
          pruneEmptyObject(candidate.web, 'appearance');
          pruneEmptyObject(candidate, 'web');
        }
        break;
      }
      case 'appearance.theme': {
        if (operation.op === 'set') {
          const web = isRecord(candidate.web) ? candidate.web : {};
          const appearance = isRecord(web.appearance) ? web.appearance : {};
          appearance.theme = operation.value;
          web.appearance = appearance;
          candidate.web = web;
        } else if (isRecord(candidate.web) && isRecord(candidate.web.appearance)) {
          delete candidate.web.appearance.theme;
          pruneEmptyObject(candidate.web, 'appearance');
          pruneEmptyObject(candidate, 'web');
        }
        break;
      }
      case 'appearance.motion': {
        if (operation.op === 'set') {
          const web = isRecord(candidate.web) ? candidate.web : {};
          const appearance = isRecord(web.appearance) ? web.appearance : {};
          appearance.motion = operation.value;
          web.appearance = appearance;
          candidate.web = web;
        } else if (isRecord(candidate.web) && isRecord(candidate.web.appearance)) {
          delete candidate.web.appearance.motion;
          pruneEmptyObject(candidate.web, 'appearance');
          pruneEmptyObject(candidate, 'web');
        }
        break;
      }
      case 'defaults.model':
        if (operation.op === 'set') candidate.defaultModel = operation.value;
        else delete candidate.defaultModel;
        break;
      case 'defaults.effort': {
        if (operation.op === 'set') {
          const projects = isRecord(candidate.projects) ? candidate.projects : {};
          const project = isRecord(projects[workspace]) ? projects[workspace] : {};
          project.defaultEffort = operation.value;
          projects[workspace] = project;
          candidate.projects = projects;
        } else if (isRecord(candidate.projects) && isRecord(candidate.projects[workspace])) {
          delete candidate.projects[workspace].defaultEffort;
          pruneEmptyObject(candidate.projects, workspace);
          pruneEmptyObject(candidate, 'projects');
        }
        break;
      }
      case 'defaults.globalEffort':
        if (operation.op === 'set') candidate.defaultEffort = operation.value;
        else delete candidate.defaultEffort;
        break;
      case 'permissions.toolConfirmation':
        if (operation.op === 'set') candidate.toolConfirmation = operation.value;
        else delete candidate.toolConfirmation;
        break;
    }
  }
  return candidate;
}

function secureRevisionEqual(left: string, right: string): boolean {
  if (!left.startsWith(SETTINGS_REVISION_PREFIX) || !right.startsWith(SETTINGS_REVISION_PREFIX)) {
    return false;
  }
  const leftBytes = Buffer.from(left.slice(SETTINGS_REVISION_PREFIX.length), 'hex');
  const rightBytes = Buffer.from(right.slice(SETTINGS_REVISION_PREFIX.length), 'hex');
  return (
    leftBytes.length === 32 && rightBytes.length === 32 && timingSafeEqual(leftBytes, rightBytes)
  );
}

/** Repository for strict reads and lock-protected CAS writes of `orion.json`. */
export class SettingsDocumentRepository {
  readonly documentPath: string;
  private readonly revisionKeyPath: string;
  private readonly revisionKey: Buffer;
  private readonly lockWaitMs: number;
  private readonly watchDebounceMs: number;
  private readonly validateCandidate?: (candidate: Readonly<GlobalConfigDocument>) => void;
  private lastGood: LastGoodSnapshot | null = null;
  private lastReadSignature: string | null = null;
  private lastObservedSignature: string | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<(event: SettingsRepositoryInvalidationV1) => void>();
  private closed = false;

  constructor(options: SettingsDocumentRepositoryOptions = {}) {
    this.documentPath = options.documentPath ?? getGlobalConfigPath();
    this.revisionKeyPath =
      options.revisionKeyPath ??
      join(
        options.documentPath ? dirname(options.documentPath) : getConfigHome(),
        SETTINGS_REVISION_KEY_FILE
      );
    this.lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    this.watchDebounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
    this.validateCandidate = options.validateCandidate;
    mkdirSync(dirname(this.documentPath), { recursive: true, mode: 0o700 });
    this.revisionKey = this.loadOrCreateRevisionKey();
  }

  static create(options: SettingsDocumentRepositoryOptions = {}): SettingsDocumentRepository {
    return new SettingsDocumentRepository(options);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new SettingsDocumentRepositoryError(
        'settings_document_unavailable',
        'The settings repository is closed.'
      );
    }
  }

  private loadOrCreateRevisionKey(): Buffer {
    return withRedactedFileLock(
      this.revisionKeyPath,
      this.lockWaitMs,
      'settings_document_unavailable',
      'The local settings revision key is unavailable.',
      () => {
        if (!existsSync(this.revisionKeyPath)) {
          atomicWriteFileSync(this.revisionKeyPath, randomBytes(REVISION_KEY_BYTES), {
            mode: 0o600,
            fsync: true,
          });
        }
        let key: Buffer;
        try {
          key = readFileSync(this.revisionKeyPath);
          chmodSync(this.revisionKeyPath, 0o600);
        } catch {
          throw new SettingsDocumentRepositoryError(
            'settings_document_unavailable',
            'The local settings revision key is unavailable.'
          );
        }
        if (key.length !== REVISION_KEY_BYTES) {
          throw new SettingsDocumentRepositoryError(
            'settings_document_unavailable',
            'The local settings revision key is invalid.'
          );
        }
        return Buffer.from(key);
      }
    );
  }

  private revision(bytes: Buffer | null): string {
    const digest = createHmac('sha256', this.revisionKey)
      .update(bytes ?? MISSING_DOCUMENT_SENTINEL)
      .digest('hex');
    return `${SETTINGS_REVISION_PREFIX}${digest}`;
  }

  private readDisk(): DiskRead {
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.documentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const revision = this.revision(null);
        const document = immutableDocument({});
        const snapshot: SettingsRepositorySnapshotV1 = Object.freeze({
          revision,
          state: 'ready',
          hasDocument: false,
          document,
          lastGoodRevision: revision,
        });
        return { snapshot, bytes: null, currentDocument: {} };
      }
      const fallback = this.lastGood;
      const snapshot: SettingsRepositorySnapshotV1 = Object.freeze({
        revision: fallback?.revision ?? this.revision(null),
        state: 'unavailable',
        hasDocument: existsSync(this.documentPath),
        document: fallback?.document ?? immutableDocument({}),
        ...(fallback ? { lastGoodRevision: fallback.revision } : {}),
        diagnostic: Object.freeze({
          code: 'settings_document_unavailable' as const,
          message: 'The settings document is unavailable.',
        }),
      });
      return { snapshot, bytes: null, currentDocument: null };
    }

    const revision = this.revision(bytes);
    try {
      const document = parseGlobalConfigDocumentStrict(bytes);
      const immutable = immutableDocument(document);
      return {
        snapshot: Object.freeze({
          revision,
          state: 'ready',
          hasDocument: true,
          document: immutable,
          lastGoodRevision: revision,
        }),
        bytes,
        currentDocument: cloneDocument(document),
      };
    } catch (error) {
      if (!(error instanceof GlobalConfigDocumentValidationError)) throw error;
      const fallback = this.lastGood;
      return {
        snapshot: Object.freeze({
          revision,
          state: 'invalid',
          hasDocument: true,
          document: fallback?.document ?? immutableDocument({}),
          ...(fallback ? { lastGoodRevision: fallback.revision } : {}),
          diagnostic: Object.freeze({
            code: 'settings_document_invalid' as const,
            message: 'The settings document is invalid. Repair it before saving settings.',
          }),
        }),
        bytes,
        currentDocument: null,
      };
    }
  }

  private remember(read: DiskRead, markWatcherObserved = false): SettingsRepositorySnapshotV1 {
    if (read.snapshot.state === 'ready' && read.currentDocument) {
      this.lastGood = Object.freeze({
        revision: read.snapshot.revision,
        hasDocument: read.snapshot.hasDocument,
        document: immutableDocument(read.currentDocument),
      });
    }
    this.lastReadSignature = `${read.snapshot.state}:${read.snapshot.revision}`;
    if (markWatcherObserved) this.lastObservedSignature = this.lastReadSignature;
    return cloneSnapshot(read.snapshot);
  }

  /** Strictly read current bytes. Invalid bytes never become defaults. */
  read(): SettingsRepositorySnapshotV1 {
    this.assertOpen();
    return this.remember(this.readDisk());
  }

  /** Whether the current document (or its directory when missing) is locally writable. */
  isWritable(snapshot: SettingsRepositorySnapshotV1 = this.read()): boolean {
    if (snapshot.state !== 'ready') return false;
    try {
      accessSync(
        snapshot.hasDocument ? this.documentPath : dirname(this.documentPath),
        constants.W_OK
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Apply a typed batch under one cross-process lock and one atomic rename. */
  persist(
    workspace: string,
    expectedRevision: string,
    operations: readonly SettingsOperationV1[]
  ): SettingsPersistResultV1 {
    this.assertOpen();
    const validatedOperations = validateSettingsOperationsV1(operations);
    return withRedactedFileLock(
      this.documentPath,
      this.lockWaitMs,
      'settings_document_unavailable',
      'The settings document could not be persisted.',
      () => {
        const before = this.readDisk();
        if (before.snapshot.state === 'invalid') {
          throw new SettingsDocumentRepositoryError(
            'settings_document_invalid',
            'The settings document is invalid.'
          );
        }
        if (before.snapshot.state !== 'ready' || !before.currentDocument) {
          throw new SettingsDocumentRepositoryError(
            'settings_document_unavailable',
            'The settings document is unavailable.'
          );
        }
        if (!secureRevisionEqual(expectedRevision, before.snapshot.revision)) {
          throw new SettingsDocumentRepositoryError(
            'settings_revision_conflict',
            'The settings document changed before this update.'
          );
        }

        const base = before.snapshot.hasDocument
          ? before.currentDocument
          : ({ schemaVersion: 1 } as GlobalConfigDocument);
        // The composition root owns workspace canonicalization. Re-keying to a
        // git root here would diverge from existing getProjectConfig(cwd).
        const candidate = applyOperations(base, workspace, validatedOperations);
        try {
          validateGlobalConfigDocumentStrict(candidate);
          this.validateCandidate?.(immutableDocument(candidate));
        } catch {
          throw new SettingsDocumentRepositoryError(
            'settings_rejected',
            'The candidate settings document was rejected.'
          );
        }
        const bytes = Buffer.from(JSON.stringify(candidate, null, 2), 'utf8');
        atomicWriteFileSync(this.documentPath, bytes, { mode: 0o600, fsync: true });
        const revision = this.revision(bytes);
        const snapshot: SettingsRepositorySnapshotV1 = Object.freeze({
          revision,
          state: 'ready',
          hasDocument: true,
          document: immutableDocument(candidate),
          lastGoodRevision: revision,
        });
        this.remember({ snapshot, bytes, currentDocument: candidate }, true);
        const rollbackToken: SettingsRollbackToken = Object.freeze({
          committedRevision: revision,
          previousBytes: before.bytes ? Buffer.from(before.bytes) : null,
        });
        return Object.freeze({
          revision,
          appliedKeys: Object.freeze(validatedOperations.map(operation => operation.key)),
          snapshot: cloneSnapshot(snapshot),
          rollbackToken,
        });
      }
    );
  }

  /** Conditionally restore the exact previous bytes after a Runtime apply failure. */
  rollback(rollbackToken: unknown): SettingsRepositorySnapshotV1 {
    this.assertOpen();
    if (!isRecord(rollbackToken)) {
      throw new SettingsDocumentRepositoryError(
        'settings_recovery_required',
        'The settings rollback token is invalid.'
      );
    }
    const token = rollbackToken as unknown as SettingsRollbackToken;
    if (
      typeof token.committedRevision !== 'string' ||
      (token.previousBytes !== null && !Buffer.isBuffer(token.previousBytes))
    ) {
      throw new SettingsDocumentRepositoryError(
        'settings_recovery_required',
        'The settings rollback token is invalid.'
      );
    }
    return withRedactedFileLock(
      this.documentPath,
      this.lockWaitMs,
      'settings_recovery_required',
      'The settings document could not be recovered safely.',
      () => {
        const current = this.readDisk();
        if (
          current.snapshot.state !== 'ready' ||
          !secureRevisionEqual(current.snapshot.revision, token.committedRevision)
        ) {
          throw new SettingsDocumentRepositoryError(
            'settings_recovery_required',
            'The settings document changed before recovery completed.'
          );
        }
        if (token.previousBytes === null) {
          try {
            unlinkSync(this.documentPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        } else {
          try {
            parseGlobalConfigDocumentStrict(token.previousBytes);
          } catch {
            throw new SettingsDocumentRepositoryError(
              'settings_recovery_required',
              'The previous settings document cannot be recovered safely.'
            );
          }
          atomicWriteFileSync(this.documentPath, token.previousBytes, { mode: 0o600, fsync: true });
        }
        return this.remember(this.readDisk(), true);
      }
    );
  }

  /** Create the minimal canonical document when the pathless advanced action needs one. */
  ensureDocument(): SettingsEnsureDocumentResultV1 {
    this.assertOpen();
    return withRedactedFileLock(
      this.documentPath,
      this.lockWaitMs,
      'settings_document_unavailable',
      'The settings document could not be created safely.',
      () => {
        const current = this.readDisk();
        // An invalid existing document is still openable for manual repair;
        // this method must only refuse to overwrite it.
        if (current.snapshot.state === 'invalid') {
          return Object.freeze({ created: false, snapshot: this.remember(current) });
        }
        if (current.snapshot.state !== 'ready') {
          throw new SettingsDocumentRepositoryError(
            'settings_document_unavailable',
            'The settings document is unavailable.'
          );
        }
        if (current.snapshot.hasDocument) {
          return Object.freeze({ created: false, snapshot: this.remember(current) });
        }
        const document: GlobalConfigDocument = { schemaVersion: 1 };
        const bytes = Buffer.from(JSON.stringify(document, null, 2), 'utf8');
        atomicWriteFileSync(this.documentPath, bytes, { mode: 0o600, fsync: true });
        return Object.freeze({ created: true, snapshot: this.remember(this.readDisk(), true) });
      }
    );
  }

  /** Watch atomic replacements by observing the containing directory. */
  watch(listener: (event: SettingsRepositoryInvalidationV1) => void): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    if (!this.watcher) {
      const directory = dirname(this.documentPath);
      const targetName = basename(this.documentPath);
      const baselineSignature = this.lastReadSignature;
      this.watcher = watchDirectory(directory, (_eventType, filename) => {
        if (filename !== null && filename.toString() !== targetName) return;
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => this.refreshWatcher(), this.watchDebounceMs);
      });
      this.watcher.on('error', () => this.stopWatcher());
      // Close the read-before-watch race: re-read after the native watcher exists.
      this.refreshWatcher(baselineSignature);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopWatcher();
    };
  }

  private refreshWatcher(compareWith: string | null = this.lastObservedSignature): void {
    if (this.closed) return;
    this.watchTimer = null;
    const read = this.readDisk();
    const signature = `${read.snapshot.state}:${read.snapshot.revision}`;
    this.remember(read, true);
    if (
      compareWith === null ||
      signature === compareWith ||
      read.snapshot.state === 'unavailable'
    ) {
      return;
    }
    const event: SettingsRepositoryInvalidationV1 = Object.freeze({
      revision: read.snapshot.revision,
      reason: 'external-edit',
      state: read.snapshot.state,
    });
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Watcher delivery is advisory; one observer cannot break durable CAS.
      }
    }
  }

  private stopWatcher(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopWatcher();
    this.listeners.clear();
    this.revisionKey.fill(0);
  }
}
