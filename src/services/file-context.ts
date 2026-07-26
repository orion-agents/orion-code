import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'fs';
import { basename, isAbsolute, relative, resolve } from 'path';

export interface ReferencedFile {
  path: string;
  absolutePath: string;
  kind: 'file' | 'directory' | 'missing' | 'outside' | 'unreadable' | 'binary';
  sizeBytes?: number;
  content?: string;
  entries?: string[];
  truncated?: boolean;
  error?: string;
}

export interface FileContextOptions {
  maxMentions?: number;
  maxFileBytes?: number;
  maxTotalChars?: number;
  maxDirectoryEntries?: number;
}

const DEFAULT_MAX_MENTIONS = 8;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const DEFAULT_MAX_TOTAL_CHARS = 96_000;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 40;

const TRAILING_PUNCTUATION = /[),.;:!?，。；：！？）]+$/u;

export function extractFileMentions(input: string, maxMentions = DEFAULT_MAX_MENTIONS): string[] {
  const mentions: string[] = [];
  const seen = new Set<string>();
  const pattern = /(^|\s)@([^\s]+)/gu;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input)) !== null) {
    const cleaned = match[2].replace(TRAILING_PUNCTUATION, '');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    mentions.push(cleaned);
    if (mentions.length >= maxMentions) break;
  }

  return mentions;
}

function isInsideCwd(cwd: string, absolutePath: string): boolean {
  const rel = relative(cwd, absolutePath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveMentionPath(cwd: string, mention: string): { absolutePath: string; displayPath: string; outside: boolean } {
  const absolutePath = isAbsolute(mention) ? resolve(mention) : resolve(cwd, mention);
  const outside = !isInsideCwd(resolve(cwd), absolutePath);
  const displayPath = outside ? mention : relative(cwd, absolutePath) || basename(absolutePath);
  return { absolutePath, displayPath, outside };
}

function readUtf8Prefix(path: string, maxBytes: number): { content: string; sizeBytes: number; truncated: boolean; binary: boolean } {
  const fd = openSync(path, 'r');
  try {
    const sizeBytes = fstatSync(fd).size;
    const bytesToRead = Math.min(sizeBytes, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0)) {
      return { content: '', sizeBytes, truncated: sizeBytes > maxBytes, binary: true };
    }
    return {
      content: slice.toString('utf8'),
      sizeBytes,
      truncated: sizeBytes > maxBytes,
      binary: false,
    };
  } finally {
    closeSync(fd);
  }
}

function readDirectoryEntries(path: string, maxEntries: number): string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, maxEntries)
    .map(entry => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`);
}

export function collectReferencedFiles(input: string, cwd: string, options: FileContextOptions = {}): ReferencedFile[] {
  const maxMentions = options.maxMentions ?? DEFAULT_MAX_MENTIONS;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxDirectoryEntries = options.maxDirectoryEntries ?? DEFAULT_MAX_DIRECTORY_ENTRIES;
  const mentions = extractFileMentions(input, maxMentions);

  return mentions.map(mention => {
    const resolved = resolveMentionPath(cwd, mention);
    if (resolved.outside) {
      return {
        path: mention,
        absolutePath: resolved.absolutePath,
        kind: 'outside',
        error: 'Path is outside the current project and was not loaded.',
      };
    }

    if (!existsSync(resolved.absolutePath)) {
      return {
        path: resolved.displayPath,
        absolutePath: resolved.absolutePath,
        kind: 'missing',
        error: 'Path does not exist.',
      };
    }

    try {
      const stat = statSync(resolved.absolutePath);
      if (stat.isDirectory()) {
        return {
          path: resolved.displayPath,
          absolutePath: resolved.absolutePath,
          kind: 'directory',
          entries: readDirectoryEntries(resolved.absolutePath, maxDirectoryEntries),
        };
      }

      if (!stat.isFile()) {
        return {
          path: resolved.displayPath,
          absolutePath: resolved.absolutePath,
          kind: 'unreadable',
          error: 'Path is not a regular file.',
        };
      }

      const read = readUtf8Prefix(resolved.absolutePath, maxFileBytes);
      if (read.binary) {
        return {
          path: resolved.displayPath,
          absolutePath: resolved.absolutePath,
          kind: 'binary',
          sizeBytes: read.sizeBytes,
          truncated: read.truncated,
          error: 'Binary file was not loaded.',
        };
      }

      return {
        path: resolved.displayPath,
        absolutePath: resolved.absolutePath,
        kind: 'file',
        sizeBytes: read.sizeBytes,
        content: read.content,
        truncated: read.truncated,
      };
    } catch (error) {
      return {
        path: resolved.displayPath,
        absolutePath: resolved.absolutePath,
        kind: 'unreadable',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export function renderReferencedFiles(files: ReferencedFile[], options: FileContextOptions = {}): string {
  if (files.length === 0) return '';

  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  let remaining = maxTotalChars;
  const parts: string[] = [];

  for (const file of files) {
    if (remaining <= 0) break;

    let block = '';
    if (file.kind === 'file') {
      const content = file.content ?? '';
      block = [
        `### @${file.path}`,
        `Type: file${file.sizeBytes !== undefined ? `, size: ${file.sizeBytes} bytes` : ''}${file.truncated ? ', truncated' : ''}`,
        '~~~',
        content,
        '~~~',
      ].join('\n');
    } else if (file.kind === 'directory') {
      block = [
        `### @${file.path}`,
        'Type: directory',
        ...(file.entries ?? []).map(entry => `- ${entry}`),
      ].join('\n');
    } else {
      block = [
        `### @${file.path}`,
        `Type: ${file.kind}`,
        `Note: ${file.error ?? 'Not loaded.'}`,
      ].join('\n');
    }

    if (block.length > remaining) {
      block = `${block.slice(0, Math.max(0, remaining - 32))}\n[truncated by context budget]`;
      remaining = 0;
    } else {
      remaining -= block.length;
    }
    parts.push(block);
  }

  return `User-referenced files from the current input:\n${parts.join('\n\n')}`;
}

export function buildReferencedFilesPrompt(input: string, cwd: string, options: FileContextOptions = {}): string {
  return renderReferencedFiles(collectReferencedFiles(input, cwd, options), options);
}
