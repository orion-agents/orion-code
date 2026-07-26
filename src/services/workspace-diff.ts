import { execFileSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { resolve } from 'path';

export interface WorkspaceDiffFile {
  path: string;
  status: string;
}

export interface WorkspaceDiffReport {
  isGitRepo: boolean;
  cwd: string;
  root?: string;
  branch?: string;
  clean: boolean;
  staged: WorkspaceDiffFile[];
  unstaged: WorkspaceDiffFile[];
  untracked: WorkspaceDiffFile[];
  stagedStat: string;
  unstagedStat: string;
  head?: string;
  error?: string;
}

export interface WorkspaceDiffOptions {
  cwd?: string;
  maxFiles?: number;
}

function runGit(args: string[], cwd: string): string {
  // core.quotepath=false makes git emit non-ASCII paths as UTF-8 instead of
  // C-style octal-escaped quoted strings (e.g. "uni\346\226\207.txt"), so the
  // returned paths are the real filenames usable on the filesystem.
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 8,
  }).trimEnd();
}

function tryGit(args: string[], cwd: string): string {
  try {
    return runGit(args, cwd);
  } catch {
    return '';
  }
}

/**
 * Unquote a git C-quoted path (e.g. `"a\"b"` -> `a"b`, `"uni\346\226.txt"` ->
 * the UTF-8 string). With core.quotepath=false git emits UTF-8 directly, but
 * paths containing `"`, `\`, or control chars are still C-quoted, so this
 * normalizes any remaining quoted form.
 */
function unquoteGitPath(path: string): string {
  if (path.length < 2 || path[0] !== '"' || path[path.length - 1] !== '"') return path;
  const inner = path.slice(1, -1);
  // Decode octal escapes (\NNN) and standard C escapes.
  return inner.replace(/\\(?:([0-7]{1,3})|(.))/g, (_, oct: string | undefined, ch: string | undefined) => {
    if (oct !== undefined) {
      return Buffer.from([parseInt(oct, 8)]).toString('utf8');
    }
    switch (ch) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '"': return '"';
      case '\\': return '\\';
      default: return ch ?? '';
    }
  });
}

function parseNameStatus(output: string): WorkspaceDiffFile[] {
  if (!output.trim()) return [];

  return output.split('\n')
    .filter(Boolean)
    .map(line => {
      const parts = line.split('\t');
      const status = parts[0] || '?';
      const rawPath = parts.length > 2 ? `${parts[1]} -> ${parts[2]}` : parts[1] || line.slice(status.length).trim();
      const path = parts.length > 2
        ? `${unquoteGitPath(parts[1])} -> ${unquoteGitPath(parts[2])}`
        : unquoteGitPath(rawPath);
      return { status, path };
    });
}

function parseUntracked(output: string): WorkspaceDiffFile[] {
  if (!output.trim()) return [];
  return output.split('\n')
    .filter(Boolean)
    .map(path => ({ status: '??', path: unquoteGitPath(path) }));
}

export function collectWorkspaceDiff(options: WorkspaceDiffOptions = {}): WorkspaceDiffReport {
  const cwd = resolve(options.cwd ?? process.cwd());
  const existingCwd = existsSync(cwd) ? realpathSync(cwd) : cwd;

  let root = '';
  try {
    root = runGit(['rev-parse', '--show-toplevel'], existingCwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isGitRepo: false,
      cwd: existingCwd,
      clean: true,
      staged: [],
      unstaged: [],
      untracked: [],
      stagedStat: '',
      unstagedStat: '',
      error: message,
    };
  }

  const branch = tryGit(['branch', '--show-current'], root) || tryGit(['rev-parse', '--short', 'HEAD'], root);
  const head = tryGit(['log', '--oneline', '-1'], root);
  const staged = parseNameStatus(tryGit(['diff', '--cached', '--name-status'], root));
  const unstaged = parseNameStatus(tryGit(['diff', '--name-status'], root));
  const untracked = parseUntracked(tryGit(['ls-files', '--others', '--exclude-standard'], root));
  const stagedStat = tryGit(['diff', '--cached', '--stat'], root);
  const unstagedStat = tryGit(['diff', '--stat'], root);

  return {
    isGitRepo: true,
    cwd: existingCwd,
    root,
    branch: branch || undefined,
    head: head || undefined,
    clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
    staged,
    unstaged,
    untracked,
    stagedStat,
    unstagedStat,
  };
}

function formatFileList(title: string, files: WorkspaceDiffFile[], maxFiles: number): string[] {
  const lines: string[] = [];
  lines.push(`${title}: ${files.length}`);
  for (const file of files.slice(0, maxFiles)) {
    lines.push(`  ${file.status.padEnd(3)} ${file.path}`);
  }
  if (files.length > maxFiles) {
    lines.push(`  ... ${files.length - maxFiles} more`);
  }
  return lines;
}

export function formatWorkspaceDiff(report: WorkspaceDiffReport, options: { maxFiles?: number } = {}): string {
  const maxFiles = options.maxFiles ?? 40;

  if (!report.isGitRepo) {
    return [
      'Workspace Diff',
      '─'.repeat(40),
      `CWD      ${report.cwd}`,
      'Status   not a git repository',
      report.error ? `Error    ${report.error}` : '',
    ].filter(Boolean).join('\n');
  }

  const lines: string[] = [
    'Workspace Diff',
    '─'.repeat(40),
    `Root     ${report.root}`,
    `Branch   ${report.branch || '(detached/unknown)'}`,
    report.head ? `HEAD     ${report.head}` : '',
    `Status   ${report.clean ? 'clean' : 'dirty'}`,
    '',
    ...formatFileList('Staged', report.staged, maxFiles),
    '',
    ...formatFileList('Unstaged', report.unstaged, maxFiles),
    '',
    ...formatFileList('Untracked', report.untracked, maxFiles),
  ].filter(line => line !== '');

  if (report.stagedStat) {
    lines.push('', 'Staged stat:', report.stagedStat);
  }
  if (report.unstagedStat) {
    lines.push('', 'Unstaged stat:', report.unstagedStat);
  }

  return lines.join('\n');
}
