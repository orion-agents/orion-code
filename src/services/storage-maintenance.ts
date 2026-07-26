import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { SESSION_SIDECAR_SUFFIXES } from './session-storage';
import {
  getCanonicalProjectKey,
  getConfigHome,
  getProjectMetadataPath,
  getProjectsDir,
  readProjectMetadata,
  updateProjectMetadata,
} from './config-dir';
import { formatBytes } from './format';

export type StorageIssueKind =
  | 'legacy-global-sessions'
  | 'legacy-global-memory'
  | 'legacy-hash-project'
  | 'temp-project'
  | 'empty-project'
  | 'missing-project-metadata'
  | 'invalid-project-metadata'
  | 'vector-orphan-project';

export interface StorageIssue {
  kind: StorageIssueKind;
  path?: string;
  projectKey?: string;
  summary: string;
  bytes?: number;
  canCleanup: boolean;
}

export interface StorageProjectSummary {
  projectKey: string;
  path: string;
  bytes: number;
  hasMetadata: boolean;
  projectPath?: string;
  sessions: number;
}

export interface VectorStorageSummary {
  project: string;
  rows: number;
  orphan: boolean;
}

export interface StorageReport {
  configHome: string;
  projectsDir: string;
  projects: StorageProjectSummary[];
  vectorProjects: VectorStorageSummary[];
  issues: StorageIssue[];
  totalBytes: number;
}

export interface StorageCleanupOptions {
  dryRun?: boolean;
  includeLegacy?: boolean;
  includeTemp?: boolean;
  includeEmpty?: boolean;
  includeVectorOrphans?: boolean;
}

export interface StorageCleanupResult {
  dryRun: boolean;
  deletedPaths: string[];
  skippedPaths: string[];
  vectorDeletedRows: number;
  issues: StorageIssue[];
}

const HASH_PROJECT_RE = /^[a-f0-9]{16}$/;
const TEMP_PROJECT_RE = /^(private-tmp-|private-var-folders-.*orion-code-|tmp-orion-code-|test-project$)/;

export function collectStorageReport(): StorageReport {
  const configHome = getConfigHome();
  const projectsDir = getProjectsDir();
  const projects = listProjectSummaries(projectsDir);
  const validProjectKeys = new Set(projects
    .filter(project => !HASH_PROJECT_RE.test(project.projectKey) && !TEMP_PROJECT_RE.test(project.projectKey))
    .map(project => project.projectKey));
  const vectorProjects = inspectVectorProjects(configHome, validProjectKeys);
  const issues: StorageIssue[] = [];

  const legacySessions = join(configHome, 'sessions');
  const legacyMemory = join(configHome, 'memory');
  if (existsSync(legacySessions)) {
    issues.push({
      kind: 'legacy-global-sessions',
      path: legacySessions,
      summary: 'Legacy global sessions directory exists',
      bytes: dirSize(legacySessions),
      canCleanup: true,
    });
  }
  if (existsSync(legacyMemory)) {
    issues.push({
      kind: 'legacy-global-memory',
      path: legacyMemory,
      summary: 'Legacy global memory directory exists',
      bytes: dirSize(legacyMemory),
      canCleanup: true,
    });
  }

  for (const project of projects) {
    if (HASH_PROJECT_RE.test(project.projectKey)) {
      issues.push({
        kind: 'legacy-hash-project',
        path: project.path,
        projectKey: project.projectKey,
        summary: 'Legacy hash project storage directory',
        bytes: project.bytes,
        canCleanup: true,
      });
      continue;
    }

    if (TEMP_PROJECT_RE.test(project.projectKey)) {
      issues.push({
        kind: 'temp-project',
        path: project.path,
        projectKey: project.projectKey,
        summary: 'Test or temporary project storage directory',
        bytes: project.bytes,
        canCleanup: true,
      });
      continue;
    }

    if (project.bytes === 0) {
      issues.push({
        kind: 'empty-project',
        path: project.path,
        projectKey: project.projectKey,
        summary: 'Empty project storage directory',
        bytes: 0,
        canCleanup: true,
      });
      continue;
    }

    if (!project.hasMetadata) {
      issues.push({
        kind: 'missing-project-metadata',
        path: getProjectMetadataPath(project.projectPath || project.path),
        projectKey: project.projectKey,
        summary: 'Project metadata file is missing',
        bytes: project.bytes,
        canCleanup: false,
      });
    } else if (project.projectPath && getCanonicalProjectKey(project.projectPath) !== project.projectKey) {
      issues.push({
        kind: 'invalid-project-metadata',
        path: getProjectMetadataPath(project.projectPath),
        projectKey: project.projectKey,
        summary: 'Project metadata does not match the canonical project key',
        bytes: project.bytes,
        canCleanup: false,
      });
    }
  }

  for (const vectorProject of vectorProjects) {
    if (!vectorProject.orphan) continue;
    issues.push({
      kind: 'vector-orphan-project',
      projectKey: vectorProject.project,
      summary: `Vector DB has ${vectorProject.rows} row(s) for a missing project`,
      canCleanup: true,
    });
  }

  return {
    configHome,
    projectsDir,
    projects,
    vectorProjects,
    issues,
    totalBytes: dirSize(configHome),
  };
}

