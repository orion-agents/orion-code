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
    const spy = jest
      .spyOn(fsModule, 'readdirSync')
      .mockImplementation((() => {
        throw new Error('EACCES simulated');
      }) as any);
    expect(() => m.getActiveSessions()).toThrow(/EACCES simulated/);
    spy.mockRestore();
    m.terminate();
  });
});
