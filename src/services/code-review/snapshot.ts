/**
 * v0.3.27 PR1 — the minimal shared Git snapshot reader for code review
 * (plan §4.2). One reader, two scopes:
 *
 *  - `worktree`: staged, unstaged and untracked changes are recorded as
 *    separate sources for the same path and are never merged into one
 *    composite diff.
 *  - `base`: the ref, HEAD and merge-base are resolved to immutable OIDs at
 *    admission; later ref movement cannot change the frozen input.
 *
 * Security posture (§4.2.7): git runs with argument arrays through the read
 * profile, never a shell; external diff drivers and textconv are disabled;
 * blobs are read by OID; untracked working files are read directly under the
 * same sensitive/binary/boundary policies as everything else. No optional
 * locks, no arbitrary subcommands exposed to the model.
 */
import { createHash } from 'crypto';
import { realpathSync, statSync } from 'fs';
import { readFile as readFilePromise } from 'fs/promises';
import { resolve, sep } from 'path';

import { isSensitiveFilePath } from '../redaction';
import { DEFAULT_REVIEW_BUDGETS, type ReviewBudgetsV1, type ReviewSelectorV1 } from './contract';

export interface ReviewSnapshotFileSideV1 {
  readonly source: 'staged' | 'unstaged' | 'base' | 'head';
  readonly oid: string | null;
  readonly contentDigest: string;
  readonly byteSize: number;
  readonly truncated: boolean;
}

export interface ReviewSnapshotHunkV1 {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly header: string;
}

/** Mutable build-time shape; frozen into ReviewSnapshotFileV1 at return. */
interface MutableReviewFile {
  readonly fileKey: string;
  readonly path: string;
  readonly oldPath: string | null;
  readonly sensitive: boolean;
  sides: ReviewSnapshotFileSideV1[];
  hunks: ReviewSnapshotHunkV1[];
}

export interface ReviewSnapshotFileV1 {
  readonly fileKey: string;
  readonly path: string;
  readonly oldPath: string | null;
  readonly sensitive: boolean;
  readonly sides: readonly ReviewSnapshotFileSideV1[];
  readonly hunks: readonly ReviewSnapshotHunkV1[];
}

export interface ReviewSnapshotSkipV1 {
  readonly path: string;
  readonly reason:
    | 'over_budget_files'
    | 'over_budget_bytes'
    | 'binary'
    | 'sensitive'
    | 'unreadable'
    | 'changed_during_review'
    | 'other';
  readonly detail?: string;
}

export interface CodeReviewSnapshotV1 {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly kind: 'worktree' | 'base';
  readonly baseOid: string | null;
  readonly headOid: string | null;
  readonly requestedPaths: readonly string[];
  readonly files: readonly ReviewSnapshotFileV1[];
  readonly inputSnapshotDigest: string;
  readonly skipped: readonly ReviewSnapshotSkipV1[];
}

export class ReviewSnapshotError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not_a_repository'
      | 'ref_unresolved'
      | 'no_merge_base'
      | 'path_invalid'
      | 'worktree_changed'
  ) {
    super(message);
    this.name = 'ReviewSnapshotError';
  }
}

/** Runs a read-only git command with argument arrays. The caller injects this,
 *  so tests drive real temporary repositories without spawning beyond git. */
export type ReviewGitRunner = (args: readonly string[]) => Promise<string>;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertSafePath(value: string): string {
  if (
    !value ||
    value.length > 1024 ||
    value.startsWith('/') ||
    value.includes('\0') ||
    value.split('/').includes('..')
  ) {
    throw new ReviewSnapshotError(`Unsafe review path: ${value}`, 'path_invalid');
  }
  return value;
}

interface NameStatusEntry {
  readonly status: string;
  readonly paths: string[];
}

/** Parses `git diff --name-status -z` records into status/path groups. */
function parseNameStatusZ(records: readonly string[]): NameStatusEntry[] {
  const parsed: NameStatusEntry[] = [];
  let index = 0;
  while (index < records.length) {
    const record = records[index];
    if (!record) {
      index += 1;
      continue;
    }
    const status = record.slice(0, 1);
    const paths: string[] = [];
    if (status === 'R' || status === 'C') {
      paths.push(records[index + 1] ?? '', records[index + 2] ?? '');
      index += 3;
    } else {
      paths.push(records[index + 1] ?? '');
      index += 2;
    }
    parsed.push({ status, paths });
  }
  return parsed;
}

interface DiffFileAccumulator {
  path: string;
  hunks: ReviewSnapshotHunkV1[];
  diffBytes: number;
}