export function cleanupStorage(options: StorageCleanupOptions = {}): StorageCleanupResult {
  const opts = {
    dryRun: options.dryRun ?? false,
    includeLegacy: options.includeLegacy ?? true,
    includeTemp: options.includeTemp ?? true,
    includeEmpty: options.includeEmpty ?? true,
    includeVectorOrphans: options.includeVectorOrphans ?? true,
  };
  const report = collectStorageReport();
  const deletedPaths: string[] = [];
  const skippedPaths: string[] = [];
  let vectorDeletedRows = 0;

  for (const issue of report.issues) {
    const shouldDeletePath =
      (opts.includeLegacy && (issue.kind === 'legacy-global-sessions' || issue.kind === 'legacy-global-memory' || issue.kind === 'legacy-hash-project')) ||
      (opts.includeTemp && issue.kind === 'temp-project') ||
      (opts.includeEmpty && issue.kind === 'empty-project');

    if (shouldDeletePath && issue.path) {
      if (!opts.dryRun) {
        rmSync(issue.path, { recursive: true, force: true });
      }
      deletedPaths.push(issue.path);
      continue;
    }

    if (opts.includeVectorOrphans && issue.kind === 'vector-orphan-project' && issue.projectKey) {
      const deleted = deleteVectorProjectRows(report.configHome, issue.projectKey, opts.dryRun);
      vectorDeletedRows += deleted;
      continue;
    }

    if (issue.canCleanup) {
      skippedPaths.push(issue.path || issue.projectKey || issue.kind);
    }
  }

  if (!opts.dryRun) {
    repairProjectMetadata();
  }

  return {
    dryRun: opts.dryRun,
    deletedPaths,
    skippedPaths,
    vectorDeletedRows,
    issues: report.issues,
  };
}

export function repairProjectMetadata(): { repaired: string[]; skipped: string[] } {
  const projectsDir = getProjectsDir();
  const repaired: string[] = [];
  const skipped: string[] = [];

  if (!existsSync(projectsDir)) {
    mkdirSync(projectsDir, { recursive: true, mode: 0o700 });
    return { repaired, skipped };
  }

  for (const entry of readdirSync(projectsDir)) {
    if (HASH_PROJECT_RE.test(entry) || TEMP_PROJECT_RE.test(entry)) {
      skipped.push(entry);
      continue;
    }

    const projectDir = join(projectsDir, entry);
    if (!safeIsDirectory(projectDir)) continue;

    const projectPath = inferProjectPath(projectDir);
    if (!projectPath) {
      skipped.push(entry);
      continue;
    }

    updateProjectMetadata(projectPath);
    repaired.push(entry);
  }

  return { repaired, skipped };
}

export function formatStorageReport(report: StorageReport): string {
  const lines = [
    'Orion Code Storage',
    '─'.repeat(40),
    `Config     ${report.configHome}`,
    `Projects   ${report.projects.length}`,
    `Size       ${formatBytes(report.totalBytes)}`,
    `Issues     ${report.issues.length}`,
    '',
  ];

  if (report.issues.length === 0) {
    lines.push('✓ Storage layout is clean');
  } else {
    for (const issue of report.issues) {
      const size = issue.bytes !== undefined ? ` ${formatBytes(issue.bytes)}` : '';
      const target = issue.path || issue.projectKey || '';
      lines.push(`! ${issue.kind}${size}`);
      lines.push(`  ${issue.summary}`);
      if (target) lines.push(`  ${target}`);
    }
  }

  if (report.vectorProjects.length > 0) {
    lines.push('', 'Vector Projects');
    for (const project of report.vectorProjects.slice(0, 12)) {
      lines.push(`  ${project.orphan ? '!' : '✓'} ${project.project} ${project.rows} rows`);
    }
  }

  return lines.join('\n');
}

