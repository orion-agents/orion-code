/**
 * v0.3.17 S5 — blame (plan G6).
 *
 * The property that matters is attribution correctness: each rendered row must name the commit
 * that git itself says last touched that line, and uncommitted lines must never be attributed
 * to a historical author.
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

describe('v0.3.17 S5 blame', () => {
  let root: string;
  let repo: string;
  let service: GitReadModelServiceV1;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'oc317-blame-')));
    repo = join(root, 'repo');
    mkdirSync(repo);
    rawGit(repo, ['init', '-q', '-b', 'main']);
    rawGit(repo, ['config', 'user.email', 'blame@probe.local']);
    rawGit(repo, ['config', 'user.name', 'Blame Probe']);
    service = new GitReadModelServiceV1(repo);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('attributes each line to the commit git says last touched it', async () => {
    writeFileSync(join(repo, 'f.txt'), 'first\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'c1']);
    const first = rawGit(repo, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(repo, 'f.txt'), 'first\nsecond\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'c2']);
    const second = rawGit(repo, ['rev-parse', 'HEAD']).trim();

    const blame = await service.blame({ path: 'f.txt' });

    expect(blame.lines).toHaveLength(2);
    expect(blame.lines[0]).toMatchObject({
      commitShort: first.slice(0, 10),
      author: 'Blame Probe',
      summary: 'c1',
    });
    expect(blame.lines[1].commitShort).toBe(second.slice(0, 10));
    expect(blame.lines[1].summary).toBe('c2');
    expect(blame.lines.map(line => line.lineNumber)).toEqual([1, 2]);
    expect(blame.lines.every(line => line.authoredAt.startsWith('20'))).toBe(true);
  });

  test('uncommitted work is not attributed to a historical author', async () => {
    writeFileSync(join(repo, 'f.txt'), 'committed\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'c1']);
    writeFileSync(join(repo, 'f.txt'), 'committed\nuncommitted\n');

    const blame = await service.blame({ path: 'f.txt' });

    // Working-tree blame covers the uncommitted line; the committed line keeps its author.
    expect(blame.lines[0].summary).toBe('c1');
    expect(blame.lines[1].author).toBe('Not Committed Yet');
    expect(blame.lines[1].summary).not.toBe('c1');
  });

  test('a rev-scoped blame ignores later working-tree changes', async () => {
    writeFileSync(join(repo, 'f.txt'), 'one\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'c1']);
    const head = rawGit(repo, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(repo, 'f.txt'), 'one\ntwo\nthree\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'c2']);

    const blame = await service.blame({ path: 'f.txt', rev: head });
    expect(blame.lines).toHaveLength(1);
    expect(blame.lines[0].commitShort).toBe(head.slice(0, 10));
  });

  test('truncates at the limit and reports it', async () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    writeFileSync(join(repo, 'f.txt'), `${lines.join('\n')}\n`);
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'many']);

    const blame = await service.blame({ path: 'f.txt', limit: 10 });
    expect(blame.lines).toHaveLength(10);
    expect(blame.truncated).toBe(true);
  });

  test('rejects unsafe paths and reads nothing for a missing file', async () => {
    writeFileSync(join(repo, 'f.txt'), 'x\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-q', '-m', 'c1']);

    await expect(service.blame({ path: '../outside' })).rejects.toMatchObject({
      code: 'git_path_unsafe',
    });
    // git refuses a path that does not exist in that tree; surfacing it beats an empty answer.
    await expect(service.blame({ path: 'nope.txt' })).rejects.toMatchObject({
      code: 'git_command_failed',
    });
  });
});
