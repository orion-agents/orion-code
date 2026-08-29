import { execFile, spawn } from 'child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { lstatSync, realpathSync, statSync } from 'fs';
import { basename, isAbsolute, relative, resolve, sep } from 'path';

import { redactTraceText } from '../services/redaction';
import { WebWorkbenchError } from './errors';

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_STATUS_PAGE_SIZE = 200;
const MAX_STATUS_PAGE_SIZE = 2_000;
const DEFAULT_LOG_PAGE_SIZE = 30;
const MAX_LOG_PAGE_SIZE = 100;
const DEFAULT_DIFF_LINES = 240;
const MAX_DIFF_LINES = 500;
const DEFAULT_DIFF_BYTES = 256 * 1024;
const MAX_DIFF_BYTES = 1024 * 1024;
const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

export interface WebGitFileV1 {
  readonly fileId: string;
  readonly path: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly renamedFrom?: string;
}

export interface WebGitStatusV1 {
  readonly isRepository: boolean;
  readonly repositoryRevision: string;
  readonly rootLabel?: string;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly head: string | null;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly clean: boolean;
  readonly staged: readonly WebGitFileV1[];
  readonly unstaged: readonly WebGitFileV1[];
  readonly untracked: readonly WebGitFileV1[];
  readonly conflicted: readonly WebGitFileV1[];
  readonly totalFiles: number;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export interface WebGitCommitV1 {
  readonly id: string;
  readonly shortId: string;
  readonly authoredAt: string;
  readonly authorName: string;
  readonly subject: string;
}

export interface WebGitLogPageV1 {
  readonly repositoryRevision: string;
  readonly items: readonly WebGitCommitV1[];
  readonly nextCursor: string | null;
}

export interface WebGitDiffPageV1 {
  readonly fileId: string;
  readonly path: string;
  readonly repositoryRevision: string;
  readonly binary: boolean;
  readonly lines: readonly string[];
  readonly nextCursor: string | null;
  readonly truncated: boolean;
}

interface GitStatusRecord {
  readonly path: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly renamedFrom?: string;
}

interface RepositorySnapshot {
  readonly isRepository: boolean;
  readonly root?: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly records: readonly GitStatusRecord[];
  readonly rawStatus: string;
  readonly revision: string;
}

interface CursorPayload {
  readonly version: 1;
  readonly kind: 'status' | 'log' | 'diff';
  readonly revision: string;
  readonly offset: number;
  readonly fileId?: string;
}

interface DiffCommand {
  readonly title: string;
  readonly args: readonly string[];
  readonly acceptedExitCodes?: readonly number[];
}

/** Bounded argv-only Git status/log/diff projection for one active Workspace. */
export class GitReadModelServiceV1 {
  private readonly workspace: string;
  private readonly secret = randomBytes(32);
  private readonly pathById = new Map<string, string>();
  private readonly idByPath = new Map<string, string>();

  constructor(workspace: string) {
    this.workspace = canonicalDirectory(workspace);
  }

  async status(
    input: {
      readonly cursor?: string;
      readonly pageSize?: number;
    } = {}
  ): Promise<WebGitStatusV1> {
    const snapshot = await this.capture();
    const pageSize = boundedInteger(
      input.pageSize ?? DEFAULT_STATUS_PAGE_SIZE,
      1,
      MAX_STATUS_PAGE_SIZE,
      'pageSize'
    );
    const offset = input.cursor
      ? this.decodeCursor(input.cursor, 'status', snapshot.revision).offset
      : 0;
    const records = snapshot.records.slice(offset, offset + pageSize);
    const projected = records.map(record => this.projectFile(record));
    const staged = projected.filter(
      file => file.indexStatus !== ' ' && file.indexStatus !== '?' && !isConflict(file)
    );
    const unstaged = projected.filter(
      file => file.worktreeStatus !== ' ' && file.worktreeStatus !== '?' && !isConflict(file)
    );
    const untracked = projected.filter(file => file.indexStatus === '?');
    const conflicted = projected.filter(isConflict);
    const nextOffset = offset + records.length;
    return Object.freeze({
      isRepository: snapshot.isRepository,
      repositoryRevision: snapshot.revision,
      ...(snapshot.root ? { rootLabel: basename(snapshot.root) } : {}),
      branch: snapshot.branch,
      detached: snapshot.isRepository && !snapshot.branch,
      head: snapshot.head ? snapshot.head.slice(0, 12) : null,
      upstream: snapshot.upstream,
      ahead: snapshot.ahead,
      behind: snapshot.behind,
      clean: snapshot.records.length === 0,
      staged: Object.freeze(staged),
      unstaged: Object.freeze(unstaged),
      untracked: Object.freeze(untracked),
      conflicted: Object.freeze(conflicted),
      totalFiles: snapshot.records.length,
      truncated: nextOffset < snapshot.records.length,
      nextCursor:
        nextOffset < snapshot.records.length
          ? this.encodeCursor({
              version: 1,
              kind: 'status',
              revision: snapshot.revision,
              offset: nextOffset,
            })
          : null,
    });
  }

