/**
 * Orion Code - configuration loading.
 *
 * Config loading priority:
 *   1. CLI arguments
 *   2. ~/.orion-code/orion.json (GlobalConfig)
 *   3. ORION_CODE_* environment variables
 *   4. Agent internal defaults
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
  type ResolvedModelProfile,
} from './model-registry';
import { ModelClientPool } from './model-client-pool';
import { delimiter } from 'path';
import { DEFAULT_SUBAGENT_CONFIG, type SubagentConfig } from '../runtime/subagents/types';
import { clampSubagentConfig } from '../runtime/subagents/policy';
import { ENV, webSearchEnv } from '../product/environment';

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

/** @deprecated Use OrionCodeCLIConfig instead. */
export type OpenHorseCLIConfig = OrionCodeCLIConfig;

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

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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
    ...(process.env[ENV.SKILLS_PATHS] ? process.env[ENV.SKILLS_PATHS]!.split(delimiter) : []),
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

  const endpoint = process.env[webSearchEnv('MCP_ENDPOINT')];
  const apiKey = process.env[webSearchEnv('API_KEY')] ?? process.env.DASHSCOPE_API_KEY;
  const provider =
    process.env[webSearchEnv('PROVIDER')] ?? process.env[webSearchEnv('MCP_PROVIDER')];
  const toolName = process.env[webSearchEnv('MCP_TOOL')];
  const timeoutMs = parsePositiveInt(process.env[webSearchEnv('MCP_TIMEOUT_MS')]);
  const authType = process.env[webSearchEnv('AUTH_TYPE')];
  const apiKeyHeader = process.env[webSearchEnv('API_KEY_HEADER')];
  const apiKeyQueryParam = process.env[webSearchEnv('API_KEY_QUERY_PARAM')];

  if (provider) merged.provider = provider;
  if (endpoint) merged.endpoint = endpoint;
  if (apiKey) merged.apiKey = apiKey;
  if (toolName) merged.toolName = toolName;
  if (timeoutMs) merged.timeoutMs = timeoutMs;
  if (
    authType === 'bearer' ||
    authType === 'header' ||
    authType === 'query' ||
    authType === 'none'
  ) {
    merged.authType = authType;
  }
  if (apiKeyHeader) merged.apiKeyHeader = apiKeyHeader;
  if (apiKeyQueryParam) merged.apiKeyQueryParam = apiKeyQueryParam;

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function loadUIConfig(
  globalConfig: GlobalConfig,
  overrides: Partial<OrionCodeCLIConfig>
): Required<UIConfig> {
  const envConfirmations = process.env[ENV.UI_CONFIRMATIONS];

  return {
    renderer: resolveUIRenderer(overrides.ui?.renderer) ?? INTERNAL_DEFAULTS.ui.renderer,
    confirmations:
      normalizeUIConfirmationMode(overrides.ui?.confirmations) ??
      normalizeUIConfirmationMode(globalConfig.ui?.confirmations) ??
      normalizeUIConfirmationMode(envConfirmations) ??
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

  const envBudget: Array<[keyof AgentLoopBudgetConfig, string | undefined]> = [
    ['maxLlmRequestsPerUserTurn', process.env[ENV.MAX_LLM_REQUESTS_PER_TURN]],
    ['maxToolCallsPerUserTurn', process.env[ENV.MAX_TOOL_CALLS_PER_TURN]],
    ['maxReadOnlyFragmentation', process.env[ENV.MAX_READ_ONLY_FRAGMENTATION]],
    ['maxModelVisibleToolBytes', process.env[ENV.MAX_MODEL_VISIBLE_TOOL_BYTES]],
  ];

  for (const [key, value] of envBudget) {
    const parsed = parsePositiveInt(value);
    if (parsed) budget[key] = parsed;
  }

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

function parseSubagentMode(value: unknown): SubagentMode | undefined {
  return value === 'off' || value === 'explicit' || value === 'auto' ? value : undefined;
}

function loadSubagentConfig(
  globalConfig: GlobalConfig,
  overrides: Partial<OrionCodeCLIConfig>
): SubagentConfig {
  const merged: SubagentUserConfig = {
    ...globalConfig.subagents,
    ...overrides.subagents,
  };

  const envMode = parseSubagentMode(process.env[ENV.SUBAGENTS]);
  if (envMode) merged.mode = envMode;

  const envMaxParallel = parsePositiveInt(process.env[ENV.SUBAGENT_MAX_PARALLEL]);
  if (envMaxParallel) merged.maxParallel = envMaxParallel;

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
      toNonEmptyString(process.env[ENV.MODEL]) ??
      'gpt-4o';
    resolvedFallback =
      toNonEmptyString(overrides.fallbackModel) ??
      toNonEmptyString(globalConfig.fallbackModel) ??
      toNonEmptyString(process.env[ENV.FALLBACK_MODEL]) ??
      undefined;
  }

  const config: OrionCodeCLIConfig = {
    apiKey:
      toNonEmptyString(overrides.apiKey) ??
      globalConfig.apiKey ??
      toNonEmptyString(process.env[ENV.API_KEY]) ??
      '',
    apiBaseUrl:
      toNonEmptyString(overrides.apiBaseUrl) ??
      globalConfig.apiBaseUrl ??
      toNonEmptyString(process.env[ENV.API_BASE_URL]) ??
      toNonEmptyString(process.env[ENV.BASE_URL]) ??
      undefined,
    model: resolvedModel,
    fallbackModel: resolvedFallback,
    modelRegistry,
    modelClientPool,
    toolConfirmation:
      normalizeToolConfirmationPolicy(overrides.toolConfirmation) ??
      normalizeToolConfirmationPolicy(globalConfig.toolConfirmation) ??
      normalizeToolConfirmationPolicy(process.env[ENV.TOOL_CONFIRMATION]) ??
      INTERNAL_DEFAULTS.toolConfirmation,
    webSearch: loadWebSearchConfig(globalConfig, overrides),
    ui: loadUIConfig(globalConfig, overrides),
    skills: loadSkillsConfig(globalConfig, overrides),
    agentLoop: loadAgentLoopConfig(globalConfig, overrides),
    subagents: loadSubagentConfig(globalConfig, overrides),
    cost: loadCostConfig(globalConfig, overrides),

    name: overrides.name ?? process.env[ENV.NAME] ?? INTERNAL_DEFAULTS.name,
    mode: (overrides.mode ?? process.env[ENV.MODE] ?? INTERNAL_DEFAULTS.mode) as
      | 'development'
      | 'production',
    logLevel: (overrides.logLevel ??
      process.env[ENV.LOG_LEVEL] ??
      INTERNAL_DEFAULTS.logLevel) as OrionCodeCLIConfig['logLevel'],
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
      'Missing ORION_CODE_API_KEY. Set it in ~/.orion-code/orion.json or environment variable.'
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
    apiKey: config.apiKey ? `${config.apiKey.slice(0, 7)}***` : '(not set)',
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
