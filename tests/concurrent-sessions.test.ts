/**
 * Issue #80: concurrent-sessions 并发控制失效修复回归测试。
 *
 * 覆盖三个缺陷：
 *  - register() 现在强制 maxSessions（之前从不调用 canStartNewSession）；
 *  - generateSessionId 改用 crypto.randomUUID，跨进程/毫秒不碰撞；
 *  - getActiveSessions 在目录不可读时抛出，而非静默返回空（避免限制被悄悄禁用）。
 */
import * as fs from 'fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { SessionManager } from '../src/services/concurrent-sessions';
import { getCacheDir } from '../src/services/config-dir';
import * as debugLog from '../src/utils/debug-log';

const fsModule = require('fs');

function sessionDir(): string {
  return path.join(getCacheDir(), 'active-sessions');
}

describe('concurrent-sessions (Issue #80)', () => {
  const created: SessionManager[] = [];

  function makeManager(opts?: { maxSessions?: number }): SessionManager {
    const m = new SessionManager({ maxSessions: opts?.maxSessions ?? 10, sessionTimeout: 60_000 });
    created.push(m);
    return m;
  }

  beforeEach(() => {
    // Hermetic: start each test from a clean (empty) session directory so
    // leftover files from other runs can't skew the maxSessions count.
    fs.rmSync(sessionDir(), { recursive: true, force: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    for (const m of created) {
      try {
        m.terminate();
      } catch {
        /* best-effort cleanup */
      }
    }
    created.length = 0;
    fs.rmSync(sessionDir(), { recursive: true, force: true });
  });

  it('generates collision-resistant (uuid) session ids across instances', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      ids.add(makeManager().getSessionId());
    }
    expect(ids.size).toBe(200);
    for (const id of ids) {
      // randomUUID shape: 8-4-4-4-12 hex
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it('enforces maxSessions: a second register is rejected when the limit is 1', () => {
    const first = makeManager({ maxSessions: 1 });
    const firstSession = first.register({ model: 'test' });
    expect(firstSession.status).toBe('active');

    const second = makeManager({ maxSessions: 1 });
    expect(() => second.register({ model: 'test' })).toThrow(/concurrent session limit/);

    // The first session's file must NOT have been overwritten by the rejected one.
    const firstPath = path.join(sessionDir(), `${firstSession.id}.json`);
    expect(fs.existsSync(firstPath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(firstPath, 'utf-8'));
    expect(onDisk.id).toBe(firstSession.id);
    expect(onDisk.pid).toBe(process.pid);

    // The limit error is thrown inside the registry lock. It must still release
    // the lock so a later registration can use the slot after termination.
    first.terminate();
    const third = makeManager({ maxSessions: 1 });
    expect(() => third.register({ model: 'replacement' })).not.toThrow();
  });

  it('keeps the returned id, manager id, filename, and payload aligned after an id collision', () => {
    const manager = makeManager({ maxSessions: 10 });
    const collidingId = manager.getSessionId();
    const collidingPath = path.join(sessionDir(), `${collidingId}.json`);
    fs.writeFileSync(
      collidingPath,
      JSON.stringify({
        id: collidingId,
        pid: process.pid,
        startedAt: Date.now(),
        cwd: process.cwd(),
        lastActivity: Date.now(),
        status: 'active',
      })
    );

    const session = manager.register({ model: 'collision-retry' });
    const registeredPath = path.join(sessionDir(), `${session.id}.json`);

    expect(session.id).not.toBe(collidingId);
    expect(manager.getSessionId()).toBe(session.id);
    expect(fs.existsSync(registeredPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(registeredPath, 'utf8')).id).toBe(session.id);
  });

  it('allows up to maxSessions registrations then rejects the overflow', () => {
    const managers: SessionManager[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        const m = makeManager({ maxSessions: 3 });
        managers.push(m);
        expect(() => m.register({ model: 't' })).not.toThrow();
      }
      const overflow = makeManager({ maxSessions: 3 });
      managers.push(overflow);
      expect(() => overflow.register({ model: 't' })).toThrow(/concurrent session limit/);
    } finally {
      for (const m of managers) m.terminate();
    }
  });

  it('fails closed: getActiveSessions throws when the directory is unreadable (does NOT return [])', () => {
    const m = makeManager({ maxSessions: 10 });
    const diagnostic = jest.spyOn(debugLog, 'debugError').mockImplementation(() => undefined);
    const readableFs = fsModule as { readdirSync: (...args: unknown[]) => unknown };
    const spy = jest.spyOn(readableFs, 'readdirSync').mockImplementation(() => {
      throw new Error('EACCES simulated');
    });
    expect(() => m.getActiveSessions()).toThrow(/EACCES simulated/);
    expect(diagnostic).toHaveBeenCalledWith(
      'concurrent-sessions.listSessions',
      expect.objectContaining({ message: 'EACCES simulated' }),
      sessionDir()
    );
    spy.mockRestore();
    m.terminate();
  });

  it('keeps one session lifecycle isolated on disk', () => {
    const m = makeManager();
    const session = m.register({ model: 'model-a' });
    const filePath = path.join(sessionDir(), `${session.id}.json`);
    const originalActivity = session.lastActivity;

    m.updateActivity();
    let stored = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(stored).toMatchObject({ id: session.id, model: 'model-a', status: 'active' });
    expect(stored.lastActivity).toBeGreaterThanOrEqual(originalActivity);

    m.setIdle();
    stored = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(stored.status).toBe('idle');

    m.terminate();
    expect(fs.existsSync(filePath)).toBe(false);

    // A callback captured before clearInterval must not recreate the slot.
    m.updateActivity();
    m.setIdle();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('reaps expired/dead sessions while retaining a live isolated session', () => {
    const now = Date.now();
    const live = makeManager().register({ model: 'live' });
    const expiredPath = path.join(sessionDir(), 'expired.json');
    const deadPath = path.join(sessionDir(), 'dead.json');
    const corruptPath = path.join(sessionDir(), 'corrupt.json');
    fs.writeFileSync(
      expiredPath,
      JSON.stringify({
        ...live,
        id: 'expired',
        lastActivity: now - 120_000,
      })
    );
    fs.writeFileSync(
      deadPath,
      JSON.stringify({
        ...live,
        id: 'dead',
        pid: 987_654_321,
        lastActivity: now,
      })
    );
    fs.writeFileSync(corruptPath, '{invalid');
    jest.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === process.pid) return true;
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    }) as typeof process.kill);
    const diagnostic = jest.spyOn(debugLog, 'debugError').mockImplementation(() => undefined);

    const sessions = makeManager().getActiveSessions();

    expect(sessions.map(item => item.id)).toEqual([live.id]);
    expect(fs.existsSync(expiredPath)).toBe(false);
    expect(fs.existsSync(deadPath)).toBe(false);
    expect(diagnostic).toHaveBeenCalledWith(
      'concurrent-sessions.parseSession',
      expect.any(Error),
      corruptPath
    );
  });

  it('treats EPERM from the liveness probe as an existing process', () => {
    const manager = makeManager();
    const protectedPath = path.join(sessionDir(), 'protected.json');
    fs.writeFileSync(
      protectedPath,
      JSON.stringify({
        id: 'protected',
        pid: 424_242,
        startedAt: Date.now(),
        cwd: process.cwd(),
        lastActivity: Date.now(),
        status: 'active',
      })
    );
    jest.spyOn(process, 'kill').mockImplementation((() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    }) as typeof process.kill);

    expect(manager.getActiveSessions().map(session => session.id)).toEqual(['protected']);
    expect(fs.existsSync(protectedPath)).toBe(true);
  });

  it('fails closed while a live process owns the registry lock', () => {
    const manager = makeManager({ maxSessions: 1 });
    const lockPath = path.join(sessionDir(), '.registry.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ token: 'live-owner', pid: process.pid, createdAt: Date.now() }),
      { mode: 0o600 }
    );

    try {
      expect(() => manager.register()).toThrow(/Timed out waiting for file lock/);
      expect(fs.readdirSync(sessionDir()).filter(file => file.endsWith('.json'))).toEqual([]);
    } finally {
      fs.unlinkSync(lockPath);
    }
  }, 5_000);

  it('cleanup removes expired, dead, and corrupt records with diagnostics', () => {
    const now = Date.now();
    const manager = makeManager();
    const template = {
      pid: process.pid,
      startedAt: now,
      cwd: process.cwd(),
      lastActivity: now,
      status: 'active',
    };
    fs.writeFileSync(
      path.join(sessionDir(), 'expired.json'),
      JSON.stringify({
        ...template,
        id: 'expired',
        lastActivity: now - 120_000,
      })
    );
    fs.writeFileSync(
      path.join(sessionDir(), 'dead.json'),
      JSON.stringify({
        ...template,
        id: 'dead',
        pid: 987_654_321,
      })
    );
    const corruptPath = path.join(sessionDir(), 'corrupt.json');
    fs.writeFileSync(corruptPath, '{invalid');
    jest.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === process.pid) return true;
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    }) as typeof process.kill);
    const diagnostic = jest.spyOn(debugLog, 'debugError').mockImplementation(() => undefined);

    expect(manager.cleanup()).toBe(3);
    expect(fs.readdirSync(sessionDir()).filter(file => file.endsWith('.json'))).toEqual([]);
    expect(diagnostic).toHaveBeenCalledWith(
      'concurrent-sessions.cleanupParse',
      expect.any(Error),
      corruptPath
    );
  });
});