  async log(
    input: {
      readonly cursor?: string;
      readonly pageSize?: number;
    } = {}
  ): Promise<WebGitLogPageV1> {
    const snapshot = await this.capture();
    if (!snapshot.isRepository || !snapshot.root || !snapshot.head) {
      return Object.freeze({
        repositoryRevision: snapshot.revision,
        items: Object.freeze([]),
        nextCursor: null,
      });
    }
    const pageSize = boundedInteger(
      input.pageSize ?? DEFAULT_LOG_PAGE_SIZE,
      1,
      MAX_LOG_PAGE_SIZE,
      'pageSize'
    );
    const offset = input.cursor
      ? this.decodeCursor(input.cursor, 'log', snapshot.revision).offset
      : 0;
    const raw = await this.runGit(
      [
        'log',
        `--skip=${offset}`,
        `--max-count=${pageSize + 1}`,
        '--format=%H%x1f%h%x1f%ct%x1f%an%x1f%s%x1e',
      ],
      snapshot.root
    );
    const commits = raw
      .split('\x1e')
      .map(record => record.replace(/^\s+/u, '').replace(/\s+$/u, ''))
      .filter(Boolean)
      .map(parseCommit);
    const hasMore = commits.length > pageSize;
    const items = commits.slice(0, pageSize);
    return Object.freeze({
      repositoryRevision: snapshot.revision,
      items: Object.freeze(items),
      nextCursor: hasMore
        ? this.encodeCursor({
            version: 1,
            kind: 'log',
            revision: snapshot.revision,
            offset: offset + items.length,
          })
        : null,
    });
  }

  async diff(input: {
    readonly fileId: string;
    readonly cursor?: string;
    readonly lineLimit?: number;
    readonly byteLimit?: number;
  }): Promise<WebGitDiffPageV1> {
    const snapshot = await this.capture();
    if (!snapshot.isRepository || !snapshot.root) {
      throw new WebWorkbenchError(404, 'Git repository is unavailable.', 'git_not_repository');
    }
    const path = this.pathById.get(input.fileId);
    if (!path) throw new WebWorkbenchError(404, 'Git file was not found.', 'git_file_not_found');
    const record = snapshot.records.find(candidate => candidate.path === path);
    if (!record) {
      throw new WebWorkbenchError(409, 'Git file changed before diff.', 'git_revision_conflict');
    }
    const lineLimit = boundedInteger(
      input.lineLimit ?? DEFAULT_DIFF_LINES,
      1,
      MAX_DIFF_LINES,
      'lineLimit'
    );
    const byteLimit = boundedInteger(
      input.byteLimit ?? DEFAULT_DIFF_BYTES,
      1024,
      MAX_DIFF_BYTES,
      'byteLimit'
    );
    const offset = input.cursor
      ? this.decodeCursor(input.cursor, 'diff', snapshot.revision, input.fileId).offset
      : 0;
    const commands = diffCommands(record, path);
    const page = await streamDiffPage({
      cwd: snapshot.root,
      commands,
      offset,
      lineLimit,
      byteLimit,
    });
    if (page.hasMore && page.returnedLines === 0) {
      throw new WebWorkbenchError(
        500,
        'Git diff pagination could not advance.',
        'git_pagination_stalled'
      );
    }
    const after = await this.capture();
    if (after.revision !== snapshot.revision) {
      throw new WebWorkbenchError(
        409,
        'Repository changed while reading diff.',
        'git_revision_conflict'
      );
    }
    const binary = page.lines.some(line => /^(?:Binary files |GIT binary patch)/u.test(line));
    const lines = binary ? page.lines.filter(line => !line.startsWith('literal ')) : page.lines;
    return Object.freeze({
      fileId: input.fileId,
      path: redactTraceText(path),
      repositoryRevision: snapshot.revision,
      binary,
      lines: Object.freeze(lines),
      nextCursor: page.hasMore
        ? this.encodeCursor({
            version: 1,
            kind: 'diff',
            revision: snapshot.revision,
            offset: offset + page.returnedLines,
            fileId: input.fileId,
          })
        : null,
      truncated: page.hasMore,
    });
  }

