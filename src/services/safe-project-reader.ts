import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from 'fs';
import { isAbsolute, relative, resolve } from 'path';

export type SafeProjectPathFailureReason =
  | 'missing'
  | 'outside'
  | 'symlink'
  | 'non_regular'
  | 'unreadable';

export interface SafeProjectPathFailure {
  ok: false;
  reason: SafeProjectPathFailureReason;
  error: string;
}

export interface SafeProjectPathSuccess {
  ok: true;
  canonicalPath: string;
  canonicalRoot: string;
  stats: Stats;
}

export type SafeProjectPathResult = SafeProjectPathFailure | SafeProjectPathSuccess;

export interface SafeProjectFileSuccess extends SafeProjectPathSuccess {
  bytes: Buffer;
  sizeBytes: number;
  truncated: boolean;
}

export type SafeProjectFileResult = SafeProjectPathFailure | SafeProjectFileSuccess;

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function failure(reason: SafeProjectPathFailureReason, error: string): SafeProjectPathFailure {
  return { ok: false, reason, error };
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : undefined;
}

function unreadable(operation: string, error?: unknown): SafeProjectPathFailure {
  const code = errorCode(error);
  return failure(
    'unreadable',
    `${operation} failed inside the allowed project boundary${code ? ` (${code})` : ''}.`
  );
}

/**
 * Resolve an existing path beneath a trusted root without crossing a symbolic
 * link. The root itself may be reached through a platform alias such as
 * `/tmp -> /private/tmp`; descendants must still map one-to-one below its
 * canonical path.
 */
export function inspectSafeProjectPath(path: string, root: string): SafeProjectPathResult {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const lexicalRelative = relative(resolvedRoot, resolvedPath);
  if (lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) {
    return failure('outside', 'Path is outside the allowed project root.');
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(resolvedRoot);
  } catch (error) {
    return unreadable('Allowed project root resolution', error);
  }

  let linkStats: Stats;
  try {
    linkStats = lstatSync(resolvedPath);
  } catch (error) {
    const code = errorCode(error);
    return code === 'ENOENT'
      ? failure('missing', 'Path does not exist.')
      : unreadable('Path metadata inspection', error);
  }
  if (linkStats.isSymbolicLink()) {
    return failure('symlink', 'Symbolic links are not loaded across the project trust boundary.');
  }

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(resolvedPath);
  } catch (error) {
    return unreadable('Canonical path resolution', error);
  }

  const expectedCanonicalPath = resolve(canonicalRoot, lexicalRelative);
  if (canonicalPath !== expectedCanonicalPath) {
    return failure('symlink', 'Path traverses a symbolic link and was not loaded.');
  }
  if (!isWithin(canonicalRoot, canonicalPath)) {
    return failure('outside', 'Canonical path is outside the allowed project root.');
  }

  let stats: Stats;
  try {
    stats = statSync(canonicalPath);
  } catch (error) {
    return unreadable('Canonical path metadata inspection', error);
  }
  if (!stats.isFile() && !stats.isDirectory()) {
    return failure('non_regular', 'Path is not a regular file or directory.');
  }
  return { ok: true, canonicalPath, canonicalRoot, stats };
}

/** Open and read a bounded prefix while re-checking the opened inode. */
export function readSafeProjectFilePrefix(
  path: string,
  root: string,
  maxBytes: number
): SafeProjectFileResult {
  const inspected = inspectSafeProjectPath(path, root);
  if (!inspected.ok) return inspected;
  if (!inspected.stats.isFile()) {
    return failure('non_regular', 'Path is not a regular file.');
  }

  const limit = Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? maxBytes : 0;
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  let descriptor: number;
  try {
    descriptor = openSync(inspected.canonicalPath, constants.O_RDONLY | noFollow);
  } catch (error) {
    return errorCode(error) === 'ELOOP'
      ? failure('symlink', 'Path changed to a symbolic link while it was being opened.')
      : unreadable('File open', error);
  }

  try {
    const openedStats = fstatSync(descriptor);
    if (!openedStats.isFile()) {
      return failure('non_regular', 'Opened path is not a regular file.');
    }

    // Re-resolve after open and compare the descriptor inode with the current
    // canonical target. A replacement between validation and open fails closed.
    const currentCanonicalPath = realpathSync(inspected.canonicalPath);
    if (
      currentCanonicalPath !== inspected.canonicalPath ||
      !isWithin(inspected.canonicalRoot, currentCanonicalPath)
    ) {
      return failure('symlink', 'Path changed while it was being opened.');
    }
    // lstat the final path instead of following a replacement symlink with
    // stat. The pathname must still resolve to the descriptor's exact inode.
    const currentStats = lstatSync(inspected.canonicalPath);
    if (
      currentStats.isSymbolicLink() ||
      currentStats.dev !== openedStats.dev ||
      currentStats.ino !== openedStats.ino
    ) {
      return failure('symlink', 'Path changed while it was being opened.');
    }

    const bytesToRead = Math.min(openedStats.size, limit);
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = bytesToRead > 0 ? readSync(descriptor, buffer, 0, bytesToRead, 0) : 0;
    return {
      ...inspected,
      stats: openedStats,
      bytes: buffer.subarray(0, bytesRead),
      sizeBytes: openedStats.size,
      truncated: openedStats.size > limit,
    };
  } catch (error) {
    return unreadable('Opened file validation or read', error);
  } finally {
    closeSync(descriptor);
  }
}
