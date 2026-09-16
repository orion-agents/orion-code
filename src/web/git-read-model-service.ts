import { spawn } from 'child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, lstatSync, realpathSync, statSync } from 'fs';
import { basename, isAbsolute, relative, resolve, sep } from 'path';

import { isSensitiveFilePath, redactTraceText } from '../services/redaction';
import { WebWorkbenchError } from './errors';
import { parseGitDiffDocument, type GitDiffDocumentV2 } from './git-diff-document';
import { buildSelectionPatch } from './git-patch-builder';
import {
  createGitHistoryReader,
  type GitCommitDetailV1,
  type GitCommitFilesV1,
  type GitBlameResultV1,
  type GitGraphPageV1,
  type GitFileHistoryPageV1,
  type GitHistoryPageV1,
  type GitHistoryQueryV1,
  type GitHistoryReader,
  type GitRefsV1,
} from './git-history-service';
import {
  createGitCompareReader,
  type GitCompareModeV1,
  type GitCompareResultV1,
} from './git-compare-service';
import {
  createGitVersionReader,
  type GitBlobResultV1,
  type GitConflictVersionsV1,
  type GitSubmoduleEntryV1,
} from './git-version-service';
import {
  GIT_WORKTREE_SOURCES_V1,
  type GitWorktreeSourceV1,
  type WebGitFileSourceV1,
} from './git-file-source';
import {
  withIndexTransaction,
  writeGitEnvironment,
  writeGitPrefix,
  type GitIndexPaths,
} from './git-index-transaction';

export type { GitWorktreeSourceV1, WebGitFileSourceV1 } from './git-file-source';

const GIT_TIMEOUT_MS = 5_000;
/** plan §7.9 — the commit runner gets its own bounded budget for hooks and signing. */
const GIT_COMMIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_STATUS_PAGE_SIZE = 200;
const MAX_STATUS_PAGE_SIZE = 2_000;
const DEFAULT_LOG_PAGE_SIZE = 30;
const MAX_LOG_PAGE_SIZE = 100;
const DEFAULT_DIFF_LINES = 240;
const MAX_DIFF_LINES = 500;
const DEFAULT_DIFF_BYTES = 256 * 1024;
const MAX_DIFF_BYTES = 1024 * 1024;
const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

/**
 * v0.3.17 S1 — the comparison source a file entry belongs to.
 *
 * A path with an index change *and* a further worktree change (`MM`) is two
 * distinct selectable objects, so the source is part of the file identity.
 * Declared in `./git-file-source` and re-exported here for existing importers.
 */
export interface WebGitFileV1 {
  readonly fileId: string;
  readonly path: string;
  readonly source: GitWorktreeSourceV1;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly renamedFrom?: string;
}

/** v0.3.17 S1 — real totals per group, independent of the loaded page. */
export interface WebGitStatusCountsV1 {
  readonly total: number;
  readonly conflicted: number;
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly loaded: number;
}

/**
 * v0.3.19 (G317-22) — what this workspace actually is, stated instead of inferred.
 *
 * `git rev-parse --show-toplevel` fails for a bare repository, and that used to be reported
 * as "not a repository at all". Those are two different facts and the reader is owed the
 * right one:
 *
 *   - `worktree` — an ordinary repository with a working tree; the panel reads changes.
 *   - `bare`     — a repository with **no** working tree. It is a repository, its history
 *                  exists, but this panel has no changes and no diff to read, and it must
 *                  never invent any.
 *   - `absent`   — no repository here at all.
 *
 * `isRepository` stays the coarse question ("is this a repository?"). Anything that needs
 * a working tree must ask `hasWorktree`.
 */
export type GitRepositoryKindV1 = 'worktree' | 'bare' | 'absent';

export interface WebGitStatusV1 {
  readonly isRepository: boolean;
  /** v0.3.19 (G317-22) — the precise answer to "what is this workspace". */
  readonly repositoryKind: GitRepositoryKindV1;
  /**
   * v0.3.19 (G317-22) — true only for `repositoryKind: 'worktree'`. Every worktree-backed
   * surface (change lists, diffs, staging, commit) is meaningless when this is false.
   */
  readonly hasWorktree: boolean;
  readonly repositoryRevision: string;
  readonly rootLabel?: string;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly head: string | null;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly clean: boolean;
  readonly staged: readonly WebGitFileV1[];
  readonly unstaged: readonly WebGitFileV1[];
  readonly untracked: readonly WebGitFileV1[];
  readonly conflicted: readonly WebGitFileV1[];
  readonly totalFiles: number;
  readonly counts: WebGitStatusCountsV1;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export interface WebGitCommitV1 {
  readonly id: string;
  readonly shortId: string;
  readonly authoredAt: string;
  readonly authorName: string;
  readonly subject: string;
}

export interface WebGitLogPageV1 {
  readonly repositoryRevision: string;
  readonly items: readonly WebGitCommitV1[];
  readonly nextCursor: string | null;
}

export interface WebGitDiffPageV1 {
  readonly fileId: string;
  readonly path: string;
  /** Which comparison target this page was rendered against. */
  readonly source: GitWorktreeSourceV1;
  readonly repositoryRevision: string;
  readonly binary: boolean;
  readonly lines: readonly string[];
  readonly nextCursor: string | null;
  readonly truncated: boolean;
}

interface GitStatusRecord {
  readonly path: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly renamedFrom?: string;
}

interface RepositorySnapshot {
  readonly isRepository: boolean;
  /** v0.3.19 (G317-22) — see `GitRepositoryKindV1`. */
  readonly repositoryKind: GitRepositoryKindV1;
  readonly root?: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly records: readonly GitStatusRecord[];
  readonly rawStatus: string;
  /** v0.3.17 S3 — how many files the index would commit, and whether conflicts block it. */
  readonly stagedRecords: number;
  readonly conflictedRecords: number;
  /** v0.3.17 S1 — digest of `git ls-files --stage -z`, the index half of the revision. */
  readonly indexDigest: string;
  readonly revision: string;
}

interface CursorPayload {
  readonly version: 2;
  readonly kind: 'status' | 'log' | 'diff';
  readonly revision: string;
  readonly offset: number;
  readonly fileId?: string;
  /** v0.3.17 S1 — query conditions are bound into the cursor so a cursor from one
   * filter can never be reused against another (plan G1: counts and scope must stay
   * truthful across pages). */
  readonly scope?: string;
}

/** v0.3.17 S1 — a Git file token resolves to a source-scoped (source, path) pair. */
export interface ResolvedGitToken {
  readonly source: GitWorktreeSourceV1;
  readonly path: string;
}

/** v0.3.17 S1 — bounded status query accepted by `status()`. */
export interface GitStatusQueryV1 {
  readonly cursor?: string;
  readonly pageSize?: number;
  /** Only a working-tree group can be filtered on; `commit` is not a status group. */
  readonly group?: GitWorktreeSourceV1;
  readonly query?: string;
}

interface DiffCommand {
  readonly title: string;
  readonly args: readonly string[];
  readonly acceptedExitCodes?: readonly number[];
}

export interface WebGitPerformanceCountersV1 {
  readonly processCount: number;
  readonly bytesRead: number;
  readonly itemsParsed: number;
}

/** Bounded argv-only Git status/log/diff projection for one active Workspace. */
export class GitReadModelServiceV1 {
  private readonly workspace: string;
  private readonly secret = randomBytes(32);
  /**
   * v0.3.17 S1 — tokens are keyed by (source, path), not by path alone. A file that is
   * both staged and modified in the worktree is two different selectable objects, so a
   * path-only key silently conflated the two comparison sources.
   */
  private readonly targetById = new Map<string, ResolvedGitToken>();
  private readonly idByKey = new Map<string, string>();
  private repositoryRoot?: string;
  private readonly performance = { processCount: 0, bytesRead: 0, itemsParsed: 0 };
  /** Overridable so the timeout-recovery path can be exercised deterministically. */
  private readonly commitTimeoutMs: number;

  constructor(workspace: string, options: { readonly commitTimeoutMs?: number } = {}) {
    this.workspace = canonicalDirectory(workspace);
    this.commitTimeoutMs = boundedInteger(
      options.commitTimeoutMs ?? GIT_COMMIT_TIMEOUT_MS,
      1_000,
      600_000,
      'commitTimeoutMs'
    );
  }

  performanceCounters(): WebGitPerformanceCountersV1 {
    return Object.freeze({ ...this.performance });
  }

