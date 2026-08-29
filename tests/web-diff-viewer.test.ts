import { buildReviewContext, splitHunks } from '../web/src/components/git/diff-hunks';

describe('Web DiffViewer hunk projection', () => {
  it('does not expose section and Git headers as a selectable pseudo-hunk', () => {
    expect(
      splitHunks([
        '## Working tree',
        'diff --git a/example.ts b/example.ts',
        '--- a/example.ts',
        '+++ b/example.ts',
        '@@ -1,2 +1,2 @@',
        '-before',
        '+after',
        '@@ -10,1 +10,2 @@',
        ' context',
        '+added',
      ])
    ).toEqual([
      {
        title: '@@ -1,2 +1,2 @@',
        lines: ['@@ -1,2 +1,2 @@', '-before', '+after'],
      },
      {
        title: '@@ -10,1 +10,2 @@',
        lines: ['@@ -10,1 +10,2 @@', ' context', '+added'],
      },
    ]);
  });

  it('returns no selectable hunk when a page contains metadata only', () => {
    expect(splitHunks(['## Staged', 'diff --git a/a b/a', 'Binary files differ'])).toEqual([]);
  });

  it('builds an explicit structured review_context without submitting it', () => {
    const value = buildReviewContext(
      { path: 'src/example.ts', repositoryRevision: 'revision-1' },
      { title: '@@ -1 +1 @@', lines: ['@@ -1 +1 @@', '-old', '+new'] }
    );

    expect(value).toContain('```review_context');
    expect(value).toContain('"type": "review_context"');
    expect(value).toContain('"repositoryRevision": "revision-1"');
    expect(value).toContain('```diff\n@@ -1 +1 @@\n-old\n+new\n```');
  });
});
