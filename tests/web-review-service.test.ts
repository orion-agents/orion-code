import type { VerifiedDurableToolReceiptRefV1 } from '../src/runtime/durable-tool-receipt-reader';
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

  test('builds a deduplicated, bounded snapshot from Git and durable verification facts', async () => {
    const status = gitStatus({
      staged: [changedFile],
      unstaged: [changedFile],
      totalFiles: 1,
      truncated: true,
      nextCursor: 'next-status',
    });
    const receipts = Array.from(
      { length: 101 },
      (_, index): VerifiedDurableToolReceiptRefV1 => ({
        callId: `call-${index}`,
        sessionId: 'session-1',
        threadId: 'thread-1',
        sequence: index,
        toolName: index % 2 ? 'exec_command' : 'write_file',
        terminal: index === 0 ? 'failed' : 'completed',
        success: index !== 0,
        outputBytes: index * 10,
        hasArtifact: index % 3 === 0,
        executionPolicyDigest: index === 0 ? 'a'.repeat(64) : `${index}`.padStart(64, 'a'),
        receiptDigest: index === 0 ? 'b'.repeat(64) : `${index}`.padStart(64, 'b'),
        finishedAt: 1_700_000_000_000 - index,
      })
    );
    const git = fakeGit(status);
    const service = new ReviewServiceV1(git, async () => receipts);

    const snapshot = await service.snapshot();

    expect(snapshot).toMatchObject({
      repositoryRevision: 'repository-revision',
      isRepository: true,
      clean: false,
      stagedCount: 1,
      unstagedCount: 1,
      untrackedCount: 0,
      conflictCount: 0,
      truncated: true,
    });
    expect(snapshot.changedFiles).toEqual([changedFile]);
    expect(snapshot.verification).toHaveLength(100);
    expect(snapshot.verification[0]).toEqual({
      callId: 'call-0',
      sessionId: 'session-1',
      threadId: 'thread-1',
      sequence: 0,
      toolName: 'write_file',
      state: 'error',
      terminal: 'failed',
      success: false,
      outputBytes: 0,
      hasArtifact: true,
      executionPolicyDigest: 'a'.repeat(64),
      receiptDigest: 'b'.repeat(64),
    });
    expect(snapshot.revision).toMatch(/^[0-9a-f]{64}$/u);
    await expect(service.snapshot()).resolves.toMatchObject({ revision: snapshot.revision });
  });

  test('binds the Review revision to the authoritative receipt references', async () => {
    const base: VerifiedDurableToolReceiptRefV1 = {
      callId: 'call-bound',
      sessionId: 'session-bound',
      threadId: 'thread-bound',
      sequence: 7,
      toolName: 'exec_command',
      terminal: 'completed',
      success: true,
      outputBytes: 2,
      hasArtifact: false,
      executionPolicyDigest: 'a'.repeat(64),
      receiptDigest: 'b'.repeat(64),
      finishedAt: 1_700_000_000_000,
    };
    let receipts: readonly VerifiedDurableToolReceiptRefV1[] = [base];
    const service = new ReviewServiceV1(fakeGit(gitStatus()), async () => receipts);

    const first = await service.snapshot();
    receipts = [{ ...base, receiptDigest: 'c'.repeat(64) }];
    const second = await service.snapshot();

    expect(second.revision).not.toBe(first.revision);
    expect(second.verification[0].receiptDigest).toBe('c'.repeat(64));
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
    const service = new ReviewServiceV1(fakeGit(gitStatus(), diff), async () => []);

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

function fakeGit(status: WebGitStatusV1, diff = jest.fn()): GitReadModelServiceV1 {
  return {
    status: jest.fn().mockResolvedValue(status),
    diff,
  } as unknown as GitReadModelServiceV1;
}