  async status(input: GitStatusQueryV1 = {}): Promise<WebGitStatusV1> {
    const snapshot = await this.capture();
    const pageSize = boundedInteger(
      input.pageSize ?? DEFAULT_STATUS_PAGE_SIZE,
      1,
      MAX_STATUS_PAGE_SIZE,
      'pageSize'
    );
    const group = normalizeSource(input.group);
    const query = normalizeQuery(input.query);
    // v0.3.17 S1 — the query scope is bound into the cursor, so pages can never be
    // stitched across two different filters.
    const scope = statusScope(group, query);

    const matched = snapshot.records.filter(record => {
      if (group && !recordSources(record).includes(group)) return false;
      return query === undefined || record.path.toLocaleLowerCase().includes(query);
    });

    const offset = input.cursor
      ? this.decodeCursor(input.cursor, 'status', snapshot.revision, undefined, scope).offset
      : 0;
    const page = matched.slice(offset, offset + pageSize);

    const staged: WebGitFileV1[] = [];
    const unstaged: WebGitFileV1[] = [];
    const untracked: WebGitFileV1[] = [];
    const conflicted: WebGitFileV1[] = [];
    const buckets: Record<GitWorktreeSourceV1, WebGitFileV1[]> = {
      staged,
      unstaged,
      untracked,
      conflict: conflicted,
    };
    for (const record of page) {
      for (const source of recordSources(record)) {
        buckets[source].push(this.projectFile(record, source));
      }
    }

    // Totals cover the whole matched scope, never just the loaded page.
    const counts = countSources(matched);
    const nextOffset = offset + page.length;
    return Object.freeze({
      isRepository: snapshot.isRepository,
      repositoryKind: snapshot.repositoryKind,
      hasWorktree: snapshot.repositoryKind === 'worktree',
      repositoryRevision: snapshot.revision,
      ...(snapshot.root ? { rootLabel: basename(snapshot.root) } : {}),
      branch: snapshot.branch,
      // v0.3.19 (G317-22) — only a worktree-backed checkout can be "detached". A bare
      // repository has no branch either, and reporting that as a detached HEAD invented a
      // state the repository is not in.
      detached: snapshot.repositoryKind === 'worktree' && !snapshot.branch,
      head: snapshot.head ? snapshot.head.slice(0, 12) : null,
      upstream: snapshot.upstream,
      ahead: snapshot.ahead,
      behind: snapshot.behind,
      clean: snapshot.records.length === 0,
      staged: Object.freeze(staged),
      unstaged: Object.freeze(unstaged),
      untracked: Object.freeze(untracked),
      conflicted: Object.freeze(conflicted),
      totalFiles: matched.length,
      counts: Object.freeze({ ...counts, loaded: page.length }),
      truncated: nextOffset < matched.length,
      nextCursor:
        nextOffset < matched.length
          ? this.encodeCursor({
              version: 2,
              kind: 'status',
              revision: snapshot.revision,
              offset: nextOffset,
              scope,
            })
          : null,
    });
  }

  async log(
    input: {
      readonly cursor?: string;
      readonly pageSize?: number;
    } = {}
  ): Promise<WebGitLogPageV1> {
    const snapshot = await this.capture();
    if (!snapshot.isRepository || !snapshot.root || !snapshot.head) {
      return Object.freeze({
        repositoryRevision: snapshot.revision,
        items: Object.freeze([]),
        nextCursor: null,
      });
    }
    const pageSize = boundedInteger(
      input.pageSize ?? DEFAULT_LOG_PAGE_SIZE,
      1,
      MAX_LOG_PAGE_SIZE,
      'pageSize'
    );
    const offset = input.cursor
      ? this.decodeCursor(input.cursor, 'log', snapshot.revision).offset
      : 0;
    const raw = await this.runGit(
      [
        'log',
        `--skip=${offset}`,
        `--max-count=${pageSize + 1}`,
        '--format=%H%x1f%h%x1f%ct%x1f%an%x1f%s%x1e',
      ],
      snapshot.root
    );
    const commits = raw
      .split('\x1e')
      .map(record => record.replace(/^\s+/u, '').replace(/\s+$/u, ''))
      .filter(Boolean)
      .map(parseCommit);
    this.performance.itemsParsed += commits.length;
    const hasMore = commits.length > pageSize;
    const items = commits.slice(0, pageSize);
    return Object.freeze({
      repositoryRevision: snapshot.revision,
      items: Object.freeze(items),
      nextCursor: hasMore
        ? this.encodeCursor({
            version: 2,
            kind: 'log',
            revision: snapshot.revision,
            offset: offset + items.length,
          })
        : null,
    });
  }

  async diff(input: {
    readonly fileId: string;
    readonly cursor?: string;
    readonly lineLimit?: number;
    readonly byteLimit?: number;
    /** v0.3.17 S5 — `git diff --ignore-all-space`. Bound into the cursor so a page can
     * never be continued under a different whitespace setting. */
    readonly ignoreWhitespace?: boolean;
    /** v0.3.17 S5 — `--word-diff=plain`. Also bound into the cursor: the rendered text is
     * different, so a page must not be continued across a mode change. */
    readonly wordDiff?: boolean;
  }): Promise<WebGitDiffPageV1> {
    const snapshot = await this.capture();
    if (!snapshot.isRepository || !snapshot.root) {
      throw new WebWorkbenchError(404, 'Git repository is unavailable.', 'git_not_repository');
    }
    const target = this.resolveTarget(input.fileId);
    const { path } = target;
    const record = snapshot.records.find(candidate => candidate.path === path);
    if (!record) {
      throw new WebWorkbenchError(409, 'Git file changed before diff.', 'git_revision_conflict');
    }
    // A token names one comparison source. If that source no longer exists (the file was
    // staged away, or the worktree edit was reverted), the selection is stale rather than
    // silently rendered against the other side.
    if (!recordStillMatches(record, target.source)) {
      throw new WebWorkbenchError(409, 'Git file changed before diff.', 'git_revision_conflict');
    }
    if (isSensitiveGitRecord(record)) {
      throw new WebWorkbenchError(
        403,
        'Sensitive file content is not available in the Web Workbench.',
        'sensitive_file_blocked'
      );
    }
    const lineLimit = boundedInteger(
      input.lineLimit ?? DEFAULT_DIFF_LINES,
      1,
      MAX_DIFF_LINES,
      'lineLimit'
    );
    const byteLimit = boundedInteger(
      input.byteLimit ?? DEFAULT_DIFF_BYTES,
      1024,
      MAX_DIFF_BYTES,
      'byteLimit'
    );
    // Defaulted once so the command, the cursor and the document all describe the same view.
    const ignoreWhitespace = input.ignoreWhitespace === true;
    const wordDiff = input.wordDiff === true;
    const offset = input.cursor
      ? this.decodeCursor(
          input.cursor,
          'diff',
          snapshot.revision,
          input.fileId,
          diffScope(ignoreWhitespace, wordDiff)
        ).offset
      : 0;
    const commands = diffCommands(path, target.source, ignoreWhitespace, wordDiff);
    const page = await streamDiffPage({
      cwd: snapshot.root,
      commands,
      offset,
      lineLimit,
      byteLimit,
      onProcess: () => {
        this.performance.processCount += 1;
      },
      onBytes: bytes => {
        this.performance.bytesRead += bytes;
      },
    });
    this.performance.itemsParsed += page.linesParsed;
    if (page.hasMore && page.returnedLines === 0) {
      throw new WebWorkbenchError(
        500,
        'Git diff pagination could not advance.',
        'git_pagination_stalled'
      );
    }
    const after = await this.capture();
    if (after.revision !== snapshot.revision) {
      throw new WebWorkbenchError(
        409,
        'Repository changed while reading diff.',
        'git_revision_conflict'
      );
    }
    const binary = page.lines.some(line => /^(?:Binary files |GIT binary patch)/u.test(line));
    const lines = binary ? page.lines.filter(line => !line.startsWith('literal ')) : page.lines;
    return Object.freeze({
      fileId: input.fileId,
      path: redactTraceText(path),
      source: target.source,
      repositoryRevision: snapshot.revision,
      binary,
      lines: Object.freeze(lines),
      nextCursor: page.hasMore
        ? this.encodeCursor({
            version: 2,
            kind: 'diff',
            revision: snapshot.revision,
            offset: offset + page.returnedLines,
            fileId: input.fileId,
            scope: diffScope(ignoreWhitespace, wordDiff),
          })
        : null,
      truncated: page.hasMore,
    });
  }

  /**
   * v0.3.17 S2 — the structured form of the same comparison. It reuses `diff()` verbatim,
   * so the hardened read path, byte/line budget and pagination stay in one place; only the
   * projection changes.
   */
  async diffDocument(input: {
    readonly fileId: string;
    readonly cursor?: string;
    readonly lineLimit?: number;
    readonly byteLimit?: number;
    readonly ignoreWhitespace?: boolean;
    readonly wordDiff?: boolean;
  }): Promise<GitDiffDocumentV2> {
    const page = await this.diff(input);
    return parseGitDiffDocument({
      fileToken: page.fileId,
      path: page.path,
      source: page.source,
      repositoryRevision: page.repositoryRevision,
      lines: page.lines,
      hasMore: page.nextCursor !== null,
      nextCursor: page.nextCursor,
    });
  }

  /**
   * v0.3.17 S4 — history reading.
   *
   * Delegated to a separate module (plan §8.2) that owns metadata about immutable objects,
   * while the bounded diff stream stays here. None of these methods touch the working tree or
   * the index — the S4 exit evidence is "history browsing without workspace writes".
   */
  private historyReaderInstance?: GitHistoryReader;

  private historyReader(): GitHistoryReader {
    this.historyReaderInstance ??= createGitHistoryReader({
      runGit: async args => this.runGit(args, await this.requireRepositoryRoot()),
      requireRoot: () => this.requireRepositoryRoot(),
      revision: async () => (await this.capture()).revision,
    });
    return this.historyReaderInstance;
  }

  private compareReaderInstance?: ReturnType<typeof createGitCompareReader>;

  private compareReader() {
    this.compareReaderInstance ??= createGitCompareReader({
      runGit: async args => this.runGit(args, await this.requireRepositoryRoot()),
    });
    return this.compareReaderInstance;
  }

  /**
   * v0.3.17 S5 — branch/version comparison. Read-only.
   *
   * The resolved OIDs are part of the result on purpose: the UI freezes the opened result
   * against them, so a ref that moves afterwards produces a "there is an update" hint
   * instead of silently comparing against a different tree.
   */
  async compare(input: {
    readonly baseRef: string;
    readonly headRef: string;
    readonly mode: GitCompareModeV1;
  }): Promise<GitCompareResultV1> {
    return this.compareReader().compare(input);
  }

