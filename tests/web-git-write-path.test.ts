/**
 * v0.3.17 S3 — write path: index transaction, hunk/line patches, commit runner.
 *
 * The §10 S3 exit evidence asks for real index/HEAD verification after a user-level action,
 * plus coverage of external contention and hook failure. So every assertion here reads the
 * result back through an **independent** `git` invocation rather than through our own API —
 * otherwise a bug in the read model could mask a bug in the write path.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitReadModelServiceV1 } from '../src/web/git-read-model-service';
import { WebWorkbenchError } from '../src/web/errors';

function rawGit(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** The staged content of one path, straight from Git. */
function stagedBlob(cwd: string, path: string): string {
  return rawGit(cwd, ['show', `:${path}`]);
}

function headBlob(cwd: string, path: string): string {
  return rawGit(cwd, ['show', `HEAD:${path}`]);
}

function fileById(
  status: Awaited<ReturnType<GitReadModelServiceV1['status']>>,
  path: string,
  source: 'staged' | 'unstaged' | 'untracked'
): { readonly fileId: string } | undefined {
  const bucket = source === 'staged' ? status.staged : source === 'unstaged' ? status.unstaged : status.untracked;
  return bucket.find(entry => entry.path === path);
}

// Real repositories, real subprocesses and real hooks: the default 5s budget measures the
// sandbox load, not the code.
jest.setTimeout(30_000);
describe('v0.3.17 S3 write path', () => {
  let root: string;
  let repo: string;
  let service: GitReadModelServiceV1;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'oc317-s3-')));
    repo = join(root, 'repo');
    mkdirSync(repo);
    rawGit(repo, ['init', '-q', '-b', 'main']);
    rawGit(repo, ['config', 'user.email', 'write@probe.local']);
    rawGit(repo, ['config', 'user.name', 'Write Probe']);
    writeFileSync(join(repo, 'alpha.txt'), ['one', 'two', 'three', 'four', 'five'].join('\n') + '\n');
    writeFileSync(join(repo, 'beta.txt'), 'committed\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'baseline']);
    service = new GitReadModelServiceV1(repo);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('file level staging through the index transaction', () => {
    test('stage lands in the real index and survives an independent read', async () => {
      writeFileSync(join(repo, 'alpha.txt'), ['one', 'TWO', 'three', 'four', 'five'].join('\n') + '\n');
      const paths = service.resolveMutationPaths('stage', [
        fileById(await service.status(), 'alpha.txt', 'unstaged')?.fileId ?? '',
      ]);

      const result = await service.stagePaths(paths);

      expect(stagedBlob(repo, 'alpha.txt')).toContain('TWO');
      expect(headBlob(repo, 'alpha.txt')).toContain('two');
      expect(result.repositoryRevision).toBe((await service.status()).repositoryRevision);
      // The worktree still has the edit, now shown only as a staged entry.
      const after = await service.status();
      expect(after.staged.map(entry => entry.path)).toEqual(['alpha.txt']);
      expect(after.unstaged).toEqual([]);
    });

    test('no index.lock or temp index is left behind after a successful write', async () => {
      writeFileSync(join(repo, 'alpha.txt'), 'changed\n');
      await service.stagePaths(['alpha.txt']);
      expect(existsSync(join(repo, '.git', 'index.lock'))).toBe(false);
      const leftovers = execFileSync('/bin/ls', ['-1', join(repo, '.git')], { encoding: 'utf8' });
      expect(leftovers).not.toContain('orion-index-');
    });

    test('unstage returns the index to HEAD without touching the worktree', async () => {
      writeFileSync(join(repo, 'alpha.txt'), 'worktree edit\n');
      await service.stagePaths(['alpha.txt']);
      expect(stagedBlob(repo, 'alpha.txt')).toBe('worktree edit\n');

      await service.unstagePaths(['alpha.txt']);

      expect(stagedBlob(repo, 'alpha.txt')).toBe(headBlob(repo, 'alpha.txt'));
      // The user's file is untouched — unstaging is an index operation only.
      expect(readFileSync(join(repo, 'alpha.txt'), 'utf8')).toBe('worktree edit\n');
    });

    test('a repository with no HEAD unstages via the index and keeps the file', async () => {
      const fresh = join(root, 'fresh');
      mkdirSync(fresh);
      rawGit(fresh, ['init', '-q', '-b', 'main']);
      rawGit(fresh, ['config', 'user.email', 'fresh@probe.local']);
      rawGit(fresh, ['config', 'user.name', 'Fresh']);
      const freshService = new GitReadModelServiceV1(fresh);
      writeFileSync(join(fresh, 'new.txt'), 'brand new\n');

      const status = await freshService.status();
      expect(status.head).toBeNull();
      const entry = fileById(status, 'new.txt', 'untracked');
      expect(entry).toBeTruthy();

      await freshService.stagePaths(freshService.resolveMutationPaths('stage', [entry?.fileId ?? '']));
      expect(rawGit(fresh, ['ls-files'])).toContain('new.txt');

      // `reset` needs HEAD, so this exercises the `rm --cached` branch.
      const stagedEntry = fileById(await freshService.status(), 'new.txt', 'staged');
      await freshService.unstagePaths(
        freshService.resolveMutationPaths('unstage', [stagedEntry?.fileId ?? ''])
      );

      expect(rawGit(fresh, ['ls-files'])).not.toContain('new.txt');
      expect(readFileSync(join(fresh, 'new.txt'), 'utf8')).toBe('brand new\n');
    });
  });

  describe('external contention', () => {
    test('a foreign index.lock is reported busy and left untouched', async () => {
      writeFileSync(join(repo, 'alpha.txt'), 'changed\n');
      const lockPath = join(repo, '.git', 'index.lock');
      // Not our marker: this is what the user's own Git looks like while it works.
      writeFileSync(lockPath, 'foreign lock\n');

      await expect(service.stagePaths(['alpha.txt'])).rejects.toMatchObject({
        code: 'git_index_busy',
      });

      // The critical assertion: we must not delete someone else's lock.
      expect(existsSync(lockPath)).toBe(true);
      expect(readFileSync(lockPath, 'utf8')).toBe('foreign lock\n');
      // And nothing was staged.
      expect(stagedBlob(repo, 'alpha.txt')).toBe(headBlob(repo, 'alpha.txt'));
    });

    test('a change made between check and write is detected, not silently overwritten', async () => {
      writeFileSync(join(repo, 'alpha.txt'), 'from orion\n');
      // Replay the exact race §7.7 warns about: the caller checked the revision, then an
      // external process moved the index before our write ran.
      const before = await service.status();
      // A real content change, otherwise `git add` is a no-op and nothing moves.
      writeFileSync(join(repo, 'beta.txt'), 'externally edited\n');
      rawGit(repo, ['add', 'beta.txt']);

      // The caller's stale expectation no longer matches, which is what makes the CAS honest.
      const now = await service.status();
      expect(now.repositoryRevision).not.toBe(before.repositoryRevision);

      await service.stagePaths(['alpha.txt']);
      // Our write preserved the external staging instead of replacing it wholesale.
      const after = rawGit(repo, ['diff', '--cached', '--name-only']);
      expect(after).toContain('beta.txt');
      expect(after).toContain('alpha.txt');
    });
  });

  describe('hunk and line level patches', () => {
    /**
     * Two well-separated changes so hunk selection is meaningful.
     *
     * The 40-line version is committed first — overwriting the 5-line baseline with 40 lines
     * would be a single whole-file hunk, and hunk selection would prove nothing.
     */
    function seedTwoHunks(): void {
      const base = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
      writeFileSync(join(repo, 'alpha.txt'), `${base.join('\n')}\n`);
      rawGit(repo, ['add', 'alpha.txt']);
      rawGit(repo, ['commit', '-q', '-m', 'expand alpha']);

      const lines = [...base];
      lines[4] = 'line 5 CHANGED';
      lines[34] = 'line 35 CHANGED';
      writeFileSync(join(repo, 'alpha.txt'), `${lines.join('\n')}\n`);
    }

    test('stages only the selected hunk and leaves the other untouched', async () => {
      seedTwoHunks();
      const status = await service.status();
      const entry = fileById(status, 'alpha.txt', 'unstaged');
      const doc = await service.diffDocument({ fileId: entry?.fileId ?? '' });
      expect(doc.hunks).toHaveLength(2);

      const mid = doc.hunks[0].lines.find(line => line.kind !== 'context');
      await service.applySelection({
        fileId: entry?.fileId ?? '',
        hunkIds: [doc.hunks[1].hunkId],
      });

      const staged = stagedBlob(repo, 'alpha.txt');
      const worktree = readFileSync(join(repo, 'alpha.txt'), 'utf8');
      // The second hunk is staged, the first is not.
      expect(staged).toContain('line 35 CHANGED');
      expect(staged).not.toContain('line 5 CHANGED');
      // The worktree keeps both edits.
      expect(worktree).toContain('line 5 CHANGED');
      expect(worktree).toContain('line 35 CHANGED');
      expect(mid).toBeTruthy();
    });

    test('stages a single selected line out of a hunk', async () => {
      writeFileSync(join(repo, 'alpha.txt'), ['one', 'TWO', 'THREE', 'four', 'five'].join('\n') + '\n');
      const status = await service.status();
      const entry = fileById(status, 'alpha.txt', 'unstaged');
      const doc = await service.diffDocument({ fileId: entry?.fileId ?? '' });
      const addition = doc.hunks[0].lines.find(line => line.kind === 'addition' && line.text === 'THREE');
      expect(addition).toBeTruthy();

      await service.applySelection({ fileId: entry?.fileId ?? '', lineIds: [addition?.lineId ?? ''] });

      const staged = stagedBlob(repo, 'alpha.txt');
      // Only the ticked line entered the index; the sibling addition did not.
      expect(staged).toContain('THREE');
      expect(staged).not.toContain('TWO');
      expect(staged).toContain('two');
    });

    test('unstages a selected hunk with the reverse patch', async () => {
      seedTwoHunks();
      await service.stagePaths(['alpha.txt']);
      expect(stagedBlob(repo, 'alpha.txt')).toContain('line 5 CHANGED');

      const status = await service.status();
      const entry = fileById(status, 'alpha.txt', 'staged');
      const doc = await service.diffDocument({ fileId: entry?.fileId ?? '' });
      expect(doc.source).toBe('staged');
      const first = doc.hunks[0];

      await service.applySelection({ fileId: entry?.fileId ?? '', hunkIds: [first.hunkId] });

      const staged = stagedBlob(repo, 'alpha.txt');
      // The first hunk reverted in the index, the second stayed staged.
      expect(staged).toContain('line 5');
      expect(staged).not.toContain('line 5 CHANGED');
      expect(staged).toContain('line 35 CHANGED');
    });

    test('refuses a partial patch it cannot rebuild faithfully, with a specific reason', async () => {
      writeFileSync(join(repo, 'brand-new.txt'), 'hello\n');
      const status = await service.status();
      const entry = fileById(status, 'brand-new.txt', 'untracked');
      const doc = await service.diffDocument({ fileId: entry?.fileId ?? '' });

      await expect(
        service.applySelection({ fileId: entry?.fileId ?? '', hunkIds: [doc.hunks[0]?.hunkId ?? '0'] })
      ).rejects.toMatchObject({ code: 'git_patch_not_applicable' });

      // Nothing was staged by the refused operation.
      expect(rawGit(repo, ['diff', '--cached', '--name-only']).trim()).toBe('');
    });

    test('refuses when the selected line is no longer in the document', async () => {
      writeFileSync(join(repo, 'alpha.txt'), 'changed\n');
      const status = await service.status();
      const entry = fileById(status, 'alpha.txt', 'unstaged');
      await expect(
        service.applySelection({ fileId: entry?.fileId ?? '', lineIds: ['999:1:1#0'] })
      ).rejects.toMatchObject({ code: 'git_patch_not_applicable' });
    });
  });

  describe('commit runner (plan §7.9)', () => {
    async function stageAlpha(content: string): Promise<string> {
      writeFileSync(join(repo, 'alpha.txt'), content);
      await service.stagePaths(['alpha.txt']);
      return (await service.status()).repositoryRevision;
    }

    test('accepts a summary plus a multi-line body and preserves both', async () => {
      const revision = await stageAlpha('committed body change\n');
      const outcome = await service.commit({
        summary: 'feat: alpha',
        body: 'why it changed\n\nand a second paragraph',
        expectedRepositoryRevision: revision,
        requestId: 'req-commit-body-1',
      });

      expect(outcome.status).toBe('committed');
      const message = rawGit(repo, ['log', '-1', '--format=%B']);
      expect(message).toContain('feat: alpha');
      expect(message).toContain('why it changed');
      expect(message).toContain('and a second paragraph');
      // The commitSha is the new HEAD, and the state revision is a different value space.
      expect(outcome.commitSha).toBe(rawGit(repo, ['rev-parse', 'HEAD']).trim());
      expect(outcome.repositoryRevision).not.toBe(outcome.commitSha);
      expect(outcome.repositoryRevision).toMatch(/^[0-9a-f]{64}$/u);
    });

    test('reports identity and hook configuration instead of hiding it', async () => {
      const revision = await stageAlpha('identity probe\n');
      const preview = await service.commitPreview();
      expect(preview.identity).toMatchObject({
        name: 'Write Probe',
        email: 'write@probe.local',
        signingEnabled: false,
      });
      expect(preview.canCommit).toBe(true);
      expect(preview.filesChanged).toBe(1);
      const outcome = await service.commit({
        summary: 'chore: identity',
        expectedRepositoryRevision: revision,
        requestId: 'req-identity-1',
      });
      expect(outcome.identity.email).toBe('write@probe.local');
    });

    test('runs repository hooks — they are NOT disabled for the commit runner', async () => {
      const hooks = join(repo, '.git', 'hooks');
      mkdirSync(hooks, { recursive: true });
      const marker = join(repo, 'hook-ran.txt');
      writeFileSync(
        join(hooks, 'pre-commit'),
        `#!/bin/sh\necho ran > "${marker}"\nexit 0\n`,
        { mode: 0o755 }
      );
      const revision = await stageAlpha('hook probe\n');

      await service.commit({
        summary: 'chore: hooks',
        expectedRepositoryRevision: revision,
        requestId: 'req-hook-1',
      });

      // The hook actually executed, which proves the commit profile leaves hooksPath alone.
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, 'utf8').trim()).toBe('ran');
    });

    test('a failing pre-commit hook surfaces the reason and commits nothing', async () => {
      const hooks = join(repo, '.git', 'hooks');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(
        join(hooks, 'pre-commit'),
        '#!/bin/sh\necho "lint failed: alpha.txt" >&2\nexit 1\n',
        { mode: 0o755 }
      );
      const revision = await stageAlpha('blocked by hook\n');
      const headBefore = rawGit(repo, ['rev-parse', 'HEAD']).trim();

      await expect(
        service.commit({
          summary: 'chore: should not land',
          expectedRepositoryRevision: revision,
          requestId: 'req-hook-fail-1',
        })
      ).rejects.toBeInstanceOf(WebWorkbenchError);

      // Nothing committed, and the staged work is still there so the draft is recoverable.
      expect(rawGit(repo, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
      expect(stagedBlob(repo, 'alpha.txt')).toBe('blocked by hook\n');
      expect((await service.commitPreview()).filesChanged).toBe(1);
    });

    test('a commit that lands while the process reports failure is reported as committed', async () => {
      // The exact scenario §7.9 forbids misreporting: the hook creates the commit through
      // plumbing (commit-tree + update-ref, so it never touches the index lock the outer
      // `git commit` holds) and THEN fails. The process exits non-zero, but HEAD moved — and
      // the answer must describe reality, not the exit code.
      const hooks = join(repo, '.git', 'hooks');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(
        join(hooks, 'pre-commit'),
        [
          '#!/bin/sh',
          'tree=$(git write-tree)',
          'new=$(echo "chore: created by hook" | git commit-tree "$tree" -p HEAD)',
          'git update-ref HEAD "$new"',
          'echo "post-commit verification failed" >&2',
          'exit 1',
          '',
        ].join('\n'),
        { mode: 0o755 }
      );
      const revision = await stageAlpha('landed anyway\n');

      const outcome = await service.commit({
        summary: 'chore: should be reported by recovery',
        expectedRepositoryRevision: revision,
        requestId: 'req-hook-landed-1',
      });

      // Recovery asked Git what happened and told the truth.
      expect(outcome.status).toBe('committed');
      expect(outcome.warning).toMatch(/已实际完成/u);
      expect(outcome.commitSha).toBe(rawGit(repo, ['rev-parse', 'HEAD']).trim());
      expect(rawGit(repo, ['log', '-1', '--format=%s'])).toContain('created by hook');
    });

    test('a timeout kills the hook process tree and reports a timeout, not a success', async () => {
      const hooks = join(repo, '.git', 'hooks');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nsleep 30\nexit 0\n', { mode: 0o755 });
      const slow = new GitReadModelServiceV1(repo, { commitTimeoutMs: 1_000 });
      writeFileSync(join(repo, 'alpha.txt'), 'slow hook\n');
      await slow.stagePaths(['alpha.txt']);
      const revision = (await slow.status()).repositoryRevision;
      const headBefore = rawGit(repo, ['rev-parse', 'HEAD']).trim();

      await expect(
        slow.commit({
          summary: 'chore: slow hook',
          expectedRepositoryRevision: revision,
          requestId: 'req-hook-slow-1',
        })
      ).rejects.toMatchObject({ code: 'git_timeout' });

      // HEAD did not move, so "timed out" was the truthful answer.
      expect(rawGit(repo, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
      expect(stagedBlob(repo, 'alpha.txt')).toBe('slow hook\n');
      // And the orphaned hook did not leave a lock behind for the next writer.
      expect(existsSync(join(repo, '.git', 'index.lock'))).toBe(false);
    });

    test('refuses when nothing is staged, when conflicts exist, or when the revision is stale', async () => {
      const clean = await service.status();
      await expect(
        service.commit({
          summary: 'chore: empty',
          expectedRepositoryRevision: clean.repositoryRevision,
          requestId: 'req-empty-1',
        })
      ).rejects.toMatchObject({ code: 'git_nothing_staged' });

      const revision = await stageAlpha('stale probe\n');
      writeFileSync(join(repo, 'beta.txt'), 'moved on\n');
      rawGit(repo, ['add', 'beta.txt']);
      await expect(
        service.commit({
          summary: 'chore: stale',
          expectedRepositoryRevision: revision,
          requestId: 'req-stale-1',
        })
      ).rejects.toMatchObject({ code: 'git_revision_conflict' });
    });

    test('rejects control characters but keeps tabs and newlines', async () => {
      const revision = await stageAlpha('message probe\n');
      await expect(
        service.commit({
          summary: 'bad\u0000summary',
          expectedRepositoryRevision: revision,
          requestId: 'req-nul-1',
        })
      ).rejects.toMatchObject({ code: 'git_message_invalid' });
      await expect(
        service.commit({
          summary: 'ok summary',
          body: 'belongs\u0007here',
          expectedRepositoryRevision: revision,
          requestId: 'req-bel-1',
        })
      ).rejects.toMatchObject({ code: 'git_message_invalid' });
      // A tab in the body is legitimate and must not be rejected.
      const outcome = await service.commit({
        summary: 'chore: tab body',
        body: 'col1\tcol2',
        expectedRepositoryRevision: revision,
        requestId: 'req-tab-1',
      });
      expect(rawGit(repo, ['log', '-1', '--format=%B'])).toContain('col1\tcol2');
      expect(outcome.status).toBe('committed');
    });

    test('rejects a malformed requestId', async () => {
      const revision = await stageAlpha('request id probe\n');
      await expect(
        service.commit({
          summary: 'chore: bad request id',
          expectedRepositoryRevision: revision,
          requestId: 'short',
        })
      ).rejects.toMatchObject({ code: 'git_request_id_invalid' });
    });
  });
});
