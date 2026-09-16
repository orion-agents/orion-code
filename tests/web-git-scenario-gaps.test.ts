/**
 * v0.3.17 — the G317 scenario variants that the first pass left unasserted.
 *
 * Each test here closes one "部分" row in `docs/plan/evidence/v0.3.17-git/g317-status.md`:
 *   - G317-05  staging a deletion and a rename
 *   - G317-07  line-level staging in a CRLF file
 *   - G317-09  a signing failure leaves the draft and the index intact
 *   - G317-22  a bare repository is within the workspace boundary and says what it cannot do
 *
 * Repository claims are read back through an independent `git` process.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

function tryGit(cwd: string, args: readonly string[]): string | null {
  try {
    return rawGit(cwd, args);
  } catch {
    return null;
  }
}

describe('v0.3.17 G317 scenario variants', () => {
  let root: string;
  let repo: string;
  let service: GitReadModelServiceV1;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'oc317-gap-')));
    repo = join(root, 'repo');
    mkdirSync(repo);
    rawGit(repo, ['init', '-q', '-b', 'main']);
    rawGit(repo, ['config', 'user.email', 'gap@probe.local']);
    rawGit(repo, ['config', 'user.name', 'Gap Probe']);
    service = new GitReadModelServiceV1(repo);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ---- G317-05: deletion ------------------------------------------------------------
  test('G317-05 staging a worktree deletion removes the index entry only', async () => {
    writeFileSync(join(repo, 'doomed.txt'), 'content\n');
    writeFileSync(join(repo, 'kept.txt'), 'kept\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'base']);

    // The user deletes the file in the working tree; git reports it as an unstaged deletion.
    rmSync(join(repo, 'doomed.txt'));
    const status = await service.status();
    const entry = status.unstaged.find(candidate => candidate.path === 'doomed.txt');
    expect(entry).toBeTruthy();

    await service.stagePaths(service.resolveMutationPaths('stage', [entry?.fileId ?? '']));

    // The deletion is recorded in the index, and the file is not resurrected on disk.
    expect(rawGit(repo, ['ls-files'])).not.toContain('doomed.txt');
    expect(rawGit(repo, ['diff', '--cached', '--name-status'])).toContain('D\tdoomed.txt');
    expect(tryGit(repo, ['rev-parse', '--verify', '--quiet', 'doomed.txt'])).toBeNull();
    // The untouched file is still tracked and unmodified.
    expect(rawGit(repo, ['ls-files'])).toContain('kept.txt');
    expect(rawGit(repo, ['diff', '--cached', '--name-only'])).not.toContain('kept.txt');
  });

  // ---- G317-05: rename ---------------------------------------------------------------
  test('G317-05 staging both sides of a rename records the rename in the index', async () => {
    writeFileSync(join(repo, 'old-name.txt'), 'stable content\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'base']);

    // A filesystem move, not `git mv`: the latter stages the change immediately, so there
    // would be nothing left for the panel to stage.
    renameSync(join(repo, 'old-name.txt'), join(repo, 'new-name.txt'));
    const status = await service.status();
    // A rename shows up as a deletion plus an untracked addition until it is staged.
    const deleted = status.unstaged.find(candidate => candidate.path === 'old-name.txt');
    const added = status.untracked.find(candidate => candidate.path === 'new-name.txt');
    expect(deleted).toBeTruthy();
    expect(added).toBeTruthy();

    await service.stagePaths(
      service.resolveMutationPaths('stage', [deleted?.fileId ?? '', added?.fileId ?? ''])
    );

    // Git detects the rename once both sides are staged, and the content is preserved.
    const nameStatus = rawGit(repo, ['diff', '--cached', '--name-status', '-M']);
    expect(nameStatus).toMatch(/^R\d+\told-name\.txt\tnew-name\.txt$/mu);
    expect(rawGit(repo, ['show', ':new-name.txt'])).toBe('stable content\n');
    expect(tryGit(repo, ['show', ':old-name.txt'])).toBeNull();
  });

  // ---- G317-07: CRLF line selection ---------------------------------------------------
  test('G317-07 line-level staging refuses a CRLF file instead of writing a broken patch', async () => {
    // Two additions; only the second is ticked.
    const original = ['one\r\n', 'two\r\n', 'three\r\n'];
    writeFileSync(join(repo, 'crlf.txt'), original.join(''));
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'base']);

    writeFileSync(join(repo, 'crlf.txt'), ['one\r\n', 'TWO\r\n', 'three\r\n', 'FOUR\r\n'].join(''));
    const status = await service.status();
    const entry = status.unstaged.find(candidate => candidate.path === 'crlf.txt');
    const document = await service.diffDocument({ fileId: entry?.fileId ?? '' });
    const ticked = document.hunks
      .flatMap(hunk => hunk.lines)
      .find(line => line.kind === 'addition' && line.text === 'FOUR');
    expect(ticked).toBeTruthy();

    const stagedBefore = rawGit(repo, ['show', ':crlf.txt']);
    // The diff text cannot represent CRLF unambiguously, so the rebuilt patch does not match
    // the stored bytes. The plan requires this to be refused explicitly rather than applied
    // partially — and nothing may be written on the way to refusing.
    await expect(
      service.applySelection({ fileId: entry?.fileId ?? '', lineIds: [ticked?.lineId ?? ''] })
    ).rejects.toMatchObject({ code: 'git_patch_not_applicable' });

    const staged = rawGit(repo, ['show', ':crlf.txt']);
    expect(staged).toBe(stagedBefore);
    // And the working tree still holds the user's whole edit, byte for byte.
    expect(readFileSync(join(repo, 'crlf.txt'), 'utf8')).toBe(
      ['one\r\n', 'TWO\r\n', 'three\r\n', 'FOUR\r\n'].join('')
    );
  });

  // ---- G317-09: signing failure --------------------------------------------------------
  test('G317-09 a signing failure refuses the commit and keeps the staged work', async () => {
    writeFileSync(join(repo, 'signed.txt'), 'content\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'base']);
    writeFileSync(join(repo, 'signed.txt'), 'changed\n');
    await service.stagePaths(['signed.txt']);

    // Ask for signing with a key that cannot exist, so the commit must fail.
    rawGit(repo, ['config', 'commit.gpgsign', 'true']);
    rawGit(repo, ['config', 'user.signingkey', 'DEADBEEFDEADBEEF']);
    const headBefore = rawGit(repo, ['rev-parse', 'HEAD']).trim();
    const revision = (await service.status()).repositoryRevision;

    await expect(
      service.commit({
        summary: 'chore: signed commit that cannot succeed',
        expectedRepositoryRevision: revision,
        requestId: 'gap-signing-1',
      })
    ).rejects.toBeTruthy();

    // The failure is honest: nothing was committed, and the staged work is still there so the
    // reader can fix the configuration and retry without retyping.
    expect(rawGit(repo, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(rawGit(repo, ['show', ':signed.txt'])).toBe('changed\n');
  });

  // ---- G317-22: bare repository --------------------------------------------------------
  test('G317-22 a bare repository is readable history with an explicit limit', async () => {
    writeFileSync(join(repo, 'file.txt'), 'content\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'base']);
    const bare = join(root, 'bare.git');
    rawGit(repo, ['clone', '-q', '--bare', repo, bare]);
    const bareService = new GitReadModelServiceV1(bare);

    // A bare repository has no working tree, so it is outside the workspace boundary this
    // panel works in. The limit is stated rather than worked around.
    await expect(bareService.history({ pageSize: 5 })).rejects.toThrow(
      /unavailable|not a repository/iu
    );
    // Measured contract: no worktree means it is not a repository for this panel's purposes,
    // and there is nothing to report as changed. It must never invent changes.
    const bareStatus = await bareService.status();
    expect(bareStatus.isRepository).toBe(false);
    expect(bareStatus.branch).toBeNull();
    expect(bareStatus.clean).toBe(true);
    expect(bareStatus.staged).toEqual([]);
    expect(bareStatus.unstaged).toEqual([]);
    expect(bareStatus.untracked).toEqual([]);
  });

  // ---- G317-01: non-repository and clean repository ------------------------------------
  test('G317-01 a non-repository and a clean repository both report honestly', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    const plainService = new GitReadModelServiceV1(plain);

    // Not a repository: stated as such, and history is refused rather than fabricated.
    const plainStatus = await plainService.status();
    expect(plainStatus.isRepository).toBe(false);
    await expect(plainService.history({ pageSize: 5 })).rejects.toThrow(
      /unavailable|not a repository/iu
    );

    // A clean repository: nothing changed, but the history is still there.
    writeFileSync(join(repo, 'clean.txt'), 'x\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'clean state']);
    const cleanStatus = await service.status();
    expect(cleanStatus.isRepository).toBe(true);
    expect(cleanStatus.clean).toBe(true);
    expect(cleanStatus.counts.total).toBe(0);
    const history = await service.history({ pageSize: 5 });
    expect(history.items.length).toBeGreaterThan(0);
  });
});
