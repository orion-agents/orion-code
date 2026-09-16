/**
 * v0.3.17 — Git comparison source.
 *
 * Lives in its own module so both the read model service and the diff document parser can
 * depend on it without forming a cycle. A path with an index change *and* a further
 * worktree change (`MM`) is two distinct selectable objects, so the source is part of a
 * Git file identity, not a display attribute.
 */
/**
 * `commit` is not a working-tree state: it identifies a historical comparison (a commit
 * against its base). Plan §6.1 makes the comparison target a first-class field, so it is a
 * distinct value rather than being smuggled in as `staged` or a display flag. It is
 * read-only: no mutation path accepts it (plan G3 keeps history read-only).
 */
export type WebGitFileSourceV1 = 'staged' | 'unstaged' | 'untracked' | 'conflict' | 'commit';

/**
 * The four sources a `git status` record can belong to. A commit comparison is never a
 * working-tree state, so status buckets and counts are typed against this narrower set —
 * adding a comparison source must not force status code to handle an impossible case.
 */
export type GitWorktreeSourceV1 = 'staged' | 'unstaged' | 'untracked' | 'conflict';

export const GIT_WORKTREE_SOURCES_V1: readonly GitWorktreeSourceV1[] = Object.freeze([
  'staged',
  'unstaged',
  'untracked',
  'conflict',
]);

export const GIT_FILE_SOURCES_V1: readonly WebGitFileSourceV1[] = Object.freeze([
  'staged',
  'unstaged',
  'untracked',
  'conflict',
  'commit',
]);

export function isGitFileSourceV1(value: unknown): value is WebGitFileSourceV1 {
  return (
    typeof value === 'string' && (GIT_FILE_SOURCES_V1 as readonly string[]).includes(value)
  );
}
