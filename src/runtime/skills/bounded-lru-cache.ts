export interface BoundedLruCacheOptions<T> {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly ttlMs: number;
  readonly sizeOf: (value: T) => number;
  readonly now?: () => number;
}

export interface BoundedLruCacheStats {
  readonly entries: number;
  readonly bytes: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly ttlMs: number;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly bytes: number;
  readonly expiresAt: number;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

/** Entry-count, byte, and TTL bounded LRU used by lazy runtime resources. */
export class BoundedLruCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly sizeOf: (value: T) => number;
  private readonly now: () => number;
  private bytesValue = 0;

  constructor(options: BoundedLruCacheOptions<T>) {
    this.maxEntries = positiveInteger(options.maxEntries, 'LRU maxEntries');
    this.maxBytes = positiveInteger(options.maxBytes, 'LRU maxBytes');
    this.ttlMs = nonNegativeInteger(options.ttlMs, 'LRU ttlMs');
    this.sizeOf = options.sizeOf;
    this.now = options.now ?? Date.now;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): boolean {
    const bytes = nonNegativeInteger(this.sizeOf(value), 'LRU entry bytes');
    this.delete(key);
    if (bytes > this.maxBytes || this.ttlMs === 0) return false;

    this.entries.set(key, {
      value,
      bytes,
      expiresAt: this.now() + this.ttlMs,
    });
    this.bytesValue += bytes;
    this.evictOverflow();
    return this.entries.has(key);
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.bytesValue -= entry.bytes;
    return true;
  }

  deleteWhere(predicate: (key: string) => boolean): number {
    let deleted = 0;
    for (const key of [...this.entries.keys()]) {
      if (predicate(key) && this.delete(key)) deleted++;
    }
    return deleted;
  }

  clear(): void {
    this.entries.clear();
    this.bytesValue = 0;
  }

  stats(): BoundedLruCacheStats {
    this.removeExpired();
    return Object.freeze({
      entries: this.entries.size,
      bytes: this.bytesValue,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      ttlMs: this.ttlMs,
    });
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.delete(key);
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries || this.bytesValue > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.delete(oldest.value);
    }
  }
}
