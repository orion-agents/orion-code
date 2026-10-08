import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';

import { getConfigHome } from '../product/paths';
import { atomicWriteFileSync } from './atomic-write';
import { withFileLockSync } from './file-lock';
import { WorkspaceRegistryError, canonicalWorkspaceDirectory } from './workspace-registry';

/** Translate the shared directory error into this registry's own code. */
function canonicalRootPath(path: string): string {
  try {
    return canonicalWorkspaceDirectory(path);
  } catch (error) {
    if (error instanceof WorkspaceRegistryError) {
      throw new WorkspaceRootsRegistryError(
        'Workspace root directory is unavailable.',
        'workspace_root_unavailable'
      );
    }
    throw error;
  }
}

const WORKSPACE_ROOTS_SCHEMA_VERSION = 1 as const;
const DEFAULT_ROOTS_FILENAME = 'workspace-roots.v1.json';
/** Saved roots are user-authorized scan boundaries, not a project catalog. */
export const MAX_WORKSPACE_ROOTS = 12;

export interface WorkspaceRootEntryV1 {
  readonly id: string;
  readonly canonicalPath: string;
  readonly label: string;
  readonly addedAt: string;
  readonly lastScannedAt?: string;
}

interface WorkspaceRootsDocumentV1 {
  readonly schemaVersion: typeof WORKSPACE_ROOTS_SCHEMA_VERSION;
  readonly entries: readonly WorkspaceRootEntryV1[];
}

export interface WorkspaceRootsRegistryOptions {
  readonly storagePath?: string;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export class WorkspaceRootsRegistryError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'workspace_roots_invalid'
      | 'workspace_roots_capacity'
      | 'workspace_root_unavailable'
  ) {
    super(message);
    this.name = 'WorkspaceRootsRegistryError';
  }
}

/**
 * v0.3.21 — durable registry of user-authorized project-root directories.
 *
 * A root is a scan boundary the user explicitly granted through the native
 * picker (or an explicit migration path); it is a different entity from a
 * workspace and lives in its own versioned file so discovery can never be
 * confused with `WorkspaceRegistryV1` (opened workspaces). Adding a root never
 * registers a workspace, activates a Context, or touches the session catalog.
 */
export class WorkspaceRootsRegistryV1 {
  private readonly storagePath: string;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: WorkspaceRootsRegistryOptions = {}) {
    this.storagePath = options.storagePath ?? join(getConfigHome(), DEFAULT_ROOTS_FILENAME);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  list(): readonly WorkspaceRootEntryV1[] {
    return freezeEntries(this.readDocument().entries);
  }

  find(id: string): WorkspaceRootEntryV1 | undefined {
    return this.readDocument().entries.find(entry => entry.id === id);
  }

  /** Canonicalize, dedupe by path, cap the count, and persist atomically. */
  add(path: string): WorkspaceRootEntryV1 {
    const canonicalPath = canonicalRootPath(path);
    this.ensureStorageDirectory();
    return withFileLockSync(this.storagePath, () => {
      const document = this.readDocument();
      const existing = document.entries.find(entry => entry.canonicalPath === canonicalPath);
      if (existing) return existing;
      if (document.entries.length >= MAX_WORKSPACE_ROOTS) {
        throw new WorkspaceRootsRegistryError(
          `Workspace roots registry cannot contain more than ${MAX_WORKSPACE_ROOTS} entries.`,
          'workspace_roots_capacity'
        );
      }
      const now = this.now().toISOString();
      const entry: WorkspaceRootEntryV1 = Object.freeze({
        id: this.createId(),
        canonicalPath,
        label: workspaceRootLabel(canonicalPath),
        addedAt: now,
      });
      this.writeDocument([...document.entries, entry]);
      return entry;
    });
  }

  remove(id: string): boolean {
    this.ensureStorageDirectory();
    return withFileLockSync(this.storagePath, () => {
      const document = this.readDocument();
      const entries = document.entries.filter(entry => entry.id !== id);
      if (entries.length === document.entries.length) return false;
      this.writeDocument(entries);
      return true;
    });
  }

  /** Record that a discovery scan completed for this root (success or partial). */
  markScanned(id: string, scannedAt?: string): WorkspaceRootEntryV1 | undefined {
    this.ensureStorageDirectory();
    const at = (scannedAt ?? this.now().toISOString()).trim();
    return withFileLockSync(this.storagePath, () => {
      const document = this.readDocument();
      const target = document.entries.find(entry => entry.id === id);
      if (!target) return undefined;
      const updated: WorkspaceRootEntryV1 = Object.freeze({
        ...target,
        lastScannedAt: Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : at,
      });
      this.writeDocument(document.entries.map(entry => (entry.id === id ? updated : entry)));
      return updated;
    });
  }

  private readDocument(): WorkspaceRootsDocumentV1 {
    if (!existsSync(this.storagePath)) {
      return Object.freeze({ schemaVersion: WORKSPACE_ROOTS_SCHEMA_VERSION, entries: [] });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as unknown;
    } catch {
      throw new WorkspaceRootsRegistryError(
        'Workspace roots registry is not valid JSON.',
        'workspace_roots_invalid'
      );
    }
    return parseDocument(parsed);
  }

  private writeDocument(entries: readonly WorkspaceRootEntryV1[]): void {
    this.ensureStorageDirectory();
    const normalized = [...entries]
      .sort(
        (left, right) =>
          Date.parse(right.addedAt) - Date.parse(left.addedAt) ||
          left.label.localeCompare(right.label) ||
          left.id.localeCompare(right.id)
      )
      .map(entry => ({ ...entry }));
    atomicWriteFileSync(
      this.storagePath,
      `${JSON.stringify({ schemaVersion: WORKSPACE_ROOTS_SCHEMA_VERSION, entries: normalized }, null, 2)}\n`,
      { mode: 0o600, fsync: true }
    );
  }

  private ensureStorageDirectory(): void {
    mkdirSync(dirname(this.storagePath), { recursive: true, mode: 0o700 });
  }
}

