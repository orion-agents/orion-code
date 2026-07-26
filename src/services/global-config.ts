/**
 * Orion Code - global configuration management.
 *
 * Config stored in ~/.orion-code/orion.json
 * Environment variable overrides use ORION_CODE_ prefix.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { ensureConfigDir, getGlobalConfigPath, getConfigDir } from './config-dir';
import type { ModelPricing } from '../core/cost-tracker';

// ============================================================================
// 类型定义
// ============================================================================

/** 项目级配置 */
export interface ProjectConfig {
  /** 允许的工具列表 */
  allowedTools?: string[];
  /** 最后会话 ID */
  lastSessionId?: string;
  /** 最后使用的模型 */
  lastModel?: string;
  /** 是否已接受信任对话框 */
  hasTrustDialogAccepted?: boolean;
}

/** How to handle tool permission checks that request interactive confirmation. */
export type ToolConfirmationPolicy = 'ask' | 'allow' | 'deny';

/** Runtime-only UI renderer selection. Terminal is stable; TUI is recommended beta; Ink is deprecated beta. */
export type UIRenderer = 'terminal' | 'tui' | 'ink';

/** How UI permission prompts should be handled. */
export type UIConfirmationMode = 'config' | 'interactive';

/** UI configuration that is safe to persist globally. */
export interface UIConfig {
  /** Runtime-only renderer override. This is ignored in orion.json. */
  renderer?: UIRenderer;
  /** Whether confirmations are handled by config fallback or interactive UI. */
  confirmations?: UIConfirmationMode;
}

/** Remote MCP service used by the built-in web_search tool. */
export interface WebSearchMcpConfig {
  /** Provider profile id. Use "auto" or omit to infer from apiBaseUrl/model. */
  provider?: string;
  /** Streamable HTTP MCP endpoint. */
  endpoint?: string;
  /** API key for the WebSearch MCP service. */
  apiKey?: string;
  /** Optional tool name override when the MCP exposes multiple tools. */
  toolName?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** How to apply apiKey. Defaults to bearer Authorization. */
  authType?: 'bearer' | 'header' | 'query' | 'none';
  /** Header name for authType "bearer" or "header". Defaults to Authorization. */
  apiKeyHeader?: string;
  /** Query parameter name for authType "query". */
  apiKeyQueryParam?: string;
  /** Extra HTTP headers for the MCP endpoint. */
  headers?: Record<string, string>;
}

/** Additional skills roots loaded at startup. */
export interface SkillsConfig {
  /** Paths to skill roots or direct skill directories. */
  paths?: string[];
}

/** Agent-loop guardrails. Defaults remain internal, these fields only override them. */
export interface AgentLoopBudgetConfig {
  /** Maximum LLM requests allowed for one user turn. */
  maxLlmRequestsPerUserTurn?: number;
  /** Maximum tool calls allowed for one user turn. */
  maxToolCallsPerUserTurn?: number;
  /** Consecutive single read-only tool turns before injecting a batch_read hint. */
  maxReadOnlyFragmentation?: number;
  /** Maximum aggregate tool-result bytes exposed to the model in one user turn. */
  maxModelVisibleToolBytes?: number;
}

export interface AgentLoopConfig {
  /** Optional budget overrides. Orion Code may still raise defaults for complex tasks. */
  budget?: AgentLoopBudgetConfig;
}

/** Subagent mode: whether the `subtask` capability is exposed to the root Agent. */
export type SubagentMode = 'off' | 'explicit' | 'auto';

/** Built-in subagent roles exposed to the root Agent. */
export type SubagentRole = 'research' | 'review' | 'test-investigate';

/**
 * User-facing subagent configuration (all fields optional; missing fields fall
 * back to runtime defaults). The runtime resolves and clamps this to a full
 * {@link SubagentConfig} at startup.
 */
export interface SubagentUserConfig {
  mode?: SubagentMode;
  maxParallel?: number;
  maxTasksPerTurn?: number;
  maxTurnsPerTask?: number;
  maxModelRequestsPerTask?: number;
  maxModelRequestsPerTurn?: number;
  maxToolCallsPerTask?: number;
  timeoutMs?: number;
  roles?: SubagentRole[];
}

/** Cost-accounting configuration. Rates are USD per one million tokens. */
export interface CostConfig {
  /** Per-model overrides for providers that do not return billed cost. */
  modelPricing?: Record<string, ModelPricing>;
  /** Fallback for unknown models. Omit to use Orion Code's conservative estimate. */
  defaultPricing?: ModelPricing;
}

/**
 * 全局配置 — 用户只需关注少量核心项
 * maxTokens/temperature/retries 等由 Agent 智能控制
 */
export interface GlobalConfig {
  /** LLM API Key */
  apiKey?: string;
  /** API Base URL */
  apiBaseUrl?: string;
  /** 默认模型 */
  defaultModel: string;
  /** 备用模型（主模型过载时自动切换） */
  fallbackModel?: string;
  /** Tool confirmation fallback while the current CLI cannot show prompts. */
  toolConfirmation?: ToolConfirmationPolicy;
  /** WebSearch MCP configuration. */
  webSearch?: WebSearchMcpConfig;
  /** Terminal UI configuration. */
  ui?: UIConfig;
  /** Additional user-managed skills roots. */
  skills?: SkillsConfig;
  /** Agent-loop guardrails. */
  agentLoop?: AgentLoopConfig;
  /** Read-only subagent runtime configuration (v0.2.20 beta). */
  subagents?: SubagentUserConfig;
  /** Cost-accounting overrides for custom or routed models. */
  cost?: CostConfig;

