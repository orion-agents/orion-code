/**
 * Orion Code - centralized path resolution.
 *
 * All global / project paths and filenames are derived from ProductIdentity.
 * Business code MUST import from here (or config-dir.ts for helpers) instead
 * of concatenating ".orion-code" directly.
 */

import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { execFile, execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { cleanupStaleAtomicWriteFiles } from '../services/atomic-write';

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

/** ~/.orion-code/mcp.json */
export function getMcpConfigPath(): string {
  return join(getConfigHome(), 'mcp.json');
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

const projectStorageIdentities = new Map<string, { fingerprint: string; path: string }>();
const MAX_PROJECT_STORAGE_IDENTITIES = 256;
const pendingProjectStorageIdentities = new Map<string, Promise<string>>();

/** Interactive Hosts must not persist an unverified Git project identity. */
export class ProjectStorageIdentityUnavailableError extends Error {
  readonly code = 'project_storage_identity_unavailable';
  constructor(message = 'Git 项目身份暂时无法确认，请检查本地 Git 后重试；未创建会话。') {
    super(message);
    this.name = 'ProjectStorageIdentityUnavailableError';
  }
}

function gitIdentityFileFingerprint(path: string): string {
  try {
    const file = statSync(path);
    return [file.dev, file.ino, file.mode, file.size, file.mtimeMs, file.ctimeMs].join(':');
  } catch {
    return 'missing';
  }
}

/** Git's small pointer files, not repository contents, identify external gitdirs. */
function readGitIdentityPointer(path: string): string | undefined {
  try {
    const file = statSync(path);
    if (!file.isFile() || file.size > 4_096) return undefined;
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return undefined;
  }
}

/**
 * Track the nearest Git boundary without spawning Git. New nested repos,
 * removed/replaced .git markers, root-affecting Git configuration and symlink
 * retargeting invalidate identities; ordinary Git object/ref writes do not.
 */
function projectStorageFingerprint(canonicalPath: string): {
  fingerprint: string;
  hasGitBoundary: boolean;
} {
  let directory = canonicalPath;
  while (true) {
    try {
      const markerPath = join(directory, '.git');
      const marker = statSync(markerPath);
      const markerIdentity = marker.isDirectory()
        ? [marker.dev, marker.ino, marker.mode]
        : [marker.dev, marker.ino, marker.mode, marker.size, marker.mtimeMs, marker.ctimeMs];
      const pointer = marker.isDirectory() ? undefined : readGitIdentityPointer(markerPath);
      const gitDirectory = marker.isDirectory()
        ? markerPath
        : pointer?.startsWith('gitdir: ')
          ? resolve(directory, pointer.slice('gitdir: '.length))
          : undefined;
      const configIdentity: string[] = [];
      if (gitDirectory) {
        configIdentity.push(
          gitDirectory,
          gitIdentityFileFingerprint(join(gitDirectory, 'config')),
          gitIdentityFileFingerprint(join(gitDirectory, 'config.worktree'))
        );
        // Linked worktrees keep shared configuration outside their own gitdir.
        // Track both the pointer and shared config, including enabling/disabling
        // extensions.worktreeConfig, without running another Git subprocess.
        const commonPointerPath = join(gitDirectory, 'commondir');
        const commonPointer = readGitIdentityPointer(commonPointerPath);
        configIdentity.push(gitIdentityFileFingerprint(commonPointerPath));
        if (commonPointer) {
          const commonDirectory = resolve(gitDirectory, commonPointer);
          configIdentity.push(
            commonDirectory,
            gitIdentityFileFingerprint(join(commonDirectory, 'config'))
          );
        }
      }
      return {
        fingerprint: `${directory}:${markerIdentity.join(':')}|${configIdentity.join('|')}`,
        hasGitBoundary: true,
      };
    } catch {
      // No readable Git marker at this level; check its parent.
    }
    const parent = dirname(directory);
    if (parent === directory) return { fingerprint: 'folder', hasGitBoundary: false };
    directory = parent;
  }
}

function storageOperationFingerprintUnchecked(projectPath: string): string {
  const absolute = resolve(projectPath);
  const exists = existsSync(absolute);
  const canonical = exists ? realpathSync(absolute) : absolute;
  const directory = exists ? statSync(canonical) : undefined;
  const gitEnvironment = Object.entries(process.env)
    .filter(([key]) => key.startsWith('GIT_'))
    .sort(([left], [right]) => left.localeCompare(right));
  const external = ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE'].map(key => {
    const value = process.env[key];
    if (!value) return '';
    const path = resolve(canonical, value);
    const target = existsSync(path) ? realpathSync(path) : path;
    const common = readGitIdentityPointer(join(target, 'commondir'));
    return [
      target,
      gitIdentityFileFingerprint(join(target, 'config')),
      gitIdentityFileFingerprint(join(target, 'config.worktree')),
      gitIdentityFileFingerprint(join(target, 'commondir')),
      common ? gitIdentityFileFingerprint(join(resolve(target, common), 'config')) : '',
    ].join('|');
  });
  return JSON.stringify([
    canonical,
    directory ? [directory.dev, directory.ino, directory.mode] : 'missing',
    projectStorageFingerprint(canonical).fingerprint,
    gitEnvironment,
    external,
  ]);
}

