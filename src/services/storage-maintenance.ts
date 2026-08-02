import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  type Stats,
} from 'fs';
import { basename, dirname, join } from 'path';
import { SESSION_SIDECAR_SUFFIXES } from './session-storage';
import {
  getCanonicalProjectKey,
  getConfigHome,
  getProjectsDir,
  PROJECT_METADATA_SCHEMA_VERSION,
  resolveProjectStoragePath,
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
  quarantinedPaths: string[];
  vectorDeletedRows: number;
  issues: StorageIssue[];
}

export interface StoragePathCleanupAction {
  type: 'path';
  kind: Extract<
    StorageIssueKind,
    | 'legacy-global-sessions'
    | 'legacy-global-memory'
    | 'legacy-hash-project'
    | 'temp-project'
    | 'empty-project'
  >;
  path: string;
  projectKey?: string;
  stateFingerprint: string;
}

export interface StorageVectorCleanupAction {
  type: 'vector';
  kind: 'vector-orphan-project';
  projectKey: string;
  rowCount: number;
  databaseIdentity: string;
  rows: StorageVectorRowSnapshot[];
  stateFingerprint: string;
}

export interface StorageVectorRowSnapshot {
  id: string;
  canonicalRow: string;
  rowFingerprint: string;
}

export type StorageCleanupAction = StoragePathCleanupAction | StorageVectorCleanupAction;

export interface StorageCleanupPlan {
  version: 1;
  configHome: string;
  projectsDir: string;
  actions: StorageCleanupAction[];
  skipped: string[];
  issues: StorageIssue[];
}

export type ProjectMetadataRepairKind = 'missing-project-metadata' | 'invalid-project-metadata';

export interface ProjectMetadataRepairAction {
  kind: ProjectMetadataRepairKind;
  projectKey: string;
  projectDir: string;
  projectPath: string;
  metadataPath: string;
  stateFingerprint: string;
}

export interface ProjectMetadataRepairPlan {
  version: 1;
  projectsDir: string;
  actions: ProjectMetadataRepairAction[];
  skipped: string[];
}

export interface ProjectMetadataRepairResult {
  repaired: string[];
  skipped: string[];
  writeDisabled: true;
  blockedReason: string;
}

export type StorageMaintenancePlanEnvelope =
  | { kind: 'cleanup'; plan: StorageCleanupPlan }
  | { kind: 'repair'; plan: ProjectMetadataRepairPlan };

const HASH_PROJECT_RE = /^[a-f0-9]{16}$/;
const TEMP_PROJECT_RE =
  /^(private-tmp-|private-var-folders-.*orion-code-|tmp-orion-code-|test-project$)/;
const STORAGE_PLAN_TOKEN_TTL_MS = 10 * 60 * 1000;

interface IssuedStorageMaintenancePlan {
  expiresAt: number;
  plan: StorageMaintenancePlanEnvelope;
}

const issuedStorageMaintenancePlans = new Map<string, IssuedStorageMaintenancePlan>();

