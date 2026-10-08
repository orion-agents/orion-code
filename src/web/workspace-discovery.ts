/**
 * v0.3.21 — bounded, cancellable project discovery inside a user-authorized
 * root directory.
 *
 * Discovery is a read-only hint, never a truth: it enumerates directory entries
 * and checks for the existence of a small, fixed set of project markers, and it
 * never reads file contents, follows symlinks, leaves the root, registers a
 * workspace, or activates a Context. Every scan is bounded by depth, directory
 * entries, candidates and a wall-clock budget; when a budget is exhausted the
 * scan returns the candidates found so far with `status: 'partial'` instead of
 * pretending the result is complete.
 *
 * Telemetry is sanitized by construction: traces carry operation, outcome,
 * duration, counts and error codes only — never a path, a label, a marker name
 * or file content.
 */
import { readdir, stat } from 'fs/promises';
import type { Dirent } from 'fs';
import { join } from 'path';

import type { WorkspaceRootEntryV1 } from '../services/workspace-roots-registry';

/** Scan bounds. Centralized so tests can inject exact values. */
export interface WorkspaceDiscoveryLimitsV1 {
  /** How deep below the root the scan walks (the root itself is depth 0). */
  readonly maxDepth: number;
  /** How many candidates may be reported. */
  readonly maxCandidates: number;
  /** How many directory entries may be inspected at all. */
  readonly maxEntries: number;
  /** Wall-clock budget for one scan. */
  readonly budgetMs: number;
  /** How long a cached scan result may be reused. */
  readonly cacheTtlMs: number;
}

export const WORKSPACE_DISCOVERY_LIMITS_V1: WorkspaceDiscoveryLimitsV1 = Object.freeze({
  maxDepth: 2,
  maxCandidates: 200,
  maxEntries: 500,
  budgetMs: 750,
  cacheTtlMs: 60_000,
});

export type WorkspaceDiscoveryHint = 'git' | 'manifest';

export interface WorkspaceDiscoveryCandidateV1 {
  readonly rootId: string;
  /** Root-relative POSIX-style path ('' for the root itself). */
  readonly relativePath: string;
  readonly label: string;
  readonly hint: WorkspaceDiscoveryHint;
  /** 'partial' when the scan stopped early (budget exhausted). */
  readonly status: 'ready' | 'partial';
}

export type WorkspaceDiscoveryErrorCode =
  | 'root_missing'
  | 'root_unreadable'
  | 'budget_exceeded'
  | 'scan_cancelled'
  | 'scan_failed';

export interface WorkspaceDiscoveryOutcomeV1 {
  readonly rootId: string;
  readonly candidates: readonly WorkspaceDiscoveryCandidateV1[];
  readonly status: 'ready' | 'partial';
  readonly errorCode?: WorkspaceDiscoveryErrorCode;
  readonly durationMs: number;
  readonly scannedEntries: number;
}

export interface WorkspaceDiscoveryOptions {
  readonly root: WorkspaceRootEntryV1;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly limits?: Partial<WorkspaceDiscoveryLimitsV1>;
}

export type WorkspaceDiscoveryOutcomeCode = 'success' | 'partial' | 'cancelled' | 'failed';

export interface WorkspaceDiscoveryTraceV1 {
  readonly operation: 'discover';
  readonly outcome: WorkspaceDiscoveryOutcomeCode;
  readonly durationMs: number;
  readonly candidateCount: number;
  readonly scannedEntries: number;
  readonly partial: boolean;
  readonly errorCode?: WorkspaceDiscoveryErrorCode;
}

export interface WorkspaceDiscoveryTelemetrySnapshotV1 {
  readonly retained: number;
  readonly limit: number;
  readonly recent: readonly WorkspaceDiscoveryTraceV1[];
}

export class WorkspaceDiscoveryTelemetryV1 {
  private readonly limit: number;
  private readonly entries: WorkspaceDiscoveryTraceV1[] = [];

  constructor(readonly options: { limit?: number } = {}) {
    this.limit = Math.max(1, options.limit ?? 50);
  }

  record(trace: WorkspaceDiscoveryTraceV1): void {
    this.entries.push(trace);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
  }

  snapshot(): WorkspaceDiscoveryTelemetrySnapshotV1 {
    return Object.freeze({
      retained: this.entries.length,
      limit: this.limit,
      recent: Object.freeze([...this.entries]),
    });
  }
}

const IGNORED_DIRECTORY_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.git',
  'cache',
  'Cache',
  '.cache',
  '.venv',
  'venv',
  'target',
  'vendor',
  '__pycache__',
]);

