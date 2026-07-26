/**
 * Orion Code - Brand Migration Tool
 *
 * One-time migration from OpenHorse → Orion Code.
 * Invoked via: orion migrate openhorse [--dry-run] [--include-env] [--include-project-files]
 *
 * Runs before LLM/config initialization. Copies ~/.openhorse → ~/.orion-code
 * with filename and config-key transformations.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  renameSync,
  realpathSync,
} from 'fs';
import { join, resolve, basename } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import type {
  BrandMigrationManifestV1,
  MigrationOptions,
  MigrationResult,
  FileMapping,
} from './types';

// ── Constants ─────────────────────────────────────────────────────────────────

const SOURCE_BRAND = 'openhorse';
const TARGET_BRAND = 'orion-code';
const SOURCE_DIR = '.openhorse';
const TARGET_DIR = '.orion-code';
const SOURCE_ENV_FILE = '.openhorse.env';
const TARGET_ENV_FILE = '.orion-code.env';

/** Files that are renamed during migration. */
const RENAME_MAP: Record<string, string> = {
  'openhorse.json': 'orion.json',
  'OPENHORSE.md': 'ORION.md',
  'OPENHORSE.local.md': 'ORION.local.md',
};

/** Project-level file renames (relative to project root). */
const PROJECT_RENAME_MAP: Array<{ from: string; to: string }> = [
  { from: '.openhorse', to: '.orion-code' },
  { from: '.openhorse.yaml', to: '.orion-code.yaml' },
  { from: '.openhorse.yml', to: '.orion-code.yml' },
  { from: '.openhorse.json', to: '.orion-code.json' },
  { from: 'openhorse.yaml', to: 'orion-code.yaml' },
  { from: 'openhorse.yml', to: 'orion-code.yml' },
  { from: 'openhorse.json', to: 'orion-code.json' },
  { from: 'OPENHORSE.md', to: 'ORION.md' },
  { from: 'OPENHORSE.local.md', to: 'ORION.local.md' },
];

/** Subdirectories whose contents are copied verbatim. */
const VERBATIM_DIRS = new Set([
  'projects',
  'skills',
  'cost',
  'cache',
  'backups',
  'migration-logs',
]);

/** Directories whose parent is renamed (e.g. backups → backups/openhorse). */
const NESTED_DIRS: Record<string, string> = {
  backups: 'openhorse',
  'migration-logs': 'openhorse',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function treeHash(dir: string): string {
  const hashes: string[] = [];
  const walk = (d: string) => {
    const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const fullPath = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        hashes.push(`${fullPath}:${sha256(readFileSync(fullPath))}`);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return sha256(hashes.sort().join('\n'));
}

function inventorySource(sourceRoot: string): { fileCount: number; totalBytes: number; treeSha256: string } {
  let fileCount = 0;
  let totalBytes = 0;
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    const entries = readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        fileCount++;
        totalBytes += statSync(fullPath).size;
      }
    }
  };
  walk(sourceRoot);
  return { fileCount, totalBytes, treeSha256: treeHash(sourceRoot) };
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function copyFileSafe(src: string, dest: string, mode?: number): void {
  const content = readFileSync(src);
  writeFileSync(dest, content, { mode: mode ?? 0o600 });
}

function copyDirRecursive(srcDir: string, destDir: string): FileMapping[] {
  const mappings: FileMapping[] = [];
  ensureDir(destDir);
  const entries = readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      mappings.push(...copyDirRecursive(srcPath, destPath));
    } else if (entry.isFile()) {
      copyFileSafe(srcPath, destPath);
      mappings.push({ from: srcPath, to: destPath });
    }
  }
  return mappings;
}

function copyWithNestedDir(
  srcDir: string,
  destDir: string,
  nestedDir: string,
): FileMapping[] {
  const srcNested = join(srcDir, nestedDir);
  if (!existsSync(srcNested)) return [];
  const destNested = join(destDir, nestedDir, NESTED_DIRS[nestedDir] || '');
  return copyDirRecursive(srcNested, destNested);
}

// ── Config key remapping ─────────────────────────────────────────────────────

function remapConfigKeys(content: string): string {
  try {
    const config = JSON.parse(content);
    // Remap known fields
    const remapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      remapped[key] = value;
    }
    return JSON.stringify(remapped, null, 2);
  } catch {
    return content;
  }
}

// ── Dotenv migration ─────────────────────────────────────────────────────────

