/**
 * orion code - 模型上下文窗口数据库 + 动态发现
 *
 * 混合策略：
 * 1. 内置数据库（兜底）
 * 2. 启动时尝试 /models 端点动态获取
 * 3. 每次 API 调用使用实际 token 数
 */

export interface ModelContextInfo {
  id: string;
  label: string;
  contextWindow: number;
  maxOutputTokens?: number;
  provider?: string;
  discovered?: boolean; // true = 来自 /models 端点
}

export interface ModelContextResolution extends ModelContextInfo {
  source: 'discovered' | 'builtin' | 'fuzzy' | 'default';
  matchedId: string;
}

export type ContextUsageSource = 'estimated' | 'provider' | 'provider_adjusted';

export interface ContextBudget {
  contextWindow: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  safeInputBudget: number;
}

/** Runtime-owned context pressure snapshot consumed by UI renderers. */
export interface ContextUsageSnapshot {
  modelId: string;
  usedTokens: number;
  contextWindow: number;
  percent: number;
  /** Percentage of the raw model context window, before output/safety reserves. */
  rawPercent?: number;
  /** Input budget remaining after output and safety reserves. */
  safeInputBudget?: number;
  reservedOutputTokens?: number;
  safetyMarginTokens?: number;
  source: ContextUsageSource;
  warningThresholdPercent: number;
  autoCompactThresholdPercent: number;
  autoCompactEnabled: boolean;
}

// ============================================================================
// 内置数据库（兜底）
// ============================================================================

