/**
 * Orion Code - configuration loading.
 *
 * Config loading priority:
 *   1. CLI arguments
 *   2. ~/.orion-code/orion.json (GlobalConfig)
 *   3. Agent internal defaults
 *
 * orion.json is the single configuration source. Provider credentials
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, DASHSCOPE_API_KEY, etc.) are still read
 * from the process environment by the model/web-search clients at runtime;
 * those are functional reads, not configuration overrides.
 *
 * UI renderer is intentionally not read from orion.json or env. TUI is the
 * public product default; --ui terminal selects the technical diagnostics
 * fallback; --ui ink is deprecated and will be removed in v0.2.0.
 */

import {
  loadGlobalConfig,
  type GlobalConfig,
  type ToolConfirmationPolicy,
  type UIConfig,
  type UIRenderer,
  type UIConfirmationMode,
  type WebSearchMcpConfig,
  type SkillsConfig,
  type AgentLoopConfig,
  type AgentLoopBudgetConfig,
  type SubagentUserConfig,
  type SubagentMode,
  type SubagentRole,
  type CostConfig,
} from './global-config';
import {
  buildRegistry,
  isLegacyConfig,
  getLegacyMigrationHint,
  type ModelRegistry,
} from './model-registry';
import { ModelClientPool } from './model-client-pool';
import { DEFAULT_SUBAGENT_CONFIG, type SubagentConfig } from '../runtime/subagents/types';
import { clampSubagentConfig } from '../runtime/subagents/policy';
import { maskSecret } from '../utils/mask';

export type {
  ToolConfirmationPolicy,
  UIConfig,
  UIRenderer,
  UIConfirmationMode,
  WebSearchMcpConfig,
  SkillsConfig,
  AgentLoopConfig,
  AgentLoopBudgetConfig,
  SubagentUserConfig,
  SubagentMode,
  SubagentRole,
  CostConfig,
};

export const PRODUCT_UI_RENDERER: UIRenderer = 'tui';
export const TECHNICAL_UI_RENDERERS = ['terminal'] as const satisfies readonly UIRenderer[];
export const DEPRECATED_UI_RENDERERS = ['ink'] as const satisfies readonly UIRenderer[];
export const DEFAULT_UI_RENDERER: UIRenderer = PRODUCT_UI_RENDERER;
export const SUPPORTED_UI_RENDERERS = [
  PRODUCT_UI_RENDERER,
  ...TECHNICAL_UI_RENDERERS,
  ...DEPRECATED_UI_RENDERERS,
] as const satisfies readonly UIRenderer[];

/** @deprecated Legacy export only; TUI is the product renderer, not beta. */
export const RECOMMENDED_BETA_UI_RENDERER: UIRenderer = PRODUCT_UI_RENDERER;
/** @deprecated Legacy export only; terminal is the technical renderer. */
export const STABLE_UI_RENDERER: UIRenderer = 'terminal';
/** @deprecated Use DEPRECATED_UI_RENDERERS instead. */
export const DEPRECATED_BETA_UI_RENDERERS = DEPRECATED_UI_RENDERERS;
/** @deprecated Use PRODUCT_UI_RENDERER / TECHNICAL_UI_RENDERERS / DEPRECATED_UI_RENDERERS instead. */
export const BETA_UI_RENDERERS = [
  PRODUCT_UI_RENDERER,
  ...DEPRECATED_UI_RENDERERS,
] as const satisfies readonly UIRenderer[];

// ============================================================================
// Types
// ============================================================================