function parseDiffHunks(diffText: string): DiffFileAccumulator[] {
  const files: DiffFileAccumulator[] = [];
  let current: DiffFileAccumulator | undefined;
  const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const split = rest.indexOf(' b/');
      current = {
        path: split >= 0 ? rest.slice(split + 3) : rest,
        hunks: [],
        diffBytes: 0,
      };
      files.push(current);
      continue;
    }
    if (!current) continue;
    current.diffBytes += line.length + 1;
    const header = HUNK.exec(line);
    if (header) {
      current.hunks.push({
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        header: line,
      });
    }
  }
  return files;
}

export interface ReviewSnapshotOptionsV1 {
  readonly root: string;
  readonly selector: ReviewSelectorV1;
  readonly budgets?: Partial<ReviewBudgetsV1>;
  readonly runGit: ReviewGitRunner;
  /** Reads one working-tree file relative to the root, or null when missing. */
  readonly readWorktreeFile?: (relativePath: string) => Promise<string | null>;
  readonly snapshotIdPrefix?: string;
}

function pathMatches(path: string, requestedPaths: readonly string[]): boolean {
  if (requestedPaths.length === 0) return true;
  return requestedPaths.some(filter => path === filter || path.startsWith(`${filter}/`));
}

/** The read-only git arguments for the scope's unified diff. Exported so the
 *  v0.3.28 runner captures the exact same diff the snapshot froze instead of
 *  re-deriving OIDs after admission. */
export function reviewUnifiedDiffArgs(
  selector: ReviewSelectorV1,
  oids: { readonly baseOid: string | null; readonly headOid: string | null }
): string[] {
  return selector.kind === 'base'
    ? ['diff', '--no-ext-diff', '--no-textconv', oids.baseOid as string, oids.headOid as string]
    : ['diff', '--no-ext-diff', '--no-textconv', 'HEAD'];
}

/** Resolves the selector to a frozen snapshot. Every OID and digest in the
 *  returned object was taken at admission time; callers persist the returned
 *  digest as the review's input identity. */
