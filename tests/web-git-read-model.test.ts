import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { GitReadModelServiceV1 } from '../src/web/git-read-model-service';

describe('GitReadModelServiceV1', () => {
  let root: string;
  let workspace: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-web-git-'));
    workspace = join(root, 'workspace');
    mkdirSync(workspace);
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Orion Test']);
    git(['config', 'user.email', 'orion@example.invalid']);
    writeFileSync(join(workspace, 'tracked.txt'), 'baseline\n');
    git(['add', 'tracked.txt']);
    git(['commit', '-m', 'initial commit']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function git(args: readonly string[]): string {
    return execFileSync('git', args, {
      cwd: workspace,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
  }

  test('projects branch, HEAD and bounded commit history without remote credentials', async () => {
    git(['remote', 'add', 'origin', 'https://user:password@example.invalid/private/repo.git']);
    const service = new GitReadModelServiceV1(workspace);

    const status = await service.status();
    expect(status).toMatchObject({
      isRepository: true,
      rootLabel: 'workspace',
      branch: 'main',
      detached: false,
      clean: true,
      totalFiles: 0,
    });
    expect(status.head).toMatch(/^[0-9a-f]{12}$/u);
    expect(JSON.stringify(status)).not.toContain('password');

    const log = await service.log({ pageSize: 1 });
    expect(log.items).toEqual([
      expect.objectContaining({ authorName: 'Orion Test', subject: 'initial commit' }),
    ]);
    expect(log.repositoryRevision).toBe(status.repositoryRevision);
    expect(service.performanceCounters().processCount).toBeGreaterThan(0);
    expect(service.performanceCounters().bytesRead).toBeGreaterThan(0);
    expect(service.performanceCounters().itemsParsed).toBeGreaterThan(0);
  });

  test('separates staged, unstaged, untracked, rename and unicode status records', async () => {
    writeFileSync(join(workspace, 'rename-source.txt'), 'rename\n');
    git(['add', 'rename-source.txt']);
    git(['commit', '-m', 'add rename source']);
    git(['mv', 'rename-source.txt', 'renamed 文件.txt']);
    writeFileSync(join(workspace, 'tracked.txt'), 'staged\n');
    git(['add', 'tracked.txt']);
    writeFileSync(join(workspace, 'tracked.txt'), 'staged\nworking\n');
    writeFileSync(join(workspace, '新文件.txt'), 'unicode\n');
    const service = new GitReadModelServiceV1(workspace);

    const status = await service.status({ pageSize: 20 });
    expect(status.clean).toBe(false);
    expect(status.staged.map(file => file.path)).toEqual(
      expect.arrayContaining(['tracked.txt', 'renamed 文件.txt'])
    );
    expect(status.unstaged.map(file => file.path)).toContain('tracked.txt');
    expect(status.untracked.map(file => file.path)).toContain('新文件.txt');
    expect(status.staged.find(file => file.path === 'renamed 文件.txt')?.renamedFrom).toBe(
      'rename-source.txt'
    );
    expect(status.staged.every(file => file.fileId.startsWith('git_'))).toBe(true);
  });

  test('paginates redacted Diff lines and rejects continuation after repository drift', async () => {
    writeFileSync(
      join(workspace, 'tracked.txt'),
      `${Array.from({ length: 120 }, (_, index) => `line-${index}`).join('\n')}\ntoken=OPAQUE_GIT_SECRET\n`
    );
    const service = new GitReadModelServiceV1(workspace);
    const status = await service.status();
    const file = status.unstaged.find(candidate => candidate.path === 'tracked.txt')!;
    const first = await service.diff({ fileId: file.fileId, lineLimit: 20, byteLimit: 16 * 1024 });

    expect(first.lines).toHaveLength(20);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.truncated).toBe(true);
    expect(first.lines.join('\n')).not.toContain('OPAQUE_GIT_SECRET');
    const second = await service.diff({
      fileId: file.fileId,
      cursor: first.nextCursor ?? undefined,
      lineLimit: 500,
      byteLimit: 1024 * 1024,
    });
    expect(`${first.lines.join('\n')}\n${second.lines.join('\n')}`).toContain('[REDACTED_SECRET]');
    expect(second.lines.join('\n')).not.toContain('OPAQUE_GIT_SECRET');

    writeFileSync(join(workspace, 'tracked.txt'), 'repository drift\n');
    await expect(
      service.diff({ fileId: file.fileId, cursor: first.nextCursor ?? undefined })
    ).rejects.toMatchObject({ status: 409, code: 'git_revision_conflict' });
  });

  test('blocks tracked and untracked sensitive Diff content before it can be returned', async () => {
    const trackedMarker = 'SYNTHETIC_TRACKED_GIT_MARKER_41c9b7';
    const untrackedMarker = 'SYNTHETIC_UNTRACKED_GIT_MARKER_8a2f6d';
    writeFileSync(join(workspace, '.env'), 'committed-safe-value');
    git(['add', '.env']);
    git(['commit', '-m', 'add sensitive fixture']);
    writeFileSync(join(workspace, '.env'), trackedMarker);
    writeFileSync(join(workspace, 'credentials.json'), untrackedMarker);
    const service = new GitReadModelServiceV1(workspace);

    const status = await service.status();
    const tracked = status.unstaged.find(file => file.path === '.env')!;
    const untracked = status.untracked.find(file => file.path === 'credentials.json')!;

    expect(JSON.stringify(status)).not.toContain(trackedMarker);
    expect(JSON.stringify(status)).not.toContain(untrackedMarker);
    await expect(service.diff({ fileId: tracked.fileId })).rejects.toMatchObject({
      status: 403,
      code: 'sensitive_file_blocked',
    });
    await expect(service.diff({ fileId: untracked.fileId })).rejects.toMatchObject({
      status: 403,
      code: 'sensitive_file_blocked',
    });
  });

  test('blocks Diff when a safe current path was renamed from a sensitive path', async () => {
    const marker = 'SYNTHETIC_RENAMED_GIT_MARKER_96d3e1';
    writeFileSync(join(workspace, '.env'), marker);
    git(['add', '.env']);
    git(['commit', '-m', 'add sensitive rename fixture']);
    git(['mv', '.env', 'notes.txt']);
    const service = new GitReadModelServiceV1(workspace);

    const status = await service.status();
    const renamed = status.staged.find(file => file.path === 'notes.txt')!;

    expect(renamed.renamedFrom).toBe('.env');
    expect(JSON.stringify(status)).not.toContain(marker);
    await expect(service.diff({ fileId: renamed.fileId })).rejects.toMatchObject({
      status: 403,
      code: 'sensitive_file_blocked',
    });
  });

  test('advances every truncated Diff cursor monotonically', async () => {
    writeFileSync(
      join(workspace, 'tracked.txt'),
      `${Array.from({ length: 80 }, (_, index) => `monotonic-${index}`).join('\n')}\n`
    );
    const service = new GitReadModelServiceV1(workspace);
    const status = await service.status();
    const file = status.unstaged.find(candidate => candidate.path === 'tracked.txt')!;
    const offsets: number[] = [];
    let cursor: string | undefined;

    do {
      const page = await service.diff({
        fileId: file.fileId,
        ...(cursor ? { cursor } : {}),
        lineLimit: 7,
        byteLimit: 16 * 1024,
      });
      cursor = page.nextCursor ?? undefined;
      if (cursor) offsets.push(decodeCursorOffset(cursor));
    } while (cursor);

    expect(offsets.length).toBeGreaterThan(1);
    expect(new Set(offsets).size).toBe(offsets.length);
    for (let index = 1; index < offsets.length; index += 1) {
      expect(offsets[index]).toBeGreaterThan(offsets[index - 1]);
    }
  });

  test('rejects an over-budget Diff line with a stable 413 instead of a stalled cursor', async () => {
    writeFileSync(join(workspace, 'tracked.txt'), `${'x'.repeat(300 * 1024)}\n`);
    const service = new GitReadModelServiceV1(workspace);
    const status = await service.status();
    const file = status.unstaged.find(candidate => candidate.path === 'tracked.txt')!;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        service.diff({ fileId: file.fileId, lineLimit: 500, byteLimit: 256 * 1024 })
      ).rejects.toMatchObject({ status: 413, code: 'git_line_too_long' });
    }
  });

  test('shows binary and conflict states without returning binary payloads', async () => {
    writeFileSync(join(workspace, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
    const service = new GitReadModelServiceV1(workspace);
    const untracked = await service.status();
    const binaryFile = untracked.untracked.find(file => file.path === 'binary.dat')!;
    const binaryDiff = await service.diff({ fileId: binaryFile.fileId });
    expect(binaryDiff.binary).toBe(true);
    expect(binaryDiff.lines.join('\n')).not.toContain('\u0000');

    writeFileSync(join(workspace, 'conflict.txt'), 'base\n');
    git(['add', 'conflict.txt']);
    git(['commit', '-m', 'conflict base']);
    git(['checkout', '-b', 'other']);
    writeFileSync(join(workspace, 'conflict.txt'), 'other\n');
    git(['commit', '-am', 'other change']);
    git(['checkout', 'main']);
    writeFileSync(join(workspace, 'conflict.txt'), 'main\n');
    git(['commit', '-am', 'main change']);
    expect(() => git(['merge', 'other'])).toThrow();

    const conflicted = await service.status();
    expect(conflicted.conflicted.map(file => file.path)).toContain('conflict.txt');
  });

  test('treats a parent repository outside the active Workspace as unavailable', async () => {
    const nested = join(workspace, 'nested');
    mkdirSync(nested);
    const service = new GitReadModelServiceV1(nested);

    const status = await service.status();
    expect(status).toMatchObject({
      isRepository: false,
      clean: true,
    });
    expect(status).not.toHaveProperty('rootLabel');
  });

  test('reports detached HEAD explicitly', async () => {
    git(['checkout', '--detach', 'HEAD']);
    const service = new GitReadModelServiceV1(workspace);
    await expect(service.status()).resolves.toMatchObject({
      isRepository: true,
      branch: null,
      detached: true,
    });
  });

  test('never executes a repository-configured fsmonitor hook for status, log or diff', async () => {
    if (process.platform === 'win32') return;
    const sentinel = join(root, 'fsmonitor-executed');
    const hook = join(root, 'fsmonitor-hook');
    writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\nprintf '\\0'\n`, {
      mode: 0o700,
    });
    chmodSync(hook, 0o700);
    git(['config', 'core.fsmonitor', hook]);
    writeFileSync(join(workspace, 'tracked.txt'), 'changed without hook execution\n');
    const service = new GitReadModelServiceV1(workspace);

    const status = await service.status();
    await service.log();
    const file = status.unstaged.find(candidate => candidate.path === 'tracked.txt')!;
    await service.diff({ fileId: file.fileId });

    expect(existsSync(sentinel)).toBe(false);
  });

  test('reports a timed out streaming diff instead of disguising it as pagination', async () => {
    const restorePath = installFakeGit('timeout');
    try {
      const service = new GitReadModelServiceV1(workspace);
      const status = await service.status();
      const file = status.untracked[0];
      await expect(service.diff({ fileId: file.fileId })).rejects.toMatchObject({
        status: 503,
        code: 'git_timeout',
      });
    } finally {
      restorePath();
    }
  }, 15_000);

  test('rejects an unbroken diff that exceeds the bounded output budget', async () => {
    const restorePath = installFakeGit('overflow');
    try {
      const service = new GitReadModelServiceV1(workspace);
      const status = await service.status();
      const file = status.untracked[0];
      await expect(service.diff({ fileId: file.fileId })).rejects.toMatchObject({
        status: 503,
        code: 'git_output_too_large',
      });
    } finally {
      restorePath();
    }
  });

  function installFakeGit(mode: 'timeout' | 'overflow'): () => void {
    if (process.platform === 'win32') throw new Error('POSIX fake Git fixture is unavailable.');
    const bin = join(root, `fake-git-${mode}`);
    mkdirSync(bin);
    const executable = join(bin, 'git');
    writeFileSync(
      executable,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--show-toplevel')) process.stdout.write(${JSON.stringify(workspace)} + '\\n');
else if (args.includes('status')) process.stdout.write('?? slow.txt\\0');
else if (args.includes('symbolic-ref')) process.stdout.write('main\\n');
else if (args.includes('@{upstream}')) process.exitCode = 1;
else if (args.includes('rev-parse')) process.stdout.write('${'a'.repeat(40)}\\n');
else if (args.includes('diff')) {
  ${mode === 'timeout' ? 'setTimeout(() => undefined, 10_000);' : "process.stdout.write('x'.repeat(9 * 1024 * 1024));"}
}
`,
      { mode: 0o700 }
    );
    chmodSync(executable, 0o700);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ''}`;
    return () => {
      process.env.PATH = previous;
    };
  }
});

function decodeCursorOffset(cursor: string): number {
  const [body] = cursor.split('.');
  const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
    readonly offset: number;
  };
  return value.offset;
}
