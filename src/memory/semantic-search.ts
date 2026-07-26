/**
 * orion code - Semantic Search
 *
 * 高级语义搜索接口，整合向量存储和记忆系统
 */

import { getVectorStore, type SearchResult, type VectorStoreConfig } from './vector-store';
import { loadAllMemories, saveMemory, type MemoryEntry, type MemoryType } from './storage';
import { ENV } from '../product/environment';


// ============================================================================
// Types
// ============================================================================

export interface SemanticSearchOptions {
  query: string;
  limit?: number;
  projectPath?: string;
  type?: MemoryType;
  minScore?: number;
}

export interface SemanticSearchResult {
  memories: SearchResult[];
  query: string;
  total: number;
  searchType: 'semantic' | 'text';
}

// ============================================================================
// Semantic Search Service
// ============================================================================

export class SemanticSearchService {
  private vectorStore: ReturnType<typeof getVectorStore>;

  constructor(config?: VectorStoreConfig) {
    this.vectorStore = getVectorStore(config);
  }

  /** Search memories semantically */
  async search(options: SemanticSearchOptions): Promise<SemanticSearchResult> {
    const { query, limit = 10, projectPath, type, minScore = 0.3 } = options;

    // Get results from vector store
    let results = await this.vectorStore.search(query, limit * 2, projectPath);

    // Filter by type if specified
    if (type) {
      results = results.filter(r => r.type === type);
    }

    // Filter by minimum score
    results = results.filter(r => r.score >= minScore);

    // Limit results
    results = results.slice(0, limit);

    return {
      memories: results,
      query,
      total: results.length,
      searchType: this.vectorStore.isVectorSearchAvailable() ? 'semantic' : 'text',
    };
  }

  /** Index all existing memories */
  async indexExistingMemories(projectPath?: string): Promise<number> {
    const memories = loadAllMemories(projectPath);
    let indexed = 0;

    for (const memory of memories) {
      try {
        await this.vectorStore.upsert(memory, projectPath);
        indexed++;
      } catch (err: any) {
        console.warn(`[SemanticSearch] Failed to index ${memory.name}: ${err.message}`);
      }
    }

    return indexed;
  }

  /** Save and index new memory */
  async saveAndIndex(entry: MemoryEntry, projectPath?: string): Promise<void> {
    // Save to file storage
    saveMemory(entry, projectPath);

    // Index in vector store
    await this.vectorStore.upsert(entry, projectPath);
  }

  /** Check if semantic search is available */
  isSemanticSearchAvailable(): boolean {
    return this.vectorStore.isVectorSearchAvailable();
  }

  /** Get search suggestions based on indexed content */
  getSuggestions(projectPath?: string): string[] {
    const allMemories = this.vectorStore.getAll(projectPath);

    // Extract key terms from memory names
    const terms = allMemories.map(m => m.name);

    // Return unique suggestions
    return [...new Set(terms)].slice(0, 10);
  }
}

// ============================================================================
// Feature Detection
// ============================================================================

/**
 * Whether semantic search is explicitly enabled via ORION_CODE_EMBEDDING_PROVIDER.
 * We require an explicit opt-in so the vector store + sqlite-vec are only
 * initialised when the user wants embeddings.
 */
export function isSemanticEnabled(): boolean {
  const provider = process.env[ENV.EMBEDDING_PROVIDER];
  return provider === 'ollama' || provider === 'openai';
}

// ============================================================================
// Factory
// ============================================================================

let defaultService: SemanticSearchService | null = null;

export function getSemanticSearchService(config?: VectorStoreConfig): SemanticSearchService {
  if (!defaultService) {
    defaultService = new SemanticSearchService(config);
  }
  return defaultService;
}

export function resetSemanticSearchService(): void {
  defaultService = null;
}

// ============================================================================
// Convenience Functions
// ============================================================================

/** Quick semantic search */
export async function semanticSearch(query: string, projectPath?: string, limit?: number): Promise<SearchResult[]> {
  const service = getSemanticSearchService();
  const result = await service.search({ query, projectPath, limit });
  return result.memories;
}