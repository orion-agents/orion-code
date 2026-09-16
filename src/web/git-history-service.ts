/**
 * v0.3.17 S4 — history reading: refs, commit details, commit file lists, search, file history.
 *
 * Split out of the read model service on purpose (plan §8.2 "读模型服务及拆分服务"): this
 * module owns *metadata* about immutable objects, while the service keeps owning the bounded
 * diff stream. Nothing here writes to the working tree or the index, which is what the §10
 * S4 exit evidence asks for ("无工作区写入的历史浏览").
 *
 * Correctness rules this module is responsible for (plan G4):
 *   - a normal commit is compared with its parent; a **root** commit is compared with the
 *     empty tree instead of failing;
 *   - a **merge** commit defaults to its first parent, is explicitly marked as a merge, and
 *     lets the caller pick a different parent;
 *   - the *commit set* of a two-dot range and the *tree difference* of two commits are
 *     different things and are never conflated: the commit list comes from `git log`, the
 *     file list from a tree diff;
 *   - search runs on the Host across the whole reachable history, never over a rendered page;
 *   - a pagination cursor is bound to the frozen tip OID **and** a fingerprint of the query,
 *     so a moved ref invalidates it instead of silently returning a different result set.
 */
import { createHash } from 'crypto';

import { isSensitiveFilePath } from '../services/redaction';
import { WebWorkbenchError } from './errors';

/** `git hash-object -t tree /dev/null` — the canonical empty tree, used for root commits. */
export const GIT_EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const REF_LIMIT = 400;
const COMMIT_FILE_LIMIT = 2_000;
const SEARCH_PAGE_DEFAULT = 30;
const SEARCH_PAGE_MAX = 100;
const FILE_HISTORY_LIMIT = 200;

export type GitRefKindV1 = 'branch' | 'tag' | 'remote' | 'other';

export interface GitRefV1 {
  /** e.g. `refs/heads/main`, `refs/tags/v1`, `refs/remotes/origin/main`. */
  readonly name: string;
  /** Short display form, e.g. `main`, `v1`, `origin/main`. */
  readonly shortName: string;
  readonly kind: GitRefKindV1;
  readonly oid: string;
  /** True for the ref HEAD points at. */
  readonly isHead: boolean;
}

export interface GitRefsV1 {
  readonly refs: readonly GitRefV1[];
  readonly head: string | null;
  readonly detached: boolean;
  readonly truncated: boolean;
}

export interface GitCommitSummaryV1 {
  readonly id: string;
  readonly shortId: string;
  readonly subject: string;
  readonly authorName: string;
  readonly authoredAt: string;
  /** Parents, first parent first. Empty for a root commit. */
  readonly parents: readonly string[];
  /** True when the commit has more than one parent. */
  readonly isMerge: boolean;
  /** `%D` decoration, trimmed; never used to infer identity. */
  readonly decoration: readonly string[];
}

export interface GitCommitDetailV1 extends GitCommitSummaryV1 {
  readonly message: string;
  readonly committerName: string;
  readonly committedAt: string;
  readonly authorEmail: string;
  /**
   * The tree the commit is compared against: the first parent, or a caller-chosen parent, or
   * the empty tree for a root commit. Exposed so the UI states the real comparison.
   */
  readonly baseOid: string;
  readonly baseLabel: string;
  readonly parentIndex: number;
}

export interface GitCommitFileV1 {
  readonly path: string;
  /** Rename source, when Git detected one. */
  readonly renamedFrom: string | null;
  readonly additions: number;
  readonly deletions: number;
  /** True for a binary entry, where numstat reports `-` for both counts. */
  readonly binary: boolean;
  readonly sensitive: boolean;
}

export interface GitCommitFilesV1 {
  readonly commitSha: string;
  readonly baseOid: string;
  readonly baseLabel: string;
  readonly files: readonly GitCommitFileV1[];
  readonly additions: number;
  readonly deletions: number;
  readonly truncated: boolean;
}

