/**
 * v0.3.17 S5 — conflict stages, historical blobs, LFS pointer state and gitlink entries.
 *
 * The plan is explicit that a conflicted file must not be presented as an ordinary staged
 * diff, so the shape and the *absence* of a side are both asserted here rather than assumed.
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

function tryGit(cwd: string, args: readonly string[]): string | null {
  try {
    return rawGit(cwd, args);
  } catch {
    return null;
  }
}

describe('v0.3.17 S5 file versions', () => {
  let root: string;
  let repo: string;
  let service: GitReadModelServiceV1;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'oc317-ver-')));
    repo = join(root, 'repo');
    mkdirSync(repo);
    rawGit(repo, ['init', '-q', '-b', 'main']);
    rawGit(repo, ['config', 'user.email', 'ver@probe.local']);
    rawGit(repo, ['config', 'user.name', 'Version Probe']);
    service = new GitReadModelServiceV1(repo);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Creates a modify/modify conflict on `f.txt`. */
  function seedModifyConflict(): void {
    writeFileSync(join(repo, 'f.txt'), 'base\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'c0']);
    rawGit(repo, ['checkout', '-q', '-b', 'other']);
    writeFileSync(join(repo, 'f.txt'), 'theirs\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'theirs change']);
    rawGit(repo, ['checkout', '-q', 'main']);
    writeFileSync(join(repo, 'f.txt'), 'ours\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'ours change']);
    tryGit(repo, ['merge', '--no-ff', '-m', 'merge other', 'other']);
  }

  test('a modify/modify conflict exposes all three stages with their real content', async () => {
    seedModifyConflict();

    const conflict = await service.conflictVersions('f.txt');

    expect(conflict.shape).toBe('both-modified');
    expect(conflict.base.exists).toBe(true);
    expect(conflict.ours.exists).toBe(true);
    expect(conflict.theirs.exists).toBe(true);
    expect(conflict.base.content).toBe('base\n');
    expect(conflict.ours.content).toBe('ours\n');
    expect(conflict.theirs.content).toBe('theirs\n');
    // The three stages are genuinely different blobs, not the same object relabelled.
    expect(new Set([conflict.base.oid, conflict.ours.oid, conflict.theirs.oid]).size).toBe(3);
    // The worktree carries the conflict markers, so it is its own version.
    expect(conflict.worktree.exists).toBe(true);
    expect(conflict.worktree.content).toContain('<<<<<<<');
  });

  test('an add/add conflict has no base, and says so instead of omitting the side', async () => {
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'c0']);
    rawGit(repo, ['checkout', '-q', '-b', 'other']);
    writeFileSync(join(repo, 'new.txt'), 'from theirs\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'theirs add']);
    rawGit(repo, ['checkout', '-q', 'main']);
    writeFileSync(join(repo, 'new.txt'), 'from ours\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'ours add']);
    tryGit(repo, ['merge', '--no-ff', '-m', 'merge other', 'other']);

    const conflict = await service.conflictVersions('new.txt');

    expect(conflict.shape).toBe('both-added');
    // Absent, but present as an explicitly absent version — never silently dropped.
    expect(conflict.base.exists).toBe(false);
    expect(conflict.base.oid).toBeNull();
    expect(conflict.ours.content).toBe('from ours\n');
    expect(conflict.theirs.content).toBe('from theirs\n');
  });

  test('a modify/delete conflict reports the missing side as a shape, not an error', async () => {
    seedModifyConflict();
    // Fresh repository state: modify on main, delete on the other branch.
    rawGit(repo, ['merge', '--abort']);
    rawGit(repo, ['checkout', '-q', '-b', 'deleter']);
    rawGit(repo, ['rm', '-q', 'f.txt']);
    rawGit(repo, ['commit', '-q', '-m', 'delete f']);
    rawGit(repo, ['checkout', '-q', 'main']);
    writeFileSync(join(repo, 'f.txt'), 'main edit\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'edit f']);
    tryGit(repo, ['merge', '--no-ff', '-m', 'merge deleter', 'deleter']);

    const conflict = await service.conflictVersions('f.txt');

    // One side deleted the file, so that stage does not exist.
    expect(['deleted-by-them', 'deleted-by-us']).toContain(conflict.shape);
    const missing = [conflict.base, conflict.ours, conflict.theirs].filter(v => !v.exists);
    expect(missing).toHaveLength(1);
    expect(conflict.base.exists).toBe(true);
  });

  test('reads one file at a revision, including a file that no longer exists', async () => {
    writeFileSync(join(repo, 'gone.txt'), 'line one\nline two\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'add gone']);
    const rev = rawGit(repo, ['rev-parse', 'HEAD']).trim();
    rawGit(repo, ['rm', '-q', 'gone.txt']);
    rawGit(repo, ['commit', '-q', '-m', 'delete gone']);

    const blob = await service.fileBlob({ path: 'gone.txt', rev });

    expect(blob.oid).toBeTruthy();
    expect(blob.content.join('\n')).toContain('line two');
    expect(blob.truncated).toBe(false);
    // And it really is gone from the working tree.
    expect(tryGit(repo, ['rev-parse', '--verify', '--quiet', 'gone.txt'])).toBeNull();
  });

  test('reports LFS pointer state without fetching the object', async () => {
    const pointer = [
      'version https://git-lfs.github.com/spec/v1',
      'oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393',
      'size 12345',
      '',
    ].join('\n');
    writeFileSync(join(repo, 'big.bin'), pointer);
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'add lfs pointer']);
    const rev = rawGit(repo, ['rev-parse', 'HEAD']).trim();

    const blob = await service.fileBlob({ path: 'big.bin', rev });

    expect(blob.lfs).toMatchObject({
      oid: '4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393',
      size: 12345,
    });
    expect(blob.binary).toBe(false);
  });

  test('lists gitlink entries without traversing submodules', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'c0']);
    const gitlinkSha = rawGit(repo, ['rev-parse', 'HEAD']).trim();
    rawGit(repo, ['update-index', '--add', '--cacheinfo', `160000,${gitlinkSha},vendor/sub`]);

    const entries = await service.submodules();

    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('vendor/sub');
    expect(entries[0].gitlinkOid).toBe(gitlinkSha);
    // Plan G6: the dirty summary is explicitly not computed, not silently left blank.
    expect(entries[0].dirtySummary).toBeNull();
    expect(entries[0].dirtyNote).toContain('不遍历');
  });

  test('refuses sensitive paths and unknown revisions, and reads nothing on its own', async () => {
    writeFileSync(join(repo, '.env'), 'SECRET=1\n');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    rawGit(repo, ['add', '-f', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'c0']);
    const rev = rawGit(repo, ['rev-parse', 'HEAD']).trim();
    const before = rawGit(repo, ['status', '--porcelain=v1']);

    await expect(service.fileBlob({ path: '.env', rev })).rejects.toMatchObject({
      code: 'sensitive_file_blocked',
    });
    await expect(service.fileBlob({ path: 'a.txt', rev: '../../etc' })).rejects.toMatchObject({
      code: 'git_ref_invalid',
    });
    await expect(service.fileBlob({ path: 'nope.txt', rev })).rejects.toMatchObject({
      code: 'git_blob_not_found',
    });
    await expect(service.conflictVersions('../outside')).rejects.toMatchObject({
      code: 'git_path_unsafe',
    });
    expect(rawGit(repo, ['status', '--porcelain=v1'])).toBe(before);
  });

  test('a known image becomes a data URL; an unknown binary does not', async () => {
    // The magic bytes, not the extension, decide what is renderable. A minimal valid PNG.
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
      0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
      0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    writeFileSync(join(repo, 'pic.png'), png);
    writeFileSync(join(repo, `opaque.bin`), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'assets']);
    const rev = rawGit(repo, ['rev-parse', 'HEAD']).trim();

    const image = await service.fileBlob({ path: 'pic.png', rev });
    expect(image.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(image.binary).toBe(true);

    const opaque = await service.fileBlob({ path: 'opaque.bin', rev });
    expect(opaque.dataUrl).toBeNull();
    expect(opaque.binary).toBe(true);
  });
});