export function formatStorageCleanupResult(result: StorageCleanupResult): string {
  const lines = [
    result.dryRun ? 'Orion Code Storage Cleanup (dry run)' : 'Orion Code Storage Cleanup',
    '─'.repeat(40),
    `Paths       ${result.deletedPaths.length}`,
    `Vector rows ${result.vectorDeletedRows}`,
  ];

  for (const path of result.deletedPaths.slice(0, 20)) {
    lines.push(`  ${result.dryRun ? 'would delete' : 'deleted'} ${path}`);
  }
  if (result.deletedPaths.length > 20) {
    lines.push(`  ... ${result.deletedPaths.length - 20} more`);
  }
  if (result.skippedPaths.length > 0) {
    lines.push(`Skipped    ${result.skippedPaths.length}`);
  }

  return lines.join('\n');
}

function listProjectSummaries(projectsDir: string): StorageProjectSummary[] {
  if (!existsSync(projectsDir)) return [];

  const summaries: StorageProjectSummary[] = [];
  for (const projectKey of readdirSync(projectsDir)) {
    const projectDir = join(projectsDir, projectKey);
    if (!safeIsDirectory(projectDir)) continue;
    const projectPath = inferProjectPath(projectDir);
    const metadata = projectPath ? readProjectMetadata(projectPath) : null;
    const sessionsDir = join(projectDir, 'sessions');
    const sessions = existsSync(sessionsDir)
      ? readdirSync(sessionsDir).filter(file => file.endsWith('.json') && !SESSION_SIDECAR_SUFFIXES.some(s => file.endsWith(s))).length
      : 0;

    summaries.push({
      projectKey,
      path: projectDir,
      bytes: dirSize(projectDir),
      hasMetadata: !!metadata,
      projectPath,
      sessions,
    });
  }

  return summaries.sort((a, b) => b.bytes - a.bytes || a.projectKey.localeCompare(b.projectKey));
}

function inferProjectPath(projectDir: string): string | undefined {
  const metadataPath = join(projectDir, 'project.json');
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, 'utf8')) as { projectPath?: unknown };
    if (typeof parsed.projectPath === 'string' && parsed.projectPath) {
      return parsed.projectPath;
    }
  } catch {
    // Fall through to session metadata.
  }

  const sessionsDir = join(projectDir, 'sessions');
  if (!existsSync(sessionsDir)) return undefined;
  for (const file of readdirSync(sessionsDir)) {
    if (!file.endsWith('.json') || SESSION_SIDECAR_SUFFIXES.some(s => file.endsWith(s))) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(sessionsDir, file), 'utf8')) as { projectPath?: unknown };
      if (typeof parsed.projectPath === 'string' && parsed.projectPath) {
        return parsed.projectPath;
      }
    } catch {
      // Try the next session file.
    }
  }
  return undefined;
}

function inspectVectorProjects(configHome: string, validProjectKeys: Set<string>): VectorStorageSummary[] {
  const dbPath = join(configHome, 'vector.db');
  if (!existsSync(dbPath)) return [];

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const hasMemories = db.prepare("SELECT name FROM sqlite_master WHERE name = 'memories'").get();
    if (!hasMemories) return [];

    const rows = db.prepare(`
      SELECT COALESCE(project, 'global') as project, COUNT(*) as rows
      FROM memories
      GROUP BY COALESCE(project, 'global')
      ORDER BY rows DESC, project ASC
    `).all() as Array<{ project: string; rows: number }>;

    return rows.map(row => ({
      project: row.project,
      rows: row.rows,
      orphan: row.project !== 'global' && !validProjectKeys.has(row.project),
    }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function deleteVectorProjectRows(configHome: string, project: string, dryRun: boolean): number {
  const dbPath = join(configHome, 'vector.db');
  if (!existsSync(dbPath)) return 0;

  const db = new Database(dbPath);
  try {
    const hasMemories = db.prepare("SELECT name FROM sqlite_master WHERE name = 'memories'").get();
    if (!hasMemories) return 0;

    const ids = (db.prepare('SELECT id FROM memories WHERE project = ?').all(project) as Array<{ id: string }>).map(row => row.id);
    if (dryRun || ids.length === 0) return ids.length;

    const placeholders = ids.map(() => '?').join(', ');
    if (db.prepare("SELECT name FROM sqlite_master WHERE name = 'vec_memories'").get() && db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_vectors'").get()) {
      db.prepare(`DELETE FROM vec_memories WHERE rowid IN (SELECT vector_rowid FROM memory_vectors WHERE memory_id IN (${placeholders}))`).run(...ids);
      db.prepare(`DELETE FROM memory_vectors WHERE memory_id IN (${placeholders})`).run(...ids);
    }
    db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);
    return ids.length;
  } finally {
    db.close();
  }
}

function dirSize(target: string): number {
  if (!existsSync(target)) return 0;
  try {
    const stat = statSync(target);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    return readdirSync(target).reduce((sum, entry) => sum + dirSize(join(target, entry)), 0);
  } catch {
    return 0;
  }
}

function safeIsDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}
