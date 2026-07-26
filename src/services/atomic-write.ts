/**
 * orion code - Atomic File Write
 *
 * Writes to a temp file then renames to the target path. POSIX rename is
 * atomic, so readers either see the old content or the full new content,
 * never a half-written file.
 */

import { writeFileSync, renameSync, unlinkSync } from 'fs';
import { dirname, basename, join } from 'path';

export interface AtomicWriteOptions {
  mode?: number;
}

export function atomicWriteFileSync(path: string, content: string, opts: AtomicWriteOptions = {}): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, content, opts.mode !== undefined ? { mode: opts.mode } : undefined);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* noop */ }
    throw err;
  }
}