  /** Resolves a pair of refs without computing a comparison (used to detect ref movement). */
  async resolveComparePair(
    baseRef: string,
    headRef: string
  ): Promise<{ readonly baseOid: string; readonly headOid: string }> {
    const pair = await this.compareReader().resolvePair(baseRef, headRef);
    return Object.freeze({ baseOid: pair.baseOid, headOid: pair.headOid });
  }

  /**
   * v0.3.17 S5 — the diff one file shows between two arbitrary commits.
   *
   * Same bounded stream as every other diff; the only new thing is that the base is a
   * caller-supplied resolved OID instead of a parent. The cursor margin binds the page to
   * this exact base/head/path triple, so a different comparison cannot continue it.
   */
  async compareFileDiffDocument(input: {
    readonly baseOid: string;
    readonly headOid: string;
    readonly path: string;
    readonly cursor?: string;
    readonly lineLimit?: number;
    readonly byteLimit?: number;
  }): Promise<GitDiffDocumentV2> {
    const root = await this.requireRepositoryRoot();
    const path = assertRelativeGitPath(input.path);
    if (isSensitiveFilePath(path)) {
      throw new WebWorkbenchError(
        403,
        'Sensitive file content is not available in the Web Workbench.',
        'sensitive_file_blocked'
      );
    }
    for (const oid of [input.baseOid, input.headOid]) {
      if (!/^[0-9a-f]{7,64}$/iu.test(oid)) {
        throw new WebWorkbenchError(400, 'A commit hash is required.', 'git_revision_invalid');
      }
    }
    const snapshot = await this.capture();
    const lineLimit = boundedInteger(
      input.lineLimit ?? DEFAULT_DIFF_LINES,
      1,
      MAX_DIFF_LINES,
      'lineLimit'
    );
    const byteLimit = boundedInteger(
      input.byteLimit ?? DEFAULT_DIFF_BYTES,
      1024,
      MAX_DIFF_BYTES,
      'byteLimit'
    );
    const margin = createHash('sha256')
      .update(`compare-diff:${input.baseOid}:${input.headOid}:${path}:${snapshot.revision}`)
      .digest('hex')
      .slice(0, 24);
    const offset = input.cursor ? decodeCommitDiffCursor(input.cursor, margin) : 0;
    const page = await streamDiffPage({
      cwd: root,
      commands: Object.freeze([
        {
          title: 'Compare',
          args: [
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--unified=3',
            input.baseOid,
            input.headOid,
            '--',
            path,
          ],
        },
      ]),
      offset,
      lineLimit,
      byteLimit,
      onProcess: () => {
        this.performance.processCount += 1;
      },
      onBytes: bytes => {
        this.performance.bytesRead += bytes;
      },
    });
    this.performance.itemsParsed += page.linesParsed;
    const document = parseGitDiffDocument({
      fileToken: `compare_${margin}`,
      path,
      source: 'commit',
      repositoryRevision: snapshot.revision,
      lines: page.lines,
      hasMore: page.hasMore,
      nextCursor: page.hasMore
        ? encodeCommitDiffCursor({ margin, offset: offset + page.returnedLines })
        : null,
    });
    return Object.freeze({
      ...document,
      baseOid: input.baseOid,
      baseLabel: `比较 ${input.baseOid.slice(0, 10)} → ${input.headOid.slice(0, 10)}`,
    });
  }

  private versionReaderInstance?: ReturnType<typeof createGitVersionReader>;

  private versionReader() {
    this.versionReaderInstance ??= createGitVersionReader({
      runGit: async args => this.runGit(args, await this.requireRepositoryRoot()),
      runGitBytes: async args => this.runGitBytes(args, await this.requireRepositoryRoot()),
    });
    return this.versionReaderInstance;
  }

  /**
   * v0.3.17 S5 — base / ours / theirs / worktree for a conflicted file.
   *
   * Read from index stages 1/2/3 rather than assembled from two diffs: a modify/delete
   * conflict genuinely has no base, and pretending otherwise is what plan G6 forbids.
   */
  async conflictVersions(path: string): Promise<GitConflictVersionsV1> {
    return this.versionReader().conflict(path);
  }

  /** Reads one file at a revision — including a file that no longer exists locally. */
  async fileBlob(input: { readonly path: string; readonly rev: string }): Promise<GitBlobResultV1> {
    return this.versionReader().blob(input);
  }

  /** Recorded gitlink SHAs only; submodules are never traversed (plan G6). */
  async submodules(): Promise<readonly GitSubmoduleEntryV1[]> {
    return this.versionReader().submodules();
  }

  async refs(): Promise<GitRefsV1> {
    return this.historyReader().refs();
  }

  async history(query: GitHistoryQueryV1): Promise<GitHistoryPageV1> {
    return this.historyReader().history(query);
  }

  async commitDetail(oid: string, parentIndex = 0): Promise<GitCommitDetailV1> {
    return this.historyReader().commit(oid, parentIndex);
  }

  async commitFiles(oid: string, parentIndex = 0): Promise<GitCommitFilesV1> {
    return this.historyReader().commitFiles(oid, parentIndex);
  }

  async graph(input: { readonly limit?: number } = {}): Promise<GitGraphPageV1> {
    return this.historyReader().graph(input);
  }

  async blame(input: {
    readonly path: string;
    readonly rev?: string;
    readonly limit?: number;
  }): Promise<GitBlameResultV1> {
    return this.historyReader().blame(input);
  }

  async fileHistory(input: {
    readonly path: string;
    readonly rev?: string;
    readonly limit?: number;
  }): Promise<GitFileHistoryPageV1> {
    return this.historyReader().fileHistory(input);
  }

  /**
   * v0.3.17 S4 — the diff a commit introduced to one file.
   *
   * Rebuilds the comparison from the commit's real base (first parent, a chosen parent, or the
   * empty tree for a root commit) and reuses `streamDiffPage`, so the byte/line budget,
   * pagination and `--no-ext-diff`/`--no-textconv` hardening are the same code the working-tree
   * diff uses. There is no second diff implementation to keep in sync.
   */
  async commitDiffDocument(input: {
    readonly oid: string;
    readonly path: string;
    readonly parentIndex?: number;
    readonly cursor?: string;
    readonly lineLimit?: number;
    readonly byteLimit?: number;
  }): Promise<GitDiffDocumentV2> {
    const root = await this.requireRepositoryRoot();
    const path = assertRelativeGitPath(input.path);
    if (isSensitiveFilePath(path)) {
      throw new WebWorkbenchError(
        403,
        'Sensitive file content is not available in the Web Workbench.',
        'sensitive_file_blocked'
      );
    }
    const parentIndex = input.parentIndex ?? 0;
    const detail = await this.commitDetail(input.oid, parentIndex);
    const snapshot = await this.capture();
    const lineLimit = boundedInteger(
      input.lineLimit ?? DEFAULT_DIFF_LINES,
      1,
      MAX_DIFF_LINES,
      'lineLimit'
    );
    const byteLimit = boundedInteger(
      input.byteLimit ?? DEFAULT_DIFF_BYTES,
      1024,
      MAX_DIFF_BYTES,
      'byteLimit'
    );
    // The margin decides which comparison this page belongs to; a different commit or parent
    // is a different document, not a continuation.
    const margin = createHash('sha256')
      .update(`commit-diff:${detail.id}:${detail.baseOid}:${parentIndex}:${snapshot.revision}`)
      .digest('hex')
      .slice(0, 24);
    const offset = input.cursor ? decodeCommitDiffCursor(input.cursor, margin) : 0;

    const page = await streamDiffPage({
      cwd: root,
      commands: Object.freeze([
        {
          title: 'Commit',
          args: [
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--unified=3',
            detail.baseOid,
            detail.id,
            '--',
            path,
          ],
        },
      ]),
      offset,
      lineLimit,
      byteLimit,
      onProcess: () => {
        this.performance.processCount += 1;
      },
      onBytes: bytes => {
        this.performance.bytesRead += bytes;
      },
    });
    this.performance.itemsParsed += page.linesParsed;

    const document = parseGitDiffDocument({
      fileToken: `commit_${margin}`,
      path,
      source: 'commit',
      repositoryRevision: snapshot.revision,
      lines: page.lines,
      hasMore: page.hasMore,
      nextCursor: page.hasMore
        ? encodeCommitDiffCursor({ margin, offset: offset + page.returnedLines })
        : null,
    });
    return Object.freeze({ ...document, baseLabel: detail.baseLabel, baseOid: detail.baseOid });
  }