function storageOperationFingerprint(projectPath: string): string {
  try {
    return storageOperationFingerprintUnchecked(projectPath);
  } catch {
    throw new ProjectStorageIdentityUnavailableError(
      'Project storage path changed or became unavailable. Retry.'
    );
  }
}

/** An operation-local verified identity; never a permanent external-env cache. */
export interface ProjectStorageIdentity {
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly projectKey: string;
  readonly fingerprint: string;
}

export async function resolveProjectStorageIdentityAsync(
  projectPath: string
): Promise<ProjectStorageIdentity> {
  const requestedPath = resolve(projectPath);
  const before = storageOperationFingerprint(requestedPath);
  const canonicalPath = await resolveProjectStoragePathAsync(requestedPath);
  if (storageOperationFingerprint(requestedPath) !== before) {
    throw new ProjectStorageIdentityUnavailableError('Project storage identity changed. Retry.');
  }
  return Object.freeze({
    requestedPath,
    canonicalPath,
    projectKey: encodeProjectPath(canonicalPath),
    fingerprint: JSON.stringify([before, storageOperationFingerprint(canonicalPath)]),
  });
}

/** Cheap lock-admission validation: filesystem/environment only, no Git spawn. */
export function assertProjectStorageIdentity(identity: ProjectStorageIdentity): void {
  if (
    JSON.stringify([
      storageOperationFingerprint(identity.requestedPath),
      storageOperationFingerprint(identity.canonicalPath),
    ]) !== identity.fingerprint
  ) {
    throw new ProjectStorageIdentityUnavailableError(
      'Project storage identity changed while waiting. Retry.'
    );
  }
}

/** Resolve a project path for storage identity with bounded, invalidatable reuse. */
export function resolveProjectStoragePath(projectPath: string): string {
  const absolute = resolve(projectPath);
  if (existsSync(absolute)) {
    let canonical = absolute;
    try {
      canonical = realpathSync(absolute);
    } catch {
      return absolute;
    }
    // Explicit external Git configuration can change identity independently of
    // the local .git boundary. Preserve its live Git semantics rather than cache it.
    const cacheable =
      !process.env.GIT_DIR && !process.env.GIT_WORK_TREE && !process.env.GIT_COMMON_DIR;
    const boundary = projectStorageFingerprint(canonical);
    const fingerprint = [
      boundary.fingerprint,
      process.env.GIT_CEILING_DIRECTORIES ?? '',
      process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM ?? '',
    ].join('|');
    const cached = cacheable ? projectStorageIdentities.get(canonical) : undefined;
    if (cached?.fingerprint === fingerprint && existsSync(cached.path)) {
      projectStorageIdentities.delete(canonical);
      projectStorageIdentities.set(canonical, cached);
      return cached.path;
    }
    let resolvedPath = canonical;
    let gitResolved = false;
    try {
      const root = execFileSync('git', ['-C', absolute, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 250,
        killSignal: 'SIGKILL',
        maxBuffer: 4_096,
        env: process.env,
      }).trim();
      if (root) {
        resolvedPath = realpathSync(root);
        gitResolved = true;
      }
    } catch {
      // Unavailable Git falls back to the existing canonical-folder identity.
    }
    // A failure under a real Git boundary may be transient. Do not pin its
    // fallback folder identity; a later successful probe must recover the root.
    if (cacheable && (gitResolved || !boundary.hasGitBoundary)) {
      projectStorageIdentities.set(canonical, { fingerprint, path: resolvedPath });
      if (projectStorageIdentities.size > MAX_PROJECT_STORAGE_IDENTITIES) {
        const oldest = projectStorageIdentities.keys().next().value;
        if (oldest) projectStorageIdentities.delete(oldest);
      }
    }
    return resolvedPath;
  }
  return absolute;
}

