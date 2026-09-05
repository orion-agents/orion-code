/**
 * v0.3.12 S2 — WorkspaceRepositorySnapshotStore.
 *
 * Git, Review and Files decorations consume one repository snapshot per
 * workspace so the UI never mixes counts from two repository revisions. The
 * store coalesces concurrent requests (no three parallel `git status` calls on
 * a refresh), drops stale responses after an invalidation/switch, and marks
 * snapshots stale when the repository moves on. This is browser-state logic
 * only: the host stays the revision authority.
 */
export interface RepositorySnapshot {
  readonly repositoryRevision: string;
  readonly branch: string | null;
  readonly counts: {
    readonly totalChangedFiles: number;
    readonly staged: number;
    readonly unstaged: number;
    readonly untracked: number;
    readonly conflicted: number;
  };
  readonly fetchedAt: number;
}

export interface RepositorySnapshotFetcher {
  (workspaceId: string): Promise<RepositorySnapshot>;
}

export interface WorkspaceRepositorySnapshotStoreOptions {
  readonly fetcher: RepositorySnapshotFetcher;
  /** Keep a fresh snapshot usable without a refetch (ms). Default 30s. */
  readonly freshnessMs?: number;
}

interface SnapshotSlot {
  readonly workspaceId: string;
  snapshot: RepositorySnapshot | null;
  inFlight: Promise<RepositorySnapshot> | null;
  generation: number;
  invalidated: boolean;
}

export class WorkspaceRepositorySnapshotStore {
  private readonly fetcher: RepositorySnapshotFetcher;
  private readonly freshnessMs: number;
  private readonly slots = new Map<string, SnapshotSlot>();

  constructor(options: WorkspaceRepositorySnapshotStoreOptions) {
    this.fetcher = options.fetcher;
    this.freshnessMs = options.freshnessMs ?? 30_000;
  }

  /** Snapshot for a workspace, coalescing concurrent callers and reusing fresh data. */
  getSnapshot(workspaceId: string): Promise<RepositorySnapshot> {
    const slot = this.slotFor(workspaceId);
    if (slot.invalidated) {
      // A prior invalidate() is one-shot: discard any in-flight response (its
      // generation is now stale) and accept fresh data from the next request.
      slot.inFlight = null;
      slot.invalidated = false;
    }
    const cached = slot.snapshot;
    if (cached && Date.now() - cached.fetchedAt <= this.freshnessMs) {
      return Promise.resolve(cached);
    }
    if (slot.inFlight) return slot.inFlight;
    slot.generation += 1;
    const generation = slot.generation;
    const request = this.fetcher(workspaceId)
      .then(snapshot => {
        const current = this.slots.get(workspaceId);
        if (!current || current.generation !== generation || current.invalidated) {
          throw new WorkspaceSnapshotStaleError(workspaceId);
        }
        current.snapshot = Object.freeze({ ...snapshot, fetchedAt: Date.now() });
        current.inFlight = null;
        return current.snapshot;
      })
      .catch(error => {
        const current = this.slots.get(workspaceId);
        if (current && current.inFlight === request) current.inFlight = null;
        throw error;
      });
    slot.inFlight = request;
    return request;
  }

  /**
   * Drop a cached snapshot so the next read refetches. Returns true when a
   * snapshot was actually discarded.
   */
  invalidate(workspaceId: string): boolean {
    const slot = this.slots.get(workspaceId);
    if (!slot) return false;
    const hadContent = Boolean(slot.snapshot || slot.inFlight);
    slot.invalidated = true;
    slot.snapshot = null;
    return hadContent;
  }

  /** True when a stored snapshot is absent or its repository has moved on. */
  isStale(workspaceId: string, repositoryRevision: string | null): boolean {
    const snapshot = this.slots.get(workspaceId)?.snapshot;
    if (!snapshot) return true;
    if (repositoryRevision === null || repositoryRevision === undefined) return false;
    return snapshot.repositoryRevision !== repositoryRevision;
  }

  cachedSnapshot(workspaceId: string): RepositorySnapshot | null {
    const slot = this.slots.get(workspaceId);
    if (!slot || slot.invalidated || !slot.snapshot) return null;
    return slot.snapshot;
  }

  clear(): void {
    this.slots.clear();
  }

  private slotFor(workspaceId: string): SnapshotSlot {
    const existing = this.slots.get(workspaceId);
    if (existing) return existing;
    const created: SnapshotSlot = {
      workspaceId,
      snapshot: null,
      inFlight: null,
      generation: 0,
      invalidated: false,
    };
    this.slots.set(workspaceId, created);
    return created;
  }
}

export class WorkspaceSnapshotStaleError extends Error {
  readonly code = 'workspace_snapshot_stale';
  constructor(workspaceId: string) {
    super(`Repository snapshot for ${workspaceId} is stale; refetching.`);
  }
}
