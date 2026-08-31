import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { promisify } from 'util';

import { getSessionLeasesDir } from '../product/paths';

const execFileAsync = promisify(execFile);

export type SessionLeaseErrorCode =
  | 'ORION_SESSION_BUSY'
  | 'ORION_SESSION_PROCESS_IDENTITY_UNAVAILABLE'
  | 'ORION_INVALID_SESSION_ID';

export class SessionLeaseError extends Error {
  constructor(
    readonly code: SessionLeaseErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'SessionLeaseError';
  }
}

export interface SessionLeaseOwner {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly pid: number;
  readonly processStartTime: string;
  readonly ownerToken: string;
  readonly sidecarVersion: string;
  readonly acquiredAt: string;
}

export interface SessionLease {
  readonly owner: SessionLeaseOwner;
  release(): Promise<void>;
}

export interface SessionLeaseProcessRuntime {
  readonly createOwnerToken: () => string;
  readonly processExists: (pid: number) => Promise<boolean>;
  readonly tryReadProcessStartTime: (pid: number) => Promise<string | null>;
}

interface SessionLeaseCandidateIdentity {
  readonly schemaVersion: 'v1';
  readonly pid: number;
  readonly fallbackProcessStartTime: boolean;
  readonly processStartTimeDigest: string;
  readonly ownerTokenDigest: string;
}

