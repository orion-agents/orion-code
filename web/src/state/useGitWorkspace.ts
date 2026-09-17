/**
 * v0.3.17 S2 — Git work panel data + reading state.
 *
 * Owns the three things the panel used to keep in its own component state and therefore
 * lost whenever the dock unmounted it:
 *
 *   1. the session bucket (view, filter, selection, fold state, anchor, draft)
 *   2. the fetched Git facts (status, history, structured diff)
 *   3. the refresh policy — a *refresh* keeps the reading position, a *workspace change*
 *      switches bucket (plan §8.1, G317-03)
 *
 * Request races are handled with a generation counter plus a per-diff request token, so a
 * slow response can never overwrite a newer selection.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { requestId, type WebApiError } from '../api';
import { WorkspaceRepositorySnapshotStore } from './workspace-repository-snapshot-store';
import type {
  GitCommitPreviewV1,
  GitDiffDocumentV2,
  WebGitFileSourceV1,
  WebGitFileV1,
  WebGitLogPageV1,
  WebGitStatusV1,
} from '../types';
import type { WorkbenchActions } from '../useWorkbench';
import { appGitDiffCache, type GitDiffCache } from './git-diff-cache';
import {
  appGitPanelStore,
  defaultGitPanelSessionState,
  gitPanelScopeKey,
  loadGitDisplayPreference,
  resolveSelectionAfterRefresh,
  saveGitDisplayPreference,
  type GitDisplayPreference,
  type GitPanelSessionState,
  type GitPanelStore,
} from './git-panel-state';

/** Light poll cadence while the panel is visible (plan G1). */
const VISIBLE_POLL_MS = 2_000;

export interface GitWorkspaceModel {
  readonly session: GitPanelSessionState;
  readonly display: GitDisplayPreference;
  readonly status: WebGitStatusV1 | null;
  readonly log: WebGitLogPageV1 | null;
  readonly diff: GitDiffDocumentV2 | null;
  /** First load for this bucket; the panel shows a skeleton. */
  readonly loading: boolean;
  /** A refresh is running while old content stays on screen. */
  readonly refreshing: boolean;
  readonly error: string;
  /** True when the on-screen content predates the latest known repository revision. */
  readonly stale: boolean;
  readonly setSession: (patch: Partial<GitPanelSessionState>) => void;
  readonly setDisplay: (patch: Partial<GitDisplayPreference>) => void;
  readonly openFile: (entry: WebGitFileV1) => void;
  readonly reload: () => void;
  readonly loadMoreStatus: () => void;
  readonly loadMoreLog: () => void;
  readonly loadMoreDiff: () => void;
  readonly selectedEntry: WebGitFileV1 | null;
  /** v0.3.17 S3 — write actions. Every one is refused while another write is in flight. */
  readonly busy: boolean;
  readonly commitPreview: GitCommitPreviewV1 | null;
  readonly toggleSelection: (fileId: string) => void;
  readonly clearSelection: () => void;
  readonly stagePaths: (fileIds: readonly string[]) => Promise<void>;
  readonly unstagePaths: (fileIds: readonly string[]) => Promise<void>;
  readonly applyPatch: (input: {
    readonly fileId: string;
    readonly hunkIds?: readonly string[];
    readonly lineIds?: readonly string[];
  }) => Promise<void>;
  readonly commit: (input: { readonly summary: string; readonly body?: string }) => Promise<string>;
}

