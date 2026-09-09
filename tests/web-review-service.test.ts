import type {
  GitReadModelServiceV1,
  WebGitDiffPageV1,
  WebGitFileV1,
  WebGitStatusV1,
} from '../src/web/git-read-model-service';
import { ReviewServiceV1 } from '../src/web/review-service';

describe('ReviewServiceV1', () => {
  const changedFile: WebGitFileV1 = Object.freeze({
    fileId: 'git_file_1',
    path: 'src/example.ts',
    indexStatus: 'M',
    worktreeStatus: 'M',
  });

  test('builds a deduplicated, bounded snapshot from Git facts', async () => {
    const status = gitStatus({
      staged: [changedFile],
      unstaged: [changedFile],
      totalFiles: 1,
      truncated: true,
      nextCursor: 'next-status',
    });
    const git = fakeGit([status, gitStatus({ totalFiles: 1 })]);
    const service = new ReviewServiceV1(git);

    const snapshot = await service.snapshot();

    expect(snapshot).toMatchObject({
      repositoryRevision: 'repository-revision',
      isRepository: true,
      clean: false,
      totalChangedFiles: 1,
      stagedCount: 1,
      unstagedCount: 1,
      untrackedCount: 0,
      conflictCount: 0,
      truncated: false,
    });
    expect(snapshot.changedFiles).toEqual([changedFile]);
    expect(snapshot.revision).toMatch(/^[0-9a-f]{64}$/u);
    await expect(service.snapshot()).resolves.toMatchObject({ revision: snapshot.revision });
  });

  test('aggregates every Git status page for repositories larger than one page (issues #237/#228)', async () => {
    const visible = Array.from(
      { length: 2_000 },
      (_, index): WebGitFileV1 =>
        Object.freeze({
          fileId: `git_file_${index}`,
          path: `generated/file-${index.toString().padStart(4, '0')}.ts`,
          indexStatus: ' ',
          worktreeStatus: '?',
        })
    );
    const tail: WebGitFileV1 = Object.freeze({
      fileId: 'git_file_2000',
      path: 'generated/file-2000.ts',
      indexStatus: ' ',
      worktreeStatus: '?',
    });
    const git = fakeGit([
      gitStatus({
        untracked: Object.freeze(visible),
        totalFiles: 2_001,
        truncated: true,
        nextCursor: 'next-status',
      }),
      gitStatus({
        untracked: Object.freeze([tail]),
        totalFiles: 2_001,
        truncated: false,
        nextCursor: null,
      }),
    ]);
    const service = new ReviewServiceV1(git);

    const snapshot = await service.snapshot();

    expect(snapshot.totalChangedFiles).toBe(2_001);
    expect(snapshot.changedFiles).toHaveLength(2_001);
    expect(snapshot.untrackedCount).toBe(2_001);
    expect(snapshot.truncated).toBe(false);
    expect(git.status).toHaveBeenCalledTimes(2);
    expect(git.status).toHaveBeenNthCalledWith(1, { pageSize: 2_000 });
    expect(git.status).toHaveBeenNthCalledWith(2, { cursor: 'next-status', pageSize: 2_000 });
  });

  test('delegates bounded diff reads without manufacturing transcript-derived review state', async () => {
    const page: WebGitDiffPageV1 = Object.freeze({
      fileId: changedFile.fileId,
      path: changedFile.path,
      repositoryRevision: 'repository-revision',
      binary: false,
      lines: Object.freeze(['@@ -1 +1 @@', '-before', '+after']),
      nextCursor: null,
      truncated: false,
    });
    const diff = jest.fn().mockResolvedValue(page);
    // v0.3.14 removed the verification-evidence loader — the service owns the
    // git read model alone.
    const service = new ReviewServiceV1(fakeGit([gitStatus()], diff));

    await expect(service.diff({ fileId: changedFile.fileId, lineLimit: 20 })).resolves.toBe(page);
    expect(diff).toHaveBeenCalledWith({ fileId: changedFile.fileId, lineLimit: 20 });
  });
});

function gitStatus(overrides: Partial<WebGitStatusV1> = {}): WebGitStatusV1 {
  return Object.freeze({
    isRepository: true,
    repositoryRevision: 'repository-revision',
    branch: 'main',
    detached: false,
    head: '0123456789ab',
    upstream: null,
    ahead: 0,
    behind: 0,
    clean: false,
    staged: Object.freeze([]),
    unstaged: Object.freeze([]),
    untracked: Object.freeze([]),
    conflicted: Object.freeze([]),
    totalFiles: 0,
    truncated: false,
    nextCursor: null,
    ...overrides,
  });
}

/**
 * v0.3.9 — paging-aware Git fake: returns each page in turn, then an empty
 * terminal page so ReviewServiceV1's page loop terminates.
 */
function fakeGit(pages: readonly WebGitStatusV1[], diff = jest.fn()): GitReadModelServiceV1 {
  const queue = [...pages];
  const status = jest.fn().mockImplementation(() => {
    const next = queue.shift();
    if (next) return Promise.resolve(next);
    return Promise.resolve(gitStatus());
  });
  return { status, diff } as unknown as GitReadModelServiceV1;
}
