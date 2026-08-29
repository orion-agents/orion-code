import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from 'fs';
import { basename, isAbsolute, relative, resolve, sep } from 'path';
import { TextDecoder } from 'util';

import { isSensitiveFilePath, redactTraceText } from '../services/redaction';
import { WebWorkbenchError } from './errors';

const ROOT_NODE_ID = 'workspace-root';
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const DEFAULT_CONTENT_BYTES = 64 * 1024;
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_CURSOR_BYTES = 4096;
const IGNORED_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.orion',
  '.orion-code',
  'node_modules',
  'coverage',
  'dist',
  'build',
  'target',
]);

export type WebFileKindV1 = 'file' | 'directory' | 'symlink';

export interface WebFileNodeV1 {
  readonly id: string;
  readonly name: string;
  readonly kind: WebFileKindV1;
  readonly sizeBytes?: number;
  readonly modifiedAt: string;
  readonly sensitive: boolean;
  readonly readable: boolean;
}

export interface WebFileTreePageV1 {
  readonly parentId: string;
  readonly revision: string;
  readonly items: readonly WebFileNodeV1[];
  readonly nextCursor: string | null;
}

export interface WebFileContentPageV1 {
  readonly fileId: string;
  readonly name: string;
  readonly revision: string;
  readonly sizeBytes: number;
  readonly binary: boolean;
  readonly sensitive: boolean;
  readonly mediaType: 'text/plain' | 'application/octet-stream';
  readonly offsetBytes: number;
  readonly content?: string;
  readonly nextCursor: string | null;
}

interface CursorPayload {
  readonly version: 1;
  readonly kind: 'tree' | 'content';
  readonly nodeId: string;
  readonly revision: string;
  readonly offset: number;
}

interface ResolvedNode {
  readonly id: string;
  readonly relativePath: string;
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly stat: BigIntStats;
  readonly symlink: boolean;
}

/** Safe, lazy, read-only projection of one active Workspace filesystem. */
export class FileReadServiceV1 {
  private readonly root: string;
  private readonly secret = randomBytes(32);
  private readonly pathById = new Map<string, string>([[ROOT_NODE_ID, '']]);
  private readonly idByPath = new Map<string, string>([['', ROOT_NODE_ID]]);

  constructor(workspace: string) {
    this.root = canonicalDirectory(workspace);
  }

  get rootId(): string {
    return ROOT_NODE_ID;
  }

  identifyRelativePath(relativePath: string): string {
    const normalized = normalizeRelativePath(relativePath);
    this.resolveRelative(normalized);
    return this.remember(normalized);
  }

