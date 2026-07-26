/**
 * Bug-hunt round 12 evidence: workspace-diff does not unquote git's C-quoted
 * paths, so non-ASCII filenames are returned with surrounding quotes and
 * octal escapes instead of the real name.
 *
 * git default-quotes any path with non-ASCII or special chars, e.g.
 *   "uni\346\226\207\344\273\226.txt"
 * parseNameStatus / parseUntracked take the field verbatim, so the reported
 * path is the quoted+escaped string, not the real filename. Downstream code
 * (commit plans, UI display) then operates on a path that does not exist.
 *
 * Fix: pass -c core.quotepath=false to git so it emits UTF-8 paths, and/or
 * unquote the C-style string.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectWorkspaceDiff } from '../src/services/workspace-diff';

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

describe('workspace-diff non-ASCII filenames (bug-hunt round 12)', () => {
  const maybeIt = hasGit ? it : it.skip;
  let repo: string;

  afterEach(() => {
    if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  maybeIt('reports the real (unquoted) path for a non-ASCII untracked file', () => {
    repo = mkdtempSync(join(tmpdir(), 'openhorse-wsdiff-unicode-'));
    git(repo, ['init', '--quiet']);
    git(repo, ['config', 'user.email', 'a@b.c']);
    git(repo, ['config', 'user.name', 't']);
    const filename = 'uni文件.txt';
    writeFileSync(join(repo, filename), 'x', 'utf-8');

    const report = collectWorkspaceDiff({ cwd: repo });

    expect(report.untracked.map(f => f.path)).toContain(filename);
    // Must NOT contain the quoted/octal-escaped form.
    const paths = report.untracked.map(f => f.path).join('|');
    expect(paths).not.toContain('"');
    expect(paths).not.toMatch(/\\[0-9]{3}/);
  });

  maybeIt('reports the real (unquoted) path for a non-ASCII staged file', () => {
    repo = mkdtempSync(join(tmpdir(), 'openhorse-wsdiff-unicode-staged-'));
    git(repo, ['init', '--quiet']);
    git(repo, ['config', 'user.email', 'a@b.c']);
    git(repo, ['config', 'user.name', 't']);
    const filename = '报告.md';
    writeFileSync(join(repo, filename), 'x', 'utf-8');
    git(repo, ['add', '.']);

    const report = collectWorkspaceDiff({ cwd: repo });

    expect(report.staged.map(f => f.path)).toContain(filename);
  });
});