interface RecoveryMutex {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

const MAX_RECOVERY_ATTEMPTS = 16;

const defaultProcessRuntime: SessionLeaseProcessRuntime = {
  createOwnerToken: randomUUID,
  processExists,
  tryReadProcessStartTime,
};

export async function acquireSessionLease(
  sessionId: string,
  sidecarVersion: string,
  processRuntime: SessionLeaseProcessRuntime = defaultProcessRuntime
): Promise<SessionLease> {
  validateSessionId(sessionId);
  const leasesDirectory = getSessionLeasesDir();
  await mkdir(leasesDirectory, { recursive: true, mode: 0o700 });
  const leaseDirectory = join(leasesDirectory, `${sessionId}.lease`);
  const owner = Object.freeze({
    schemaVersion: 1 as const,
    sessionId,
    pid: process.pid,
    processStartTime: await readProcessStartTime(process.pid, processRuntime),
    ownerToken: processRuntime.createOwnerToken(),
    sidecarVersion,
    acquiredAt: new Date().toISOString(),
  });

  await cleanupAbandonedCandidates(leaseDirectory, processRuntime);
  const candidateDirectory = await createPreparedCandidate(leaseDirectory, owner);
  try {
    await claimLeaseDirectory(leaseDirectory, candidateDirectory, owner, processRuntime);
  } catch (claimError) {
    try {
      await removeOwnedLeaseDirectory(leaseDirectory, owner);
    } catch (cleanupError) {
      throw new Error(
        `Session ${owner.sessionId} claim failed (${describeError(
          claimError
        )}) and its published lease could not be rolled back (${describeError(cleanupError)}).`
      );
    }
    throw claimError;
  } finally {
    await rm(candidateDirectory, { recursive: true, force: true });
  }
  let released = false;
  return {
    owner,
    async release(): Promise<void> {
      if (released) return;
      await removeOwnedLeaseDirectory(leaseDirectory, owner);
      released = true;
    },
  };
}

async function removeOwnedLeaseDirectory(
  leaseDirectory: string,
  owner: SessionLeaseOwner
): Promise<boolean> {
  const current = await readOwner(leaseDirectory);
  if (!ownersEqual(current, owner)) return false;
  const releasedDirectory = `${leaseDirectory}.released-${randomUUID()}`;
  const isolated = await isolateDirectoryIfUnchanged(
    leaseDirectory,
    releasedDirectory,
    current,
    owner.sessionId
  );
  if (!isolated) return false;
  await rm(releasedDirectory, { recursive: true, force: true });
  return true;
}

async function claimLeaseDirectory(
  leaseDirectory: string,
  candidateDirectory: string,
  owner: SessionLeaseOwner,
  processRuntime: SessionLeaseProcessRuntime
): Promise<void> {
  const recoveryDirectory = `${leaseDirectory}.recovery`;
  const recoveryMutex = await acquireRecoveryMutex(recoveryDirectory, owner, processRuntime);
  let claimError: unknown;

  try {
    await recoveryMutex.assertOwned();
    const leaseExists = await pathExists(leaseDirectory);
    const current = leaseExists ? await readOwner(leaseDirectory) : null;
    if (current && (await ownerIsActive(current, processRuntime))) {
      throw new SessionLeaseError(
        'ORION_SESSION_BUSY',
        `Session ${owner.sessionId} is already owned by another Orion Code process.`
      );
    }

    await recoveryMutex.assertOwned();
    if (leaseExists) {
      const staleDirectory = `${leaseDirectory}.stale-${randomUUID()}`;
      const isolated = await isolateDirectoryIfUnchanged(
        leaseDirectory,
        staleDirectory,
        current,
        owner.sessionId
      );
      if (isolated) await rm(staleDirectory, { recursive: true, force: true });
    }

    await cleanupStaleDirectories(leaseDirectory);
    await recoveryMutex.assertOwned();
    if (!(await tryPublishCandidate(candidateDirectory, leaseDirectory))) {
      throw new SessionLeaseError(
        'ORION_SESSION_BUSY',
        `Session ${owner.sessionId} lease changed while recovery was in progress.`
      );
    }
  } catch (error) {
    claimError = error;
  }

  try {
    await recoveryMutex.release();
  } catch (releaseError) {
    if (claimError !== undefined) {
      throw new Error(
        `Session ${owner.sessionId} claim failed (${describeError(
          claimError
        )}) and recovery cleanup also failed (${describeError(releaseError)}).`
      );
    }
    throw releaseError;
  }

  if (claimError !== undefined) throw claimError;
}

async function acquireRecoveryMutex(
  recoveryDirectory: string,
  owner: SessionLeaseOwner,
  processRuntime: SessionLeaseProcessRuntime
): Promise<RecoveryMutex> {
  await cleanupAbandonedCandidates(recoveryDirectory, processRuntime);
  const candidateDirectory = await createPreparedCandidate(recoveryDirectory, owner);
  try {
    for (let attempt = 0; attempt < MAX_RECOVERY_ATTEMPTS; attempt++) {
      if (await tryPublishCandidate(candidateDirectory, recoveryDirectory)) {
        return createRecoveryMutexHandle(recoveryDirectory, owner);
      }

      if (!(await pathExists(recoveryDirectory))) continue;
      const existing = await readOwner(recoveryDirectory);
      if (existing && (await ownerIsActive(existing, processRuntime))) {
        throw new SessionLeaseError(
          'ORION_SESSION_BUSY',
          `Session ${owner.sessionId} lease recovery is already in progress.`
        );
      }

      const abandonedDirectory = `${recoveryDirectory}.abandoned-${randomUUID()}`;
      const isolated = await isolateDirectoryIfUnchanged(
        recoveryDirectory,
        abandonedDirectory,
        existing,
        owner.sessionId
      );
      if (!isolated) continue;
      await rm(abandonedDirectory, { recursive: true, force: true });
    }

    throw new SessionLeaseError(
      'ORION_SESSION_BUSY',
      `Session ${owner.sessionId} lease recovery changed too frequently to claim safely.`
    );
  } finally {
    await rm(candidateDirectory, { recursive: true, force: true });
  }
}

function createRecoveryMutexHandle(
  recoveryDirectory: string,
  owner: SessionLeaseOwner
): RecoveryMutex {
  let released = false;
  return {
    async assertOwned(): Promise<void> {
      if (released || !ownersEqual(await readOwner(recoveryDirectory), owner)) {
        throw new SessionLeaseError(
          'ORION_SESSION_BUSY',
          `Session ${owner.sessionId} recovery ownership changed before claim completed.`
        );
      }
    },
    async release(): Promise<void> {
      if (released) return;
      if (!ownersEqual(await readOwner(recoveryDirectory), owner)) {
        released = true;
        return;
      }

      const releasedDirectory = `${recoveryDirectory}.released-${randomUUID()}`;
      try {
        await rename(recoveryDirectory, releasedDirectory);
      } catch (error) {
        if (isMissing(error)) {
          released = true;
          return;
        }
        throw error;
      }
      await rm(releasedDirectory, { recursive: true, force: true });
      released = true;
    },
  };
}

async function createPreparedCandidate(
  targetDirectory: string,
  owner: SessionLeaseOwner
): Promise<string> {
  const identity = encodeProcessIdentity(owner);
  const candidateDirectory = `${targetDirectory}.candidate-${identity}.${randomUUID()}`;
  await mkdir(candidateDirectory, { mode: 0o700 });
  try {
    await writeOwner(candidateDirectory, owner);
    if (!ownersEqual(await readOwner(candidateDirectory), owner)) {
      throw new Error(`Failed to verify prepared lease owner for session ${owner.sessionId}.`);
    }
    return candidateDirectory;
  } catch (error) {
    await rm(candidateDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function tryPublishCandidate(
  candidateDirectory: string,
  targetDirectory: string
): Promise<boolean> {
  try {
    await rename(candidateDirectory, targetDirectory);
    return true;
  } catch (error) {
    if (isAlreadyExists(error) || (await pathExists(targetDirectory))) return false;
    throw error;
  }
}

async function isolateDirectoryIfUnchanged(
  sourceDirectory: string,
  isolatedDirectory: string,
  observedOwner: SessionLeaseOwner | null,
  sessionId: string
): Promise<boolean> {
  try {
    await rename(sourceDirectory, isolatedDirectory);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }

  const isolatedOwner = await readOwner(isolatedDirectory);
  if (ownersEqual(isolatedOwner, observedOwner)) return true;

  let restoreError: unknown;
  try {
    await rename(isolatedDirectory, sourceDirectory);
  } catch (error) {
    restoreError = error;
  }
  const detail = restoreError instanceof Error ? ` Restore failed: ${restoreError.message}` : '';
  throw new SessionLeaseError(
    'ORION_SESSION_BUSY',
    `Session ${sessionId} ownership changed while its lease directory was being isolated.${detail}`
  );
}

async function cleanupAbandonedCandidates(
  targetDirectory: string,
  processRuntime: SessionLeaseProcessRuntime
): Promise<void> {
  const parentDirectory = dirname(targetDirectory);
  const candidatePrefix = `${basename(targetDirectory)}.candidate-`;
  let entries;
  try {
    entries = await readdir(parentDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(candidatePrefix)) continue;
    const identity = decodeCandidateIdentity(entry.name.slice(candidatePrefix.length));
    if (!identity || (await candidateIdentityIsActive(identity, processRuntime))) continue;
    await rm(join(parentDirectory, entry.name), { recursive: true, force: true });
  }
}

async function cleanupStaleDirectories(leaseDirectory: string): Promise<void> {
  const parentDirectory = dirname(leaseDirectory);
  const stalePrefix = `${basename(leaseDirectory)}.stale-`;
  let entries;
  try {
    entries = await readdir(parentDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(stalePrefix)) continue;
    await rm(join(parentDirectory, entry.name), { recursive: true, force: true });
  }
}

function encodeProcessIdentity(owner: SessionLeaseOwner): string {
  const fallback = owner.processStartTime.startsWith('fallback:') ? 'f' : 's';
  return [
    'v1',
    String(owner.pid),
    fallback,
    identityDigest(owner.processStartTime),
    identityDigest(owner.ownerToken),
  ].join('.');
}

function decodeCandidateIdentity(candidateSuffix: string): SessionLeaseCandidateIdentity | null {
  const [schemaVersion, rawPid, fallback, processStartTimeDigest, ownerTokenDigest] =
    candidateSuffix.split('.');
  const pid = Number(rawPid);
  if (
    schemaVersion !== 'v1' ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    (fallback !== 'f' && fallback !== 's') ||
    !isIdentityDigest(processStartTimeDigest) ||
    !isIdentityDigest(ownerTokenDigest)
  ) {
    return null;
  }
  return {
    schemaVersion,
    pid,
    fallbackProcessStartTime: fallback === 'f',
    processStartTimeDigest,
    ownerTokenDigest,
  };
}

async function writeOwner(leaseDirectory: string, owner: SessionLeaseOwner): Promise<void> {
  const temporaryPath = join(leaseDirectory, `owner-${randomUUID()}.tmp`);
  const ownerPath = join(leaseDirectory, 'owner.json');
  const temporaryFile = await open(temporaryPath, 'wx', 0o600);
  try {
    await temporaryFile.writeFile(`${JSON.stringify(owner, null, 2)}\n`, 'utf8');
    await temporaryFile.sync();
  } finally {
    await temporaryFile.close();
  }
  await rename(temporaryPath, ownerPath);
}

async function readOwner(leaseDirectory: string): Promise<SessionLeaseOwner | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(leaseDirectory, 'owner.json'), 'utf8')
    ) as Partial<SessionLeaseOwner>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.sessionId !== 'string' ||
      parsed.sessionId.length === 0 ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid ?? 0) <= 0 ||
      typeof parsed.processStartTime !== 'string' ||
      parsed.processStartTime.length === 0 ||
      typeof parsed.ownerToken !== 'string' ||
      parsed.ownerToken.length === 0 ||
      typeof parsed.sidecarVersion !== 'string' ||
      parsed.sidecarVersion.length === 0 ||
      typeof parsed.acquiredAt !== 'string'
    ) {
      return null;
    }
    return parsed as SessionLeaseOwner;
  } catch {
    return null;
  }
}

