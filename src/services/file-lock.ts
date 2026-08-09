import { randomUUID } from 'crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { debugError } from '../utils/debug-log';

const DEFAULT_WAIT_MS = 2_000;
const DEFAULT_RETRY_MS = 10;
const DEFAULT_STALE_MS = 30_000;

interface LockOwner {
  token: string;
  pid: number;
  createdAt: number;
}

function sleepSync(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockOwner>;
    if (
      typeof value.token !== 'string' ||
      !Number.isSafeInteger(value.pid) ||
      typeof value.createdAt !== 'number'
    ) {
      return null;
    }
    return value as LockOwner;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function recoverStaleLock(lockPath: string, staleMs: number): boolean {
  let firstStat;
  try {
    firstStat = statSync(lockPath);
  } catch {
    return true;
  }
  const firstOwner = readOwner(lockPath);
  const lastActivity = Math.max(firstStat.mtimeMs, firstOwner?.createdAt ?? 0);
  if (Date.now() - lastActivity <= staleMs || (firstOwner && processIsAlive(firstOwner.pid))) {
    return false;
  }

  let currentStat;
  try {
    currentStat = statSync(lockPath);
  } catch {
    return true;
  }
  const currentOwner = readOwner(lockPath);
  if (
    currentStat.ino !== firstStat.ino ||
    currentStat.mtimeMs !== firstStat.mtimeMs ||
    currentOwner?.token !== firstOwner?.token
  ) {
    return false;
  }

  const stalePath = `${lockPath}.stale-${randomUUID().slice(0, 8)}`;
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  try {
    unlinkSync(stalePath);
  } catch (error) {
    debugError('file-lock.cleanupStale', error, stalePath);
  }
  return true;
}

function acquireLock(
  lockPath: string,
  options: { waitMs: number; retryMs: number; staleMs: number }
): LockOwner {
  const deadline = Date.now() + options.waitMs;
  while (true) {
    const owner: LockOwner = { token: randomUUID(), pid: process.pid, createdAt: Date.now() };
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(owner));
      } catch (error) {
        try {
          unlinkSync(lockPath);
        } catch (cleanupError) {
          debugError('file-lock.initializeCleanup', cleanupError, lockPath);
        }
        throw error;
      } finally {
        closeSync(fd);
      }
      return owner;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    if (recoverStaleLock(lockPath, options.staleMs)) continue;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for file lock ${lockPath}`);
    sleepSync(options.retryMs);
  }
}

/** Serialize a synchronous read-modify-write operation across Orion processes. */
export function withFileLockSync<T>(
  targetPath: string,
  operation: () => T,
  options: { waitMs?: number; retryMs?: number; staleMs?: number } = {}
): T {
  const lockPath = `${targetPath}.lock`;
  const owner = acquireLock(lockPath, {
    waitMs: options.waitMs ?? DEFAULT_WAIT_MS,
    retryMs: options.retryMs ?? DEFAULT_RETRY_MS,
    staleMs: options.staleMs ?? DEFAULT_STALE_MS,
  });
  try {
    return operation();
  } finally {
    try {
      if (existsSync(lockPath) && readOwner(lockPath)?.token === owner.token) {
        unlinkSync(lockPath);
      } else {
        debugError('file-lock.releaseOwnership', new Error('lock ownership changed'), lockPath);
      }
    } catch (error) {
      debugError('file-lock.release', error, lockPath);
    }
  }
}
