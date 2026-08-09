/**
 * Issue #80: concurrent-sessions 并发控制失效修复回归测试。
 *
 * 覆盖三个缺陷：
 *  - register() 现在强制 maxSessions（之前从不调用 canStartNewSession）；
 *  - generateSessionId 改用 crypto.randomUUID，跨进程/毫秒不碰撞；
 *  - getActiveSessions 在目录不可读时抛出，而非静默返回空（避免限制被悄悄禁用）。
 */
import * as fs from 'fs';
import * as path from 'path';
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
    const spy = jest
      .spyOn(fsModule, 'readdirSync')
      .mockImplementation((() => {
        throw new Error('EACCES simulated');
      }) as any);
    expect(() => m.getActiveSessions()).toThrow(/EACCES simulated/);
    expect(diagnostic).toHaveBeenCalledWith(
      'concurrent-sessions.listSessions',
      expect.objectContaining({ message: 'EACCES simulated' }),
      sessionDir(),
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
  });

  it('reaps expired/dead sessions while retaining a live isolated session', () => {
    const now = Date.now();
    const live = makeManager().register({ model: 'live' });
    const expiredPath = path.join(sessionDir(), 'expired.json');
    const deadPath = path.join(sessionDir(), 'dead.json');
    const corruptPath = path.join(sessionDir(), 'corrupt.json');
    fs.writeFileSync(expiredPath, JSON.stringify({
      ...live,
      id: 'expired',
      lastActivity: now - 120_000,
    }));
    fs.writeFileSync(deadPath, JSON.stringify({
      ...live,
      id: 'dead',
      pid: 987_654_321,
      lastActivity: now,
    }));
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
      corruptPath,
    );
  });

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
    fs.writeFileSync(path.join(sessionDir(), 'expired.json'), JSON.stringify({
      ...template,
      id: 'expired',
      lastActivity: now - 120_000,
    }));
    fs.writeFileSync(path.join(sessionDir(), 'dead.json'), JSON.stringify({
      ...template,
      id: 'dead',
      pid: 987_654_321,
    }));
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
      corruptPath,
    );
  });
});