async function ownerIsActive(
  owner: SessionLeaseOwner,
  processRuntime: SessionLeaseProcessRuntime
): Promise<boolean> {
  return processIdentityIsActive(owner, processRuntime);
}

async function processIdentityIsActive(
  owner: Pick<SessionLeaseOwner, 'pid' | 'processStartTime'>,
  processRuntime: SessionLeaseProcessRuntime
): Promise<boolean> {
  if (!(await processRuntime.processExists(owner.pid))) return false;
  if (owner.processStartTime.startsWith('fallback:')) return true;
  const observedStartTime = await processRuntime.tryReadProcessStartTime(owner.pid);
  if (observedStartTime === null) return true;
  return observedStartTime === owner.processStartTime;
}

async function candidateIdentityIsActive(
  identity: SessionLeaseCandidateIdentity,
  processRuntime: SessionLeaseProcessRuntime
): Promise<boolean> {
  if (!(await processRuntime.processExists(identity.pid))) return false;
  if (identity.fallbackProcessStartTime) return true;
  const observedStartTime = await processRuntime.tryReadProcessStartTime(identity.pid);
  if (observedStartTime === null) return true;
  return identityDigest(observedStartTime) === identity.processStartTimeDigest;
}

function identityDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url').slice(0, 22);
}

function isIdentityDigest(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/u.test(value);
}

