/**
 * v0.3.17 S4 — history view data.
 *
 * Reading only. Nothing here can reach the mutation path, which is what makes "browsing
 * history never writes to the workspace" a structural property (plan §10 S4).
 *
 * Two rules from plan G4 shape the state handling:
 *   - the selected commit is an **immutable oid**, never an index into the current page, so a
 *     refreshed or extended history cannot silently move the selection to another commit;
 *   - the change list and the history list have independent loading/error state, so a slow
 *     history query never blanks the change list.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { WebApiError } from '../api';
import type {
  GitCommitDetailV1,
  GitCommitFilesV1,
  GitDiffDocumentV2,
  GitFileHistoryPageV1,
  GitHistoryPageV1,
  GitRefsV1,
} from '../types';
import type { WorkbenchActions } from '../useWorkbench';
import {
  defaultGitHistoryFilterState,
  type GitHistoryFilterState,
  type GitPanelSessionState,
} from './git-panel-state';

/** Typing should not fire a query per keystroke; the Host also caps search length. */
const SEARCH_DEBOUNCE_MS = 350;
const HISTORY_PAGE_SIZE = 30;

export interface GitHistoryModel {
  readonly query: GitHistoryFilterState;
  readonly refs: GitRefsV1 | null;
  readonly page: GitHistoryPageV1 | null;
  readonly detail: GitCommitDetailV1 | null;
  readonly files: GitCommitFilesV1 | null;
  readonly diff: GitDiffDocumentV2 | null;
  readonly fileHistory: GitFileHistoryPageV1 | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly loadingDetail: boolean;
  readonly error: string;
  readonly isEmptyRepository: boolean;
  readonly setQuery: (patch: Partial<GitHistoryFilterState>) => void;
  readonly resetQuery: () => void;
  readonly selectCommit: (commit: { readonly id: string }) => void;
  readonly closeDetail: () => void;
  readonly setParentIndex: (parentIndex: number) => void;
  readonly selectFile: (path: string) => void;
  readonly loadMore: () => void;
  readonly openFileHistory: (path: string) => void;
  readonly closeFileHistory: () => void;
}

