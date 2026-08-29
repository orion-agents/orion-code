import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  acquireSessionLease,
  type SessionLeaseOwner,
  type SessionLeaseProcessRuntime,
} from '../src/acp/session-lease';
import { getSessionLeasesDir } from '../src/product/paths';

const TEST_PROCESS_START_TIME = 'test:shared-process-start';
const DEAD_PROCESS_ID = 2_147_483_647;

describe('ACP session leases', () => {
  const roots: string[] = [];
  const originalDataDirectory = process.env.ORION_CODE_DATA_DIR;

  afterEach(() => {
    if (originalDataDirectory === undefined) delete process.env.ORION_CODE_DATA_DIR;
    else process.env.ORION_CODE_DATA_DIR = originalDataDirectory;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function useTemporaryDataDirectory(): string {
    const root = mkdtempSync(join(tmpdir(), 'orion-acp-lease-'));
    roots.push(root);
    process.env.ORION_CODE_DATA_DIR = root;
    return root;
  }

  test('rejects a second live owner and allows reacquire after release', async () => {
    useTemporaryDataDirectory();
    const first = await acquireSessionLease('session-1', '0.3.1');
    expect(readOwner(join(getSessionLeasesDir(), 'session-1.lease'))).toEqual(first.owner);
    await expect(acquireSessionLease('session-1', '0.3.1')).rejects.toMatchObject({
      code: 'ORION_SESSION_BUSY',
    });
    await first.release();

    const second = await acquireSessionLease('session-1', '0.3.1');
    await second.release();
    expect(existsSync(join(getSessionLeasesDir(), 'session-1.lease'))).toBe(false);
  });

  test('recovers a lease only after its recorded process is not alive', async () => {
    useTemporaryDataDirectory();
    const leaseDirectory = join(getSessionLeasesDir(), 'session-stale.lease');
    writeOwnerDirectory(
      leaseDirectory,
      createOwner('session-stale', DEAD_PROCESS_ID, 'missing', 'stale-owner')
    );

    const recovered = await acquireSessionLease('session-stale', '0.3.1');
    expect(recovered.owner.ownerToken).not.toBe('stale-owner');
    await recovered.release();
  });

  test('allows only one contender to take over the same stale lease', async () => {
    useTemporaryDataDirectory();
    const leaseDirectory = join(getSessionLeasesDir(), 'session-race.lease');
    writeOwnerDirectory(
      leaseDirectory,
      createOwner('session-race', DEAD_PROCESS_ID, 'dead-process-start', 'stale-owner')
    );

    const results = await Promise.allSettled([
      acquireSessionLease('session-race', '0.3.1', createProcessRuntime('contender-a')),
      acquireSessionLease('session-race', '0.3.1', createProcessRuntime('contender-b')),
    ]);

    const acquired = results.flatMap(result =>
      result.status === 'fulfilled' ? [result.value] : []
    );
    const failures = results.flatMap(result =>
      result.status === 'rejected' ? [result.reason] : []
    );
    expect(acquired).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: 'ORION_SESSION_BUSY' });
    await acquired[0].release();
    expect(existsSync(`${leaseDirectory}.recovery`)).toBe(false);
  });

  test('recovers an ownerless canonical lease by isolating it before publishing', async () => {
    useTemporaryDataDirectory();
    const leaseDirectory = join(getSessionLeasesDir(), 'session-ownerless.lease');
    mkdirSync(leaseDirectory, { recursive: true, mode: 0o700 });

    const recovered = await acquireSessionLease(
      'session-ownerless',
      '0.3.1',
      createProcessRuntime('ownerless-recovery')
    );

    expect(readOwner(leaseDirectory)).toEqual(recovered.owner);
    expect(leaseArtifacts(leaseDirectory, '.stale-')).toEqual([]);
    await recovered.release();
  });

  test('cleans a candidate left before owner write only after its process identity is dead', async () => {
    useTemporaryDataDirectory();
    const leaseDirectory = join(getSessionLeasesDir(), 'session-candidate-crash.lease');
    mkdirSync(getSessionLeasesDir(), { recursive: true, mode: 0o700 });
    const abandonedCandidate = candidateDirectory(
      leaseDirectory,
      DEAD_PROCESS_ID,
      'dead-process-start',
      'crashed-candidate'
    );
    mkdirSync(abandonedCandidate, { mode: 0o700 });

    const acquired = await acquireSessionLease(
      'session-candidate-crash',
      '0.3.1',
      createProcessRuntime('candidate-recovery')
    );

    expect(existsSync(abandonedCandidate)).toBe(false);
    expect(readOwner(leaseDirectory)).toEqual(acquired.owner);
    await acquired.release();
  });

  test('does not remove an unpublished candidate while its process identity is active', async () => {
    useTemporaryDataDirectory();
    const leaseDirectory = join(getSessionLeasesDir(), 'session-live-candidate.lease');
    mkdirSync(getSessionLeasesDir(), { recursive: true, mode: 0o700 });
    const liveCandidate = candidateDirectory(
      leaseDirectory,
      process.pid,
      TEST_PROCESS_START_TIME,
      'live-candidate'
    );
    mkdirSync(liveCandidate, { mode: 0o700 });

    const acquired = await acquireSessionLease(
      'session-live-candidate',
      '0.3.1',
      createProcessRuntime('other-contender')
    );

    expect(existsSync(liveCandidate)).toBe(true);
    await acquired.release();
  });

  test('reclaims a recovery mutex left by a crashed owner', async () => {
    useTemporaryDataDirectory();
    const leaseDirectory = join(getSessionLeasesDir(), 'session-recovery-crash.lease');
    const recoveryDirectory = `${leaseDirectory}.recovery`;
    writeOwnerDirectory(
      recoveryDirectory,
      createOwner(
        'session-recovery-crash',
        DEAD_PROCESS_ID,
        'dead-process-start',
        'crashed-recovery'
      )
    );

    const acquired = await acquireSessionLease(
      'session-recovery-crash',
      '0.3.1',
      createProcessRuntime('recovery-successor')
    );

    expect(readOwner(leaseDirectory)).toEqual(acquired.owner);
    expect(existsSync(recoveryDirectory)).toBe(false);
    await acquired.release();
  });

  test('recovers after a crashed recoverer renamed the stale lease', async () => {
    useTemporaryDataDirectory();
    const leaseDirectory = join(getSessionLeasesDir(), 'session-stale-rename.lease');
    const recoveryDirectory = `${leaseDirectory}.recovery`;
    const staleDirectory = `${leaseDirectory}.stale-crashed-recoverer`;
    writeOwnerDirectory(
      recoveryDirectory,
      createOwner(
        'session-stale-rename',
        DEAD_PROCESS_ID,
        'dead-recoverer-start',
        'crashed-recoverer'
      )
    );
    writeOwnerDirectory(
      staleDirectory,
      createOwner('session-stale-rename', DEAD_PROCESS_ID, 'dead-original-start', 'stale-original')
    );

    const acquired = await acquireSessionLease(
      'session-stale-rename',
      '0.3.1',
      createProcessRuntime('stale-rename-successor')
    );

    expect(readOwner(leaseDirectory)).toEqual(acquired.owner);
    expect(existsSync(recoveryDirectory)).toBe(false);
    expect(existsSync(staleDirectory)).toBe(false);
    await acquired.release();
  });

  test('does not reclaim an active recovery mutex based on its age', async () => {
    useTemporaryDataDirectory();
    const leaseDirectory = join(getSessionLeasesDir(), 'session-live-recovery.lease');
    const recoveryDirectory = `${leaseDirectory}.recovery`;
    writeOwnerDirectory(
      recoveryDirectory,
      createOwner(
        'session-live-recovery',
        process.pid,
        TEST_PROCESS_START_TIME,
        'live-recovery',
        '2000-01-01T00:00:00.000Z'
      )
    );

    await expect(
      acquireSessionLease(
        'session-live-recovery',
        '0.3.1',
        createProcessRuntime('blocked-contender')
      )
    ).rejects.toMatchObject({ code: 'ORION_SESSION_BUSY' });

    expect(readOwner(recoveryDirectory)?.ownerToken).toBe('live-recovery');
    expect(existsSync(leaseDirectory)).toBe(false);
  });

  test('treats a fallback identity as live while its pid still exists', async () => {
    useTemporaryDataDirectory();
    const fallbackRuntime: SessionLeaseProcessRuntime = {
      createOwnerToken: () => 'fallback-owner',
      processExists: async () => true,
      tryReadProcessStartTime: async () => null,
    };
    const first = await acquireSessionLease('session-fallback', '0.3.1', fallbackRuntime);
    expect(first.owner.processStartTime).toMatch(/^fallback:/u);

    const strongIdentityRuntime: SessionLeaseProcessRuntime = {
      createOwnerToken: () => 'strong-owner',
      processExists: async () => true,
      tryReadProcessStartTime: async () => 'test:live-owner',
    };
    await expect(
      acquireSessionLease('session-fallback', '0.3.1', strongIdentityRuntime)
    ).rejects.toMatchObject({ code: 'ORION_SESSION_BUSY' });

    await first.release();
  });

  test('rejects path-like session identifiers', async () => {
    useTemporaryDataDirectory();
    await expect(acquireSessionLease('../escape', '0.3.1')).rejects.toMatchObject({
      code: 'ORION_INVALID_SESSION_ID',
    });
  });
});

