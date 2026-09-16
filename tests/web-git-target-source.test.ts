/**
 * v0.3.17 S0 — regression net for the confirmed Git work-panel gaps.
 *
 * Every assertion below describes the CORRECT contract from
 * `docs/plan/v0.3.17-plan.md` §3 / §6.1. They are written first and are expected to
 * FAIL on the `codex/v0.3.17` baseline; S1 turns them green and they stay as the net.
 *
 *   G1  a mixed file (`MM`) shares one fileId across staged/unstaged and returns one
 *       merged diff page, so the two comparison sources cannot be told apart.
 *   G2  Git mutations resolve file ids through FileReadService, so a real Git list
 *       token cannot be staged.
 *   G3  mutations report `rev-parse HEAD` as `repositoryRevision`, which is a different
 *       value space from `status().repositoryRevision` and never reflects index state.
 *
 * G4 (`WorkspaceRepositorySnapshotStore` has no production wiring) is owned by S3 per
 * plan §10; it is recorded in the S0 evidence document instead of asserted here.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { WorkspaceRegistryV1 } from '../src/services/workspace-registry';
import { GitReadModelServiceV1 } from '../src/web/git-read-model-service';
import { WebWorkbenchController } from '../src/web/workbench-controller';
import { createFakeWebRuntime } from './support/web-runtime';

const STAGED_SECTION = '## Staged';
const WORKTREE_SECTION = '## Working tree';

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function porcelain(cwd: string): string {
  return git(cwd, ['status', '--porcelain=v1']);
}

describe('v0.3.17 Git target/source contract (S0 regression net)', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'oc317-git-target-')));
    repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'target@probe.local']);
    git(repo, ['config', 'user.name', 'Target Probe']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Commits `mixed.txt`, then produces index=M / worktree=M so both sources differ. */
  function stageMixedFile(): void {
    writeFileSync(join(repo, 'mixed.txt'), 'line one\n');
    git(repo, ['add', 'mixed.txt']);
    git(repo, ['commit', '-q', '-m', 'baseline']);
    // index change
    writeFileSync(join(repo, 'mixed.txt'), 'line one\nstaged-line\n');
    git(repo, ['add', 'mixed.txt']);
    // further worktree-only change
    writeFileSync(join(repo, 'mixed.txt'), 'line one\nstaged-line\nworktree-line\n');
  }

  test('G1 a mixed file exposes one distinguishable source per comparison target', async () => {
    stageMixedFile();
    const service = new GitReadModelServiceV1(repo);

    const status = await service.status();
    expect(porcelain(repo)).toContain('MM mixed.txt');

    const stagedEntry = status.staged.find(file => file.path === 'mixed.txt');
    const unstagedEntry = status.unstaged.find(file => file.path === 'mixed.txt');
    expect(stagedEntry).toBeDefined();
    expect(unstagedEntry).toBeDefined();

    // A shared id makes "which source am I looking at" unanswerable in the UI.
    expect(stagedEntry?.fileId).not.toBe(unstagedEntry?.fileId);
  });

  test('G1 each source returns only its own diff, not a merged page', async () => {
    stageMixedFile();
    const service = new GitReadModelServiceV1(repo);

    const status = await service.status();
    const stagedEntry = status.staged.find(file => file.path === 'mixed.txt');
    const unstagedEntry = status.unstaged.find(file => file.path === 'mixed.txt');
    expect(stagedEntry).toBeDefined();
    expect(unstagedEntry).toBeDefined();

    const stagedDiff = await service.diff({ fileId: stagedEntry?.fileId ?? '' });
    const stagedText = stagedDiff.lines.join('\n');
    expect(stagedText).toContain('staged-line');
    expect(stagedText).not.toContain('worktree-line');
    expect(stagedText).not.toContain(WORKTREE_SECTION);

    const unstagedDiff = await service.diff({ fileId: unstagedEntry?.fileId ?? '' });
    const unstagedText = unstagedDiff.lines.join('\n');
    expect(unstagedText).toContain('worktree-line');
    expect(unstagedText).not.toContain(STAGED_SECTION);
  });

  test('G3 a mutation reports a repository revision in the same value space as status', async () => {
    writeFileSync(join(repo, 'tracked.txt'), 'baseline\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-q', '-m', 'baseline']);
    writeFileSync(join(repo, 'tracked.txt'), 'baseline\nchange\n');

    const service = new GitReadModelServiceV1(repo);
    const before = await service.status();

    const staged = await service.stagePaths(['tracked.txt']);
    const afterStage = await service.status();

    // `rev-parse HEAD` (40 hex) can never equal the status digest (64 hex).
    expect(staged.repositoryRevision).toBe(afterStage.repositoryRevision);
    expect(afterStage.repositoryRevision).not.toBe(before.repositoryRevision);

    const unstaged = await service.unstagePaths(['tracked.txt']);
    // HEAD is unchanged by stage/unstage, so an index-aware revision must still differ.
    expect(unstaged.repositoryRevision).not.toBe(staged.repositoryRevision);
  });

  test('G3 commit separates the state revision from the commit oid', async () => {
    writeFileSync(join(repo, 'tracked.txt'), 'baseline\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-q', '-m', 'baseline']);
    writeFileSync(join(repo, 'tracked.txt'), 'baseline\ncommitted change\n');
    git(repo, ['add', 'tracked.txt']);

    const service = new GitReadModelServiceV1(repo);
    // v0.3.17 S3 — a commit is bound to the state the form showed and carries a requestId
    // so a retry can be answered from the idempotency ledger instead of replaying blindly.
    const result = await service.commit({
      summary: 'test: commit a change',
      expectedRepositoryRevision: (await service.status()).repositoryRevision,
      requestId: 's0-g3-commit-1',
    });

    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/u);
    // A commit oid is not a repository state version.
    expect(result.repositoryRevision).not.toBe(result.commitSha);

    const after = await service.status();
    expect(result.repositoryRevision).toBe(after.repositoryRevision);
  });

  test('G2 a Git list token can be staged through the controller', async () => {
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git(repo, ['add', 'base.txt']);
    git(repo, ['commit', '-q', '-m', 'baseline']);
    writeFileSync(join(repo, 'base.txt'), 'base\nchanged\n');

    const registry = new WorkspaceRegistryV1({ storagePath: join(root, 'registry.json') });
    registry.registerKnown([repo], repo);
    const controller = await WebWorkbenchController.create({
      cwd: repo,
      workspaceRegistry: registry,
      createRuntime: async (cwd: string) => createFakeWebRuntime(cwd),
    });
    try {
      const bootstrap = controller.bootstrap('target-nonce');
      const guard = {
        expectedContextRevision: bootstrap.contextRevision,
        workspaceId: bootstrap.workspaceId,
      };

      const status = await controller.gitStatus(guard, {});
      const entry = status.unstaged.find(file => file.path === 'base.txt');
      expect(entry).toBeDefined();

      // The token came from the Git service, so the Git mutation path must accept it.
      const result = await controller.gitStage(guard, {
        fileIds: [entry?.fileId ?? ''],
        expectedRepositoryRevision: status.repositoryRevision,
      });
      expect(result).toBeDefined();
      expect(porcelain(repo)).toContain('M  base.txt');
    } finally {
      await controller.shutdown();
    }
  });
});