  private async capture(): Promise<RepositorySnapshot> {
    let root: string | undefined;
    let repositoryKind: GitRepositoryKindV1 = 'absent';
    try {
      root =
        this.repositoryRoot ??
        realpathSync((await this.runGit(['rev-parse', '--show-toplevel'], this.workspace)).trim());
      if (!isWithinRoot(root, this.workspace)) throw new Error('repository root escaped workspace');
      this.repositoryRoot = root;
      repositoryKind = 'worktree';
    } catch {
      // v0.3.19 (G317-22) — `--show-toplevel` fails for a bare repository too, so the failure
      // alone cannot say which case this is. Ask directly. Conflating "no repository" with
      // "a repository that has no working tree" told the reader the wrong thing about a
      // directory that is in fact a valid repository.
      const bare = (await this.tryGit(['rev-parse', '--is-bare-repository'], this.workspace))
        ?.trim()
        .toLowerCase();
      repositoryKind = bare === 'true' ? 'bare' : 'absent';
    }
    if (repositoryKind === 'bare') {
      // A bare repository has no index and no working tree, so there is nothing to report as
      // changed — but its HEAD is real and worth stating. `clean` stays true in `status()`
      // because zero files differ from an index that does not exist; `hasWorktree` is what
      // tells the reader not to trust that as "you have nothing to commit".
      const [branchResult, headResult] = await Promise.all([
        this.tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], this.workspace),
        this.tryGit(['rev-parse', 'HEAD'], this.workspace),
      ]);
      const branch = branchResult?.trim() || null;
      const head = headResult?.trim() || null;
      const revision = createHash('sha256')
        .update(JSON.stringify({ bare: this.workspace, branch, head }))
        .digest('hex');
      return Object.freeze({
        isRepository: true,
        repositoryKind: 'bare',
        branch,
        head,
        upstream: null,
        ahead: 0,
        behind: 0,
        records: Object.freeze([]),
        rawStatus: '',
        stagedRecords: 0,
        conflictedRecords: 0,
        indexDigest: createHash('sha256').update('').digest('hex'),
        revision,
      });
    }
    if (repositoryKind === 'absent') {
      const revision = createHash('sha256').update(`not-git:${this.workspace}`).digest('hex');
      return Object.freeze({
        isRepository: false,
        repositoryKind: 'absent',
        branch: null,
        head: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        records: Object.freeze([]),
        rawStatus: '',
        stagedRecords: 0,
        conflictedRecords: 0,
        indexDigest: createHash('sha256').update('').digest('hex'),
        revision,
      });
    }
    if (!root) {
      // Only the `worktree` branch assigns a root and both other kinds returned above, so this
      // is unreachable today — it exists so the invariant is enforced, not merely inferred.
      throw new Error('Resolved a non-worktree repository without a root.');
    }
    const [rawStatus, branchResult, headResult, upstreamResult, indexListing] = await Promise.all([
      this.runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root),
      this.tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], root),
      this.tryGit(['rev-parse', 'HEAD'], root),
      this.tryGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root),
      // v0.3.17 S1 — the index snapshot is what makes a state revision change on
      // stage/unstage even though HEAD does not move. `--stage` yields
      // mode/oid/stage/path for every entry, including unmerged stages.
      this.tryGit(['ls-files', '--stage', '-z'], root),
    ]);
    const branch = branchResult?.trim() || null;
    const head = headResult?.trim() || null;
    const upstream = upstreamResult?.trim() || null;
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      const counts = await this.tryGit(
        ['rev-list', '--left-right', '--count', `HEAD...${upstream}`],
        root
      );
      const [aheadValue, behindValue] = (counts ?? '').trim().split(/\s+/u).map(Number);
      ahead = Number.isSafeInteger(aheadValue) ? aheadValue : 0;
      behind = Number.isSafeInteger(behindValue) ? behindValue : 0;
    }
    const records = parsePorcelainV1(rawStatus);
    this.performance.itemsParsed += records.length;
    let stagedRecords = 0;
    let conflictedRecords = 0;
    for (const record of records) {
      const sources = recordSources(record);
      if (sources.includes('conflict')) conflictedRecords += 1;
      else if (sources.includes('staged')) stagedRecords += 1;
    }
    const fileFingerprints = records.map(record => fingerprintWorktreePath(root, record.path));
    // Hash the index listing on its own so a large index never builds a second full copy
    // of itself inside the JSON payload.
    const indexDigest = createHash('sha256')
      .update(indexListing ?? '')
      .digest('hex');
    const revision = createHash('sha256')
      .update(
        JSON.stringify({
          root,
          branch,
          head,
          upstream,
          ahead,
          behind,
          rawStatus,
          fileFingerprints,
          indexDigest,
        })
      )
      .digest('hex');
    return Object.freeze({
      isRepository: true,
      repositoryKind: 'worktree' as const,
      root,
      branch,
      head,
      upstream,
      ahead,
      behind,
      records: Object.freeze(records),
      rawStatus,
      stagedRecords,
      conflictedRecords,
      indexDigest,
      revision,
    });
  }

  private projectFile(record: GitStatusRecord, source: GitWorktreeSourceV1): WebGitFileV1 {
    return Object.freeze({
      fileId: this.rememberTarget(source, record.path),
      path: redactTraceText(record.path),
      source,
      indexStatus: record.indexStatus,
      worktreeStatus: record.worktreeStatus,
      ...(record.renamedFrom ? { renamedFrom: redactTraceText(record.renamedFrom) } : {}),
    });
  }

  private rememberTarget(source: GitWorktreeSourceV1, path: string): string {
    const key = `${source}\u0000${path}`;
    const existing = this.idByKey.get(key);
    if (existing) return existing;
    const id = `git_${createHmac('sha256', this.secret)
      .update(key)
      .digest('base64url')
      .slice(0, 32)}`;
    this.idByKey.set(key, id);
    this.targetById.set(id, Object.freeze({ source, path }));
    return id;
  }

  /**
   * v0.3.17 S1 — the single place a Git file token becomes a path. Git mutations resolve
   * tokens here instead of going through FileReadService, whose token space is unrelated.
   */
  resolveTarget(fileId: string): ResolvedGitToken {
    if (typeof fileId !== 'string' || fileId.length === 0 || fileId.length > 256) {
      throw new WebWorkbenchError(400, 'A Git file id is invalid.', 'file_id_invalid');
    }
    const target = this.targetById.get(fileId);
    if (!target) {
      throw new WebWorkbenchError(404, 'Git file was not found.', 'git_file_not_found');
    }
    return target;
  }

  /**
   * v0.3.17 S1 — resolve Git file tokens for a mutation and enforce the source each
   * action may write. This replaces FileReadService token lookup, whose token space is
   * unrelated to Git and silently rejected every real Git list token.
   */
  resolveMutationPaths(action: 'stage' | 'unstage', fileIds: readonly string[]): readonly string[] {
    if (!Array.isArray(fileIds) || fileIds.length === 0 || fileIds.length > 200) {
      throw new WebWorkbenchError(400, 'fileIds must list 1 through 200 files.');
    }
    const paths: string[] = [];
    for (const fileId of fileIds) {
      const target = this.resolveTarget(fileId);
      const writable =
        action === 'stage'
          ? target.source === 'unstaged' || target.source === 'untracked'
          : target.source === 'staged';
      if (!writable) {
        // Conflict entries are deliberately not writable in this version (plan G3).
        throw new WebWorkbenchError(
          409,
          `A ${target.source} file cannot be ${action === 'stage' ? 'staged' : 'unstaged'}.`,
          'git_source_not_writable'
        );
      }
      paths.push(target.path);
    }
    assertSafeGitPaths(paths);
    return paths;
  }

  /** v0.3.12 S3 — guarded stage: paths are host-resolved file ids only. */
  async stagePaths(paths: readonly string[]): Promise<GitMutationResultV1> {
    assertSafeGitPaths(paths);
    if (paths.length === 0) throw new Error('stage requires at least one path.');
    const pathsInfo = await this.resolveIndexPaths();
    await withIndexTransaction(
      pathsInfo,
      context => this.readTreeEmpty(context),
      async context => {
        await this.runGit(['add', '--', ...paths], pathsInfo.root, 'index', context.env);
        await this.assertIndexMatchesWorktree(pathsInfo.root, context.env, paths);
      }
    );
    return this.mutationResult();
  }

  /**
   * v0.3.17 S3 — prove the index entry for each path really equals what `git add` should
   * have produced.
   *
   * Checking "the path is present in the index" is not enough: the path was usually already
   * there, so a silent no-op would pass. `hash-object --path` applies exactly the filters and
   * attributes git itself would, so comparing the two oids is a precise postcondition — and
   * it is what turns a stat-cache no-op into a loud failure instead of a lost edit.
   */
  private async assertIndexMatchesWorktree(
    root: string,
    env: NodeJS.ProcessEnv,
    paths: readonly string[]
  ): Promise<void> {
    const entries = await this.indexEntries(root, env);
    for (const path of paths) {
      const entry = entries.get(path);
      const absolute = resolve(root, path);
      if (!isWithinRoot(absolute, root)) {
        throw new WebWorkbenchError(400, 'A path escaped the repository.', 'git_path_unsafe');
      }
      if (!existsSync(absolute)) {
        // A worktree deletion must have dropped the index entry.
        if (entry !== undefined) {
          throw new WebWorkbenchError(
            409,
            `The index still records a deleted file: ${path}`,
            'git_index_verify_failed'
          );
        }
        continue;
      }
      const expected = (
        await this.runGit(['hash-object', `--path=${path}`, '--', absolute], root, 'index', env)
      ).trim();
      if (entry !== expected) {
        throw new WebWorkbenchError(
          409,
          `The index did not record the current content of ${path}.`,
          'git_index_verify_failed'
        );
      }
    }
  }

  async unstagePaths(paths: readonly string[]): Promise<GitMutationResultV1> {
    assertSafeGitPaths(paths);
    if (paths.length === 0) throw new Error('unstage requires at least one path.');
    const pathsInfo = await this.resolveIndexPaths();
    const head =
      (await this.tryGit(['rev-parse', '--verify', 'HEAD'], pathsInfo.root)) !== undefined;
    // Captured up front so the postcondition is checked against a frozen expectation.
    const headBlobs = new Map<string, string | null>();
    for (const path of paths) {
      headBlobs.set(
        path,
        head
          ? ((await this.tryGit(['rev-parse', `HEAD:${path}`], pathsInfo.root))?.trim() ?? null)
          : null
      );
    }
    await withIndexTransaction(
      pathsInfo,
      context => this.readTreeEmpty(context),
      async context => {
        // A repository without HEAD cannot `reset`; `rm --cached` is the index operation
        // that matches a first-commit workflow and leaves worktree files alone (plan G3).
        const args = head
          ? ['reset', '-q', '--', ...paths]
          : ['rm', '--cached', '-q', '--', ...paths];
        await this.runGit(args, pathsInfo.root, 'index', context.env);
        const entries = await this.indexEntries(pathsInfo.root, context.env);
        for (const path of paths) {
          const entry = entries.get(path);
          const expected = headBlobs.get(path) ?? null;
          if (expected === null) {
            if (entry !== undefined) {
              throw new WebWorkbenchError(
                409,
                'The index did not drop the expected entry.',
                'git_index_verify_failed'
              );
            }
          } else if (entry !== expected) {
            throw new WebWorkbenchError(
              409,
              'The index did not return to the committed version.',
              'git_index_verify_failed'
            );
          }
        }
      }
    );
    return this.mutationResult();
  }

  /**
   * v0.3.17 S3 — apply a hunk or line selection to the index only (plan §7.6/§7.8).
   *
   * The document is re-read on the Host, the patch is rebuilt from it, and `--check` runs
   * before the write. The browser only ever sends ids, never patch text.
   */
  async applySelection(input: {
    readonly fileId: string;
    readonly hunkIds?: readonly string[];
    readonly lineIds?: readonly string[];
  }): Promise<GitMutationResultV1> {
    const document = await this.diffDocument({ fileId: input.fileId });
    const built = buildSelectionPatch(document, {
      ...(input.hunkIds ? { hunkIds: input.hunkIds } : {}),
      ...(input.lineIds ? { lineIds: input.lineIds } : {}),
    });
    if (!built.ok) {
      throw new WebWorkbenchError(409, built.reason, 'git_patch_not_applicable');
    }
    // Unstaging a selection is the same patch applied backwards against the index.
    const reverse = document.source === 'staged';
    return this.applyIndexPatch(built.patch, { reverse });
  }

  /**
   * Applies a Host-rebuilt patch to the index only (plan §7.6). The patch never comes from
   * the browser: it is rebuilt from the reviewed document, and `--check` runs first so a
   * patch that cannot apply is rejected before anything is written into the private index.
   */
  async applyIndexPatch(
    patch: string,
    options: { readonly reverse?: boolean } = {}
  ): Promise<GitMutationResultV1> {
    if (typeof patch !== 'string' || patch.length === 0 || patch.length > 1_000_000) {
      throw new WebWorkbenchError(400, 'A patch must be a bounded string.', 'git_patch_invalid');
    }
    const pathsInfo = await this.resolveIndexPaths();
    const direction = options.reverse ? ['--reverse'] : [];
    await withIndexTransaction(
      pathsInfo,
      context => this.readTreeEmpty(context),
      async context => {
        // `--recount` derives line counts from the body, so a partially rebuilt hunk still
        // applies exactly as written. `--check` first: nothing is written on a failed check.
        await this.runGit(
          ['apply', '--cached', '--check', '--recount', ...direction, '-'],
          pathsInfo.root,
          'index',
          context.env,
          patch
        ).catch(error => {
          const message = error instanceof Error ? error.message : '';
          // A patch rebuilt from the reviewed document can still be inapplicable to the real
          // index. CRLF line endings are the common cause: the diff text cannot represent them
          // unambiguously, so the rebuilt context does not match the stored bytes. The plan
          // requires such a selection to be refused explicitly rather than to fail as a Git
          // error — nothing has been written at this point.
          throw new WebWorkbenchError(
            409,
            /patch failed|patch does not apply/iu.test(message)
              ? 'This selection cannot be applied to the index (CRLF line endings are a common cause).'
              : message,
            'git_patch_not_applicable'
          );
        });
        await this.runGit(
          ['apply', '--cached', '--recount', ...direction, '-'],
          pathsInfo.root,
          'index',
          context.env,
          patch
        );
      }
    );
    return this.mutationResult();
  }

  private async readTreeEmpty(context: {
    readonly indexFile: string;
    readonly env: NodeJS.ProcessEnv;
  }): Promise<void> {
    const root = await this.requireRepositoryRoot();
    await this.runGit(['read-tree', '--empty'], root, 'index', context.env);
  }

  /** `ls-files --stage -z` parsed into path → blob oid, honouring a private index env. */
  private async indexEntries(root: string, env: NodeJS.ProcessEnv): Promise<Map<string, string>> {
    const raw = await this.runGit(['ls-files', '--stage', '-z'], root, 'index', env);
    const entries = new Map<string, string>();
    for (const record of raw.split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const meta = record.slice(0, tab).split(' ');
      const path = record.slice(tab + 1);
      // Unmerged stages share a path; the first stage recorded is enough for verification.
      if (!entries.has(path)) entries.set(path, meta[1] ?? '');
    }
    return entries;
  }

  /** Resolves root, git dir and the real index path (worktree-aware). */
  private async resolveIndexPaths(): Promise<GitIndexPaths> {
    const root = await this.requireRepositoryRoot();
    // `--git-path index` resolves into `.git/worktrees/<name>/index` for a linked worktree,
    // which is the index this workspace actually writes — not the main worktree's.
    const indexPath = resolve(
      root,
      (await this.runGit(['rev-parse', '--git-path', 'index'], root)).trim()
    );
    const gitDir = (await this.runGit(['rev-parse', '--absolute-git-dir'], root)).trim();
    return { root, gitDir, indexPath };
  }

  private async mutationResult(): Promise<GitMutationResultV1> {
    return { repositoryRevision: await this.revisionAfterMutation() };
  }

  /**
   * v0.3.17 S3 — what a commit would actually include.
   *
   * This is deliberately independent of the change-list filter: plan G3 requires the form to
   * show the real index, not the currently filtered view, so the reader can never commit a
   * subset they did not intend.
   */
  async commitPreview(): Promise<GitCommitPreviewV1> {
    const snapshot = await this.capture();
    if (!snapshot.isRepository || !snapshot.root) {
      throw new WebWorkbenchError(409, 'Git repository is unavailable.', 'git_not_repository');
    }
    const root = snapshot.root;
    const entries: GitIndexEntryV1[] = [];
    for (const record of snapshot.records) {
      const sources = recordSources(record);
      if (sources.includes('conflict')) {
        entries.push(
          Object.freeze({
            path: redactTraceText(record.path),
            source: 'conflict' as const,
            status: `${record.indexStatus}${record.worktreeStatus}`,
          })
        );
        continue;
      }
      if (sources.includes('staged')) {
        entries.push(
          Object.freeze({
            path: redactTraceText(record.path),
            source: 'staged' as const,
            status: `${record.indexStatus}${record.worktreeStatus}`,
          })
        );
      }
    }

    const stats = await this.stagedNumstat(root);
    const identity = await this.describeCommitConfiguration(root);
    const hasConflict = snapshot.conflictedRecords > 0;
    const blockedReason = hasConflict
      ? '存在未解决的冲突，请先在 Files 中处理。'
      : entries.length === 0
        ? '暂存区为空，没有可提交的改动。'
        : null;
    return Object.freeze({
      repositoryRevision: snapshot.revision,
      branch: snapshot.branch,
      detached: !snapshot.branch,
      entries: Object.freeze(entries),
      additions: stats.additions,
      deletions: stats.deletions,
      filesChanged: entries.length,
      identity,
      canCommit: blockedReason === null,
      blockedReason,
    });
  }

  /** Bounded `--cached --numstat` read; used only for the summary line of the form. */
  private async stagedNumstat(
    root: string
  ): Promise<{ readonly additions: number; readonly deletions: number }> {
    const raw = await this.tryGit(
      ['diff', '--cached', '--numstat', '--no-ext-diff', '--no-textconv', '-z'],
      root
    );
    if (!raw) return { additions: 0, deletions: 0 };
    let additions = 0;
    let deletions = 0;
    for (const record of raw.split('\0')) {
      if (!record) continue;
      const [added, removed] = record.split('\t');
      // Binary entries report `-` for both counts and contribute nothing to the totals.
      if (/^\d+$/u.test(added ?? '')) additions += Number(added);
      if (/^\d+$/u.test(removed ?? '')) deletions += Number(removed);
    }
    return { additions, deletions };
  }

  /**
   * v0.3.17 S3 — commit against a frozen expectation of HEAD and the index tree (plan §7.9).
   *
   * Differences from the previous implementation, all deliberate:
   *   - a **separate runner** that leaves the repository's own hooks and signing
   *     configuration in place, instead of the read hardening that disables hooks;
   *   - the message may contain real newlines (summary + body) and is rejected only for
   *     control characters that would corrupt a commit object;
   *   - the index and HEAD are captured before and re-read after, and any change that is not
   *     ours is reported rather than rolled back;
   *   - a timeout is not treated as "not committed": the outcome is queried by requestId.
   */
  async commit(input: {
    readonly summary: string;
    readonly body?: string;
    readonly expectedRepositoryRevision: string;
    readonly requestId: string;
  }): Promise<GitCommitOutcomeV1> {
    const message = normalizeCommitMessage(input.summary, input.body);
    if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/u.test(input.requestId)) {
      throw new WebWorkbenchError(400, 'requestId is invalid.', 'git_request_id_invalid');
    }
    const pathsInfo = await this.resolveIndexPaths();
    const before = await this.capture();
    if (!before.isRepository) {
      throw new WebWorkbenchError(409, 'Git repository is unavailable.', 'git_not_repository');
    }
    if (before.revision !== input.expectedRepositoryRevision) {
      throw new WebWorkbenchError(
        409,
        'Repository changed before commit.',
        'git_revision_conflict'
      );
    }
    if (before.conflictedRecords > 0) {
      throw new WebWorkbenchError(
        409,
        'Unresolved conflicts must be handled before committing.',
        'git_conflict_unresolved'
      );
    }
    if (before.stagedRecords === 0) {
      throw new WebWorkbenchError(409, 'Nothing is staged to commit.', 'git_nothing_staged');
    }

    const previousHead = before.head;
    const identity = await this.describeCommitConfiguration(pathsInfo.root);

    const startedAt = Date.now();
    try {
      // `-F -` so the message travels as a literal payload; no shell, no argument parsing.
      await this.runGit(['commit', '-F', '-'], pathsInfo.root, 'commit', undefined, message);
    } catch (error) {
      // A timed-out or interrupted commit may still have landed. Always report the truth.
      const recovery = await this.recoverCommit(pathsInfo.root, previousHead);
      if (recovery.committed && recovery.commitSha) {
        return Object.freeze({
          status: 'committed' as const,
          commitSha: recovery.commitSha,
          repositoryRevision: await this.revisionAfterMutation(),
          durationMs: Date.now() - startedAt,
          identity,
          warning: `提交进程报告失败，但提交已实际完成：${describeError(error)}`,
        });
      }
      throw error;
    }

    const after = await this.recoverCommit(pathsInfo.root, previousHead);
    if (!after.committed || !after.commitSha) {
      throw new WebWorkbenchError(
        503,
        'The commit did not produce a new HEAD.',
        'git_commit_unconfirmed'
      );
    }
    return Object.freeze({
      status: 'committed' as const,
      commitSha: after.commitSha,
      repositoryRevision: await this.revisionAfterMutation(),
      durationMs: Date.now() - startedAt,
      identity,
    });
  }

  /**
   * A commit is confirmed by HEAD having moved to a *new* commit, never by exit code alone.
   * This is what makes the timeout path safe: we ask Git what actually happened.
   */
  private async recoverCommit(
    root: string,
    previousHead: string | null
  ): Promise<{ readonly committed: boolean; readonly commitSha: string | null }> {
    const head = (await this.tryGit(['rev-parse', '--verify', 'HEAD'], root))?.trim() ?? null;
    if (!head) return { committed: false, commitSha: null };
    if (head === previousHead) return { committed: false, commitSha: null };
    return { committed: true, commitSha: head };
  }

  /** Identity and hook configuration the commit will actually run under (plan §7.9). */
  private async describeCommitConfiguration(root: string): Promise<GitCommitIdentityV1> {
    const name = (await this.tryGit(['config', 'user.name'], root))?.trim() ?? null;
    const email = (await this.tryGit(['config', 'user.email'], root))?.trim() ?? null;
    const signingKey = (await this.tryGit(['config', 'user.signingkey'], root))?.trim() ?? null;
    const gpgsign = (await this.tryGit(['config', 'commit.gpgsign'], root))?.trim() ?? null;
    // `rev-parse --git-path hooks` accounts for core.hooksPath; a missing directory means no
    // hooks will run, which the form states instead of silently skipping them.
    const hooksPath =
      (await this.tryGit(['rev-parse', '--git-path', 'hooks'], root))?.trim() ?? null;
    const hooksDir = hooksPath ? resolve(root, hooksPath) : null;
    return Object.freeze({
      name,
      email,
      signingKey,
      signingEnabled: gpgsign === 'true',
      hooksDir,
      hooksPresent: hooksDir !== null && existsSync(hooksDir),
    });
  }

  private async mutate(args: readonly string[]): Promise<void> {
    const root = await this.requireRepositoryRoot();
    await this.runGit(args, root, 'index');
  }

  private async requireRepositoryRoot(): Promise<string> {
    const snapshot = await this.capture();
    if (snapshot.repositoryKind === 'bare') {
      // v0.3.19 (G317-22) — a bare repository *is* a repository, so "unavailable" was the
      // wrong word for it. What it lacks is a working tree, and this panel is worktree-based:
      // the limit is stated rather than worked around, and reading from a different working
      // tree would widen access in a way the workspace boundary does not allow.
      throw new Error(
        'This workspace is a bare repository. The Git panel reads a working tree, so it has no changes or history to show here.'
      );
    }
    if (!snapshot.isRepository || !snapshot.root) {
      throw new Error('Git repository is unavailable.');
    }
    return snapshot.root;
  }

  /**
   * v0.3.17 S1 — a mutation reports the same state digest `status()` reports. Returning
   * `rev-parse HEAD` was a different value space AND did not move on stage/unstage, so it
   * could never express "the index changed".
   *
   * NOTE: this is post-write verification, not an atomic compare-and-swap. The real
   * check-write window is S3 scope (plan §7.7); until then nothing may claim atomicity.
   */
  private async revisionAfterMutation(): Promise<string> {
    const snapshot = await this.capture();
    if (!snapshot.isRepository) throw new Error('Git repository is unavailable.');
    return snapshot.revision;
  }

  /**
   * v0.3.17 S3 — one exec path, three explicit profiles.
   *
   * `read` keeps every hardening from v0.3.12. `index` relaxes only what staging must
   * resolve (user config for filters/CRLF) while keeping hooks disabled. `commit` is the
   * deliberate exception from plan §7.9: it lets the repository's own hooks and signing
   * configuration run, and gets its own bounded budget instead of the 5s read budget.
   * The profiles are separate on purpose — enabling commit hooks must not relax reads.
   *
   * Implemented with `spawn` rather than `execFile` for two reasons found the hard way:
   *   1. the async `execFile`/`exec` `input` option is silently ignored, so `git apply -`
   *      blocked forever waiting for stdin that never closed;
   *   2. a timeout must kill the whole process group, otherwise a slow `pre-commit` hook
   *      survives as an orphan while we report failure.
   */
  private runGit(
    args: readonly string[],
    cwd: string,
    profile: 'read' | 'index' | 'commit' = 'read',
    env?: NodeJS.ProcessEnv,
    input?: string
  ): Promise<string> {
    return this.runGitBytes(args, cwd, profile, env, input).then(buffer => buffer.toString('utf8'));
  }

  /**
   * v0.3.17 S5 — the byte-level primitive behind `runGit`.
   *
   * Historical file content may not be valid UTF-8, so blob reads must not round-trip
   * through a string. Everything else (hardening prefix, profile, byte budget, timeout,
   * process-group kill) is shared, which is why this is the same body and not a copy.
   */
  private runGitBytes(
    args: readonly string[],
    cwd: string,
    profile: 'read' | 'index' | 'commit' = 'read',
    env?: NodeJS.ProcessEnv,
    /** stdin payload, used by `git apply -` and `git commit -F -`. Never browser input. */
    input?: string
  ): Promise<Buffer> {
    const prefix =
      profile === 'read'
        ? hardenedGitPrefix()
        : profile === 'index'
          ? writeGitPrefix()
          : commitGitPrefix();
    const environment = profile === 'read' ? gitEnvironment() : (env ?? writeGitEnvironment());
    const timeout = profile === 'commit' ? this.commitTimeoutMs : GIT_TIMEOUT_MS;

    return new Promise((resolvePromise, reject) => {
      this.performance.processCount += 1;
      const child = spawn('git', [...prefix, ...args], {
        cwd,
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group, so a timeout can take the hook processes down with it.
        detached: true,
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let timedOut = false;
      let overflowed = false;

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeout);

      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        this.performance.bytesRead += chunk.length;
        if (bytes > GIT_MAX_BUFFER) {
          overflowed = true;
          killProcessTree(child);
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        this.performance.bytesRead += chunk.length;
        if (bytes > GIT_MAX_BUFFER) {
          overflowed = true;
          killProcessTree(child);
          return;
        }
        stderr.push(chunk);
      });

      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
          return;
        }
        resolvePromise(Buffer.concat(stdout));
      };

      child.on('error', (error: Error) => {
        settle(new WebWorkbenchError(503, redactTraceText(error.message), 'git_command_failed'));
      });

      child.on('close', (code: number | null) => {
        if (timedOut) {
          settle(new WebWorkbenchError(503, 'Git command timed out.', 'git_timeout'));
          return;
        }
        if (overflowed) {
          settle(
            new WebWorkbenchError(
              503,
              'Git output exceeded the bounded read limit.',
              'git_output_too_large'
            )
          );
          return;
        }
        if (code === 0) {
          settle();
          return;
        }
        const message = Buffer.concat(stderr).toString('utf8').trim();
        settle(
          new WebWorkbenchError(
            503,
            redactTraceText(message || `Git exited with code ${code ?? 'unknown'}.`),
            'git_command_failed'
          )
        );
      });

      if (input === undefined) {
        child.stdin.end();
        return;
      }
      // stdin must be explicitly closed; a `-` argument otherwise blocks the child forever.
      child.stdin.on('error', () => {
        // The child may exit before consuming the payload; the close handler already decided.
      });
      child.stdin.end(input, 'utf8');
    });
  }

  private async tryGit(args: readonly string[], cwd: string): Promise<string | undefined> {
    try {
      return await this.runGit(args, cwd);
    } catch {
      return undefined;
    }
  }

  private encodeCursor(payload: CursorPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  private decodeCursor(
    cursor: string,
    kind: CursorPayload['kind'],
    revision: string,
    fileId?: string,
    scope?: string
  ): CursorPayload {
    if (!cursor || cursor.length > 4096) return invalidCursor();
    const [body, encodedSignature, extra] = cursor.split('.');
    if (!body || !encodedSignature || extra) return invalidCursor();
    const expected = createHmac('sha256', this.secret).update(body).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(encodedSignature, 'base64url');
    } catch {
      return invalidCursor();
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return invalidCursor();
    }
    try {
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CursorPayload;
      if (
        parsed.version !== 2 ||
        parsed.kind !== kind ||
        parsed.fileId !== fileId ||
        parsed.scope !== scope ||
        !Number.isSafeInteger(parsed.offset) ||
        parsed.offset < 0
      ) {
        return invalidCursor();
      }
      if (parsed.revision !== revision) {
        throw new WebWorkbenchError(409, 'Git cursor revision is stale.', 'git_revision_conflict');
      }
      return parsed;
    } catch (error) {
      if (error instanceof WebWorkbenchError) throw error;
      return invalidCursor();
    }
  }
}

