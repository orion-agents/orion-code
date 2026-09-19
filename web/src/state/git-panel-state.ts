/**
 * v0.3.17 S2 — Git work panel state.
 *
 * Two different lifetimes are kept apart on purpose (plan §8.1):
 *
 *   - **Session state** (view, filter, selection, fold state, scroll anchor, commit draft)
 *     lives in a store above the panel, so the dock can unmount the Git pane and come back
 *     to the same reading position. It is never written to localStorage — it can contain
 *     commit message drafts and paths.
 *   - **Display preference** (unified vs side-by-side, wrap, whitespace) is a viewport
 *     preference and is persisted, because it belongs to the user, not to a session.
 *
 * No React here: the store and the normalisers are plain functions so they can be tested
 * without a renderer.
 */
import type { GitWorktreeSourceV1, WebGitFileSourceV1 } from '../../../src/web/git-file-source';

export type GitPanelView = 'changes' | 'history' | 'compare';
export type GitDiffMode = 'unified' | 'side-by-side';

export const GIT_DISPLAY_STORAGE_KEY = 'orion.web.git-display.v1';

export const GIT_PANEL_VIEWS: readonly GitPanelView[] = Object.freeze([
  'changes',
  'history',
  'compare',
]);

export interface GitCommitDraft {
  readonly summary: string;
  readonly body: string;
}

/**
 * v0.3.17 S4 — the history filters a reader has typed.
 *
 * Deliberately without a cursor: paging is a request concern, whereas the query itself is
 * session state that must survive a panel unmount. Keeping them apart is also what lets the
 * cursor be bound to a fingerprint of exactly these fields.
 */
export interface GitHistoryFilterState {
  readonly message: string;
  readonly author: string;
  readonly path: string;
  readonly sha: string;
  readonly since: string;
  readonly until: string;
}

export const defaultGitHistoryFilterState: GitHistoryFilterState = Object.freeze({
  message: '',
  author: '',
  path: '',
  sha: '',
  since: '',
  until: '',
});

export interface GitPanelSessionState {
  readonly view: GitPanelView;
  /** Host-side filter; null means every group. A status filter is always a worktree group. */
  readonly group: GitWorktreeSourceV1 | null;
  /** Host-side path search; empty means no filter. */
  readonly query: string;
  readonly selectedFileId: string | null;
  readonly selectedSource: WebGitFileSourceV1 | null;
  /**
   * v0.3.17 S3 — the checkbox selection, deliberately independent of `selectedFileId`.
   * Plan G1 requires "选中行" and "暂存状态" to stay separate concepts: one is where you are
   * reading, the other is what a bulk action would touch.
   */
  readonly selectedFileIds: readonly string[];
  /**
   * v0.3.17 S5 — line-level selection for partial staging (plan G3 P1).
   * Cleared whenever the file or comparison changes; never persisted.
   */
  readonly selectedLineIds: readonly string[];
  /** hunkIds the reader folded shut. */
  readonly collapsedHunks: readonly string[];
  /** Diff line to restore after a refresh, when it still exists. */
  readonly anchorLineId: string | null;
  readonly navigatorScrollTop: number;
  readonly commitDraft: GitCommitDraft;
  /**
   * v0.3.17 S4 — history view state.
   *
   * The selected commit is stored as an immutable oid, never as an index into the list or
   * the current page: plan G4 requires the selection to survive a workspace refresh that
   * reorders or extends history.
   */
  readonly historyQuery: GitHistoryFilterState;
  readonly selectedCommitId: string | null;
  /** Which parent the commit is compared against; merges only. */
  readonly selectedCommitParentIndex: number;
  readonly selectedCommitPath: string | null;
  /** Set while browsing one file's history instead of the whole repository. */
  readonly fileHistoryPath: string | null;
  /** Transient explanation shown after a selection had to be repaired. */
  readonly notice: string;
}

