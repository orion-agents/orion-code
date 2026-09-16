/**
 * v0.3.17 S3 — index transaction.
 *
 * Plan §7.7 is explicit: an internal queue cannot defend against external Git, and checking
 * status before and after is **not** an atomic compare-and-swap. This module implements the
 * real check-then-write window:
 *
 *   1. acquire `<index>.lock` with `O_CREAT|O_EXCL` — Git's own mutual exclusion, so a
 *      concurrent `git add` in the user's terminal fails instead of interleaving;
 *   2. copy the current index to a sibling temp file and do **all** index work against
 *      `GIT_INDEX_FILE=<temp>`, so a failure never leaves a half-written index;
 *   3. verify the result against the caller's expectations;
 *   4. publish with a single `rename()` — atomic on POSIX, same filesystem by construction;
 *   5. release only the lock this transaction created.
 *
 * What it deliberately does NOT do:
 *   - never removes a lock it did not create (a lock owned by the user's Git is reported as
 *     `git_index_busy` and left alone);
 *   - never rolls back external changes after a failure (§7.9).
 */
import { copyFileSync, existsSync, openSync, closeSync, renameSync, statSync, unlinkSync, utimesSync, writeSync, readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { dirname, join } from 'path';

import { WebWorkbenchError } from './errors';

const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** Non-secret marker proving we own a lock file, so we never unlink someone else's. */
const LOCK_MARKER_PREFIX = 'orion-code index transaction ';

export interface GitIndexPaths {
  readonly root: string;
  /** `git rev-parse --absolute-git-dir`. */
  readonly gitDir: string;
  /** `git rev-parse --git-path index`, resolved to an absolute path. */
  readonly indexPath: string;
}

export interface IndexTransactionContext {
  /** Value for `GIT_INDEX_FILE`; the mutation must target this index, not the real one. */
  readonly indexFile: string;
  readonly env: NodeJS.ProcessEnv;
  /** Index digest before the transaction, for post-hoc comparison. */
  readonly before: string;
}

/**
 * Environment for index writes.
 *
 * `GIT_CONFIG_GLOBAL` is intentionally *not* pointed at /dev/null here, unlike the read
 * path: staging must resolve the user's `core.autocrlf`, filters and `.gitattributes`
 * exactly as their own Git would, otherwise we would silently stage different bytes than
 * they expect (plan §7.8). Hooks stay disabled — `add`/`apply` must not run user hooks.
 */
export function writeGitEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    ...overrides,
  };
}

/**
 * `-c` prefix for index writes. Hooks are disabled because none of the index mutations run
 * hooks; the commit runner uses its own prefix and does not reuse this one.
 */
export function writeGitPrefix(): string[] {
  return [
    '-c',
    'core.quotepath=false',
    '-c',
    `core.hooksPath=${GIT_NULL_DEVICE}`,
    '--literal-pathspecs',
  ];
}

export function indexLockPath(indexPath: string): string {
  return `${indexPath}.lock`;
}

interface AcquiredLock {
  readonly path: string;
  readonly marker: string;
}

function acquireIndexLock(indexPath: string): AcquiredLock {
  const path = indexLockPath(indexPath);
  const marker = `${LOCK_MARKER_PREFIX}${process.pid} ${randomBytes(8).toString('hex')}\n`;
  let handle: number;
  try {
    handle = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // Someone else holds it. Report busy and leave their lock untouched.
      throw new WebWorkbenchError(
        409,
        'Git index is locked by another process.',
        'git_index_busy'
      );
    }
    throw error;
  }
  try {
    writeSync(handle, marker);
  } finally {
    closeSync(handle);
  }
  return { path, marker };
}

function releaseIndexLock(lock: AcquiredLock): void {
  try {
    // Only remove a lock whose content is still ours. If the user's Git replaced it, that is
    // their lock now and we must not delete it.
    const current = readFileSync(lock.path, 'utf8');
    if (!current.startsWith(LOCK_MARKER_PREFIX) || current !== lock.marker) return;
  } catch {
    return;
  }
  try {
    unlinkSync(lock.path);
  } catch {
    // Already gone; nothing to release.
  }
}

/**
 * Runs `work` against a private copy of the index and publishes it atomically.
 *
 * `verify` receives the temp index path so the caller can assert the mutation actually did
 * what it intended (for example that the target path is now staged) before publication.
 */
export async function withIndexTransaction<T>(
  paths: GitIndexPaths,
  seed: (context: { readonly indexFile: string; readonly env: NodeJS.ProcessEnv }) => Promise<void>,
  work: (context: IndexTransactionContext) => Promise<T>,
  verify?: (result: T, context: IndexTransactionContext) => Promise<void>
): Promise<T> {
  const lock = acquireIndexLock(paths.indexPath);
  const tempIndex = join(
    dirname(paths.indexPath),
    `orion-index-${process.pid}-${randomBytes(6).toString('hex')}.tmp`
  );
  const env = writeGitEnvironment({ GIT_INDEX_FILE: tempIndex });
  const before = existsSync(paths.indexPath)
    ? readFileSync(paths.indexPath).toString('base64').slice(0, 32)
    : 'absent';
  const context: IndexTransactionContext = { indexFile: tempIndex, env, before };

  try {
    // Seed the private index from the real one, or from an empty tree in a repository that
    // has no index yet (fresh clone-less init, or a worktree created before any add).
    if (existsSync(paths.indexPath)) {
      copyFileSync(paths.indexPath, tempIndex);
      // Copy the ORIGINAL timestamps onto the copy.
      //
      // This is not cosmetic. Git decides whether a cached stat entry may be trusted by
      // asking whether the index is at least as new as the file. A freshly copied index is
      // newer than everything, which makes git trust stale stat data — so a file edited
      // within the same timestamp granularity and with an unchanged size would not be
      // re-hashed, and `git add` would silently do nothing. Preserving the mtime keeps the
      // racy-clean defence that a real index has.
      const stats = statSync(paths.indexPath);
      utimesSync(tempIndex, stats.atime, stats.mtime);
    } else {
      await seed(context);
    }
    const result = await work(context);
    if (verify) await verify(result, context);
    // Single atomic publish; the real index is never partially written.
    renameSync(tempIndex, paths.indexPath);
    return result;
  } catch (error) {
    if (existsSync(tempIndex)) {
      try {
        unlinkSync(tempIndex);
      } catch {
        // Best effort; a leftover temp index is inert because nothing reads it.
      }
    }
    throw error;
  } finally {
    releaseIndexLock(lock);
  }
}

/**
 * Failure text Git prints when it refuses because the index changed under it. Surfaced so
 * callers can report an honest conflict instead of a generic error.
 */
export function isIndexConflictOutput(text: string): boolean {
  return /index file smaller than expected|index file corrupt|unable to read index|needs update/i.test(
    text
  );
}