/** Pre-resolve interactive Host identities without blocking its event loop. */
export async function resolveProjectStoragePathAsync(projectPath: string): Promise<string> {
  const absolute = resolve(projectPath);
  if (!existsSync(absolute)) return absolute;
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch {
    throw new ProjectStorageIdentityUnavailableError(
      'Project storage path became unavailable. Retry.'
    );
  }
  const cacheable =
    !process.env.GIT_DIR && !process.env.GIT_WORK_TREE && !process.env.GIT_COMMON_DIR;
  const boundary = projectStorageFingerprint(canonical);
  const operationFingerprint = storageOperationFingerprint(absolute);
  const fingerprint = [
    boundary.fingerprint,
    process.env.GIT_CEILING_DIRECTORIES ?? '',
    process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM ?? '',
  ].join('|');
  const cached = cacheable ? projectStorageIdentities.get(canonical) : undefined;
  if (cached?.fingerprint === fingerprint && existsSync(cached.path)) return cached.path;
  const pendingKey = `${canonical}|${fingerprint}`;
  const pending = cacheable ? pendingProjectStorageIdentities.get(pendingKey) : undefined;
  if (pending) return pending;
  const probe = new Promise<string>((resolveIdentity, rejectIdentity) => {
    execFile(
      'git',
      ['-C', absolute, 'rev-parse', '--show-toplevel'],
      {
        encoding: 'utf-8',
        timeout: 250,
        killSignal: 'SIGKILL',
        maxBuffer: 4_096,
        env: process.env,
      },
      (error, stdout) => {
        let currentFingerprint: string;
        try {
          currentFingerprint = storageOperationFingerprint(absolute);
        } catch (failure) {
          rejectIdentity(failure);
          return;
        }
        if (currentFingerprint !== operationFingerprint) {
          rejectIdentity(
            new ProjectStorageIdentityUnavailableError(
              'Project storage identity changed during Git discovery. Retry.'
            )
          );
          return;
        }
        if (boundary.hasGitBoundary && (error || !stdout.trim())) {
          rejectIdentity(new ProjectStorageIdentityUnavailableError());
          return;
        }
        let result = canonical;
        let gitResolved = false;
        if (!error && stdout.trim()) {
          try {
            result = realpathSync(stdout.trim());
            gitResolved = true;
          } catch {
            if (boundary.hasGitBoundary) {
              rejectIdentity(new ProjectStorageIdentityUnavailableError());
              return;
            }
          }
        }
        // Never seed a completed probe under a boundary changed while it ran.
        if (cacheable && (gitResolved || !boundary.hasGitBoundary)) {
          projectStorageIdentities.set(canonical, { fingerprint, path: result });
          if (projectStorageIdentities.size > MAX_PROJECT_STORAGE_IDENTITIES) {
            const oldest = projectStorageIdentities.keys().next().value;
            if (oldest) projectStorageIdentities.delete(oldest);
          }
        }
        resolveIdentity(result);
      }
    );
  });
  if (cacheable) pendingProjectStorageIdentities.set(pendingKey, probe);
  try {
    return await probe;
  } finally {
    if (pendingProjectStorageIdentities.get(pendingKey) === probe) {
      pendingProjectStorageIdentities.delete(pendingKey);
    }
  }
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

/** Side-by-side v2 Thread facts. Legacy Session files remain under sessions/. */
export function getProjectThreadsV2Dir(projectPath: string): string {
  return join(getProjectDir(projectPath), 'threads-v2');
}

/** Atomic legacy Session → v2 Thread cutover index. */
export function getProjectThreadsV2IndexPath(projectPath: string): string {
  return join(getProjectThreadsV2Dir(projectPath), 'index.v1.json');
}

export function getProjectThreadV2ImportReceiptPath(projectPath: string, threadId: string): string {
  return join(getProjectThreadsV2Dir(projectPath), `${threadId}.legacy-import.v1.json`);
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

const sweptStorageDirectories = new Set<string>();

function sweepStorageDirectory(directory: string): void {
  if (sweptStorageDirectories.has(directory)) return;
  cleanupStaleAtomicWriteFiles(directory);
  sweptStorageDirectories.add(directory);
}

export function ensureConfigDir(): void {
  const dir = getConfigHome();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const sub of ['projects', 'cost', 'cache']) {
    const p = join(dir, sub);
    mkdirSync(p, { recursive: true, mode: 0o700 });
    sweepStorageDirectory(p);
  }
  sweepStorageDirectory(dir);
}

export function ensureProjectDir(projectPath: string): void {
  ensureConfigDir();
  const projectDir = getProjectDir(projectPath);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  const sessionsDir = getProjectSessionsDir(projectPath);
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  sweepStorageDirectory(projectDir);
  sweepStorageDirectory(sessionsDir);
  // Write project metadata (lazy import to avoid circular dependency).
  const { updateProjectMetadata } = require('../services/config-dir') as {
    updateProjectMetadata: (pp: string) => unknown;
  };
  updateProjectMetadata(projectPath);
}

/** Use the already-verified identity; do not re-probe Git under explicit env. */
export function ensureResolvedProjectDir(identity: ProjectStorageIdentity): string {
  assertProjectStorageIdentity(identity);
  ensureConfigDir();
  const projectDir = join(getProjectsDir(), identity.projectKey);
  const sessionsDir = join(projectDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  sweepStorageDirectory(projectDir);
  sweepStorageDirectory(sessionsDir);
  const { updateProjectMetadata } = require('../services/config-dir') as {
    updateProjectMetadata: (path: string, now: Date, identity: ProjectStorageIdentity) => unknown;
  };
  updateProjectMetadata(identity.canonicalPath, new Date(), identity);
  return sessionsDir;
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
