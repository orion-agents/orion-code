import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SessionGoalV1 } from '../src/runtime/goals/types';

type FsCall = () => unknown;

let mockReadFileSyncHook: ((callActual: FsCall, path: unknown) => unknown) | undefined;
let mockMkdirSyncHook: ((callActual: FsCall, path: unknown) => unknown) | undefined;
let mockUnlinkSyncHook: ((callActual: FsCall, path: unknown) => unknown) | undefined;

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => {
      const callActual = () => Reflect.apply(actual.readFileSync, actual, args);
      return mockReadFileSyncHook ? mockReadFileSyncHook(callActual, args[0]) : callActual();
    },
    mkdirSync: (...args: unknown[]) => {
      const callActual = () => Reflect.apply(actual.mkdirSync, actual, args);
      return mockMkdirSyncHook ? mockMkdirSyncHook(callActual, args[0]) : callActual();
    },
    unlinkSync: (...args: unknown[]) => {
      const callActual = () => Reflect.apply(actual.unlinkSync, actual, args);
      return mockUnlinkSyncHook ? mockUnlinkSyncHook(callActual, args[0]) : callActual();
    },
  };
});

const actualFs = jest.requireActual<typeof import('fs')>('fs');
const testRoot = mkdtempSync(join(tmpdir(), 'orion-goal-quarantine-race-'));
const sessionsDir = join(testRoot, 'sessions');

jest.mock('../src/services/config-dir', () => ({
  ...jest.requireActual('../src/services/config-dir'),
  getProjectSessionsDir: () => sessionsDir,
}));

import { createGoal, loadGoal, saveGoal } from '../src/services/goal-storage';

const projectPath = '/test/goal-quarantine-race';

function sidecarPath(sessionId: string): string {
  return join(sessionsDir, `${sessionId}.goal.json`);
}

function makeGoal(sessionId: string, revision: number = 0): SessionGoalV1 {
  return {
    version: 1,
    goalId: `goal-${sessionId}`,
    sessionId,
    revision,
    objective: 'Preserve the authoritative replacement',
    status: 'active',
    tokensUsed: 0,
    timeUsedMs: 0,
    createdAt: 1_000,
    updatedAt: 1_000 + revision,
    continuationCount: 0,
    noProgressCount: 0,
  };
}

function corruptQuarantines(sessionId: string): string[] {
  return actualFs
    .readdirSync(sessionsDir)
    .filter(file => file.startsWith(`${sessionId}.goal.json.corrupt-`));
}