export const BUILTIN_MODELS: Record<string, ModelContextInfo> = {
  // DashScope (coding + standard)
  'glm-5': {
    id: 'glm-5',
    label: 'GLM-5',
    contextWindow: 202752,
    maxOutputTokens: 8192,
    provider: 'glm',
  },
  'glm-4.7': {
    id: 'glm-4.7',
    label: 'GLM-4.7',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    provider: 'glm',
  },
  'glm-4': {
    id: 'glm-4',
    label: 'GLM-4',
    contextWindow: 131072,
    maxOutputTokens: 4096,
    provider: 'glm',
  },
  'qwen3.7-plus': {
    id: 'qwen3.7-plus',
    label: 'Qwen 3.7 Plus',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    provider: 'qwen',
  },
  'qwen3.6-plus': {
    id: 'qwen3.6-plus',
    label: 'Qwen 3.6 Plus',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    provider: 'qwen',
  },
  'qwen3.5-plus': {
    id: 'qwen3.5-plus',
    label: 'Qwen 3.5 Plus',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    provider: 'qwen',
  },
  'qwen3-max-2026-01-23': {
    id: 'qwen3-max-2026-01-23',
    label: 'Qwen 3 Max',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    provider: 'qwen',
  },
  'qwen3-coder-plus': {
    id: 'qwen3-coder-plus',
    label: 'Qwen 3 Coder Plus',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    provider: 'qwen',
  },
  'qwen3-coder-next': {
    id: 'qwen3-coder-next',
    label: 'Qwen 3 Coder Next',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    provider: 'qwen',
  },
  'qwen-turbo': {
    id: 'qwen-turbo',
    label: 'Qwen Turbo',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    provider: 'qwen',
  },
  'qwen-plus': {
    id: 'qwen-plus',
    label: 'Qwen Plus',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    provider: 'qwen',
  },
  'qwen-max': {
    id: 'qwen-max',
    label: 'Qwen Max',
    contextWindow: 32768,
    maxOutputTokens: 8192,
    provider: 'qwen',
  },
  'qwen-long': {
    id: 'qwen-long',
    label: 'Qwen Long',
    contextWindow: 1000000,
    maxOutputTokens: 8192,
    provider: 'qwen',
  },
  'kimi-k2.5': {
    id: 'kimi-k2.5',
    label: 'Kimi K2.5',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    provider: 'moonshot',
  },
  'MiniMax-M2.5': {
    id: 'MiniMax-M2.5',
    label: 'MiniMax M2.5',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    provider: 'minimax',
  },
  'minimax-m2.5': {
    id: 'minimax-m2.5',
    label: 'MiniMax M2.5',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    provider: 'minimax',
  },
  xopglm51: {
    id: 'xopglm51',
    label: 'XOP GLM 5.1',
    contextWindow: 204800,
    maxOutputTokens: 16384,
    provider: 'astroncodingplan',
  },
  xopdeepseekv4pro: {
    id: 'xopdeepseekv4pro',
    label: 'XOP DeepSeek V4 Pro',
    contextWindow: 1000000,
    maxOutputTokens: 16384,
    provider: 'astroncodingplan',
  },
  'astron-code-latest': {
    id: 'astron-code-latest',
    label: 'Astron Code Latest',
    contextWindow: 92160,
    maxOutputTokens: 32768,
    provider: 'astroncodingplan',
  },

  // 火山方舟 Ark (huoshan / volcengine)
  'ark-code-latest': {
    id: 'ark-code-latest',
    label: 'Ark Code Latest',
    contextWindow: 1024000,
    maxOutputTokens: 128000,
    provider: 'huoshan',
  },
  'glm-5.2': {
    id: 'glm-5.2',
    label: 'GLM 5.2',
    contextWindow: 1024000,
    maxOutputTokens: 128000,
    provider: 'huoshan',
  },
  'kimi-k2.7-code': {
    id: 'kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    contextWindow: 256000,
    maxOutputTokens: 32768,
    provider: 'huoshan',
  },
  'deepseek-v4-pro': {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    provider: 'huoshan',
  },

  // OpenAI
  'gpt-4o': {
    id: 'gpt-4o',
    label: 'GPT-4o',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    provider: 'openai',
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini',
    label: 'GPT-4o Mini',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    provider: 'openai',
  },
  'gpt-4.1': {
    id: 'gpt-4.1',
    label: 'GPT-4.1',
    contextWindow: 1047576,
    maxOutputTokens: 32768,
    provider: 'openai',
  },
  'gpt-4-turbo': {
    id: 'gpt-4-turbo',
    label: 'GPT-4 Turbo',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    provider: 'openai',
  },
  'gpt-4': {
    id: 'gpt-4',
    label: 'GPT-4',
    contextWindow: 8192,
    // 8k 版 GPT-4 的真实上限是 4096。此前写成 8192（== contextWindow），
    // 使 contextWindow - reserved - margin 变成负数。
    maxOutputTokens: 4096,
    provider: 'openai',
  },
  'gpt-3.5-turbo': {
    id: 'gpt-3.5-turbo',
    label: 'GPT-3.5 Turbo',
    contextWindow: 16385,
    maxOutputTokens: 4096,
    provider: 'openai',
  },

  // Claude
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    contextWindow: 200000,
    maxOutputTokens: 16000,
    provider: 'anthropic',
  },
  'claude-opus-4-8': {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    contextWindow: 200000,
    maxOutputTokens: 32000,
    provider: 'anthropic',
  },
  'claude-haiku-4-5-20251001': {
    id: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    provider: 'anthropic',
  },

  // DeepSeek
  'deepseek-chat': {
    id: 'deepseek-chat',
    label: 'DeepSeek Chat',
    contextWindow: 64000,
    maxOutputTokens: 8192,
    provider: 'deepseek',
  },
  'deepseek-coder': {
    id: 'deepseek-coder',
    label: 'DeepSeek Coder',
    contextWindow: 64000,
    maxOutputTokens: 8192,
    provider: 'deepseek',
  },
  'deepseek-reasoner': {
    id: 'deepseek-reasoner',
    label: 'DeepSeek Reasoner',
    contextWindow: 64000,
    maxOutputTokens: 8192,
    provider: 'deepseek',
  },
};

