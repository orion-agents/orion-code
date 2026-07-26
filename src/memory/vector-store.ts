/**
 * orion code - Vector Store
 *
 * 基于 sqlite-vec 的向量存储层
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';  // Issue #32 #3.4: 用于 hashProject
import { getEmbeddingService, type EmbeddingConfig } from './embeddings';
import type { MemoryEntry, MemoryType } from './types';
import { getCanonicalProjectKey, getConfigHome } from '../services/config-dir';

// ============================================================================
// Types
// ============================================================================

export interface SearchResult {
  id: string;
  name: string;
  type: MemoryType;
  content: string;
  description: string;
  score: number;
  createdAt: number;
}

export interface VectorStoreConfig {
  dbPath?: string;
  embeddingConfig?: EmbeddingConfig;
}

export interface VectorProjectStats {
  project: string;
  rows: number;
}

export interface VectorCleanupResult {
  orphanProjects: string[];
  deletedRows: number;
}

// ============================================================================
// Vector Store
// ============================================================================

export class VectorStore {
  private db: Database.Database;
  private embeddingService: ReturnType<typeof getEmbeddingService>;
  private initialized: boolean = false;

  constructor(config?: VectorStoreConfig) {
    // Determine database path
    const dbPath = config?.dbPath || join(getConfigHome(), 'vector.db');

    // Ensure directory exists
    const dbDir = join(dbPath, '..');
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    // Initialize database
    this.db = new Database(dbPath);

    // Get embedding service
    this.embeddingService = getEmbeddingService(config?.embeddingConfig);

    // Initialize tables
    this.initialize();
  }

  /** Initialize database tables */
  private initialize(): void {
    // Create memories table (without vector column initially)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        description TEXT,
        project TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Create index on type and project
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project)
    `);

    // Try to create vector column using sqlite-vec
    try {
      const dimension = this.embeddingService.getDimension();
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
          embedding FLOAT[${dimension}]
        )
      `);

      // Link table for vector -> memory
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_vectors (
          memory_id TEXT PRIMARY KEY,
          vector_rowid INTEGER,
          FOREIGN KEY (memory_id) REFERENCES memories(id)
        )
      `);

      this.initialized = true;
    } catch (err: any) {
      // sqlite-vec may not be available - fall back to text search only
      console.warn(`[VectorStore] sqlite-vec not available: ${err.message}`);
      this.initialized = false;
    }
  }

  /** Check if vector search is available */
  isVectorSearchAvailable(): boolean {
    return this.initialized;
  }

  /** Insert or update memory with embedding - Issue #32 #3.3: 使用事务 */
  async upsert(entry: MemoryEntry, projectPath?: string): Promise<void> {
    const projectKey = projectPath ? this.projectKey(projectPath) : 'global';
    const memoryId = this.memoryId(projectKey, entry.name);

    // Issue #32 #3.3: 使用事务确保 embed 失败时不写 memories 表
    const upsertTransaction = this.db.transaction((data: {
      id: string;
      name: string;
      type: string;
      content: string;
      description: string;
      projectKey: string;
      createdAt: number;
      updatedAt: number;
    }) => {
      // Insert/update memory record
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO memories (id, name, type, content, description, project, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        data.id,
        data.name,
        data.type,
        data.content,
        data.description,
        data.projectKey,
        data.createdAt,
        data.updatedAt
      );
    });

    // Generate embedding first (before transaction)
    if (this.initialized) {
      try {
        const vector = await this.embeddingService.embed(entry.content);

        // Now execute transaction with the data
        upsertTransaction({
          id: memoryId,
          name: entry.name,
          type: entry.type,
          content: entry.content,
          description: entry.description || entry.content.slice(0, 100),
          projectKey,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        });

        // Delete old vector if exists
        this.deleteVectorsForMemoryIds([memoryId]);

        // Insert new vector
        const vectorStmt = this.db.prepare(`INSERT INTO vec_memories (embedding) VALUES (?)`);
        const result = vectorStmt.run(JSON.stringify(vector));

        // Link vector to memory
        this.db.prepare('INSERT INTO memory_vectors (memory_id, vector_rowid) VALUES (?, ?)').run(
          memoryId,
          result.lastInsertRowid
        );
      } catch (err: any) {
        console.warn(`[VectorStore] Failed to store embedding: ${err.message}`);
        // embed 失败时不写入 memories 表（事务未执行）
        throw err;
      }
    } else {
      // No vector search - just write memory
      upsertTransaction({
        id: memoryId,
        name: entry.name,
        type: entry.type,
        content: entry.content,
        description: entry.description || entry.content.slice(0, 100),
        projectKey,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
    }
  }

  /** Delete memory */
  delete(name: string, projectPath?: string): void {
    if (!projectPath) {
      this.deleteMemoryIds([name]);
      return;
    }

    const projectKeys = this.projectKeys(projectPath);
    const scopedIds = projectKeys.map(projectKey => this.memoryId(projectKey, name));
    const idPlaceholders = scopedIds.map(() => '?').join(', ');
    const projectPlaceholders = projectKeys.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT id FROM memories
      WHERE id IN (${idPlaceholders})
         OR (id = ? AND project IN (${projectPlaceholders}))
    `).all(...scopedIds, name, ...projectKeys) as Array<{ id: string }>;

    this.deleteMemoryIds(rows.map(row => row.id));
  }

  /** Search by similarity */
  async search(query: string, limit: number = 10, projectPath?: string): Promise<SearchResult[]> {
    const projectKeys = projectPath ? this.projectKeys(projectPath) : undefined;

    // If vector search available, use semantic search
    if (this.initialized) {
      return this.semanticSearch(query, limit, projectKeys);
    }

    // Otherwise fall back to text search
    return this.textSearch(query, limit, projectKeys);
  }

  /** Semantic search using vectors */
  private async semanticSearch(query: string, limit: number, projectKeys?: string[]): Promise<SearchResult[]> {
    try {
      const queryVector = await this.embeddingService.embed(query);
      const projectPlaceholders = projectKeys?.map(() => '?').join(', ');

      // Use sqlite-vec for similarity search
      const sql = projectKeys
        ? `
          SELECT m.id, m.name, m.type, m.content, m.description, m.created_at,
                 vec_distance_cosine(v.embedding, ?) as distance
          FROM memories m
          JOIN memory_vectors mv ON m.id = mv.memory_id
          JOIN vec_memories v ON mv.vector_rowid = v.rowid
          WHERE m.project IN (${projectPlaceholders})
          ORDER BY distance ASC
          LIMIT ?
        `
        : `
          SELECT m.id, m.name, m.type, m.content, m.description, m.created_at,
                 vec_distance_cosine(v.embedding, ?) as distance
          FROM memories m
          JOIN memory_vectors mv ON m.id = mv.memory_id
          JOIN vec_memories v ON mv.vector_rowid = v.rowid
          ORDER BY distance ASC
          LIMIT ?
        `;

      const stmt = this.db.prepare(sql);
      const params = projectKeys
        ? [JSON.stringify(queryVector), ...projectKeys, limit]
        : [JSON.stringify(queryVector), limit];

      const rows = stmt.all(...params) as any[];

      return rows.map(row => ({
        id: row.id,
        name: row.name,
        type: row.type as MemoryType,
        content: row.content,
        description: row.description,
        score: 1 - row.distance, // Convert distance to similarity score
        createdAt: row.created_at,
      }));
    } catch (err: any) {
      console.warn(`[VectorStore] Semantic search failed: ${err.message}`);
      return this.textSearch(query, limit, projectKeys);
    }
  }

  /** Text search fallback */
  private textSearch(query: string, limit: number, projectKeys?: string[]): SearchResult[] {
    const projectPlaceholders = projectKeys?.map(() => '?').join(', ');
    const sql = projectKeys
      ? `
        SELECT id, name, type, content, description, created_at
        FROM memories
        WHERE project IN (${projectPlaceholders}) AND (content LIKE ? OR name LIKE ? OR description LIKE ?)
        LIMIT ?
      `
      : `
        SELECT id, name, type, content, description, created_at
        FROM memories
        WHERE content LIKE ? OR name LIKE ? OR description LIKE ?
        LIMIT ?
      `;

    const searchTerm = `%${query}%`;
    const stmt = this.db.prepare(sql);
    const params = projectKeys
      ? [...projectKeys, searchTerm, searchTerm, searchTerm, limit]
      : [searchTerm, searchTerm, searchTerm, limit];

    const rows = stmt.all(...params) as any[];

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      type: row.type as MemoryType,
      content: row.content,
      description: row.description,
      score: 0.5, // Default score for text search
      createdAt: row.created_at,
    }));
  }

  /** Get all memories for a project */
  getAll(projectPath?: string): SearchResult[] {
    const projectKeys = projectPath ? this.projectKeys(projectPath) : undefined;
    const projectPlaceholders = projectKeys?.map(() => '?').join(', ');

    const sql = projectKeys
      ? `SELECT id, name, type, content, description, created_at FROM memories WHERE project IN (${projectPlaceholders})`
      : 'SELECT id, name, type, content, description, created_at FROM memories';

    const stmt = this.db.prepare(sql);
    const params = projectKeys ?? [];
    const rows = stmt.all(...params) as any[];

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      type: row.type as MemoryType,
      content: row.content,
      description: row.description,
      score: 1,
      createdAt: row.created_at,
    }));
  }

  /** Count rows by project key for storage maintenance diagnostics. */
  getProjectStats(): VectorProjectStats[] {
    const rows = this.db.prepare(`
      SELECT COALESCE(project, 'global') as project, COUNT(*) as rows
      FROM memories
      GROUP BY COALESCE(project, 'global')
      ORDER BY rows DESC, project ASC
    `).all() as Array<{ project: string; rows: number }>;

    return rows.map(row => ({ project: row.project, rows: row.rows }));
  }

  /** Delete all rows for projects that are not in validProjectKeys. */
  cleanupOrphanProjects(validProjectKeys: string[]): VectorCleanupResult {
    const valid = new Set([...validProjectKeys, 'global']);
    const orphanProjects = this.getProjectStats()
      .map(stat => stat.project)
      .filter(project => !valid.has(project));

    let deletedRows = 0;
    for (const project of orphanProjects) {
      deletedRows += this.deleteProjectRows(project);
    }

    return { orphanProjects, deletedRows };
  }

  private deleteProjectRows(project: string): number {
    const ids = (this.db.prepare('SELECT id FROM memories WHERE project = ?').all(project) as Array<{ id: string }>)
      .map(row => row.id);
    if (ids.length === 0) return 0;

    this.deleteMemoryIds(ids);
    return ids.length;
  }

  private deleteMemoryIds(ids: string[]): void {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return;

    this.deleteVectorsForMemoryIds(uniqueIds);
    const placeholders = uniqueIds.map(() => '?').join(', ');
    this.db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...uniqueIds);
  }

  private deleteVectorsForMemoryIds(ids: string[]): void {
    if (!this.hasTable('memory_vectors') || !this.hasTable('vec_memories') || ids.length === 0) return;

    const placeholders = ids.map(() => '?').join(', ');
    this.db.prepare(`DELETE FROM vec_memories WHERE rowid IN (SELECT vector_rowid FROM memory_vectors WHERE memory_id IN (${placeholders}))`).run(...ids);
    this.db.prepare(`DELETE FROM memory_vectors WHERE memory_id IN (${placeholders})`).run(...ids);
  }

  /** Canonical project key used by v0.2.8+ storage. */
  private projectKey(projectPath: string): string {
    return getCanonicalProjectKey(projectPath);
  }

  /** Legacy hash project key used by older memory/vector storage. */
  private legacyProjectKey(projectPath: string): string {
    return createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
  }

  private projectKeys(projectPath: string): string[] {
    return [...new Set([this.projectKey(projectPath), this.legacyProjectKey(projectPath)])];
  }

  private memoryId(projectKey: string, name: string): string {
    return projectKey === 'global' ? name : `${projectKey}:${name}`;
  }

  private hasTable(name: string): boolean {
    const row = this.db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(name);
    return !!row;
  }

  /** Close database */
  close(): void {
    this.db.close();
  }
}

// ============================================================================
// Factory
// ============================================================================

let defaultStore: VectorStore | null = null;

export function getVectorStore(config?: VectorStoreConfig): VectorStore {
  if (!defaultStore) {
    defaultStore = new VectorStore(config);
  }
  return defaultStore;
}

export function resetVectorStore(): void {
  if (defaultStore) {
    defaultStore.close();
    defaultStore = null;
  }
}
