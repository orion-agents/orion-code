import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cleanupStorage,
  collectStorageReport,
  repairProjectMetadata,
} from '../src/services/storage-maintenance';
import {
  getCanonicalProjectKey,
  getConfigHome,
  getProjectMetadataPath,
  getProjectsDir,
} from '../src/services/config-dir';

describe('storage-maintenance', () => {
  const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
  let configDir: string;

  beforeEach(() => {
    configDir = join(tmpdir(), `openhorse-storage-maintenance-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.ORION_CODE_CONFIG_DIR = configDir;
    rmSync(configDir, { recursive: true, force: true });
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
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

    expect(result.deletedPaths).toContain(legacySessions);
    expect(existsSync(legacySessions)).toBe(true);
  });

  test('cleanupStorage deletes legacy and temp paths', () => {
    const legacySessions = join(configDir, 'sessions');
    const tempProject = join(getProjectsDir(), 'tmp-orion-code-artifact-test');
    mkdirSync(legacySessions, { recursive: true });
    mkdirSync(tempProject, { recursive: true });

    const result = cleanupStorage();

    expect(result.deletedPaths).toEqual(expect.arrayContaining([legacySessions, tempProject]));
    expect(existsSync(legacySessions)).toBe(false);
    expect(existsSync(tempProject)).toBe(false);
  });

  test('repairProjectMetadata creates project.json from session metadata', () => {
    const projectPath = '/tmp/storage-repair-project';
    const projectKey = getCanonicalProjectKey(projectPath);
    const sessionsDir = join(getProjectsDir(), projectKey, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'session-1.json'), JSON.stringify({
      id: 'session-1',
      projectPath,
      model: 'gpt-4o',
      startTime: Date.now(),
      tokenCount: 0,
      cost: 0,
    }));

    const result = repairProjectMetadata();
    const metadata = JSON.parse(readFileSync(getProjectMetadataPath(projectPath), 'utf8'));

    expect(result.repaired).toContain(projectKey);
    expect(metadata.projectKey).toBe(projectKey);
    expect(metadata.projectPath).toBe(projectPath);
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
    db.prepare(`
      INSERT INTO memories (id, name, type, content, description, project, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('orphan-id', 'orphan', 'project', 'orphan content', '', 'missing-project-key', Date.now(), Date.now());
    db.close();

    const result = cleanupStorage();
    const after = new Database(dbPath, { readonly: true });
    const rows = after.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number };
    after.close();

    expect(result.vectorDeletedRows).toBe(1);
    expect(rows.count).toBe(0);
  });
});
