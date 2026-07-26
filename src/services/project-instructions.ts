import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';

export interface ProjectInstructionFile {
  path: string;
  absolutePath: string;
  content: string;
  truncated: boolean;
}

export interface ProjectInstructionOptions {
  maxFileBytes?: number;
  maxTotalChars?: number;
  root?: string;
}

const DEFAULT_MAX_FILE_BYTES = 32 * 1024;
const DEFAULT_MAX_TOTAL_CHARS = 96_000;

const DIRECT_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.orion-code/instructions.md',
  '.cursorrules',
];

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

function readTextPrefix(path: string, maxBytes: number): { content: string; truncated: boolean } | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    const content = readFileSync(path).subarray(0, maxBytes).toString('utf8');
    return {
      content,
      truncated: stat.size > maxBytes,
    };
  } catch {
    return null;
  }
}

function candidateFiles(dir: string): string[] {
  const files = DIRECT_FILES.map(file => join(dir, file));
  const cursorRulesDir = join(dir, '.cursor', 'rules');

  if (existsSync(cursorRulesDir)) {
    try {
      const ruleFiles = readdirSync(cursorRulesDir)
        .filter(file => file.endsWith('.md') || file.endsWith('.mdc'))
        .sort((a, b) => a.localeCompare(b))
        .map(file => join(cursorRulesDir, file));
      files.push(...ruleFiles);
    } catch {
      // Ignore unreadable rule directories.
    }
  }

  return files;
}

export function loadProjectInstructionFiles(cwd: string, options: ProjectInstructionOptions = {}): ProjectInstructionFile[] {
  const root = resolve(options.root ?? findProjectRoot(cwd));
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const files: ProjectInstructionFile[] = [];
  const seen = new Set<string>();

  for (const dir of directoriesFromRoot(root, cwd)) {
    for (const filePath of candidateFiles(dir)) {
      const absolutePath = resolve(filePath);
      if (seen.has(absolutePath) || !existsSync(absolutePath)) continue;
      seen.add(absolutePath);

      const read = readTextPrefix(absolutePath, maxFileBytes);
      if (!read || !read.content.trim()) continue;
      files.push({
        path: relative(root, absolutePath) || absolutePath,
        absolutePath,
        content: read.content.trimEnd(),
        truncated: read.truncated,
      });
    }
  }

  return files;
}

export function renderProjectInstructions(files: ProjectInstructionFile[], options: ProjectInstructionOptions = {}): string {
  if (files.length === 0) return '';

  let remaining = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const blocks: string[] = [];

  for (const file of files) {
    if (remaining <= 0) break;
    let block = [
      `## ${file.path}${file.truncated ? ' (truncated)' : ''}`,
      file.content,
    ].join('\n\n');

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

export function loadProjectInstructions(cwd: string, options: ProjectInstructionOptions = {}): string {
  return renderProjectInstructions(loadProjectInstructionFiles(cwd, options), options);
}
