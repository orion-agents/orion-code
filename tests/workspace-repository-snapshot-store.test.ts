/**
 * v0.3.12 S2 — repository snapshot store contracts (coalescing, freshness,
 * stale-response dropping, per-workspace isolation).
 */
import {
  WorkspaceRepositorySnapshotStore,
  WorkspaceSnapshotStaleError,
  type RepositorySnapshot,
} from '../web/src/state/workspace-repository-snapshot-store';

function snapshot(
  revision: string,
  overrides: Partial<RepositorySnapshot['counts']> = {}
): RepositorySnapshot {
  return Object.freeze({
    repositoryRevision: revision,
    branch: 'main',
    counts: Object.freeze({
      totalChangedFiles: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      ...overrides,
    }),
    fetchedAt: Date.now(),
  });
}

describe('WorkspaceRepositorySnapshotStore (v0.3.12 S2)', () => {
  test('coalesces concurrent readers into one fetch per workspace', async () => {
    let calls = 0;
    const store = new WorkspaceRepositorySnapshotStore({
      fetcher: async () => {
        calls += 1;
        await new Promise(resolve => setTimeout(resolve, 20));
        return snapshot(`rev-${calls}`);
      },
    });
    const [a, b, c] = await Promise.all([
      store.getSnapshot('ws-1'),
      store.getSnapshot('ws-1'),
      store.getSnapshot('ws-1'),
    ]);
    expect(calls).toBe(1);
    expect(a.repositoryRevision).toBe('rev-1');
    expect(b.repositoryRevision).toBe('rev-1');
    expect(c.repositoryRevision).toBe('rev-1');
  });

  test('reuses a fresh snapshot and refetches after invalidation', async () => {
    let calls = 0;
    const store = new WorkspaceRepositorySnapshotStore({
      fetcher: async () => {
        calls += 1;
        return snapshot(`rev-${calls}`);
      },
      freshnessMs: 60_000,
    });
    const first = await store.getSnapshot('ws-1');
    const second = await store.getSnapshot('ws-1');
    expect(second).toBe(first);
    expect(calls).toBe(1);

    store.invalidate('ws-1');
    const third = await store.getSnapshot('ws-1');
    expect(third.repositoryRevision).toBe('rev-2');
    expect(calls).toBe(2);
  });

  test('a response that lands after invalidation is dropped as stale', async () => {
    let resolveFetch!: (value: RepositorySnapshot) => void;
    const store = new WorkspaceRepositorySnapshotStore({
      fetcher: () =>
        new Promise<RepositorySnapshot>(resolve => {
          resolveFetch = resolve;
        }),
      freshnessMs: 60_000,
    });
    const pending = store.getSnapshot('ws-1');
    store.invalidate('ws-1');
    resolveFetch(snapshot('rev-old'));
    await expect(pending).rejects.toBeInstanceOf(WorkspaceSnapshotStaleError);
    expect(store.cachedSnapshot('ws-1')).toBeNull();
  });

  test('stale markers reflect repository revision moves', async () => {
    const store = new WorkspaceRepositorySnapshotStore({
      fetcher: async () => snapshot('rev-a'),
    });
    await store.getSnapshot('ws-1');
    expect(store.isStale('ws-1', 'rev-a')).toBe(false);
    expect(store.isStale('ws-1', 'rev-b')).toBe(true);
    expect(store.isStale('ws-missing', null)).toBe(true);
  });

  test('keeps workspaces isolated and clears wholesale', async () => {
    let calls = 0;
    const store = new WorkspaceRepositorySnapshotStore({
      fetcher: async () => {
        calls += 1;
        return snapshot(`rev-${calls}`);
      },
    });
    await store.getSnapshot('ws-a');
    await store.getSnapshot('ws-b');
    expect(calls).toBe(2);
    store.invalidate('ws-a');
    expect(store.cachedSnapshot('ws-a')).toBeNull();
    expect(store.cachedSnapshot('ws-b')).not.toBeNull();
    store.clear();
    expect(store.cachedSnapshot('ws-b')).toBeNull();
  });
});
