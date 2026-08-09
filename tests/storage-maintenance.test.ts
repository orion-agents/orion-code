import Database from 'better-sqlite3';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cleanupStorage,
  collectProjectMetadataRepairPlan,
  collectStorageCleanupPlan,
  collectStorageReport,
  formatStorageCleanupResult,
  repairProjectMetadata,
} from '../src/services/storage-maintenance';
import {
  getCanonicalProjectKey,
  getConfigHome,
  getProjectMetadataPath,
  getProjectsDir,
} from '../src/services/config-dir';
import { getVectorStore, resetVectorStore, VectorStore } from '../src/memory/vector-store';

const fsModule: typeof import('fs') = require('fs');

describe('storage-maintenance', () => {
  const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
  let configDir: string;

  beforeEach(() => {
    configDir = join(
      tmpdir(),
      `openhorse-storage-maintenance-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    process.env.ORION_CODE_CONFIG_DIR = configDir;
    rmSync(configDir, { recursive: true, force: true });
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    resetVectorStore();
    rmSync(configDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) {
      delete process.env.ORION_CODE_CONFIG_DIR;
    } else {
      process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
    }
  });

  test('reports legacy and temp storage issues', () => {
    mkdirSync(join(configDir, 'sessions'), { recursive: true });
    mkdirSync(join(configDir, 'memory'), { recursive: true });
    mkdirSync(join(getProjectsDir(), 'e2ca7dd6f2f0fc4b', 'memory'), { recursive: true });
    mkdirSync(join(getProjectsDir(), 'tmp-orion-code-artifact-test'), { recursive: true });

    const report = collectStorageReport();
    const kinds = report.issues.map(issue => issue.kind);

    expect(kinds).toContain('legacy-global-sessions');
    expect(kinds).toContain('legacy-global-memory');
    expect(kinds).toContain('legacy-hash-project');
    expect(kinds).toContain('temp-project');
  });

  test('cleanupStorage dry run does not delete paths', () => {
    const legacySessions = join(configDir, 'sessions');
    mkdirSync(legacySessions, { recursive: true });

    const result = cleanupStorage({ dryRun: true });

    expect(result.deletedPaths).toEqual([]);
    expect(result.quarantinedPaths).toEqual([legacySessions]);
    expect(existsSync(legacySessions)).toBe(true);
    expect(formatStorageCleanupResult(result)).toContain(`would quarantine ${legacySessions}`);
    expect(formatStorageCleanupResult(result)).not.toContain('would delete');
  });

  test('cleanupStorage quarantines legacy and temp paths without deleting them', () => {
    const legacySessions = join(configDir, 'sessions');
    const tempProject = join(getProjectsDir(), 'tmp-orion-code-artifact-test');
    mkdirSync(legacySessions, { recursive: true });
    mkdirSync(tempProject, { recursive: true });

    const result = cleanupStorage();

    expect(result.deletedPaths).toEqual([]);
    expect(result.quarantinedPaths).toHaveLength(2);
    expect(result.quarantinedPaths.every(path => existsSync(path))).toBe(true);
    expect(formatStorageCleanupResult(result)).toContain('Quarantined 2');
    expect(formatStorageCleanupResult(result)).toContain('retained');
    expect(existsSync(legacySessions)).toBe(false);
    expect(existsSync(tempProject)).toBe(false);
  });

  test('cleanupStorage applies only targets captured by the supplied plan', () => {
    const planned = join(configDir, 'sessions');
    mkdirSync(planned, { recursive: true });
    const plan = collectStorageCleanupPlan();
    const lateTarget = join(getProjectsDir(), 'tmp-orion-code-late-target');
    mkdirSync(lateTarget, { recursive: true });

    const result = cleanupStorage({}, plan);

    expect(result.deletedPaths).toEqual([]);
    expect(result.quarantinedPaths).toHaveLength(1);
    expect(existsSync(result.quarantinedPaths[0])).toBe(true);
    expect(existsSync(planned)).toBe(false);
    expect(existsSync(lateTarget)).toBe(true);
  });

  test('cleanupStorage skips a planned directory when its contents drift', () => {
    const legacySessions = join(configDir, 'sessions');
    mkdirSync(legacySessions, { recursive: true });
    const plan = collectStorageCleanupPlan();
    writeFileSync(join(legacySessions, 'late-data.json'), '{"important":true}');

    const result = cleanupStorage({}, plan);

    expect(result.deletedPaths).not.toContain(legacySessions);
    expect(result.skippedPaths).toContain(legacySessions);
    expect(existsSync(join(legacySessions, 'late-data.json'))).toBe(true);
  });

  test('cleanupStorage preserves a replacement swapped in at quarantine rename', () => {
    const legacySessions = join(configDir, 'sessions');
    const plannedBackup = join(configDir, 'sessions-planned-backup');
    mkdirSync(legacySessions, { recursive: true });
    writeFileSync(join(legacySessions, 'planned.json'), '{"planned":true}');
    const plan = collectStorageCleanupPlan();
    const realRename = fsModule.renameSync;
    let injected = false;
    const rename = jest.spyOn(fsModule, 'renameSync').mockImplementation((source, target) => {
      if (!injected && source === legacySessions) {
        injected = true;
        realRename(legacySessions, plannedBackup);
        mkdirSync(legacySessions);
        writeFileSync(join(legacySessions, 'replacement.json'), '{"keep":true}');
      }
      return realRename(source, target);
    });

    try {
      const result = cleanupStorage({}, plan);

      expect(injected).toBe(true);
      expect(result.deletedPaths).not.toContain(legacySessions);
      expect(result.skippedPaths).toContain(legacySessions);
      expect(readFileSync(join(legacySessions, 'replacement.json'), 'utf8')).toBe('{"keep":true}');
      expect(existsSync(join(plannedBackup, 'planned.json'))).toBe(true);
    } finally {
      rename.mockRestore();
    }
  });

  test('cleanupStorage reports a retained quarantine when safe restoration is blocked', () => {
    const legacySessions = join(configDir, 'sessions');
    mkdirSync(legacySessions, { recursive: true });
    writeFileSync(join(legacySessions, 'planned.json'), '{"planned":true}');
    const plan = collectStorageCleanupPlan();
    const realRename = fsModule.renameSync;
    let quarantinePath: string | undefined;
    const rename = jest.spyOn(fsModule, 'renameSync').mockImplementation((source, target) => {
      const result = realRename(source, target);
      if (!quarantinePath && source === legacySessions) {
        quarantinePath = String(target);
        writeFileSync(join(quarantinePath, 'post-rename-drift.json'), '{"changed":true}');
        mkdirSync(legacySessions);
        writeFileSync(join(legacySessions, 'replacement.json'), '{"keep":true}');
      }
      return result;
    });

    try {
      const result = cleanupStorage({}, plan);

      expect(result.deletedPaths).not.toContain(legacySessions);
      expect(result.skippedPaths).toContain(legacySessions);
      expect(result.quarantinedPaths).toEqual([quarantinePath]);
      expect(existsSync(join(legacySessions, 'replacement.json'))).toBe(true);
      expect(existsSync(join(quarantinePath!, 'planned.json'))).toBe(true);
    } finally {
      rename.mockRestore();
    }
  });

  test('cleanupStorage preserves both paths after the final quarantine fingerprint check', () => {
    const legacySessions = join(configDir, 'sessions');
    mkdirSync(legacySessions, { recursive: true });
    writeFileSync(join(legacySessions, 'planned.json'), '{"planned":true}');
    const plan = collectStorageCleanupPlan();
    const realRename = fsModule.renameSync;
    const realLstat = fsModule.lstatSync;
    let quarantinePath: string | undefined;
    let quarantineRootStats = 0;
    const rename = jest.spyOn(fsModule, 'renameSync').mockImplementation((source, target) => {
      const result = realRename(source, target);
      if (source === legacySessions) quarantinePath = String(target);
      return result;
    });
    const lstat = jest.spyOn(fsModule, 'lstatSync').mockImplementation(path => {
      const stat = realLstat(path);
      if (quarantinePath && String(path) === quarantinePath) {
        quarantineRootStats += 1;
        if (quarantineRootStats === 2) {
          mkdirSync(legacySessions);
          writeFileSync(join(legacySessions, 'replacement.json'), '{"keep":true}');
        }
      }
      return stat;
    });
    const remove = jest.spyOn(fsModule, 'rmSync');

    try {
      const result = cleanupStorage({}, plan);

      expect(quarantineRootStats).toBe(2);
      expect(remove).not.toHaveBeenCalled();
      expect(result.deletedPaths).toEqual([]);
      expect(result.quarantinedPaths).toEqual([quarantinePath]);
      expect(readFileSync(join(legacySessions, 'replacement.json'), 'utf8')).toBe('{"keep":true}');
      expect(readFileSync(join(quarantinePath!, 'planned.json'), 'utf8')).toBe('{"planned":true}');
    } finally {
      remove.mockRestore();
      lstat.mockRestore();
      rename.mockRestore();
    }
  });

  test('cleanupStorage never follows nested symlinks while fingerprinting directories', () => {
    const legacySessions = join(configDir, 'sessions');
    const outsideDir = join(configDir, 'outside-data');
    mkdirSync(legacySessions, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'keep.json'), '{"important":true}');
    symlinkSync(outsideDir, join(legacySessions, 'linked'), 'dir');

    const plan = collectStorageCleanupPlan();
    const result = cleanupStorage({}, plan);

    expect(plan.actions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'path', path: legacySessions })])
    );
    expect(result.skippedPaths).toContain(legacySessions);
    expect(existsSync(join(outsideDir, 'keep.json'))).toBe(true);
    expect(existsSync(legacySessions)).toBe(true);
  });

  test('repairProjectMetadata fails closed instead of writing project metadata', () => {
    const projectPath = '/tmp/storage-repair-project';
    const projectKey = getCanonicalProjectKey(projectPath);
    const sessionsDir = join(getProjectsDir(), projectKey, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'session-1.json'),
      JSON.stringify({
        id: 'session-1',
        projectPath,
        model: 'gpt-4o',
        startTime: Date.now(),
        tokenCount: 0,
        cost: 0,
      })
    );

    const result = repairProjectMetadata();

    expect(result.repaired).toEqual([]);
    expect(result.skipped).toContain(projectKey);
    expect(result.writeDisabled).toBe(true);
    expect(result.blockedReason).toContain('race-safe');
    expect(existsSync(getProjectMetadataPath(projectPath))).toBe(false);
  });

  test('collectProjectMetadataRepairPlan previews repairs without writing metadata', () => {
    const projectPath = '/tmp/storage-repair-preview';
    const projectKey = getCanonicalProjectKey(projectPath);
    const sessionsDir = join(getProjectsDir(), projectKey, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeSessionMetadata(sessionsDir, 'session-1', projectPath);

    const plan = collectProjectMetadataRepairPlan();

    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: 'missing-project-metadata',
        projectKey,
        projectPath,
      }),
    ]);
    expect(existsSync(getProjectMetadataPath(projectPath))).toBe(false);
  });

  test('repairProjectMetadata keeps every planned and late target unchanged', () => {
    const plannedPath = '/tmp/storage-repair-planned';
    const plannedKey = getCanonicalProjectKey(plannedPath);
    const plannedSessions = join(getProjectsDir(), plannedKey, 'sessions');
    mkdirSync(plannedSessions, { recursive: true });
    writeSessionMetadata(plannedSessions, 'session-1', plannedPath);
    const plan = collectProjectMetadataRepairPlan();

    const latePath = '/tmp/storage-repair-late';
    const lateKey = getCanonicalProjectKey(latePath);
    const lateSessions = join(getProjectsDir(), lateKey, 'sessions');
    mkdirSync(lateSessions, { recursive: true });
    writeSessionMetadata(lateSessions, 'session-2', latePath);

    const result = repairProjectMetadata(plan);

    expect(result.repaired).toEqual([]);
    expect(result.skipped).toContain(plannedKey);
    expect(result.writeDisabled).toBe(true);
    expect(existsSync(getProjectMetadataPath(plannedPath))).toBe(false);
    expect(existsSync(getProjectMetadataPath(latePath))).toBe(false);
  });

  test('cleanupStorage does not rewrite project metadata', () => {
    const projectPath = '/tmp/storage-cleanup-metadata';
    const projectKey = getCanonicalProjectKey(projectPath);
    const sessionsDir = join(getProjectsDir(), projectKey, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeSessionMetadata(sessionsDir, 'session-1', projectPath);
    const metadataPath = getProjectMetadataPath(projectPath);
    writeFileSync(
      metadataPath,
      JSON.stringify({
        schemaVersion: 1,
        projectKey,
        projectPath,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-01T00:00:00.000Z',
      })
    );
    const before = readFileSync(metadataPath, 'utf8');
    mkdirSync(join(configDir, 'sessions'), { recursive: true });

    cleanupStorage();

    expect(readFileSync(metadataPath, 'utf8')).toBe(before);
  });

  test('storage maintenance plan and apply leave valid and malformed Goal deletion fences untouched', () => {
    const projectPath = '/tmp/storage-fence-preservation';
    const projectKey = getCanonicalProjectKey(projectPath);
    const projectDir = join(getProjectsDir(), projectKey);
    const sessionsDir = join(projectDir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeSessionMetadata(sessionsDir, 'session-1', projectPath);
    writeFileSync(
      getProjectMetadataPath(projectPath),
      JSON.stringify({
        schemaVersion: 1,
        projectKey,
        projectPath,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-01T00:00:00.000Z',
      })
    );
    const validFencePath = join(sessionsDir, 'session-1.goal.json.deleted');
    const malformedFencePath = join(sessionsDir, 'session-2.goal.json.deleted');
    const validFence = JSON.stringify({
      version: 1,
      kind: 'goal_deletion_fence',
      sessionId: 'session-1',
      goalId: 'goal-1',
      revision: 3,
      deletedAt: Date.now(),
    });
    const malformedFence = '{not-json';
    writeFileSync(validFencePath, validFence);
    writeFileSync(malformedFencePath, malformedFence);

    const cleanupPlan = collectStorageCleanupPlan();
    const repairPlan = collectProjectMetadataRepairPlan();
    const dryRun = cleanupStorage({ dryRun: true }, cleanupPlan);
    const applied = cleanupStorage({}, cleanupPlan);
    const repaired = repairProjectMetadata(repairPlan);

    expect(cleanupPlan.actions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'path', path: projectDir })])
    );
    expect(dryRun.deletedPaths).toEqual([]);
    expect(applied.deletedPaths).toEqual([]);
    expect(repaired.repaired).toEqual([]);
    expect(readFileSync(validFencePath, 'utf8')).toBe(validFence);
    expect(readFileSync(malformedFencePath, 'utf8')).toBe(malformedFence);
  });

  test('repairProjectMetadata skips a planned target when inference drifts', () => {
    const projectPath = '/tmp/storage-repair-drift';
    const projectKey = getCanonicalProjectKey(projectPath);
    const sessionsDir = join(getProjectsDir(), projectKey, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const sessionPath = join(sessionsDir, 'session-1.json');
    writeSessionMetadata(sessionsDir, 'session-1', projectPath);
    const plan = collectProjectMetadataRepairPlan();
    writeFileSync(
      sessionPath,
      JSON.stringify({
        id: 'session-1',
        projectPath: '/tmp/storage-repair-drifted-elsewhere',
      })
    );

    const result = repairProjectMetadata(plan);

    expect(result.repaired).toEqual([]);
    expect(result.skipped).toContain(projectKey);
    expect(existsSync(getProjectMetadataPath(projectPath))).toBe(false);
  });

  test('repairProjectMetadata preserves raw invalid-metadata hashes during revalidation', () => {
    const projectPath = '/tmp/storage-repair-invalid-drift';
    const projectKey = getCanonicalProjectKey(projectPath);
    const projectDir = join(getProjectsDir(), projectKey);
    const sessionsDir = join(projectDir, 'sessions');
    const metadataPath = join(projectDir, 'project.json');
    mkdirSync(sessionsDir, { recursive: true });
    writeSessionMetadata(sessionsDir, 'session-1', projectPath);
    writeFileSync(metadataPath, '{broken-one');
    const plan = collectProjectMetadataRepairPlan();
    writeFileSync(metadataPath, '{different-broken-two');

    const result = repairProjectMetadata(plan);

    expect(result.repaired).toEqual([]);
    expect(result.skipped).toContain(projectKey);
    expect(readFileSync(metadataPath, 'utf8')).toBe('{different-broken-two');
  });

  test('repairProjectMetadata fails closed when project metadata cannot be read', () => {
    const projectPath = '/tmp/storage-repair-unreadable';
    const projectKey = getCanonicalProjectKey(projectPath);
    const projectDir = join(getProjectsDir(), projectKey);
    const sessionsDir = join(projectDir, 'sessions');
    const metadataPath = join(projectDir, 'project.json');
    mkdirSync(sessionsDir, { recursive: true });
    writeSessionMetadata(sessionsDir, 'session-1', projectPath);
    writeFileSync(metadataPath, '{"projectPath":"/tmp/storage-repair-unreadable"}');
    chmodSync(metadataPath, 0o000);

    try {
      const plan = collectProjectMetadataRepairPlan();
      expect(plan.actions).toEqual([]);
      expect(plan.skipped).toContain(projectKey);
    } finally {
      chmodSync(metadataPath, 0o600);
    }
  });

  test('repairProjectMetadata never follows a project.json symlink', () => {
    const projectPath = '/tmp/storage-repair-metadata-link';
    const projectKey = getCanonicalProjectKey(projectPath);
    const projectDir = join(getProjectsDir(), projectKey);
    const sessionsDir = join(projectDir, 'sessions');
    const outsideMetadata = join(configDir, 'outside-project.json');
    mkdirSync(sessionsDir, { recursive: true });
    writeSessionMetadata(sessionsDir, 'session-1', projectPath);
    writeFileSync(outsideMetadata, JSON.stringify({ projectPath }));
    symlinkSync(outsideMetadata, join(projectDir, 'project.json'));

    const plan = collectProjectMetadataRepairPlan();

    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toContain(projectKey);
    expect(JSON.parse(readFileSync(outsideMetadata, 'utf8')).projectPath).toBe(projectPath);
  });

  test('repairProjectMetadata skips when missing metadata is swapped to a symlink before apply', () => {
    const projectPath = '/tmp/storage-repair-metadata-swap';
    const projectKey = getCanonicalProjectKey(projectPath);
    const projectDir = join(getProjectsDir(), projectKey);
    const sessionsDir = join(projectDir, 'sessions');
    const metadataPath = join(projectDir, 'project.json');
    const outsideMetadata = join(configDir, 'outside-swap.json');
    mkdirSync(sessionsDir, { recursive: true });
    writeSessionMetadata(sessionsDir, 'session-1', projectPath);
    writeFileSync(outsideMetadata, '{"keep":true}');
    const plan = collectProjectMetadataRepairPlan();
    symlinkSync(outsideMetadata, metadataPath);

    const result = repairProjectMetadata(plan);

    expect(result.repaired).toEqual([]);
    expect(result.skipped).toContain(projectKey);
    expect(readFileSync(outsideMetadata, 'utf8')).toBe('{"keep":true}');
  });

  test('repairProjectMetadata remains write-disabled when the project parent is swapped', () => {
    const projectPath = '/tmp/storage-repair-parent-swap';
    const projectKey = getCanonicalProjectKey(projectPath);
    const projectDir = join(getProjectsDir(), projectKey);
    const sessionsDir = join(projectDir, 'sessions');
    const movedDir = join(getProjectsDir(), `${projectKey}-moved`);
    const outsideDir = join(configDir, 'outside-parent-swap');
    mkdirSync(sessionsDir, { recursive: true });
    writeSessionMetadata(sessionsDir, 'session-1', projectPath);
    const plan = collectProjectMetadataRepairPlan();
    renameSync(projectDir, movedDir);
    mkdirSync(join(outsideDir, 'sessions'), { recursive: true });
    writeSessionMetadata(join(outsideDir, 'sessions'), 'session-2', projectPath);
    symlinkSync(outsideDir, projectDir, 'dir');

    const result = repairProjectMetadata(plan);

    expect(result.repaired).toEqual([]);
    expect(result.skipped).toContain(projectKey);
    expect(result.writeDisabled).toBe(true);
    expect(result.blockedReason).toContain('race-safe');
    expect(existsSync(join(outsideDir, 'project.json'))).toBe(false);
  });

  test('collectProjectMetadataRepairPlan never follows a project directory symlink', () => {
    const projectPath = '/tmp/storage-repair-symlink';
    const projectKey = getCanonicalProjectKey(projectPath);
    const targetDir = join(configDir, 'symlink-target');
    const sessionsDir = join(targetDir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeSessionMetadata(sessionsDir, 'session-1', projectPath);
    mkdirSync(getProjectsDir(), { recursive: true });
    symlinkSync(targetDir, join(getProjectsDir(), projectKey), 'dir');

    const plan = collectProjectMetadataRepairPlan();

    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toContain(projectKey);
    expect(existsSync(join(targetDir, 'project.json'))).toBe(false);
  });

  test('collectProjectMetadataRepairPlan never follows a sessions directory symlink', () => {
    const projectPath = '/tmp/storage-repair-sessions-symlink';
    const projectKey = getCanonicalProjectKey(projectPath);
    const projectDir = join(getProjectsDir(), projectKey);
    const outsideSessions = join(configDir, 'outside-sessions');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(outsideSessions, { recursive: true });
    writeSessionMetadata(outsideSessions, 'session-1', projectPath);
    symlinkSync(outsideSessions, join(projectDir, 'sessions'), 'dir');

    const plan = collectProjectMetadataRepairPlan();

    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toContain(projectKey);
  });

  test('collectProjectMetadataRepairPlan never follows a session file symlink', () => {
    const projectPath = '/tmp/storage-repair-session-file-symlink';
    const projectKey = getCanonicalProjectKey(projectPath);
    const projectDir = join(getProjectsDir(), projectKey);
    const sessionsDir = join(projectDir, 'sessions');
    const outsideSession = join(configDir, 'outside-session.json');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(outsideSession, JSON.stringify({ id: 'outside', projectPath }));
    symlinkSync(outsideSession, join(sessionsDir, 'session-1.json'));

    const plan = collectProjectMetadataRepairPlan();

    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toContain(projectKey);
  });

  test('cleanupStorage removes vector rows for orphan project keys', () => {
    const dbPath = join(getConfigHome(), 'vector.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        description TEXT,
        project TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.prepare(
      `
      INSERT INTO memories (id, name, type, content, description, project, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      'orphan-id',
      'orphan',
      'project',
      'orphan content',
      '',
      'missing-project-key',
      Date.now(),
      Date.now()
    );
    db.close();

    const result = cleanupStorage();
    const after = new Database(dbPath, { readonly: true });
    const rows = after.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number };
    after.close();

    expect(result.vectorDeletedRows).toBe(1);
    expect(rows.count).toBe(0);
  });

  test('cleanupStorage skips vector deletion when the previewed row set drifts', () => {
    const dbPath = join(getConfigHome(), 'vector.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        description TEXT,
        project TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    const insert = db.prepare(
      `
      INSERT INTO memories (id, name, type, content, description, project, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
    );
    insert.run('planned-id', 'planned', 'project', 'one', '', 'orphan-project', 1, 1);
    db.close();
    const plan = collectStorageCleanupPlan();

    const changed = new Database(dbPath);
    insertVectorMemory(changed, 'late-id', 'late', 'orphan-project');
    changed.close();

    const result = cleanupStorage({}, plan);
    const after = new Database(dbPath, { readonly: true });
    const ids = (
      after.prepare('SELECT id FROM memories ORDER BY id').all() as Array<{ id: string }>
    ).map(row => row.id);
    after.close();

    expect(result.vectorDeletedRows).toBe(0);
    expect(result.skippedPaths).toContain('orphan-project');
    expect(ids).toEqual(['late-id', 'planned-id']);
  });

  test('cleanupStorage binds vector cleanup to the previewed database file identity', () => {
    const dbPath = join(getConfigHome(), 'vector.db');
    const backupPath = `${dbPath}.previewed`;
    const previewed = createVectorDatabase(dbPath);
    insertVectorMemory(previewed, 'same-id', 'previewed', 'orphan-project');
    previewed.close();
    const plan = collectStorageCleanupPlan();
    renameSync(dbPath, backupPath);
    const replacement = createVectorDatabase(dbPath);
    insertVectorMemory(replacement, 'same-id', 'replacement', 'orphan-project');
    replacement.close();

    const result = cleanupStorage({}, plan);
    const after = new Database(dbPath, { readonly: true });
    const row = after.prepare('SELECT content FROM memories WHERE id = ?').get('same-id') as {
      content: string;
    };
    after.close();

    expect(result.vectorDeletedRows).toBe(0);
    expect(result.skippedPaths).toContain('orphan-project');
    expect(row.content).toBe('replacement');
  });

  test('cleanupStorage uses length-safe canonical vector row snapshots', () => {
    const dbPath = join(getConfigHome(), 'vector.db');
    const db = createVectorDatabase(dbPath);
    insertVectorMemory(db, 'a', 'first', 'orphan-project');
    insertVectorMemory(db, 'b\0c', 'second', 'orphan-project');
    db.close();
    const plan = collectStorageCleanupPlan();
    const changed = new Database(dbPath);
    changed.prepare('DELETE FROM memories').run();
    insertVectorMemory(changed, 'a\0b', 'replacement-first', 'orphan-project');
    insertVectorMemory(changed, 'c', 'replacement-second', 'orphan-project');
    changed.close();

    const result = cleanupStorage({}, plan);
    const after = new Database(dbPath, { readonly: true });
    const ids = (
      after.prepare('SELECT id FROM memories ORDER BY id').all() as Array<{ id: string }>
    ).map(row => row.id);
    after.close();

    expect(result.vectorDeletedRows).toBe(0);
    expect(result.skippedPaths).toContain('orphan-project');
    expect(ids).toEqual(['a\0b', 'c']);
  });

  test('collectStorageCleanupPlan snapshots through the live VectorStore connection', () => {
    const dbPath = join(getConfigHome(), 'vector.db');
    getVectorStore({ dbPath });
    const db = new Database(dbPath);
    insertVectorMemory(db, 'live-id', 'live', 'orphan-project');
    db.close();
    const snapshot = jest.spyOn(VectorStore.prototype, 'snapshotProjectRows');

    const plan = collectStorageCleanupPlan();

    expect(snapshot).toHaveBeenCalledWith('orphan-project');
    expect(
      plan.actions.some(
        action => action.type === 'vector' && action.projectKey === 'orphan-project'
      )
    ).toBe(true);
  });

  test('cleanupStorage detects adjacent integers above Number.MAX_SAFE_INTEGER', () => {
    const dbPath = join(getConfigHome(), 'vector.db');
    const db = createVectorDatabase(dbPath);
    db.prepare(
      `
      INSERT INTO memories (id, name, type, content, description, project, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      'large-integer-id',
      'large-integer',
      'project',
      'important',
      '',
      'orphan-project',
      9007199254740992n,
      1
    );
    db.close();
    const plan = collectStorageCleanupPlan();
    const changed = new Database(dbPath);
    changed
      .prepare('UPDATE memories SET created_at = ? WHERE id = ?')
      .run(9007199254740993n, 'large-integer-id');
    changed.close();

    const result = cleanupStorage({}, plan);
    const after = new Database(dbPath, { readonly: true });
    after.defaultSafeIntegers(true);
    const row = after
      .prepare('SELECT created_at FROM memories WHERE id = ?')
      .get('large-integer-id') as { created_at: bigint };
    after.close();

    expect(result.vectorDeletedRows).toBe(0);
    expect(result.skippedPaths).toContain('orphan-project');
    expect(row.created_at).toBe(9007199254740993n);
  });
});

function writeSessionMetadata(sessionsDir: string, sessionId: string, projectPath: string): void {
  writeFileSync(
    join(sessionsDir, `${sessionId}.json`),
    JSON.stringify({
      id: sessionId,
      projectPath,
      model: 'gpt-4o',
      startTime: Date.now(),
      tokenCount: 0,
      cost: 0,
    })
  );
}

function insertVectorMemory(
  db: Database.Database,
  id: string,
  name: string,
  project: string
): void {
  db.prepare(
    `
    INSERT INTO memories (id, name, type, content, description, project, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(id, name, 'project', name, '', project, Date.now(), Date.now());
}

function createVectorDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      description TEXT,
      project TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return db;
}
