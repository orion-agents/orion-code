/**
 * v0.3.17 S2 — structured diff reader view model.
 *
 * These are the parts that are easy to get subtly wrong: side-by-side alignment, change
 * anchors, and fold behaviour. No renderer needed.
 */
import type { GitDiffLineV2, GitHunkV2 } from '../src/web/git-diff-document';
import {
  buildRenderRows,
  buildSideBySideRows,
  changeAnchors,
  diffStats,
  displayText,
  findInDocument,
  markerFor,
} from '../web/src/components/git/diff-view-model';

function line(
  kind: GitDiffLineV2['kind'],
  oldLineNumber: number | null,
  newLineNumber: number | null,
  text: string,
  lineId = `${kind}-${oldLineNumber ?? 'x'}-${newLineNumber ?? 'x'}-${text}`
): GitDiffLineV2 {
  return Object.freeze({
    lineId,
    kind,
    oldLineNumber,
    newLineNumber,
    text,
    raw: kind === 'addition' ? `+${text}` : kind === 'deletion' ? `-${text}` : ` ${text}`,
  });
}

function hunk(hunkId: string, lines: readonly GitDiffLineV2[]): GitHunkV2 {
  return Object.freeze({
    hunkId,
    header: `@@ -1,${lines.length} +1,${lines.length} @@`,
    oldStart: 1,
    oldLines: lines.length,
    newStart: 1,
    newLines: lines.length,
    contextLabel: '',
    lines: Object.freeze([...lines]),
    complete: true,
  });
}

describe('buildSideBySideRows', () => {
  test('pairs a replacement onto one row and clears the unused side', () => {
    const rows = buildSideBySideRows(
      hunk('h', [
        line('context', 1, 1, 'keep'),
        line('deletion', 2, null, 'old a'),
        line('deletion', 3, null, 'old b'),
        line('addition', null, 2, 'new a'),
        line('context', 4, 3, 'tail'),
      ])
    );

    expect(rows).toHaveLength(4);
    // Replacement: old a ↔ new a on one row, then the unpaired deletion.
    expect(rows[1]).toMatchObject({ changed: true });
    expect(rows[1].left?.text).toBe('old a');
    expect(rows[1].right?.text).toBe('new a');
    expect(rows[2].left?.text).toBe('old b');
    expect(rows[2].right).toBeNull();
    // Context keeps both sides so the gutters stay aligned.
    expect(rows[3]).toMatchObject({ changed: false });
    expect(rows[3].left?.text).toBe('tail');
    expect(rows[3].right?.text).toBe('tail');
  });

  test('gives an addition with no removal a right-side-only row', () => {
    const rows = buildSideBySideRows(
      hunk('h', [line('context', 1, 1, 'a'), line('addition', null, 2, 'brand new')])
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ changed: true, left: null });
    expect(rows[1].right?.text).toBe('brand new');
  });

  test('keeps every rendered row addressable by a unique key', () => {
    const rows = buildSideBySideRows(
      hunk('h', [
        line('deletion', 1, null, 'a'),
        line('addition', null, 1, 'A'),
        line('deletion', 2, null, 'b'),
        line('addition', null, 2, 'B'),
      ])
    );
    const keys = rows.map(row => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('buildRenderRows', () => {
  const first = hunk('h1', [line('context', 1, 1, 'a'), line('addition', null, 2, 'b')]);
  const second = hunk('h2', [line('deletion', 1, null, 'c')]);

  test('emits a header per hunk and every line in unified mode', () => {
    const rows = buildRenderRows([first, second], [], 'unified');
    expect(rows.map(row => row.kind)).toEqual([
      'hunk-header',
      'unified-line',
      'unified-line',
      'hunk-header',
      'unified-line',
    ]);
  });

  test('replaces a folded hunk body with a single folded row', () => {
    const rows = buildRenderRows([first, second], ['h1'], 'unified');
    expect(rows.map(row => row.kind)).toEqual([
      'hunk-header',
      'folded',
      'hunk-header',
      'unified-line',
    ]);
  });

  test('emits aligned rows in side-by-side mode', () => {
    const rows = buildRenderRows([first], [], 'side-by-side');
    expect(rows.map(row => row.kind)).toEqual([
      'hunk-header',
      'side-by-side',
      'side-by-side',
    ]);
  });
});

describe('changeAnchors', () => {
  test('yields one anchor per contiguous change run, not per hunk', () => {
    const anchor = changeAnchors([
      hunk('h', [
        line('context', 1, 1, 'a'),
        line('deletion', 2, null, 'b'),
        line('addition', null, 2, 'B'),
        line('context', 3, 3, 'c'),
        line('addition', null, 4, 'd'),
      ]),
    ]);
    // The deletion + addition pair is one change; the trailing addition is a second one.
    expect(anchor).toHaveLength(2);
    expect(anchor[0].lineId).toBe('deletion-2-x-b');
    expect(anchor[1].lineId).toBe('addition-x-4-d');
    expect(anchor[1].hunkId).toBe('h');
  });

  test('returns nothing for a purely contextual hunk', () => {
    expect(changeAnchors([hunk('h', [line('context', 1, 1, 'a')])])).toEqual([]);
  });
});

describe('findInDocument', () => {
  test('is case-insensitive, literal and reports which side matched', () => {
    const matches = findInDocument(
      [
        hunk('h', [
          line('context', 1, 1, 'Needle here'),
          line('deletion', 2, null, 'needle removed'),
          line('addition', null, 2, 'unrelated'),
        ]),
      ],
      'NEEDLE'
    );
    expect(matches).toHaveLength(2);
    expect(matches[0].side).toBe('both');
    expect(matches[1].side).toBe('old');
  });

  test('treats a blank query as no search and respects the match budget', () => {
    expect(findInDocument([hunk('h', [line('context', 1, 1, 'a')])], '   ')).toEqual([]);
    const many = hunk(
      'h',
      Array.from({ length: 20 }, (_, index) =>
        line('context', index + 1, index + 1, `hit ${index}`, `id-${index}`)
      )
    );
    expect(findInDocument([many], 'hit', 5)).toHaveLength(5);
  });
});

describe('diffStats and display helpers', () => {
  test('counts additions, deletions and hunks', () => {
    const stats = diffStats([
      hunk('h1', [
        line('addition', null, 1, 'a'),
        line('deletion', 1, null, 'b'),
        line('context', 2, 2, 'c'),
      ]),
      hunk('h2', [line('addition', null, 3, 'd')]),
    ]);
    expect(stats).toEqual({ additions: 2, deletions: 1, hunks: 2 });
  });

  test('only marks whitespace when asked, and never mutates the source text', () => {
    const text = 'value\t=\t1   ';
    expect(displayText(text, false)).toBe(text);
    // Every tab is marked, and trailing spaces become middle dots.
    expect(displayText(text, true)).toBe('value→\t=→\t1···');
    expect(markerFor('addition')).toBe('+');
    expect(markerFor('deletion')).toBe('-');
    expect(markerFor('context')).toBe(' ');
    expect(markerFor('meta')).toBe('\\');
  });
});