  private async capture(): Promise<RepositorySnapshot> {
    let root: string;
    try {
      root = realpathSync(
        (await this.runGit(['rev-parse', '--show-toplevel'], this.workspace)).trim()
      );
      if (!isWithinRoot(root, this.workspace)) throw new Error('repository root escaped workspace');
    } catch {
      const revision = createHash('sha256').update(`not-git:${this.workspace}`).digest('hex');
      return Object.freeze({
        isRepository: false,
        branch: null,
        head: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        records: Object.freeze([]),
        rawStatus: '',
        revision,
      });
    }
    const [rawStatus, branchResult, headResult, upstreamResult] = await Promise.all([
      this.runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root),
      this.tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], root),
      this.tryGit(['rev-parse', 'HEAD'], root),
      this.tryGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root),
    ]);
    const branch = branchResult?.trim() || null;
    const head = headResult?.trim() || null;
    const upstream = upstreamResult?.trim() || null;
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      const counts = await this.tryGit(
        ['rev-list', '--left-right', '--count', `HEAD...${upstream}`],
        root
      );
      const [aheadValue, behindValue] = (counts ?? '').trim().split(/\s+/u).map(Number);
      ahead = Number.isSafeInteger(aheadValue) ? aheadValue : 0;
      behind = Number.isSafeInteger(behindValue) ? behindValue : 0;
    }
    const records = parsePorcelainV1(rawStatus);
    const fileFingerprints = records.map(record => fingerprintWorktreePath(root, record.path));
    const revision = createHash('sha256')
      .update(
        JSON.stringify({
          root,
          branch,
          head,
          upstream,
          ahead,
          behind,
          rawStatus,
          fileFingerprints,
        })
      )
      .digest('hex');
    return Object.freeze({
      isRepository: true,
      root,
      branch,
      head,
      upstream,
      ahead,
      behind,
      records: Object.freeze(records),
      rawStatus,
      revision,
    });
  }

  private projectFile(record: GitStatusRecord): WebGitFileV1 {
    return Object.freeze({
      fileId: this.rememberPath(record.path),
      path: redactTraceText(record.path),
      indexStatus: record.indexStatus,
      worktreeStatus: record.worktreeStatus,
      ...(record.renamedFrom ? { renamedFrom: redactTraceText(record.renamedFrom) } : {}),
    });
  }

  private rememberPath(path: string): string {
    const existing = this.idByPath.get(path);
    if (existing) return existing;
    const id = `git_${createHmac('sha256', this.secret)
      .update(path)
      .digest('base64url')
      .slice(0, 32)}`;
    this.idByPath.set(path, id);
    this.pathById.set(id, path);
    return id;
  }

  private runGit(args: readonly string[], cwd: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      execFile(
        'git',
        [...hardenedGitPrefix(), ...args],
        {
          cwd,
          encoding: 'utf8',
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER,
          env: gitEnvironment(),
        },
        (error, stdout, stderr) => {
          if (error) {
            const processError = error as Error & {
              readonly code?: string;
              readonly killed?: boolean;
              readonly signal?: NodeJS.Signals;
            };
            const timedOut =
              processError.code === 'ETIMEDOUT' ||
              (processError.killed && processError.signal === 'SIGTERM');
            const outputTooLarge =
              processError.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
              /maxBuffer length exceeded/iu.test(processError.message);
            reject(
              new WebWorkbenchError(
                503,
                timedOut
                  ? 'Git command timed out.'
                  : outputTooLarge
                    ? 'Git output exceeded the bounded read limit.'
                    : redactTraceText(stderr || error.message || 'Git command failed.'),
                timedOut
                  ? 'git_timeout'
                  : outputTooLarge
                    ? 'git_output_too_large'
                    : 'git_command_failed'
              )
            );
            return;
          }
          resolvePromise(stdout);
        }
      );
    });
  }

  private async tryGit(args: readonly string[], cwd: string): Promise<string | undefined> {
    try {
      return await this.runGit(args, cwd);
    } catch {
      return undefined;
    }
  }

  private encodeCursor(payload: CursorPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  private decodeCursor(
    cursor: string,
    kind: CursorPayload['kind'],
    revision: string,
    fileId?: string
  ): CursorPayload {
    if (!cursor || cursor.length > 4096) return invalidCursor();
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
        parsed.fileId !== fileId ||
        !Number.isSafeInteger(parsed.offset) ||
        parsed.offset < 0
      ) {
        return invalidCursor();
      }
      if (parsed.revision !== revision) {
        throw new WebWorkbenchError(409, 'Git cursor revision is stale.', 'git_revision_conflict');
      }
      return parsed;
    } catch (error) {
      if (error instanceof WebWorkbenchError) throw error;
      return invalidCursor();
    }
  }
}

