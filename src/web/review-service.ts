import { createHash } from 'crypto';

import type {
  GitReadModelServiceV1,
  WebGitDiffPageV1,
  WebGitFileV1,
  WebGitStatusV1,
} from './git-read-model-service';

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
}

/** Review overview composed only from Git facts. */
export class ReviewServiceV1 {
  constructor(private readonly git: GitReadModelServiceV1) {}

  async snapshot(): Promise<WebReviewSnapshotV1> {
    // v0.3.9 #237/#228 — collect every Git status page. A repository with more
    // than the single pageSize of changed files was silently truncated before;
    // the review overview must aggregate all pages (bounded by a guard that
    // keeps runaway repositories from looping forever).
    const statusPages = await collectStatusPages((cursor: string | undefined) =>
      this.git.status({ pageSize: 2_000, ...(cursor ? { cursor } : {}) })
    );
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
    const revision = createHash('sha256')
      .update(JSON.stringify({ repositoryRevision: status.repositoryRevision }))
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
    });
  }

  diff(input: Parameters<GitReadModelServiceV1['diff']>[0]): Promise<WebGitDiffPageV1> {
    return this.git.diff(input);
  }
}

function uniqueFiles(files: readonly WebGitFileV1[]): WebGitFileV1[] {
  const byId = new Map<string, WebGitFileV1>();
  for (const file of files) byId.set(file.fileId, file);
  return [...byId.values()].sort((left, right) => left.path.localeCompare(right.path));
}

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