export async function captureReviewSnapshot(
  options: ReviewSnapshotOptionsV1
): Promise<CodeReviewSnapshotV1> {
  const budgets: ReviewBudgetsV1 = { ...DEFAULT_REVIEW_BUDGETS, ...options.budgets };
  const { runGit } = options;
  const requestedPaths = (options.selector.paths ?? []).map(assertSafePath);

  let baseOid: string | null = null;
  let headOid: string | null = null;
  let nameStatusArgs: string[];
  let unifiedArgs: string[];
  if (options.selector.kind === 'base') {
    headOid = (await runGit(['rev-parse', '--verify', 'HEAD'])).trim();
    const refOid = (
      await runGit(['rev-parse', '--verify', `${options.selector.ref}^{commit}`]).catch(() => '')
    ).trim();
    if (!refOid) {
      throw new ReviewSnapshotError(
        `Review base ref could not be resolved: ${options.selector.ref}`,
        'ref_unresolved'
      );
    }
    baseOid = (await runGit(['merge-base', refOid, headOid]).catch(() => '')).trim();
    if (!baseOid) {
      throw new ReviewSnapshotError(
        `No merge base between ${options.selector.ref} and HEAD`,
        'no_merge_base'
      );
    }
    nameStatusArgs = [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--find-renames',
      '--name-status',
      '-z',
      baseOid,
      headOid,
    ];
    unifiedArgs = reviewUnifiedDiffArgs(options.selector, { baseOid, headOid });
  } else {
    nameStatusArgs = [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--find-renames',
      '--name-status',
      '-z',
      'HEAD',
    ];
    unifiedArgs = reviewUnifiedDiffArgs(options.selector, { baseOid, headOid });
  }

  const nameStatusRaw = await runGit(nameStatusArgs);
  const changed = parseNameStatusZ(nameStatusRaw.split('\0')).filter(entry => {
    const path = entry.paths.at(-1);
    return Boolean(path) && pathMatches(path as string, requestedPaths);
  });

  const files: MutableReviewFile[] = [];
  const skipped: ReviewSnapshotSkipV1[] = [];
  const seenPaths = new Set<string>();

  for (const entry of changed) {
    const path = assertSafePath(entry.paths.at(-1) as string);
    if (seenPaths.has(path)) continue;
    if (files.length >= budgets.maxFiles) {
      skipped.push({ path, reason: 'over_budget_files' });
      continue;
    }
    seenPaths.add(path);
    const oldPath = entry.status === 'R' || entry.status === 'C' ? (entry.paths[0] ?? null) : null;
    const sensitive = isSensitiveFilePath(path) || (oldPath ? isSensitiveFilePath(oldPath) : false);
    if (sensitive) {
      skipped.push({ path, reason: 'sensitive' });
      continue;
    }
    if (entry.status === 'B') {
      skipped.push({ path, reason: 'binary' });
      continue;
    }
    files.push({
      fileKey: sha256(`${entry.status}:${oldPath ?? ''}:${path}`).slice(0, 16),
      path,
      oldPath,
      sensitive: false,
      sides: [],
      hunks: [],
    });
  }

  const parsedFiles = parseDiffHunks(await runGit(unifiedArgs));
  for (const file of files) {
    const match = parsedFiles.find(candidate => candidate.path === file.path);
    if (match) file.hunks.push(...match.hunks);
  }

  for (const file of files) {
    const totalDiff = file.hunks.reduce((sum, hunk) => sum + hunk.oldLines + hunk.newLines, 0);
    if (totalDiff * 128 > budgets.maxDiffBytes) {
      skipped.push({ path: file.path, reason: 'over_budget_bytes' });
      continue;
    }
    if (options.selector.kind === 'base') {
      const headOidForPath = (
        await runGit(['rev-parse', '--verify', `${headOid as string}:${file.path}`]).catch(() => '')
      ).trim();
      const baseOidForPath = (
        await runGit([
          'rev-parse',
          '--verify',
          `${baseOid as string}:${file.oldPath ?? file.path}`,
        ]).catch(() => '')
      ).trim();
      if (headOidForPath) {
        file.sides.push({
          source: 'head',
          oid: headOidForPath,
          contentDigest: headOidForPath,
          byteSize: Number((await runGit(['cat-file', '-s', headOidForPath])).trim()) || 0,
          truncated: false,
        });
      }
      if (baseOidForPath) {
        file.sides.push({
          source: 'base',
          oid: baseOidForPath,
          contentDigest: baseOidForPath,
          byteSize: Number((await runGit(['cat-file', '-s', baseOidForPath])).trim()) || 0,
          truncated: false,
        });
      }
    } else {
      const indexOid = (
        await runGit(['ls-files', '-s', '-z', '--', file.path]).then(raw => {
          const record = raw.split('\0').find(item => item.length > 0);
          return record ? (record.split(' ')[1] ?? '') : '';
        })
      ).trim();
      if (indexOid) {
        file.sides.push({
          source: 'staged',
          oid: indexOid,
          contentDigest: indexOid,
          byteSize: Number((await runGit(['cat-file', '-s', indexOid])).trim()) || 0,
          truncated: false,
        });
      }
      if (options.readWorktreeFile) {
        const before = await options.readWorktreeFile(file.path);
        if (before === null) {
          file.sides.push({
            source: 'unstaged',
            oid: null,
            contentDigest: sha256(''),
            byteSize: 0,
            truncated: false,
          });
        } else {
          const beforeDigest = sha256(before);
          const after = await options.readWorktreeFile(file.path);
          if (after === null || sha256(after) !== beforeDigest) {
            throw new ReviewSnapshotError(
              `Working file changed while snapshotting: ${file.path}`,
              'worktree_changed'
            );
          }
          file.sides.push({
            source: 'unstaged',
            oid: null,
            contentDigest: beforeDigest,
            byteSize: Buffer.byteLength(before, 'utf8'),
            truncated: before.length > budgets.maxBodyBytes,
          });
        }
      }
    }
  }

  const manifest = {
    kind: options.selector.kind,
    baseOid,
    headOid,
    requestedPaths,
    files: files.map(file => ({
      fileKey: file.fileKey,
      path: file.path,
      oldPath: file.oldPath,
      sides: file.sides.map(side => ({ source: side.source, contentDigest: side.contentDigest })),
    })),
  };
  const inputSnapshotDigest = sha256(JSON.stringify(manifest));
  const snapshotId = `${options.snapshotIdPrefix ?? 'rev'}-${inputSnapshotDigest.slice(0, 16)}`;

  return Object.freeze({
    schemaVersion: 1 as const,
    snapshotId,
    kind: options.selector.kind,
    baseOid,
    headOid,
    requestedPaths,
    files: Object.freeze(
      files.map(
        file =>
          Object.freeze({
            ...file,
            sides: Object.freeze(file.sides),
            hunks: Object.freeze(file.hunks),
          }) as ReviewSnapshotFileV1
      )
    ),
    inputSnapshotDigest,
    skipped: Object.freeze(skipped),
  });
}

/** Reads one working-tree file for review purposes, refusing to leave the
 *  repository root (same containment discipline as the v0.3.25 conflict
 *  reader). Returns null when the file is missing or unreadable. */
export function createContainedWorktreeReader(
  rootInput: string
): (relativePath: string) => Promise<string | null> {
  const root = realpathSync(rootInput);
  return async (relativePath: string): Promise<string | null> => {
    try {
      const absolute = resolve(root, relativePath);
      const fileReal = realpathSync(absolute);
      if (fileReal !== root && !fileReal.startsWith(root + sep)) return null;
      if (!statSync(fileReal).isFile()) return null;
      return await readFilePromise(fileReal, 'utf8');
    } catch {
      return null;
    }
  };
}
