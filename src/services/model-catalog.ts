import { resolveModelContext } from './model-context';

export interface ModelCatalogEntry {
  name: string;
  alias?: string;
  provider?: string;
}

const MODEL_CATALOG: ModelCatalogEntry[] = [
  { name: 'claude-opus-4-8', alias: 'opus', provider: 'Anthropic' },
  { name: 'claude-sonnet-4-6', alias: 'sonnet', provider: 'Anthropic' },
  { name: 'claude-haiku-4-5-20251001', alias: 'haiku', provider: 'Anthropic' },
  { name: 'gpt-4o', alias: 'gpt4o', provider: 'OpenAI' },
  { name: 'gpt-3.5-turbo', alias: 'gpt35', provider: 'OpenAI' },
  { name: 'glm-5', alias: 'glm', provider: 'Bailian (Zhipu)' },
  { name: 'glm-4.7', alias: 'glm47', provider: 'Bailian (Zhipu)' },
  { name: 'qwen3.7-plus', alias: 'qwen', provider: 'Bailian (Alibaba)' },
  { name: 'qwen3.6-plus', alias: 'qwen36', provider: 'Bailian (Alibaba)' },
  { name: 'qwen3.5-plus', alias: 'qwen35', provider: 'Bailian (Alibaba)' },
  { name: 'qwen3-max-2026-01-23', alias: 'qwenmax', provider: 'Bailian (Alibaba)' },
  { name: 'qwen3-coder-plus', alias: 'coder', provider: 'Bailian (Alibaba)' },
  { name: 'qwen3-coder-next', alias: 'codernext', provider: 'Bailian (Alibaba)' },
  { name: 'kimi-k2.5', alias: 'kimi', provider: 'Bailian (Moonshot)' },
  { name: 'MiniMax-M2.5', alias: 'minimax', provider: 'Bailian (MiniMax)' },
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
  return MODEL_CATALOG.find(entry =>
    normalizeCatalogKey(entry.name) === normalized || normalizeCatalogKey(entry.alias) === normalized
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
  const unknownCatalogModels = MODEL_CATALOG
    .filter(entry => {
      const source = resolveModelContext(entry.name).source;
      return source === 'default' || source === 'fuzzy';
    })
    .map(entry => entry.name);

  const unknownAliases = Object.entries(getModelCatalogAliases())
    .filter(([, modelId]) => {
      const source = resolveModelContext(modelId).source;
      return source === 'default' || source === 'fuzzy';
    })
    .map(([alias, modelId]) => `${alias}->${modelId}`);

  return { unknownCatalogModels, unknownAliases };
}
