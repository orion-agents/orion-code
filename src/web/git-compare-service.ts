/**
 * v0.3.17 S5 — branch and version comparison (plan G5).
 *
 * Two modes, and the difference between them is the whole point:
 *   - `snapshot`: the tree difference between A and B;
 *   - `merge-base`: what B introduced since the branches diverged.
 *
 * Semantics this module is responsible for:
 *   - refs are resolved to **commits** before anything else, and the resolved OIDs are part of
 *     the result, so the UI can detect that a ref moved and freeze the opened result instead
 *     of silently comparing against a different tree (plan G5);
 *   - `merge-base --all` with more than one answer is refused — picking one candidate would
 *     present an arbitrary choice as if it were the unique divergence point, so the caller is
 *     told to use the two-endpoint mode instead (plan G5);
 *   - no common ancestor and a shallow clone with missing objects produce distinct, explicit
 *     errors rather than an empty file list that looks like a legitimate answer;
 *   - a ref name is validated before it ever reaches argv: revision expressions, ranges and
 *     pathspec magic are refused.
 */
import { isSensitiveFilePath } from '../services/redaction';
import { WebWorkbenchError } from './errors';

export type GitCompareModeV1 = 'snapshot' | 'merge-base';

export interface GitCompareFileV1 {
  readonly path: string;
  readonly renamedFrom: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
  readonly sensitive: boolean;
}

export interface GitCompareResultV1 {
  readonly mode: GitCompareModeV1;
  readonly requestedBaseRef: string;
  readonly requestedHeadRef: string;
  /** The commits the comparison actually used; the UI freezes the result against these. */
  readonly baseOid: string;
  readonly headOid: string;
  readonly baseLabel: string;
  readonly headLabel: string;
  /** Set only in merge-base mode: the divergence point that was used. */
  readonly mergeBaseOid: string | null;
  readonly files: readonly GitCompareFileV1[];
  readonly additions: number;
  readonly deletions: number;
  readonly truncated: boolean;
}

export interface GitCompareReaderOptions {
  readonly runGit: (args: readonly string[]) => Promise<string>;
}

const REF_NAME_PATTERN = /^[0-9A-Za-z](?:[0-9A-Za-z._/-]{0,250}[0-9A-Za-z])?$/u;
const COMPARE_FILE_LIMIT = 2_000;

/** Resolves a ref-ish name to a commit, refusing anything that is not a plain ref name. */
function assertRefName(value: string, name: string): string {
  if (typeof value !== 'string' || !REF_NAME_PATTERN.test(value) || value.includes('..')) {
    throw new WebWorkbenchError(
      400,
      `${name} must be a branch, tag or commit hash.`,
      'git_ref_invalid'
    );
  }
  return value;
}

async function resolveCommit(
  runGit: (args: readonly string[]) => Promise<string>,
  ref: string
): Promise<string> {
  const resolved = (await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(
    () => ''
  ))
    .toString()
    .trim();
  if (!/^[0-9a-f]{7,64}$/iu.test(resolved)) {
    throw new WebWorkbenchError(
      404,
      `The ref ${ref} could not be resolved to a commit.`,
      'git_ref_not_found'
    );
  }
  return resolved;
}

export function createGitCompareReader(options: GitCompareReaderOptions) {
  const { runGit } = options;

  const numstat = async (base: string, head: string) => {
    const raw = await runGit([
      'diff',
      '--numstat',
      '-z',
      '--no-ext-diff',
      '--no-textconv',
      base,
      head,
    ]);
    const files: GitCompareFileV1[] = [];
    const fields = raw.split('\0');
    let index = 0;
    while (index < fields.length) {
      const record = fields[index];
      index += 1;
      if (!record) continue;
      const [added, deleted, inlinePath] = record.split('\t');
      let path = inlinePath ?? '';
      let renamedFrom: string | null = null;
      if (path === '' && index + 1 < fields.length) {
        renamedFrom = fields[index];
        path = fields[index + 1];
        index += 2;
      }
      if (!path) continue;
      const binary = added === '-' || deleted === '-';
      files.push(
        Object.freeze({
          path,
          renamedFrom: renamedFrom || null,
          additions: binary ? 0 : Number(added) || 0,
          deletions: binary ? 0 : Number(deleted) || 0,
          binary,
          sensitive: isSensitiveFilePath(path),
        })
      );
      if (files.length >= COMPARE_FILE_LIMIT) break;
    }
    return Object.freeze({
      files,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      truncated: files.length >= COMPARE_FILE_LIMIT,
    });
  };

  return {
    /** Validates a pair of refs and returns their commits, without computing anything yet. */
    async resolvePair(baseRef: string, headRef: string) {
      const base = assertRefName(baseRef, 'base');
      const head = assertRefName(headRef, 'head');
      const [baseOid, headOid] = await Promise.all([
        resolveCommit(runGit, base),
        resolveCommit(runGit, head),
      ]);
      return Object.freeze({
        baseRef: base,
        headRef: head,
        baseOid,
        headOid,
        baseLabel: base,
        headLabel: head,
      });
    },

    async compare(input: {
      readonly baseRef: string;
      readonly headRef: string;
      readonly mode: GitCompareModeV1;
    }): Promise<GitCompareResultV1> {
      const pair = await this.resolvePair(input.baseRef, input.headRef);
      const mode: GitCompareModeV1 = input.mode === 'merge-base' ? 'merge-base' : 'snapshot';

      let baseOid = pair.baseOid;
      let mergeBaseOid: string | null = null;
      if (mode === 'merge-base') {
        // `--all` is the honest way to ask: a single answer means one divergence point, and
        // more than one means the question has no unique answer.
        const raw = await runGit(['merge-base', '--all', pair.baseOid, pair.headOid]).catch(error => {
          const message = error instanceof Error ? error.message : '';
          if (/missing|bad object/iu.test(message)) {
            throw new WebWorkbenchError(
              409,
              'The repository does not contain the objects needed for this comparison (a shallow clone?).',
              'git_shallow_history'
            );
          }
          // git exits non-zero with no candidates when the histories are unrelated, and with
          // a diagnostic when objects are missing — those are different failures.
          throw new WebWorkbenchError(
            409,
            'The two refs have no common ancestor; use the two-endpoint comparison instead.',
            'git_merge_base_missing'
          );
        }
        );
        const candidates = raw
          .split('\n')
          .map(line => line.trim())
          .filter(line => /^[0-9a-f]{7,64}$/iu.test(line));
        if (candidates.length === 0) {
          throw new WebWorkbenchError(
            409,
            'The two refs have no common ancestor; use the two-endpoint comparison instead.',
            'git_merge_base_missing'
          );
        }
        if (candidates.length > 1) {
          throw new WebWorkbenchError(
            409,
            `These refs have ${candidates.length} merge bases, so there is no unique divergence point. Use the two-endpoint comparison instead.`,
            'git_merge_base_multiple'
          );
        }
        mergeBaseOid = candidates[0];
        baseOid = mergeBaseOid;
      }

      const stats = await numstat(baseOid, pair.headOid);
      return Object.freeze({
        mode,
        requestedBaseRef: pair.baseRef,
        requestedHeadRef: pair.headRef,
        baseOid,
        headOid: pair.headOid,
        baseLabel:
          mode === 'merge-base' && mergeBaseOid !== null
            ? `共同祖先 ${mergeBaseOid.slice(0, 10)}`
            : pair.baseLabel,
        headLabel: pair.headLabel,
        mergeBaseOid,
        files: stats.files,
        additions: stats.additions,
        deletions: stats.deletions,
        truncated: stats.truncated,
      });
    },
  };
}