/** 默认上下文窗口（未知模型） */
export const DEFAULT_CONTEXT_WINDOW = 128000;

/** 自动 compact 阈值（95%） */
export const AUTO_COMPACT_THRESHOLD = 0.95;

/** Show a manual compact reminder before the automatic threshold is reached. */
export const CONTEXT_WARNING_THRESHOLD = 0.8;

/** 输出预留占上下文窗口的上限（避免 reserved 吃光整个窗口）。 */
export const MAX_OUTPUT_RESERVE_RATIO = 0.5;

/** 预算算出非正数时的按比例兜底。 */
export const FALLBACK_INPUT_BUDGET_RATIO = 0.6;

/** 同一模型只告警一次，避免每轮刷屏。 */
const warnedUnusableBudget = new Set<string>();

function warnUnusableBudgetOnce(modelId: string, contextWindow: number, fallback: number): void {
  if (warnedUnusableBudget.has(modelId)) return;
  warnedUnusableBudget.add(modelId);
  // eslint-disable-next-line no-console -- 配置错误必须可见，否则只会表现为「每轮都在压缩」
  console.warn(
    `[model-context] "${modelId}" 的上下文预算不可用（contextWindow=${contextWindow}，` +
      `输出预留 + 安全余量 已超出窗口）。回退到 ${fallback} tokens。请检查该模型的 ` +
      'contextWindow / maxOutputTokens 配置。'
  );
}

/** 仅供测试重置告警去重状态。 */
export function __resetBudgetWarningsForTest(): void {
  warnedUnusableBudget.clear();
}

/** 仅供测试注册一个模型条目（生产代码请走 discoverModels）。 */
export function __registerModelForTest(info: ModelContextInfo): void {
  registerDiscoveredModel(info);
}

// ============================================================================
// 运行时发现模型（从 /models 端点）
// ============================================================================

/** 运行时发现的模型上下文窗口 */
const discoveredModels: Map<string, ModelContextInfo> = new Map();

export function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/^.*\//, '');
}

function registerDiscoveredModel(info: ModelContextInfo): void {
  discoveredModels.set(info.id, info);
  const normalized = normalizeModelId(info.id);
  if (normalized && normalized !== info.id) {
    discoveredModels.set(normalized, { ...info, id: normalized, label: info.label || normalized });
  }
}

/**
 * 尝试从 API 端点动态发现模型上下文
 * 调用 OpenAI 兼容的 /models 端点
 */
export async function discoverModelContexts(
  baseUrl: string,
  apiKey: string
): Promise<ModelContextInfo[]> {
  try {
    const url = baseUrl.endsWith('/') ? baseUrl + 'models' : baseUrl + '/models';
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return [];

    const data = (await response.json()) as { data?: Array<Record<string, unknown>> };
    const models: ModelContextInfo[] = [];

    for (const m of data.data || []) {
      const id = String(m.id || '');
      const contextWindow = (m.context_window ?? m.max_context_length) as number | undefined;
      if (contextWindow && id) {
        const valid =
          typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0
            ? contextWindow
            : typeof contextWindow === 'string' &&
                Number.isFinite(Number(contextWindow)) &&
                Number(contextWindow) > 0
              ? Number(contextWindow)
              : undefined;
        if (!valid) continue;
        const info: ModelContextInfo = {
          id,
          label: id,
          contextWindow: valid,
          discovered: true,
        };
        registerDiscoveredModel(info);
        models.push(info);
      }
    }

    return models;
  } catch {
    return []; // 静默失败，回退到内置数据库
  }
}

/**
 * `needle` 是否以「模型 id 边界」的方式出现在 `haystack` 中。
 *
 * 裸 `includes` 会让 `gpt-4` 吞掉 `gpt-4.1`；这里要求：
 *  - 前一个字符不是字母/数字（避免 `mygpt-4o` 命中 `gpt-4o`）；
 *  - 后一个字符不是数字或 `.`（避免版本号被截断：`gpt-4` ⊄ `gpt-4.1`、
 *    `glm-5` ⊄ `glm-5.2`），但允许 `-`（`gpt-4o-2024-05-13` 仍命中 `gpt-4o`）。
 */
