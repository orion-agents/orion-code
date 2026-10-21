/**
 * v0.3.27 PR1 — integration tests for the review snapshot reader and the
 * read-only workflow constraints, driven against real temporary git
 * repositories (plan §9.1: real Git objects, staged/unstaged splits on the
 * same file, rename tracking, frozen merge-base, budget skips, mid-review
 * mutation detection, and the deny-by-default tool guard).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REVIEW_WORKFLOW_CONSTRAINTS,
  ReviewToolPolicyError,
  assertReviewToolAllowed,
} from '../src/services/code-review/constraints';
import {
  ReviewSnapshotError,
  captureReviewSnapshot,
  createContainedWorktreeReader,
  type ReviewGitRunner,
} from '../src/services/code-review/snapshot';

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runner(cwd: string): ReviewGitRunner {
  return async (args: readonly string[]) => git(cwd, args);
}

describe('v0.3.27 PR1 — review snapshot reader', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orion-review-snap-')));
    repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'review@probe.local']);
    git(repo, ['config', 'user.name', 'Review Probe']);
    writeFileSync(join(repo, 'base.txt'), 'one\ntwo\nthree\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'baseline']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('worktree scope records staged and unstaged sides of the same file separately', async () => {
    // A staged edit and a further unstaged edit to the same file.
    writeFileSync(join(repo, 'base.txt'), 'one\ntwo changed\nthree\n');
    git(repo, ['add', 'base.txt']);
    writeFileSync(join(repo, 'base.txt'), 'one\ntwo changed again\nthree\n');

    const snapshot = await captureReviewSnapshot({
      root: repo,
      selector: { kind: 'worktree' },
      runGit: runner(repo),
      readWorktreeFile: createContainedWorktreeReader(repo),
    });

    expect(snapshot.kind).toBe('worktree');
    const file = snapshot.files.find(entry => entry.path === 'base.txt');
    expect(file).toBeTruthy();
    const sources = (file?.sides ?? []).map(side => side.source);
    expect(sources).toContain('staged');
    expect(sources).toContain('unstaged');
    const staged = file?.sides.find(side => side.source === 'staged');
    const unstaged = file?.sides.find(side => side.source === 'unstaged');
    expect(staged?.contentDigest).not.toBe(unstaged?.contentDigest);
    // The unstaged side carries the working content (two changed again).
    expect(unstaged?.byteSize).toBe(Buffer.byteLength('one\ntwo changed again\nthree\n', 'utf8'));
  });

  test('base scope freezes ref, HEAD and merge-base into immutable OIDs', async () => {
    git(repo, ['checkout', '-q', '-b', 'topic']);
    writeFileSync(join(repo, 'base.txt'), 'one\ntwo\nthree changed\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'topic edit']);

    const before = await captureReviewSnapshot({
      root: repo,
      selector: { kind: 'base', ref: 'topic' },
      runGit: runner(repo),
    });
    expect(before.kind).toBe('base');
    expect(before.baseOid).toBeTruthy();
    expect(before.headOid).toBeTruthy();

    // Moving the branch afterwards cannot change the frozen input identity.
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'drift after snapshot']);
    const after = await captureReviewSnapshot({
      root: repo,
      selector: { kind: 'base', ref: 'topic' },
      runGit: runner(repo),
    });
    // A fresh capture sees the moved tip; the ORIGINAL snapshot's identity is
    // the frozen pair of OIDs, which is what the receipt stores.
    expect(after.headOid).not.toBe(before.headOid);
    expect(before.baseOid).toBeTruthy();
    expect(before.inputSnapshotDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rename tracking carries the old path in the base scope', async () => {
    git(repo, ['checkout', '-q', '-b', 'topic']);
    git(repo, ['mv', 'base.txt', 'renamed.txt']);
    git(repo, ['commit', '-q', '-m', 'rename base']);

    // HEAD sits on topic; the base ref (main) resolves merge-base(main, topic)
    // and the diff walks that frozen OID up to HEAD.
    const snapshot = await captureReviewSnapshot({
      root: repo,
      selector: { kind: 'base', ref: 'main' },
      runGit: runner(repo),
    });

    const file = snapshot.files.find(entry => entry.path === 'renamed.txt');
    expect(file).toBeTruthy();
    expect(file?.oldPath).toBe('base.txt');
    // Both sides resolve by OID: the old path on the base side, the new path
    // on the head side.
    const sides = (file?.sides ?? []).map(side => side.source).sort();
    expect(sides).toEqual(['base', 'head']);
  });

  test('path filtering restricts the snapshot to the requested subtree', async () => {
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'export {};\n');
    writeFileSync(join(repo, 'docs.md'), 'docs\n');
    git(repo, ['add', '.']);

    const snapshot = await captureReviewSnapshot({
      root: repo,
      selector: { kind: 'worktree', paths: ['src'] },
      runGit: runner(repo),
    });

    expect(snapshot.files.map(file => file.path)).toEqual(['src/a.ts']);
    expect(snapshot.files.find(file => file.path === 'docs.md')).toBeUndefined();
  });

  test('sensitive files are skipped, never read into the snapshot', async () => {
    writeFileSync(join(repo, '.env'), 'SECRET_TOKEN=abc\n');
    git(repo, ['add', '.env']);

    const snapshot = await captureReviewSnapshot({
      root: repo,
      selector: { kind: 'worktree' },
      runGit: runner(repo),
    });

    expect(snapshot.files.find(file => file.path === '.env')).toBeUndefined();
    expect(snapshot.skipped).toMatchObject([{ path: '.env', reason: 'sensitive' }]);
  });

  test('a working file mutated mid-snapshot fails loudly instead of freezing half the content', async () => {
    writeFileSync(join(repo, 'base.txt'), 'one\ntwo\nthree edited\n');
    let reads = 0;
    const mutatingReader = async (relativePath: string): Promise<string | null> => {
      if (relativePath !== 'base.txt') return null;
      reads += 1;
      return reads === 1 ? 'first content\n' : 'second content\n';
    };

    await expect(
      captureReviewSnapshot({
        root: repo,
        selector: { kind: 'worktree' },
        runGit: runner(repo),
        readWorktreeFile: mutatingReader,
      })
    ).rejects.toMatchObject({ code: 'worktree_changed' });
  });

  test('tightened file budgets skip the excess with a typed reason', async () => {
    for (let index = 0; index < 3; index += 1) {
      writeFileSync(join(repo, `file-${index}.txt`), `content ${index}\n`);
    }
    git(repo, ['add', '.']);

    const snapshot = await captureReviewSnapshot({
      root: repo,
      selector: { kind: 'worktree' },
      budgets: { maxFiles: 1 },
      runGit: runner(repo),
    });

    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.skipped.filter(skip => skip.reason === 'over_budget_files')).toHaveLength(2);
  });

  test('base scope errors are typed and actionable', async () => {
    await expect(
      captureReviewSnapshot({
        root: repo,
        selector: { kind: 'base', ref: 'no-such-branch' },
        runGit: runner(repo),
      })
    ).rejects.toMatchObject({ code: 'ref_unresolved' });

    // Unrelated histories have no merge base: an orphan branch with its own
    // root commit shares nothing with main.
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'main advances']);
    git(repo, ['checkout', '-q', '--orphan', 'island']);
    git(repo, ['rm', '-rfq', '.']);
    writeFileSync(join(repo, 'island.txt'), 'island\n');
    git(repo, ['add', 'island.txt']);
    git(repo, ['commit', '-q', '-m', 'island root']);
    git(repo, ['checkout', '-q', 'main']);
    rmSync(join(repo, 'island.txt'), { force: true });
    await expect(
      captureReviewSnapshot({
        root: repo,
        selector: { kind: 'base', ref: 'island' },
        runGit: runner(repo),
      })
    ).rejects.toMatchObject({ code: 'no_merge_base' });
  });

  test('the contained worktree reader refuses to escape the repository', async () => {
    const outside = join(root, 'outside-secret.txt');
    writeFileSync(outside, 'secret\n');
    rmSync(join(repo, 'base.txt'));
    writeFileSync(join(repo, 'link.txt'), 'placeholder\n');
    rmSync(join(repo, 'link.txt'));
    try {
      execFileSync('ln', ['-s', outside, join(repo, 'link.txt')]);
    } catch {
      // Filesystems without symlink support skip this assertion naturally.
    }
    const reader = createContainedWorktreeReader(repo);
    expect(await reader('base.txt')).toBeNull();
    expect(await reader('link.txt')).toBeNull();
  });
});

describe('v0.3.27 PR1 — read-only workflow constraints', () => {
  test('the four read tools are allowed and everything else is denied by default', () => {
    for (const tool of ['read_file', 'list_files', 'glob', 'grep']) {
      expect(() => assertReviewToolAllowed(tool)).not.toThrow();
    }
    for (const tool of [
      'exec_command',
      'write_file',
      'edit_file',
      'mcp_call',
      'web_fetch',
      'spawn_task',
      'update_settings',
      'totally_unknown_tool',
    ]) {
      expect(() => assertReviewToolAllowed(tool)).toThrow(ReviewToolPolicyError);
    }
  });

  test('the constraint digest is deterministic and binds the policy text', () => {
    const first = REVIEW_WORKFLOW_CONSTRAINTS.constraintsDigest;
    const again = REVIEW_WORKFLOW_CONSTRAINTS.constraintsDigest;
    expect(first).toBe(again);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(REVIEW_WORKFLOW_CONSTRAINTS.policy).toContain('never widen');
  });
});
