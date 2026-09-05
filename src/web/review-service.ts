import { createHash } from 'crypto';

import type { VerifiedDurableToolReceiptRefV1 } from '../runtime/durable-tool-receipt-reader';
import type {
  GitReadModelServiceV1,
  WebGitDiffPageV1,
  WebGitFileV1,
  WebGitStatusV1,
} from './git-read-model-service';

export interface WebReviewVerificationV1 {
  readonly callId: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly sequence: number;
  readonly toolName: string;
  readonly state: 'success' | 'error' | 'skipped';
  readonly terminal: VerifiedDurableToolReceiptRefV1['terminal'];
  readonly success: boolean;
  readonly outputBytes: number;
  readonly hasArtifact: boolean;
  readonly executionPolicyDigest: string;
  readonly receiptDigest: string;
}

export interface WebReviewSnapshotV1 {
  readonly revision: string;
  readonly repositoryRevision: string;
  readonly isRepository: boolean;
  readonly clean: boolean;
  readonly changedFiles: readonly WebGitFileV1[];
  readonly totalChangedFiles: number;
  readonly stagedCount: number;
  readonly unstagedCount: number;
  readonly untrackedCount: number;
  readonly conflictCount: number;
  readonly truncated: boolean;
  readonly verification: readonly WebReviewVerificationV1[];
}

/** Review overview composed only from Git facts and doubly verified durable tool receipts. */
export class ReviewServiceV1 {
  constructor(
    private readonly git: GitReadModelServiceV1,
    private readonly listReceiptRefs: () =>
      | Promise<readonly VerifiedDurableToolReceiptRefV1[]>
      | readonly VerifiedDurableToolReceiptRefV1[]
  ) {}

  async snapshot(): Promise<WebReviewSnapshotV1> {
    // v0.3.9 #237/#228 — collect every Git status page. A repository with more
    // than the single pageSize of changed files was silently truncated before;
    // the review overview must aggregate all pages (bounded by a guard that
    // keeps runaway repositories from looping forever).
    const [receiptRefs, statusPages] = await Promise.all([
      this.listReceiptRefs(),
      collectStatusPages((cursor: string | undefined) =>
        this.git.status({ pageSize: 2_000, ...(cursor ? { cursor } : {}) })
      ),
    ]);
    const status = statusPages.at(-1) ?? (await this.git.status({ pageSize: 2_000 }));
    const conflicted: WebGitFileV1[] = [];
    const staged: WebGitFileV1[] = [];
    const unstaged: WebGitFileV1[] = [];
    const untracked: WebGitFileV1[] = [];
    for (const page of statusPages) {
      conflicted.push(...page.conflicted);
      staged.push(...page.staged);
      unstaged.push(...page.unstaged);
      untracked.push(...page.untracked);
    }
    const changedFiles = uniqueFiles([...conflicted, ...staged, ...unstaged, ...untracked]);
    const verification = this.projectVerification(receiptRefs.slice(0, 100));
    const revision = createHash('sha256')
      .update(
        JSON.stringify({
          repositoryRevision: status.repositoryRevision,
          verification,
        })
      )
      .digest('hex');
    return Object.freeze({
      revision,
      repositoryRevision: status.repositoryRevision,
      isRepository: status.isRepository,
      clean: status.clean,
      changedFiles: Object.freeze(changedFiles),
      totalChangedFiles: status.totalFiles,
      stagedCount: staged.length,
      unstagedCount: unstaged.length,
      untrackedCount: untracked.length,
      conflictCount: conflicted.length,
      truncated: statusPages.at(-1)?.truncated ?? false,
      verification: Object.freeze(verification),
    });
  }

  /**
   * v0.3.12 S2 — progressive verification evidence. The Review summary loads
   * first; receipts page in behind it, optionally filtered to one session.
   */
  async verificationPage(input: {
    readonly sessionId?: string;
    readonly cursor?: number;
    readonly pageSize?: number;
  }): Promise<{
    readonly items: readonly WebReviewVerificationV1[];
    readonly nextCursor: number | null;
    readonly totalForSession: number;
  }> {
    const refs = await this.listReceiptRefs();
    const filtered = input.sessionId ? refs.filter(ref => ref.sessionId === input.sessionId) : refs;
    const offset = Math.max(0, Math.min(filtered.length, Math.trunc(input.cursor ?? 0)));
    const pageSize = Math.max(1, Math.min(100, Math.trunc(input.pageSize ?? 25)));
    const page = filtered.slice(offset, offset + pageSize);
    const nextCursor = offset + page.length < filtered.length ? offset + page.length : null;
    return Object.freeze({
      items: Object.freeze(this.projectVerification(page)),
      nextCursor,
      totalForSession: filtered.length,
    });
  }

  private projectVerification(
    refs: readonly VerifiedDurableToolReceiptRefV1[]
  ): WebReviewVerificationV1[] {
    return refs.map(receipt =>
      Object.freeze({
        callId: receipt.callId,
        sessionId: receipt.sessionId,
        threadId: receipt.threadId,
        sequence: receipt.sequence,
        toolName: receipt.toolName,
        state: reviewState(receipt),
        terminal: receipt.terminal,
        success: receipt.success,
        outputBytes: receipt.outputBytes,
        hasArtifact: receipt.hasArtifact,
        executionPolicyDigest: receipt.executionPolicyDigest,
        receiptDigest: receipt.receiptDigest,
      })
    );
  }

  diff(input: Parameters<GitReadModelServiceV1['diff']>[0]): Promise<WebGitDiffPageV1> {
    return this.git.diff(input);
  }
}

function reviewState(receipt: VerifiedDurableToolReceiptRefV1): WebReviewVerificationV1['state'] {
  if (receipt.success) return 'success';
  return receipt.terminal === 'interrupted' || receipt.terminal === 'indeterminate'
    ? 'skipped'
    : 'error';
}

function uniqueFiles(files: readonly WebGitFileV1[]): WebGitFileV1[] {
  const byId = new Map<string, WebGitFileV1>();
  for (const file of files) byId.set(file.fileId, file);
  return [...byId.values()].sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * v0.3.9 #237/#228 — page through Git status until the snapshot is fully
 * collected. The bounded guard (64 pages x 2_000 = 128k files) exists to stop
 * runaway repositories from looping; a repository exceeding it stays marked
 * truncated so the UI can still communicate the limit.
 */
async function collectStatusPages(
  fetchPage: (cursor: string | undefined) => Promise<WebGitStatusV1>
): Promise<readonly WebGitStatusV1[]> {
  const pages: WebGitStatusV1[] = [];
  let page = await fetchPage(undefined);
  pages.push(page);
  let guard = 0;
  while (page.truncated && page.nextCursor && guard < 64) {
    page = await fetchPage(page.nextCursor);
    pages.push(page);
    guard += 1;
  }
  return pages;
}