function ownersEqual(left: SessionLeaseOwner | null, right: SessionLeaseOwner | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.schemaVersion === right.schemaVersion &&
    left.sessionId === right.sessionId &&
    left.pid === right.pid &&
    left.processStartTime === right.processStartTime &&
    left.ownerToken === right.ownerToken &&
    left.sidecarVersion === right.sidecarVersion &&
    left.acquiredAt === right.acquiredAt
  );
}

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readProcessStartTime(
  pid: number,
  processRuntime: SessionLeaseProcessRuntime
): Promise<string> {
  const startTime = await processRuntime.tryReadProcessStartTime(pid);
  if (startTime !== null) return startTime;
  if (pid === process.pid) {
    return `fallback:${Math.round(Date.now() - process.uptime() * 1000)}`;
  }
  throw new SessionLeaseError(
    'ORION_SESSION_PROCESS_IDENTITY_UNAVAILABLE',
    `Unable to establish process-start identity for PID ${pid}.`
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function tryReadProcessStartTime(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
      const endOfName = contents.lastIndexOf(')');
      const fields = contents
        .slice(endOfName + 2)
        .trim()
        .split(/\s+/u);
      const startTicks = fields[19];
      return startTicks ? `linux:${startTicks}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const result = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
      });
      const value = result.stdout.trim();
      return value ? `darwin:${value}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32') {
    try {
      const result = await execFileAsync(
        'wmic',
        ['process', 'where', `processid=${pid}`, 'get', 'creationdate', '/value'],
        { encoding: 'utf8' }
      );
      const match = result.stdout.match(/CreationDate=([^\r\n]+)/u);
      return match?.[1] ? `win32:${match[1].trim()}` : null;
    } catch {
      return null;
    }
  }
  try {
    const processStat = await stat(`/proc/${pid}`);
    return `stat:${processStat.birthtimeMs}:${processStat.ino}`;
  } catch {
    return null;
  }
}

function validateSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9._-]+$/u.test(sessionId)) {
    throw new SessionLeaseError('ORION_INVALID_SESSION_ID', 'Session ID is not safe for storage.');
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