export interface OrionCodeCLIConfig {
  apiKey: string;
  apiBaseUrl?: string;
  model: string;
  fallbackModel?: string;
  modelRegistry?: ModelRegistry;
  modelClientPool?: ModelClientPool;
  toolConfirmation: ToolConfirmationPolicy;
  webSearch?: WebSearchMcpConfig;
  ui?: UIConfig;
  skills?: SkillsConfig;
  agentLoop?: AgentLoopConfig;
  subagents?: SubagentConfig;
  cost?: CostConfig;
  name: string;
  mode: 'development' | 'production';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// ============================================================================
// Agent internal defaults
// ============================================================================

let _legacyConfigWarned = false;

const INTERNAL_DEFAULTS = {
  name: 'orion-code',
  mode: 'development',
  logLevel: 'info',
  toolConfirmation: 'allow' as ToolConfirmationPolicy,
  ui: {
    renderer: DEFAULT_UI_RENDERER,
    confirmations: 'config' as UIConfirmationMode,
  },
} as const;

function normalizeToolConfirmationPolicy(value: unknown): ToolConfirmationPolicy | undefined {
  return value === 'ask' || value === 'allow' || value === 'deny' ? value : undefined;
}

export function resolveUIRenderer(value: unknown): UIRenderer | undefined {
  if (value === 'stable') return 'terminal';
  return isSupportedUIRenderer(value) ? value : undefined;
}

export function isSupportedUIRenderer(value: unknown): value is UIRenderer {
  return typeof value === 'string' && (SUPPORTED_UI_RENDERERS as readonly string[]).includes(value);
}

export function isInteractiveUIRenderer(value: unknown): value is UIRenderer {
  return isSupportedUIRenderer(value);
}

export function isProductUIRenderer(value: unknown): boolean {
  return value === PRODUCT_UI_RENDERER;
}

export function isTechnicalUIRenderer(value: unknown): boolean {
  return typeof value === 'string' && (TECHNICAL_UI_RENDERERS as readonly string[]).includes(value);
}

export function isDeprecatedUIRenderer(value: unknown): boolean {
  return (
    typeof value === 'string' && (DEPRECATED_UI_RENDERERS as readonly string[]).includes(value)
  );
}

/** @deprecated Use isProductUIRenderer / isTechnicalUIRenderer instead. */
export function isBetaUIRenderer(value: unknown): value is (typeof BETA_UI_RENDERERS)[number] {
  return typeof value === 'string' && (BETA_UI_RENDERERS as readonly string[]).includes(value);
}

/** @deprecated Use isProductUIRenderer instead. */
export function isRecommendedBetaUIRenderer(value: unknown): boolean {
  return value === RECOMMENDED_BETA_UI_RENDERER;
}

function normalizeUIConfirmationMode(value: unknown): UIConfirmationMode | undefined {
  return value === 'config' || value === 'interactive' ? value : undefined;
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths = value
    .map(item => toNonEmptyString(item))
    .filter((item): item is string => Boolean(item));
  return [...new Set(paths)];
}

function loadSkillsConfig(
  globalConfig: GlobalConfig,
  overrides: Partial<OrionCodeCLIConfig>
): SkillsConfig | undefined {
  const paths = normalizeStringList([
    ...normalizeStringList(globalConfig.skills?.paths),
    ...normalizeStringList(overrides.skills?.paths),
  ]);

  return paths.length > 0 ? { paths } : undefined;
}

function loadWebSearchConfig(
  globalConfig: GlobalConfig,
  overrides: Partial<OrionCodeCLIConfig>
): WebSearchMcpConfig | undefined {
  const merged: WebSearchMcpConfig = {
    ...globalConfig.webSearch,
    ...overrides.webSearch,
  };

  // orion.json is the sole structured configuration source. The provider API
  // key remains a functional read from the environment (DASHSCOPE_API_KEY) so
  // the built-in DashScope web search keeps working without an explicit key.
  const apiKey = merged.apiKey ?? process.env.DASHSCOPE_API_KEY;
  if (apiKey) merged.apiKey = apiKey;

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function loadUIConfig(
  globalConfig: GlobalConfig,
  overrides: Partial<OrionCodeCLIConfig>
): Required<UIConfig> {
  return {
    renderer: resolveUIRenderer(overrides.ui?.renderer) ?? INTERNAL_DEFAULTS.ui.renderer,
    confirmations:
      normalizeUIConfirmationMode(overrides.ui?.confirmations) ??
      normalizeUIConfirmationMode(globalConfig.ui?.confirmations) ??
      INTERNAL_DEFAULTS.ui.confirmations,
  };
}

function loadAgentLoopConfig(
  globalConfig: GlobalConfig,
  overrides: Partial<OrionCodeCLIConfig>
): AgentLoopConfig | undefined {
  const budget: AgentLoopBudgetConfig = {
    ...globalConfig.agentLoop?.budget,
    ...overrides.agentLoop?.budget,
  };

  return Object.keys(budget).length > 0 ? { budget } : undefined;
}

function normalizePricing(value: unknown): CostConfig['defaultPricing'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const pricing = value as Record<string, unknown>;
  const input = pricing.input;
  const output = pricing.output;
  const cachedInput = pricing.cachedInput;
  if (
    typeof input !== 'number' ||
    !Number.isFinite(input) ||
    input < 0 ||
    typeof output !== 'number' ||
    !Number.isFinite(output) ||
    output < 0
  ) {
    return undefined;
  }
  return {
    input,
    output,
    ...(typeof cachedInput === 'number' && Number.isFinite(cachedInput) && cachedInput >= 0
      ? { cachedInput }
      : {}),
  };
}

function loadCostConfig(
  globalConfig: GlobalConfig,
  overrides: Partial<OrionCodeCLIConfig>
): CostConfig | undefined {
  const sourceModels = {
    ...(globalConfig.cost?.modelPricing ?? {}),
    ...(overrides.cost?.modelPricing ?? {}),
  };
  const modelPricing = Object.fromEntries(
    Object.entries(sourceModels)
      .map(([model, pricing]) => [model, normalizePricing(pricing)] as const)
      .filter((entry): entry is readonly [string, NonNullable<CostConfig['defaultPricing']>] =>
        Boolean(entry[1])
      )
  );
  const defaultPricing = normalizePricing(
    overrides.cost?.defaultPricing ?? globalConfig.cost?.defaultPricing
  );

  if (Object.keys(modelPricing).length === 0 && !defaultPricing) return undefined;
  return {
    ...(Object.keys(modelPricing).length > 0 ? { modelPricing } : {}),
    ...(defaultPricing ? { defaultPricing } : {}),
  };
}

function loadSubagentConfig(
  globalConfig: GlobalConfig,
  overrides: Partial<OrionCodeCLIConfig>
): SubagentConfig {
  const merged: SubagentUserConfig = {
    ...globalConfig.subagents,
    ...overrides.subagents,
  };

  const resolved: SubagentConfig = {
    mode: merged.mode ?? DEFAULT_SUBAGENT_CONFIG.mode,
    maxParallel: merged.maxParallel ?? DEFAULT_SUBAGENT_CONFIG.maxParallel,
    maxTasksPerTurn: merged.maxTasksPerTurn ?? DEFAULT_SUBAGENT_CONFIG.maxTasksPerTurn,
    maxTurnsPerTask: merged.maxTurnsPerTask ?? DEFAULT_SUBAGENT_CONFIG.maxTurnsPerTask,
    maxModelRequestsPerTask:
      merged.maxModelRequestsPerTask ?? DEFAULT_SUBAGENT_CONFIG.maxModelRequestsPerTask,
    maxModelRequestsPerTurn:
      merged.maxModelRequestsPerTurn ?? DEFAULT_SUBAGENT_CONFIG.maxModelRequestsPerTurn,
    maxToolCallsPerTask: merged.maxToolCallsPerTask ?? DEFAULT_SUBAGENT_CONFIG.maxToolCallsPerTask,
    timeoutMs: merged.timeoutMs ?? DEFAULT_SUBAGENT_CONFIG.timeoutMs,
    roles: merged.roles && merged.roles.length > 0 ? merged.roles : DEFAULT_SUBAGENT_CONFIG.roles,
  };

  return clampSubagentConfig(resolved);
}

// ============================================================================
// Load config
// ============================================================================

export function loadConfig(overrides: Partial<OrionCodeCLIConfig> = {}): OrionCodeCLIConfig {
  const globalConfig = loadGlobalConfig();

  let modelRegistry: ModelRegistry | undefined;
  let modelClientPool: ModelClientPool | undefined;
  let resolvedModel = 'gpt-4o';
  let resolvedFallback: string | undefined;

  const rawConfig = globalConfig as unknown as Record<string, unknown>;
  if (rawConfig.providers && rawConfig.models) {
    const result = buildRegistry({
      providers: rawConfig.providers as never,
      models: rawConfig.models as never,
      defaultModel: globalConfig.defaultModel,
      fallbackModel: globalConfig.fallbackModel,
    });
    if (result.valid && result.registry) {
      modelRegistry = result.registry;
      modelClientPool = new ModelClientPool();
      resolvedModel = modelRegistry.defaultProfile?.id ?? 'gpt-4o';
      resolvedFallback = modelRegistry.fallbackProfile?.id ?? undefined;
    } else {
      console.error('[orion-code] Invalid providers+models configuration:');
      for (const err of result.errors) {
        console.error(`  ${err.path}: ${err.message}`);
      }
    }
  }

  if (!modelRegistry) {
    if (isLegacyConfig(rawConfig)) {
      if (!_legacyConfigWarned) {
        _legacyConfigWarned = true;
        console.warn(`[orion-code] ${getLegacyMigrationHint().split('\n')[0]}`);
      }
    }
    resolvedModel =
      toNonEmptyString(overrides.model) ??
      toNonEmptyString(globalConfig.defaultModel) ??
      'gpt-4o';
    resolvedFallback =
      toNonEmptyString(overrides.fallbackModel) ??
      toNonEmptyString(globalConfig.fallbackModel) ??
      undefined;
  }

  const config: OrionCodeCLIConfig = {
    apiKey:
      toNonEmptyString(overrides.apiKey) ??
      globalConfig.apiKey ??
      '',
    apiBaseUrl:
      toNonEmptyString(overrides.apiBaseUrl) ??
      globalConfig.apiBaseUrl ??
      undefined,
    model: resolvedModel,
    fallbackModel: resolvedFallback,
    modelRegistry,
    modelClientPool,
    toolConfirmation:
      normalizeToolConfirmationPolicy(overrides.toolConfirmation) ??
      normalizeToolConfirmationPolicy(globalConfig.toolConfirmation) ??
      INTERNAL_DEFAULTS.toolConfirmation,
    webSearch: loadWebSearchConfig(globalConfig, overrides),
    ui: loadUIConfig(globalConfig, overrides),
    skills: loadSkillsConfig(globalConfig, overrides),
    agentLoop: loadAgentLoopConfig(globalConfig, overrides),
    subagents: loadSubagentConfig(globalConfig, overrides),
    cost: loadCostConfig(globalConfig, overrides),

    name: overrides.name ?? INTERNAL_DEFAULTS.name,
    mode: (overrides.mode ?? INTERNAL_DEFAULTS.mode) as 'development' | 'production',
    logLevel: (overrides.logLevel ?? INTERNAL_DEFAULTS.logLevel) as OrionCodeCLIConfig['logLevel'],
  };

  return config;
}

export function isConfigured(config: OrionCodeCLIConfig): boolean {
  if (config.modelRegistry?.defaultProfile) {
    const provider = config.modelRegistry.providers.get(
      config.modelRegistry.defaultProfile.provider
    );
    if (provider) {
      return provider.apiKey.length > 0;
    }
  }
  return Boolean(config.apiKey);
}

export function getConfigErrors(config: OrionCodeCLIConfig): string[] {
  const errors: string[] = [];
  if (!isConfigured(config)) {
    errors.push(
      'Missing API key. Set it in ~/.orion-code/orion.json.'
    );
  }
  return errors;
}

export function getConfigSummary(config: OrionCodeCLIConfig): Record<string, string> {
  return {
    name: config.name,
    model: config.model,
    fallback: config.fallbackModel || '(none)',
    apiBaseUrl: config.apiBaseUrl || '(default)',
    apiKey: maskSecret(config.apiKey),
    mode: config.mode,
    logLevel: config.logLevel,
    toolConfirmation: config.toolConfirmation,
    ui: `${config.ui?.renderer ?? INTERNAL_DEFAULTS.ui.renderer}/${config.ui?.confirmations ?? INTERNAL_DEFAULTS.ui.confirmations}`,
    webSearch:
      config.webSearch?.endpoint || config.webSearch?.apiKey || config.webSearch?.toolName
        ? 'configured'
        : '(default)',
  };
}
