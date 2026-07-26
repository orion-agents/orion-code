import { execFileSync } from 'child_process';
import { statSync } from 'fs';
import { join } from 'path';

export interface WorkspaceFileChange {
  path: string;
  status: string;
  sizeBytes?: number;
  mtimeMs?: number;
}

export interface WorkspaceSnapshot {
  gitAvailable: boolean;
  dirty: boolean;
  branch?: string;
  fileCount: number;
  files: WorkspaceFileChange[];
  error?: string;
}

export interface WorkspaceDelta {
  preExistingFiles: string[];
  filesAfterTurn: string[];
  newFilesByTurn: string[];
  changedByTurn: string[];
  modifiedPreExistingByTurn: string[];
  resolvedByTurn: string[];
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  }).trim();
}

function parsePorcelainLine(line: string): WorkspaceFileChange | null {
  if (line.length < 4) return null;
  const status = line.slice(0, 2).trim() || line.slice(0, 2);
  const rawPath = line.slice(2).trim();
  if (!rawPath) return null;

  const renameParts = rawPath.split(' -> ');
  const renameTarget = renameParts.length > 1 ? renameParts[renameParts.length - 1] : rawPath;

  return {
    status,
    path: renameTarget.replace(/^"|"$/g, ''),
  };
}

function attachFileMetadata(gitRoot: string, file: WorkspaceFileChange): WorkspaceFileChange {
  try {
    const stat = statSync(join(gitRoot, file.path));
    return {
      ...file,
      sizeBytes: stat.isFile() ? stat.size : undefined,
      mtimeMs: Math.floor(stat.mtimeMs),
    };
  } catch {
    return file;
  }
}

export function captureWorkspaceSnapshot(cwd: string): WorkspaceSnapshot {
  let gitRoot: string;
  try {
    gitRoot = runGit(cwd, ['rev-parse', '--show-toplevel']);
  } catch (error) {
    return {
      gitAvailable: false,
      dirty: false,
      fileCount: 0,
      files: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let branch: string | undefined;
  try {
    branch = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || undefined;
  } catch {
    branch = undefined;
  }

  try {
    const output = runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
    const files = output
      ? (output.split('\n').map(parsePorcelainLine).filter(Boolean) as WorkspaceFileChange[])
        .map(file => attachFileMetadata(gitRoot, file))
      : [];

    return {
      gitAvailable: true,
      dirty: files.length > 0,
      branch,
      fileCount: files.length,
      files,
    };
  } catch (error) {
    return {
      gitAvailable: true,
      dirty: false,
      branch,
      fileCount: 0,
      files: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function fileFingerprint(file: WorkspaceFileChange | undefined): string {
  if (!file) return '';
  return [
    file.status,
    file.path,
    file.sizeBytes ?? 'missing',
    file.mtimeMs ?? 'missing',
  ].join('\0');
}

export function diffWorkspaceSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceDelta {
  const beforeByPath = new Map(before.files.map(file => [file.path, file]));
  const afterByPath = new Map(after.files.map(file => [file.path, file]));
  const beforeSet = new Set(beforeByPath.keys());
  const afterSet = new Set(afterByPath.keys());

  const changedByTurn = [...afterSet]
    .filter(file => !beforeSet.has(file) || fileFingerprint(beforeByPath.get(file)) !== fileFingerprint(afterByPath.get(file)))
    .sort();

  return {
    preExistingFiles: [...beforeSet].sort(),
    filesAfterTurn: [...afterSet].sort(),
    newFilesByTurn: changedByTurn.filter(file => !beforeSet.has(file)).sort(),
    changedByTurn,
    modifiedPreExistingByTurn: changedByTurn.filter(file => beforeSet.has(file)).sort(),
    resolvedByTurn: [...beforeSet].filter(file => !afterSet.has(file)).sort(),
  };
}
