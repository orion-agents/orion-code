import { existsSync, lstatSync, readdirSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { inspectSafeProjectPath, readSafeProjectFilePrefix } from './safe-project-reader';

export interface ProjectInstructionFile {
  path: string;
  absolutePath: string;
  content: string;
  truncated: boolean;
}

export interface ProjectInstructionOptions {
  maxFileBytes?: number;
  maxTotalChars?: number;
  maxTotalReadBytes?: number;
  maxFiles?: number;
  root?: string;
}

const DEFAULT_MAX_FILE_BYTES = 32 * 1024;
const DEFAULT_MAX_TOTAL_CHARS = 96_000;
const DEFAULT_MAX_TOTAL_READ_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 128;

const DIRECT_FILES = ['AGENTS.md', 'CLAUDE.md', '.orion-code/instructions.md', '.cursorrules'];

function parent(path: string): string {
  const next = dirname(path);
  return next === path ? path : next;
}

export function findProjectRoot(cwd: string): string {
  let current = resolve(cwd);

  while (true) {
    if (existsSync(join(current, '.git'))) {
      return current;
    }
    const next = parent(current);
    if (next === current) return resolve(cwd);
    current = next;
  }
}

function directoriesFromRoot(root: string, cwd: string): string[] {
  const resolvedRoot = resolve(root);
  let current = resolve(cwd);
  const dirs: string[] = [];

  while (true) {
    dirs.unshift(current);
    if (current === resolvedRoot) break;
    const next = parent(current);
    if (next === current) break;
    current = next;
  }

  return dirs.filter(dir => dir === resolvedRoot || !relative(resolvedRoot, dir).startsWith('..'));
}

function readTextPrefix(
  path: string,
  root: string,
  maxBytes: number
): { content: string; truncated: boolean } | null {
  const read = readSafeProjectFilePrefix(path, root, maxBytes);
  if (!read.ok || read.bytes.includes(0)) return null;
  return { content: read.bytes.toString('utf8'), truncated: read.truncated };
}

interface ProjectInstructionDiscovery {
  candidates: string[];
  watchPaths: string[];
}

function discoverProjectInstructionFiles(
  root: string,
  cwd: string,
  maxFiles: number
): ProjectInstructionDiscovery {
  const candidates: string[] = [];
  const watchPaths = new Set<string>([join(root, '.git')]);
  const addCandidate = (path: string): void => {
    watchPaths.add(path);
    if (candidates.length < maxFiles && existsSync(path)) candidates.push(path);
  };

  for (const dir of directoriesFromRoot(root, cwd)) {
    DIRECT_FILES.forEach(file => addCandidate(join(dir, file)));
    const cursorRulesDir = join(dir, '.cursor', 'rules');
    watchPaths.add(cursorRulesDir);
    const inspectedRulesDir = inspectSafeProjectPath(cursorRulesDir, root);
    if (!inspectedRulesDir.ok || !inspectedRulesDir.stats.isDirectory()) continue;
    try {
      for (const file of readdirSync(inspectedRulesDir.canonicalPath)
        .filter(file => file.endsWith('.md') || file.endsWith('.mdc'))
        .sort((a, b) => a.localeCompare(b))) {
        addCandidate(join(cursorRulesDir, file));
      }
    } catch {
      // Ignore unreadable rule directories.
    }
  }
  return { candidates, watchPaths: [...watchPaths] };
}

function loadDiscoveredFiles(
  root: string,
  discovery: ProjectInstructionDiscovery,
  options: ProjectInstructionOptions
): ProjectInstructionFile[] {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  let remainingReadBytes = options.maxTotalReadBytes ?? DEFAULT_MAX_TOTAL_READ_BYTES;
  const files: ProjectInstructionFile[] = [];
  const seen = new Set<string>();

  for (const filePath of discovery.candidates) {
    const absolutePath = resolve(filePath);
    if (seen.has(absolutePath) || remainingReadBytes <= 0) continue;
    seen.add(absolutePath);
    const readLimit = Math.min(maxFileBytes, remainingReadBytes);
    const read = readTextPrefix(absolutePath, root, readLimit);
    if (!read) continue;
    remainingReadBytes -= Buffer.byteLength(read.content, 'utf8');
    if (!read.content.trim()) continue;
    files.push({
      path: relative(root, absolutePath) || absolutePath,
      absolutePath,
      content: read.content.trimEnd(),
      truncated: read.truncated,
    });
  }
  return files;
}

export function loadProjectInstructionFiles(
  cwd: string,
  options: ProjectInstructionOptions = {}
): ProjectInstructionFile[] {
  const root = resolve(options.root ?? findProjectRoot(cwd));
  const discovery = discoverProjectInstructionFiles(
    root,
    cwd,
    options.maxFiles ?? DEFAULT_MAX_FILES
  );
  return loadDiscoveredFiles(root, discovery, options);
}

export function renderProjectInstructions(
  files: ProjectInstructionFile[],
  options: ProjectInstructionOptions = {}
): string {
  if (files.length === 0) return '';

  let remaining = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const blocks: string[] = [];

  for (const file of files) {
    if (remaining <= 0) break;
    let block = [`## ${file.path}${file.truncated ? ' (truncated)' : ''}`, file.content].join(
      '\n\n'
    );

    if (block.length > remaining) {
      block = `${block.slice(0, Math.max(0, remaining - 32))}\n[truncated by instruction budget]`;
      remaining = 0;
    } else {
      remaining -= block.length;
    }
    blocks.push(block);
  }

  return [
    'Project instructions loaded from repository guidance files.',
    'Apply these instructions for this project. Later sections are from more specific directories and override earlier sections when they conflict.',
    '',
    blocks.join('\n\n---\n\n'),
  ].join('\n');
}

export function loadProjectInstructions(
  cwd: string,
  options: ProjectInstructionOptions = {}
): string {
  const cacheKey = [
    resolve(cwd),
    options.root ? resolve(options.root) : 'auto',
    options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS,
    options.maxTotalReadBytes ?? DEFAULT_MAX_TOTAL_READ_BYTES,
    options.maxFiles ?? DEFAULT_MAX_FILES,
  ].join('|');
  const cached = projectInstructionCache.get(cacheKey);
  if (cached && watchFingerprint(cached.watchPaths) === cached.fingerprint) {
    return cached.content;
  }

  const root = resolve(options.root ?? findProjectRoot(cwd));
  const discovery = discoverProjectInstructionFiles(
    root,
    cwd,
    options.maxFiles ?? DEFAULT_MAX_FILES
  );
  const content = renderProjectInstructions(loadDiscoveredFiles(root, discovery, options), options);
  projectInstructionReloads += 1;
  projectInstructionCache.set(cacheKey, {
    content,
    watchPaths: discovery.watchPaths,
    fingerprint: watchFingerprint(discovery.watchPaths),
  });
  return content;
}

interface CachedProjectInstructions {
  content: string;
  watchPaths: string[];
  fingerprint: string;
}

const projectInstructionCache = new Map<string, CachedProjectInstructions>();
let projectInstructionReloads = 0;

function watchFingerprint(paths: string[]): string {
  return paths
    .map(path => {
      try {
        const stat = lstatSync(path);
        return `${path}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      } catch {
        return `${path}:missing`;
      }
    })
    .join('|');
}

export function clearProjectInstructionsCache(): void {
  projectInstructionCache.clear();
  projectInstructionReloads = 0;
}

/** Lightweight diagnostics used by doctor/tests without exposing cached content. */
export function getProjectInstructionsCacheStats(): { entries: number; reloads: number } {
  return { entries: projectInstructionCache.size, reloads: projectInstructionReloads };
}
