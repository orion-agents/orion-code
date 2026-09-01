import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';

import { getConfigHome } from '../product/paths';
import { atomicWriteFileSync } from './atomic-write';
import { withFileLockSync } from './file-lock';

const WORKSPACE_REGISTRY_SCHEMA_VERSION = 1 as const;
const DEFAULT_REGISTRY_FILENAME = 'workspaces.v1.json';
const MAX_WORKSPACES = 1_000;

export interface WorkspaceRegistryEntryV1 {
  readonly id: string;
  readonly canonicalPath: string;
  readonly label: string;
  readonly lastActivatedAt: string;
  readonly pinnedOrder?: number;
}

interface WorkspaceRegistryDocumentV1 {
  readonly schemaVersion: typeof WORKSPACE_REGISTRY_SCHEMA_VERSION;
  readonly entries: readonly WorkspaceRegistryEntryV1[];
}

export interface WorkspaceRegistryOptions {
  readonly storagePath?: string;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export class WorkspaceRegistryError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'workspace_registry_invalid'
      | 'workspace_registry_capacity'
      | 'workspace_unavailable'
  ) {
    super(message);
    this.name = 'WorkspaceRegistryError';
  }
}

/**
 * Durable registry of directories the user explicitly opened in Orion.
 *
 * Paths are canonicalized before becoming identities. Mutations take the
 * repository-wide file lock so two local Orion processes cannot silently
 * overwrite each other's project list.
 */
