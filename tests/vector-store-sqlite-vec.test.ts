/**
 * Issue #47: sqlite-vec extension was never loaded, so semantic memory search
 * silently degraded to LIKE; and failed embeddings became zero vectors that
 * ranked #1. These tests require the better-sqlite3 native binding (and the
 * sqlite-vec dylib) to be present, so they are skipped where that binding is
 * unavailable (e.g. CI/sandbox without a matching prebuilt binary).
 */
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VectorStore } from '../src/memory/vector-store';
import { resetEmbeddingService } from '../src/memory/embeddings';

// Probe for the native binding once; if absent, skip the whole suite.
let SQLITE_AVAILABLE = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3');
  const probe = new Database(':memory:');
  probe.close();
  SQLITE_AVAILABLE = true;
} catch {
  SQLITE_AVAILABLE = false;
}

const describeIf = SQLITE_AVAILABLE ? describe : describe.skip;
describeIf('VectorStore sqlite-vec loading (Issue #47)', () => {
  let dbPath = '';
  let store: VectorStore | null = null;

  beforeEach(() => {
    resetEmbeddingService();
    const dir = mkdtempSync(join(tmpdir(), 'orion-vec-'));
    dbPath = join(dir, 'vector.db');
  });

  afterEach(() => {
    try {
      store?.close();
    } catch {
      /* noop */
    }
    store = null;
    if (dbPath) rmSync(join(dbPath, '..'), { recursive: true, force: true });
  });

  test('sqlite-vec is loaded so vector search becomes available (core #47 fix)', () => {
    // provider 'openai' with no API key => embed() yields a zero vector, but
    // the extension itself must load regardless of the embedding provider.
    store = new VectorStore({
      dbPath,
      embeddingConfig: { provider: 'openai' },
    });
    expect(store.isVectorSearchAvailable()).toBe(true);
  });

  test('degenerate (zero) embeddings are not stored as vectors (#47 item 2)', async () => {
    store = new VectorStore({
      dbPath,
      embeddingConfig: { provider: 'openai' }, // no key => embed() returns zeros
    });
    expect(store.isVectorSearchAvailable()).toBe(true);

    // A zero-query / zero-stored-vector pairing would otherwise rank #1 at
    // score 1.0. With the guard, no vector is stored, so a semantic search
    // over this single memory returns nothing instead of a bogus top hit.
    await store.upsert({
      name: 'note',
      type: 'reference',
      content: 'some memory content',
      description: 'a reference note',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const results = await store.search('some memory content', 10);
    expect(results).toEqual([]);
  });

  test('re-upserting the same memory keeps a single vector (no orphan/duplicate, #81)', async () => {
    store = new VectorStore({
      dbPath,
      embeddingConfig: { provider: 'openai' },
    });
    expect(store.isVectorSearchAvailable()).toBe(true);

    const entry = {
      name: 'dup',
      type: 'reference' as const,
      content: 'duplicated memory',
      description: 'a reference note',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await store.upsert(entry);
    await store.upsert(entry); // second upsert must replace, not duplicate

    // The combined memory+vector transaction deletes the prior vector before
    // inserting the new one, so re-upserting yields exactly one vector row.
    expect(store.getAll().length).toBe(1);
  });
});
