import type { OrionCodeCLIConfig, WebSearchMcpConfig } from './config';
import { ENV, webSearchEnv } from '../product/environment';

export const BAILIAN_WEBSEARCH_MCP_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp';
export const ZHIPU_WEBSEARCH_PRIME_MCP_ENDPOINT = 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp';
export const TAVILY_MCP_ENDPOINT = 'https://mcp.tavily.com/mcp/';

type AuthType = NonNullable<WebSearchMcpConfig['authType']>;

interface WebSearchProviderProfile {
  id: string;
  aliases: string[];
  endpoint: string;
  toolName?: string;
  authType?: AuthType;
  apiKeyHeader?: string;
  apiKeyQueryParam?: string;
  apiKeyEnvVars: string[];
  matches(config: OrionCodeCLIConfig): boolean;
  note?: string;
}

export interface ResolvedWebSearchMcpConfig extends WebSearchMcpConfig {
  provider: string;
  endpoint: string;
  timeoutMs?: number;
  note?: string;
}

const ORION_WEBSEARCH_API_KEY = webSearchEnv('API_KEY');

const PROVIDER_PROFILES: WebSearchProviderProfile[] = [
  {
    id: 'bailian',
    aliases: ['dashscope', 'aliyun', 'alibaba', 'coding-plan', 'coding_plan'],
    endpoint: BAILIAN_WEBSEARCH_MCP_ENDPOINT,
    apiKeyEnvVars: [ORION_WEBSEARCH_API_KEY, 'DASHSCOPE_API_KEY'],
    matches(config) {
      const baseUrl = (config.apiBaseUrl || '').toLowerCase();
      return baseUrl.includes('dashscope.aliyuncs.com') || baseUrl.includes('dashscope-intl.aliyuncs.com');
    },
    note: 'Bailian WebSearch MCP. Official docs currently list the dashscope endpoint for Coding Plan tools.',
  },
  {
    id: 'zhipu',
    aliases: ['glm', 'bigmodel', 'zhipuai', 'web-search-prime'],
    endpoint: ZHIPU_WEBSEARCH_PRIME_MCP_ENDPOINT,
    toolName: 'webSearchPrime',
    apiKeyEnvVars: [ORION_WEBSEARCH_API_KEY, 'GLM_API_KEY', 'ZHIPU_API_KEY', 'BIGMODEL_API_KEY'],
    matches(config) {
      const baseUrl = (config.apiBaseUrl || '').toLowerCase();
      const model = (config.model || '').toLowerCase();
      return baseUrl.includes('bigmodel.cn') || (model.startsWith('glm') && !baseUrl.includes('dashscope'));
    },
    note: 'ZhipuAI GLM WebSearch Prime MCP.',
  },
  {
    id: 'tavily-mcp',
    aliases: [],
    endpoint: TAVILY_MCP_ENDPOINT,
    authType: 'query',
    apiKeyQueryParam: 'tavilyApiKey',
    apiKeyEnvVars: [ORION_WEBSEARCH_API_KEY, 'TAVILY_API_KEY'],
    matches() {
      return false;
    },
    note: 'Tavily remote MCP.',
  },
];

function normalizeProvider(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function findProfile(provider: string | undefined): WebSearchProviderProfile | undefined {
  const normalized = normalizeProvider(provider);
  if (!normalized || normalized === 'auto') return undefined;
  return PROVIDER_PROFILES.find(profile => (
    profile.id === normalized || profile.aliases.includes(normalized)
  ));
}

function inferProfile(config: OrionCodeCLIConfig): WebSearchProviderProfile {
  return PROVIDER_PROFILES.find(profile => profile.matches(config)) || PROVIDER_PROFILES[0];
}

function firstEnvValue(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

function mergeHeaders(profile: WebSearchProviderProfile, explicit: WebSearchMcpConfig): Record<string, string> | undefined {
  const headers = { ...(explicit.headers || {}) };
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function hasExplicitCredential(config: WebSearchMcpConfig): boolean {
  return Boolean(config.apiKey || config.headers?.Authorization || config.headers?.authorization);
}

export function resolveWebSearchMcpConfig(config: OrionCodeCLIConfig): ResolvedWebSearchMcpConfig {
  const explicit = config.webSearch || {};
  const envProvider = process.env[webSearchEnv('PROVIDER')] ?? process.env[webSearchEnv('MCP_PROVIDER')];
  const profile = findProfile(explicit.provider || envProvider) || inferProfile(config);

  const envEndpoint = process.env[webSearchEnv('MCP_ENDPOINT')];
  const envToolName = process.env[webSearchEnv('MCP_TOOL')];
  const envAuthType = process.env[webSearchEnv('AUTH_TYPE')];
  const envApiKeyHeader = process.env[webSearchEnv('API_KEY_HEADER')];
  const envApiKeyQueryParam = process.env[webSearchEnv('API_KEY_QUERY_PARAM')];
  const providerApiKey = firstEnvValue(profile.apiKeyEnvVars);
  const configuredApiKey = config.apiKey || process.env[ENV.API_KEY];

  const authType = (
    explicit.authType
    || (envAuthType === 'bearer' || envAuthType === 'header' || envAuthType === 'query' || envAuthType === 'none'
      ? envAuthType
      : undefined)
    || profile.authType
  );

  return {
    provider: profile.id,
    endpoint: explicit.endpoint || envEndpoint || profile.endpoint,
    apiKey: explicit.apiKey || providerApiKey || (hasExplicitCredential(explicit) ? undefined : configuredApiKey),
    toolName: explicit.toolName || envToolName || profile.toolName,
    timeoutMs: explicit.timeoutMs,
    authType,
    apiKeyHeader: explicit.apiKeyHeader || envApiKeyHeader || profile.apiKeyHeader,
    apiKeyQueryParam: explicit.apiKeyQueryParam || envApiKeyQueryParam || profile.apiKeyQueryParam,
    headers: mergeHeaders(profile, explicit),
    note: profile.note,
  };
}

export function getWebSearchMcpErrorSuggestion(config: ResolvedWebSearchMcpConfig): string {
  const provider = config.provider;
  const keyHint = (() => {
    if (provider === 'bailian') return `DASHSCOPE_API_KEY, ${ORION_WEBSEARCH_API_KEY}, or the configured Orion Code apiKey`;
    if (provider === 'zhipu') return `GLM_API_KEY/ZHIPU_API_KEY/BIGMODEL_API_KEY or ${ORION_WEBSEARCH_API_KEY}`;
    if (provider === 'tavily-mcp') return `TAVILY_API_KEY or ${ORION_WEBSEARCH_API_KEY}`;
    return `${ORION_WEBSEARCH_API_KEY} or the configured Orion Code apiKey`;
  })();

  return [
    `Resolved WebSearch provider "${provider}" to ${config.endpoint}.`,
    `Orion Code uses ${keyHint} automatically unless webSearch.apiKey/headers override it.`,
    'If this endpoint rejects the key, set webSearch.provider/endpoint/apiKey explicitly for that provider.',
  ].join(' ');
}

export function listWebSearchProviderProfiles(): Array<Pick<WebSearchProviderProfile, 'id' | 'endpoint' | 'aliases' | 'toolName'>> {
  return PROVIDER_PROFILES.map(({ id, endpoint, aliases, toolName }) => ({ id, endpoint, aliases, toolName }));
}