export class WorkspaceRegistryV1 {
  private readonly storagePath: string;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: WorkspaceRegistryOptions = {}) {
    this.storagePath = options.storagePath ?? join(getConfigHome(), DEFAULT_REGISTRY_FILENAME);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  list(): readonly WorkspaceRegistryEntryV1[] {
    return freezeEntries(this.readDocument().entries);
  }

  register(path: string, options: { readonly activated?: boolean } = {}): WorkspaceRegistryEntryV1 {
    const canonicalPath = canonicalWorkspaceDirectory(path);
    this.ensureStorageDirectory();
    return withFileLockSync(this.storagePath, () => {
      const document = this.readDocument();
      const existing = document.entries.find(entry => entry.canonicalPath === canonicalPath);
      const now = this.now().toISOString();
      const nextEntry = Object.freeze({
        id: existing?.id ?? this.createId(),
        canonicalPath,
        label: workspaceLabel(canonicalPath),
        lastActivatedAt: options.activated ? now : (existing?.lastActivatedAt ?? now),
        ...(existing?.pinnedOrder !== undefined ? { pinnedOrder: existing.pinnedOrder } : {}),
      });
      const entries = existing
        ? document.entries.map(entry => (entry.id === existing.id ? nextEntry : entry))
        : [...document.entries, nextEntry];
      if (entries.length > MAX_WORKSPACES) {
        throw new WorkspaceRegistryError(
          `Workspace registry cannot contain more than ${MAX_WORKSPACES} entries.`,
          'workspace_registry_capacity'
        );
      }
      this.writeDocument(entries);
      return nextEntry;
    });
  }

  registerKnown(
    paths: readonly string[],
    activePath?: string
  ): readonly WorkspaceRegistryEntryV1[] {
    const active = activePath ? canonicalWorkspaceDirectory(activePath) : undefined;
    const canonical = [...new Set(paths.map(path => canonicalWorkspaceDirectory(path)))];
    this.ensureStorageDirectory();
    return withFileLockSync(this.storagePath, () => {
      const current = this.readDocument();
      const byPath = new Map(current.entries.map(entry => [entry.canonicalPath, entry]));
      const now = this.now().toISOString();
      for (const path of canonical) {
        const existing = byPath.get(path);
        byPath.set(
          path,
          Object.freeze({
            id: existing?.id ?? this.createId(),
            canonicalPath: path,
            label: workspaceLabel(path),
            lastActivatedAt: path === active ? now : (existing?.lastActivatedAt ?? now),
            ...(existing?.pinnedOrder !== undefined ? { pinnedOrder: existing.pinnedOrder } : {}),
          })
        );
      }
      const entries = [...byPath.values()];
      if (entries.length > MAX_WORKSPACES) {
        throw new WorkspaceRegistryError(
          `Workspace registry cannot contain more than ${MAX_WORKSPACES} entries.`,
          'workspace_registry_capacity'
        );
      }
      this.writeDocument(entries);
      return freezeEntries(entries);
    });
  }

  find(id: string): WorkspaceRegistryEntryV1 | undefined {
    return this.readDocument().entries.find(entry => entry.id === id);
  }

  setPinned(id: string, pinned: boolean): WorkspaceRegistryEntryV1 {
    this.ensureStorageDirectory();
    return withFileLockSync(this.storagePath, () => {
      const document = this.readDocument();
      const target = document.entries.find(entry => entry.id === id);
      if (!target) {
        throw new WorkspaceRegistryError('Workspace is not registered.', 'workspace_unavailable');
      }
      const currentMax = document.entries.reduce(
        (max, entry) => Math.max(max, entry.pinnedOrder ?? 0),
        0
      );
      const updated = Object.freeze({
        id: target.id,
        canonicalPath: target.canonicalPath,
        label: target.label,
        lastActivatedAt: target.lastActivatedAt,
        ...(pinned ? { pinnedOrder: target.pinnedOrder ?? currentMax + 1 } : {}),
      });
      this.writeDocument(document.entries.map(entry => (entry.id === id ? updated : entry)));
      return updated;
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

  private readDocument(): WorkspaceRegistryDocumentV1 {
    if (!existsSync(this.storagePath)) {
      return Object.freeze({ schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION, entries: [] });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as unknown;
    } catch {
      throw new WorkspaceRegistryError(
        'Workspace registry is not valid JSON.',
        'workspace_registry_invalid'
      );
    }
    return parseDocument(parsed);
  }

  private writeDocument(entries: readonly WorkspaceRegistryEntryV1[]): void {
    this.ensureStorageDirectory();
    const normalized = [...entries].sort(compareEntries).map(entry => ({ ...entry }));
    atomicWriteFileSync(
      this.storagePath,
      `${JSON.stringify({ schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION, entries: normalized }, null, 2)}\n`,
      { mode: 0o600, fsync: true }
    );
  }

  private ensureStorageDirectory(): void {
    mkdirSync(dirname(this.storagePath), { recursive: true, mode: 0o700 });
  }
}

export function canonicalWorkspaceDirectory(path: string): string {
  const absolute = resolve(path);
  try {
    const stat = statSync(absolute);
    if (!stat.isDirectory()) {
      throw new WorkspaceRegistryError(
        'Workspace path is not a directory.',
        'workspace_unavailable'
      );
    }
    return realpathSync(absolute);
  } catch (error) {
    if (error instanceof WorkspaceRegistryError) throw error;
    throw new WorkspaceRegistryError(
      'Workspace directory is unavailable.',
      'workspace_unavailable'
    );
  }
}

function parseDocument(value: unknown): WorkspaceRegistryDocumentV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidDocument();
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== WORKSPACE_REGISTRY_SCHEMA_VERSION || !Array.isArray(row.entries)) {
    return invalidDocument();
  }
  if (row.entries.length > MAX_WORKSPACES) return invalidDocument();
  const entries = row.entries.map(parseEntry);
  if (
    new Set(entries.map(entry => entry.id)).size !== entries.length ||
    new Set(entries.map(entry => entry.canonicalPath)).size !== entries.length
  ) {
    return invalidDocument();
  }
  return Object.freeze({
    schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION,
    entries: freezeEntries(entries),
  });
}

function parseEntry(value: unknown): WorkspaceRegistryEntryV1 {
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
    typeof row.lastActivatedAt !== 'string' ||
    !Number.isFinite(Date.parse(row.lastActivatedAt)) ||
    (row.pinnedOrder !== undefined &&
      (!Number.isSafeInteger(row.pinnedOrder) || Number(row.pinnedOrder) < 1))
  ) {
    return invalidDocument();
  }
  return Object.freeze({
    id: row.id,
    canonicalPath: row.canonicalPath,
    label: row.label,
    lastActivatedAt: row.lastActivatedAt,
    ...(row.pinnedOrder !== undefined ? { pinnedOrder: Number(row.pinnedOrder) } : {}),
  });
}

function invalidDocument(): never {
  throw new WorkspaceRegistryError(
    'Workspace registry document is invalid.',
    'workspace_registry_invalid'
  );
}

function compareEntries(left: WorkspaceRegistryEntryV1, right: WorkspaceRegistryEntryV1): number {
  const leftPinned = left.pinnedOrder ?? Number.MAX_SAFE_INTEGER;
  const rightPinned = right.pinnedOrder ?? Number.MAX_SAFE_INTEGER;
  if (leftPinned !== rightPinned) return leftPinned - rightPinned;
  const recent = Date.parse(right.lastActivatedAt) - Date.parse(left.lastActivatedAt);
  return recent || left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
}

function freezeEntries(
  entries: readonly WorkspaceRegistryEntryV1[]
): readonly WorkspaceRegistryEntryV1[] {
  return Object.freeze([...entries].sort(compareEntries).map(entry => Object.freeze({ ...entry })));
}

function workspaceLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, '');
  return normalized.split(/[\\/]/u).filter(Boolean).at(-1) ?? normalized;
}