export interface GitDisplayPreference {
  readonly mode: GitDiffMode;
  readonly wrap: boolean;
  readonly showWhitespace: boolean;
  /**
   * v0.3.17 S5 — `--word-diff=plain`. Changes the content, so it is also bound into the
   * pagination cursor like the whitespace flag.
   */
  readonly wordDiff: boolean;
  /**
   * v0.3.17 S5 — `git diff --ignore-all-space`.
   * Persisted like the other display preferences, but the reader must be told that the
   * document content itself changes when this flips, not just how it is drawn.
   */
  readonly ignoreWhitespace: boolean;
}

export const defaultGitPanelSessionState: GitPanelSessionState = Object.freeze({
  view: 'changes',
  group: null,
  query: '',
  selectedFileId: null,
  selectedSource: null,
  selectedFileIds: Object.freeze([]) as readonly string[],
  selectedLineIds: Object.freeze([]) as readonly string[],
  collapsedHunks: Object.freeze([]) as readonly string[],
  anchorLineId: null,
  navigatorScrollTop: 0,
  commitDraft: Object.freeze({ summary: '', body: '' }),
  historyQuery: defaultGitHistoryFilterState,
  selectedCommitId: null,
  selectedCommitParentIndex: 0,
  selectedCommitPath: null,
  fileHistoryPath: null,
  notice: '',
});

export const defaultGitDisplayPreference: GitDisplayPreference = Object.freeze({
  mode: 'unified',
  wrap: false,
  showWhitespace: false,
  ignoreWhitespace: false,
  wordDiff: false,
});

/**
 * Session buckets are keyed by workspace. The workspace registry already identifies a
 * worktree by its canonical path, so two linked worktrees of one repository are two
 * workspaces and never share a bucket (plan G317-21). Per-repository splitting inside one
 * workspace would only be needed if the Host ever reported more than one repository.
 */
export function gitPanelScopeKey(workspaceId: string): string {
  return workspaceId || '__no-workspace__';
}

export interface GitPanelStore {
  read(scopeKey: string): GitPanelSessionState;
  update(scopeKey: string, patch: Partial<GitPanelSessionState>): GitPanelSessionState;
  clear(scopeKey: string): void;
}

/**
 * A store instance, not a module singleton, so tests get isolation while the app shares
 * one copy across panel mount cycles.
 */
export function createGitPanelStore(): GitPanelStore {
  const buckets = new Map<string, GitPanelSessionState>();
  return {
    read(scopeKey) {
      return buckets.get(scopeKey) ?? defaultGitPanelSessionState;
    },
    update(scopeKey, patch) {
      const next = Object.freeze({
        ...(buckets.get(scopeKey) ?? defaultGitPanelSessionState),
        ...patch,
      });
      buckets.set(scopeKey, next);
      return next;
    },
    clear(scopeKey) {
      buckets.delete(scopeKey);
    },
  };
}

/** Shared by the app; tests should build their own store. */
export const appGitPanelStore: GitPanelStore = createGitPanelStore();

export function loadGitDisplayPreference(): GitDisplayPreference {
  try {
    const raw = globalThis.localStorage?.getItem(GIT_DISPLAY_STORAGE_KEY);
    if (!raw) return defaultGitDisplayPreference;
    const parsed: unknown = JSON.parse(raw);
    return normalizeGitDisplayPreference(parsed);
  } catch {
    // A corrupt or unavailable storage must never break the panel.
    return defaultGitDisplayPreference;
  }
}