function matchesAtBoundary(haystack: string, needle: string): boolean {
  if (!needle || !haystack) return false;

  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return false;

    const before = index > 0 ? haystack[index - 1] : '';
    const after = haystack[index + needle.length] ?? '';

    if (!/[a-z0-9]/.test(before) && !/[0-9.]/.test(after)) {
      return true;
    }
    from = index + 1;
  }
}

/**
 * 解析模型上下文窗口
 * 优先级：动态发现 > 内置数据库 > 模糊/别名匹配 > 默认值
 */
export function resolveModelContext(modelId: string): ModelContextResolution {
  const normalized = normalizeModelId(modelId);

  // 1. 动态发现的模型
  const discovered = discoveredModels.get(modelId) ?? discoveredModels.get(normalized);
  if (discovered) {
    return { ...discovered, source: 'discovered', matchedId: discovered.id };
  }

  // 2. 内置数据库
  const builtin = BUILTIN_MODELS[modelId] ?? BUILTIN_MODELS[normalized];
  if (builtin) {
    return { ...builtin, source: 'builtin', matchedId: builtin.id };
  }

  // 3. 模糊匹配
  //
  // 原实现按对象**声明顺序**做裸 `includes`，于是较短、较早声明的 id 会吃掉更长
  // 的：`gpt-4.1` / `gpt-4-turbo` 全部落到 8k 的 `gpt-4` 条目（进而 safeInputBudget
  // 退化到 1），`glm-5.2-air` 落到 `glm-5` 而不是 `glm-5.2`。
  //
  // 两轮，方向不同、排序也不同：
  //   Pass 1（查询包含 id）：取**最长**命中 —— 越长越具体。
  //   Pass 2（id 包含查询）：取**最短**命中 —— 最贴近的超集，避免
  //                          `gpt-4o:latest` 被 `gpt-4o-mini` 抢走。
  if (!normalized) {
    const firstBuiltinId = Object.keys(BUILTIN_MODELS)[0];
    if (firstBuiltinId) {
      return { ...BUILTIN_MODELS[firstBuiltinId], source: 'fuzzy', matchedId: firstBuiltinId };
    }
  }

  const candidateId = normalized.split(':')[0];
  const ids = Object.keys(BUILTIN_MODELS);

  const containedInQuery = ids
    .filter(id => matchesAtBoundary(normalized, id))
    .sort((a, b) => b.length - a.length);
  if (containedInQuery.length > 0) {
    const id = containedInQuery[0];
    return { ...BUILTIN_MODELS[id], source: 'fuzzy', matchedId: id };
  }

  const containsQuery = ids
    .filter(id => matchesAtBoundary(id, candidateId))
    .sort((a, b) => a.length - b.length);
  if (containsQuery.length > 0) {
    const id = containsQuery[0];
    return { ...BUILTIN_MODELS[id], source: 'fuzzy', matchedId: id };
  }

  // 4. 默认值
  return {
    id: modelId,
    label: modelId || 'unknown',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: 8192,
    source: 'default',
    matchedId: 'default',
  };
}

/**
 * 获取模型上下文窗口
 */
export function getModelContextWindow(modelId: string): number {
  return resolveModelContext(modelId).contextWindow;
}

/**
 * 获取模型信息
 */
export function getModelInfo(modelId: string): ModelContextInfo | null {
  const resolved = resolveModelContext(modelId);
  return resolved.source === 'default' ? null : resolved;
}

/**
 * 计算上下文使用百分比
 */
export function calculateCtxPercent(usedTokens: number, modelId: string): number {
  const contextWindow = getModelContextWindow(modelId);
  return Math.min(100, Math.round((usedTokens / contextWindow) * 100));
}