  // ---- 内部标识 ----
  userId?: string;
  firstStartTime?: string;

  // ---- 项目配置 ----
  projects?: Record<string, ProjectConfig>;
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: GlobalConfig = {
  defaultModel: 'gpt-4o',
  toolConfirmation: 'allow',
};

interface LegacyUsageFields {
  totalSessions?: unknown;
  totalTokens?: unknown;
  totalCost?: unknown;
}

function sanitizeGlobalConfig(config: GlobalConfig & LegacyUsageFields): GlobalConfig {
  const {
    ui,
    totalSessions: _totalSessions,
    totalTokens: _totalTokens,
    totalCost: _totalCost,
    ...rest
  } = config;
  void _totalSessions;
  void _totalTokens;
  void _totalCost;
  const sanitized: GlobalConfig = { ...rest };

  // UI renderer is a runtime choice, not persisted global configuration.
  if (ui?.confirmations && ui.confirmations !== 'config') {
    sanitized.ui = { confirmations: ui.confirmations };
  }

  return sanitized;
}

// ============================================================================
// 加载/保存
// ============================================================================

/**
 * 加载全局配置
 * 如果文件不存在，返回默认配置
 */
export function loadGlobalConfig(): GlobalConfig {
  ensureConfigDir();
  const path = getGlobalConfigPath();

  if (!existsSync(path)) {
    return sanitizeGlobalConfig({ ...DEFAULT_CONFIG });
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(content);
    return sanitizeGlobalConfig({ ...DEFAULT_CONFIG, ...parsed });
  } catch {
    return sanitizeGlobalConfig({ ...DEFAULT_CONFIG });
  }
}

/**
 * 保存全局配置
 */
export function saveGlobalConfig(config: GlobalConfig & LegacyUsageFields): void {
  ensureConfigDir();
  const path = getGlobalConfigPath();
  writeFileSync(path, JSON.stringify(sanitizeGlobalConfig(config), null, 2), { mode: 0o600 });
}

/**
 * 更新全局配置（部分更新）
 */
export function updateGlobalConfig(updates: Partial<GlobalConfig>): GlobalConfig {
  const config = loadGlobalConfig();
  const newConfig = { ...config, ...updates };
  saveGlobalConfig(newConfig);
  return newConfig;
}

// ============================================================================
// 项目配置
// ============================================================================

export function getProjectConfig(projectPath: string): ProjectConfig {
  const config = loadGlobalConfig();
  return config.projects?.[projectPath] ?? {};
}

export function saveProjectConfig(projectPath: string, projectConfig: ProjectConfig): void {
  const config = loadGlobalConfig();
  config.projects = {
    ...config.projects,
    [projectPath]: projectConfig,
  };
  saveGlobalConfig(config);
}

// ============================================================================
// 用户 ID
// ============================================================================

export function getOrCreateUserId(): string {
  const config = loadGlobalConfig();

  if (config.userId) {
    return config.userId;
  }

  const userId = randomBytes(16).toString('hex');
  updateGlobalConfig({ userId });
  return userId;
}

export function recordFirstStartTime(): void {
  const config = loadGlobalConfig();
  if (!config.firstStartTime) {
    updateGlobalConfig({ firstStartTime: new Date().toISOString() });
  }
}

export { incrementSessionCount, updateTokenStats } from './usage-state';

// ============================================================================
// 输入历史
// ============================================================================

const MAX_INPUT_HISTORY = 1000;

export interface InputHistoryEntry {
  content: string;
  timestamp: number;
}

function getInputHistoryPath(): string {
  return join(getConfigDir(), 'input-history.json');
}

export function getInputHistory(): InputHistoryEntry[] {
  const path = getInputHistoryPath();
  if (!existsSync(path)) {
    return [];
  }
  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

function saveInputHistory(history: InputHistoryEntry[]): void {
  ensureConfigDir();
  const path = getInputHistoryPath();
  writeFileSync(path, JSON.stringify(history, null, 2), { mode: 0o600 });
}

export function addToInputHistory(content: string): void {
  if (!content.trim()) return;

  const history = getInputHistory();

  const existingIndex = history.findIndex(h => h.content === content);
  if (existingIndex >= 0) {
    history.splice(existingIndex, 1);
  }

  history.unshift({
    content,
    timestamp: Date.now(),
  });

  if (history.length > MAX_INPUT_HISTORY) {
    history.splice(MAX_INPUT_HISTORY);
  }

  saveInputHistory(history);
}

export function searchInputHistory(query: string): InputHistoryEntry[] {
  const history = getInputHistory();
  if (!query) return history.slice(0, 20);
  return history.filter(h => h.content.toLowerCase().includes(query.toLowerCase())).slice(0, 20);
}