function parsePorcelainV1(output: string): GitStatusRecord[] {
  const fields = output.split('\0');
  const records: GitStatusRecord[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field || field.length < 4) continue;
    const indexStatus = field[0];
    const worktreeStatus = field[1];
    const path = field.slice(3);
    if (!safeGitPath(path)) continue;
    const renamed = indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R';
    const renamedFrom = renamed ? fields[++index] : undefined;
    records.push(
      Object.freeze({
        path,
        indexStatus,
        worktreeStatus,
        ...(renamedFrom && safeGitPath(renamedFrom) ? { renamedFrom } : {}),
      })
    );
  }
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

function safeGitPath(path: string): boolean {
  return (
    Boolean(path) &&
    path.length <= 4096 &&
    !path.includes('\0') &&
    !path.includes('\r') &&
    !path.includes('\n') &&
    !isAbsolute(path) &&
    path !== '..' &&
    !path.startsWith('../') &&
    !path.includes('/../')
  );
}

function recordStillMatches(record: GitStatusRecord, source: GitWorktreeSourceV1): boolean {
  return recordSources(record).includes(source);
}

function parseCommit(record: string): WebGitCommitV1 {
  const [id, shortId, timestamp, authorName, subject] = record.split('\x1f');
  if (!id || !shortId || !timestamp || !authorName || subject === undefined) {
    throw new WebWorkbenchError(502, 'Git log record is invalid.', 'git_output_invalid');
  }
  const authoredAt = new Date(Number(timestamp) * 1000);
  if (!Number.isFinite(authoredAt.valueOf())) {
    throw new WebWorkbenchError(502, 'Git log timestamp is invalid.', 'git_output_invalid');
  }
  return Object.freeze({
    id,
    shortId,
    authoredAt: authoredAt.toISOString(),
    authorName: redactTraceText(authorName),
    subject: redactTraceText(subject),
  });
}

