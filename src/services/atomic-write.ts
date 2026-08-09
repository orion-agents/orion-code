/**
 * orion code - Atomic File Write
 *
 * Writes to a temp file then renames to the target path. POSIX rename is
 * atomic, so readers either see the old content or the full new content,
 * never a half-written file.
 */

import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { randomBytes } from 'crypto';
import { dirname, basename, join } from 'path';

export interface AtomicWriteOptions {
  mode?: number;
  /**
   * fsync the temp file before renaming. Protects against power loss, not just
   * a torn write. Defaults to false because it costs a disk round-trip; enable
   * it for data whose loss is unrecoverable (credentials, tokens).
   */
  fsync?: boolean;
}

const ATOMIC_TEMP_PATTERN = /^\..+\.(?:\d+\.\d+|[a-f0-9]{24})\.tmp$/;
const SIDECAR_TEMP_PATTERN = /\.tmp-(?:delete-)?[a-z0-9]+$/;

/** Remove abandoned atomic-write sidecars while leaving recent in-flight writes alone. */
export function cleanupStaleAtomicWriteFiles(
  directory: string,
  olderThanMs: number = 60 * 60 * 1000,
  now: number = Date.now()
): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!ATOMIC_TEMP_PATTERN.test(entry) && !SIDECAR_TEMP_PATTERN.test(entry)) continue;
    const candidate = join(directory, entry);
    try {
      const stat = statSync(candidate);
      if (!stat.isFile() || now - stat.mtimeMs < olderThanMs) continue;
      unlinkSync(candidate);
      removed++;
    } catch {
      // Startup cleanup is best-effort and must not block normal storage access.
    }
  }
  return removed;
}

export function atomicWriteFileSync(
  path: string,
  content: string | Buffer,
  opts: AtomicWriteOptions = {}
): void {
  // Issue #85: the temp name must be unpredictable. A predictable name
  // (basename + pid + timestamp) lets a local attacker pre-create a symlink at
  // that exact path and divert the rename (symlink TOCTOU). A random suffix
  // makes pre-planting infeasible. The temp stays in the target's directory so
  // `rename` remains atomic on a single filesystem.
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(12).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, content, opts.mode !== undefined ? { mode: opts.mode } : undefined);
    if (opts.mode !== undefined) {
      // `writeFileSync`'s `mode` is masked by the process umask, and is ignored
      // outright when the file already exists. An explicit chmod makes the
      // permission guarantee unconditional before the file becomes visible.
      chmodSync(tmp, opts.mode);
    }
    if (opts.fsync) {
      const fd = openSync(tmp, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* noop */
    }
    throw err;
  }
}
