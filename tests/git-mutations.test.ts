/**
 * v0.3.12 S3 — guarded Git mutations over a disposable repository.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FileReadServiceV1 } from '../src/web/file-read-service';
import { GitReadModelServiceV1 } from '../src/web/git-read-model-service';

function sh(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
}

function porcelain(repo: string): string {
  return execFileSync('git', ['status', '--porcelain=v1'], { cwd: repo, encoding: 'utf8' });
}

describe('guarded git mutations (v0.3.12 S3)', () => {
  test('stage, unstage and commit through host-resolved ids', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc312-git-'));
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    sh(repo, ['init', '-q', '-b', 'main']);
    sh(repo, ['config', 'user.email', 'm@probe.local']);
    sh(repo, ['config', 'user.name', 'Mutation Probe']);
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    sh(repo, ['add', 'base.txt']);
    sh(repo, ['commit', '-q', '-m', 'base']);

    writeFileSync(join(repo, 'added.ts'), 'export const added = 1;\n');
    writeFileSync(join(repo, 'base.txt'), 'base\nchanged\n');

    const files = new FileReadServiceV1(repo);
    const git = new GitReadModelServiceV1(repo);
    const addedId = files.identifyRelativePath('added.ts');
    const baseId = files.identifyRelativePath('base.txt');
    const addedPath = files.pathForFileId(addedId);
    const basePath = files.pathForFileId(baseId);

    await git.stagePaths([addedPath, basePath]);
    let status = porcelain(repo);
    expect(status).toContain('A  added.ts');
    expect(status).toContain('M  base.txt');

    await git.unstagePaths([addedPath]);
    status = porcelain(repo);
    expect(status).toContain('?? added.ts');
    expect(status).toContain('M  base.txt');

    // Commit with nothing staged for added.ts but base.txt staged -> allowed.
    const commitResult = await git.commit('feat: stage base change');
    expect(commitResult.commitSha).toMatch(/^[0-9a-f]{40}$/u);
    const after = porcelain(repo).trim();
    expect(after).toContain('?? added.ts');
    expect(after).not.toContain('base.txt');

    rmSync(root, { recursive: true, force: true });
  });

  test('rejects unsafe paths, empty commits and control characters in messages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc312-git-'));
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    sh(repo, ['init', '-q', '-b', 'main']);
    sh(repo, ['config', 'user.email', 'm@probe.local']);
    sh(repo, ['config', 'user.name', 'Mutation Probe']);
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    sh(repo, ['add', 'a.txt']);
    sh(repo, ['commit', '-q', '-m', 'base']);

    const git = new GitReadModelServiceV1(repo);
    await expect(git.stagePaths(['--cached'])).rejects.toThrow(/Unsafe Git path/);
    await expect(git.stagePaths(['../outside.txt'])).rejects.toThrow(/Unsafe Git path/);
    await expect(git.commit('   ')).rejects.toThrow(/commit message/);
    await expect(git.commit('bad\x07message')).rejects.toThrow(/commit message/);
    // nothing staged -> commit refused
    await expect(git.commit('valid but empty stage')).rejects.toThrow(/Nothing is staged/);
    rmSync(root, { recursive: true, force: true });
  });
});
