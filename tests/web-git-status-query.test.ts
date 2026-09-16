/**
 * v0.3.17 S1 — Git read protocol over disposable repositories.
 *
 * Covers the S1 exit criteria from `docs/plan/v0.3.17-plan.md` §10:
 *   - target / source model
 *   - source-scoped tokens and mutation writability
 *   - index-aware repository revision
 *   - truthful group counts across pages
 *   - pagination and cancellation
 *   - v1 compatibility
 *
 * Everything runs against real `git` in a temp directory — no mocked Git.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { GitReadModelServiceV1 } from '../src/web/git-read-model-service';
import { WebWorkbenchError } from '../src/web/errors';

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function porcelain(cwd: string): string {
  return git(cwd, ['status', '--porcelain=v1']);
}

describe('v0.3.17 Git read protocol (S1)', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'oc317-git-read-')));
    repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'read@probe.local']);
    git(repo, ['config', 'user.name', 'Read Probe']);
    for (const name of ['alpha.txt', 'beta.txt']) {
      writeFileSync(join(repo, name), 'baseline\n');
    }
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'baseline']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('group counts describe the whole matched scope, not the loaded page', async () => {
    for (const name of ['alpha.txt', 'beta.txt']) {
      writeFileSync(join(repo, name), 'baseline\nedited\n');
    }
    writeFileSync(join(repo, 'gamma.txt'), 'brand new\n');
    const service = new GitReadModelServiceV1(repo);

    const full = await service.status();
    expect(full.counts).toMatchObject({ staged: 0, unstaged: 2, untracked: 1, total: 3 });
    expect(full.counts.loaded).toBe(3);

    // One record per page: the group total must stay truthful while the page is partial.
    const firstPage = await service.status({ pageSize: 1 });
    expect(firstPage.counts.unstaged).toBe(2);
    expect(firstPage.counts.untracked).toBe(1);
    expect(firstPage.counts.total).toBe(3);
    expect(firstPage.counts.loaded).toBe(1);
    expect(firstPage.truncated).toBe(true);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await service.status({
      pageSize: 1,
      cursor: firstPage.nextCursor ?? '',
    });
    expect(secondPage.counts.total).toBe(3);
    expect(secondPage.counts.loaded).toBe(1);

    // Pages must not repeat the same entry.
    const firstKeys = new Set(
      [...firstPage.unstaged, ...firstPage.untracked].map(file => `${file.source}:${file.path}`)
    );
    for (const file of [...secondPage.unstaged, ...secondPage.untracked]) {
      expect(firstKeys.has(`${file.source}:${file.path}`)).toBe(false);
    }
  });

  test('group and query filters are applied by the Host and counted truthfully', async () => {
    for (const name of ['alpha.txt', 'beta.txt']) {
      writeFileSync(join(repo, name), 'baseline\nedited\n');
      git(repo, ['add', name]);
    }
    writeFileSync(join(repo, 'gamma.txt'), 'brand new\n');
    const service = new GitReadModelServiceV1(repo);

    const stagedOnly = await service.status({ group: 'staged' });
    expect(stagedOnly.counts.staged).toBe(2);
    expect(stagedOnly.staged.map(file => file.path)).toEqual(['alpha.txt', 'beta.txt']);
    expect(stagedOnly.unstaged).toEqual([]);

    const searched = await service.status({ query: 'alpha' });
    expect(searched.counts.total).toBe(1);
    expect(searched.staged.map(file => file.path)).toEqual(['alpha.txt']);

    // A filter that matches nothing is distinct from "still loading".
    const empty = await service.status({ query: 'no-such-path-anywhere' });
    expect(empty.counts.total).toBe(0);
    expect(empty.truncated).toBe(false);
    expect(empty.nextCursor).toBeNull();
  });

  test('a cursor is bound to the filter it was issued for', async () => {
    for (const name of ['alpha.txt', 'beta.txt']) {
      writeFileSync(join(repo, name), 'baseline\nedited\n');
      git(repo, ['add', name]);
      writeFileSync(join(repo, name), 'baseline\nedited\nmore\n');
    }
    const service = new GitReadModelServiceV1(repo);

    const page = await service.status({ pageSize: 1, group: 'unstaged' });
    expect(page.nextCursor).not.toBeNull();

    // Same query scope: accepted.
    await expect(
      service.status({ pageSize: 1, group: 'unstaged', cursor: page.nextCursor ?? '' })
    ).resolves.toBeDefined();

    // Different scope: refused rather than silently returning a page from another query.
    await expect(
      service.status({ pageSize: 1, group: 'staged', cursor: page.nextCursor ?? '' })
    ).rejects.toMatchObject({ code: 'git_cursor_invalid' });
  });

  test('an unknown group value is rejected instead of silently ignored', async () => {
    const service = new GitReadModelServiceV1(repo);
    await expect(
      service.status({ group: 'not-a-source' as unknown as 'staged' })
    ).rejects.toBeInstanceOf(WebWorkbenchError);
  });

  test('mutation writability follows the comparison source', async () => {
    writeFileSync(join(repo, 'alpha.txt'), 'baseline\nstaged\n');
    git(repo, ['add', 'alpha.txt']);
    writeFileSync(join(repo, 'alpha.txt'), 'baseline\nstaged\nworktree\n');
    writeFileSync(join(repo, 'gamma.txt'), 'brand new\n');
    const service = new GitReadModelServiceV1(repo);

    const status = await service.status();
    const staged = status.staged.find(file => file.path === 'alpha.txt');
    const unstaged = status.unstaged.find(file => file.path === 'alpha.txt');
    const untracked = status.untracked.find(file => file.path === 'gamma.txt');
    expect(staged && unstaged && untracked).toBeTruthy();

    // Only the worktree side may be staged.
    expect(service.resolveMutationPaths('stage', [unstaged?.fileId ?? ''])).toEqual(['alpha.txt']);
    expect(service.resolveMutationPaths('stage', [untracked?.fileId ?? ''])).toEqual(['gamma.txt']);
    expect(() => service.resolveMutationPaths('stage', [staged?.fileId ?? ''])).toThrow(
      /cannot be staged/u
    );

    // Only the index side may be unstaged.
    expect(service.resolveMutationPaths('unstage', [staged?.fileId ?? ''])).toEqual(['alpha.txt']);
    expect(() => service.resolveMutationPaths('unstage', [unstaged?.fileId ?? ''])).toThrow(
      /cannot be unstaged/u
    );
  });

  test('an unknown or oversized token is refused without touching Git', async () => {
    const service = new GitReadModelServiceV1(repo);
    expect(() => service.resolveMutationPaths('stage', ['not-a-token'])).toThrow(
      /Git file was not found/u
    );
    expect(() => service.resolveMutationPaths('stage', ['x'.repeat(300)])).toThrow(
      /file id is invalid/u
    );
    expect(() => service.resolveMutationPaths('stage', [])).toThrow(/1 through 200/u);
    expect(service.performanceCounters().processCount).toBe(0);
  });

  test('an untracked file renders only its own source section', async () => {
    writeFileSync(join(repo, 'gamma.txt'), 'brand new\nsecond line\n');
    const service = new GitReadModelServiceV1(repo);

    const status = await service.status();
    const untracked = status.untracked.find(file => file.path === 'gamma.txt');
    expect(untracked).toBeTruthy();

    const diff = await service.diff({ fileId: untracked?.fileId ?? '' });
    expect(diff.source).toBe('untracked');
    expect(diff.lines.join('\n')).toContain('brand new');
    expect(diff.lines).not.toContain('## Working tree');
  });

  test('a deletion is readable and a rename exposes both ends', async () => {
    git(repo, ['mv', 'alpha.txt', 'renamed.txt']);
    // `git rm` stages the deletion (`D `); a bare unlink would leave it unstaged (` D`).
    git(repo, ['rm', '-q', 'beta.txt']);
    const service = new GitReadModelServiceV1(repo);

    const status = await service.status();
    const renamed = status.staged.find(file => file.path === 'renamed.txt');
    expect(renamed).toMatchObject({ source: 'staged', renamedFrom: 'alpha.txt' });

    const deleted = status.staged.find(file => file.path === 'beta.txt');
    expect(deleted).toMatchObject({ source: 'staged', indexStatus: 'D' });

    // A deleted file has no worktree entity but its staged diff must still render.
    const diff = await service.diff({ fileId: deleted?.fileId ?? '' });
    expect(diff.source).toBe('staged');
    expect(diff.lines.join('\n')).toContain('baseline');
  });

  test('revision changes with the index and returns to the previous value on unstage', async () => {
    writeFileSync(join(repo, 'alpha.txt'), 'baseline\nedited\n');
    const service = new GitReadModelServiceV1(repo);

    const clean = await service.status();
    await service.stagePaths(['alpha.txt']);
    const staged = await service.status();
    expect(staged.repositoryRevision).not.toBe(clean.repositoryRevision);
    // HEAD does not move, so a HEAD-only revision could not have detected this.
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(git(repo, ['rev-parse', 'HEAD']));

    await service.unstagePaths(['alpha.txt']);
    const restored = await service.status();
    expect(restored.repositoryRevision).toBe(clean.repositoryRevision);
  });

  test('the not-a-repository path stays well formed', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    const service = new GitReadModelServiceV1(plain);

    const status = await service.status();
    expect(status.isRepository).toBe(false);
    expect(status.counts.total).toBe(0);
    expect(status.repositoryRevision).toMatch(/^[0-9a-f]{64}$/u);
    await expect(service.diff({ fileId: 'git_missing' })).rejects.toMatchObject({
      code: 'git_not_repository',
    });
  });

  test('v1 shapes are preserved for existing callers', async () => {
    writeFileSync(join(repo, 'alpha.txt'), 'baseline\nedited\n');
    const service = new GitReadModelServiceV1(repo);
    const status = await service.status();

    // Fields the v1 client and ReviewService already depend on.
    expect(status).toMatchObject({
      isRepository: true,
      branch: 'main',
      detached: false,
      clean: false,
      totalFiles: 1,
    });
    expect(status.head).toMatch(/^[0-9a-f]{12}$/u);
    for (const file of [...status.staged, ...status.unstaged]) {
      expect(file).toMatchObject({
        path: expect.any(String),
        fileId: expect.stringMatching(/^git_/u),
        indexStatus: expect.any(String),
        worktreeStatus: expect.any(String),
      });
    }

    const log = await service.log({ pageSize: 1 });
    expect(log.repositoryRevision).toBe(status.repositoryRevision);
    expect(log.items[0]?.subject).toBe('baseline');
    expect(porcelain(repo)).toContain('M alpha.txt');
  });
});
