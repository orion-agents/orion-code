/**
 * Orion Code - centralized path resolution.
 *
 * All global / project paths and filenames are derived from ProductIdentity.
 * Business code MUST import from here (or config-dir.ts for helpers) instead
 * of concatenating ".orion-code" directly.
 */

import { homedir } from 'os';
import { join, resolve } from 'path';
import { existsSync, mkdirSync, realpathSync } from 'fs';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';

import {
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  ENV_FILE_NAME,
  USER_INSTRUCTIONS_FILE,
  LOCAL_INSTRUCTIONS_FILE,
  PROJECT_CONFIG_DIR_NAME,
  ENV_PREFIX,
} from './identity';

// ── Global paths ────────────────────────────────────────────────────────────

/** Root config directory: $ORION_CODE_CONFIG_DIR or ~/.orion-code */
export function getConfigHome(): string {
  return process.env[`${ENV_PREFIX}CONFIG_DIR`] ?? join(homedir(), CONFIG_DIR_NAME);
}

/** Alias for getConfigHome */
export function getConfigDir(): string {
  return getConfigHome();
}

/** ~/.orion-code/orion.json */
export function getGlobalConfigPath(): string {
  return join(getConfigHome(), CONFIG_FILE_NAME);
}

/** ~/.orion-code/settings.json */
export function getSettingsPath(): string {
  return join(getConfigHome(), 'settings.json');
}

/** ~/.orion-code/usage.json */
export function getUsageStatePath(): string {
  return join(getConfigHome(), 'usage.json');
}

/** ~/.orion-code/cost/usage-ledger.jsonl */
export function getUsageLedgerPath(): string {
  return join(getConfigHome(), 'cost', 'usage-ledger.jsonl');
}

/** ~/.orion-code/ORION.md */
export function getUserMemoryPath(): string {
  return join(getConfigHome(), USER_INSTRUCTIONS_FILE);
}

/** ~/.orion-code/history.jsonl */
export function getHistoryPath(): string {
  return join(getConfigHome(), 'history.jsonl');
}

/** ~/.orion-code/projects */
export function getProjectsDir(): string {
  return join(getConfigHome(), 'projects');
}

/** ~/.orion-code.env (outside config home) */
export function getGlobalEnvPath(): string {
  return join(homedir(), ENV_FILE_NAME);
}

// ── Project paths ───────────────────────────────────────────────────────────

/** Encode an absolute project path into a stable directory key. */
export function encodeProjectPath(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, '/');
  const encoded = normalized.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const suffix = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `${encoded || 'root'}-${suffix}`;
}

