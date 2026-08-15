import { randomUUID } from 'crypto';
import {
  closeSync,
  existsSync,
  linkSync,
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
const RECOVERY_SUFFIX = '.recovery';

interface LockOwner {
  token: string;
  pid: number;
  createdAt: number;
}

interface StaleRecoveryOptions {
  /**
   * Legacy recovery sentinels could be published before their owner metadata
   * was written. New locks are atomically published, so an old unreadable
   * sentinel may be quarantined after the normal stale grace. Main locks must
   * keep failing closed because their ownership cannot be inferred safely.
   */
  quarantineUnreadable?: boolean;
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

function recoverStaleLock(
  lockPath: string,
  staleMs: number,
  options: StaleRecoveryOptions = {}
): boolean {
  let firstStat;
  try {
    firstStat = statSync(lockPath);
  } catch {
    return true;
  }
  const firstOwner = readOwner(lockPath);
  if (firstOwner) {
    const lastActivity = Math.max(firstStat.mtimeMs, firstOwner.createdAt);
    if (Date.now() - lastActivity <= staleMs || processIsAlive(firstOwner.pid)) {
      return false;
    }
  } else {
    // An unreadable main lock is never safe to reclaim automatically. The
    // recovery sentinel is different: createLock() now publishes complete
    // metadata atomically, so only legacy/crashed writers can leave this
    // state. Preserve a fresh sentinel in case an older Orion is still in its
    // open-then-write window, and quarantine it only after the stale grace.
    if (!options.quarantineUnreadable || Date.now() - firstStat.mtimeMs <= staleMs) {
      return false;
    }
  }

  let currentStat;
  try {
    currentStat = statSync(lockPath);
  } catch {
    return true;
  }
  const currentOwner = readOwner(lockPath);
  if (
    currentStat.dev !== firstStat.dev ||
    currentStat.ino !== firstStat.ino ||
    currentStat.mtimeMs !== firstStat.mtimeMs ||
    currentStat.ctimeMs !== firstStat.ctimeMs ||
    currentStat.size !== firstStat.size ||
    (firstOwner ? !currentOwner || currentOwner.token !== firstOwner.token : currentOwner !== null)
  ) {
    return false;
  }

  const stalePath = firstOwner
    ? `${lockPath}.stale-${randomUUID().slice(0, 8)}`
    : `${lockPath}.quarantine-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  // Keep malformed legacy bytes for audit/recovery. A normal stale lock has a
  // validated dead owner and can be removed after the atomic rename.
  if (firstOwner) {
    try {
      unlinkSync(stalePath);
    } catch (error) {
      debugError('file-lock.cleanupStale', error, stalePath);
    }
  }
  return true;
}

function createLock(lockPath: string): LockOwner | null {
  const owner: LockOwner = { token: randomUUID(), pid: process.pid, createdAt: Date.now() };
  const candidatePath = `${lockPath}.candidate-${owner.token}`;
  let candidateCreated = false;
  try {
    // Publish the lock only after its owner record is complete. linkSync is an
    // atomic no-replace operation: contenders see either no lock or a fully
    // initialized lock, never the zero-byte open('wx') crash window.
    const fd = openSync(candidatePath, 'wx', 0o600);
    candidateCreated = true;
    try {
      writeFileSync(fd, JSON.stringify(owner));
    } finally {
      closeSync(fd);
    }

    try {
      linkSync(candidatePath, lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw error;
    }
    return owner;
  } finally {
    if (candidateCreated) {
      try {
        unlinkSync(candidatePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          debugError('file-lock.candidateCleanup', error, candidatePath);
        }
      }
    }
  }
}

function releaseOwnedLock(lockPath: string, owner: LockOwner, scope: string): void {
  try {
    if (existsSync(lockPath) && readOwner(lockPath)?.token === owner.token) {
      unlinkSync(lockPath);
    } else {
      debugError(`${scope}Ownership`, new Error('lock ownership changed'), lockPath);
    }
  } catch (error) {
    debugError(scope, error, lockPath);
  }
}

/**
 * Acquire a lock without a recovery sentinel. This is used only for the short-
 * lived recovery sentinel itself; normal locks must use acquireLock().
 */
function acquirePrimitiveLock(
  lockPath: string,
  options: { waitMs: number; retryMs: number; staleMs: number }
): LockOwner {
  const deadline = Date.now() + options.waitMs;
  while (true) {
    const owner = createLock(lockPath);
    if (owner) return owner;

    if (recoverStaleLock(lockPath, options.staleMs, { quarantineUnreadable: true })) continue;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for file lock ${lockPath}`);
    sleepSync(options.retryMs);
  }
}

function withRecoverySentinel<T>(
  lockPath: string,
  options: { waitMs: number; retryMs: number; staleMs: number },
  operation: () => T
): T {
  // Every main-lock acquire, stale recovery, and release passes through this
  // short-lived sentinel, so a checked stale main lock cannot be replaced
  // before it is renamed. The primitive sentinel still treats a live owner as
  // authoritative and fails closed on contention.
  const sentinelPath = `${lockPath}${RECOVERY_SUFFIX}`;
  const sentinel = acquirePrimitiveLock(sentinelPath, options);
  try {
    return operation();
  } finally {
    releaseOwnedLock(sentinelPath, sentinel, 'file-lock.releaseRecovery');
  }
}

function acquireLock(
  lockPath: string,
  options: { waitMs: number; retryMs: number; staleMs: number }
): LockOwner {
  const deadline = Date.now() + options.waitMs;
  while (true) {
    const remainingMs = Math.max(0, deadline - Date.now());
    let owner: LockOwner | null = null;

    withRecoverySentinel(lockPath, { ...options, waitMs: remainingMs }, () => {
      owner = createLock(lockPath);
      if (!owner && recoverStaleLock(lockPath, options.staleMs)) {
        owner = createLock(lockPath);
      }
    });
    if (owner) return owner;
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
  const resolvedOptions = {
    waitMs: options.waitMs ?? DEFAULT_WAIT_MS,
    retryMs: options.retryMs ?? DEFAULT_RETRY_MS,
    staleMs: options.staleMs ?? DEFAULT_STALE_MS,
  };
  const owner = acquireLock(lockPath, resolvedOptions);
  try {
    return operation();
  } finally {
    try {
      withRecoverySentinel(lockPath, resolvedOptions, () => {
        releaseOwnedLock(lockPath, owner, 'file-lock.release');
      });
    } catch (error) {
      debugError('file-lock.release', error, lockPath);
    }
  }
}