export function collectStorageReport(): StorageReport {
  const configHome = getConfigHome();
  const projectsDir = getProjectsDir();
  const projects = listProjectSummaries(projectsDir);
  const validProjectKeys = new Set(
    projects
      .filter(
        project =>
          !HASH_PROJECT_RE.test(project.projectKey) && !TEMP_PROJECT_RE.test(project.projectKey)
      )
      .map(project => project.projectKey)
  );
  const vectorProjects = inspectVectorProjects(configHome, validProjectKeys);
  const metadataRepairPlan = collectProjectMetadataRepairPlan();
  const issues: StorageIssue[] = [];

  const legacySessions = join(configHome, 'sessions');
  const legacyMemory = join(configHome, 'memory');
  if (safeIsDirectory(legacySessions)) {
    issues.push({
      kind: 'legacy-global-sessions',
      path: legacySessions,
      summary: 'Legacy global sessions directory exists',
      bytes: dirSize(legacySessions),
      canCleanup: true,
    });
  }
  if (safeIsDirectory(legacyMemory)) {
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
  }

  const projectsByKey = new Map(projects.map(project => [project.projectKey, project]));
  for (const action of metadataRepairPlan.actions) {
    issues.push({
      kind: action.kind,
      path: action.metadataPath,
      projectKey: action.projectKey,
      summary:
        action.kind === 'missing-project-metadata'
          ? 'Project metadata file is missing'
          : 'Project metadata is invalid',
      bytes: projectsByKey.get(action.projectKey)?.bytes,
      canCleanup: false,
    });
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

/** Collect an immutable, serializable cleanup plan without modifying storage. */
export function collectStorageCleanupPlan(options: StorageCleanupOptions = {}): StorageCleanupPlan {
  const opts = {
    includeLegacy: options.includeLegacy ?? true,
    includeTemp: options.includeTemp ?? true,
    includeEmpty: options.includeEmpty ?? true,
    includeVectorOrphans: options.includeVectorOrphans ?? true,
  };
  const report = collectStorageReport();
  const actions: StorageCleanupAction[] = [];
  const skipped: string[] = [];

  for (const issue of report.issues) {
    const shouldDeletePath =
      (opts.includeLegacy &&
        (issue.kind === 'legacy-global-sessions' ||
          issue.kind === 'legacy-global-memory' ||
          issue.kind === 'legacy-hash-project')) ||
      (opts.includeTemp && issue.kind === 'temp-project') ||
      (opts.includeEmpty && issue.kind === 'empty-project');

    if (shouldDeletePath && issue.path && isPathCleanupKind(issue.kind)) {
      const action = inspectCleanupPathAction(report, issue.kind, issue.path, issue.projectKey);
      if (action) actions.push(action);
      else skipped.push(issue.path);
      continue;
    }

    if (opts.includeVectorOrphans && issue.kind === 'vector-orphan-project' && issue.projectKey) {
      const action = inspectVectorCleanupAction(report, issue.projectKey);
      if (action) actions.push(action);
      else skipped.push(issue.projectKey);
      continue;
    }

    if (issue.canCleanup) skipped.push(issue.path || issue.projectKey || issue.kind);
  }

  actions.sort((a, b) => cleanupActionKey(a).localeCompare(cleanupActionKey(b)));
  return {
    version: 1,
    configHome: report.configHome,
    projectsDir: report.projectsDir,
    actions,
    skipped,
    issues: report.issues,
  };
}

/** Apply only actions captured in a cleanup plan, after exact state revalidation. */
export function cleanupStorage(
  options: StorageCleanupOptions = {},
  plan: StorageCleanupPlan = collectStorageCleanupPlan(options)
): StorageCleanupResult {
  const dryRun = options.dryRun ?? false;
  const deletedPaths: string[] = [];
  const skippedPaths = [...plan.skipped];
  const quarantinedPaths: string[] = [];
  let vectorDeletedRows = 0;

  if (!sameStorageRoots(plan.configHome, plan.projectsDir)) {
    return {
      dryRun,
      deletedPaths,
      skippedPaths: [...skippedPaths, ...plan.actions.map(cleanupActionKey)],
      quarantinedPaths,
      vectorDeletedRows,
      issues: plan.issues,
    };
  }

  for (const action of plan.actions) {
    if (action.type === 'path') {
      const current = inspectCleanupPathAction(
        {
          configHome: plan.configHome,
          projectsDir: plan.projectsDir,
        },
        action.kind,
        action.path,
        action.projectKey
      );
      if (!current || !sameCleanupPathAction(current, action)) {
        skippedPaths.push(action.path);
        continue;
      }
      if (dryRun) {
        quarantinedPaths.push(action.path);
        continue;
      }
      const quarantine = quarantinePlannedPath(action);
      if (quarantine.status === 'restored' || quarantine.status === 'skipped') {
        skippedPaths.push(action.path);
      }
      if (quarantine.quarantinePath) quarantinedPaths.push(quarantine.quarantinePath);
      continue;
    }

    const current = inspectVectorCleanupAction(
      { configHome: plan.configHome, projectsDir: plan.projectsDir },
      action.projectKey
    );
    if (!current || !sameVectorCleanupAction(current, action)) {
      skippedPaths.push(action.projectKey);
      continue;
    }
    if (dryRun) {
      vectorDeletedRows += action.rowCount;
      continue;
    }
    const deletedRows = deletePlannedVectorRows(plan.configHome, action);
    if (deletedRows !== action.rowCount) {
      skippedPaths.push(action.projectKey);
      continue;
    }
    vectorDeletedRows += deletedRows;
  }

  return {
    dryRun,
    deletedPaths,
    skippedPaths,
    quarantinedPaths,
    vectorDeletedRows,
    issues: plan.issues,
  };
}

/** Collect a read-only, revalidatable plan for safe project metadata repairs. */
export function collectProjectMetadataRepairPlan(): ProjectMetadataRepairPlan {
  const projectsDir = getProjectsDir();
  const actions: ProjectMetadataRepairAction[] = [];
  const skipped: string[] = [];

  if (!safeIsDirectory(projectsDir)) return { version: 1, projectsDir, actions, skipped };

  for (const entry of readdirSync(projectsDir)) {
    if (HASH_PROJECT_RE.test(entry) || TEMP_PROJECT_RE.test(entry)) {
      skipped.push(entry);
      continue;
    }

    const observation = inspectProjectMetadataRepair(projectsDir, entry);
    if (observation.action) {
      actions.push(observation.action);
    } else if (observation.skipped) {
      skipped.push(entry);
    }
  }

  actions.sort((a, b) => a.projectKey.localeCompare(b.projectKey));
  return { version: 1, projectsDir, actions, skipped };
}

/** Apply only the targets in a repair plan, after revalidating every target. */
export function repairProjectMetadata(
  plan: ProjectMetadataRepairPlan = collectProjectMetadataRepairPlan()
): ProjectMetadataRepairResult {
  const projectsDir = getProjectsDir();
  const repaired: string[] = [];
  const skipped = [...plan.skipped];
  const blockedReason =
    'Writable project metadata repair is disabled because Node.js cannot provide race-safe directory-relative writes on this platform.';

  if (plan.version !== 1 || plan.projectsDir !== projectsDir) {
    return {
      repaired,
      skipped: [...skipped, ...plan.actions.map(action => action.projectKey)],
      writeDisabled: true,
      blockedReason,
    };
  }

  skipped.push(...plan.actions.map(action => action.projectKey));
  return { repaired, skipped, writeDisabled: true, blockedReason };
}

/** Issue an opaque, process-local, expiring token for a previewed maintenance plan. */
export function serializeStorageMaintenancePlan(plan: StorageMaintenancePlanEnvelope): string {
  if (
    (plan.kind === 'cleanup' && !isStorageCleanupPlan(plan.plan)) ||
    (plan.kind === 'repair' && !isProjectMetadataRepairPlan(plan.plan))
  ) {
    throw new Error('Cannot issue an invalid storage maintenance plan');
  }
  pruneExpiredStorageMaintenancePlans();
  let nonce: string;
  do {
    nonce = randomBytes(32).toString('base64url');
  } while (issuedStorageMaintenancePlans.has(nonce));
  issuedStorageMaintenancePlans.set(nonce, {
    expiresAt: Date.now() + STORAGE_PLAN_TOKEN_TTL_MS,
    plan: cloneStorageMaintenancePlan(plan),
  });
  return `v2.${nonce}`;
}

/** Peek at an active plan token without consuming it (used only for preview/dry-run). */
export function deserializeStorageMaintenancePlan(
  token: string
): StorageMaintenancePlanEnvelope | undefined {
  const issued = readIssuedStorageMaintenancePlan(token, false);
  return issued ? cloneStorageMaintenancePlan(issued) : undefined;
}

/** Consume a plan token exactly once before a confirmed mutation attempt. */
export function consumeStorageMaintenancePlan(
  token: string
): StorageMaintenancePlanEnvelope | undefined {
  const issued = readIssuedStorageMaintenancePlan(token, true);
  return issued ? cloneStorageMaintenancePlan(issued) : undefined;
}

/** Clear process-local plan capabilities, primarily for process-boundary tests. */
export function resetStorageMaintenancePlanRegistry(): void {
  issuedStorageMaintenancePlans.clear();
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
    `Deleted     ${result.deletedPaths.length}`,
    `Quarantined ${result.quarantinedPaths.length}`,
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
  if (result.quarantinedPaths.length > 0) {
    for (const path of result.quarantinedPaths.slice(0, 20)) {
      lines.push(`  ${result.dryRun ? 'would quarantine' : 'retained'} ${path}`);
    }
  }

  return lines.join('\n');
}

function listProjectSummaries(projectsDir: string): StorageProjectSummary[] {
  if (!safeIsDirectory(projectsDir)) return [];

  const summaries: StorageProjectSummary[] = [];
  for (const projectKey of readdirSync(projectsDir)) {
    const projectDir = join(projectsDir, projectKey);
    if (!safeIsDirectory(projectDir)) continue;
    const metadata = inspectProjectMetadata(projectDir, projectKey);
    const repair = inspectProjectMetadataRepair(projectsDir, projectKey).action;
    const projectPath = metadata.valid ? metadata.projectPath : repair?.projectPath;
    const sessionsDir = join(projectDir, 'sessions');
    const sessions = safeIsDirectory(sessionsDir)
      ? readdirSync(sessionsDir).filter(
          file =>
            file.endsWith('.json') &&
            !SESSION_SIDECAR_SUFFIXES.some(s => file.endsWith(s)) &&
            safeIsFile(join(sessionsDir, file))
        ).length
      : 0;

    summaries.push({
      projectKey,
      path: projectDir,
      bytes: dirSize(projectDir),
      hasMetadata: metadata.valid,
      projectPath,
      sessions,
    });
  }

  return summaries.sort((a, b) => b.bytes - a.bytes || a.projectKey.localeCompare(b.projectKey));
}

interface ProjectMetadataInspection {
  exists: boolean;
  valid: boolean;
  repairable: boolean;
  fingerprint: string;
  projectPath?: string;
}

interface ProjectSessionEvidence {
  safe: boolean;
  fingerprint: string;
  projectPaths: string[];
}

function inspectProjectMetadata(
  projectDir: string,
  expectedProjectKey: string
): ProjectMetadataInspection {
  const metadataPath = join(projectDir, 'project.json');
  const inspected = readTextFileNoFollow(metadataPath);
  if (inspected.status === 'missing') {
    return { exists: false, valid: false, repairable: true, fingerprint: 'missing' };
  }
  if (inspected.status !== 'ok') {
    return {
      exists: true,
      valid: false,
      repairable: false,
      fingerprint: inspected.fingerprint,
    };
  }

  const fingerprint = fingerprintText(inspected.raw);

  try {
    const parsed = JSON.parse(inspected.raw) as {
      schemaVersion?: unknown;
      projectKey?: unknown;
      projectPath?: unknown;
    };
    const projectPath = normalizeProjectPath(parsed.projectPath);
    const valid =
      parsed.schemaVersion === PROJECT_METADATA_SCHEMA_VERSION &&
      parsed.projectKey === expectedProjectKey &&
      !!projectPath &&
      getCanonicalProjectKey(projectPath) === expectedProjectKey;
    return { exists: true, valid, repairable: true, fingerprint, projectPath };
  } catch {
    return { exists: true, valid: false, repairable: true, fingerprint };
  }
}

function inspectProjectSessions(projectDir: string): ProjectSessionEvidence {
  const sessionsDir = join(projectDir, 'sessions');
  if (!pathExistsNoFollow(sessionsDir)) {
    return { safe: true, fingerprint: fingerprintText('missing'), projectPaths: [] };
  }
  if (!safeIsDirectory(sessionsDir)) {
    return { safe: false, fingerprint: fingerprintText('unsafe-directory'), projectPaths: [] };
  }

  const evidence: string[] = [];
  const projectPaths: string[] = [];
  let files: string[];
  try {
    files = readdirSync(sessionsDir).sort();
  } catch {
    return { safe: false, fingerprint: fingerprintText('unreadable-directory'), projectPaths: [] };
  }
  for (const file of files) {
    if (!file.endsWith('.json') || SESSION_SIDECAR_SUFFIXES.some(s => file.endsWith(s))) continue;
    const inspected = readTextFileNoFollow(join(sessionsDir, file));
    if (inspected.status !== 'ok') {
      return {
        safe: false,
        fingerprint: fingerprintText(`${file}:${inspected.fingerprint}`),
        projectPaths: [],
      };
    }
    evidence.push(`${file}:${fingerprintText(inspected.raw)}`);
    try {
      const parsed = JSON.parse(inspected.raw) as { projectPath?: unknown };
      const projectPath = normalizeProjectPath(parsed.projectPath);
      if (projectPath) projectPaths.push(projectPath);
    } catch {}
  }

  return {
    safe: true,
    fingerprint: fingerprintText(evidence.join('\0')),
    projectPaths,
  };
}

function inspectProjectMetadataRepair(
  projectsDir: string,
  projectKey: string
): { action?: ProjectMetadataRepairAction; skipped: boolean } {
  if (HASH_PROJECT_RE.test(projectKey) || TEMP_PROJECT_RE.test(projectKey)) {
    return { skipped: true };
  }

  const projectDir = join(projectsDir, projectKey);
  if (!safeIsDirectory(projectDir)) return { skipped: true };

  const metadata = inspectProjectMetadata(projectDir, projectKey);
  if (metadata.valid) return { skipped: false };
  if (!metadata.repairable) return { skipped: true };

  const sessions = inspectProjectSessions(projectDir);
  if (!sessions.safe) return { skipped: true };
  const inferredPaths = new Set(sessions.projectPaths);
  if (metadata.projectPath) inferredPaths.add(metadata.projectPath);
  if (inferredPaths.size !== 1) return { skipped: true };

  const projectPath = [...inferredPaths][0];
  if (getCanonicalProjectKey(projectPath) !== projectKey) return { skipped: true };

  return {
    skipped: false,
    action: {
      kind: metadata.exists ? 'invalid-project-metadata' : 'missing-project-metadata',
      projectKey,
      projectDir,
      projectPath,
      metadataPath: join(projectDir, 'project.json'),
      stateFingerprint: fingerprintText(
        `${pathIdentityFingerprint(projectDir)}\0${metadata.fingerprint}\0${sessions.fingerprint}`
      ),
    },
  };
}

function normalizeProjectPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return resolveProjectStoragePath(value);
}

function isPathCleanupKind(kind: StorageIssueKind): kind is StoragePathCleanupAction['kind'] {
  return (
    kind === 'legacy-global-sessions' ||
    kind === 'legacy-global-memory' ||
    kind === 'legacy-hash-project' ||
    kind === 'temp-project' ||
    kind === 'empty-project'
  );
}

function quarantinePlannedPath(action: StoragePathCleanupAction): {
  status: 'quarantined' | 'restored' | 'skipped';
  quarantinePath?: string;
} {
  const parent = dirname(action.path);
  const quarantinePath = join(
    parent,
    `.${basename(action.path)}.orion-quarantine-${randomBytes(24).toString('hex')}`
  );

  try {
    if (pathExistsNoFollow(quarantinePath)) return { status: 'skipped' };
    renameSync(action.path, quarantinePath);
  } catch {
    return { status: 'skipped' };
  }

  const quarantined = inspectPathTreeNoFollow(quarantinePath);
  if (!quarantined || quarantined.fingerprint !== action.stateFingerprint) {
    if (!pathExistsNoFollow(action.path)) {
      try {
        renameSync(quarantinePath, action.path);
        return { status: 'restored' };
      } catch {}
    }
    return {
      status: 'skipped',
      quarantinePath: pathExistsNoFollow(quarantinePath) ? quarantinePath : undefined,
    };
  }
  return { status: 'quarantined', quarantinePath };
}

function inspectCleanupPathAction(
  roots: Pick<StorageReport, 'configHome' | 'projectsDir'>,
  kind: StoragePathCleanupAction['kind'],
  path: string,
  projectKey?: string
): StoragePathCleanupAction | undefined {
  if (!isExpectedCleanupPath(roots, kind, path, projectKey)) return undefined;
  const state = inspectPathTreeNoFollow(path);
  if (!state || state.type !== 'directory') return undefined;
  if (kind === 'empty-project' && state.bytes !== 0) return undefined;
  return { type: 'path', kind, path, projectKey, stateFingerprint: state.fingerprint };
}

function isExpectedCleanupPath(
  roots: Pick<StorageReport, 'configHome' | 'projectsDir'>,
  kind: StoragePathCleanupAction['kind'],
  path: string,
  projectKey?: string
): boolean {
  if (kind === 'legacy-global-sessions') return path === join(roots.configHome, 'sessions');
  if (kind === 'legacy-global-memory') return path === join(roots.configHome, 'memory');
  if (
    !projectKey ||
    !isSafeProjectKey(projectKey) ||
    path !== join(roots.projectsDir, projectKey)
  ) {
    return false;
  }
  if (kind === 'legacy-hash-project') return HASH_PROJECT_RE.test(projectKey);
  if (kind === 'temp-project') return TEMP_PROJECT_RE.test(projectKey);
  return !HASH_PROJECT_RE.test(projectKey) && !TEMP_PROJECT_RE.test(projectKey);
}

function sameCleanupPathAction(
  current: StoragePathCleanupAction,
  planned: StoragePathCleanupAction
): boolean {
  return (
    current.kind === planned.kind &&
    current.path === planned.path &&
    current.projectKey === planned.projectKey &&
    current.stateFingerprint === planned.stateFingerprint
  );
}

function inspectVectorCleanupAction(
  roots: Pick<StorageReport, 'configHome' | 'projectsDir'>,
  projectKey: string
): StorageVectorCleanupAction | undefined {
  if (!isSafeProjectKey(projectKey) || safeIsDirectory(join(roots.projectsDir, projectKey))) {
    return undefined;
  }
  const snapshot = readVectorProjectSnapshot(roots.configHome, projectKey);
  if (!snapshot || snapshot.rows.length === 0) return undefined;
  return {
    type: 'vector',
    kind: 'vector-orphan-project',
    projectKey,
    rowCount: snapshot.rows.length,
    databaseIdentity: snapshot.databaseIdentity,
    rows: snapshot.rows,
    stateFingerprint: fingerprintText(
      canonicalJson({ databaseIdentity: snapshot.databaseIdentity, rows: snapshot.rows })
    ),
  };
}

function sameVectorCleanupAction(
  current: StorageVectorCleanupAction,
  planned: StorageVectorCleanupAction
): boolean {
  return (
    current.projectKey === planned.projectKey &&
    current.databaseIdentity === planned.databaseIdentity &&
    canonicalJson(current.rows) === canonicalJson(planned.rows) &&
    current.stateFingerprint === planned.stateFingerprint &&
    current.rowCount === planned.rowCount
  );
}

function cleanupActionKey(action: StorageCleanupAction): string {
  return action.type === 'path' ? action.path : `vector:${action.projectKey}`;
}

function sameStorageRoots(configHome: string, projectsDir: string): boolean {
  return configHome === getConfigHome() && projectsDir === getProjectsDir();
}

function isSafeProjectKey(projectKey: string): boolean {
  return (
    !!projectKey &&
    projectKey !== '.' &&
    projectKey !== '..' &&
    !projectKey.includes('/') &&
    !projectKey.includes('\\')
  );
}

interface PathTreeState {
  type: 'file' | 'directory';
  bytes: number;
  fingerprint: string;
}

type ReadFileInspection =
  | { status: 'missing' | 'unsafe' | 'unreadable'; fingerprint: string }
  | { status: 'ok'; fingerprint: string; raw: Buffer };

function inspectPathTreeNoFollow(target: string): PathTreeState | undefined {
  let before: Stats;
  try {
    before = lstatSync(target);
  } catch {
    return undefined;
  }
  if (before.isSymbolicLink()) return undefined;

  if (before.isFile()) {
    const inspected = readFileNoFollow(target);
    if (inspected.status !== 'ok' || !inspected.raw) return undefined;
    return {
      type: 'file',
      bytes: inspected.raw.length,
      fingerprint: fingerprintText(`file:${stableObjectIdentity(before)}:${inspected.fingerprint}`),
    };
  }
  if (!before.isDirectory()) return undefined;

  let entries: string[];
  try {
    entries = readdirSync(target).sort();
  } catch {
    return undefined;
  }
  const children: string[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const state = inspectPathTreeNoFollow(join(target, entry));
    if (!state) return undefined;
    bytes += state.bytes;
    children.push(`${entry}:${state.fingerprint}`);
  }

  let after: Stats;
  try {
    after = lstatSync(target);
  } catch {
    return undefined;
  }
  if (!after.isDirectory() || !sameStatIdentity(before, after)) return undefined;
  return {
    type: 'directory',
    bytes,
    fingerprint: fingerprintText(
      `directory:${stableObjectIdentity(after)}\0${children.join('\0')}`
    ),
  };
}

function readTextFileNoFollow(
  path: string
):
  | { status: 'missing' | 'unsafe' | 'unreadable'; fingerprint: string }
  | { status: 'ok'; fingerprint: string; raw: string } {
  const inspected = readFileNoFollow(path);
  if (inspected.status !== 'ok') return inspected;
  return {
    status: 'ok',
    fingerprint: inspected.fingerprint,
    raw: inspected.raw.toString('utf8'),
  };
}

function readFileNoFollow(path: string): ReadFileInspection {
  let before: Stats;
  try {
    before = lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      status: code === 'ENOENT' ? 'missing' : 'unreadable',
      fingerprint: fingerprintText(code || 'lstat-error'),
    };
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    return { status: 'unsafe', fingerprint: fingerprintText(`unsafe:${statIdentity(before)}`) };
  }

  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameStatIdentity(before, opened)) {
      return { status: 'unsafe', fingerprint: fingerprintText('identity-drift') };
    }
    const raw = readFileSync(fd);
    const after = fstatSync(fd);
    if (!sameStatIdentity(opened, after)) {
      return { status: 'unreadable', fingerprint: fingerprintText('read-drift') };
    }
    return { status: 'ok', fingerprint: fingerprintText(raw.toString('base64')), raw };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code || 'read-error';
    return {
      status: code === 'ELOOP' ? 'unsafe' : 'unreadable',
      fingerprint: fingerprintText(`${code}:${statIdentity(before)}`),
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function statIdentity(stat: Stats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

function stableObjectIdentity(stat: Stats): string {
  return [stat.dev, stat.ino, stat.mode].join(':');
}

function sameStatIdentity(a: Stats, b: Stats): boolean {
  return statIdentity(a) === statIdentity(b);
}

function pathIdentityFingerprint(path: string): string {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return fingerprintText('unsafe-symlink');
    return fingerprintText(stableObjectIdentity(stat));
  } catch (error) {
    return fingerprintText((error as NodeJS.ErrnoException).code || 'lstat-error');
  }
}

function pathExistsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function safeIsFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneStorageMaintenancePlan(
  plan: StorageMaintenancePlanEnvelope
): StorageMaintenancePlanEnvelope {
  return JSON.parse(JSON.stringify(plan)) as StorageMaintenancePlanEnvelope;
}

function readIssuedStorageMaintenancePlan(
  token: string,
  consume: boolean
): StorageMaintenancePlanEnvelope | undefined {
  pruneExpiredStorageMaintenancePlans();
  const match = token.match(/^v2\.([A-Za-z0-9_-]{43})$/);
  if (!match) return undefined;
  const issued = issuedStorageMaintenancePlans.get(match[1]);
  if (!issued || issued.expiresAt <= Date.now()) {
    if (issued) issuedStorageMaintenancePlans.delete(match[1]);
    return undefined;
  }
  if (consume) issuedStorageMaintenancePlans.delete(match[1]);
  return issued.plan;
}

function pruneExpiredStorageMaintenancePlans(): void {
  const now = Date.now();
  for (const [nonce, issued] of issuedStorageMaintenancePlans) {
    if (issued.expiresAt <= now) issuedStorageMaintenancePlans.delete(nonce);
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isStorageIssue(value: unknown): value is StorageIssue {
  if (!isRecord(value) || !isStorageIssueKind(value.kind)) return false;
  return (
    typeof value.summary === 'string' &&
    typeof value.canCleanup === 'boolean' &&
    (value.path === undefined || typeof value.path === 'string') &&
    (value.projectKey === undefined || typeof value.projectKey === 'string') &&
    (value.bytes === undefined || typeof value.bytes === 'number')
  );
}

function isStorageIssueKind(value: unknown): value is StorageIssueKind {
  return (
    value === 'legacy-global-sessions' ||
    value === 'legacy-global-memory' ||
    value === 'legacy-hash-project' ||
    value === 'temp-project' ||
    value === 'empty-project' ||
    value === 'missing-project-metadata' ||
    value === 'invalid-project-metadata' ||
    value === 'vector-orphan-project'
  );
}

function isStorageCleanupAction(value: unknown): value is StorageCleanupAction {
  if (!isRecord(value) || !isSha256(value.stateFingerprint)) return false;
  if (value.type === 'path') {
    return (
      isPathCleanupKind(value.kind as StorageIssueKind) &&
      typeof value.path === 'string' &&
      (value.projectKey === undefined || typeof value.projectKey === 'string')
    );
  }
  return (
    value.type === 'vector' &&
    value.kind === 'vector-orphan-project' &&
    typeof value.projectKey === 'string' &&
    isSafeProjectKey(value.projectKey) &&
    Number.isSafeInteger(value.rowCount) &&
    (value.rowCount as number) > 0 &&
    isSha256(value.databaseIdentity) &&
    Array.isArray(value.rows) &&
    value.rows.length === value.rowCount &&
    value.rows.every(isStorageVectorRowSnapshot) &&
    new Set(value.rows.map(row => row.id)).size === value.rows.length &&
    fingerprintText(
      canonicalJson({ databaseIdentity: value.databaseIdentity, rows: value.rows })
    ) === value.stateFingerprint
  );
}

function isStorageVectorRowSnapshot(value: unknown): value is StorageVectorRowSnapshot {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.canonicalRow === 'string' &&
    isSha256(value.rowFingerprint) &&
    fingerprintText(value.canonicalRow) === value.rowFingerprint
  );
}

function isStorageCleanupPlan(value: unknown): value is StorageCleanupPlan {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.configHome === 'string' &&
    typeof value.projectsDir === 'string' &&
    Array.isArray(value.actions) &&
    value.actions.every(isStorageCleanupAction) &&
    isStringArray(value.skipped) &&
    Array.isArray(value.issues) &&
    value.issues.every(isStorageIssue)
  );
}

function isProjectMetadataRepairAction(value: unknown): value is ProjectMetadataRepairAction {
  return (
    isRecord(value) &&
    (value.kind === 'missing-project-metadata' || value.kind === 'invalid-project-metadata') &&
    typeof value.projectKey === 'string' &&
    isSafeProjectKey(value.projectKey) &&
    typeof value.projectDir === 'string' &&
    typeof value.projectPath === 'string' &&
    typeof value.metadataPath === 'string' &&
    isSha256(value.stateFingerprint)
  );
}

function isProjectMetadataRepairPlan(value: unknown): value is ProjectMetadataRepairPlan {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.projectsDir === 'string' &&
    Array.isArray(value.actions) &&
    value.actions.every(isProjectMetadataRepairAction) &&
    isStringArray(value.skipped)
  );
}