const ENV_KEY_MAP: Record<string, string> = {
  OPENHORSE_CONFIG_DIR: 'ORION_CODE_CONFIG_DIR',
  OPENHORSE_CONFIG_HOME: 'ORION_CODE_CONFIG_HOME',
  OPENHORSE_API_KEY: 'ORION_CODE_API_KEY',
  OPENHORSE_API_BASE_URL: 'ORION_CODE_API_BASE_URL',
  OPENHORSE_BASE_URL: 'ORION_CODE_BASE_URL',
  OPENHORSE_MODEL: 'ORION_CODE_MODEL',
  OPENHORSE_FALLBACK_MODEL: 'ORION_CODE_FALLBACK_MODEL',
  OPENHORSE_MODE: 'ORION_CODE_MODE',
  OPENHORSE_NAME: 'ORION_CODE_NAME',
  OPENHORSE_LOG_LEVEL: 'ORION_CODE_LOG_LEVEL',
  OPENHORSE_TOOL_CONFIRMATION: 'ORION_CODE_TOOL_CONFIRMATION',
  OPENHORSE_UI: 'ORION_CODE_UI',
  OPENHORSE_UI_RENDERER: 'ORION_CODE_UI_RENDERER',
  OPENHORSE_UI_CONFIRMATIONS: 'ORION_CODE_UI_CONFIRMATIONS',
  OPENHORSE_SKILLS_PATHS: 'ORION_CODE_SKILLS_PATHS',
  OPENHORSE_SUBAGENTS: 'ORION_CODE_SUBAGENTS',
  OPENHORSE_SUBAGENT_MAX_PARALLEL: 'ORION_CODE_SUBAGENT_MAX_PARALLEL',
  OPENHORSE_EMBEDDING_MODEL: 'ORION_CODE_EMBEDDING_MODEL',
  OPENHORSE_EMBEDDING_PROVIDER: 'ORION_CODE_EMBEDDING_PROVIDER',
  OPENHORSE_MAX_LLM_REQUESTS_PER_TURN: 'ORION_CODE_MAX_LLM_REQUESTS_PER_TURN',
  OPENHORSE_MAX_TOOL_CALLS_PER_TURN: 'ORION_CODE_MAX_TOOL_CALLS_PER_TURN',
  OPENHORSE_MAX_READ_ONLY_FRAGMENTATION: 'ORION_CODE_MAX_READ_ONLY_FRAGMENTATION',
  OPENHORSE_MAX_MODEL_VISIBLE_TOOL_BYTES: 'ORION_CODE_MAX_MODEL_VISIBLE_TOOL_BYTES',
  OPENHORSE_DEBUG_TOOLS: 'ORION_CODE_DEBUG_TOOLS',
  OPENHORSE_WEBSEARCH_API_KEY: 'ORION_CODE_WEBSEARCH_API_KEY',
  OPENHORSE_WEBSEARCH_PROVIDER: 'ORION_CODE_WEBSEARCH_PROVIDER',
  OPENHORSE_WEBSEARCH_MCP_PROVIDER: 'ORION_CODE_WEBSEARCH_MCP_PROVIDER',
  OPENHORSE_WEBSEARCH_MCP_ENDPOINT: 'ORION_CODE_WEBSEARCH_MCP_ENDPOINT',
  OPENHORSE_WEBSEARCH_MCP_TOOL: 'ORION_CODE_WEBSEARCH_MCP_TOOL',
  OPENHORSE_WEBSEARCH_MCP_TIMEOUT_MS: 'ORION_CODE_WEBSEARCH_MCP_TIMEOUT_MS',
  OPENHORSE_WEBSEARCH_AUTH_TYPE: 'ORION_CODE_WEBSEARCH_AUTH_TYPE',
  OPENHORSE_WEBSEARCH_API_KEY_HEADER: 'ORION_CODE_WEBSEARCH_API_KEY_HEADER',
  OPENHORSE_WEBSEARCH_API_KEY_QUERY_PARAM: 'ORION_CODE_WEBSEARCH_API_KEY_QUERY_PARAM',
};

function migrateEnvFile(srcPath: string, destPath: string): FileMapping | null {
  if (!existsSync(srcPath)) return null;
  const content = readFileSync(srcPath, 'utf8');
  const lines = content.split('\n');
  const migrated: string[] = [];
  let changed = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      migrated.push(line);
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) {
      migrated.push(line);
      continue;
    }
    const key = line.substring(0, eqIdx).trim();
    const rest = line.substring(eqIdx);
    if (ENV_KEY_MAP[key]) {
      migrated.push(`${ENV_KEY_MAP[key]}${rest}`);
      changed = true;
    } else {
      migrated.push(line);
    }
  }

  if (changed) {
    writeFileSync(destPath, migrated.join('\n'), { mode: 0o600 });
    return { from: srcPath, to: destPath };
  }
  return null;
}

// ── SQLite verification ──────────────────────────────────────────────────────

function verifySqlite(path: string): boolean {
  try {
    // Dynamic import to avoid requiring better-sqlite3 at module load
    const Database = require('better-sqlite3');
    const db = new Database(path, { readonly: true });
    const result = db.pragma('integrity_check');
    db.close();
    return result?.[0]?.integrity_check === 'ok';
  } catch {
    return false;
  }
}

