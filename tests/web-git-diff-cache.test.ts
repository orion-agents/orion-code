/**
 * v0.3.17 S2 — bounded Git diff document cache.
 *
 * Added because the §9 baseline measured file switching at ~2x the budget while the HTTP
 * read itself was fast: every switch was re-fetching an unchanged document.
 */
import type { GitDiffDocumentV2 } from '../src/web/git-diff-document';
import { createGitDiffCache } from '../web/src/state/git-diff-cache';

function doc(overrides: Partial<GitDiffDocumentV2> = {}): GitDiffDocumentV2 {
  return {
    schemaVersion: 2,
    fileToken: 'token',
    path: 'src/a.ts',
    source: 'unstaged',
    repositoryRevision: 'rev-1',
    kind: 'text',
    binary: false,
    hunks: [
      {
        hunkId: '0:1:1',
        header: '@@ -1,1 +1,1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        contextLabel: '',
        complete: true,
        lines: [
          {
            lineId: '0:1:1#0',
            kind: 'deletion',
            oldLineNumber: 1,
            newLineNumber: null,
            text: 'old',
            raw: '-old',
          },
        ],
      },
    ],
    meta: [],
    completeness: 'complete',
    additions: 0,
    deletions: 1,
    lineCount: 1,
    nextCursor: null,
    capabilities: {
      stageFile: true,
      unstageFile: false,
      stageHunk: false,
      unstageHunk: false,
      stageLines: false,
    },
    ...overrides,
  };
}

describe('createGitDiffCache', () => {
  test('serves a hit for the same revision and token', () => {
    const cache = createGitDiffCache();
    expect(cache.read('rev-1', 'token')).toBeNull();
    const document = doc();
    cache.write('rev-1', 'token', document);
    expect(cache.read('rev-1', 'token')).toBe(document);
    expect(cache.stats()).toMatchObject({ entries: 1, hits: 1, misses: 1 });
  });

  test('never serves an entry across a repository revision change', () => {
    const cache = createGitDiffCache();
    cache.write('rev-1', 'token', doc());
    // A new revision must be a miss: stale diff content is a correctness problem, not a
    // performance one.
    expect(cache.read('rev-2', 'token')).toBeNull();
  });

  test('never serves one file token under another', () => {
    const cache = createGitDiffCache();
    cache.write('rev-1', 'token-a', doc());
    expect(cache.read('rev-1', 'token-b')).toBeNull();
  });

  test('evicts least recently used entries to stay inside the byte budget', () => {
    // Two entries of a few hundred bytes each, with a budget that only fits one.
    const cache = createGitDiffCache({ maxBytes: 400, maxEntryBytes: 10_000 });
    cache.write('rev-1', 'a', doc());
    cache.write('rev-1', 'b', doc());
    cache.write('rev-1', 'c', doc());
    const stats = cache.stats();
    expect(stats.bytes).toBeLessThanOrEqual(400);
    // The most recent write survives, the oldest does not.
    expect(cache.read('rev-1', 'c')).not.toBeNull();
    expect(cache.read('rev-1', 'a')).toBeNull();
  });

  test('refreshes recency on read so a hot entry is not evicted first', () => {
    // One entry is ~329 bytes, so 700 fits two and forces an eviction on the third.
    const cache = createGitDiffCache({ maxBytes: 700, maxEntryBytes: 10_000 });
    cache.write('rev-1', 'a', doc());
    cache.write('rev-1', 'b', doc());
    // Touch `a` so it becomes the most recently used and `b` becomes the eviction target.
    expect(cache.read('rev-1', 'a')).not.toBeNull();
    cache.write('rev-1', 'c', doc());
    expect(cache.read('rev-1', 'a')).not.toBeNull();
    expect(cache.read('rev-1', 'b')).toBeNull();
  });

  test('refuses to cache a single oversized document', () => {
    const cache = createGitDiffCache({ maxBytes: 1024 * 1024, maxEntryBytes: 64 });
    cache.write('rev-1', 'token', doc());
    expect(cache.stats().entries).toBe(0);
    expect(cache.read('rev-1', 'token')).toBeNull();
  });

  test('rewriting the same key does not double count bytes', () => {
    const cache = createGitDiffCache();
    cache.write('rev-1', 'token', doc());
    const first = cache.stats().bytes;
    cache.write('rev-1', 'token', doc());
    expect(cache.stats()).toMatchObject({ entries: 1, bytes: first });
  });

  test('clear drops everything', () => {
    const cache = createGitDiffCache();
    cache.write('rev-1', 'token', doc());
    cache.clear();
    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0 });
  });
});
