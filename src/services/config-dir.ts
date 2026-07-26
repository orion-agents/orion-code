/**
 * Orion Code - configuration directory path management.
 *
 * Re-exports from src/product/paths.ts for backward compatibility.
 * All new code should import directly from src/product/paths.ts.
 */

import { readFileSync, existsSync, realpathSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, resolve } from 'path';
import { atomicWriteFileSync } from './atomic-write';

export {
  getConfigHome,
  getConfigDir,
  getGlobalConfigPath,
  getSettingsPath,
  getUsageStatePath,
  getUsageLedgerPath,
  getUserMemoryPath,
  getHistoryPath,
  getProjectsDir,
  getGlobalEnvPath,
  encodeProjectPath,
  resolveProjectStoragePath,
  getCanonicalProjectKey,
  getProjectDir,
  getProjectMetadataPath,
  getProjectSessionsDir,
  getProjectSessionMetaPath,
  getProjectSessionMessagesPath,
  getProjectSessionHarnessPath,
  getProjectSessionCompactPath,
  getProjectSessionTracePath,
  getProjectSessionGoalPath,
  getProjectMemoryDir,
  getLegacyProjectMemoryDir,
  getProjectArtifactsDir,
  getProjectCheckpointsDir,
  getProjectIndexesDir,
  getCostDir,
  getDailyCostPath,
  getCacheDir,
  getMemoryPath,
  getExistingMemoryPaths,
  ensureConfigDir,
  ensureProjectDir,
  PROJECT_CONFIG_CANDIDATES,
  getProjectInstructionsPath,
  getProjectSkillsDir,
  type MemoryType,
} from '../product/paths';

export const PROJECT_METADATA_SCHEMA_VERSION = 1;

export interface ProjectMetadata {
  schemaVersion: number;
  projectKey: string;
  projectPath: string;
  createdAt: string;
  lastSeenAt: string;
}

import { getProjectDir as _getProjectDir, getProjectsDir as _getProjectsDir, encodeProjectPath as _encodeProjectPath } from '../product/paths';

export function readProjectMetadata(projectPath: string): ProjectMetadata | null {
  const metadataPath = join(_getProjectDir(projectPath), 'project.json');
  if (!existsSync(metadataPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, 'utf8')) as ProjectMetadata;
    if (
      parsed?.schemaVersion !== PROJECT_METADATA_SCHEMA_VERSION ||
      typeof parsed.projectKey !== 'string' ||
      typeof parsed.projectPath !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function updateProjectMetadata(projectPath: string, now: Date = new Date()): ProjectMetadata {
  const resolvedPath = (() => {
    const absolute = resolve(projectPath);
    if (existsSync(absolute)) {
      try {
        const root = execFileSync('git', ['-C', absolute, 'rev-parse', '--show-toplevel'], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (root) return realpathSync(root);
      } catch {}
      try { return realpathSync(absolute); } catch {}
    }
    return absolute;
  })();

  const { getProjectsDir, encodeProjectPath } = require('../product/paths');
  const projectKey = _encodeProjectPath(resolvedPath);
  const projectDir = join(_getProjectsDir(), projectKey);
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  }

  const metadataPath = join(projectDir, 'project.json');
  let createdAt = now.toISOString();
  try {
    const existing = JSON.parse(readFileSync(metadataPath, 'utf8')) as Partial<ProjectMetadata>;
    if (typeof existing.createdAt === 'string' && existing.createdAt) {
      createdAt = existing.createdAt;
    }
  } catch {}

  const metadata: ProjectMetadata = {
    schemaVersion: PROJECT_METADATA_SCHEMA_VERSION,
    projectKey,
    projectPath: resolvedPath,
    createdAt,
    lastSeenAt: now.toISOString(),
  };

  atomicWriteFileSync(metadataPath, JSON.stringify(metadata, null, 2), { mode: 0o600 });
  return metadata;
}