const REGISTER_WORKER = String.raw`
const fs = require('fs');
const role = process.env.ORION_TEST_ROLE;
const readyPath = process.env.ORION_TEST_READY;
const attemptPath = process.env.ORION_TEST_ATTEMPT;
const releasePath = process.env.ORION_TEST_RELEASE;
const finishPath = process.env.ORION_TEST_FINISH;
const resultPath = process.env.ORION_TEST_RESULT;
const originalWriteFileSync = fs.writeFileSync.bind(fs);
const sleep = ms => {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
};

if (role === 'a') {
  let paused = false;
  fs.writeFileSync = (file, data, options) => {
    if (
      !paused &&
      typeof file === 'string' &&
      file.includes('active-sessions') &&
      file.endsWith('.json') &&
      options &&
      options.flag === 'wx'
    ) {
      paused = true;
      originalWriteFileSync(readyPath, 'ready');
      while (!fs.existsSync(releasePath)) sleep(10);
    }
    return originalWriteFileSync(file, data, options);
  };
}

const { SessionManager } = require('./src/services/concurrent-sessions');
const manager = new SessionManager({
  maxSessions: 1,
  sessionTimeout: 60_000,
  heartbeatInterval: 60_000,
});
originalWriteFileSync(attemptPath, 'attempt');
let result;
try {
  const session = manager.register({ model: 'process-' + role });
  result = { ok: true, id: session.id };
} catch (error) {
  result = { ok: false, message: error instanceof Error ? error.message : String(error) };
}
originalWriteFileSync(resultPath, JSON.stringify(result));
while (!fs.existsSync(finishPath)) sleep(10);
if (result.ok) manager.terminate();
`;

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await delay(10);
  }
}