export function useGitHistory(input: {
  readonly workspaceId: string;
  readonly enabled: boolean;
  readonly session: GitPanelSessionState;
  readonly setSession: (patch: Partial<GitPanelSessionState>) => void;
  readonly actions: WorkbenchActions;
  /** Bumped after a write so history reflects the new HEAD. */
  readonly refreshEpoch: number;
}): GitHistoryModel {
  const { enabled, session, setSession, actions, refreshEpoch } = input;
  const query = session.historyQuery ?? defaultGitHistoryFilterState;

  const [refs, setRefs] = useState<GitRefsV1 | null>(null);
  const [page, setPage] = useState<GitHistoryPageV1 | null>(null);
  const [detail, setDetail] = useState<GitCommitDetailV1 | null>(null);
  const [files, setFiles] = useState<GitCommitFilesV1 | null>(null);
  const [diff, setDiff] = useState<GitDiffDocumentV2 | null>(null);
  const [fileHistory, setFileHistory] = useState<GitFileHistoryPageV1 | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState('');

  /** Monotonic token: only the newest list response may land. */
  const listToken = useRef(0);
  const detailToken = useRef(0);

  const trimmed = useMemo(
    () => ({
      ...(query.message.trim() ? { message: query.message.trim() } : {}),
      ...(query.author.trim() ? { author: query.author.trim() } : {}),
      ...(query.path.trim() ? { path: query.path.trim() } : {}),
      ...(query.sha.trim() ? { sha: query.sha.trim() } : {}),
      ...(query.since.trim() ? { since: query.since.trim() } : {}),
      ...(query.until.trim() ? { until: query.until.trim() } : {}),
    }),
    [query]
  );

  // ---------------------------------------------------------------------------------------
  // Refs and the first page.
  // ---------------------------------------------------------------------------------------
  useEffect(() => {
    if (!enabled) return;
    const token = listToken.current + 1;
    listToken.current = token;
    setLoading(true);
    setError('');
    const timer = setTimeout(
      () => {
        void (async () => {
          try {
            const [nextRefs, nextPage] = await Promise.all([
              actions.gitRefs(),
              actions.gitHistory({ ...trimmed, pageSize: HISTORY_PAGE_SIZE }),
            ]);
            if (token !== listToken.current) return;
            setRefs(nextRefs);
            setPage(nextPage);
          } catch (caught) {
            if (token !== listToken.current) return;
            setError(messageOf(caught));
          } finally {
            if (token === listToken.current) setLoading(false);
          }
        })();
      },
      // The read is debounced, so the token is already reserving this generation and any
      // earlier in-flight response is discarded rather than racing the new one.
      trimmed.message || trimmed.author || trimmed.path || trimmed.sha ? SEARCH_DEBOUNCE_MS : 0
    );
    return () => clearTimeout(timer);
  }, [actions, enabled, refreshEpoch, trimmed]);

  // ---------------------------------------------------------------------------------------
  // Commit detail, its files, and the selected file's diff inside that commit.
  // ---------------------------------------------------------------------------------------
  useEffect(() => {
    const oid = session.selectedCommitId;
    if (!enabled || !oid) {
      setDetail(null);
      setFiles(null);
      setDiff(null);
      return;
    }
    const token = detailToken.current + 1;
    detailToken.current = token;
    const parentIndex = session.selectedCommitParentIndex;
    setLoadingDetail(true);
    setError('');
    void (async () => {
      try {
        const [nextDetail, nextFiles] = await Promise.all([
          actions.gitCommitDetail(oid, parentIndex),
          actions.gitCommitFiles(oid, parentIndex),
        ]);
        if (token !== detailToken.current) return;
        setDetail(nextDetail);
        setFiles(nextFiles);
        // Auto-open the first readable file so the pane is never a dead end.
        const first = nextFiles.files.find(file => !file.sensitive && !file.binary);
        const wanted =
          session.selectedCommitPath && nextFiles.files.some(f => f.path === session.selectedCommitPath)
            ? session.selectedCommitPath
            : (first?.path ?? null);
        if (wanted !== session.selectedCommitPath) setSession({ selectedCommitPath: wanted });
        if (!wanted) setDiff(null);
      } catch (caught) {
        if (token !== detailToken.current) return;
        setError(messageOf(caught));
      } finally {
        if (token === detailToken.current) setLoadingDetail(false);
      }
    })();
    // `session.selectedCommitPath` is intentionally excluded: it is written by this effect.
    // eslint-disable-next-line
  }, [actions, enabled, session.selectedCommitId, session.selectedCommitParentIndex]);

  useEffect(() => {
    const oid = session.selectedCommitId;
    const path = session.selectedCommitPath;
    if (!enabled || !oid || !path) {
      setDiff(null);
      return;
    }
    const token = detailToken.current;
    void (async () => {
      try {
        const document = await actions.gitCommitDiff({
          oid,
          path,
          parentIndex: session.selectedCommitParentIndex,
        });
        if (token !== detailToken.current) return;
        setDiff(document);
      } catch (caught) {
        if (token !== detailToken.current) return;
        setError(messageOf(caught));
        setDiff(null);
      }
    })();
  }, [actions, enabled, session.selectedCommitId, session.selectedCommitPath, session.selectedCommitParentIndex]);

  // ---------------------------------------------------------------------------------------
  // File history.
  // ---------------------------------------------------------------------------------------
  useEffect(() => {
    const path = session.fileHistoryPath;
    if (!enabled || !path) {
      setFileHistory(null);
      return;
    }
    const token = detailToken.current;
    void (async () => {
      try {
        const result = await actions.gitFileHistory({ path });
        if (token !== detailToken.current) return;
        setFileHistory(result);
      } catch (caught) {
        if (token !== detailToken.current) return;
        setError(messageOf(caught));
      }
    })();
  }, [actions, enabled, session.fileHistoryPath]);

  // ---------------------------------------------------------------------------------------
  // Actions.
  // ---------------------------------------------------------------------------------------
  const setQuery = useCallback(
    (patch: Partial<GitHistoryFilterState>) => {
      setSession({ historyQuery: { ...query, ...patch } });
    },
    [query, setSession]
  );

  const resetQuery = useCallback(() => {
    setSession({ historyQuery: defaultGitHistoryFilterState });
  }, [setSession]);

  const selectCommit = useCallback(
    (commit: { readonly id: string }) => {
      // Store the oid, not the row: a reordered or extended list must not move the selection.
      setSession({
        selectedCommitId: commit.id,
        selectedCommitParentIndex: 0,
        selectedCommitPath: null,
      });
    },
    [setSession]
  );

  const closeDetail = useCallback(() => {
    setSession({ selectedCommitId: null, selectedCommitPath: null, selectedCommitParentIndex: 0 });
  }, [setSession]);

  const setParentIndex = useCallback(
    (parentIndex: number) => {
      setSession({ selectedCommitParentIndex: parentIndex, selectedCommitPath: null });
    },
    [setSession]
  );

  const selectFile = useCallback((path: string) => setSession({ selectedCommitPath: path }), [setSession]);

  const loadMore = useCallback(() => {
    const cursor = page?.nextCursor;
    if (!cursor || loadingMore) return;
    const token = listToken.current;
    setLoadingMore(true);
    void (async () => {
      try {
        const next = await actions.gitHistory({ ...trimmed, cursor, pageSize: HISTORY_PAGE_SIZE });
        if (token !== listToken.current) return;
        setPage(current =>
          !current ? next : { ...next, items: [...current.items, ...next.items] }
        );
      } catch (caught) {
        if (token !== listToken.current) return;
        setError(messageOf(caught));
      } finally {
        if (token === listToken.current) setLoadingMore(false);
      }
    })();
  }, [actions, loadingMore, page, trimmed]);

  const openFileHistory = useCallback(
    (path: string) => setSession({ fileHistoryPath: path }),
    [setSession]
  );
  const closeFileHistory = useCallback(() => setSession({ fileHistoryPath: null }), [setSession]);

  return {
    query,
    refs,
    page,
    detail,
    files,
    diff,
    fileHistory,
    loading,
    loadingMore,
    loadingDetail,
    error,
    // A repository with no commits has no tip; that is an explicit state, not an error.
    isEmptyRepository: page !== null && page.tipOid === null,
    setQuery,
    resetQuery,
    selectCommit,
    closeDetail,
    setParentIndex,
    selectFile,
    loadMore,
    openFileHistory,
    closeFileHistory,
  };
}

function messageOf(error: unknown): string {
  const candidate = error as WebApiError | undefined;
  if (candidate?.code === 'git_cursor_invalid') {
    return '历史已变化，已重新载入列表。';
  }
  return error instanceof Error ? error.message : 'Git 历史读取失败。';
}