describe('Goal sidecar quarantine race safety', () => {
  beforeEach(() => {
    mockReadFileSyncHook = undefined;
    mockMkdirSyncHook = undefined;
    mockUnlinkSyncHook = undefined;
    actualFs.rmSync(sessionsDir, { recursive: true, force: true });
    actualFs.mkdirSync(sessionsDir, { recursive: true });
  });

  afterAll(() => {
    mockReadFileSyncHook = undefined;
    mockMkdirSyncHook = undefined;
    mockUnlinkSyncHook = undefined;
    actualFs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('does not turn post-commit fence cleanup failure into a failed create', () => {
    const sessionId = 'post-commit-fence-cleanup';
    const fencePath = `${sidecarPath(sessionId)}.deleted`;
    actualFs.writeFileSync(
      fencePath,
      JSON.stringify({
        version: 1,
        kind: 'goal_deletion_fence',
        sessionId,
        goalId: 'goal-deleted',
        revision: 3,
      })
    );
    mockUnlinkSyncHook = (callActual, path) => {
      if (path === fencePath) {
        const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        throw error;
      }
      return callActual();
    };

    const created = createGoal(projectPath, sessionId, 'Replacement survives cleanup failure');

    expect(created.ok).toBe(true);
    expect(loadGoal(projectPath, sessionId)).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ objective: 'Replacement survives cleanup failure' }),
      })
    );
    expect(actualFs.existsSync(fencePath)).toBe(true);
  });

  it.each([
    {
      label: 'unsupported schema',
      sessionId: 'repair-unsupported-schema',
      payload: { ...makeGoal('repair-unsupported-schema'), version: 2 },
      error: 'incompatible_schema',
    },
    {
      label: 'metadata mismatch',
      sessionId: 'repair-metadata-mismatch',
      payload: makeGoal('different-session'),
      error: 'metadata_mismatch',
    },
  ])('does not repair $label with expected revision zero', ({ sessionId, payload, error }) => {
    actualFs.writeFileSync(sidecarPath(sessionId), JSON.stringify(payload));

    const result = saveGoal(projectPath, sessionId, makeGoal(sessionId, 1), 0);

    expect(result).toEqual(expect.objectContaining({ ok: false, error }));
    expect(actualFs.existsSync(sidecarPath(sessionId))).toBe(false);
  });

  it('does not overwrite an unreadable sidecar with expected revision zero', () => {
    const sessionId = 'repair-io-error';
    actualFs.writeFileSync(sidecarPath(sessionId), JSON.stringify(makeGoal(sessionId)));
    mockReadFileSyncHook = (callActual, path) => {
      if (path === sidecarPath(sessionId)) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return callActual();
    };

    const result = saveGoal(projectPath, sessionId, makeGoal(sessionId, 1), 0);

    expect(result).toEqual(expect.objectContaining({ ok: false, error: 'io_error' }));
    expect(actualFs.existsSync(sidecarPath(sessionId))).toBe(true);
  });

  it('retries and returns a valid sidecar installed after the corrupt read', () => {
    const sessionId = 'changed-to-valid';
    const path = sidecarPath(sessionId);
    const lockPath = `${path}.lock`;
    const replacement = makeGoal(sessionId, 4);
    actualFs.writeFileSync(path, '{broken-json');

    let sidecarReads = 0;
    let quarantineReadSawLock = false;
    mockReadFileSyncHook = (callActual, readPath) => {
      if (String(readPath) !== path) return callActual();
      sidecarReads += 1;
      if (sidecarReads === 1) {
        const observed = callActual();
        actualFs.writeFileSync(path, JSON.stringify(replacement));
        return observed;
      }
      if (sidecarReads === 2) quarantineReadSawLock = actualFs.existsSync(lockPath);
      return callActual();
    };

    const result = loadGoal(projectPath, sessionId);

    expect(result).toEqual({ ok: true, value: replacement });
    expect(sidecarReads).toBe(3);
    expect(quarantineReadSawLock).toBe(true);
    expect(JSON.parse(actualFs.readFileSync(path, 'utf8'))).toEqual(replacement);
    expect(corruptQuarantines(sessionId)).toEqual([]);
    expect(actualFs.existsSync(lockPath)).toBe(false);
  });

  it('returns not_found when the observed corrupt sidecar disappears before quarantine', () => {
    const sessionId = 'missing-before-quarantine';
    const path = sidecarPath(sessionId);
    const lockPath = `${path}.lock`;
    actualFs.writeFileSync(path, '{broken-json');

    let sidecarReads = 0;
    let quarantineReadSawLock = false;
    mockReadFileSyncHook = (callActual, readPath) => {
      if (String(readPath) !== path) return callActual();
      sidecarReads += 1;
      if (sidecarReads === 1) {
        const observed = callActual();
        actualFs.unlinkSync(path);
        return observed;
      }
      quarantineReadSawLock = actualFs.existsSync(lockPath);
      return callActual();
    };

    const result = loadGoal(projectPath, sessionId);

    expect(result).toEqual(expect.objectContaining({ ok: false, error: 'not_found' }));
    expect(sidecarReads).toBe(2);
    expect(quarantineReadSawLock).toBe(true);
    expect(corruptQuarantines(sessionId)).toEqual([]);
    expect(actualFs.existsSync(lockPath)).toBe(false);
  });

  it('fails closed and preserves corrupt bytes when the quarantine lock cannot be acquired', () => {
    const sessionId = 'lock-acquisition-failure';
    const path = sidecarPath(sessionId);
    const lockPath = `${path}.lock`;
    const corruptRaw = '{broken-json';
    actualFs.writeFileSync(path, corruptRaw);
    mockMkdirSyncHook = (callActual, mkdirPath) => {
      if (String(mkdirPath) !== lockPath) return callActual();
      throw Object.assign(new Error('lock denied'), { code: 'EACCES' });
    };

    const result = loadGoal(projectPath, sessionId);

    expect(result).toEqual(expect.objectContaining({ ok: false, error: 'io_error' }));
    if (result.ok) throw new Error('expected lock acquisition to fail');
    expect(result.message).toContain('Failed to acquire Goal sidecar lock');
    expect(actualFs.readFileSync(path, 'utf8')).toBe(corruptRaw);
    expect(corruptQuarantines(sessionId)).toEqual([]);
    expect(actualFs.existsSync(lockPath)).toBe(false);
  });

  it('quarantines safely without reacquiring a lock during a locked CAS write', () => {
    const sessionId = 'locked-cas-corrupt';
    const path = sidecarPath(sessionId);
    const replacement = makeGoal(sessionId, 0);
    actualFs.writeFileSync(path, '{broken-json');
    let lockAcquisitions = 0;
    mockMkdirSyncHook = (callActual, mkdirPath) => {
      if (String(mkdirPath) === `${path}.lock`) lockAcquisitions += 1;
      return callActual();
    };

    const result = saveGoal(projectPath, sessionId, replacement, 0);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(lockAcquisitions).toBe(1);
    expect(JSON.parse(actualFs.readFileSync(path, 'utf8'))).toEqual(replacement);
    expect(corruptQuarantines(sessionId)).toHaveLength(1);
    expect(actualFs.existsSync(`${path}.lock`)).toBe(false);
  });
});