/** Resolve a project path for storage identity. */
export function resolveProjectStoragePath(projectPath: string): string {
  const absolute = resolve(projectPath);
  if (existsSync(absolute)) {
    try {
      const root = execFileSync('git', ['-C', absolute, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (root) return realpathSync(root);
    } catch {
      // Not a git worktree.
    }
    try { return realpathSync(absolute); } catch { return absolute; }
  }
  return absolute;
}

export function getCanonicalProjectKey(projectPath: string): string {
  return encodeProjectPath(resolveProjectStoragePath(projectPath));
}

export function getProjectDir(projectPath: string): string {
  return join(getProjectsDir(), getCanonicalProjectKey(projectPath));
}

export function getProjectMetadataPath(projectPath: string): string {
  return join(getProjectDir(projectPath), 'project.json');
}

export function getProjectSessionsDir(projectPath: string): string {
  return join(getProjectDir(projectPath), 'sessions');
}

export function getProjectSessionMetaPath(projectPath: string, sessionId: string): string {
  return join(getProjectSessionsDir(projectPath), `${sessionId}.json`);
}

export function getProjectSessionMessagesPath(projectPath: string, sessionId: string): string {
  return join(getProjectSessionsDir(projectPath), `${sessionId}.jsonl`);
}

export function getProjectSessionHarnessPath(projectPath: string, sessionId: string): string {
  return join(getProjectSessionsDir(projectPath), `${sessionId}.harness.json`);
}

export function getProjectSessionCompactPath(projectPath: string, sessionId: string): string {
  return join(getProjectSessionsDir(projectPath), `${sessionId}.compact.json`);
}

export function getProjectSessionTracePath(projectPath: string, sessionId: string): string {
  return join(getProjectSessionsDir(projectPath), `${sessionId}.trace.jsonl`);
}

export function getProjectSessionGoalPath(projectPath: string, sessionId: string): string {
  return join(getProjectSessionsDir(projectPath), `${sessionId}.goal.json`);
}

export function getProjectMemoryDir(projectPath: string): string {
  return join(getProjectDir(projectPath), 'memory');
}

export function getLegacyProjectMemoryDir(projectPath: string): string {
  const hash = createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
  return join(getProjectsDir(), hash, 'memory');
}

export function getProjectArtifactsDir(projectPath: string): string {
  return join(getProjectDir(projectPath), 'artifacts');
}

export function getProjectCheckpointsDir(projectPath: string): string {
  return join(getProjectDir(projectPath), 'checkpoints');
}

export function getProjectIndexesDir(projectPath: string): string {
  return join(getProjectDir(projectPath), 'indexes');
}

// ── Cost / Cache ────────────────────────────────────────────────────────────

export function getCostDir(): string {
  return join(getConfigHome(), 'cost');
}

export function getDailyCostPath(date?: Date): string {
  const d = date ?? new Date();
  const filename = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`;
  return join(getCostDir(), filename);
}

export function getCacheDir(): string {
  return join(getConfigHome(), 'cache');
}

// ── Memory paths (User / Project / Local) ───────────────────────────────────

export type MemoryType = 'User' | 'Project' | 'Local';

export function getMemoryPath(type: MemoryType, cwd?: string): string {
  const workDir = cwd ?? process.cwd();
  switch (type) {
    case 'User':
      return getUserMemoryPath();
    case 'Project':
      return join(workDir, USER_INSTRUCTIONS_FILE);
    case 'Local':
      return join(workDir, LOCAL_INSTRUCTIONS_FILE);
  }
}

export function getExistingMemoryPaths(cwd?: string): string[] {
  const types: MemoryType[] = ['Local', 'Project', 'User'];
  return types.map(t => getMemoryPath(t, cwd)).filter(p => existsSync(p));
}

// ── Directory helpers ───────────────────────────────────────────────────────

export function ensureConfigDir(): void {
  const dir = getConfigHome();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  for (const sub of ['projects', 'cost', 'cache']) {
    const p = join(dir, sub);
    if (!existsSync(p)) mkdirSync(p, { mode: 0o700 });
  }
}

export function ensureProjectDir(projectPath: string): void {
  ensureConfigDir();
  const projectDir = getProjectDir(projectPath);
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  }
  const sessionsDir = getProjectSessionsDir(projectPath);
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  }
  // Write project metadata (lazy import to avoid circular dependency).
  const { updateProjectMetadata } = require('../services/config-dir') as {
    updateProjectMetadata: (pp: string) => unknown;
  };
  updateProjectMetadata(projectPath);
}

// ── Project filesystem scanning ─────────────────────────────────────────────

/** Ordered project config candidate files (relative to project root). */
export const PROJECT_CONFIG_CANDIDATES = [
  '.orion-code.yaml',
  '.orion-code.yml',
  '.orion-code.json',
  'orion-code.yaml',
  'orion-code.yml',
  'orion.json',
] as const;

/** Project instructions file (relative to project root). */
export function getProjectInstructionsPath(projectRoot: string): string {
  return join(projectRoot, PROJECT_CONFIG_DIR_NAME, 'instructions.md');
}

/** Project skills directory (relative to project root). */
export function getProjectSkillsDir(projectRoot: string): string {
  return join(projectRoot, PROJECT_CONFIG_DIR_NAME, 'skills');
}