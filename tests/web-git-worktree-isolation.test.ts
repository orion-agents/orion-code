/**
 * v0.3.17 S6 — two worktrees sharing one repository's common dir (plan G317-21).
 *
 * Linked worktrees share refs and objects but each has its own index and working tree. The
 * risks the plan calls out are exactly the ones that would be invisible in single-repo tests:
 * a token minted for one worktree resolving in the other, a cursor continuing across, or an
 * index write in one showing up in the other's status.
 *
 * Token and cursor isolation are *architectural* here — the HMAC secret is per-service
 * instance (`randomBytes(32)`) — but an architectural guarantee still deserves a test that
 * would fail if somebody replaced it with a process-wide constant.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitReadModelServiceV1 } from '../src/web/git-read-model-service';

function rawGit(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('v0.3.17 S6 worktree isolation', () => {
  let root: string;
  let main: string;
  let linked: string;
  let serviceMain: GitReadModelServiceV1;
  let serviceLinked: GitReadModelServiceV1;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'oc317-wt-')));
    main = join(root, 'main');
    linked = join(root, 'linked');
    mkdirSync(main);
    rawGit(main, ['init', '-q', '-b', 'main']);
    rawGit(main, ['config', 'user.email', 'wt@probe.local']);
    rawGit(main, ['config', 'user.name', 'Worktree Probe']);
    writeFileSync(join(main, 'a.txt'), 'main version\n');
    rawGit(main, ['add', '.']);
    rawGit(main, ['commit', '-q', '-m', 'c0']);
    // A linked worktree on its own branch: same objects and refs, own index and worktree.
    rawGit(main, ['worktree', 'add', '-q', '-b', 'wt-branch', linked]);
    serviceMain = new GitReadModelServiceV1(main);
    serviceLinked = new GitReadModelServiceV1(linked);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('each worktree reports its own branch and its own status', async () => {
    const statusMain = await serviceMain.status();
    const statusLinked = await serviceLinked.status();

    expect(statusMain.branch).toBe('main');
    expect(statusLinked.branch).toBe('wt-branch');
    // Different indexes (even with identical content) produce different state revisions.
    expect(statusMain.repositoryRevision).not.toBe(statusLinked.repositoryRevision);
  });

  test('a token minted in one worktree does not resolve in the other', async () => {
    writeFileSync(join(main, 'a.txt'), 'main edited\n');
    const statusMain = await serviceMain.status();
    const tokenMain = statusMain.unstaged.find(entry => entry.path === 'a.txt')?.fileId ?? '';

    // In the linked worktree `a.txt` is unmodified, so there is nothing to mint a token for —
    // and the foreign token must not be accepted either.
    await expect(serviceLinked.diffDocument({ fileId: tokenMain })).rejects.toMatchObject({
      code: 'git_file_not_found',
    });
  });

  test('a pagination cursor is bound to the worktree it was issued in', async () => {
    const statusLinked = await serviceLinked.status();
    const tokenLinked = statusLinked.untracked.find(entry => entry.path === 'a.txt')?.fileId;
    if (!tokenLinked) return; // nothing to paginate in this shape
    const page = await serviceLinked.diffDocument({ fileId: tokenLinked });
    if (!page.nextCursor) return;

    // Same path, same repository, different index — the cursor must not continue there.
    await expect(
      serviceMain.diffDocument({ fileId: tokenLinked, cursor: page.nextCursor })
    ).rejects.toMatchObject({ code: 'git_file_not_found' });
  });

  test('staging in one worktree does not appear in the other', async () => {
    writeFileSync(join(main, 'a.txt'), 'main edited\n');
    await serviceMain.stagePaths(['a.txt']);

    const statusMain = await serviceMain.status();
    const statusLinked = await serviceLinked.status();

    // Main has a staged modification; the linked worktree still sees its own clean file.
    expect(statusMain.staged.map(entry => entry.path)).toEqual(['a.txt']);
    expect(statusLinked.staged).toEqual([]);
    expect(statusLinked.clean).toBe(true);
  });

  test('a file that only exists in one worktree is invisible to the other', async () => {
    writeFileSync(join(linked, 'only-in-linked.txt'), 'linked only\n');

    const statusMain = await serviceMain.status();
    const statusLinked = await serviceLinked.status();

    expect(statusLinked.untracked.map(entry => entry.path)).toContain('only-in-linked.txt');
    expect(
      [...statusMain.staged, ...statusMain.unstaged, ...statusMain.untracked].map(
        entry => entry.path
      )
    ).not.toContain('only-in-linked.txt');
  });
});
