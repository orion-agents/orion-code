/**
 * orion code - Embedding Service
 *
 * 支持 Ollama (nomic-embed-text) 和 OpenAI (text-embedding-3-small)
 */

import axios from 'axios';
import { ENV } from '../product/environment';

// ============================================================================
// Types
// ============================================================================

export interface EmbeddingConfig {
  provider: 'ollama' | 'openai';
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface EmbeddingResult {
  vector: number[];
  dimension: number;
}

// ============================================================================
// Embedding Service
// ============================================================================

export class EmbeddingService {
  private config: EmbeddingConfig;
  private dimension: number;

  constructor(config: EmbeddingConfig) {
    this.config = config;

    // Set dimension based on provider/model
    if (config.provider === 'ollama') {
      this.dimension = 768; // nomic-embed-text
    } else {
      this.dimension = 1536; // text-embedding-3-small
    }
  }

  /** Get embedding dimension */
  getDimension(): number {
    return this.dimension;
  }

  /** Embed single text */
  async embed(text: string): Promise<number[]> {
    if (this.config.provider === 'ollama') {
      return this.embedWithOllama(text);
    } else {
      return this.embedWithOpenAI(text);
    }
  }

  /** Embed batch of texts - Issue #32 #3.5: 添加 AbortSignal 支持 */
  async embedBatch(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    // Issue #32 #3.5: 使用 Promise.allSettled + AbortSignal
    const batchSize = 10;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      // 检查 abort signal
      if (signal?.aborted) {
        throw new Error('Embedding batch aborted');
      }

      const batch = texts.slice(i, i + batchSize);

      // 使用 Promise.allSettled 确保部分失败不影响整体
      const batchResults = await Promise.allSettled(
        batch.map(t => this.embed(t))
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          // 失败时使用零向量
          console.warn(`[Embedding] Batch item failed: ${result.reason}`);
          results.push(new Array(this.dimension).fill(0));
        }
      }
    }

    return results;
  }

  /** Embed using Ollama */
  private async embedWithOllama(text: string): Promise<number[]> {
    const baseUrl = this.config.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const model = this.config.model || 'nomic-embed-text';

    try {
      const response = await axios.post(`${baseUrl}/api/embeddings`, {
        model,
        prompt: text,
      }, {
        timeout: 30000,
      });

      return response.data.embedding;
    } catch (err: any) {
      // Fallback: return zero vector if Ollama unavailable
      console.warn(`[Embedding] Ollama unavailable: ${err.message}`);
      return new Array(this.dimension).fill(0);
    }
  }

  /** Embed using OpenAI */
  private async embedWithOpenAI(text: string): Promise<number[]> {
    const apiKey = this.config.apiKey || process.env.OPENAI_API_KEY || process.env[ENV.API_KEY];
    const model = this.config.model || 'text-embedding-3-small';

    if (!apiKey) {
      console.warn('[Embedding] OpenAI API key not configured');
      return new Array(this.dimension).fill(0);
    }

    try {
      const response = await axios.post(
        'https://api.openai.com/v1/embeddings',
        {
          model,
          input: text,
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      return response.data.data[0].embedding;
    } catch (err: any) {
      console.warn(`[Embedding] OpenAI unavailable: ${err.message}`);
      return new Array(this.dimension).fill(0);
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

let defaultService: EmbeddingService | null = null;

export function getEmbeddingService(config?: EmbeddingConfig): EmbeddingService {
  if (!defaultService) {
    // Auto-detect provider from environment
    const provider = process.env[ENV.EMBEDDING_PROVIDER] ||
      (process.env.OLLAMA_BASE_URL ? 'ollama' : 'openai');

    defaultService = new EmbeddingService({
      provider: provider as 'ollama' | 'openai',
      model: process.env[ENV.EMBEDDING_MODEL],
      baseUrl: process.env.OLLAMA_BASE_URL,
      apiKey: process.env[ENV.API_KEY],
      ...config,
    });
  }

  return defaultService;
}

export function resetEmbeddingService(): void {
  defaultService = null;
}