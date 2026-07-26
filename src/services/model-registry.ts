/**
 * orion code — Model Registry v0.2.26
 *
 * Provider + ModelProfile configuration types, validation, and registry.
 * Replaces the legacy 4-field config (apiKey/apiBaseUrl/defaultModel/fallbackModel).
 *
 * Core principles:
 * - Providers manage endpoint/auth/protocol.
 * - ModelProfiles bind a user-visible selector to a provider + API model ID.
 * - Only configured profiles are "available" — catalog is metadata, not availability.
 * - Context fields follow config > discovery > builtin > default priority.
 * - Secret-free fingerprint for change detection.
 */

// ============================================================================
// Provider types
// ============================================================================

export type ProviderProtocol = 'openai-completions' | 'anthropic-messages';

export interface ProviderConfig {
  /** Unique provider id (e.g. "huoshan", "astroncodingplan"). */
  id: string;
  /** Base URL for API requests. */
  baseUrl: string;
  /** API key or env-var reference. "$ENV_VAR" syntax pulls from process.env. */
  apiKey: string;
  /** API protocol. */
  protocol: ProviderProtocol;
  /** Optional display name for UI. */
  displayName?: string;
}

// ============================================================================
// ModelProfile types
// ============================================================================

export interface ModelProfile {
  /** User-visible selector (e.g. "deepseek-v4", "glm-5.2"). */
  id: string;
  /** Human-readable display name (defaults to id). */
  displayName?: string;
  /** Provider id this profile uses. */
  provider: string;
  /** Actual model ID sent to the API. */
  model: string;
  /** User-configured context window (overrides discovery/catalog). */
  contextWindow?: number;
  /** User-configured max output tokens (overrides discovery/catalog). */
  maxOutputTokens?: number;
  /** Aliases for /model lookup (e.g. ["ds", "v4"]). */
  aliases?: string[];
  /** Whether this profile is enabled. Disabled profiles are hidden from /model list. */
  enabled?: boolean;
  /** Whether this model supports reasoning/thinking. */
  reasoning?: boolean;
  /** Temperature compatibility: "supported" | "unsupported". */
  temperatureMode?: 'supported' | 'unsupported';
  /** Optional cost per 1M tokens. */
  cost?: { input: number; output: number };
}

export interface ResolvedModelProfile extends ModelProfile {
  /** Resolved context window (after config>discovery>builtin>default). */
  resolvedContextWindow: number;
  /** Resolved max output tokens. */
  resolvedMaxOutputTokens: number;
  /** Where each field came from. */
  contextSource: 'config' | 'discovery' | 'builtin' | 'default';
  outputSource: 'config' | 'discovery' | 'builtin' | 'default';
  /** Stable fingerprint for change detection (no secrets). */
  fingerprint: string;
}

// ============================================================================
// Registry
// ============================================================================

export interface ModelRegistryConfig {
  providers: ProviderConfig[];
  models: ModelProfile[];
  /** Default model selector. */
  defaultModel?: string;
  /** Fallback model selector. */
  fallbackModel?: string;
}

export interface ModelRegistry {
  providers: Map<string, ProviderConfig>;
  profiles: Map<string, ResolvedModelProfile>;
  /** Alias → profile id mapping. */
  aliasIndex: Map<string, string>;
  defaultProfile: ResolvedModelProfile | null;
  fallbackProfile: ResolvedModelProfile | null;
  /** Ordered list of enabled profiles (for /model list). */
  enabledProfiles: ResolvedModelProfile[];
}

// ============================================================================
// Validation
// ============================================================================

export interface RegistryValidationError {
  path: string;
  message: string;
}

export interface RegistryValidationResult {
  valid: boolean;
  errors: RegistryValidationError[];
  registry: ModelRegistry | null;
}

export const LEGACY_FIELDS = ['apiKey', 'apiBaseUrl', 'defaultModel', 'fallbackModel'] as const;

export function isLegacyConfig(config: Record<string, unknown>): boolean {
  return LEGACY_FIELDS.some(f => typeof config[f] === 'string' && (config[f] as string).length > 0);
}

export function getLegacyMigrationHint(): string {
  return [
    'v0.2.26 requires the new providers+models configuration format.',
    'Your orion.json uses the legacy 4-field format (apiKey/apiBaseUrl/defaultModel/fallbackModel).',
    '',
    'Migration example:',
    '{',
    '  "providers": [',
    '    {',
    '      "id": "my-provider",',
    '      "baseUrl": "<your-base-url>",',
    '      "apiKey": "<your-api-key>",',
    '      "protocol": "openai-completions"',
    '    }',
    '  ],',
    '  "models": [',
    '    {',
    '      "id": "my-model",',
    '      "provider": "my-provider",',
    '      "model": "<actual-model-id>"',
    '    }',
    '  ],',
    '  "defaultModel": "my-model"',
    '}',
    '',
    'See docs/codex/v0.2.26-multi-model-configuration-plan.md for full details.',
  ].join('\n');
}

