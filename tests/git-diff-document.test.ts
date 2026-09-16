/**
 * v0.3.17 S2 — structured diff document parser.
 *
 * The model is what makes side-by-side rendering, hunk folding and "jump to next change"
 * possible without re-parsing text in the browser, and it is the shape hunk/line level
 * writes will consume in S3. Pure input → output, plus one real-repository round trip.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { parseGitDiffDocument } from '../src/web/git-diff-document';
import { GitReadModelServiceV1 } from '../src/web/git-read-model-service';

function parse(lines: readonly string[], overrides: Partial<Parameters<typeof parseGitDiffDocument>[0]> = {}) {
  return parseGitDiffDocument({
    fileToken: 'git_token',
    path: 'src/example.ts',
    source: 'unstaged',
    repositoryRevision: 'rev-1',
    lines,
    hasMore: false,
    nextCursor: null,
    ...overrides,
  });
}

describe('parseGitDiffDocument', () => {
  test('derives real old and new line numbers for every line kind', () => {
    const doc = parse([
      'diff --git a/src/example.ts b/src/example.ts',
      'index 1111111..2222222 100644',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -10,4 +10,5 @@ export function example() {',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '+const c = 4;',
      ' return a;',
      ' }',
    ]);

    expect(doc.kind).toBe('text');
    expect(doc.hunks).toHaveLength(1);
    const hunk = doc.hunks[0];
    expect(hunk).toMatchObject({
      oldStart: 10,
      oldLines: 4,
      newStart: 10,
      newLines: 5,
      contextLabel: 'export function example() {',
      complete: true,
    });

    // Old side runs 10..13, new side 10..14.
    expect(hunk.lines.map(line => [line.kind, line.oldLineNumber, line.newLineNumber])).toEqual([
      ['context', 10, 10],
      ['deletion', 11, null],
      ['addition', null, 11],
      ['addition', null, 12],
      ['context', 12, 13],
      ['context', 13, 14],
    ]);
    expect(doc.additions).toBe(2);
    expect(doc.deletions).toBe(1);

    // Text never carries the +/- marker, raw always does.
    const deletion = hunk.lines[1];
    expect(deletion.text).toBe('const b = 2;');
    expect(deletion.raw).toBe('-const b = 2;');
  });

  test('keeps document headers as metadata and never as hunk lines', () => {
    const doc = parse([
      '## Staged',
      'diff --git a/a.txt b/a.txt',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/a.txt',
      '@@ -0,0 +1 @@',
      '+hello',
    ]);
    expect(doc.meta).toEqual([
      '## Staged',
      'diff --git a/a.txt b/a.txt',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/a.txt',
    ]);
    expect(doc.hunks).toHaveLength(1);
    expect(doc.hunks[0].lines).toHaveLength(1);
    expect(doc.hunks[0].lines[0]).toMatchObject({ kind: 'addition', newLineNumber: 1 });
  });

  test('splits multiple hunks and keeps line ids unique per hunk', () => {
    const doc = parse([
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '@@ -20,2 +20,3 @@ second',
      ' x',
      '+y',
      ' z',
    ]);
    expect(doc.hunks).toHaveLength(2);
    expect(doc.hunks[1]).toMatchObject({ oldStart: 20, newStart: 20, contextLabel: 'second' });

    const ids = doc.hunks.flatMap(hunk => hunk.lines.map(line => line.lineId));
    expect(new Set(ids).size).toBe(ids.length);
    // Ids are namespaced by their hunk so a client can address a line unambiguously.
    expect(doc.hunks[0].lines[0].lineId.startsWith('0:1:1#')).toBe(true);
    expect(doc.hunks[1].lines[0].lineId.startsWith('1:20:20#')).toBe(true);
  });

  test('marks the trailing hunk incomplete when the page cut it', () => {
    // Header promises 2 new lines, body carries 1 → readonly consumers must not write it.
    const doc = parse(
      ['@@ -1,1 +1,2 @@', ' a', '+b'],
      { hasMore: true, nextCursor: 'cursor-1' }
    );
    expect(doc.completeness).toBe('paged');
    expect(doc.hunks[0].complete).toBe(true);
    expect(doc.nextCursor).toBe('cursor-1');

    const cut = parse(['@@ -1,1 +1,3 @@', ' a', '+b']);
    expect(cut.completeness).toBe('limited');
    expect(cut.hunks[0].complete).toBe(false);
  });

  test('reports binary and metadata documents without inventing hunks', () => {
    const binary = parse(['diff --git a/logo.png b/logo.png', 'Binary files a/logo.png and b/logo.png differ']);
    expect(binary.kind).toBe('binary');
    expect(binary.binary).toBe(true);
    expect(binary.hunks).toEqual([]);
    expect(binary.completeness).toBe('complete');

    const modeOnly = parse([
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
    ]);
    expect(modeOnly.kind).toBe('metadata');
    expect(modeOnly.hunks).toEqual([]);
    expect(modeOnly.meta).toContain('old mode 100644');
  });

  test('carries the write capability of the comparison source', () => {
    const unstaged = parse([], { source: 'unstaged' });
    expect(unstaged.capabilities).toMatchObject({
      stageFile: true,
      unstageFile: false,
      stageHunk: false,
      stageLines: false,
    });
    expect(unstaged.capabilities.reason).toMatch(/S3/u);

    const staged = parse([], { source: 'staged' });
    expect(staged.capabilities).toMatchObject({ stageFile: false, unstageFile: true });

    // Conflicts are deliberately not writable in this version.
    const conflict = parse([], { source: 'conflict' });
    expect(conflict.capabilities).toMatchObject({
      stageFile: false,
      unstageFile: false,
      stageHunk: false,
      stageLines: false,
    });
    expect(conflict.capabilities.reason).toMatch(/冲突/u);

    // An unchanged (empty) document is still a complete answer.
    expect(parse([], { source: 'untracked' }).completeness).toBe('complete');
  });

  test('handles the no-newline marker and blank context lines', () => {
    const doc = parse([
      '@@ -1,3 +1,3 @@',
      ' first',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
      ' ',
    ]);
    const kinds = doc.hunks[0].lines.map(line => line.kind);
    expect(kinds).toEqual(['context', 'deletion', 'meta', 'addition', 'meta', 'context']);
    // The deletion consumed old 2 and the addition consumed new 2, so the blank context
    // line lands on 3 on both sides.
    const blank = doc.hunks[0].lines[5];
    expect(blank).toMatchObject({ oldLineNumber: 3, newLineNumber: 3, text: '' });
  });

  test('fails closed on a line that is not a valid unified-diff line', () => {
    // Real Git output always prefixes hunk bodies with ' ', '+' or '-'. If that does not
    // hold, the parser must not guess: it keeps the line as metadata and reports the hunk
    // incomplete, because a wrong completeness claim is what would let a partial write
    // through later.
    const doc = parse(['@@ -1,2 +1,2 @@', ' keep', 'stray']);
    expect(doc.hunks[0].lines.map(line => line.kind)).toEqual(['context', 'meta']);
    expect(doc.hunks[0].complete).toBe(false);
    expect(doc.completeness).toBe('limited');
  });

  test('treats a second file boundary inside one page as metadata, not hunk content', () => {
    const doc = parse([
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A',
      'diff --git a/other.txt b/other.txt',
      '--- a/other.txt',
      '+++ b/other.txt',
      '@@ -1,1 +1,2 @@',
      ' keep',
      '+added',
    ]);
    expect(doc.hunks).toHaveLength(2);
    expect(doc.meta).toEqual([
      'diff --git a/other.txt b/other.txt',
      '--- a/other.txt',
      '+++ b/other.txt',
    ]);
  });
});

describe('GitReadModelServiceV1.diffDocument', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'oc317-doc-')));
    repo = join(root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'doc@probe.local'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Doc Probe'], { cwd: repo });
    writeFileSync(join(repo, 'src.ts'), ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'].join('\n') + '\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: repo });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('produces a structured document that matches the file on disk', async () => {
    // Change line 2 (worktree only) and line 4 (index), leaving a mixed file.
    writeFileSync(
      join(repo, 'src.ts'),
      ['line 1', 'line 2 changed', 'line 3', 'line 4', 'line 5'].join('\n') + '\n'
    );
    execFileSync('git', ['add', 'src.ts'], { cwd: repo });
    writeFileSync(
      join(repo, 'src.ts'),
      ['line 1', 'line 2 changed', 'line 3', 'line 4 changed', 'line 5'].join('\n') + '\n'
    );

    const service = new GitReadModelServiceV1(repo);
    const status = await service.status();
    const unstagedEntry = status.unstaged.find(file => file.path === 'src.ts');
    expect(unstagedEntry).toBeTruthy();

    const doc = await service.diffDocument({ fileId: unstagedEntry?.fileId ?? '' });
    expect(doc).toMatchObject({
      schemaVersion: 2,
      source: 'unstaged',
      kind: 'text',
      completeness: 'complete',
    });
    expect(doc.repositoryRevision).toBe(status.repositoryRevision);

    const changed = doc.hunks.flatMap(hunk =>
      hunk.lines.filter(line => line.kind !== 'context').map(line => line.text)
    );
    // Only the worktree edit belongs to the unstaged comparison.
    expect(changed).toContain('line 4 changed');
    expect(changed.join('\n')).not.toContain('line 2 changed');

    // Line numbers point at the real new-file positions.
    const addition = doc.hunks[0].lines.find(line => line.kind === 'addition');
    expect(addition?.newLineNumber).toBe(4);
    expect(addition?.oldLineNumber).toBeNull();
  });
});