function parsePorcelainV1(output: string): GitStatusRecord[] {
  const fields = output.split('\0');
  const records: GitStatusRecord[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field || field.length < 4) continue;
    const indexStatus = field[0];
    const worktreeStatus = field[1];
    const path = field.slice(3);
    if (!safeGitPath(path)) continue;
    const renamed = indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R';
    const renamedFrom = renamed ? fields[++index] : undefined;
    records.push(
      Object.freeze({
        path,
        indexStatus,
        worktreeStatus,
        ...(renamedFrom && safeGitPath(renamedFrom) ? { renamedFrom } : {}),
      })
    );
  }
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

function safeGitPath(path: string): boolean {
  return (
    Boolean(path) &&
    path.length <= 4096 &&
    !path.includes('\0') &&
    !path.includes('\r') &&
    !path.includes('\n') &&
    !isAbsolute(path) &&
    path !== '..' &&
    !path.startsWith('../') &&
    !path.includes('/../')
  );
}

function isConflict(file: WebGitFileV1): boolean {
  return (
    file.indexStatus === 'U' ||
    file.worktreeStatus === 'U' ||
    `${file.indexStatus}${file.worktreeStatus}` === 'AA' ||
    `${file.indexStatus}${file.worktreeStatus}` === 'DD'
  );
}

function parseCommit(record: string): WebGitCommitV1 {
  const [id, shortId, timestamp, authorName, subject] = record.split('\x1f');
  if (!id || !shortId || !timestamp || !authorName || subject === undefined) {
    throw new WebWorkbenchError(502, 'Git log record is invalid.', 'git_output_invalid');
  }
  const authoredAt = new Date(Number(timestamp) * 1000);
  if (!Number.isFinite(authoredAt.valueOf())) {
    throw new WebWorkbenchError(502, 'Git log timestamp is invalid.', 'git_output_invalid');
  }
  return Object.freeze({
    id,
    shortId,
    authoredAt: authoredAt.toISOString(),
    authorName: redactTraceText(authorName),
    subject: redactTraceText(subject),
  });
}

function diffCommands(record: GitStatusRecord, path: string): DiffCommand[] {
  const commands: DiffCommand[] = [];
  if (isConflictRecord(record) || (record.indexStatus !== ' ' && record.indexStatus !== '?')) {
    commands.push({
      title: 'Staged',
      args: ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--unified=3', '--', path],
    });
  }
  if (
    isConflictRecord(record) ||
    (record.worktreeStatus !== ' ' && record.worktreeStatus !== '?')
  ) {
    commands.push({
      title: 'Working tree',
      args: ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', '--', path],
    });
  }
  if (record.indexStatus === '?') {
    commands.push({
      title: 'Untracked',
      args: [
        'diff',
        '--no-index',
        '--no-ext-diff',
        '--no-textconv',
        '--unified=3',
        '--',
        '/dev/null',
        path,
      ],
      acceptedExitCodes: [0, 1],
    });
  }
  return commands;
}

function isConflictRecord(record: GitStatusRecord): boolean {
  return (
    record.indexStatus === 'U' ||
    record.worktreeStatus === 'U' ||
    `${record.indexStatus}${record.worktreeStatus}` === 'AA' ||
    `${record.indexStatus}${record.worktreeStatus}` === 'DD'
  );
}

