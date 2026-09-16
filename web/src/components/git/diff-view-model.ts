/**
 * v0.3.17 S2 — pure view model for the structured diff reader.
 *
 * Kept free of React so the tricky parts (side-by-side alignment, change anchors, find
 * matching across both sides) can be asserted directly.
 */
import type { GitDiffLineV2, GitHunkV2 } from '../../../../src/web/git-diff-document';

export interface SideBySideRow {
  readonly key: string;
  /** Null when this side has no line for the row (an added or removed counterpart). */
  readonly left: GitDiffLineV2 | null;
  readonly right: GitDiffLineV2 | null;
  readonly changed: boolean;
}

export type DiffRenderRow =
  | { readonly kind: 'hunk-header'; readonly hunk: GitHunkV2 }
  | { readonly kind: 'folded'; readonly hunk: GitHunkV2 }
  | { readonly kind: 'unified-line'; readonly hunk: GitHunkV2; readonly line: GitDiffLineV2 }
  | { readonly kind: 'side-by-side'; readonly hunk: GitHunkV2; readonly row: SideBySideRow };

/**
 * Aligns a hunk into side-by-side rows.
 *
 * Within one run of removals followed by additions, lines are paired index-wise so a
 * replacement shows old and new on the same row. Unpaired lines leave the other side empty
 * rather than shifting context, which is what makes the two gutters line up.
 */
export function buildSideBySideRows(hunk: GitHunkV2): readonly SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let index = 0;
  const lines = hunk.lines;

  while (index < lines.length) {
    const line = lines[index];
    if (line.kind === 'deletion') {
      const removals: GitDiffLineV2[] = [];
      while (index < lines.length && lines[index].kind === 'deletion') {
        removals.push(lines[index]);
        index += 1;
      }
      const additions: GitDiffLineV2[] = [];
      while (index < lines.length && lines[index].kind === 'addition') {
        additions.push(lines[index]);
        index += 1;
      }
      const pairs = Math.max(removals.length, additions.length);
      for (let pair = 0; pair < pairs; pair += 1) {
        const left = removals[pair] ?? null;
        const right = additions[pair] ?? null;
        rows.push(
          Object.freeze({
            key: `${hunk.hunkId}:${left?.lineId ?? `-${pair}`}:${right?.lineId ?? `-${pair}`}`,
            left,
            right,
            changed: true,
          })
        );
      }
      continue;
    }
    if (line.kind === 'addition') {
      // An addition with no preceding removal still occupies the right side only.
      rows.push(
        Object.freeze({
          key: `${hunk.hunkId}:${line.lineId}`,
          left: null,
          right: line,
          changed: true,
        })
      );
      index += 1;
      continue;
    }
    rows.push(
      Object.freeze({
        key: `${hunk.hunkId}:${line.lineId}`,
        left: line,
        right: line,
        changed: false,
      })
    );
    index += 1;
  }
  return rows;
}

/** The rows a reader actually sees, honouring folded hunks. */
export function buildRenderRows(
  hunks: readonly GitHunkV2[],
  collapsedHunks: readonly string[],
  mode: 'unified' | 'side-by-side'
): readonly DiffRenderRow[] {
  const collapsed = new Set(collapsedHunks);
  const rows: DiffRenderRow[] = [];
  for (const hunk of hunks) {
    rows.push(Object.freeze({ kind: 'hunk-header' as const, hunk }));
    if (collapsed.has(hunk.hunkId)) {
      rows.push(Object.freeze({ kind: 'folded' as const, hunk }));
      continue;
    }
    if (mode === 'side-by-side') {
      for (const row of buildSideBySideRows(hunk)) {
        rows.push(Object.freeze({ kind: 'side-by-side' as const, hunk, row }));
      }
      continue;
    }
    for (const line of hunk.lines) {
      rows.push(Object.freeze({ kind: 'unified-line' as const, hunk, line }));
    }
  }
  return rows;
}

export interface ChangeAnchor {
  readonly lineId: string;
  readonly hunkId: string;
  readonly oldLineNumber: number | null;
  readonly newLineNumber: number | null;
}

/**
 * One anchor per contiguous run of changed lines. This is what F7 / the toolbar arrows walk,
 * replacing the old "one tab per hunk" navigation that could not reach a specific change in
 * a long hunk.
 */
export function changeAnchors(hunks: readonly GitHunkV2[]): readonly ChangeAnchor[] {
  const anchors: ChangeAnchor[] = [];
  for (const hunk of hunks) {
    let previousChanged = false;
    for (const line of hunk.lines) {
      const changed = line.kind === 'addition' || line.kind === 'deletion';
      if (changed && !previousChanged) {
        anchors.push(
          Object.freeze({
            lineId: line.lineId,
            hunkId: hunk.hunkId,
            oldLineNumber: line.oldLineNumber,
            newLineNumber: line.newLineNumber,
          })
        );
      }
      previousChanged = changed;
    }
  }
  return anchors;
}

export interface DiffFindMatch {
  readonly lineId: string;
  readonly hunkId: string;
  readonly side: 'old' | 'new' | 'both';
}

/** Case-insensitive literal search over the loaded document. */
export function findInDocument(
  hunks: readonly GitHunkV2[],
  query: string,
  limit = 500
): readonly DiffFindMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: DiffFindMatch[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (matches.length >= limit) return matches;
      if (!line.text.toLowerCase().includes(needle)) continue;
      matches.push(
        Object.freeze({
          lineId: line.lineId,
          hunkId: hunk.hunkId,
          side:
            line.oldLineNumber !== null && line.newLineNumber !== null
              ? 'both'
              : line.oldLineNumber !== null
                ? 'old'
                : 'new',
        })
      );
    }
  }
  return matches;
}

export interface DiffStats {
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: number;
}

export function diffStats(hunks: readonly GitHunkV2[]): DiffStats {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'addition') additions += 1;
      else if (line.kind === 'deletion') deletions += 1;
    }
  }
  return Object.freeze({ additions, deletions, hunks: hunks.length });
}

/** Expands the text for display; the copy path always uses `line.raw`. */
export function displayText(text: string, showWhitespace: boolean): string {
  if (!showWhitespace) return text;
  return text.replace(/\t/gu, '→\t').replace(/ +$/gu, spaces => '·'.repeat(spaces.length));
}

export function markerFor(kind: GitDiffLineV2['kind']): string {
  if (kind === 'addition') return '+';
  if (kind === 'deletion') return '-';
  if (kind === 'meta') return '\\';
  return ' ';
}

/** Review context for one hunk, built from the raw lines so nothing is invented. */
export function buildHunkReviewContext(
  input: {
    readonly path: string;
    readonly source: string;
    readonly repositoryRevision: string;
  },
  hunk: GitHunkV2
): string {
  const metadata = {
    schemaVersion: 2,
    type: 'review_context',
    repositoryRevision: input.repositoryRevision,
    path: input.path,
    source: input.source,
    hunk: hunk.header,
    hunkId: hunk.hunkId,
    complete: hunk.complete,
  } as const;
  const body = hunk.lines
    .map(line => line.raw)
    .join('\n')
    .slice(0, 12_000);
  return [
    `请审阅 ${input.path} 的这个 diff hunk，并指出正确性、安全性和测试风险：`,
    '',
    '```review_context',
    JSON.stringify(metadata, null, 2),
    '```',
    '',
    '```diff',
    body,
    '```',
  ].join('\n');
}
