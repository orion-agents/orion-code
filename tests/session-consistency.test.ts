/**
 * v0.2.24 — Session storage atomicity & consistency tests
 * (10-test-prompts Prompt 1: Session 并发安全)
 *
 * Tests: atomic-write, messageCount audit, meta↔messages consistency,
 * truncate boundary, append-then-read ordering.
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Setup: isolated config dir per suite so tests don't collide with prod data
// ---------------------------------------------------------------------------
const testHome = mkdtempSync(join(tmpdir(), 'openhorse-session-consistency-'));
const projectsDir = join(testHome, 'projects');
mkdirSync(projectsDir, { recursive: true });

const originalEnv = process.env.ORION_CODE_CONFIG_DIR;
beforeAll(() => {
  process.env.ORION_CODE_CONFIG_DIR = testHome;
});
afterAll(() => {
  if (originalEnv) process.env.ORION_CODE_CONFIG_DIR = originalEnv;
  else delete process.env.ORION_CODE_CONFIG_DIR;
  rmSync(testHome, { recursive: true, force: true });
});

import {
  createSession,
  saveSessionMeta,
  loadSessionMeta,
  appendSessionMessage,
  appendSessionMessages,
  readSessionMessages,
  updateSessionStats,
  endSession,
  truncateSessionToLastComplete,
} from '../src/services/session-storage';

const model = 'test-model';

describe('Session storage atomicity & consistency (Prompt 1)', () => {
  it('messageCount matches actual file lines after a single append', () => {
    const s = createSession('/tmp/test-project', model);
    appendSessionMessage(s.id, { role: 'user', content: 'hello', timestamp: Date.now() });
    const meta = loadSessionMeta(s.id)!;
    const messages = readSessionMessages(s.id);
    expect(meta.messageCount).toBe(messages.length);
    expect(messages.length).toBe(1);
  });

  it('messageCount matches after multiple appends', () => {
    const s = createSession('/tmp/test-project', model);
    for (let i = 0; i < 20; i++) {
      appendSessionMessage(s.id, { role: 'user', content: 'msg-' + i, timestamp: Date.now() + i });
    }
    const meta = loadSessionMeta(s.id)!;
    const messages = readSessionMessages(s.id);
    expect(meta.messageCount).toBe(20);
    expect(messages.length).toBe(20);
  });

  it('batch append matches count', () => {
    const s = createSession('/tmp/test-project', model);
    appendSessionMessages(s.id, [
      { role: 'user', content: 'a', timestamp: 1 },
      { role: 'assistant', content: 'b', timestamp: 2 },
      { role: 'user', content: 'c', timestamp: 3 },
      { role: 'assistant', content: 'd', timestamp: 4 },
      { role: 'user', content: 'e', timestamp: 5 },
    ]);
    const meta = loadSessionMeta(s.id)!;
    expect(meta.messageCount).toBe(5);
    expect(readSessionMessages(s.id).length).toBe(5);
  });

  it('updateSessionStats accumulates correctly across calls', () => {
    const s = createSession('/tmp/test-project', model);
    updateSessionStats(s.id, 100, 0.001);
    updateSessionStats(s.id, 200, 0.002);
    updateSessionStats(s.id, 300, 0.003);
    const meta = loadSessionMeta(s.id)!;
    expect(meta.tokenCount).toBe(600);
    expect(meta.cost).toBeCloseTo(0.006, 5);
  });

  it('endSession sets endTime without losing data', () => {
    const s = createSession('/tmp/test-project', model);
    updateSessionStats(s.id, 50, 0.0005);
    endSession(s.id);
    const meta = loadSessionMeta(s.id)!;
    expect(meta.endTime).toBeGreaterThan(0);
    expect(meta.tokenCount).toBe(50);
  });

  it('truncateSessionToLastComplete removes incomplete turns', () => {
    const s = createSession('/tmp/test-project', model);
    // user → assistant (final, complete) → user → (no response)
    appendSessionMessages(s.id, [
      { role: 'user', content: 'q1', timestamp: 1 },
      { role: 'assistant', content: 'a1', timestamp: 2 },
      { role: 'user', content: 'q2', timestamp: 3 },
      { role: 'assistant', content: 'a2', timestamp: 4, tool_calls: [{ id: '1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', content: 'result', timestamp: 5, toolCallId: '1' },
      // no final assistant → this turn is incomplete
    ]);
    truncateSessionToLastComplete(s.id);
    const messages = readSessionMessages(s.id);
    // 5 messages: q1,a1,q2,a2(tool_calls),tool.
    // Last complete turn = q1+a1 (2 messages). q2+a2+tool is incomplete.
    expect(messages.length).toBe(2);
    const meta = loadSessionMeta(s.id)!;
    expect(meta.messageCount).toBe(2);
  });

  it('meta file is written atomically (no partial reads)', () => {
    const s = createSession('/tmp/test-project', model);
    // Rapid save/load without errors
    for (let i = 0; i < 50; i++) {
      s.tokenCount = i;
      s.updatedAt = Date.now();
      saveSessionMeta(s);
      const loaded = loadSessionMeta(s.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.tokenCount).toBe(i);
    }
  });
});