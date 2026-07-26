// This must be set before the module is imported
// Jest hoists import statements, so we use a setup file approach
// Instead, we test with the actual config directory

import {
  getConfigHome,
  ensureConfigDir,
  ensureProjectDir,
  getGlobalConfigPath,
  getSettingsPath,
  getUserMemoryPath,
  getHistoryPath,
  getProjectsDir,
  getCostDir,
  getCanonicalProjectKey,
  getLegacyProjectMemoryDir,
  getProjectArtifactsDir,
  getProjectCheckpointsDir,
  getProjectMetadataPath,
  getProjectMemoryDir,
  readProjectMetadata,
  updateProjectMetadata,
  getMemoryPath,
  getExistingMemoryPaths,
  type MemoryType,
} from '../src/services/config-dir';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

describe('config-dir', () => {
  // Use a unique test directory based on timestamp to avoid conflicts
  const testDir = join(homedir(), `.openhorse-test-${Date.now()}`);
  const originalEnv = process.env.ORION_CODE_CONFIG_DIR;

  beforeAll(() => {
    process.env.ORION_CODE_CONFIG_DIR = testDir;
    // Clean up test directory if it exists
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    // Restore original env var
    if (originalEnv !== undefined) {
      process.env.ORION_CODE_CONFIG_DIR = originalEnv;
    } else {
      delete process.env.ORION_CODE_CONFIG_DIR;
    }
  });

  describe('getConfigHome', () => {
    test('returns env override when set', () => {
      // The env var is set in beforeAll
      expect(getConfigHome()).toBe(testDir);
    });
  });

  describe('ensureConfigDir', () => {
    test('creates config directory and subdirectories', () => {
      ensureConfigDir();

      expect(existsSync(testDir)).toBe(true);
      expect(existsSync(join(testDir, 'sessions'))).toBe(false);
      expect(existsSync(join(testDir, 'projects'))).toBe(true);
      expect(existsSync(join(testDir, 'cost'))).toBe(true);
      expect(existsSync(join(testDir, 'cache'))).toBe(true);
    });

    test('does not throw when directory already exists', () => {
      ensureConfigDir();
      ensureConfigDir(); // Call again
      expect(existsSync(testDir)).toBe(true);
    });
  });

  describe('path getters', () => {
    test('getGlobalConfigPath returns correct path', () => {
      expect(getGlobalConfigPath()).toBe(join(testDir, 'orion.json'));
    });

    test('getSettingsPath returns correct path', () => {
      expect(getSettingsPath()).toBe(join(testDir, 'settings.json'));
    });

    test('getUserMemoryPath returns correct path', () => {
      expect(getUserMemoryPath()).toBe(join(testDir, 'ORION.md'));
    });

    test('getHistoryPath returns correct path', () => {
      expect(getHistoryPath()).toBe(join(testDir, 'history.jsonl'));
    });

    test('getProjectsDir returns correct path', () => {
      expect(getProjectsDir()).toBe(join(testDir, 'projects'));
    });

    test('getCostDir returns correct path', () => {
      expect(getCostDir()).toBe(join(testDir, 'cost'));
    });

    test('project-scoped storage helpers use canonical encoded project key', () => {
      const projectPath = '/tmp/openhorse config-dir project';
      const key = getCanonicalProjectKey(projectPath);

      expect(key).toContain('tmp-openhorse-config-dir-project');
      expect(getProjectMemoryDir(projectPath)).toBe(join(testDir, 'projects', key, 'memory'));
      expect(getProjectArtifactsDir(projectPath)).toBe(join(testDir, 'projects', key, 'artifacts'));
      expect(getProjectCheckpointsDir(projectPath)).toBe(join(testDir, 'projects', key, 'checkpoints'));
      expect(getLegacyProjectMemoryDir(projectPath)).not.toBe(getProjectMemoryDir(projectPath));
    });

    test('ensureProjectDir writes project metadata', () => {
      const projectPath = '/tmp/openhorse-project-metadata';

      ensureProjectDir(projectPath);

      const metadata = readProjectMetadata(projectPath);
      expect(existsSync(getProjectMetadataPath(projectPath))).toBe(true);
      expect(metadata?.schemaVersion).toBe(1);
      expect(metadata?.projectKey).toBe(getCanonicalProjectKey(projectPath));
      expect(metadata?.projectPath).toBe(projectPath);
      expect(metadata?.createdAt).toBeDefined();
      expect(metadata?.lastSeenAt).toBeDefined();
    });

    test('updateProjectMetadata preserves createdAt', () => {
      const projectPath = '/tmp/openhorse-project-metadata-preserve';
      const first = updateProjectMetadata(projectPath, new Date('2026-01-01T00:00:00.000Z'));
      const second = updateProjectMetadata(projectPath, new Date('2026-01-02T00:00:00.000Z'));

      expect(second.createdAt).toBe(first.createdAt);
      expect(second.lastSeenAt).toBe('2026-01-02T00:00:00.000Z');
    });
  });

  describe('getMemoryPath', () => {
    const testCwd = '/tmp/test-project';

    test('User memory path', () => {
      expect(getMemoryPath('User')).toBe(join(testDir, 'ORION.md'));
    });

    test('Project memory path', () => {
      expect(getMemoryPath('Project', testCwd)).toBe(join(testCwd, 'ORION.md'));
    });

    test('Local memory path', () => {
      expect(getMemoryPath('Local', testCwd)).toBe(join(testCwd, 'ORION.local.md'));
    });

    test('Project memory uses process.cwd() when not specified', () => {
      const path = getMemoryPath('Project');
      expect(path).toBe(join(process.cwd(), 'ORION.md'));
    });
  });

  describe('getExistingMemoryPaths', () => {
    test('returns empty array when no memory files exist', () => {
      const paths = getExistingMemoryPaths();
      expect(paths).toEqual([]);
    });

    test('returns existing memory files in correct order', () => {
      // Create test memory files
      const userMemory = getUserMemoryPath();
      writeFileSync(userMemory, '# User Memory\n');

      const paths = getExistingMemoryPaths();
      expect(paths).toContain(userMemory);

      // Clean up
      rmSync(userMemory);
    });
  });
});
