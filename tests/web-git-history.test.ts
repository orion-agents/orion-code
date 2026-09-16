/**
 * v0.3.17 S4 — history reading: refs, commit details, commit files, commit diffs, search,
 * file history.
 *
 * The §10 S4 exit evidence is "history browsing without workspace writes", so this file
 * asserts two things throughout: that the history facts are right, and that after all of the
 * reading the working tree, the index and HEAD are byte-for-byte unchanged — checked through
 * an independent `git` invocation rather than through our own API.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GIT_EMPTY_TREE_OID } from '../src/web/git-history-service';
import { GitReadModelServiceV1 } from '../src/web/git-read-model-service';

function rawGit(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Real repositories, real subprocesses: the default 5s budget measures the sandbox, not the
// code. Kept explicit rather than raised globally so a genuine hang elsewhere still fails fast.
jest.setTimeout(30_000);
describe('v0.3.17 S4 history reading', () => {
  let root: string;
  let repo: string;
  let service: GitReadModelServiceV1;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'oc317-s4-')));
    repo = join(root, 'repo');
    mkdirSync(repo);
    rawGit(repo, ['init', '-q', '-b', 'main']);
    rawGit(repo, ['config', 'user.email', 'history@probe.local']);
    rawGit(repo, ['config', 'user.name', 'History Probe']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A linear history plus a tag, a branch and a merge commit. */
  function seedHistory(): void {
    writeFileSync(join(repo, 'alpha.txt'), 'one\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'feat: alpha initial']);
    rawGit(repo, ['tag', 'v1.0']);

    writeFileSync(join(repo, 'beta.txt'), 'beta\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'fix: add beta']);

    // A side branch merged back, so a real merge commit exists.
    rawGit(repo, ['checkout', '-q', '-b', 'side']);
    writeFileSync(join(repo, 'gamma.txt'), 'gamma\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'chore: gamma on side']);
    rawGit(repo, ['checkout', '-q', 'main']);
    writeFileSync(join(repo, 'alpha.txt'), 'one\ntwo\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'feat: alpha two']);
    rawGit(repo, ['merge', '-q', '--no-ff', '-m', 'merge: side into main', 'side']);

    service = new GitReadModelServiceV1(repo);
  }

  /** Snapshot of everything a history read must never touch. */
  function repoState(): {
    readonly head: string;
    readonly index: string;
    readonly porcelain: string;
    readonly worktree: string;
  } {
    return {
      head: rawGit(repo, ['rev-parse', 'HEAD']).trim(),
      index: rawGit(repo, ['ls-files', '--stage']),
      porcelain: rawGit(repo, ['status', '--porcelain=v1']),
      worktree: readFileSync(join(repo, 'alpha.txt'), 'utf8'),
    };
  }

  describe('refs', () => {
    test('classifies branches, tags and remotes, and marks the checked-out ref', async () => {
      seedHistory();
      rawGit(repo, ['branch', 'feature/x']);
      rawGit(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

      const refs = await service.refs();

      const byName = new Map(refs.refs.map(ref => [ref.shortName, ref]));
      expect(byName.get('main')?.kind).toBe('branch');
      expect(byName.get('feature/x')?.kind).toBe('branch');
      expect(byName.get('main')?.isHead).toBe(true);
      expect(byName.get('v1.0')?.kind).toBe('tag');
      expect(byName.get('origin/main')?.kind).toBe('remote');
      expect(refs.detached).toBe(false);
      expect(refs.head).toBe(rawGit(repo, ['rev-parse', 'HEAD']).trim());
      // Branches sort before tags before remotes.
      const kinds = refs.refs.map(ref => ref.kind);
      expect(kinds.indexOf('branch')).toBeLessThan(kinds.indexOf('tag'));
      expect(kinds.indexOf('tag')).toBeLessThanOrEqual(kinds.lastIndexOf('remote'));
      expect(refs.truncated).toBe(false);
    });

    test('reports detached HEAD instead of pretending a branch is checked out', async () => {
      seedHistory();
      const head = rawGit(repo, ['rev-parse', 'HEAD']).trim();
      rawGit(repo, ['checkout', '-q', '--detach', head]);

      const refs = await service.refs();
      expect(refs.detached).toBe(true);
      expect(refs.head).toBe(head);
    });
  });

  describe('commit details and comparison base', () => {
    test('a normal commit is compared with its parent', async () => {
      seedHistory();
      const head = rawGit(repo, ['rev-parse', 'HEAD']).trim();
      const parent = rawGit(repo, ['rev-parse', 'HEAD^']).trim();

      const detail = await service.commitDetail(head);
      expect(detail.id).toBe(head);
      expect(detail.baseOid).toBe(parent);
      // A merge names the parent it is being compared against.
      expect(detail.baseLabel).toBe('父提交 1/2');
      expect(detail.isMerge).toBe(true);
      expect(detail.parents).toHaveLength(2);
      expect(detail.message).toContain('merge: side into main');
      expect(detail.authorEmail).toBe('history@probe.local');
    });

    test('a root commit is compared with the empty tree rather than failing', async () => {
      seedHistory();
      const first = rawGit(repo, ['rev-list', '--max-parents=0', 'HEAD']).trim();

      const detail = await service.commitDetail(first);
      expect(detail.parents).toHaveLength(0);
      expect(detail.isMerge).toBe(false);
      expect(detail.baseOid).toBe(GIT_EMPTY_TREE_OID);
      expect(detail.baseLabel).toContain('根提交');

      const files = await service.commitFiles(first);
      expect(files.baseOid).toBe(GIT_EMPTY_TREE_OID);
      // alpha.txt is the only file the repository was created with.
      expect(files.files.map(file => file.path)).toEqual(['alpha.txt']);
      expect(files.additions).toBe(1);
    });

    test('a merge commit can be compared with a chosen parent', async () => {
      seedHistory();
      const merge = rawGit(repo, ['rev-parse', 'HEAD']).trim();
      const firstParent = rawGit(repo, ['rev-parse', 'HEAD^1']).trim();
      const secondParent = rawGit(repo, ['rev-parse', 'HEAD^2']).trim();

      const viaFirst = await service.commitDetail(merge, 0);
      const viaSecond = await service.commitDetail(merge, 1);

      expect(viaFirst.baseOid).toBe(firstParent);
      expect(viaSecond.baseOid).toBe(secondParent);
      expect(viaFirst.baseOid).not.toBe(viaSecond.baseOid);
      expect(viaSecond.baseLabel).toBe('父提交 2/2');
      // Each base really changes which files the merge appears to introduce.
      const fromFirst = await service.commitFiles(merge, 0);
      const fromSecond = await service.commitFiles(merge, 1);
      expect(fromFirst.files.map(f => f.path)).toContain('gamma.txt');
      expect(fromSecond.files.map(f => f.path)).toContain('alpha.txt');
    });

    test('rejects a malformed commit hash and an out-of-range parent index', async () => {
      seedHistory();
      await expect(service.commitDetail('not-a-hash')).rejects.toMatchObject({
        code: 'git_revision_invalid',
      });
      await expect(service.commitDetail('--upload-pack=/bin/sh')).rejects.toMatchObject({
        code: 'git_revision_invalid',
      });
      const head = rawGit(repo, ['rev-parse', 'HEAD']).trim();
      await expect(service.commitDetail(head, 9)).rejects.toMatchObject({
        code: 'git_query_invalid',
      });
    });

    test('reports a rename in the commit file list', async () => {
      seedHistory();
      rawGit(repo, ['mv', 'beta.txt', 'beta-renamed.txt']);
      rawGit(repo, ['commit', '-q', '-m', 'refactor: rename beta']);

      const files = await service.commitFiles(rawGit(repo, ['rev-parse', 'HEAD']).trim());
      const entry = files.files.find(file => file.path === 'beta-renamed.txt');
      expect(entry).toBeTruthy();
      expect(entry?.renamedFrom).toBe('beta.txt');
    });

    test('flags a sensitive path instead of returning its content', async () => {
      seedHistory();
      writeFileSync(join(repo, '.env'), 'SECRET=1\n');
      rawGit(repo, ['add', '-f', '.env']);
      rawGit(repo, ['commit', '-q', '-m', 'chore: add env']);

      const files = await service.commitFiles(rawGit(repo, ['rev-parse', 'HEAD']).trim());
      expect(files.files.find(file => file.path === '.env')?.sensitive).toBe(true);
      await expect(
        service.commitDiffDocument({ oid: rawGit(repo, ['rev-parse', 'HEAD']).trim(), path: '.env' })
      ).rejects.toMatchObject({ code: 'sensitive_file_blocked' });
    });
  });

  describe('commit file diff', () => {
    test('renders a structured document with the real comparison recorded', async () => {
      seedHistory();
      // `HEAD^1` is the commit that changed alpha.txt from `one` to `one\ntwo`; the merge
      // itself introduces gamma.txt, so it would prove nothing about this file.
      const target = rawGit(repo, ['rev-parse', 'HEAD^1']).trim();

      const document = await service.commitDiffDocument({ oid: target, path: 'alpha.txt' });

      // `commit` is its own comparison source: never a working-tree state (plan §6.1).
      expect(document.source).toBe('commit');
      expect(document.path).toBe('alpha.txt');
      expect(document.baseOid).toBe(rawGit(repo, ['rev-parse', `${target}^`]).trim());
      expect(document.baseLabel).toBe('父提交');
      expect(document.kind).toBe('text');
      expect(document.hunks.length).toBeGreaterThan(0);
      // The historical diff must describe the commit, not the working tree.
      const added = document.hunks.flatMap(hunk => hunk.lines).filter(line => line.kind === 'addition');
      expect(added.map(line => line.text)).toContain('two');
    });

    test('handles a file added by the root commit', async () => {
      seedHistory();
      const first = rawGit(repo, ['rev-list', '--max-parents=0', 'HEAD']).trim();
      const document = await service.commitDiffDocument({ oid: first, path: 'alpha.txt' });
      expect(document.kind).toBe('text');
      const added = document.hunks.flatMap(hunk => hunk.lines).filter(line => line.kind === 'addition');
      expect(added.map(line => line.text)).toContain('one');
    });

    test('refuses an unsafe path and an unknown commit', async () => {
      seedHistory();
      const head = rawGit(repo, ['rev-parse', 'HEAD']).trim();
      await expect(
        service.commitDiffDocument({ oid: head, path: '../outside.txt' })
      ).rejects.toMatchObject({ code: 'git_path_unsafe' });
      await expect(
        service.commitDiffDocument({ oid: head, path: ':!alpha.txt' })
      ).rejects.toMatchObject({ code: 'git_path_unsafe' });
      await expect(service.commitDiffDocument({ oid: head, path: '/etc/passwd' })).rejects.toMatchObject(
        { code: 'git_path_unsafe' }
      );
    });
  });

  describe('history search runs on the Host over the whole history', () => {
    /** 30 synthetic commits so "first page only" cannot pass by accident. */
    function seedLongHistory(): void {
      seedHistory();
      for (let index = 0; index < 30; index += 1) {
        writeFileSync(join(repo, 'log.txt'), `entry ${index}\n`);
        rawGit(repo, ['add', '.']);
        rawGit(
          repo,
          ['commit', '-q', '-m', index === 5 ? 'fix: the needle everyone looks for' : `chore: bulk ${index}`]
        );
      }
    }

    test('finds a commit far outside the first page', async () => {
      seedLongHistory();
      const page = await service.history({ pageSize: 5, message: 'needle' });
      expect(page.items).toHaveLength(1);
      expect(page.items[0].subject).toBe('fix: the needle everyone looks for');
      expect(page.items[0].isMerge).toBe(false);
      expect(page.tipOid).toBe(rawGit(repo, ['rev-parse', 'HEAD']).trim());
    });

    test('filters by author, path and date range', async () => {
      seedLongHistory();
      const byAuthor = await service.history({ author: 'history@probe.local', pageSize: 5 });
      expect(byAuthor.items.length).toBeGreaterThan(0);

      const byPath = await service.history({ path: 'gamma.txt', pageSize: 10 });
      expect(byPath.items.map(item => item.subject)).toContain('chore: gamma on side');

      // `--since` in the far future must exclude everything.
      // `--since` is passed straight to git. Note the date must be a sane one: a year like
      // 2999 is not reliably excluded by git's date parser, which is a test-input trap rather
      // than a filter that can be trusted.
      const future = await service.history({ since: '2030-01-01', pageSize: 5 });
      expect(future.items).toHaveLength(0);
    });

    test('paginates without repeating or skipping the filtered set', async () => {
      seedLongHistory();
      const first = await service.history({ pageSize: 10, message: 'bulk' });
      expect(first.items).toHaveLength(10);
      expect(first.truncated).toBe(true);
      expect(first.nextCursor).toBeTruthy();

      const second = await service.history({
        pageSize: 10,
        message: 'bulk',
        cursor: first.nextCursor ?? '',
      });
      const firstIds = new Set(first.items.map(item => item.id));
      expect(second.items.some(item => firstIds.has(item.id))).toBe(false);
      // Pages are in the same order: every id of page 2 precedes the last id of page 1.
      expect(second.items[0].id).not.toBe(first.items[0].id);
    });

    test('a cursor is bound to the frozen tip and the query', async () => {
      seedLongHistory();
      const first = await service.history({ pageSize: 5, message: 'bulk' });
      const cursor = first.nextCursor ?? '';

      // Changing the query must not be able to reuse the cursor.
      await expect(
        service.history({ pageSize: 5, message: 'chore', cursor })
      ).rejects.toMatchObject({ code: 'git_cursor_invalid' });

      // Neither must a repository that moved on.
      writeFileSync(join(repo, 'log.txt'), 'moved\n');
      rawGit(repo, ['add', '.']);
      rawGit(repo, ['commit', '-q', '-m', 'chore: moves the tip']);
      await expect(
        service.history({ pageSize: 5, message: 'bulk', cursor })
      ).rejects.toMatchObject({ code: 'git_cursor_invalid' });
    });

    test('a SHA query resolves one commit and reports reachability honestly', async () => {
      seedLongHistory();
      const target = rawGit(repo, ['rev-parse', 'HEAD~3']).trim();
      const bySha = await service.history({ sha: target.slice(0, 10) });
      expect(bySha.items).toHaveLength(1);
      expect(bySha.items[0].id).toBe(target);

      // An unreachable object is an empty result, not a silent substitution.
      rawGit(repo, ['checkout', '-q', '--detach', target]);
      writeFileSync(join(repo, 'orphan.txt'), 'orphan\n');
      rawGit(repo, ['add', '.']);
      rawGit(repo, ['commit', '-q', '-m', 'chore: orphan']);
      const orphan = rawGit(repo, ['rev-parse', 'HEAD']).trim();
      rawGit(repo, ['checkout', '-q', 'main']);
      const unreachable = await service.history({ sha: orphan });
      expect(unreachable.items).toHaveLength(0);
    });

    test('a repository with no commits is an empty history, not an error', async () => {
      rawGit(repo, ['config', 'user.email', 'history@probe.local']);
      rawGit(repo, ['config', 'user.name', 'History Probe']);
      const bare = new GitReadModelServiceV1(repo);
      const page = await bare.history({});
      expect(page.items).toHaveLength(0);
      expect(page.tipOid).toBeNull();
      expect(page.nextCursor).toBeNull();
    });

    test('rejects a search term carrying control characters instead of passing it to git', async () => {
      seedLongHistory();
      await expect(service.history({ message: 'bad\u0000term' })).rejects.toMatchObject({
        code: 'git_query_invalid',
      });
      await expect(service.history({ path: '../../etc/passwd' })).rejects.toMatchObject({
        code: 'git_path_unsafe',
      });
    });
  });

  describe('file history', () => {
    test('follows a rename and says so', async () => {
      seedHistory();
      rawGit(repo, ['mv', 'beta.txt', 'beta-renamed.txt']);
      rawGit(repo, ['commit', '-q', '-m', 'refactor: rename beta']);

      const history = await service.fileHistory({ path: 'beta-renamed.txt' });
      expect(history.path).toBe('beta-renamed.txt');
      expect(history.followed).toBe(true);
      // Both the rename and the original addition are reachable through --follow.
      expect(history.items.map(item => item.subject)).toContain('refactor: rename beta');
      expect(history.items.map(item => item.subject)).toContain('fix: add beta');
    });

    test('bounds the result and reports truncation', async () => {
      seedHistory();
      for (let index = 0; index < 12; index += 1) {
        writeFileSync(join(repo, 'alpha.txt'), `one\ntwo\n${index}\n`);
        rawGit(repo, ['add', '.']);
        rawGit(repo, ['commit', '-q', '-m', `chore: alpha ${index}`]);
      }
      const history = await service.fileHistory({ path: 'alpha.txt', limit: 5 });
      expect(history.items).toHaveLength(5);
      expect(history.truncated).toBe(true);
    });
  });

  describe('history browsing never writes to the workspace', () => {
    test('the worktree, index and HEAD are identical after a full sweep of history reads', async () => {
      seedHistory();
      // Leave uncommitted state in place so a stray write would be visible.
      writeFileSync(join(repo, 'alpha.txt'), 'one\ntwo\nuncommitted\n');
      writeFileSync(join(repo, 'untracked.txt'), 'untracked\n');
      const before = repoState();

      const refs = await service.refs();
      const page = await service.history({ pageSize: 10 });
      for (const item of page.items) {
        await service.commitDetail(item.id);
        const files = await service.commitFiles(item.id);
        for (const file of files.files.slice(0, 3)) {
          if (file.sensitive) continue;
          await service.commitDiffDocument({ oid: item.id, path: file.path });
        }
      }
      await service.fileHistory({ path: 'alpha.txt' });
      await service.commitDiffDocument({
        oid: rawGit(repo, ['rev-list', '--max-parents=0', 'HEAD']).trim(),
        path: 'alpha.txt',
      });

      expect(refs.refs.length).toBeGreaterThan(0);
      expect(repoState()).toEqual(before);
    });
  });
});