// ============================================================================
// Built-in catalog (metadata only — does NOT define availability)
// ============================================================================

interface CatalogEntry {
  contextWindow: number;
  maxOutputTokens: number;
  reasoning?: boolean;
  temperatureMode?: 'supported' | 'unsupported';
  cost?: { input: number; output: number };
}

const BUILTIN_CATALOG: Record<string, CatalogEntry> = {
  'gpt-4o': { contextWindow: 128000, maxOutputTokens: 16384, temperatureMode: 'supported', cost: { input: 2.5, output: 10 } },
  'gpt-4o-mini': { contextWindow: 128000, maxOutputTokens: 16384, temperatureMode: 'supported', cost: { input: 0.15, output: 0.6 } },
  'claude-opus-4-8': { contextWindow: 200000, maxOutputTokens: 32768, reasoning: true, temperatureMode: 'supported', cost: { input: 15, output: 75 } },
  'claude-sonnet-4-6': { contextWindow: 200000, maxOutputTokens: 16384, temperatureMode: 'supported', cost: { input: 3, output: 15 } },
  'deepseek-chat': { contextWindow: 65536, maxOutputTokens: 8192, temperatureMode: 'supported', cost: { input: 0.14, output: 0.28 } },
  'deepseek-coder': { contextWindow: 65536, maxOutputTokens: 8192, temperatureMode: 'supported', cost: { input: 0.14, output: 0.28 } },
};

const DEFAULT_CONTEXT = 128000;
const DEFAULT_MAX_OUTPUT = 16384;

// ============================================================================
// Resolver
// ============================================================================

export function resolveModelProfile(
  profile: ModelProfile,
  provider: ProviderConfig,
  discoveryContext?: number,
  discoveryOutput?: number,
): ResolvedModelProfile {
  const catalog = BUILTIN_CATALOG[profile.model];

  // Context: config > discovery > builtin > default
  let resolvedContextWindow: number;
  let contextSource: ResolvedModelProfile['contextSource'];
  if (profile.contextWindow !== undefined && profile.contextWindow > 0) {
    resolvedContextWindow = profile.contextWindow;
    contextSource = 'config';
  } else if (discoveryContext !== undefined && discoveryContext > 0) {
    resolvedContextWindow = discoveryContext;
    contextSource = 'discovery';
  } else if (catalog?.contextWindow) {
    resolvedContextWindow = catalog.contextWindow;
    contextSource = 'builtin';
  } else {
    resolvedContextWindow = DEFAULT_CONTEXT;
    contextSource = 'default';
  }

  // Output: config > discovery > builtin > default
  let resolvedMaxOutputTokens: number;
  let outputSource: ResolvedModelProfile['outputSource'];
  if (profile.maxOutputTokens !== undefined && profile.maxOutputTokens > 0) {
    resolvedMaxOutputTokens = profile.maxOutputTokens;
    outputSource = 'config';
  } else if (discoveryOutput !== undefined && discoveryOutput > 0) {
    resolvedMaxOutputTokens = discoveryOutput;
    outputSource = 'discovery';
  } else if (catalog?.maxOutputTokens) {
    resolvedMaxOutputTokens = catalog.maxOutputTokens;
    outputSource = 'builtin';
  } else {
    resolvedMaxOutputTokens = DEFAULT_MAX_OUTPUT;
    outputSource = 'default';
  }

  const fingerprint = computeFingerprint(profile, provider, resolvedContextWindow, resolvedMaxOutputTokens);

  return {
    ...profile,
    resolvedContextWindow,
    resolvedMaxOutputTokens,
    contextSource,
    outputSource,
    fingerprint,
  };
}

// ============================================================================
// Registry builder
// ============================================================================