function parseDocument(value: unknown): WorkspaceRootsDocumentV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidDocument();
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== WORKSPACE_ROOTS_SCHEMA_VERSION || !Array.isArray(row.entries)) {
    return invalidDocument();
  }
  if (row.entries.length > MAX_WORKSPACE_ROOTS) return invalidDocument();
  const entries = row.entries.map(parseEntry);
  if (
    new Set(entries.map(entry => entry.id)).size !== entries.length ||
    new Set(entries.map(entry => entry.canonicalPath)).size !== entries.length
  ) {
    return invalidDocument();
  }
  return Object.freeze({
    schemaVersion: WORKSPACE_ROOTS_SCHEMA_VERSION,
    entries: freezeEntries(entries),
  });
}

function parseEntry(value: unknown): WorkspaceRootEntryV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidDocument();
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    !row.id.trim() ||
    row.id.length > 128 ||
    typeof row.canonicalPath !== 'string' ||
    !row.canonicalPath.trim() ||
    typeof row.label !== 'string' ||
    !row.label.trim() ||
    typeof row.addedAt !== 'string' ||
    !Number.isFinite(Date.parse(row.addedAt)) ||
    (row.lastScannedAt !== undefined &&
      (typeof row.lastScannedAt !== 'string' || !Number.isFinite(Date.parse(row.lastScannedAt))))
  ) {
    return invalidDocument();
  }
  return Object.freeze({
    id: row.id,
    canonicalPath: row.canonicalPath,
    label: row.label,
    addedAt: row.addedAt,
    ...(row.lastScannedAt !== undefined ? { lastScannedAt: row.lastScannedAt } : {}),
  });
}

function invalidDocument(): never {
  throw new WorkspaceRootsRegistryError(
    'Workspace roots registry document is invalid.',
    'workspace_roots_invalid'
  );
}

function freezeEntries(entries: readonly WorkspaceRootEntryV1[]): readonly WorkspaceRootEntryV1[] {
  return Object.freeze(
    [...entries]
      .sort(
        (left, right) =>
          Date.parse(right.addedAt) - Date.parse(left.addedAt) ||
          left.label.localeCompare(right.label) ||
          left.id.localeCompare(right.id)
      )
      .map(entry => Object.freeze({ ...entry }))
  );
}

function workspaceRootLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, '');
  return normalized.split(/[\\/]/u).filter(Boolean).at(-1) ?? normalized;
}

/** Re-exported for tests: a root must be an existing, readable directory. */
export function canonicalWorkspaceRoot(path: string): string {
  const canonical = canonicalWorkspaceDirectory(path);
  statSync(canonical);
  return canonical;
}