export function resolveContextBudget(
  modelId: string,
  requestedOutputTokens?: number
): ContextBudget {
  const model = resolveModelContext(modelId);
  const requested = Number.isFinite(requestedOutputTokens)
    ? Math.max(0, Math.round(requestedOutputTokens ?? 0))
    : (model.maxOutputTokens ?? 8192);

  // 输出预留最多占上下文窗口的一半：某些条目的 maxOutputTokens 等于（甚至接近）
  // contextWindow，直接相减会把可用输入预算打到 0/负数。
  const reservedCeiling = Math.max(1, Math.floor(model.contextWindow * MAX_OUTPUT_RESERVE_RATIO));
  const reservedOutputTokens = Math.min(
    requested,
    model.maxOutputTokens ?? requested,
    reservedCeiling
  );
  const safetyMarginTokens = Math.max(1024, Math.ceil(model.contextWindow * 0.02));

  // 兜底：`Math.max(1, …)` 会把配置错误伪装成一个「看起来合理」的 1，
  // 而 safeInputBudget 是 auto-compact 与状态栏占比的分母 —— ratio = used / 1
  // 恒 ≥ 阈值，于是从第一条消息起每轮都触发压缩、状态栏钉死 100%。
  // 非正数时退回按窗口比例估算，并记录一次告警。
  const rawBudget = model.contextWindow - reservedOutputTokens - safetyMarginTokens;
  let safeInputBudget = rawBudget;
  if (safeInputBudget <= 0) {
    safeInputBudget = Math.max(1, Math.floor(model.contextWindow * FALLBACK_INPUT_BUDGET_RATIO));
    warnUnusableBudgetOnce(model.matchedId || modelId, model.contextWindow, safeInputBudget);
  }

  return {
    contextWindow: model.contextWindow,
    reservedOutputTokens,
    safetyMarginTokens,
    safeInputBudget,
  };
}

export function createContextUsageSnapshot(input: {
  modelId: string;
  usedTokens: number;
  source?: ContextUsageSource;
  warningThreshold?: number;
  autoCompactThreshold?: number;
  autoCompactEnabled?: boolean;
  outputReserveTokens?: number;
}): ContextUsageSnapshot {
  const budget = resolveContextBudget(input.modelId, input.outputReserveTokens);
  const contextWindow = budget.contextWindow;
  const usedTokens = Number.isFinite(input.usedTokens)
    ? Math.max(0, Math.round(input.usedTokens))
    : 0;
  const warningThreshold = input.warningThreshold ?? CONTEXT_WARNING_THRESHOLD;
  const autoCompactThreshold = input.autoCompactThreshold ?? AUTO_COMPACT_THRESHOLD;

  return {
    modelId: input.modelId,
    usedTokens,
    contextWindow,
    percent: Math.min(100, Math.floor((usedTokens / budget.safeInputBudget) * 100)),
    rawPercent: Math.min(100, Math.floor((usedTokens / contextWindow) * 100)),
    safeInputBudget: budget.safeInputBudget,
    reservedOutputTokens: budget.reservedOutputTokens,
    safetyMarginTokens: budget.safetyMarginTokens,
    source: input.source ?? 'estimated',
    warningThresholdPercent: Math.round(warningThreshold * 100),
    autoCompactThresholdPercent: Math.round(autoCompactThreshold * 100),
    autoCompactEnabled: input.autoCompactEnabled ?? true,
  };
}

/**
 * 获取所有已知模型列表（内置 + 动态发现）
 */
export function getAllKnownModels(): ModelContextInfo[] {
  const all = [...Object.values(BUILTIN_MODELS)];
  for (const [, discovered] of discoveredModels) {
    if (!all.some(m => m.id === discovered.id)) {
      all.push(discovered);
    }
  }
  return all;
}