function fingerprintText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function inspectVectorProjects(
  configHome: string,
  validProjectKeys: Set<string>
): VectorStorageSummary[] {
  const dbPath = join(configHome, 'vector.db');
  if (!safeIsFile(dbPath)) return [];

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const hasMemories = db.prepare("SELECT name FROM sqlite_master WHERE name = 'memories'").get();
    if (!hasMemories) return [];

    const rows = db
      .prepare(
        `
      SELECT COALESCE(project, 'global') as project, COUNT(*) as rows
      FROM memories
      GROUP BY COALESCE(project, 'global')
      ORDER BY rows DESC, project ASC
    `
      )
      .all() as Array<{ project: string; rows: number }>;

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

interface VectorProjectSnapshot {
  databaseIdentity: string;
  rows: StorageVectorRowSnapshot[];
}

function readVectorProjectSnapshot(
  configHome: string,
  project: string
): VectorProjectSnapshot | undefined {
  const dbPath = join(configHome, 'vector.db');
  const databaseIdentity = databaseFileIdentity(dbPath);
  if (!databaseIdentity) return undefined;

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    db.defaultSafeIntegers(true);
    const hasMemories = db.prepare("SELECT name FROM sqlite_master WHERE name = 'memories'").get();
    if (!hasMemories) return undefined;
    const rows = readVectorRowsFromDatabase(db, project);
    if (!rows || databaseFileIdentity(dbPath) !== databaseIdentity) return undefined;
    return { databaseIdentity, rows };
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

function deletePlannedVectorRows(configHome: string, action: StorageVectorCleanupAction): number {
  const dbPath = join(configHome, 'vector.db');
  if (databaseFileIdentity(dbPath) !== action.databaseIdentity) return 0;

  const db = new Database(dbPath);
  db.defaultSafeIntegers(true);
  try {
    const apply = db.transaction((): number => {
      const hasMemories = db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'memories'")
        .get();
      if (!hasMemories) return 0;
      if (databaseFileIdentity(dbPath) !== action.databaseIdentity) return 0;
      const currentRows = readVectorRowsFromDatabase(db, action.projectKey);
      if (!currentRows) return 0;
      const currentStateFingerprint = fingerprintText(
        canonicalJson({ databaseIdentity: action.databaseIdentity, rows: currentRows })
      );
      if (
        currentRows.length !== action.rowCount ||
        canonicalJson(currentRows) !== canonicalJson(action.rows) ||
        currentStateFingerprint !== action.stateFingerprint ||
        databaseFileIdentity(dbPath) !== action.databaseIdentity
      ) {
        return 0;
      }

      const currentIds = action.rows.map(row => row.id);
      const placeholders = currentIds.map(() => '?').join(', ');
      if (
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'vec_memories'").get() &&
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_vectors'").get()
      ) {
        db.prepare(
          `DELETE FROM vec_memories WHERE rowid IN (SELECT vector_rowid FROM memory_vectors WHERE memory_id IN (${placeholders}))`
        ).run(...currentIds);
        db.prepare(`DELETE FROM memory_vectors WHERE memory_id IN (${placeholders})`).run(
          ...currentIds
        );
      }
      db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...currentIds);
      return currentIds.length;
    });
    return apply.immediate();
  } finally {
    db.close();
  }
}

function readVectorRowsFromDatabase(
  db: Database.Database,
  project: string
): StorageVectorRowSnapshot[] | undefined {
  const rows = db
    .prepare('SELECT * FROM memories WHERE project = ? ORDER BY id')
    .all(project) as Array<Record<string, unknown>>;
  const snapshots: StorageVectorRowSnapshot[] = [];
  for (const row of rows) {
    if (typeof row.id !== 'string') return undefined;
    const canonicalRow = canonicalJson(row);
    snapshots.push({
      id: row.id,
      canonicalRow,
      rowFingerprint: fingerprintText(canonicalRow),
    });
  }
  return snapshots;
}

function databaseFileIdentity(path: string): string | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return fingerprintText(stableObjectIdentity(stat));
  } catch {
    return undefined;
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalJsonValue(value));
}

function toCanonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
    return { $number: String(value) };
  }
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (Buffer.isBuffer(value)) return { $buffer: value.toString('base64') };
  if (Array.isArray(value)) return value.map(toCanonicalJsonValue);
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = toCanonicalJsonValue(value[key]);
    }
    return result;
  }
  return { $unsupported: String(value) };
}

function dirSize(target: string): number {
  let stat: Stats;
  try {
    stat = lstatSync(target);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  try {
    return readdirSync(target).reduce((sum, entry) => sum + dirSize(join(target, entry)), 0);
  } catch {
    return 0;
  }
}

function safeIsDirectory(target: string): boolean {
  try {
    return lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}