export interface GitHistoryQueryV1 {
  /** Substring of the commit message. */
  readonly message?: string;
  /** Substring of the author name or email. */
  readonly author?: string;
  /** Full or abbreviated commit SHA. */
  readonly sha?: string;
  /** Restricts to commits touching this path. */
  readonly path?: string;
  /** ISO date or `YYYY-MM-DD`; passed through as `--since`/`--until`. */
  readonly since?: string;
  readonly until?: string;
  /** Defaults to HEAD. */
  readonly rev?: string;
  readonly cursor?: string;
  readonly pageSize?: number;
}

export interface GitHistoryPageV1 {
  readonly items: readonly GitCommitSummaryV1[];
  readonly nextCursor: string | null;
  /** The tip the page was frozen against, so the UI can state it. */
  readonly tipOid: string | null;
  readonly truncated: boolean;
}

export interface GitBlameLineV1 {
  readonly lineNumber: number;
  readonly commitShort: string;
  readonly author: string;
  readonly authoredAt: string;
  readonly summary: string;
  /** True when the commit predates the history git can see (a grafted/shallow boundary). */
  readonly isBoundary: boolean;
}

export interface GitBlameResultV1 {
  readonly path: string;
  readonly rev: string | null;
  readonly lines: readonly GitBlameLineV1[];
  readonly truncated: boolean;
}

export interface GitGraphRowV1 {
  /** The graph column prefix exactly as git drew it (never re-derived by us). */
  readonly graph: string;
  /** Commit id when the row belongs to a commit; graph-only rows have null. */
  readonly id: string | null;
  readonly shortId: string | null;
  readonly subject: string;
}

export interface GitGraphPageV1 {
  readonly rows: readonly GitGraphRowV1[];
  readonly truncated: boolean;
}

export interface GitFileHistoryPageV1 {
  readonly path: string;
  readonly items: readonly GitCommitSummaryV1[];
  /** True when Git followed a rename across the boundary; the UI must say so. */
  readonly followed: boolean;
  readonly truncated: boolean;
}

export interface GitHistoryReader {
  refs(): Promise<GitRefsV1>;
  commit(oid: string, parentIndex?: number): Promise<GitCommitDetailV1>;
  commitFiles(oid: string, parentIndex?: number): Promise<GitCommitFilesV1>;
  history(query: GitHistoryQueryV1): Promise<GitHistoryPageV1>;
  graph(input: { readonly limit?: number }): Promise<GitGraphPageV1>;
  blame(input: {
    readonly path: string;
    readonly rev?: string;
    readonly limit?: number;
  }): Promise<GitBlameResultV1>;
  fileHistory(input: {
    readonly path: string;
    readonly rev?: string;
    readonly limit?: number;
  }): Promise<GitFileHistoryPageV1>;
}

export interface GitHistoryReaderOptions {
  /** Runs a read-profile git command in the repository root. */
  readonly runGit: (args: readonly string[]) => Promise<string>;
  /** Resolves the repository root, throwing when it is unavailable. */
  readonly requireRoot: () => Promise<string>;
  /** Current repository state version, used to bind cursors. */
  readonly revision: () => Promise<string>;
}

const RECORD_SEPARATOR = '\x1e';
const FIELD_SEPARATOR = '\x1f';

/** Metadata half of the list format; `%b` is fetched separately so a body can never be
 *  mistaken for a separator. */
const LIST_FORMAT = ['%H', '%h', '%ct', '%an', '%s', '%P', '%D'].join(FIELD_SEPARATOR);