/**
 * v0.3.17 S1 — the token's source decides the command, so exactly one comparison is
 * produced. Previously a mixed (`MM`) file emitted both `--cached` and worktree diffs and
 * the caller merged them into one page, making the two sources indistinguishable.
 */
function diffCommands(
  path: string,
  source: WebGitFileSourceV1,
  ignoreWhitespace = false,
  wordDiff = false
): readonly DiffCommand[] {
  const modes = [
    ...(ignoreWhitespace ? ['--ignore-all-space'] : []),
    ...(wordDiff ? ['--word-diff=plain'] : []),
  ];
  if (source === 'staged') {
    return Object.freeze([
      {
        title: 'Staged',
        args: [
          'diff',
          '--cached',
          ...modes,
          '--no-ext-diff',
          '--no-textconv',
          '--unified=3',
          '--',
          path,
        ],
      },
    ]);
  }
  if (source === 'unstaged') {
    return Object.freeze([
      {
        title: 'Working tree',
        args: ['diff', ...modes, '--no-ext-diff', '--no-textconv', '--unified=3', '--', path],
      },
    ]);
  }
  if (source === 'untracked') {
    return Object.freeze([
      {
        title: 'Untracked',
        args: [
          'diff',
          '--no-index',
          ...modes,
          '--no-ext-diff',
          '--no-textconv',
          '--unified=3',
          '--',
          GIT_NULL_DEVICE,
          path,
        ],
        acceptedExitCodes: [0, 1],
      },
    ]);
  }
  // Conflict version selection (base / ours / theirs) is S5 scope. Until then keep the
  // pre-existing index-vs-worktree pair so nothing regresses.
  return Object.freeze([
    {
      title: 'Staged',
      args: ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--unified=3', '--', path],
    },
    {
      title: 'Working tree',
      args: ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', '--', path],
    },
  ]);
}

