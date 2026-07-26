/**
 * orion code — Model Client Pool v0.2.26
 *
 * Manages per-provider OpenAI client instances so that /model switching
 * can atomically change endpoint, API key, and model ID without leaking
 * the previous client's configuration into the next request.
 *
 * Slice 3 of v0.2.26 plan.
 */

import OpenAI from 'openai';
import type { ProviderConfig, ResolvedModelProfile } from './model-registry';

// ============================================================================
// Pool
// ============================================================================

export interface PooledClient {
  provider: ProviderConfig;
  client: OpenAI;
  createdAt: number;
}

export class ModelClientPool {
  private clients = new Map<string, PooledClient>();

  /** Get or create an OpenAI client for a provider. */
  getClient(provider: ProviderConfig): OpenAI {
    const existing = this.clients.get(provider.id);
    if (existing) return existing.client;

    // Resolve env-var API keys
    const apiKey = resolveApiKey(provider.apiKey);

    const client = new OpenAI({
      baseURL: provider.baseUrl,
      apiKey,
      // No default model — callers must pass the resolved model ID
    });

    this.clients.set(provider.id, { provider, client, createdAt: Date.now() });
    return client;
  }

  /** Invalidate and recreate a provider's client (e.g. after key rotation). */
  invalidate(providerId: string): void {
    this.clients.delete(providerId);
  }

  /** Get the provider config for a client. */
  getProvider(providerId: string): ProviderConfig | undefined {
    return this.clients.get(providerId)?.provider;
  }

  /** Clear all cached clients. */
  clear(): void {
    this.clients.clear();
  }

  get size(): number {
    return this.clients.size;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function resolveApiKey(apiKey: string): string {
  // $ENV_VAR syntax
  if (apiKey.startsWith('$')) {
    const envVar = apiKey.slice(1);
    const value = process.env[envVar];
    if (!value) {
      throw new Error(`Environment variable ${envVar} is not set (referenced by provider apiKey).`);
    }
    return value;
  }
  return apiKey;
}

// ============================================================================
// Temperature strategy (Slice 3)
// ============================================================================

export function buildTemperatureParam(profile: ResolvedModelProfile): Record<string, unknown> {
  // Reasoning models that don't support temperature: omit the field entirely.
  if (profile.temperatureMode === 'unsupported') return {};
  // Default coding-agent behavior: temperature 0 for determinism.
  return { temperature: 0 };
}

// ============================================================================
// Request context builder (Slice 2 integration)
// ============================================================================

export interface RequestContext {
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  temperatureParams: Record<string, unknown>;
}

export function buildRequestContext(profile: ResolvedModelProfile): RequestContext {
  return {
    model: profile.model,
    contextWindow: profile.resolvedContextWindow,
    maxOutputTokens: profile.resolvedMaxOutputTokens,
    temperatureParams: buildTemperatureParam(profile),
  };
}