  list(
    input: {
      readonly parentId?: string;
      readonly cursor?: string;
      readonly pageSize?: number;
    } = {}
  ): WebFileTreePageV1 {
    const parentId = input.parentId ?? ROOT_NODE_ID;
    const pageSize = boundedPageSize(input.pageSize ?? DEFAULT_PAGE_SIZE);
    const parent = this.resolveNode(parentId);
    if (!parent.stat.isDirectory()) {
      throw new WebWorkbenchError(409, 'File node is not a directory.', 'file_not_directory');
    }
    const revision = fingerprintStat(parent.stat);
    const offset = input.cursor
      ? this.decodeCursor(input.cursor, 'tree', parentId, revision).offset
      : 0;
    const directory = opendirSync(parent.canonicalPath);
    const items: WebFileNodeV1[] = [];
    let visibleIndex = 0;
    let hasMore = false;
    try {
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        if (IGNORED_NAMES.has(entry.name)) continue;
        if (visibleIndex < offset) {
          visibleIndex += 1;
          continue;
        }
        if (items.length >= pageSize) {
          hasMore = true;
          break;
        }
        visibleIndex += 1;
        const childRelative = parent.relativePath
          ? `${parent.relativePath}/${entry.name}`
          : entry.name;
        items.push(this.projectNode(childRelative));
      }
    } finally {
      directory.closeSync();
    }
    const after = this.resolveNode(parentId);
    if (fingerprintStat(after.stat) !== revision) {
      throw new WebWorkbenchError(
        409,
        'Directory changed while it was being read.',
        'file_revision_conflict'
      );
    }
    return Object.freeze({
      parentId,
      revision,
      items: Object.freeze(items),
      nextCursor: hasMore
        ? this.encodeCursor({
            version: 1,
            kind: 'tree',
            nodeId: parentId,
            revision,
            offset: offset + items.length,
          })
        : null,
    });
  }

  readContent(input: {
    readonly fileId: string;
    readonly cursor?: string;
    readonly limitBytes?: number;
  }): WebFileContentPageV1 {
    const limitBytes = boundedContentBytes(input.limitBytes ?? DEFAULT_CONTENT_BYTES);
    const node = this.resolveNode(input.fileId);
    if (!node.stat.isFile()) {
      throw new WebWorkbenchError(409, 'File node is not a regular file.', 'file_not_regular');
    }
    const sensitive = isSensitiveFilePath(node.relativePath);
    if (sensitive) {
      throw new WebWorkbenchError(
        403,
        'Sensitive file content is not available in the Web Workbench.',
        'sensitive_file_blocked'
      );
    }
    const revision = fingerprintStat(node.stat);
    const offset = input.cursor
      ? this.decodeCursor(input.cursor, 'content', input.fileId, revision).offset
      : 0;
    if (offset > Number(node.stat.size)) {
      throw new WebWorkbenchError(409, 'File content cursor is stale.', 'file_revision_conflict');
    }
    const descriptor = openSync(node.canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(descriptor, { bigint: true });
      if (fingerprintStat(before) !== revision) {
        throw new WebWorkbenchError(
          409,
          'File changed before it was read.',
          'file_revision_conflict'
        );
      }
      const sample = Buffer.alloc(Math.min(8192, Number(before.size)));
      if (sample.length > 0) readSync(descriptor, sample, 0, sample.length, 0);
      const binary = isBinary(sample);
      if (binary) {
        return Object.freeze({
          fileId: input.fileId,
          name: basename(node.relativePath),
          revision,
          sizeBytes: Number(before.size),
          binary: true,
          sensitive: false,
          mediaType: 'application/octet-stream',
          offsetBytes: 0,
          nextCursor: null,
        });
      }
      const remaining = Math.max(0, Number(before.size) - offset);
      const page = readLineSafePage(descriptor, offset, remaining, limitBytes);
      const contentBuffer = validUtf8Prefix(page.content);
      if (page.consumedBytes > 0 && contentBuffer.length === 0) {
        throw new WebWorkbenchError(415, 'File is not valid UTF-8 text.', 'file_binary');
      }
      const nextOffset = offset + page.consumedBytes;
      const after = fstatSync(descriptor, { bigint: true });
      if (fingerprintStat(after) !== revision) {
        throw new WebWorkbenchError(
          409,
          'File changed while it was read.',
          'file_revision_conflict'
        );
      }
      return Object.freeze({
        fileId: input.fileId,
        name: basename(node.relativePath),
        revision,
        sizeBytes: Number(before.size),
        binary: false,
        sensitive: false,
        mediaType: 'text/plain',
        offsetBytes: offset,
        content: redactTraceText(new TextDecoder('utf-8', { fatal: true }).decode(contentBuffer)),
        nextCursor:
          nextOffset < Number(before.size)
            ? this.encodeCursor({
                version: 1,
                kind: 'content',
                nodeId: input.fileId,
                revision,
                offset: nextOffset,
              })
            : null,
      });
    } finally {
      closeSync(descriptor);
    }
  }

  private projectNode(relativePath: string): WebFileNodeV1 {
    const lexicalPath = resolve(this.root, relativePath);
    const lexicalStat = lstatSync(lexicalPath, { bigint: true });
    const symlink = lexicalStat.isSymbolicLink();
    let readable = true;
    let effectiveStat = lexicalStat;
    if (symlink) {
      try {
        const canonicalPath = realpathSync(lexicalPath);
        readable = isWithinRoot(canonicalPath, this.root);
        if (readable) effectiveStat = statSync(canonicalPath, { bigint: true });
      } catch {
        readable = false;
      }
    }
    return Object.freeze({
      id: this.remember(relativePath),
      name: basename(relativePath),
      kind: symlink ? 'symlink' : effectiveStat.isDirectory() ? 'directory' : 'file',
      ...(effectiveStat.isFile() ? { sizeBytes: Number(effectiveStat.size) } : {}),
      modifiedAt: new Date(Number(effectiveStat.mtimeMs)).toISOString(),
      sensitive: isSensitiveFilePath(relativePath),
      readable,
    });
  }

  private resolveNode(id: string): ResolvedNode {
    const relativePath = this.pathById.get(id);
    if (relativePath === undefined) {
      throw new WebWorkbenchError(404, 'File node was not found.', 'file_not_found');
    }
    return this.resolveRelative(relativePath, id);
  }

  private resolveRelative(relativePath: string, id = this.remember(relativePath)): ResolvedNode {
    const normalized = normalizeRelativePath(relativePath);
    const root = canonicalDirectory(this.root);
    const lexicalPath = resolve(root, normalized || '.');
    if (!isWithinRoot(lexicalPath, root)) {
      throw new WebWorkbenchError(
        403,
        'File node escaped the Workspace.',
        'file_outside_workspace'
      );
    }
    let canonicalPath: string;
    let lexicalStat: BigIntStats;
    try {
      lexicalStat = lstatSync(lexicalPath, { bigint: true });
      canonicalPath = realpathSync(lexicalPath);
    } catch {
      throw new WebWorkbenchError(404, 'File node no longer exists.', 'file_not_found');
    }
    if (!isWithinRoot(canonicalPath, root)) {
      throw new WebWorkbenchError(
        403,
        'Symbolic link points outside the active Workspace.',
        'file_outside_workspace'
      );
    }
    const stat = statSync(canonicalPath, { bigint: true });
    return Object.freeze({
      id,
      relativePath: normalized,
      lexicalPath,
      canonicalPath,
      stat,
      symlink: lexicalStat.isSymbolicLink(),
    });
  }

  private remember(relativePath: string): string {
    const normalized = normalizeRelativePath(relativePath);
    const existing = this.idByPath.get(normalized);
    if (existing) return existing;
    const id = `file_${createHmac('sha256', this.secret)
      .update(normalized)
      .digest('base64url')
      .slice(0, 32)}`;
    this.idByPath.set(normalized, id);
    this.pathById.set(id, normalized);
    return id;
  }

  private encodeCursor(payload: CursorPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  private decodeCursor(
    cursor: string,
    kind: CursorPayload['kind'],
    nodeId: string,
    revision: string
  ): CursorPayload {
    if (!cursor || cursor.length > MAX_CURSOR_BYTES) return invalidCursor();
    const [body, encodedSignature, extra] = cursor.split('.');
    if (!body || !encodedSignature || extra) return invalidCursor();
    const expected = createHmac('sha256', this.secret).update(body).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(encodedSignature, 'base64url');
    } catch {
      return invalidCursor();
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return invalidCursor();
    }
    try {
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CursorPayload;
      if (
        parsed.version !== 1 ||
        parsed.kind !== kind ||
        parsed.nodeId !== nodeId ||
        !Number.isSafeInteger(parsed.offset) ||
        parsed.offset < 0
      ) {
        return invalidCursor();
      }
      if (parsed.revision !== revision) {
        throw new WebWorkbenchError(
          409,
          'File cursor revision is stale.',
          'file_revision_conflict'
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof WebWorkbenchError) throw error;
      return invalidCursor();
    }
  }
}

