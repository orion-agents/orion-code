import { createHash } from 'crypto';

import type { VerifiedDurableToolReceiptRefV1 } from '../runtime/durable-tool-receipt-reader';
import type {
  GitReadModelServiceV1,
  WebGitDiffPageV1,
  WebGitFileV1,
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
    const [status, receiptRefs] = await Promise.all([
      this.git.status({ pageSize: 2_000 }),
      this.listReceiptRefs(),
    ]);
    const changedFiles = uniqueFiles([
      ...status.conflicted,
      ...status.staged,
      ...status.unstaged,
      ...status.untracked,
    ]);
    const verification = receiptRefs.slice(0, 100).map(receipt =>
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
      stagedCount: status.staged.length,
      unstagedCount: status.unstaged.length,
      untrackedCount: status.untracked.length,
      conflictCount: status.conflicted.length,
      truncated: status.truncated,
      verification: Object.freeze(verification),
    });
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