function bounded(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new WebWorkbenchError(400, `${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function assertOid(value: string, name = 'oid'): string {
  // Full or abbreviated SHA-1/SHA-256 hex. Anything else would be passed to git as a
  // revision expression, which is exactly the injection surface we refuse.
  if (typeof value !== 'string' || !/^[0-9a-f]{4,64}$/iu.test(value)) {
    throw new WebWorkbenchError(400, `${name} must be a commit hash.`, 'git_revision_invalid');
  }
  return value;
}

function assertSafeRelativePath(path: string): string {
  if (typeof path !== 'string' || !path || path.length > 1024) {
    throw new WebWorkbenchError(400, 'A file path is required.', 'git_path_invalid');
  }
  if (path.startsWith('/') || path.includes('\0')) {
    throw new WebWorkbenchError(400, 'Unsafe Git path.', 'git_path_unsafe');
  }
  const segments = path.split('/');
  if (segments.some(segment => segment === '..' || segment === '.' || segment === '')) {
    throw new WebWorkbenchError(400, 'Unsafe Git path.', 'git_path_unsafe');
  }
  return path;
}

/** Bounded, literal-safe search text. Refused rather than escaped so nothing reaches argv. */
function assertSearchText(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 200 || /[\0-\x1f\x7f]/u.test(trimmed)) {
    throw new WebWorkbenchError(400, `${name} is not a valid search term.`, 'git_query_invalid');
  }
  return trimmed;
}

function refKind(name: string): GitRefKindV1 {
  if (name.startsWith('refs/heads/')) return 'branch';
  if (name.startsWith('refs/tags/')) return 'tag';
  if (name.startsWith('refs/remotes/')) return 'remote';
  return 'other';
}

function shortRefName(name: string): string {
  for (const prefix of ['refs/heads/', 'refs/tags/', 'refs/remotes/']) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
}

function parseSummaryRecord(record: string): GitCommitSummaryV1 | null {
  const fields = record.replace(/^\s+/u, '').split(FIELD_SEPARATOR);
  if (fields.length < 7) return null;
  const [id, shortId, committedSeconds, authorName, subject, parents, decoration] = fields;
  if (!/^[0-9a-f]{7,64}$/iu.test(id)) return null;
  const parentList = parents
    .split(' ')
    .map(value => value.trim())
    .filter(Boolean);
  return Object.freeze({
    id,
    shortId,
    subject,
    authorName,
    // `%ct` is seconds; the protocol exposes ISO so the client never re-implements time.
    authoredAt: new Date(Number(committedSeconds) * 1000).toISOString(),
    parents: Object.freeze(parentList),
    isMerge: parentList.length > 1,
    decoration: Object.freeze(
      decoration
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
    ),
  });
}

function parseSummaryPage(raw: string): readonly GitCommitSummaryV1[] {
  return raw
    .split(RECORD_SEPARATOR)
    .map(record => record.replace(/\s+$/u, ''))
    .filter(Boolean)
    .map(parseSummaryRecord)
    .filter((item): item is GitCommitSummaryV1 => item !== null);
}

/** One `--numstat -z` record: `added\tdeleted\t path`, or a rename with an empty path field
 *  followed by the old and new names as their own NUL-terminated fields. */
function parseNumstat(raw: string): readonly GitCommitFileV1[] {
  const fields = raw.split('\0');
  const files: GitCommitFileV1[] = [];
  let index = 0;
  while (index < fields.length) {
    const record = fields[index];
    index += 1;
    if (!record) continue;
    const [added, deleted, inlinePath] = record.split('\t');
    let path = inlinePath ?? '';
    let renamedFrom: string | null = null;
    if (path === '' && index + 1 < fields.length) {
      // Rename: the following two fields are the old and the new path.
      renamedFrom = fields[index];
      path = fields[index + 1];
      index += 2;
    }
    if (!path) continue;
    const binary = added === '-' || deleted === '-';
    files.push(
      Object.freeze({
        path,
        renamedFrom: renamedFrom || null,
        additions: binary ? 0 : Number(added) || 0,
        deletions: binary ? 0 : Number(deleted) || 0,
        binary,
        sensitive: isSensitiveFilePath(path),
      })
    );
    if (files.length >= COMMIT_FILE_LIMIT) break;
  }
  return files;
}

function queryFingerprint(query: GitHistoryQueryV1): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        message: query.message ?? null,
        author: query.author ?? null,
        sha: query.sha ?? null,
        path: query.path ?? null,
        since: query.since ?? null,
        until: query.until ?? null,
        rev: query.rev ?? null,
      })
    )
    .digest('hex')
    .slice(0, 16);
}

export function createGitHistoryReader(options: GitHistoryReaderOptions): GitHistoryReader {
  const { runGit, requireRoot, revision } = options;

  /** Resolves a commit to a base tree SHA and a human label for the comparison. */
  const resolveBase = async (
    oid: string,
    parentIndex: number
  ): Promise<{ readonly baseOid: string; readonly baseLabel: string }> => {
    const parentRaw = (await runGit(['rev-list', '--parents', '-n', '1', oid])).trim();
    const parents = parentRaw.split(' ').slice(1).filter(Boolean);
    if (parents.length === 0) {
      // A root commit has no parent, so the honest comparison is against the empty tree.
      return { baseOid: GIT_EMPTY_TREE_OID, baseLabel: '空树（根提交）' };
    }
    const chosen = parents[Math.min(parentIndex, parents.length - 1)];
    return {
      baseOid: chosen,
      baseLabel:
        parents.length > 1
          ? `父提交 ${parentIndex + 1}/${parents.length}`
          : '父提交',
    };
  };

  return {
    async refs() {
      await requireRoot();
      const head = (
        await runGit(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')
      )
        .toString()
        .trim();
      // Detached is defined by HEAD being a raw oid rather than a symbolic ref, NOT by
      // "no ref points at this oid". Detaching onto a commit that a branch also points at is
      // the common case, and the earlier oid-comparison heuristic misreported it as attached.
      const symbolicHead = (await runGit(['symbolic-ref', '--quiet', 'HEAD']).catch(() => ''))
        .toString()
        .trim();
      // `for-each-ref` does NOT understand the `%x1f` hex escapes that `git log --format`
      // supports — it prints them literally, which silently produced an empty ref list until
      // this was caught against real Git. A space is the safe separator here because
      // `git check-ref-format` forbids spaces in ref names, and records are newline-delimited.
      const raw = await runGit([
        'for-each-ref',
        `--count=${REF_LIMIT + 1}`,
        '--format=%(refname) %(objectname)',
        'refs/heads',
        'refs/tags',
        'refs/remotes',
      ]);
      // An explicit loop rather than a map/filter chain: the intermediate shapes (including
      // the "skip this record" case) stay visible and typed.
      const collected: GitRefV1[] = [];
      for (const record of raw.split('\n')) {
        const trimmed = record.trim();
        if (!trimmed) continue;
        const separator = trimmed.indexOf(' ');
        if (separator <= 0) continue;
        const name = trimmed.slice(0, separator);
        const oid = trimmed.slice(separator + 1).trim();
        collected.push(
          Object.freeze({
            name,
            shortName: shortRefName(name),
            kind: refKind(name),
            oid,
            isHead: Boolean(symbolicHead) && name === symbolicHead,
          })
        );
      }
      collected.sort((left, right) => {
        const order: readonly GitRefKindV1[] = ['branch', 'tag', 'remote', 'other'];
        const byKind = order.indexOf(left.kind) - order.indexOf(right.kind);
        // Stable inside a kind so the list does not reshuffle between reads.
        return byKind !== 0 ? byKind : left.shortName.localeCompare(right.shortName);
      });
      return Object.freeze({
        refs: Object.freeze(collected.slice(0, REF_LIMIT)),
        head: head || null,
        detached: Boolean(head) && !symbolicHead,
        truncated: collected.length > REF_LIMIT,
      });
    },

    async commit(oid, parentIndex = 0) {
      const revisionOid = assertOid(oid);
      await requireRoot();
      if (!Number.isInteger(parentIndex) || parentIndex < 0 || parentIndex > 63) {
        throw new WebWorkbenchError(400, 'parentIndex is out of range.', 'git_query_invalid');
      }
      const summaryRaw = await runGit([
        'log',
        '-1',
        `--format=${LIST_FORMAT}${RECORD_SEPARATOR}`,
        revisionOid,
        '--',
      ]);
      const [summary] = parseSummaryPage(summaryRaw);
      if (!summary) {
        throw new WebWorkbenchError(404, 'Commit was not found.', 'git_revision_not_found');
      }
      if (parentIndex >= Math.max(1, summary.parents.length)) {
        throw new WebWorkbenchError(
          400,
          'parentIndex exceeds the number of parents.',
          'git_query_invalid'
        );
      }
      // The body is a separate call: a commit message may contain any byte, including the
      // separators the list format relies on.
      const message = await runGit(['log', '-1', '--format=%B', summary.id]);
      const committerRaw = (
        await runGit(['log', '-1', `--format=%cn${FIELD_SEPARATOR}%ce${FIELD_SEPARATOR}%cI`, summary.id])
      ).trim();
      const [committerName, authorEmail, committedAt] = committerRaw.split(FIELD_SEPARATOR);
      const base = await resolveBase(summary.id, parentIndex);
      return Object.freeze({
        ...summary,
        message: message.replace(/\s+$/u, ''),
        committerName: committerName ?? '',
        authorEmail: authorEmail ?? '',
        committedAt: committedAt ?? summary.authoredAt,
        baseOid: base.baseOid,
        baseLabel: base.baseLabel,
        parentIndex,
      });
    },

    async commitFiles(oid, parentIndex = 0) {
      const detail = await this.commit(oid, parentIndex);
      const raw = await runGit([
        'diff',
        '--numstat',
        '-z',
        '--no-ext-diff',
        '--no-textconv',
        detail.baseOid,
        detail.id,
      ]);
      const files = parseNumstat(raw);
      let additions = 0;
      let deletions = 0;
      for (const file of files) {
        additions += file.additions;
        deletions += file.deletions;
      }
      return Object.freeze({
        commitSha: detail.id,
        baseOid: detail.baseOid,
        baseLabel: detail.baseLabel,
        files: Object.freeze(files),
        additions,
        deletions,
        truncated: files.length >= COMMIT_FILE_LIMIT,
      });
    },

    async history(query) {
      const root = await requireRoot();
      void root;
      const pageSize = bounded(
        query.pageSize,
        SEARCH_PAGE_DEFAULT,
        1,
        SEARCH_PAGE_MAX,
        'pageSize'
      );
      const message = assertSearchText(query.message, 'message');
      const author = assertSearchText(query.author, 'author');
      const sha = query.sha ? assertOid(query.sha, 'sha') : undefined;
      const path = query.path ? assertSafeRelativePath(query.path) : undefined;
      const since = assertSearchText(query.since, 'since');
      const until = assertSearchText(query.until, 'until');
      const rev = query.rev ? assertSearchText(query.rev, 'rev') : undefined;

      const tip = (
        await runGit(['rev-parse', '--verify', '--quiet', rev ?? 'HEAD']).catch(() => '')
      )
        .toString()
        .trim();
      if (!tip) {
        // A repository without commits is an empty history, not an error (plan G4).
        return Object.freeze({
          items: Object.freeze([]),
          nextCursor: null,
          tipOid: null,
          truncated: false,
        });
      }

      const normalized: GitHistoryQueryV1 = {
        ...(message ? { message } : {}),
        ...(author ? { author } : {}),
        ...(sha ? { sha } : {}),
        ...(path ? { path } : {}),
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
        ...(rev ? { rev } : {}),
      };
      const scopeRevision = await revision();
      const fingerprint = queryFingerprint(normalized);

      // A SHA is a direct lookup, not a text filter: `git log` cannot filter by object id, and
      // faking it with a range expression would silently conflate "the commit set of a range"
      // with "one commit" (plan G4). So a SHA query resolves the object, checks it is reachable
      // from the current rev, and answers with zero or one item. The other text filters are
      // deliberately NOT combined with it, and the API documents that.
      if (sha) {
        const resolved = (
          await runGit(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).catch(() => '')
        )
          .toString()
          .trim();
        if (!resolved) {
          return Object.freeze({
            items: Object.freeze([]),
            nextCursor: null,
            tipOid: tip,
            truncated: false,
          });
        }
        const reachable = await runGit(['merge-base', '--is-ancestor', resolved, tip])
          .then(() => true)
          // `--is-ancestor` exits 1 for "not an ancestor", which is a normal answer.
          .catch(() => false);
        if (!reachable) {
          return Object.freeze({
            items: Object.freeze([]),
            nextCursor: null,
            tipOid: tip,
            truncated: false,
          });
        }
        const single = parseSummaryPage(
          await runGit(['log', '-1', `--format=${LIST_FORMAT}${RECORD_SEPARATOR}`, resolved, '--'])
        );
        return Object.freeze({
          items: Object.freeze(single.slice(0, 1)),
          nextCursor: null,
          tipOid: tip,
          truncated: false,
        });
      }

      const offset = query.cursor
        ? decodeSearchCursor(query.cursor, { tipOid: tip, revision: scopeRevision, fingerprint })
        : 0;

      const args = [
        'log',
        `--skip=${offset}`,
        `--max-count=${pageSize + 1}`,
        `--format=${LIST_FORMAT}${RECORD_SEPARATOR}`,
      ];
      if (message) args.push(`--grep=${message}`, '--regexp-ignore-case');
      if (author) args.push(`--author=${author}`, '--regexp-ignore-case');
      if (since) args.push(`--since=${since}`);
      if (until) args.push(`--until=${until}`);
      // `--full-history` so a path filter does not silently drop merges and simplified side
      // branches; the tree difference is reported separately from the commit set (plan G4).
      if (path) args.push('--full-history');
      args.push(tip);
      if (path) args.push('--', path);

      const raw = await runGit(args);
      const all = parseSummaryPage(raw);
      const hasMore = all.length > pageSize;
      const items = all.slice(0, pageSize);
      return Object.freeze({
        items: Object.freeze(items),
        nextCursor: hasMore
          ? encodeSearchCursor({
              tipOid: tip,
              revision: scopeRevision,
              fingerprint,
              offset: offset + items.length,
            })
          : null,
        tipOid: tip,
        truncated: hasMore,
      });
    },

    async graph(input) {
      const limit = bounded(input.limit, 200, 1, 2_000, 'limit');
      await requireRoot();
      // The graph columns are taken verbatim from git rather than recomputed: a hand-rolled
      // renderer would be a second implementation of lane assignment, and it would disagree
      // with `git log --graph` in exactly the merge cases that matter.
      const raw = await runGit([
        'log',
        '--graph',
        `--max-count=${limit + 1}`,
        '--date-order',
        '--format=%x1f%H%x1f%h%x1f%s',
      ]).catch(() => '');
      const rows: GitGraphRowV1[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const separator = line.indexOf('\x1f');
        if (separator < 0) {
          rows.push(Object.freeze({ graph: line, id: null, shortId: null, subject: '' }));
          continue;
        }
        const graph = line.slice(0, separator);
        const fields = line.slice(separator + 1).split('\x1f');
        rows.push(
          Object.freeze({
            graph,
            id: fields[0] || null,
            shortId: fields[1] || null,
            subject: fields[2] ?? '',
          })
        );
      }
      const truncated = rows.length > limit;
      return Object.freeze({ rows: Object.freeze(rows.slice(0, limit)), truncated });
    },

    async blame(input) {
      const path = assertSafeRelativePath(input.path);
      const limit = bounded(input.limit, 2_000, 1, 5_000, 'limit');
      await requireRoot();
      const rev = input.rev ? assertSearchText(input.rev, 'rev') : undefined;
      const target = rev ?? null;
      const tracked = (
        await runGit(['rev-parse', '--verify', '--quiet', rev ?? 'HEAD']).catch(() => '')
      )
        .toString()
        .trim();
      if (!tracked) {
        return Object.freeze({ path, rev: rev ?? null, lines: Object.freeze([]), truncated: false });
      }
      // `--porcelain` is machine-readable and stable; the date stays ISO so the client never
      // re-implements time. Uncommitted lines show as boundary/not-committed metadata.
      const raw = await runGit([
        'blame',
        '--porcelain',
        ...(target ? [target] : []),
        '--',
        path,
      ]);
      const commits = new Map<string, { author: string; authoredAt: string; summary: string }>();
      const lines: import('./git-history-service').GitBlameLineV1[] = [];
      let currentOid: string | null = null;
      let boundary = false;
      let pendingAuthor = '';
      let pendingTime = '';
      let pendingSummary = '';
      let lineNumber = 0;
      for (const line of raw.split('\n')) {
        if (line.startsWith('\t')) {
          if (!currentOid) continue;
          lineNumber += 1;
          if (lineNumber > limit) break;
          const known = commits.get(currentOid);
          lines.push(
            Object.freeze({
              lineNumber,
              commitShort: currentOid.slice(0, 10),
              author: known?.author ?? pendingAuthor,
              authoredAt: known?.authoredAt ?? pendingTime,
              summary: known?.summary ?? pendingSummary,
              isBoundary: boundary,
            })
          );
          continue;
        }
        const header = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/.exec(line);
        if (header) {
          currentOid = header[1];
          boundary = false;
          pendingAuthor = '';
          pendingTime = '';
          pendingSummary = '';
          const cached = commits.get(currentOid);
          if (cached) {
            pendingAuthor = cached.author;
            pendingTime = cached.authoredAt;
            pendingSummary = cached.summary;
          }
          continue;
        }
        if (!currentOid) continue;
        const separator = line.indexOf(' ');
        const key = separator < 0 ? line : line.slice(0, separator);
        const value = separator < 0 ? '' : line.slice(separator + 1);
        if (key === 'author') pendingAuthor = value;
        else if (key === 'author-time') pendingTime = new Date(Number(value) * 1000).toISOString();
        else if (key === 'summary') pendingSummary = value;
        else if (key === 'boundary') boundary = true;
        if (pendingAuthor && pendingTime && pendingSummary && !commits.has(currentOid)) {
          commits.set(currentOid, Object.freeze({ author: pendingAuthor, authoredAt: pendingTime, summary: pendingSummary }));
        }
      }
      return Object.freeze({
        path,
        rev: rev ?? null,
        lines: Object.freeze(lines),
        truncated: lineNumber > limit,
      });
    },

    async fileHistory(input) {
      const path = assertSafeRelativePath(input.path);
      const limit = bounded(input.limit, SEARCH_PAGE_DEFAULT, 1, FILE_HISTORY_LIMIT, 'limit');
      await requireRoot();
      const rev = input.rev ? assertSearchText(input.rev, 'rev') : undefined;
      const target = rev ?? 'HEAD';
      const tracked = (
        await runGit(['rev-parse', '--verify', '--quiet', target]).catch(() => '')
      )
        .toString()
        .trim();
      if (!tracked) {
        return Object.freeze({ path, items: Object.freeze([]), followed: false, truncated: false });
      }
      // `--follow` only accepts a single path, which is exactly this case. It explains its own
      // limits for copies and complex merges (plan G6) — we surface `followed` rather than
      // pretending tracking is complete.
      const raw = await runGit([
        'log',
        `--max-count=${limit + 1}`,
        `--format=${LIST_FORMAT}${RECORD_SEPARATOR}`,
        '--follow',
        '--',
        path,
      ]);
      const all = parseSummaryPage(raw);
      const items = all.slice(0, limit);
      return Object.freeze({
        path,
        items: Object.freeze(items),
        followed: true,
        truncated: all.length > limit,
      });
    },
  };
}

/**
 * Cursors are opaque to the client and bound to three things: the frozen tip, the repository
 * state version, and the query. Naming them separately means a moved ref or an edited query
 * produces a clear `git_cursor_invalid` instead of a page from a different result set.
 */
interface SearchCursorScope {
  readonly tipOid: string;
  readonly revision: string;
  readonly fingerprint: string;
}

function encodeSearchCursor(scope: SearchCursorScope & { readonly offset: number }): string {
  return Buffer.from(JSON.stringify({ v: 1, ...scope }), 'utf8').toString('base64url');
}

function decodeSearchCursor(cursor: string, expected: SearchCursorScope): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new WebWorkbenchError(400, 'History cursor is not valid.', 'git_cursor_invalid');
  }
  const candidate = parsed as Partial<SearchCursorScope & { readonly offset?: number }>;
  if (
    candidate.tipOid !== expected.tipOid ||
    candidate.revision !== expected.revision ||
    candidate.fingerprint !== expected.fingerprint ||
    typeof candidate.offset !== 'number' ||
    !Number.isInteger(candidate.offset) ||
    candidate.offset < 0
  ) {
    throw new WebWorkbenchError(
      409,
      'History changed; reload the list before paginating.',
      'git_cursor_invalid'
    );
  }
  return candidate.offset;
}