function createProcessRuntime(ownerToken: string): SessionLeaseProcessRuntime {
  return {
    createOwnerToken: () => ownerToken,
    processExists: async pid => pid !== DEAD_PROCESS_ID,
    tryReadProcessStartTime: async pid => (pid === process.pid ? TEST_PROCESS_START_TIME : null),
  };
}

function createOwner(
  sessionId: string,
  pid: number,
  processStartTime: string,
  ownerToken: string,
  acquiredAt = '2026-01-01T00:00:00.000Z'
): SessionLeaseOwner {
  return {
    schemaVersion: 1,
    sessionId,
    pid,
    processStartTime,
    ownerToken,
    sidecarVersion: '0.3.0',
    acquiredAt,
  };
}

function writeOwnerDirectory(directory: string, owner: SessionLeaseOwner): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, {
    mode: 0o600,
  });
}

function readOwner(directory: string): SessionLeaseOwner | null {
  if (!existsSync(join(directory, 'owner.json'))) return null;
  return JSON.parse(readFileSync(join(directory, 'owner.json'), 'utf8')) as SessionLeaseOwner;
}

function candidateDirectory(
  leaseDirectory: string,
  pid: number,
  processStartTime: string,
  ownerToken: string
): string {
  const fallback = processStartTime.startsWith('fallback:') ? 'f' : 's';
  const encodedIdentity = [
    'v1',
    String(pid),
    fallback,
    identityDigest(processStartTime),
    identityDigest(ownerToken),
  ].join('.');
  return `${leaseDirectory}.candidate-${encodedIdentity}.crashed`;
}

function identityDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url').slice(0, 22);
}

function leaseArtifacts(leaseDirectory: string, suffixPrefix: string): string[] {
  const leasesDirectory = getSessionLeasesDir();
  const leaseName = leaseDirectory.slice(leasesDirectory.length + 1);
  if (!existsSync(leasesDirectory)) return [];
  return readdirSync(leasesDirectory).filter(entry =>
    entry.startsWith(`${leaseName}${suffixPrefix}`)
  );
}
