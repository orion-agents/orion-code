/**
 * v0.3.17 S2 — bounded document cache for the Git diff reader.
 *
 * The §9 baseline showed the "switch back and forth between cached files" budget failing at
 * p50 ≈ 199ms while `/git/diff-v2` itself costs ≈86ms p50: every switch was re-fetching a
 * document that had not changed. Plan §9 asks for ≤100ms and explicitly says the same
 * version body must not be pulled twice, so the reader keeps a small LRU instead.
 *
 * Deliberate properties:
 *   - Keyed by repository revision *and* file token. A new revision can never serve stale
 *     content, and a stale entry simply falls out of use rather than needing invalidation.
 *   - Byte-budgeted, not entry-budgeted: a 20MiB ceiling on rendered documents, and any
 *     single document above 5MiB is never cached.
 *   - Only documents from a complete or paged read are cached, and an incomplete document is
 *     cached under its own revision so a later page does not resurrect a partial body.
 */
import type { GitDiffDocumentV2 } from '../../../src/web/git-diff-document';

export const GIT_DIFF_CACHE_MAX_BYTES = 20 * 1024 * 1024;
export const GIT_DIFF_CACHE_MAX_ENTRY_BYTES = 5 * 1024 * 1024;

export interface GitDiffCache {
  read(repositoryRevision: string, fileToken: string): GitDiffDocumentV2 | null;
  write(repositoryRevision: string, fileToken: string, document: GitDiffDocumentV2): void;
  clear(): void;
  /** Diagnostics for the perf harness; not used by the reader. */
  stats(): { readonly entries: number; readonly bytes: number; readonly hits: number; readonly misses: number };
}

/** Cheap and stable: what the reader would have to transfer again. */
function estimateBytes(document: GitDiffDocumentV2): number {
  let bytes = 0;
  for (const hunk of document.hunks) {
    bytes += hunk.header.length;
    for (const line of hunk.lines) bytes += line.raw.length + 48;
  }
  return bytes + document.path.length + 256;
}

export function createGitDiffCache(options?: {
  readonly maxBytes?: number;
  readonly maxEntryBytes?: number;
}): GitDiffCache {
  const maxBytes = options?.maxBytes ?? GIT_DIFF_CACHE_MAX_BYTES;
  const maxEntryBytes = options?.maxEntryBytes ?? GIT_DIFF_CACHE_MAX_ENTRY_BYTES;
  /** Insertion-ordered, so the first key is the least recently used. */
  const entries = new Map<string, { readonly document: GitDiffDocumentV2; readonly bytes: number }>();
  let bytes = 0;
  let hits = 0;
  let misses = 0;

  const keyOf = (revision: string, token: string) => `${revision}\u0000${token}`;

  return {
    read(revision, token) {
      const key = keyOf(revision, token);
      const entry = entries.get(key);
      if (!entry) {
        misses += 1;
        return null;
      }
      // Refresh recency: re-insert so it moves to the end of the iteration order.
      entries.delete(key);
      entries.set(key, entry);
      hits += 1;
      return entry.document;
    },
    write(revision, token, document) {
      const size = estimateBytes(document);
      // Oversized bodies are served straight from the network every time on purpose: the
      // cache exists to make small switches cheap, not to pin large payloads in memory.
      if (size > maxEntryBytes) return;
      const key = keyOf(revision, token);
      const existing = entries.get(key);
      if (existing) {
        entries.delete(key);
        bytes -= existing.bytes;
      }
      entries.set(key, { document, bytes: size });
      bytes += size;
      while (bytes > maxBytes && entries.size > 0) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        const evicted = entries.get(oldest.value);
        entries.delete(oldest.value);
        bytes -= evicted?.bytes ?? 0;
      }
    },
    clear() {
      entries.clear();
      bytes = 0;
    },
    stats() {
      return { entries: entries.size, bytes, hits, misses };
    },
  };
}

/** Shared by the app; tests build their own instance. */
export const appGitDiffCache: GitDiffCache = createGitDiffCache();