export function useGitWorkspace(input: {
  readonly workspaceId: string;
  readonly refreshEpoch: number;
  readonly actions: WorkbenchActions;
  /** Injectable for tests; the app shares the module store. */
  readonly store?: GitPanelStore;
  /** Injectable for tests; the app shares one bounded LRU. */
  readonly cache?: GitDiffCache;
}): GitWorkspaceModel {
  const { workspaceId, refreshEpoch, actions } = input;
  const store = input.store ?? appGitPanelStore;
  const cache = input.cache ?? appGitDiffCache;
  const scopeKey = gitPanelScopeKey(workspaceId);

  const [session, setSessionState] = useState<GitPanelSessionState>(() => store.read(scopeKey));
  const [display, setDisplayState] = useState<GitDisplayPreference>(() =>
    loadGitDisplayPreference()
  );
  const [status, setStatus] = useState<WebGitStatusV1 | null>(null);
  const [log, setLog] = useState<WebGitLogPageV1 | null>(null);
  const [diff, setDiff] = useState<GitDiffDocumentV2 | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);

  const generationRef = useRef(0);
  const diffTokenRef = useRef(0);
  /** Latest session, readable synchronously from async callbacks. */
  const sessionRef = useRef(session);
  sessionRef.current = session;
  /** Latest status, so `openFile` can key the cache without re-creating the callback. */
  const statusRef = useRef<WebGitStatusV1 | null>(status);
  const displayRef = useRef(display);
  displayRef.current = display;
  statusRef.current = status;

  const setSession = useCallback(
    (patch: Partial<GitPanelSessionState>) => {
      setSessionState(store.update(scopeKey, patch));
    },
    [scopeKey, store]
  );

  const setDisplay = useCallback((patch: Partial<GitDisplayPreference>) => {
    setDisplayState(current => {
      const next = Object.freeze({ ...current, ...patch });
      saveGitDisplayPreference(next);
      return next;
    });
  }, []);

  /**
   * `keepSelection` is the whole difference between a refresh and an identity change:
   * a refresh must restore the reader's position, a workspace change must not carry it over.
   */
  const load = useCallback(
    async (
      generation: number,
      options: { readonly keepSelection: boolean; readonly quiet?: boolean }
    ) => {
      if (generation !== generationRef.current) return;
      if (options.quiet) setRefreshing(true);
      else setLoading(true);
      setError('');
      try {
        const current = sessionRef.current;
        const [nextStatus, nextLog] = await Promise.all([
          actions.gitStatus(undefined, {
            ...(current.group ? { group: current.group } : {}),
            ...(current.query ? { query: current.query } : {}),
          }),
          actions.gitLog(),
        ]);
        if (generation !== generationRef.current) return;
        setStatus(nextStatus);
        setLog(nextLog);

        if (!nextStatus.hasWorktree) {
          // v0.3.19 (G317-22) — a bare repository is a repository but has no working tree, so
          // nothing here is selectable. Gating on `isRepository` alone would have walked into
          // this branch with an empty list and reported it as "you have nothing to stage"
          // rather than "there is nothing to read here".
          setDiff(null);
          setStale(false);
          return;
        }

        const entries = flattenEntries(nextStatus);
        if (!options.keepSelection) {
          setDiff(null);
          setSession({ selectedFileId: null, selectedSource: null, anchorLineId: null });
          setStale(false);
          return;
        }

        const previousFileId = current.selectedFileId;
        const previousPath =
          entries.find(entry => entry.fileId === previousFileId)?.path ?? (diff ? diff.path : null);
        const repaired = resolveSelectionAfterRefresh({
          entries,
          previousFileId,
          previousPath,
        });
        if (repaired.fileId && repaired.fileId !== previousFileId) {
          // Re-select rather than leaving the reader on a diff that no longer applies.
          setSession({
            selectedFileId: null,
            selectedSource: null,
            notice: repaired.notice,
          });
          setDiff(null);
          setStale(false);
          return;
        }
        if (previousFileId) {
          // Same selection: keep the rendered document and mark it as possibly outdated
          // instead of blanking the pane.
          const stillValid =
            diff !== null && nextStatus.repositoryRevision === diff.repositoryRevision;
          setStale(!stillValid);
        } else {
          setStale(false);
        }
      } catch (caught) {
        if (generation !== generationRef.current) return;
        setError(messageOf(caught));
      } finally {
        if (generation === generationRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [actions, diff, setSession]
  );

  const reload = useCallback(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    diffTokenRef.current += 1;
    void load(generation, { keepSelection: true, quiet: status !== null });
  }, [load, status]);

  // Identity change resets the bucket; refresh only re-reads data.
  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    diffTokenRef.current += 1;
    setStatus(null);
    setLog(null);
    setDiff(null);
    setError('');
    setStale(false);
    setLoading(Boolean(workspaceId));
    setSessionState(store.read(scopeKey));
    if (workspaceId) {
      void load(generation, { keepSelection: false });
    } else {
      setLoading(false);
    }
    // `load` is intentionally out of the dep list: it changes with the rendered diff and
    // re-running this effect on every diff load would defeat the generation guard.
  }, [scopeKey, workspaceId, store]);

  useEffect(() => {
    if (!workspaceId || refreshEpoch === 0) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    diffTokenRef.current += 1;
    void load(generation, { keepSelection: true, quiet: true });
  }, [refreshEpoch]);

  // Visible-only light poll: hidden panels must not keep asking the Host.
  useEffect(() => {
    if (!workspaceId || typeof document === 'undefined') return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      timer = setInterval(() => {
        const generation = generationRef.current + 1;
        generationRef.current = generation;
        void load(generation, { keepSelection: true, quiet: true });
      }, VISIBLE_POLL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Catch up once on becoming visible, then resume the cadence.
        const generation = generationRef.current + 1;
        generationRef.current = generation;
        void load(generation, { keepSelection: true, quiet: true });
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [workspaceId, session.group, session.query]);

  const openFile = useCallback(
    (entry: WebGitFileV1) => {
      const token = diffTokenRef.current + 1;
      diffTokenRef.current = token;
      setSession({
        selectedLineIds: [],
        selectedFileId: entry.fileId,
        selectedSource: entry.source,
        anchorLineId: null,
        notice: '',
      });
      setError('');

      // A cached document for the same repository revision is served without a request.
      // This is the difference between a §9 pass and ~2x over budget on file switching.
      const revision = statusRef.current?.repositoryRevision;
      const cached = revision ? cache.read(revision, entry.fileId) : null;
      if (cached) {
        setDiff(cached);
        setStale(false);
        setLoading(false);
        return;
      }

      setDiff(null);
      setLoading(true);
      void (async () => {
        try {
          const document = await actions.gitDiffDocument(
            entry.fileId,
            undefined,
            displayRef.current.ignoreWhitespace,
            displayRef.current.wordDiff
          );
          // v0.3.19 (G317-03/G317-20) — only a newer *selection* supersedes this read.
          //
          // The generation guard used to drop the document whenever any refresh had happened
          // in the meantime, including the 2s visible poll. That silently produced a blank
          // reading pane with a file still selected: the read was abandoned, nothing re-issued
          // it, and `diff` stayed null. A repository refresh is not a competing read of this
          // file, and the document states the revision it was rendered against, so accepting it
          // and letting `stale` tell the truth is both safer and correct.
          if (token !== diffTokenRef.current) return;
          cache.write(document.repositoryRevision, entry.fileId, document);
          setDiff(document);
          setStale(document.repositoryRevision !== statusRef.current?.repositoryRevision);
        } catch (caught) {
          if (token !== diffTokenRef.current) return;
          if (isRevisionConflict(caught)) {
            setError('仓库已变化，已重新载入 Git 状态。');
            setSession({ selectedFileId: null, selectedSource: null });
            return;
          }
          setError(messageOf(caught));
        } finally {
          if (token === diffTokenRef.current) setLoading(false);
        }
      })();
    },
    [actions, cache, setSession]
  );

  const loadMoreStatus = useCallback(() => {
    const cursor = status?.nextCursor;
    if (!cursor) return;
    const generation = generationRef.current;
    const revision = status?.repositoryRevision;
    void (async () => {
      try {
        const page = await actions.gitStatus(cursor, {
          ...(session.group ? { group: session.group } : {}),
          ...(session.query ? { query: session.query } : {}),
        });
        if (generation !== generationRef.current) return;
        if (revision !== undefined && page.repositoryRevision !== revision) {
          setError('仓库已变化，已重新载入 Git 状态。');
          return;
        }
        setStatus(current =>
          !current
            ? current
            : {
                ...page,
                conflicted: mergeByFileId(current.conflicted, page.conflicted),
                staged: mergeByFileId(current.staged, page.staged),
                unstaged: mergeByFileId(current.unstaged, page.unstaged),
                untracked: mergeByFileId(current.untracked, page.untracked),
                counts: { ...page.counts, loaded: current.counts.loaded + page.counts.loaded },
              }
        );
      } catch (caught) {
        if (generation !== generationRef.current) return;
        setError(messageOf(caught));
      }
    })();
  }, [actions, session.group, session.query, status]);

  const loadMoreLog = useCallback(() => {
    const cursor = log?.nextCursor;
    if (!cursor) return;
    const generation = generationRef.current;
    void (async () => {
      try {
        const page = await actions.gitLog(cursor);
        if (generation !== generationRef.current) return;
        setLog(current =>
          !current ? current : { ...page, items: mergeCommits(current.items, page.items) }
        );
      } catch (caught) {
        if (generation !== generationRef.current) return;
        setError(messageOf(caught));
      }
    })();
  }, [actions, log]);

  const loadMoreDiff = useCallback(() => {
    const cursor = diff?.nextCursor;
    const fileId = session.selectedFileId;
    if (!cursor || !fileId) return;
    const generation = generationRef.current;
    const token = diffTokenRef.current;
    void (async () => {
      try {
        const next = await actions.gitDiffDocument(
          fileId,
          cursor,
          displayRef.current.ignoreWhitespace,
          displayRef.current.wordDiff
        );
        if (generation !== generationRef.current || token !== diffTokenRef.current) return;
        setDiff(current =>
          !current ? next : { ...next, hunks: [...current.hunks, ...next.hunks] }
        );
      } catch (caught) {
        if (generation !== generationRef.current || token !== diffTokenRef.current) return;
        setError(messageOf(caught));
      }
    })();
  }, [actions, diff, session.selectedFileId]);

  // If a filter change left the selection outside the result set, repair it eagerly.
  useEffect(() => {
    if (!status || !session.selectedFileId) return;
    const entries = flattenEntries(status);
    if (entries.some(entry => entry.fileId === session.selectedFileId)) return;
    setDiff(null);
    setSession({ selectedFileId: null, selectedSource: null, anchorLineId: null });
  }, [status, session.selectedFileId, setSession]);

  const selectedEntry = useMemo(() => {
    if (!status || !session.selectedFileId) return null;
    return flattenEntries(status).find(entry => entry.fileId === session.selectedFileId) ?? null;
  }, [status, session.selectedFileId]);

  // ---------------------------------------------------------------------------------------
  // v0.3.17 S3 — writes
  //
  // Every write is bound to the revision the reader is looking at, so a stale click is
  // refused by the Host rather than applied to a repository that has moved on. After a
  // successful write the change list is re-read and the document cache entry for that
  // comparison is dropped, because the index it was rendered against no longer exists.
  // ---------------------------------------------------------------------------------------
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<GitCommitPreviewV1 | null>(null);

  /**
   * v0.3.17 S3 — shared snapshot store, finally in production.
   *
   * It owns one job: answering "has this repository moved since what I am reading?" without
   * every caller issuing its own status request. Concurrent checks coalesce into one fetch and
   * a fresh answer is reused, which is exactly what a focus or panel-reactivation burst needs.
   * The fetcher reads the whole status (no group/query filter) because the summary describes
   * the repository, not whichever slice the change list is filtered to.
   */
  const snapshotStoreRef = useRef<WorkspaceRepositorySnapshotStore | null>(null);
  if (snapshotStoreRef.current === null) {
    snapshotStoreRef.current = new WorkspaceRepositorySnapshotStore({
      fetcher: async workspaceId => {
        void workspaceId;
        const status = await actions.gitStatus(undefined, {});
        return Object.freeze({
          repositoryRevision: status.repositoryRevision,
          branch: status.branch,
          counts: Object.freeze({
            totalChangedFiles: status.counts.total,
            staged: status.counts.staged,
            unstaged: status.counts.unstaged,
            untracked: status.counts.untracked,
            conflicted: status.counts.conflicted,
          }),
          fetchedAt: Date.now(),
        });
      },
    });
  }
  const snapshotStore = snapshotStoreRef.current;

  /**
   * Focus / reactivation probe. Returns without touching anything when the revision is
   * unchanged; reloads quietly when it moved, keeping the reader's position.
   */
  const checkForRepositoryChange = useCallback(async () => {
    const current = statusRef.current;
    // v0.3.19 (G317-22) — only a worktree-backed repository has a revision that writes can
    // move, so a bare repository must not be polled for changes it cannot have.
    if (!current?.hasWorktree) return;
    try {
      const summary = await snapshotStore.getSnapshot(workspaceId);
      if (summary.repositoryRevision === current.repositoryRevision) return;
      snapshotStore.invalidate(workspaceId);
      await load(generationRef.current, { keepSelection: true, quiet: true });
    } catch {
      // A probe that fails must not surface as an error banner: the next real load will.
    }
  }, [load, snapshotStore, workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    let inFlight = false;
    const probe = () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      void checkForRepositoryChange().finally(() => {
        inFlight = false;
      });
    };
    const onVisibility = () => {
      if (!document.hidden) probe();
    };
    window.addEventListener('focus', probe);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', probe);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [checkForRepositoryChange, workspaceId]);

  const refreshAfterWrite = useCallback(async () => {
    cache.clear();
    // Plan §10 S3 — the shared snapshot store is now the thing that owns freshness: a write
    // must invalidate the cached repository summary, otherwise a subsequent focus check would
    // reuse the pre-write revision and conclude that nothing changed.
    snapshotStore.invalidate(workspaceId);
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    diffTokenRef.current += 1;
    await load(generation, { keepSelection: true, quiet: true });
  }, [cache, load, snapshotStore, workspaceId]);

  const runWrite = useCallback(
    async (operation: () => Promise<unknown>, successNote: string) => {
      if (busy) return;
      setBusy(true);
      setError('');
      try {
        await operation();
        await refreshAfterWrite();
        setSession({ notice: successNote });
      } catch (caught) {
        setError(messageOf(caught));
      } finally {
        setBusy(false);
      }
    },
    [busy, refreshAfterWrite, setSession]
  );

  const stagePaths = useCallback(
    async (fileIds: readonly string[]) => {
      const revision = statusRef.current?.repositoryRevision;
      if (!revision) return;
      await runWrite(
        () => actions.gitStage(fileIds, revision),
        fileIds.length > 1 ? `已暂存 ${fileIds.length} 个文件。` : '已暂存。'
      );
      setSession({ selectedFileIds: [] });
    },
    [actions, runWrite, setSession]
  );

  const unstagePaths = useCallback(
    async (fileIds: readonly string[]) => {
      const revision = statusRef.current?.repositoryRevision;
      if (!revision) return;
      await runWrite(
        () => actions.gitUnstage(fileIds, revision),
        fileIds.length > 1 ? `已取消暂存 ${fileIds.length} 个文件。` : '已取消暂存。'
      );
      setSession({ selectedFileIds: [] });
    },
    [actions, runWrite, setSession]
  );

  const applyPatch = useCallback(
    async (input: {
      readonly fileId: string;
      readonly hunkIds?: readonly string[];
      readonly lineIds?: readonly string[];
    }) => {
      const revision = statusRef.current?.repositoryRevision;
      if (!revision) return;
      await runWrite(
        () => actions.gitApplyPatch({ ...input, expectedRepositoryRevision: revision }),
        '已应用所选改动到索引。'
      );
    },
    [actions, runWrite]
  );

  const commit = useCallback(
    async (input: { readonly summary: string; readonly body?: string }) => {
      const revision = statusRef.current?.repositoryRevision;
      if (!revision) throw new Error('Git repository is unavailable.');
      setBusy(true);
      setError('');
      // A commit gets a client-minted UUID so a retry after a timeout can be answered from
      // the Host idempotency ledger instead of replaying the commit blindly. It must be a
      // real UUID: the Host validates it, and a hand-rolled id is rejected before any work.
      const id = requestId();
      try {
        const outcome = await actions.gitCommit({
          summary: input.summary,
          ...(input.body ? { body: input.body } : {}),
          expectedRepositoryRevision: revision,
          requestId: id,
        });
        await refreshAfterWrite();
        // The draft is only cleared once Git confirms a new HEAD exists.
        setSession({
          commitDraft: { summary: '', body: '' },
          notice: outcome.warning
            ? `已提交 ${outcome.commitSha.slice(0, 8)}，但：${outcome.warning}`
            : `已提交 ${outcome.commitSha.slice(0, 8)}。`,
        });
        return outcome.commitSha;
      } catch (caught) {
        // A failed commit keeps the draft: the reason is shown, the text is not lost.
        setError(messageOf(caught));
        throw caught;
      } finally {
        setBusy(false);
      }
    },
    [actions, refreshAfterWrite, setSession]
  );

  const toggleSelection = useCallback(
    (fileId: string) => {
      const current = sessionRef.current.selectedFileIds;
      setSession({
        selectedFileIds: current.includes(fileId)
          ? current.filter(id => id !== fileId)
          : [...current, fileId],
      });
    },
    [setSession]
  );

  const clearSelection = useCallback(() => setSession({ selectedFileIds: [] }), [setSession]);

  // The commit form must describe the real index, so the preview is re-read whenever the
  // repository moves — independent of whatever the change list is filtered to.
  useEffect(() => {
    // v0.3.19 (G317-22) — the commit form describes an index, and a bare repository has none.
    if (!status?.hasWorktree) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const next = await actions.gitCommitPreview();
        if (!cancelled) setPreview(next);
      } catch {
        if (!cancelled) setPreview(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actions, status?.hasWorktree, status?.repositoryRevision]);

  return {
    session,
    display,
    status,
    log,
    diff,
    loading,
    refreshing,
    error,
    stale,
    setSession,
    setDisplay,
    openFile,
    reload,
    loadMoreStatus,
    loadMoreLog,
    loadMoreDiff,
    selectedEntry,
    busy,
    commitPreview: preview,
    toggleSelection,
    clearSelection,
    stagePaths,
    unstagePaths,
    applyPatch,
    commit,
  };
}

/** Plan order: conflicts, then worktree edits, then index, then untracked. */
export function flattenEntries(status: WebGitStatusV1): readonly WebGitFileV1[] {
  return [...status.conflicted, ...status.unstaged, ...status.staged, ...status.untracked];
}

export function entriesForSource(
  status: WebGitStatusV1,
  source: WebGitFileSourceV1
): readonly WebGitFileV1[] {
  if (source === 'conflict') return status.conflicted;
  if (source === 'unstaged') return status.unstaged;
  if (source === 'staged') return status.staged;
  return status.untracked;
}

function mergeByFileId(
  current: readonly WebGitFileV1[],
  next: readonly WebGitFileV1[]
): readonly WebGitFileV1[] {
  const byId = new Map(current.map(entry => [entry.fileId, entry]));
  for (const entry of next) byId.set(entry.fileId, entry);
  return [...byId.values()];
}

function mergeCommits(
  current: readonly WebGitLogPageV1['items'][number][],
  next: readonly WebGitLogPageV1['items'][number][]
): readonly WebGitLogPageV1['items'][number][] {
  const byId = new Map(current.map(item => [item.id, item]));
  for (const item of next) byId.set(item.id, item);
  return [...byId.values()];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Git 请求失败。';
}

function isRevisionConflict(error: unknown): error is WebApiError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: string }).code === 'git_revision_conflict'
  );
}

/** Exported for tests that need a clean bucket without a renderer. */
export { defaultGitPanelSessionState };