async function streamDiffPage(input: {
  readonly cwd: string;
  readonly commands: readonly DiffCommand[];
  readonly offset: number;
  readonly lineLimit: number;
  readonly byteLimit: number;
}): Promise<{
  readonly lines: string[];
  readonly returnedLines: number;
  readonly hasMore: boolean;
}> {
  const lines: string[] = [];
  let virtualLine = 0;
  let bytes = 0;
  let hasMore = false;
  let oversizedLine = false;
  const acceptLine = (raw: string): boolean => {
    const line = redactTraceText(raw.split(input.cwd).join('[WORKSPACE]'));
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (lineBytes > input.byteLimit) {
      oversizedLine = true;
      return false;
    }
    if (virtualLine < input.offset) {
      virtualLine += 1;
      return true;
    }
    if (lines.length >= input.lineLimit || bytes + lineBytes > input.byteLimit) {
      hasMore = true;
      return false;
    }
    lines.push(line);
    bytes += lineBytes;
    virtualLine += 1;
    return true;
  };

  for (const command of input.commands) {
    if (!acceptLine(`## ${command.title}`)) break;
    const completed = await streamGitLines({
      cwd: input.cwd,
      args: command.args,
      acceptedExitCodes: command.acceptedExitCodes ?? [0],
      onLine: acceptLine,
    });
    if (!completed) {
      hasMore = true;
      break;
    }
  }
  if (oversizedLine) {
    throw new WebWorkbenchError(
      413,
      'A Git diff line exceeds the bounded page size.',
      'git_line_too_long'
    );
  }
  return Object.freeze({ lines, returnedLines: lines.length, hasMore });
}

function streamGitLines(input: {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly acceptedExitCodes: readonly number[];
  readonly onLine: (line: string) => boolean;
}): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', [...hardenedGitPrefix(), ...input.args], {
      cwd: input.cwd,
      env: gitEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffer = '';
    let stderr = '';
    let outputBytes = 0;
    let paginationStopped = false;
    let timedOut = false;
    let outputTooLarge = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, GIT_TIMEOUT_MS);
    timer.unref();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (paginationStopped || timedOut || outputTooLarge) return;
      outputBytes += Buffer.byteLength(chunk, 'utf8');
      if (outputBytes > GIT_MAX_BUFFER) {
        outputTooLarge = true;
        buffer = '';
        clearTimeout(timer);
        child.kill('SIGTERM');
        return;
      }
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/u, '');
        buffer = buffer.slice(newline + 1);
        if (!input.onLine(line)) {
          paginationStopped = true;
          clearTimeout(timer);
          child.kill('SIGTERM');
          break;
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk, 'utf8');
      if (outputBytes > GIT_MAX_BUFFER && !outputTooLarge) {
        outputTooLarge = true;
        clearTimeout(timer);
        child.kill('SIGTERM');
      }
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        timedOut
          ? new WebWorkbenchError(503, 'Git command timed out.', 'git_timeout')
          : outputTooLarge
            ? new WebWorkbenchError(
                503,
                'Git output exceeded the bounded read limit.',
                'git_output_too_large'
              )
            : new WebWorkbenchError(503, redactTraceText(error.message), 'git_command_failed')
      );
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new WebWorkbenchError(503, 'Git command timed out.', 'git_timeout'));
        return;
      }
      if (outputTooLarge) {
        reject(
          new WebWorkbenchError(
            503,
            'Git output exceeded the bounded read limit.',
            'git_output_too_large'
          )
        );
        return;
      }
      if (!paginationStopped && buffer && !input.onLine(buffer)) paginationStopped = true;
      if (!paginationStopped && !input.acceptedExitCodes.includes(code ?? -1)) {
        reject(
          new WebWorkbenchError(
            503,
            redactTraceText(stderr || 'Git diff command failed.'),
            'git_command_failed'
          )
        );
        return;
      }
      resolvePromise(!paginationStopped);
    });
  });
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE,
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  };
}

function hardenedGitPrefix(): string[] {
  return [
    '-c',
    'core.quotepath=false',
    '-c',
    'core.fsmonitor=false',
    '-c',
    `core.hooksPath=${GIT_NULL_DEVICE}`,
    '-c',
    'log.showSignature=false',
    '--literal-pathspecs',
  ];
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

function fingerprintWorktreePath(root: string, path: string): readonly string[] {
  const candidate = resolve(root, path);
  if (!isWithinRoot(candidate, root)) return Object.freeze([path, 'outside']);
  try {
    const stat = lstatSync(candidate, { bigint: true });
    return Object.freeze([
      path,
      stat.dev.toString(),
      stat.ino.toString(),
      stat.mode.toString(),
      stat.size.toString(),
      stat.mtimeNs.toString(),
      stat.ctimeNs.toString(),
    ]);
  } catch {
    return Object.freeze([path, 'missing']);
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new WebWorkbenchError(400, `${name} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

function invalidCursor(): never {
  throw new WebWorkbenchError(400, 'Git cursor is invalid.', 'git_cursor_invalid');
}