/** v0.3.17 S3 — every index mutation answers with the state version it produced. */
export interface GitMutationResultV1 {
  readonly repositoryRevision: string;
}

/**
 * v0.3.17 S3 — the identity, signing and hook configuration a commit will actually run
 * under. Shown in the form so a failure is explainable instead of mysterious (plan §7.9).
 */
export interface GitCommitIdentityV1 {
  readonly name: string | null;
  readonly email: string | null;
  readonly signingKey: string | null;
  readonly signingEnabled: boolean;
  readonly hooksDir: string | null;
  readonly hooksPresent: boolean;
}

export interface GitCommitOutcomeV1 {
  readonly status: 'committed';
  readonly commitSha: string;
  readonly repositoryRevision: string;
  readonly durationMs: number;
  readonly identity: GitCommitIdentityV1;
  /** Set when the process reported failure but Git had in fact committed. */
  readonly warning?: string;
}

/** One entry of the actual index that a commit would include. */
export interface GitIndexEntryV1 {
  readonly path: string;
  readonly source: WebGitFileSourceV1;
  readonly status: string;
}

export interface GitCommitPreviewV1 {
  readonly repositoryRevision: string;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly entries: readonly GitIndexEntryV1[];
  readonly additions: number;
  readonly deletions: number;
  readonly filesChanged: number;
  readonly identity: GitCommitIdentityV1;
  readonly canCommit: boolean;
  /** Why the form is disabled, when it is. */
  readonly blockedReason: string | null;
}

/** v0.3.17 S1 — every comparison source a status record participates in. */
// A status record is always a working-tree state; typing the result narrowly makes the
// compiler enforce that no comparison-only source can ever leak into a status bucket.
function recordSources(record: GitStatusRecord): readonly GitWorktreeSourceV1[] {
  if (isConflictRecord(record)) return Object.freeze(['conflict'] as const);
  if (record.indexStatus === '?') return Object.freeze(['untracked'] as const);
  const sources: GitWorktreeSourceV1[] = [];
  if (record.indexStatus !== ' ') sources.push('staged');
  if (record.worktreeStatus !== ' ') sources.push('unstaged');
  return Object.freeze(sources);
}

function countSources(records: readonly GitStatusRecord[]): Omit<WebGitStatusCountsV1, 'loaded'> {
  let conflicted = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const record of records) {
    for (const source of recordSources(record)) {
      if (source === 'staged') staged += 1;
      else if (source === 'unstaged') unstaged += 1;
      else if (source === 'untracked') untracked += 1;
      else conflicted += 1;
    }
  }
  return { total: records.length, conflicted, staged, unstaged, untracked };
}

/**
 * v0.3.17 S4 — the status group filter accepts only a working-tree source.
 *
 * The distinction is load-bearing: passing the wider comparison-source union here would let a
 * caller ask for the `commit` group and silently get nothing, hiding the mistake. It is
 * rejected up front with a clear code instead.
 */
function normalizeSource(value: unknown): GitWorktreeSourceV1 | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!(GIT_WORKTREE_SOURCES_V1 as readonly string[]).includes(value as string)) {
    throw new WebWorkbenchError(400, 'group must be a known Git file source.', 'git_query_invalid');
  }
  return value as GitWorktreeSourceV1;
}

function normalizeQuery(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 256) {
    throw new WebWorkbenchError(
      400,
      'query must be a string of at most 256 characters.',
      'git_query_invalid'
    );
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.toLocaleLowerCase() : undefined;
}

/** Binds the active filter into the cursor so pages never mix two query scopes. */
function statusScope(group: GitWorktreeSourceV1 | undefined, query: string | undefined): string {
  return createHash('sha256')
    .update(`${group ?? '*'}\u0000${query ?? '*'}`)
    .digest('hex')
    .slice(0, 16);
}

function isConflictRecord(record: GitStatusRecord): boolean {
  return (
    record.indexStatus === 'U' ||
    record.worktreeStatus === 'U' ||
    `${record.indexStatus}${record.worktreeStatus}` === 'AA' ||
    `${record.indexStatus}${record.worktreeStatus}` === 'DD'
  );
}

function isSensitiveGitRecord(record: GitStatusRecord): boolean {
  return (
    isSensitiveFilePath(record.path) ||
    (record.renamedFrom !== undefined && isSensitiveFilePath(record.renamedFrom))
  );
}