const PROJECT_MARKERS: ReadonlyMap<string, WorkspaceDiscoveryHint> = new Map([
  ['.git', 'git'],
  ['package.json', 'manifest'],
  ['pyproject.toml', 'manifest'],
  ['go.mod', 'manifest'],
  ['Cargo.toml', 'manifest'],
  ['pom.xml', 'manifest'],
]);

export interface WorkspaceDiscoveryServiceOptions {
  readonly telemetry?: WorkspaceDiscoveryTelemetryV1;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
}

interface CacheEntry {
  readonly outcome: WorkspaceDiscoveryOutcomeV1;
  readonly recordedAt: number;
}

/**
 * Owns discovery runs: one bounded scan per call, a per-root result cache with
 * a short TTL, and sanitized telemetry. The service holds no Context or
 * Runtime authority; callers must still inspect a candidate before activating
 * it.
 */
export class WorkspaceDiscoveryServiceV1 {
  private readonly telemetry?: WorkspaceDiscoveryTelemetryV1;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: WorkspaceDiscoveryServiceOptions = {}) {
    this.telemetry = options.telemetry;
    this.now = options.now ?? (() => performance.now());
    this.cacheTtlMs = options.cacheTtlMs ?? WORKSPACE_DISCOVERY_LIMITS_V1.cacheTtlMs;
  }

  /** A cached outcome younger than the TTL, or undefined. Never a truth. */
  cached(rootId: string): WorkspaceDiscoveryOutcomeV1 | undefined {
    const entry = this.cache.get(rootId);
    if (!entry) return undefined;
    if (this.now() - entry.recordedAt > this.cacheTtlMs) {
      this.cache.delete(rootId);
      return undefined;
    }
    return entry.outcome;
  }

  /** Drop the cached result for one root or for every root. */
  invalidate(rootId?: string): void {
    if (rootId === undefined) this.cache.clear();
    else this.cache.delete(rootId);
  }

  async discover(options: WorkspaceDiscoveryOptions): Promise<WorkspaceDiscoveryOutcomeV1> {
    const startedAt = this.now();
    const { root, signal } = options;
    const limits = { ...WORKSPACE_DISCOVERY_LIMITS_V1, ...options.limits };
    try {
      const outcome = await this.scan(root, signal, limits, startedAt);
      this.cache.set(root.id, { outcome, recordedAt: this.now() });
      this.telemetry?.record({
        operation: 'discover',
        outcome: outcome.status === 'ready' ? 'success' : 'partial',
        durationMs: outcome.durationMs,
        candidateCount: outcome.candidates.length,
        scannedEntries: outcome.scannedEntries,
        partial: outcome.status === 'partial',
        ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      });
      return outcome;
    } catch (error) {
      const cancelled =
        signal?.aborted === true ||
        (error instanceof Error && error.name === 'AbortError') ||
        error instanceof DiscoveryCancelledError;
      const errorCode: WorkspaceDiscoveryErrorCode = cancelled
        ? 'scan_cancelled'
        : error instanceof DiscoveryError
          ? error.code
          : 'scan_failed';
      const durationMs = Math.max(0, Math.round(this.now() - startedAt));
      this.telemetry?.record({
        operation: 'discover',
        outcome: cancelled ? 'cancelled' : 'failed',
        durationMs,
        candidateCount: 0,
        scannedEntries: 0,
        partial: false,
        errorCode,
      });
      if (cancelled) {
        return {
          rootId: root.id,
          candidates: [],
          status: 'partial',
          errorCode: 'scan_cancelled',
          durationMs,
          scannedEntries: 0,
        };
      }
      // Actionable failures (missing/unreadable root, mid-scan errors) are
      // outcomes, not exceptions: the client shows a status with an action,
      // and the telemetry ring keeps a sanitized trace.
      if (error instanceof DiscoveryError) {
        return {
          rootId: root.id,
          candidates: [],
          status: 'partial',
          errorCode: error.code,
          durationMs,
          scannedEntries: 0,
        };
      }
      throw error;
    }
  }

  private async scan(
    root: WorkspaceRootEntryV1,
    signal: AbortSignal | undefined,
    limits: WorkspaceDiscoveryLimitsV1,
    startedAt: number
  ): Promise<WorkspaceDiscoveryOutcomeV1> {
    const candidates: WorkspaceDiscoveryCandidateV1[] = [];
    let scannedEntries = 0;
    let partial = false;
    let errorCode: WorkspaceDiscoveryErrorCode | undefined;

    const throwIfCancelled = (): void => {
      if (signal?.aborted) throw new DiscoveryCancelledError();
    };

    const remainingBudget = (): number => limits.budgetMs - Math.round(this.now() - startedAt);

    const walk = async (relativePath: string, depth: number): Promise<void> => {
      throwIfCancelled();
      if (remainingBudget() <= 0) {
        partial = true;
        errorCode = 'budget_exceeded';
        return;
      }
      if (candidates.length >= limits.maxCandidates || scannedEntries >= limits.maxEntries) {
        partial = true;
        errorCode = 'budget_exceeded';
        return;
      }
      const absolutePath = join(root.canonicalPath, relativePath);
      let entries: Dirent[] = [];
      try {
        entries = await readdir(absolutePath, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (depth === 0) {
          throw new DiscoveryError(
            code === 'ENOENT'
              ? 'The root directory no longer exists.'
              : 'The root directory is not readable.',
            code === 'ENOENT' ? 'root_missing' : 'root_unreadable'
          );
        }
        // A nested unreadable directory is not fatal: skip it and keep going.
        if (code !== 'EACCES' && code !== 'EPERM') {
          partial = true;
          errorCode = 'scan_failed';
        }
        return;
      }
      scannedEntries += 1;
      // walk() is only called for directories that were already checked to
      // carry no marker (the root excepted — it is always walked so the user's
      // authorized boundary is searched even when it is itself a project).
      const subdirectories: string[] = [];
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          !IGNORED_DIRECTORY_NAMES.has(entry.name)
        ) {
          subdirectories.push(entry.name);
        }
      }
      for (const name of subdirectories) {
        throwIfCancelled();
        if (candidates.length >= limits.maxCandidates || scannedEntries >= limits.maxEntries) {
          partial = true;
          errorCode = 'budget_exceeded';
          return;
        }
        const childRelative = relativePath ? `${relativePath}/${name}` : name;
        const childAbsolute = join(root.canonicalPath, childRelative);
        let childMarker: WorkspaceDiscoveryHint | undefined;
        try {
          // stat (not lstat): a symlinked marker would resolve, but directory
          // symlinks themselves are skipped below without following.
          const childStat = await stat(childAbsolute);
          if (!childStat.isDirectory()) continue;
          const childEntries = await readdir(childAbsolute, { withFileTypes: true });
          scannedEntries += 1;
          for (const childEntry of childEntries) {
            if (PROJECT_MARKERS.has(childEntry.name)) {
              childMarker = PROJECT_MARKERS.get(childEntry.name);
              break;
            }
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | undefined)?.code;
          if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') continue;
          partial = true;
          errorCode = 'scan_failed';
          continue;
        }
        if (childMarker) {
          candidates.push(
            Object.freeze({
              rootId: root.id,
              relativePath: childRelative,
              label: name,
              hint: childMarker,
              status: 'ready' as const,
            })
          );
        } else if (depth + 1 < limits.maxDepth) {
          await walk(childRelative, depth + 1);
        }
      }
    };

    // The root itself is a candidate when it carries a marker (depth 0).
    let rootHint: WorkspaceDiscoveryHint | undefined;
    try {
      const rootEntries = await readdir(root.canonicalPath, { withFileTypes: true });
      scannedEntries += 1;
      for (const entry of rootEntries) {
        if (PROJECT_MARKERS.has(entry.name)) {
          rootHint = PROJECT_MARKERS.get(entry.name);
          break;
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      throw new DiscoveryError(
        code === 'ENOENT'
          ? 'The root directory no longer exists.'
          : 'The root directory is not readable.',
        code === 'ENOENT' ? 'root_missing' : 'root_unreadable'
      );
    }
    if (rootHint) {
      candidates.push(
        Object.freeze({
          rootId: root.id,
          relativePath: '',
          label: root.label,
          hint: rootHint,
          status: 'ready' as const,
        })
      );
    }
    await walk('', 0);
    throwIfCancelled();
    if (remainingBudget() <= 0) {
      partial = true;
      errorCode = 'budget_exceeded';
    }
    return Object.freeze({
      rootId: root.id,
      candidates: Object.freeze(candidates),
      status: partial ? ('partial' as const) : ('ready' as const),
      ...(partial && errorCode ? { errorCode } : {}),
      durationMs: Math.max(0, Math.round(this.now() - startedAt)),
      scannedEntries,
    });
  }
}

class DiscoveryError extends Error {
  constructor(
    message: string,
    readonly code: Extract<
      WorkspaceDiscoveryErrorCode,
      'root_missing' | 'root_unreadable' | 'scan_failed'
    >
  ) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

class DiscoveryCancelledError extends Error {
  constructor() {
    super('Workspace discovery was cancelled.');
    this.name = 'DiscoveryCancelledError';
  }
}
