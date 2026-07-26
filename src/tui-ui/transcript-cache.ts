/**
 * Transcript layout cache — avoids re-laying-out committed entries on every
 * render. Only entries that changed (new, updated, or resize-invalidated)
 * are re-processed.
 *
 * Bounded by generation: when transcript generation increments (replace/clear),
 * the entire cache is discarded. Within a generation, entries are cached by
 * their (id, revision) pair. Resize invalidates all cached rows.
 *
 * Resource limit: MAX_CACHE_SIZE entries. LRU eviction when exceeded.
 */

import type { StyledRow } from '../tui-core/style';

export interface TranscriptCacheEntry {
  id: string;
  revision: number;
  themeId: string;
  rows: StyledRow[];
}

const MAX_CACHE_SIZE = 256;

export class TranscriptLayoutCache {
  private cache = new Map<string, TranscriptCacheEntry>();
  private lastGeneration = -1;
  private lastWidth = -1;
  private lastThemeId = '';

  /** Get cached rows for an entry, or null if not cached / stale. */
  get(
    id: string,
    revision: number,
    generation: number,
    width: number,
    themeId = 'default',
  ): StyledRow[] | null {
    if (
      generation !== this.lastGeneration
      || width !== this.lastWidth
      || themeId !== this.lastThemeId
    ) {
      this.invalidate(generation, width, themeId);
      return null;
    }
    const entry = this.cache.get(id);
    if (!entry || entry.revision !== revision || entry.themeId !== themeId) return null;
    // Promote to most-recently-used.
    this.cache.delete(id);
    this.cache.set(id, entry);
    return entry.rows;
  }

  /** Store layout result for an entry. */
  set(
    id: string,
    revision: number,
    rows: StyledRow[],
    generation: number,
    width: number,
    themeId = 'default',
  ): void {
    if (
      generation !== this.lastGeneration
      || width !== this.lastWidth
      || themeId !== this.lastThemeId
    ) {
      this.invalidate(generation, width, themeId);
    }
    // Evict oldest if at capacity.
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(id, { id, revision, themeId, rows });
  }

  /** Full invalidation on generation change or resize. */
  invalidate(generation: number, width: number, themeId = 'default'): void {
    this.cache.clear();
    this.lastGeneration = generation;
    this.lastWidth = width;
    this.lastThemeId = themeId;
  }

  /** Current cache size (for testing). */
  get size(): number {
    return this.cache.size;
  }

  /** Reset the cache entirely. */
  clear(): void {
    this.cache.clear();
    this.lastGeneration = -1;
    this.lastWidth = -1;
    this.lastThemeId = '';
  }
}
