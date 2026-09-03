import { resolveModelContext } from './model-context';

export interface ModelCatalogEntry {
  name: string;
  alias?: string;
  provider?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    name: 'claude-opus-4-8',
    alias: 'opus',
    provider: 'Anthropic',
    contextWindow: 200000,
    maxOutputTokens: 32000,
  },
  {
    name: 'claude-sonnet-4-6',
    alias: 'sonnet',
    provider: 'Anthropic',
    contextWindow: 200000,
    maxOutputTokens: 16000,
  },
  {
    name: 'claude-haiku-4-5-20251001',
    alias: 'haiku',
    provider: 'Anthropic',
    contextWindow: 200000,
    maxOutputTokens: 8192,
  },
  {
    name: 'gpt-4o',
    alias: 'gpt4o',
    provider: 'OpenAI',
    contextWindow: 128000,
    maxOutputTokens: 16384,
  },
  {
    name: 'gpt-4o-mini',
    alias: 'gpt4omin',
    provider: 'OpenAI',
    contextWindow: 128000,
    maxOutputTokens: 16384,
  },
  {
    name: 'gpt-3.5-turbo',
    alias: 'gpt35',
    provider: 'OpenAI',
    contextWindow: 16385,
    maxOutputTokens: 4096,
  },
  {
    name: 'glm-5',
    alias: 'glm',
    provider: 'Bailian (Zhipu)',
    contextWindow: 202752,
    maxOutputTokens: 8192,
  },
  {
    name: 'glm-4.7',
    alias: 'glm47',
    provider: 'Bailian (Zhipu)',
    contextWindow: 131072,
    maxOutputTokens: 8192,
  },
  {
    name: 'glm-5.2',
    alias: 'glm52',
    provider: 'Huoshan (Volcengine)',
    contextWindow: 1024000,
    maxOutputTokens: 128000,
  },
  {
    name: 'qwen3.7-plus',
    alias: 'qwen',
    provider: 'Bailian (Alibaba)',
    contextWindow: 131072,
    maxOutputTokens: 8192,
  },
  {
    name: 'qwen3.6-plus',
    alias: 'qwen36',
    provider: 'Bailian (Alibaba)',
    contextWindow: 131072,
    maxOutputTokens: 8192,
  },
  {
    name: 'qwen3.5-plus',
    alias: 'qwen35',
    provider: 'Bailian (Alibaba)',
    contextWindow: 131072,
    maxOutputTokens: 8192,
  },
  {
    name: 'qwen3-max-2026-01-23',
    alias: 'qwenmax',
    provider: 'Bailian (Alibaba)',
    contextWindow: 131072,
    maxOutputTokens: 8192,
  },
  {
    name: 'qwen3-coder-plus',
    alias: 'coder',
    provider: 'Bailian (Alibaba)',
    contextWindow: 131072,
    maxOutputTokens: 8192,
  },
  {
    name: 'qwen3-coder-next',
    alias: 'codernext',
    provider: 'Bailian (Alibaba)',
    contextWindow: 131072,
    maxOutputTokens: 8192,
  },
  {
    name: 'kimi-k2.5',
    alias: 'kimi',
    provider: 'Bailian (Moonshot)',
    contextWindow: 131072,
    maxOutputTokens: 8192,
  },
  {
    name: 'kimi-k2.7-code',
    alias: 'kimicode',
    provider: 'Huoshan (Volcengine)',
    contextWindow: 256000,
    maxOutputTokens: 32768,
  },
  {
    name: 'MiniMax-M2.5',
    alias: 'minimax',
    provider: 'Bailian (MiniMax)',
    contextWindow: 131072,
    maxOutputTokens: 8192,
  },
  {
    name: 'ark-code-latest',
    alias: 'ark',
    provider: 'Huoshan (Volcengine)',
    contextWindow: 1024000,
    maxOutputTokens: 128000,
  },
  {
    name: 'deepseek-v4-pro',
    alias: 'dsv4pro',
    provider: 'Huoshan (Volcengine)',
    contextWindow: 1000000,
    maxOutputTokens: 384000,
  },
  {
    name: 'xopdeepseekv4pro',
    alias: 'xdsv4pro',
    provider: 'XF MAAS (xf-yun)',
    contextWindow: 1000000,
    maxOutputTokens: 16384,
  },
  {
    name: 'xopglm51',
    alias: 'xglm51',
    provider: 'XF MAAS (xf-yun)',
    contextWindow: 204800,
    maxOutputTokens: 16384,
  },
  {
    name: 'astron-code-latest',
    alias: 'astron',
    provider: 'XF MAAS (xf-yun)',
    contextWindow: 92160,
    maxOutputTokens: 32768,
  },
  {
    name: 'deepseek-chat',
    alias: 'dschat',
    provider: 'DeepSeek',
    contextWindow: 64000,
    maxOutputTokens: 8192,
  },
  {
    name: 'deepseek-coder',
    alias: 'dscoder',
    provider: 'DeepSeek',
    contextWindow: 64000,
    maxOutputTokens: 8192,
  },
];

const EXTRA_ALIASES: Record<string, string> = {
  claude: 'claude-sonnet-4-6',
  gpt4: 'gpt-4o',
  qwenplus: 'qwen3.7-plus',
};

function normalizeCatalogKey(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function listModelCatalogEntries(): ModelCatalogEntry[] {
  return MODEL_CATALOG.map(entry => ({ ...entry }));
}

export function getModelCatalogEntry(modelIdOrAlias: string): ModelCatalogEntry | undefined {
  const normalized = normalizeCatalogKey(modelIdOrAlias);
  return MODEL_CATALOG.find(
    entry =>
      normalizeCatalogKey(entry.name) === normalized ||
      normalizeCatalogKey(entry.alias) === normalized
  );
}

export function resolveModelAlias(modelIdOrAlias: string): string {
  const normalized = normalizeCatalogKey(modelIdOrAlias);
  if (!normalized) return modelIdOrAlias.trim();

  const catalogEntry = getModelCatalogEntry(normalized);
  if (catalogEntry) return catalogEntry.name;
  return EXTRA_ALIASES[normalized] ?? modelIdOrAlias.trim();
}

export function getModelCatalogAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const entry of MODEL_CATALOG) {
    if (entry.alias) aliases[entry.alias] = entry.name;
  }
  return { ...aliases, ...EXTRA_ALIASES };
}

export function getModelCatalogDiagnostics(): {
  unknownCatalogModels: string[];
  unknownAliases: string[];
} {
  const unknownCatalogModels = MODEL_CATALOG.filter(entry => {
    const source = resolveModelContext(entry.name).source;
    return source === 'default' || source === 'fuzzy';
  }).map(entry => entry.name);

  const unknownAliases = Object.entries(getModelCatalogAliases())
    .filter(([, modelId]) => {
      const source = resolveModelContext(modelId).source;
      return source === 'default' || source === 'fuzzy';
    })
    .map(([alias, modelId]) => `${alias}->${modelId}`);

  return { unknownCatalogModels, unknownAliases };
}