export function buildRegistry(config: ModelRegistryConfig): RegistryValidationResult {
  const errors: RegistryValidationError[] = [];

  // Validate providers
  if (!config.providers || config.providers.length === 0) {
    errors.push({ path: 'providers', message: 'At least one provider is required.' });
  }

  const providers = new Map<string, ProviderConfig>();
  for (const p of (config.providers || [])) {
    if (!p.id) { errors.push({ path: 'providers[].id', message: 'Provider id is required.' }); continue; }
    if (!p.baseUrl) { errors.push({ path: `providers.${p.id}.baseUrl`, message: 'baseUrl is required.' }); }
    if (!p.apiKey) { errors.push({ path: `providers.${p.id}.apiKey`, message: 'apiKey is required.' }); }
    if (providers.has(p.id)) { errors.push({ path: `providers.${p.id}`, message: 'Duplicate provider id.' }); }
    providers.set(p.id, p);
  }

  // Validate models
  if (!config.models || config.models.length === 0) {
    errors.push({ path: 'models', message: 'At least one model profile is required.' });
  }

  const profiles = new Map<string, ResolvedModelProfile>();
  const aliasIndex = new Map<string, string>();
  const seenIds = new Set<string>();

  for (const m of (config.models || [])) {
    if (!m.id) { errors.push({ path: 'models[].id', message: 'Model profile id is required.' }); continue; }
    if (seenIds.has(m.id)) { errors.push({ path: `models.${m.id}`, message: 'Duplicate model profile id.' }); continue; }
    seenIds.add(m.id);

    if (!m.provider) { errors.push({ path: `models.${m.id}.provider`, message: 'Provider is required.' }); continue; }
    const provider = providers.get(m.provider);
    if (!provider) { errors.push({ path: `models.${m.id}.provider`, message: `Unknown provider: ${m.provider}` }); continue; }

    if (!m.model) { errors.push({ path: `models.${m.id}.model`, message: 'API model ID is required.' }); continue; }

    // Validate context/output bounds
    if (m.contextWindow !== undefined && (m.contextWindow <= 0 || !Number.isInteger(m.contextWindow))) {
      errors.push({ path: `models.${m.id}.contextWindow`, message: 'Must be a positive integer.' });
    }
    if (m.maxOutputTokens !== undefined && (m.maxOutputTokens <= 0 || !Number.isInteger(m.maxOutputTokens))) {
      errors.push({ path: `models.${m.id}.maxOutputTokens`, message: 'Must be a positive integer.' });
    }
    if (m.maxOutputTokens !== undefined && m.contextWindow !== undefined && m.maxOutputTokens >= m.contextWindow) {
      errors.push({ path: `models.${m.id}.maxOutputTokens`, message: 'maxOutputTokens must be less than contextWindow.' });
    }

    const resolved = resolveModelProfile(m, provider);
    profiles.set(m.id, resolved);

    // Build alias index
    if (m.aliases) {
      for (const alias of m.aliases) {
        if (aliasIndex.has(alias)) {
          errors.push({ path: `models.${m.id}.aliases`, message: `Alias "${alias}" conflicts with existing mapping.` });
        }
        aliasIndex.set(alias, m.id);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, registry: null };
  }

  // Resolve default and fallback
  let defaultProfile: ResolvedModelProfile | null = null;
  let fallbackProfile: ResolvedModelProfile | null = null;

  if (config.defaultModel) {
    defaultProfile = profiles.get(config.defaultModel) ?? null;
    if (!defaultProfile) {
      errors.push({ path: 'defaultModel', message: `Default model "${config.defaultModel}" not found in profiles.` });
    }
  } else {
    // First enabled profile is the default
    const first = [...profiles.values()].find(p => p.enabled !== false);
    defaultProfile = first ?? null;
  }

  if (config.fallbackModel) {
    fallbackProfile = profiles.get(config.fallbackModel) ?? null;
    if (!fallbackProfile) {
      errors.push({ path: 'fallbackModel', message: `Fallback model "${config.fallbackModel}" not found in profiles.` });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, registry: null };
  }

  const enabledProfiles = [...profiles.values()].filter(p => p.enabled !== false);

  return {
    valid: true,
    errors: [],
    registry: {
      providers,
      profiles,
      aliasIndex,
      defaultProfile,
      fallbackProfile,
      enabledProfiles,
    },
  };
}

// ============================================================================
// Fingerprint
// ============================================================================

function computeFingerprint(
  profile: ModelProfile,
  provider: ProviderConfig,
  context: number,
  output: number,
): string {
  // Secret-free: only includes non-sensitive fields.
  const { createHash } = require('crypto');
  const parts = [
    profile.id,
    profile.provider,
    profile.model,
    String(context),
    String(output),
    provider.baseUrl,
    provider.protocol,
    profile.reasoning ? '1' : '0',
    profile.temperatureMode ?? '',
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12);
}

// ============================================================================
// Resolver helpers
// ============================================================================

export function lookupProfile(registry: ModelRegistry, selector: string): ResolvedModelProfile | null {
  // Exact ID match
  if (registry.profiles.has(selector)) return registry.profiles.get(selector)!;
  // Alias match
  const aliasedId = registry.aliasIndex.get(selector);
  if (aliasedId) return registry.profiles.get(aliasedId) ?? null;
  // Prefix match (only if unique)
  const prefixMatches = registry.enabledProfiles.filter(p => p.id.startsWith(selector));
  if (prefixMatches.length === 1) return prefixMatches[0];
  return null;
}