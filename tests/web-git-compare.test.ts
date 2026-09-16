/**
 * v0.3.17 S5 — branch/version comparison (plan G5).
 *
 * The semantics under test are the ones that are easy to get silently wrong: which commits the
 * comparison actually used, what happens when the divergence point is not unique, and what a
 * hostile ref name is allowed to do. Every read is verified to leave the repository untouched.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

describe('v0.3.17 S5 branch/version comparison', () => {
  let root: string;
  let repo: string;
  let service: GitReadModelServiceV1;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'oc317-cmp-')));
    repo = join(root, 'repo');
    mkdirSync(repo);
    rawGit(repo, ['init', '-q', '-b', 'main']);
    rawGit(repo, ['config', 'user.email', 'compare@probe.local']);
    rawGit(repo, ['config', 'user.name', 'Compare Probe']);
    service = new GitReadModelServiceV1(repo);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Two branches with one merge, so a unique merge base exists. */
  function seedFork(): { readonly main: string; readonly side: string } {
    writeFileSync(join(repo, 'alpha.txt'), 'one\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'feat: alpha initial']);
    rawGit(repo, ['tag', 'v1']);

    rawGit(repo, ['checkout', '-q', '-b', 'side']);
    writeFileSync(join(repo, 'gamma.txt'), 'gamma\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'chore: gamma on side']);
    rawGit(repo, ['checkout', '-q', 'main']);
    writeFileSync(join(repo, 'alpha.txt'), 'one\ntwo\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'feat: alpha two']);
    rawGit(repo, ['merge', '-q', '--no-ff', '-m', 'merge: side into main', 'side']);
    return {
      main: rawGit(repo, ['rev-parse', 'main']).trim(),
      side: rawGit(repo, ['rev-parse', 'side']).trim(),
    };
  }

  function repoState(): string {
    return JSON.stringify({
      head: rawGit(repo, ['rev-parse', 'HEAD']).trim(),
      index: rawGit(repo, ['ls-files', '--stage']),
      porcelain: rawGit(repo, ['status', '--porcelain=v1']),
    });
  }

  test('snapshot mode diffs the two trees and reports the resolved commits', async () => {
    const { main, side } = seedFork();

    const result = await service.compare({ baseRef: 'side', headRef: 'main', mode: 'snapshot' });

    // Snapshot means the two trees, so the merge itself is part of the difference.
    expect(result.baseOid).toBe(side);
    expect(result.headOid).toBe(main);
    expect(result.mode).toBe('snapshot');
    expect(result.files.map(file => file.path)).toContain('alpha.txt');
    expect(result.additions).toBeGreaterThan(0);
    // Resolved OIDs are first-class output: this is what the UI freezes against.
    expect(result.headLabel).toBe('main');
  });

  test('merge-base mode compares from the divergence point only', async () => {
    const { main } = seedFork();
    rawGit(repo, ['checkout', '-q', '-b', 'feature']);
    writeFileSync(join(repo, 'feature.txt'), 'feature\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'feat: feature work']);

    const result = await service.compare({
      baseRef: 'main',
      headRef: 'feature',
      mode: 'merge-base',
    });

    // The base is the divergence point, not main's tip — so main's own commits are excluded.
    expect(result.mergeBaseOid).toBe(rawGit(repo, ['merge-base', 'main', 'feature']).trim());
    expect(result.files.map(file => file.path)).toEqual(['feature.txt']);
    expect(result.baseLabel).toContain('共同祖先');
  });

  test('more than one merge base is refused instead of picking one arbitrarily', async () => {
    // Classic criss-cross: A merges B, then B merges A's *old* tip. Different files keep
    // both merges clean, and merge-base --all for the two merge commits is genuinely
    // ambiguous.
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'c0']);
    rawGit(repo, ['checkout', '-q', '-b', 'leftA']);
    writeFileSync(join(repo, 'left.txt'), 'left\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'c1']);
    rawGit(repo, ['checkout', '-q', '-b', 'rightB', 'main']);
    writeFileSync(join(repo, 'right.txt'), 'right\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'c2']);
    rawGit(repo, ['checkout', '-q', 'leftA']);
    rawGit(repo, ['merge', '-q', '--no-ff', '-m', 'm1', 'rightB']);
    rawGit(repo, ['checkout', '-q', 'rightB']);
    rawGit(repo, ['merge', '-q', '--no-ff', '-m', 'm2', rawGit(repo, ['rev-parse', 'leftA^']).trim()]);

    expect(
      rawGit(repo, ['merge-base', '--all', 'leftA', 'rightB']).trim().split('\n').length
    ).toBeGreaterThan(1);
    await expect(
      service.compare({ baseRef: 'leftA', headRef: 'rightB', mode: 'merge-base' })
    ).rejects.toMatchObject({ code: 'git_merge_base_multiple' });
    // The plan's answer to ambiguity is the other mode, which still works.
    const snapshot = await service.compare({ baseRef: 'leftA', headRef: 'rightB', mode: 'snapshot' });
    expect(snapshot.mode).toBe('snapshot');
  });
  test('no common ancestor is an explicit error, not an empty file list', async () => {
    seedFork();
    // An unrelated root.
    rawGit(repo, ['checkout', '-q', '--orphan', 'island']);
    rawGit(repo, ['rm', '-rq', '--cached', '.']);
    writeFileSync(join(repo, 'island.txt'), 'island\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'feat: island root']);

    await expect(
      service.compare({ baseRef: 'main', headRef: 'island', mode: 'merge-base' })
    ).rejects.toMatchObject({ code: 'git_merge_base_missing' });
  });

  test('hostile ref names are refused before reaching git', async () => {
    seedFork();
    for (const bad of ['--upload-pack=/bin/sh', 'main..side', '../../etc', 'a b', '-x']) {
      await expect(
        service.compare({ baseRef: bad, headRef: 'main', mode: 'snapshot' })
      ).rejects.toMatchObject({ code: 'git_ref_invalid' });
    }
    await expect(
      service.compare({ baseRef: 'no-such-branch', headRef: 'main', mode: 'snapshot' })
    ).rejects.toMatchObject({ code: 'git_ref_not_found' });
  });

  test('resolved OIDs follow a ref that moves, so the UI can detect it', async () => {
    seedFork();
    const before = await service.resolveComparePair('side', 'main');
    expect(before.headOid).toBe(rawGit(repo, ['rev-parse', 'main']).trim());

    writeFileSync(join(repo, 'moved.txt'), 'moved\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'feat: move main']);
    const after = await service.resolveComparePair('side', 'main');
    expect(after.headOid).not.toBe(before.headOid);
    // The old result stays frozen: resolving by OID is unaffected by the ref moving.
    const frozen = await service.compareFileDiffDocument({
      baseOid: before.baseOid,
      headOid: before.headOid,
      path: 'alpha.txt',
    });
    expect(frozen.path).toBe('alpha.txt');
  });

  test('a historical diff matches what git says between the two trees', async () => {
    const { main, side } = seedFork();
    const document = await service.compareFileDiffDocument({
      baseOid: side,
      headOid: main,
      path: 'alpha.txt',
    });
    expect(document.source).toBe('commit');
    const added = document.hunks
      .flatMap(hunk => hunk.lines)
      .filter(line => line.kind === 'addition')
      .map(line => line.text);
    expect(added).toContain('two');
    // And the tree-level facts agree with an independent git invocation.
    expect(rawGit(repo, ['diff', '--name-only', side, main]).trim()).toBe('alpha.txt');
    expect(main).toBe(rawGit(repo, ['rev-parse', 'main']).trim());
  });

  test('comparison is read-only: HEAD, index and worktree are untouched', async () => {
    seedFork();
    // Uncommitted state left in place so a stray write would show.
    writeFileSync(join(repo, 'alpha.txt'), 'one\ntwo\nuncommitted\n');
    writeFileSync(join(repo, 'untracked.txt'), 'untracked\n');
    const before = repoState();

    const refs = await service.refs();
    const base = refs.refs.find(ref => ref.kind === 'branch')?.shortName ?? 'main';
    await service.compare({ baseRef: base, headRef: 'main', mode: 'snapshot' });
    await service.compare({ baseRef: base, headRef: 'main', mode: 'merge-base' });
    await service.compareFileDiffDocument({
      baseOid: rawGit(repo, ['rev-parse', 'main^']).trim(),
      headOid: rawGit(repo, ['rev-parse', 'main']).trim(),
      path: 'alpha.txt',
    });

    expect(repoState()).toEqual(before);
    expect(readFileSync(join(repo, 'alpha.txt'), 'utf8')).toContain('uncommitted');
  });
});