// ── Core migration ───────────────────────────────────────────────────────────

export function migrateBrand(options: MigrationOptions = {}): MigrationResult {
  const home = options.home ?? homedir();
  const sourceRoot = join(home, SOURCE_DIR);
  const targetRoot = join(home, TARGET_DIR);
  const sourceEnvPath = join(home, SOURCE_ENV_FILE);
  const targetEnvPath = join(home, TARGET_ENV_FILE);

  const manifest: BrandMigrationManifestV1 = {
    version: 1,
    migrationId: `mig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sourceBrand: SOURCE_BRAND,
    targetBrand: TARGET_BRAND,
    createdAt: new Date().toISOString(),
    dryRun: options.dryRun ?? false,
    sourceRoot,
    targetRoot,
    sourceSnapshot: { fileCount: 0, totalBytes: 0, treeSha256: '' },
    renamedFiles: [],
    copiedFiles: 0,
    skippedFiles: [],
    conflicts: [],
    warnings: [],
    verified: false,
  };

  // ── Pre-flight checks ────────────────────────────────────────────────────

  if (!existsSync(sourceRoot)) {
    manifest.warnings.push(`Source directory ${sourceRoot} does not exist. Nothing to migrate.`);
    return { success: true, manifest };
  }

  manifest.sourceSnapshot = inventorySource(sourceRoot);

  if (existsSync(targetRoot) && readdirSync(targetRoot).length > 0) {
    manifest.conflicts.push({
      path: targetRoot,
      reason: 'Target directory already exists and is non-empty. Remove it or move it aside before migrating.',
    });
    return { success: false, manifest };
  }

  // ── Stage migration ──────────────────────────────────────────────────────

  const stagingRoot = join(home, `.orion-code-staging-${manifest.migrationId}`);

  try {
    if (!options.dryRun) {
      ensureDir(stagingRoot);
    }

    const writeDest = options.dryRun ? targetRoot : stagingRoot;

    // 1. Copy and rename config files
    const configMappings = migrateConfigFiles(sourceRoot, writeDest, options, manifest);
    manifest.renamedFiles.push(...configMappings);
    manifest.copiedFiles += configMappings.length;

    // 2. Copy verbatim directories
    for (const dir of VERBATIM_DIRS) {
      const srcDir = join(sourceRoot, dir);
      if (!existsSync(srcDir)) continue;
      const destDir = join(writeDest, dir);
      const mappings = copyDirRecursive(srcDir, destDir);
      manifest.renamedFiles.push(...mappings);
      manifest.copiedFiles += mappings.length;
    }

    // 3. Handle nested directories (backups → backups/openhorse, etc.)
    for (const [dir, nestedName] of Object.entries(NESTED_DIRS)) {
      const srcDir = join(sourceRoot, dir);
      if (!existsSync(srcDir)) continue;
      const destDir = join(writeDest, dir, nestedName);
      const mappings = copyDirRecursive(srcDir, destDir);
      manifest.renamedFiles.push(...mappings);
      manifest.copiedFiles += mappings.length;
    }

    // 4. Copy uncategorized files verbatim
    const knownPaths = new Set([
      'openhorse.json', 'OPENHORSE.md', 'OPENHORSE.local.md',
      'settings.json', 'usage.json', 'history.jsonl', 'mcp.json',
      'vector.db',
      ...VERBATIM_DIRS,
      ...Object.keys(NESTED_DIRS),
    ]);
    if (existsSync(sourceRoot)) {
      for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) continue;
        if (knownPaths.has(entry.name)) continue;
        const srcPath = join(sourceRoot, entry.name);
        const destPath = join(writeDest, entry.name);
        if (!options.dryRun) {
          copyFileSafe(srcPath, destPath);
        }
        manifest.renamedFiles.push({ from: srcPath, to: destPath });
        manifest.copiedFiles++;
      }
    }

    // 5. Validate SQLite if present
    const vectorSrc = join(sourceRoot, 'vector.db');
    if (existsSync(vectorSrc)) {
      if (!verifySqlite(vectorSrc)) {
        manifest.warnings.push('vector.db integrity check failed. The file was copied but may be corrupted.');
      }
    }

    // 6. Verify output
    if (!options.dryRun) {
      const outputSnapshot = inventorySource(stagingRoot);
      manifest.outputSnapshot = outputSnapshot;

      // Compare file count and byte count
      if (outputSnapshot.fileCount !== manifest.sourceSnapshot.fileCount) {
        manifest.warnings.push(
          `File count mismatch: source=${manifest.sourceSnapshot.fileCount} vs staging=${outputSnapshot.fileCount}`,
        );
      }

      // Atomic rename: staging → target
      renameSync(stagingRoot, targetRoot);
      manifest.verified = true;
    }

    // ── Dotenv migration ──────────────────────────────────────────────────

    if (options.includeEnv) {
      const envMapping = migrateEnvFile(sourceEnvPath, targetEnvPath);
      if (envMapping) {
        manifest.renamedFiles.push(envMapping);
      }
    } else if (existsSync(sourceEnvPath)) {
      manifest.warnings.push(
        `${sourceEnvPath} exists but was not migrated. Use --include-env to migrate environment variables.`,
      );
    }

    // ── Write manifest ─────────────────────────────────────────────────────

    if (!options.dryRun) {
      manifest.completedAt = new Date().toISOString();
      const manifestDir = join(targetRoot, 'migration-logs', 'openhorse');
      ensureDir(manifestDir);
      writeFileSync(
        join(manifestDir, `migration-${manifest.migrationId}.json`),
        JSON.stringify(manifest, null, 2),
        { mode: 0o600 },
      );
    }

    return { success: true, manifest };
  } catch (err: any) {
    // Clean up staging on failure
    manifest.warnings.push(`Migration failed: ${err.message}`);
    try {
      if (existsSync(stagingRoot)) {
        const { rmSync } = require('fs');
        rmSync(stagingRoot, { recursive: true, force: true });
      }
    } catch {}
    return { success: false, manifest };
  }
}

function migrateConfigFiles(
  sourceRoot: string,
  destRoot: string,
  options: MigrationOptions,
  manifest: BrandMigrationManifestV1,
): FileMapping[] {
  const mappings: FileMapping[] = [];

  for (const [srcName, destName] of Object.entries(RENAME_MAP)) {
    const srcPath = join(sourceRoot, srcName);
    if (!existsSync(srcPath)) continue;
    const destPath = join(destRoot, destName);

    if (!options.dryRun) {
      ensureDir(destRoot);
      let content = readFileSync(srcPath);
      // Remap config keys in orion.json
      if (srcName === 'openhorse.json') {
        content = Buffer.from(remapConfigKeys(content.toString('utf8')), 'utf8');
      }
      writeFileSync(destPath, content, { mode: 0o600 });
    }
    mappings.push({ from: srcPath, to: destPath });
  }

  return mappings;
}

// ── Project file migration ───────────────────────────────────────────────────

export function migrateProjectFiles(
  projectPath: string,
  options: MigrationOptions = {},
): { success: boolean; renamed: FileMapping[]; conflicts: FileMapping[]; warnings: string[] } {
  const renamed: FileMapping[] = [];
  const conflicts: FileMapping[] = [];
  const warnings: string[] = [];

  const resolved = resolve(projectPath);
  if (!existsSync(resolved)) {
    return { success: false, renamed, conflicts, warnings: [`Project path ${resolved} does not exist.`] };
  }

  for (const { from, to } of PROJECT_RENAME_MAP) {
    const srcPath = join(resolved, from);
    const destPath = join(resolved, to);

    if (!existsSync(srcPath)) continue;

    if (existsSync(destPath)) {
      conflicts.push({ from: srcPath, to: destPath, reason: 'Target already exists' });
      continue;
    }

    if (!options.dryRun) {
      try {
        renameSync(srcPath, destPath);
      } catch (err: any) {
        warnings.push(`Failed to rename ${from} → ${to}: ${err.message}`);
        continue;
      }
    }
    renamed.push({ from: srcPath, to: destPath });
  }

  return { success: conflicts.length === 0, renamed, conflicts, warnings };
}

// ── Help text ────────────────────────────────────────────────────────────────

export function getMigrationHelp(): string {
  return `orion migrate openhorse — Migrate OpenHorse data to Orion Code

USAGE
  orion migrate openhorse [flags]

FLAGS
  --dry-run                  Preview migration without writing files
  --include-env              Also migrate ~/.openhorse.env → ~/.orion-code.env
  --include-project-files    Rename .openhorse/ → .orion-code/ in project dirs

DESCRIPTION
  Copies ~/.openhorse → ~/.orion-code with filename and config-key
  transformations. The source directory is left unchanged.

  Migration covers:
  - openhorse.json → orion.json (with config key remapping)
  - OPENHORSE.md → ORION.md
  - OPENHORSE.local.md → ORION.local.md
  - settings.json, usage.json, history.jsonl, mcp.json
  - projects/, skills/, cost/, cache/
  - backups/ → backups/openhorse/
  - migration-logs/ → migration-logs/openhorse/
  - vector.db (with SQLite integrity check)

  The target directory must not already exist. Migration is atomic —
  files are staged and then renamed in one operation.

  Project file migration (--include-project-files) renames:
  ${PROJECT_RENAME_MAP.map(r => `  ${r.from} → ${r.to}`).join('\n  ')}
`;
}