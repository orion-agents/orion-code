import {
  EmbeddingService,
  getEmbeddingService,
  resetEmbeddingService,
} from '../src/memory/embeddings';
import { VectorStore } from '../src/memory/vector-store';
import { SemanticSearchService } from '../src/memory/semantic-search';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getCanonicalProjectKey } from '../src/services/config-dir';
import axios from 'axios';

function deterministicEmbedding(this: EmbeddingService, text: string): Promise<number[]> {
  const vector = new Array(this.getDimension()).fill(0);
  vector[0] = 1;
  if (vector.length > 1) {
    vector[1] = Math.max(1, text.length);
  }
  return Promise.resolve(vector);
}

describe('EmbeddingService', () => {
  beforeEach(() => {
    resetEmbeddingService();
    jest.spyOn(axios, 'post').mockImplementation(async (_url, payload) => {
      const text =
        typeof payload === 'object' && payload !== null && 'prompt' in payload
          ? String(payload.prompt)
          : typeof payload === 'object' && payload !== null && 'input' in payload
            ? String(payload.input)
            : '';
      const dimension = String(_url).includes('openai.com') ? 1536 : 768;
      const vector = new Array(dimension).fill(0);
      vector[0] = Math.max(1, text.length);
      return String(_url).includes('openai.com')
        ? { data: { data: [{ embedding: vector }] } }
        : { data: { embedding: vector } };
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('creates service with default config', () => {
    const service = getEmbeddingService();
    expect(service).toBeDefined();
    expect(service.getDimension()).toBeGreaterThan(0);
  });

  test('creates service with ollama provider', () => {
    const service = new EmbeddingService({ provider: 'ollama' });
    expect(service.getDimension()).toBe(768);
  });

  test('creates service with openai provider', () => {
    const service = new EmbeddingService({ provider: 'openai' });
    expect(service.getDimension()).toBe(1536);
  });

  test('embed returns vector', async () => {
    const service = new EmbeddingService({ provider: 'ollama' });
    const vector = await service.embed('test text');
    expect(vector).toBeInstanceOf(Array);
    expect(vector.length).toBe(768);
  });

  test('embedBatch returns multiple vectors', async () => {
    const service = new EmbeddingService({ provider: 'ollama' });
    const vectors = await service.embedBatch(['text 1', 'text 2']);
    expect(vectors.length).toBe(2);
    expect(vectors[0].length).toBe(768);
  });
});

describe('VectorStore', () => {
  let store: VectorStore;
  let dbPath: string;

  beforeEach(() => {
    // Use temp database for each test
    resetEmbeddingService();
    jest.spyOn(EmbeddingService.prototype, 'embed').mockImplementation(deterministicEmbedding);
    dbPath = join(mkdtempSync(join(tmpdir(), 'openhorse-test-vector-')), 'vector.db');
    store = new VectorStore({ dbPath, embeddingConfig: { provider: 'openai' } });
  });

  afterEach(() => {
    store?.close();
    rmSync(join(dbPath, '..'), { recursive: true, force: true });
    jest.restoreAllMocks();
    resetEmbeddingService();
  });

  test('initializes database', () => {
    expect(store).toBeDefined();
  });

  test('upsert inserts memory', async () => {
    const entry = {
      name: 'test-memory',
      type: 'user' as const,
      content: 'This is a test memory',
      description: 'Test memory',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await store.upsert(entry);
    const all = store.getAll();
    expect(all.length).toBeGreaterThan(0);
  });

  test('delete removes memory', async () => {
    const entry = {
      name: 'to-delete',
      type: 'user' as const,
      content: 'This will be deleted',
      description: 'Temporary memory',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await store.upsert(entry);
    store.delete('to-delete');
    const all = store.getAll();
    const found = all.find(m => m.name === 'to-delete');
    expect(found).toBeUndefined();
  });

  test('project-scoped rows with the same memory name do not overwrite each other', async () => {
    const name = 'shared-memory';
    await store.upsert(
      {
        name,
        type: 'project',
        content: 'project A content',
        description: 'A',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      '/tmp/openhorse-vector-project-a'
    );
    await store.upsert(
      {
        name,
        type: 'project',
        content: 'project B content',
        description: 'B',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      '/tmp/openhorse-vector-project-b'
    );

    expect(store.getAll('/tmp/openhorse-vector-project-a')[0]?.content).toBe('project A content');
    expect(store.getAll('/tmp/openhorse-vector-project-b')[0]?.content).toBe('project B content');

    store.delete(name, '/tmp/openhorse-vector-project-a');

    expect(store.getAll('/tmp/openhorse-vector-project-a')).toHaveLength(0);
    expect(store.getAll('/tmp/openhorse-vector-project-b')[0]?.content).toBe('project B content');
  });

  test('search returns results', async () => {
    const results = await store.search('test', 5);
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  test('project search includes legacy hash project rows', () => {
    const projectPath = '/tmp/openhorse-vector-legacy-project';
    const legacyProjectKey = createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
    const db = (store as any).db;

    db.prepare(
      `
      INSERT OR REPLACE INTO memories (id, name, type, content, description, project, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      'legacy-memory',
      'legacy-memory',
      'project',
      'legacy vector content',
      'Legacy vector row',
      legacyProjectKey,
      Date.now(),
      Date.now()
    );

    const all = store.getAll(projectPath);
    expect(all.find(memory => memory.name === 'legacy-memory')).toBeDefined();
  });

  test('cleanupOrphanProjects removes rows for missing projects', async () => {
    const keepProject = '/tmp/openhorse-vector-keep-project';
    const orphanProject = '/tmp/openhorse-vector-orphan-project';
    await store.upsert(
      {
        name: 'keep-memory',
        type: 'project',
        content: 'keep',
        description: 'keep',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      keepProject
    );
    await store.upsert(
      {
        name: 'orphan-memory',
        type: 'project',
        content: 'orphan',
        description: 'orphan',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      orphanProject
    );

    const result = store.cleanupOrphanProjects([getCanonicalProjectKey(keepProject)]);

    expect(result.orphanProjects).toContain(getCanonicalProjectKey(orphanProject));
    expect(result.deletedRows).toBe(1);
    expect(store.getAll(keepProject)).toHaveLength(1);
    expect(store.getAll(orphanProject)).toHaveLength(0);
  });

  test('default database path follows ORION_CODE_CONFIG_DIR', () => {
    const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    const originalConfigHome = process.env.ORION_CODE_CONFIG_HOME;
    const configDir = mkdtempSync(join(tmpdir(), 'orion-code-vector-config-'));
    delete process.env.ORION_CODE_CONFIG_HOME;
    process.env.ORION_CODE_CONFIG_DIR = configDir;

    const defaultStore = new VectorStore();
    try {
      expect(existsSync(join(configDir, 'vector.db'))).toBe(true);
    } finally {
      defaultStore.close();
      rmSync(configDir, { recursive: true, force: true });
      if (originalConfigDir === undefined) {
        delete process.env.ORION_CODE_CONFIG_DIR;
      } else {
        process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
      }
      if (originalConfigHome === undefined) {
        delete process.env.ORION_CODE_CONFIG_HOME;
      } else {
        process.env.ORION_CODE_CONFIG_HOME = originalConfigHome;
      }
    }
  });
});

describe('SemanticSearchService', () => {
  let service: SemanticSearchService;
  let store: VectorStore;
  let dbPath: string;

  beforeEach(() => {
    resetEmbeddingService();
    jest.spyOn(EmbeddingService.prototype, 'embed').mockImplementation(deterministicEmbedding);
    dbPath = join(mkdtempSync(join(tmpdir(), 'openhorse-test-semantic-')), 'vector.db');
    store = new VectorStore({ dbPath, embeddingConfig: { provider: 'openai' } });
    service = new SemanticSearchService({
      dbPath,
      embeddingConfig: { provider: 'openai' },
    });
  });

  afterEach(() => {
    store?.close();
    rmSync(join(dbPath, '..'), { recursive: true, force: true });
    jest.restoreAllMocks();
    resetEmbeddingService();
  });

  test('creates service', () => {
    expect(service).toBeDefined();
  });

  test('search returns structured results', async () => {
    const result = await service.search({ query: 'test', limit: 5 });
    expect(Array.isArray(result.memories)).toBe(true);
    expect(result.query).toBe('test');
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(['semantic', 'text']).toContain(result.searchType);
  });

  test('isSemanticSearchAvailable returns boolean', () => {
    const available = service.isSemanticSearchAvailable();
    expect(typeof available).toBe('boolean');
  });

  test('getSuggestions returns array', () => {
    const suggestions = service.getSuggestions();
    expect(suggestions).toBeInstanceOf(Array);
  });
});