async function streamDiffPage(input: {
  readonly cwd: string;
  readonly commands: readonly DiffCommand[];
  readonly offset: number;
  readonly lineLimit: number;
  readonly byteLimit: number;
  readonly onProcess: () => void;
  readonly onBytes: (bytes: number) => void;
}): Promise<{
  readonly lines: string[];
  readonly returnedLines: number;
  readonly hasMore: boolean;
  readonly linesParsed: number;
}> {
  const lines: string[] = [];
  let virtualLine = 0;
  let bytes = 0;
  let hasMore = false;
  let oversizedLine = false;
  let linesParsed = 0;
  const acceptLine = (raw: string): boolean => {
    linesParsed += 1;
    const line = redactTraceText(raw.split(input.cwd).join('[WORKSPACE]'));
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (lineBytes > input.byteLimit) {
      oversizedLine = true;
      return false;
    }
    if (virtualLine < input.offset) {
      virtualLine += 1;
      return true;
    }
    if (lines.length >= input.lineLimit || bytes + lineBytes > input.byteLimit) {
      hasMore = true;
      return false;
    }
    lines.push(line);
    bytes += lineBytes;
    virtualLine += 1;
    return true;
  };

  for (const command of input.commands) {
    if (!acceptLine(`## ${command.title}`)) break;
    const completed = await streamGitLines({
      cwd: input.cwd,
      args: command.args,
      acceptedExitCodes: command.acceptedExitCodes ?? [0],
      onLine: acceptLine,
      onProcess: input.onProcess,
      onBytes: input.onBytes,
    });
    if (!completed) {
      hasMore = true;
      break;
    }
  }
  if (oversizedLine) {
    throw new WebWorkbenchError(
      413,
      'A Git diff line exceeds the bounded page size.',
      'git_line_too_long'
    );
  }
  return Object.freeze({ lines, returnedLines: lines.length, hasMore, linesParsed });
}

function streamGitLines(input: {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly acceptedExitCodes: readonly number[];
  readonly onLine: (line: string) => boolean;
  readonly onProcess: () => void;
  readonly onBytes: (bytes: number) => void;
}): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    input.onProcess();
    const child = spawn('git', [...hardenedGitPrefix(), ...input.args], {
      cwd: input.cwd,
      env: gitEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffer = '';
    let stderr = '';
    let outputBytes = 0;
    let paginationStopped = false;
    let timedOut = false;
    let outputTooLarge = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, GIT_TIMEOUT_MS);
    timer.unref();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      input.onBytes(Buffer.byteLength(chunk, 'utf8'));
      if (paginationStopped || timedOut || outputTooLarge) return;
      outputBytes += Buffer.byteLength(chunk, 'utf8');
      if (outputBytes > GIT_MAX_BUFFER) {
        outputTooLarge = true;
        buffer = '';
        clearTimeout(timer);
        child.kill('SIGTERM');
        return;
      }
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/u, '');
        buffer = buffer.slice(newline + 1);
        if (!input.onLine(line)) {
          paginationStopped = true;
          clearTimeout(timer);
          child.kill('SIGTERM');
          break;
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      input.onBytes(Buffer.byteLength(chunk, 'utf8'));
      outputBytes += Buffer.byteLength(chunk, 'utf8');
      if (outputBytes > GIT_MAX_BUFFER && !outputTooLarge) {
        outputTooLarge = true;
        clearTimeout(timer);
        child.kill('SIGTERM');
      }
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        timedOut
          ? new WebWorkbenchError(503, 'Git command timed out.', 'git_timeout')
          : outputTooLarge
            ? new WebWorkbenchError(
                503,
                'Git output exceeded the bounded read limit.',
                'git_output_too_large'
              )
            : new WebWorkbenchError(503, redactTraceText(error.message), 'git_command_failed')
      );
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new WebWorkbenchError(503, 'Git command timed out.', 'git_timeout'));
        return;
      }
      if (outputTooLarge) {
        reject(
          new WebWorkbenchError(
            503,
            'Git output exceeded the bounded read limit.',
            'git_output_too_large'
          )
        );
        return;
      }
      if (!paginationStopped && buffer && !input.onLine(buffer)) paginationStopped = true;
      if (!paginationStopped && !input.acceptedExitCodes.includes(code ?? -1)) {
        reject(
          new WebWorkbenchError(
            503,
            redactTraceText(stderr || 'Git diff command failed.'),
            'git_command_failed'
          )
        );
        return;
      }
      resolvePromise(!paginationStopped);
    });
  });
}

function assertSafeGitPaths(paths: readonly string[]): void {
  for (const path of paths) {
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.length > 4096 ||
      path.includes('\0') ||
      path.startsWith('-') ||
      path.includes('/../') ||
      path === '..' ||
      path.startsWith('../')
    ) {
      throw new Error(`Unsafe Git path rejected: ${JSON.stringify(path)}`);
    }
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE,
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  };
}

function hardenedGitPrefix(): string[] {
  return [
    '-c',
    'core.quotepath=false',
    '-c',
    'core.fsmonitor=false',
    '-c',
    `core.hooksPath=${GIT_NULL_DEVICE}`,
    '-c',
    'log.showSignature=false',
    '--literal-pathspecs',
  ];
}

/**
 * v0.3.17 S3 — commit runner prefix.
 *
 * This is the one place where hooks are deliberately **not** disabled and the user's own
 * configuration is authoritative (plan §7.9). It is a separate function, not a parameter on
 * the read prefix, so enabling commit hooks can never leak into Git reads.
 */
function commitGitPrefix(): string[] {
  return ['-c', 'core.quotepath=false', '--literal-pathspecs'];
}

/**
 * v0.3.17 S3 — summary plus optional body.
 *
 * The previous validator rejected any newline, which made a real commit body impossible
 * (plan G3 asks for exactly that fix). What must still be rejected are characters that would
 * corrupt or truncate the commit object: NUL and other C0 controls, except the newlines and
 * tabs a message legitimately contains.
 */
export function normalizeCommitMessage(summary: string, body?: string): string {
  if (typeof summary !== 'string') {
    throw new WebWorkbenchError(400, 'A commit summary is required.', 'git_message_invalid');
  }
  const trimmedSummary = summary.trim();
  if (!trimmedSummary) {
    throw new WebWorkbenchError(400, 'A commit summary is required.', 'git_message_invalid');
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(trimmedSummary)) {
    throw new WebWorkbenchError(
      400,
      'A commit summary must not contain control characters.',
      'git_message_invalid'
    );
  }
  const trimmedBody = (body ?? '').replace(/\r\n/gu, '\n').trim();
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(trimmedBody)) {
    throw new WebWorkbenchError(
      400,
      'A commit body must not contain control characters.',
      'git_message_invalid'
    );
  }
  const message = trimmedBody ? `${trimmedSummary}\n\n${trimmedBody}\n` : `${trimmedSummary}\n`;
  // Bound the whole payload, not just each half.
  if (message.length > 20_000) {
    throw new WebWorkbenchError(400, 'A commit message is too long.', 'git_message_invalid');
  }
  return message;
}

/** Binds the two content-changing diff modes into the pagination cursor scope. */
function diffScope(ignoreWhitespace: boolean, wordDiff: boolean): string {
  return `iw:${ignoreWhitespace ? 1 : 0}:wd:${wordDiff ? 1 : 0}`;
}

function describeError(error: unknown): string {
  return redactTraceText(error instanceof Error ? error.message : 'unknown error');
}

/**
 * v0.3.17 S4 — a repository-relative path coming from a history request.
 *
 * Validated, never escaped: anything that could be read as a revision expression, a pathspec
 * magic prefix or an absolute path is refused outright rather than passed to argv.
 */
export function assertRelativeGitPath(path: unknown): string {
  if (typeof path !== 'string' || !path || path.length > 1024) {
    throw new WebWorkbenchError(400, 'A file path is required.', 'git_path_invalid');
  }
  if (path.startsWith('/') || path.includes('\0') || path.startsWith(':')) {
    throw new WebWorkbenchError(400, 'Unsafe Git path.', 'git_path_unsafe');
  }
  const segments = path.split('/');
  if (segments.some(segment => segment === '..' || segment === '.' || segment === '')) {
    throw new WebWorkbenchError(400, 'Unsafe Git path.', 'git_path_unsafe');
  }
  return path;
}

/**
 * A commit-diff cursor carries its comparison identity, so a page from a different commit,
 * base or parent is rejected instead of silently stitched onto the wrong document.
 */
function encodeCommitDiffCursor(input: {
  readonly margin: string;
  readonly offset: number;
}): string {
  return Buffer.from(JSON.stringify({ v: 1, ...input }), 'utf8').toString('base64url');
}

function decodeCommitDiffCursor(cursor: string, margin: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new WebWorkbenchError(400, 'Diff cursor is not valid.', 'git_cursor_invalid');
  }
  const candidate = parsed as { readonly margin?: unknown; readonly offset?: unknown };
  if (
    candidate.margin !== margin ||
    typeof candidate.offset !== 'number' ||
    !Number.isInteger(candidate.offset) ||
    candidate.offset < 0
  ) {
    throw new WebWorkbenchError(
      409,
      'Diff changed; reload before paginating.',
      'git_cursor_invalid'
    );
  }
  return candidate.offset;
}

/**
 * Kills a detached child and everything it spawned.
 *
 * A `pre-commit` hook runs as a child of `git`, so killing only `git` on timeout would leave
 * the hook running and, worse, leave `index.lock` behind if the hook owned it.
 */
function killProcessTree(child: {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
}): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

function canonicalDirectory(path: string): string {
  try {
    const canonical = realpathSync(resolve(path));
    if (!statSync(canonical).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch {
    throw new WebWorkbenchError(400, 'Workspace directory is unavailable.');
  }
}

function fingerprintWorktreePath(root: string, path: string): readonly string[] {
  const candidate = resolve(root, path);
  if (!isWithinRoot(candidate, root)) return Object.freeze([path, 'outside']);
  try {
    const stat = lstatSync(candidate, { bigint: true });
    return Object.freeze([
      path,
      stat.dev.toString(),
      stat.ino.toString(),
      stat.mode.toString(),
      stat.size.toString(),
      stat.mtimeNs.toString(),
      stat.ctimeNs.toString(),
    ]);
  } catch {
    return Object.freeze([path, 'missing']);
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new WebWorkbenchError(400, `${name} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

function invalidCursor(): never {
  throw new WebWorkbenchError(400, 'Git cursor is invalid.', 'git_cursor_invalid');
}
