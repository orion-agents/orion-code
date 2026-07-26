/**
 * orion code - File Checkpoints
 *
 * Before editing files, create recoverable snapshots so the user can
 * undo agent changes back to a specific turn.
 *
 * Storage: ~/.orion-code/projects/<project-key>/checkpoints/<turnId>/<file>
 * TTL: 7 days
 */

import * as fs from 'fs';
import * as path from 'path';
import { getProjectCheckpointsDir, getProjectSessionsDir } from '../services/config-dir';

export const CHECKPOINT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface CheckpointFile {
  path: string;
  content: string;
  sizeBytes: number;
  existed?: boolean;
}

export interface Checkpoint {
  turnId: string;
  createdAt: number;
  files: CheckpointFile[];
}

function getCheckpointDir(projectPath: string): string {
  const dir = getProjectCheckpointsDir(projectPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function getLegacyCheckpointDir(projectPath: string): string {
  return path.join(getProjectSessionsDir(projectPath), '_checkpoints');
}

function getTurnDir(projectPath: string, turnId: string): string {
  const base = getCheckpointDir(projectPath);
  return path.join(base, `${turnId}`);
}

function getExistingTurnDir(projectPath: string, turnId: string): string {
  const canonical = path.join(getProjectCheckpointsDir(projectPath), `${turnId}`);
  if (fs.existsSync(canonical)) return canonical;
  const legacy = path.join(getLegacyCheckpointDir(projectPath), `${turnId}`);
  if (fs.existsSync(legacy)) return legacy;
  return canonical;
}

function isInside(parentDir: string, candidatePath: string): boolean {
  const relative = path.relative(parentDir, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveCheckpointTarget(
  projectPath: string,
  filePath: string,
): { absolutePath: string; relativePath: string } | null {
  const projectRoot = path.resolve(projectPath);
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(projectRoot, filePath);
  if (!isInside(projectRoot, absolutePath)) return null;

  const relativePath = path.relative(projectRoot, absolutePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;
  return { absolutePath, relativePath };
}

function resolveCheckpointSourcePath(turnDir: string, relativePath: string): string | null {
  const checkpointPath = path.resolve(turnDir, safeFileName(relativePath));
  return isInside(path.resolve(turnDir), checkpointPath) ? checkpointPath : null;
}

/**
 * Create a checkpoint for the given files at the current state.
 * Files are saved individually so they can be restored independently.
 */
export function createCheckpoint(
  projectPath: string | undefined,
  turnId: string,
  filePaths: string[],
): Checkpoint | null {
  if (!projectPath || filePaths.length === 0) return null;

  const dir = getTurnDir(projectPath, turnId);
  if (fs.existsSync(dir)) return null; // Already exists

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const files: CheckpointFile[] = [];
  for (const filePath of filePaths) {
    try {
      const target = resolveCheckpointTarget(projectPath, filePath);
      if (!target) continue;

      if (!fs.existsSync(target.absolutePath)) {
        files.push({
          path: target.relativePath,
          content: '',
          sizeBytes: 0,
          existed: false,
        });
        continue;
      }

      const content = fs.readFileSync(target.absolutePath, 'utf8');
      const checkpointPath = resolveCheckpointSourcePath(dir, target.relativePath);
      if (!checkpointPath) continue;
      fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
      fs.writeFileSync(checkpointPath, content, { mode: 0o600 });

      files.push({
        path: target.relativePath,
        content: content.slice(0, 200), // Preview only
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        existed: true,
      });
    } catch {
      // Skip files that can't be read
    }
  }

  // Write checkpoint metadata
  const meta: Checkpoint = { turnId, createdAt: Date.now(), files };
  fs.writeFileSync(path.join(dir, '.checkpoint.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });

  return meta;
}

/**
 * Restore a checkpoint — overwrite current files with checkpointed content.
 * Returns the list of restored files.
 */
export function restoreCheckpoint(
  projectPath: string | undefined,
  turnId: string,
): { restored: string[]; error?: string } {
  if (!projectPath) return { restored: [], error: 'No project path' };

  const dir = getExistingTurnDir(projectPath, turnId);
  if (!fs.existsSync(dir)) {
    return { restored: [], error: `No checkpoint found for turn ${turnId}` };
  }

  const metaPath = path.join(dir, '.checkpoint.json');
  if (!fs.existsSync(metaPath)) {
    return { restored: [], error: 'Checkpoint metadata missing' };
  }

  let meta: Checkpoint;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return { restored: [], error: 'Checkpoint metadata corrupted' };
  }

  if (!Array.isArray(meta.files)) {
    return { restored: [], error: 'Checkpoint metadata missing files array' };
  }

  const restored: string[] = [];
  for (const file of meta.files) {
    const target = resolveCheckpointTarget(projectPath, file.path);
    if (!target) {
      return { restored, error: `Invalid checkpoint path: ${file.path}` };
    }
    const checkpointFile = resolveCheckpointSourcePath(dir, target.relativePath);
    if (!checkpointFile) {
      return { restored, error: `Invalid checkpoint source path: ${file.path}` };
    }
    try {
      if (file.existed === false) {
        if (fs.existsSync(target.absolutePath)) {
          const stat = fs.statSync(target.absolutePath);
          if (stat.isDirectory()) {
            return { restored, error: `Refusing to remove directory from checkpoint restore: ${file.path}` };
          }
          fs.rmSync(target.absolutePath, { force: true });
        }
        restored.push(target.relativePath);
        continue;
      }

      if (!fs.existsSync(checkpointFile)) continue;
      const content = fs.readFileSync(checkpointFile, 'utf8');
      fs.mkdirSync(path.dirname(target.absolutePath), { recursive: true });
      fs.writeFileSync(target.absolutePath, content, { mode: 0o600 });
      restored.push(target.relativePath);
    } catch {
      // Skip files that can't be restored
    }
  }

  return { restored };
}

/**
 * List available checkpoints for a project.
 */
export function listCheckpoints(projectPath: string | undefined): Checkpoint[] {
  if (!projectPath) return [];

  const dirs = [getCheckpointDir(projectPath), getLegacyCheckpointDir(projectPath)];

  const checkpointsByTurn = new Map<string, Checkpoint>();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const metaPath = path.join(dir, entry, '.checkpoint.json');
      if (fs.existsSync(metaPath)) {
        try {
          const checkpoint = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Checkpoint;
          if (!checkpointsByTurn.has(checkpoint.turnId)) {
            checkpointsByTurn.set(checkpoint.turnId, checkpoint);
          }
        } catch {
          // Skip corrupted metadata
        }
      }
    }
  }

  return Array.from(checkpointsByTurn.values()).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Clean up checkpoints older than the TTL (7 days).
 */
export function cleanupCheckpoints(projectPath: string | undefined): number {
  if (!projectPath) return 0;

  const dirs = [getCheckpointDir(projectPath), getLegacyCheckpointDir(projectPath)];

  let cleaned = 0;
  const now = Date.now();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (entry === '.checkpoint.json') continue; // Skip stray meta files

      const entryPath = path.join(dir, entry);
      try {
        const stat = fs.statSync(entryPath);
        if (!stat.isDirectory()) continue;

        // Check the meta file's mtime
        const metaPath = path.join(entryPath, '.checkpoint.json');
        if (fs.existsSync(metaPath)) {
          const metaStat = fs.statSync(metaPath);
          if (now - metaStat.mtimeMs > CHECKPOINT_TTL_MS) {
            fs.rmSync(entryPath, { recursive: true, force: true });
            cleaned++;
          }
        }
      } catch {
        // Skip entries that can't be accessed
      }
    }
  }

  return cleaned;
}

function safeFileName(filePath: string): string {
  // Replace problematic characters in file names for safe storage
  return filePath.replace(/[<>:"|?*]/g, '_');
}

/**
 * Returns true when a single turn modifies enough files to warrant an explicit
 * risky-edit checkpoint with rollback guidance. Wired into createPreToolCheckpoint
 * in chat-controller.ts, which marks the trace note 'risky_multi_file_checkpoint'
 * and emits a user-visible rollback hint.
 */
export function shouldCreateMultiFileCheckpoint(changedFileCount: number, threshold = 5): boolean {
  return changedFileCount >= threshold;
}