function readLineSafePage(
  descriptor: number,
  offset: number,
  remaining: number,
  requestedBytes: number
): { readonly content: Buffer; readonly consumedBytes: number } {
  if (remaining === 0) return { content: Buffer.alloc(0), consumedBytes: 0 };
  // Redaction rules are label-aware. Never split a logical line across pages or a caller could
  // request `token=` and its value in separate pages. A line larger than the bounded service
  // budget fails closed instead of returning an unsafe fragment.
  const budget = Math.min(MAX_CONTENT_BYTES, remaining);
  const buffer = Buffer.alloc(budget);
  const bytesRead = readSync(descriptor, buffer, 0, budget, offset);
  const content = buffer.subarray(0, bytesRead);
  const target = Math.min(requestedBytes, bytesRead);
  const atEnd = offset + bytesRead >= offset + remaining;
  if (target === bytesRead && atEnd) return { content, consumedBytes: bytesRead };

  const lastNewline = content.lastIndexOf(0x0a, Math.max(0, target - 1));
  if (lastNewline >= 0) {
    const consumedBytes = lastNewline + 1;
    return { content: content.subarray(0, consumedBytes), consumedBytes };
  }
  const nextNewline = content.indexOf(0x0a, target);
  if (nextNewline >= 0) {
    const consumedBytes = nextNewline + 1;
    return { content: content.subarray(0, consumedBytes), consumedBytes };
  }
  if (atEnd) return { content, consumedBytes: bytesRead };
  throw new WebWorkbenchError(
    413,
    'A text line exceeds the safe Web preview limit.',
    'file_line_too_long'
  );
}

function canonicalDirectory(path: string): string {
  try {
    const canonical = realpathSync(resolve(path));
    if (!statSync(canonical).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch {
    throw new WebWorkbenchError(400, 'Workspace directory is unavailable.');
  }
}

function normalizeRelativePath(path: string): string {
  if (typeof path !== 'string' || path.includes('\0') || path.length > 4096 || isAbsolute(path)) {
    throw new WebWorkbenchError(400, 'File path is invalid.', 'file_path_invalid');
  }
  const normalized = path.replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new WebWorkbenchError(400, 'File path is invalid.', 'file_path_invalid');
  }
  return normalized === '.' ? '' : normalized;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function fingerprintStat(stat: BigIntStats): string {
  return createHash('sha256')
    .update(
      [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs]
        .map(value => value.toString())
        .join(':')
    )
    .digest('hex');
}

function boundedPageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new WebWorkbenchError(
      400,
      `pageSize must be an integer from 1 through ${MAX_PAGE_SIZE}.`
    );
  }
  return value;
}

function boundedContentBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONTENT_BYTES) {
    throw new WebWorkbenchError(
      400,
      `limitBytes must be an integer from 1 through ${MAX_CONTENT_BYTES}.`
    );
  }
  return value;
}

function isBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
}

function validUtf8Prefix(buffer: Buffer): Buffer {
  for (let trim = 0; trim <= Math.min(3, buffer.length); trim += 1) {
    const candidate = buffer.subarray(0, buffer.length - trim);
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(candidate);
      return candidate;
    } catch {
      // A bounded read may end inside one UTF-8 code point.
    }
  }
  return Buffer.alloc(0);
}

function invalidCursor(): never {
  throw new WebWorkbenchError(400, 'File cursor is invalid.', 'file_cursor_invalid');
}