export function saveGitDisplayPreference(value: GitDisplayPreference): void {
  try {
    globalThis.localStorage?.setItem(GIT_DISPLAY_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage is a convenience; failing to persist a viewport preference is not an error.
  }
}

export function normalizeGitDisplayPreference(value: unknown): GitDisplayPreference {
  if (typeof value !== 'object' || value === null) return defaultGitDisplayPreference;
  const candidate = value as Partial<Record<keyof GitDisplayPreference, unknown>>;
  return Object.freeze({
    mode: candidate.mode === 'side-by-side' ? 'side-by-side' : 'unified',
    wrap: candidate.wrap === true,
    showWhitespace: candidate.showWhitespace === true,
    ignoreWhitespace: candidate.ignoreWhitespace === true,
    wordDiff: candidate.wordDiff === true,
  });
}

export function isGitPanelView(value: unknown): value is GitPanelView {
  return typeof value === 'string' && (GIT_PANEL_VIEWS as readonly string[]).includes(value);
}

/**
 * Picks the file to select after a refresh. Keeps the current selection when it is still
 * present for the same comparison source, otherwise falls back to the nearest readable
 * entry and says why, so the reader never lands on a blank pane.
 */
export function resolveSelectionAfterRefresh(input: {
  readonly entries: readonly { readonly fileId: string; readonly path: string }[];
  readonly previousFileId: string | null;
  readonly previousPath: string | null;
}): { readonly fileId: string | null; readonly path: string | null; readonly notice: string } {
  if (input.entries.length === 0) {
    return { fileId: null, path: null, notice: '' };
  }
  const kept = input.entries.find(entry => entry.fileId === input.previousFileId);
  if (kept) return { fileId: kept.fileId, path: kept.path, notice: '' };
  // The same path may still exist under another source; that is a better repair than
  // jumping to an unrelated first entry.
  const samePath = input.entries.find(entry => entry.path === input.previousPath);
  const fallback = samePath ?? input.entries[0];
  return {
    fileId: fallback.fileId,
    path: fallback.path,
    notice:
      input.previousFileId === null ? '' : `原选中的改动已不在此列表，已跳到 ${fallback.path}。`,
  };
}

/** v0.3.19 (G317-19) — the plan's panel widths: 960 wide, 620 narrow, 360 at the floor. */
export const GIT_PANEL_WIDE_MIN_WIDTH = 960;
export const GIT_PANEL_COMPACT_MAX_WIDTH = 959;
export const GIT_PANEL_NARROW_MAX_WIDTH = 620;
/** Reading two code columns needs more room than the panel stops being narrow at. */
export const GIT_PANEL_SIDE_BY_SIDE_MIN_WIDTH = 640;

export type GitPanelTier = 'wide' | 'compact' | 'narrow';

export interface GitPanelLayoutV1 {
  readonly tier: GitPanelTier;
  /** True while the panel is narrow enough that it shows one pane at a time. */
  readonly narrow: boolean;
  /** The mode actually rendered, which is not always the stored preference. */
  readonly effectiveMode: GitDiffMode;
  /** What `data-width` reports, so the DOM and the logic can never disagree. */
  readonly dataWidth: GitPanelTier;
}

/**
 * v0.3.19 (G317-19) — the responsive decision, extracted so it can be asserted at the plan's
 * widths instead of only being visible in a browser at whatever width a window happened to be.
 *
 * Two things this deliberately does *not* do:
 *   - it never writes back to the stored preference, because a narrow container must not
 *     permanently downgrade what the reader chose for a wide one;
 *   - it returns `wide` before the first measurement (`width <= 0`), so the initial render is
 *     the unconstrained one and a narrow panel is never guessed at from a missing width.
 */
export function resolveGitPanelLayout(
  panelWidth: number,
  storedMode: GitDiffMode
): GitPanelLayoutV1 {
  if (!Number.isFinite(panelWidth) || panelWidth <= 0) {
    return { tier: 'wide', narrow: false, effectiveMode: storedMode, dataWidth: 'wide' };
  }
  const tier: GitPanelTier =
    panelWidth <= GIT_PANEL_NARROW_MAX_WIDTH
      ? 'narrow'
      : panelWidth <= GIT_PANEL_COMPACT_MAX_WIDTH
        ? 'compact'
        : 'wide';
  return {
    tier,
    narrow: tier === 'narrow',
    effectiveMode: panelWidth <= GIT_PANEL_SIDE_BY_SIDE_MIN_WIDTH ? 'unified' : storedMode,
    dataWidth: tier,
  };
}