describe('concurrent-sessions cross-process reservation (Issue #121)', () => {
  it('allows exactly one of two simultaneous processes when maxSessions is 1', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-concurrent-process-'));
    const releasePath = path.join(configDir, 'release');
    const finishPath = path.join(configDir, 'finish');
    const children: ChildProcessWithoutNullStreams[] = [];
    const diagnostics = new Map<
      ChildProcessWithoutNullStreams,
      { stdout: string; stderr: string }
    >();

    const startWorker = (role: 'a' | 'b'): ChildProcessWithoutNullStreams => {
      const child = spawn(
        process.execPath,
        ['-r', require.resolve('ts-node/register/transpile-only'), '-e', REGISTER_WORKER],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ORION_CODE_CONFIG_DIR: configDir,
            ORION_TEST_ROLE: role,
            ORION_TEST_READY: path.join(configDir, `${role}-ready`),
            ORION_TEST_ATTEMPT: path.join(configDir, `${role}-attempt`),
            ORION_TEST_RELEASE: releasePath,
            ORION_TEST_FINISH: finishPath,
            ORION_TEST_RESULT: path.join(configDir, `${role}-result.json`),
          },
        }
      );
      const output = { stdout: '', stderr: '' };
      child.stdout.on('data', chunk => (output.stdout += String(chunk)));
      child.stderr.on('data', chunk => (output.stderr += String(chunk)));
      diagnostics.set(child, output);
      children.push(child);
      return child;
    };

    const waitForExit = (child: ChildProcessWithoutNullStreams): Promise<void> =>
      new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => {
          if (code === 0) {
            resolve();
            return;
          }
          const output = diagnostics.get(child);
          reject(
            new Error(
              `registration worker exited with ${code}\n${output?.stdout ?? ''}\n${output?.stderr ?? ''}`
            )
          );
        });
      });

    try {
      const first = startWorker('a');
      const firstExit = waitForExit(first);
      await waitForFile(path.join(configDir, 'a-ready'));

      const second = startWorker('b');
      const secondExit = waitForExit(second);
      await waitForFile(path.join(configDir, 'b-attempt'));

      // Worker A is paused after its capacity check. Without the registry lock,
      // worker B now observes the same free slot and registers before A resumes.
      await delay(500);
      fs.writeFileSync(releasePath, 'release');

      const firstResultPath = path.join(configDir, 'a-result.json');
      const secondResultPath = path.join(configDir, 'b-result.json');
      await Promise.all([waitForFile(firstResultPath), waitForFile(secondResultPath)]);
      const results = [firstResultPath, secondResultPath].map(
        file =>
          JSON.parse(fs.readFileSync(file, 'utf8')) as {
            ok: boolean;
            id?: string;
            message?: string;
          }
      );
      const successes = results.filter(result => result.ok);
      const failures = results.filter(result => !result.ok);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0].message).toMatch(/concurrent session limit/);

      const files = fs
        .readdirSync(path.join(configDir, 'cache', 'active-sessions'))
        .filter(file => file.endsWith('.json'));
      expect(files).toEqual([`${successes[0].id}.json`]);
      const stored = JSON.parse(
        fs.readFileSync(path.join(configDir, 'cache', 'active-sessions', files[0]), 'utf8')
      );
      expect(stored.id).toBe(successes[0].id);

      fs.writeFileSync(finishPath, 'finish');
      await Promise.all([firstExit, secondExit]);
    } finally {
      fs.writeFileSync(releasePath, 'release');
      fs.writeFileSync(finishPath, 'finish');
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }, 20_000);
});
