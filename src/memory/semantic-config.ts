/**
 * Lightweight semantic-memory feature detection.
 *
 * Keep this module free of vector/native imports so core tools can decide
 * whether semantic memory is enabled before loading better-sqlite3/sqlite-vec.
 */

import { ENV } from '../product/environment';

/** Whether semantic memory was explicitly enabled by the user. */
export function isSemanticEnabled(): boolean {
  const provider = process.env[ENV.EMBEDDING_PROVIDER];
  return provider === 'ollama' || provider === 'openai';
}
