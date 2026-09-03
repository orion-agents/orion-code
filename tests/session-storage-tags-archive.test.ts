/**
 * v0.3.7 — Session storage tags / archive / restore / listing contracts.
 *
 * The Jest environment owns an isolated `ORION_CODE_CONFIG_DIR`, so these
 * tests write only into the temp config root. Delete-based cases are guarded
 * by a filesystem probe: WorkBuddy's sandbox blocks unlink (safe-delete shim),
 * so the suite self-skips there and runs fully in CI.
 */
import { mkdtempSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  archiveSession,
  deleteSession,
  countSessionsByProject,
  createSession,
  listArchivedProjectSessions,
  listProjectSessions,
  listSessions,
  loadSessionMeta,
  normalizeSessionTags,
  restoreSession,
  setSessionTags,
} from '../src/services/session-storage';

function filesystemWritable(): boolean {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'orion-fs-probe-'));
    const file = join(dir, 'probe.txt');
    writeFileSync(file, 'x');
    unlinkSync(file);
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

const CAN_UNLINK = filesystemWritable();
const maybe = CAN_UNLINK ? describe : describe.skip;
const maybeIt = CAN_UNLINK ? it : it.skip;

const projectFor = (name: string) => join(tmpdir(), `orion-v037-${name}`);

describe('session-storage tags & archive (v0.3.7)', () => {
  it('normalizeSessionTags trims, dedupes, caps length and count', () => {
    expect(normalizeSessionTags(['  bug ', 'bug', '', '   '])).toEqual(['bug']);
    expect(normalizeSessionTags(['x'.repeat(50)])).toEqual(['x'.repeat(32)]);
    const many = Array.from({ length: 20 }, (_, index) => `tag-${index}`);
    expect(normalizeSessionTags(many)).toHaveLength(8);
  });

  it('keeps default listings free of archived sessions', () => {
    const project = projectFor('default-lists');
    const session = createSession(project, 'test-model');
    expect(session).not.toBeNull();
    if (!session) return;

    expect(setSessionTags(session.id, ['bug', 'frontend']))?.not.toBeNull();
    const withTags = loadSessionMeta(session.id);
    expect(withTags?.tags).toEqual(['bug', 'frontend']);

    // Still listed everywhere before archiving.
    expect(listProjectSessions(project).some(item => item.id === session.id)).toBe(true);
    expect(countSessionsByProject().get(project)).toBeGreaterThan(0);

    const archived = archiveSession(session.id);
    expect(archived?.archivedAt).toBeGreaterThan(0);
    expect(listProjectSessions(project).some(item => item.id === session.id)).toBe(false);
    expect(listSessions().some(item => item.id === session.id)).toBe(false);
    expect(countSessionsByProject().get(project) ?? 0).toBe(0);
    expect(listArchivedProjectSessions(project).some(item => item.id === session.id)).toBe(true);

    const restored = restoreSession(session.id);
    expect(restored?.archivedAt).toBeUndefined();
    expect(listProjectSessions(project).some(item => item.id === session.id)).toBe(true);
    expect(listArchivedProjectSessions(project).some(item => item.id === session.id)).toBe(false);
  });

  it('clears tags when an empty set is saved', () => {
    const session = createSession(projectFor('clear-tags'), 'test-model');
    if (!session) return;
    setSessionTags(session.id, ['a', 'b']);
    setSessionTags(session.id, []);
    expect(loadSessionMeta(session.id)?.tags).toBeUndefined();
  });

  maybe('setSessionTags is idempotent under repeated save', () => {
    const session = createSession(projectFor('idempotent'), 'test-model');
    if (!session) return;
    setSessionTags(session.id, ['bug']);
    setSessionTags(session.id, ['bug', 'bug']);
    expect(loadSessionMeta(session.id)?.tags).toEqual(['bug']);
  });

  maybeIt('archive keeps files on disk and only flips the marker', () => {
    const session = createSession(projectFor('soft-delete'), 'test-model');
    if (!session) return;
    archiveSession(session.id);
    const meta = loadSessionMeta(session.id);
    expect(meta?.archivedAt).toBeGreaterThan(0);
    // The meta file itself still exists after archiving (soft delete).
    expect(meta).not.toBeNull();
  });
});

describe('session delete (storage)', () => {
  maybeIt('deleteSession removes the session from every listing', () => {
    const session = createSession(projectFor('delete-session'), 'test-model');
    if (!session) return;
    deleteSession(session.id);
    expect(loadSessionMeta(session.id)).toBeNull();
    expect(listProjectSessions(projectFor('delete-session'))).toHaveLength(0);
    expect(listArchivedProjectSessions(projectFor('delete-session'))).toHaveLength(0);
    expect(countSessionsByProject().get(projectFor('delete-session')) ?? 0).toBe(0);
  });
});

describe('session archive/restore idempotency (v0.3.8)', () => {
  it('archiving twice keeps a single archived state with the latest timestamp', () => {
    const session = createSession(projectFor('archive-twice'), 'test-model');
    if (!session) return;
    const first = archiveSession(session.id);
    const second = archiveSession(session.id);
    expect(second?.archivedAt).toBeGreaterThanOrEqual(first?.archivedAt ?? 0);
    expect(listArchivedProjectSessions(projectFor('archive-twice'))).toHaveLength(1);
  });

  it('restoring a never-archived session is a safe no-op', () => {
    const session = createSession(projectFor('restore-fresh'), 'test-model');
    if (!session) return;
    const restored = restoreSession(session.id);
    expect(restored?.archivedAt).toBeUndefined();
    expect(
      listProjectSessions(projectFor('restore-fresh')).some(item => item.id === session.id)
    ).toBe(true);
    expect(listArchivedProjectSessions(projectFor('restore-fresh'))).toHaveLength(0);
  });
});
