/**
 * Orion Code - global configuration management.
 *
 * Config stored in ~/.orion-code/orion.json
 * Environment variable overrides use ORION_CODE_ prefix.
 */

import { existsSync, readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { ensureConfigDir, getGlobalConfigPath, getConfigDir } from './config-dir';
import { atomicWriteFileSync } from './atomic-write';
import { withFileLockSync } from './file-lock';
import type { ModelPricing } from '../core/cost-tracker';
import { isEffortPreference, type EffortPreference } from './effort';

// ============================================================================
// 类型定义
// ============================================================================

/** 项目级配置 */
export interface ProjectConfig {
  /** 允许的工具列表 */
  allowedTools?: string[];
  /**
   * Project-level sandbox override, shallow-merged on top of `GlobalConfig.sandbox`.
   * Absent keys inherit the global value; the effective default is `profile: 'none'`.
   */
  sandbox?: SandboxConfig;
  /** 最后会话 ID */
  lastSessionId?: string;
  /** 最后使用的模型 */
  lastModel?: string;
  /** 是否已接受信任对话框 */
  hasTrustDialogAccepted?: boolean;
  /** Project default reasoning effort. */
  defaultEffort?: EffortPreference;
}

/** How to handle tool permission checks that request interactive confirmation. */
export type ToolConfirmationPolicy = 'ask' | 'allow' | 'deny';

/**
 * OS-level isolation requested for shell command execution.
 * `none` is the default and reproduces pre-sandbox behaviour exactly.
 */
export type SandboxProfile = 'none' | 'read-only' | 'workspace-write';

/** Concrete mechanism used to deliver a {@link SandboxProfile}. */
export type SandboxBackend = 'seatbelt' | 'bubblewrap' | 'docker';

/**
 * Sandbox settings. Valid at global scope and, as an override, per project.
 * See `src/tools/sandbox.ts` for the full contract (probing, fail-closed
 * behaviour and backend selection).
 */
export interface SandboxConfig {
  /** Defaults to `none`. Unknown values fail closed instead of downgrading. */
  profile?: SandboxProfile;
  /** Force a backend instead of auto-selecting the first available one. */
  backend?: SandboxBackend | 'auto';
  /** Allow outbound network. Defaults to false for every non-`none` profile. */
  allowNetwork?: boolean;
  /** Extra writable roots for `workspace-write`, beyond the cwd and temp dir. */
  writableRoots?: string[];
  /** Container image; required by (and only used for) the `docker` backend. */
  image?: string;
}

/** Runtime-only UI renderer selection. TUI is the product default; Terminal is the technical fallback; Ink is deprecated (removed in v0.2.0). */
export type UIRenderer = 'terminal' | 'tui' | 'ink';

/** How UI permission prompts should be handled. */
export type UIConfirmationMode = 'config' | 'interactive';

/** Stable TUI theme ids. Orion Pixel is the product default from v0.1.7. */
export type TuiThemePreference = 'orion-pixel' | 'classic' | 'high-contrast' | 'auto';
export type TuiMotionPreference = 'full' | 'reduced' | 'off';
export type TuiStatusItem =
  | 'mode'
  | 'goal'
  | 'model'
  | 'effort'
  | 'context'
  | 'permission'
  | 'queue'
  | 'activity';

/** Semantic keymap actions. Raw escape sequences are deliberately unsupported. */
export type TuiKeymapAction =
  | 'submit'
  | 'queue'
  | 'interrupt'
  | 'history-search'
  | 'external-editor'
  | 'transcript'
  | 'redraw'
  | 'exit';

/** UI configuration that is safe to persist globally. */
export interface UIConfig {
  /** Runtime-only renderer override. This is ignored in orion.json. */
  renderer?: UIRenderer;
  /** Whether confirmations are handled by config fallback or interactive UI. */
  confirmations?: UIConfirmationMode;
  /** Product theme. Existing configs without this field receive Orion Pixel. */
  theme?: TuiThemePreference;
  /** Motion policy for bounded terminal animations. */
  motion?: TuiMotionPreference;
  /** Show the Orion pixel hunter when space permits. */
  mascot?: boolean;
  /** Ordered, renderer-owned status items. */
  statusLine?: TuiStatusItem[];
  /** Optional semantic key bindings; invalid/conflicting bindings are ignored. */
  keymap?: Partial<Record<TuiKeymapAction, string[]>>;
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
  /** Persisted configuration schema version; absent in legacy files. */
  schemaVersion?: number;
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
  /** Machine-wide tool permission rules applied to every project. */
  allowedTools?: string[];
  /** Global default reasoning effort. */
  defaultEffort?: EffortPreference;
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
  /** OS-level sandbox for shell execution. Defaults to `{ profile: 'none' }`. */
  sandbox?: SandboxConfig;

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
  schemaVersion: 1,
  defaultModel: 'gpt-4o',
  toolConfirmation: 'allow',
};

const CONFIG_SCHEMA_VERSION = 1;

const TUI_THEME_PREFERENCES = new Set<TuiThemePreference>([
  'orion-pixel',
  'classic',
  'high-contrast',
  'auto',
]);
const TUI_MOTION_PREFERENCES = new Set<TuiMotionPreference>(['full', 'reduced', 'off']);
const TUI_STATUS_ITEMS = new Set<TuiStatusItem>([
  'mode',
  'goal',
  'model',
  'effort',
  'context',
  'permission',
  'queue',
  'activity',
]);
const TUI_KEYMAP_ACTIONS = new Set<TuiKeymapAction>([
  'submit',
  'queue',
  'interrupt',
  'history-search',
  'external-editor',
  'transcript',
  'redraw',
  'exit',
]);
const TUI_KEY_BINDINGS = new Set([
  'enter',
  'tab',
  'escape',
  'ctrl+c',
  'ctrl+d',
  'ctrl+e',
  'ctrl+l',
  'ctrl+o',
  'ctrl+r',
]);

function sanitizeUiConfig(value: unknown): UIConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const ui: UIConfig = {};
  if (raw.confirmations === 'config' || raw.confirmations === 'interactive') {
    ui.confirmations = raw.confirmations;
  }
  if (typeof raw.theme === 'string' && TUI_THEME_PREFERENCES.has(raw.theme as TuiThemePreference)) {
    ui.theme = raw.theme as TuiThemePreference;
  }
  if (
    typeof raw.motion === 'string' &&
    TUI_MOTION_PREFERENCES.has(raw.motion as TuiMotionPreference)
  ) {
    ui.motion = raw.motion as TuiMotionPreference;
  }
  if (typeof raw.mascot === 'boolean') ui.mascot = raw.mascot;
  if (Array.isArray(raw.statusLine)) {
    ui.statusLine = [
      ...new Set(
        raw.statusLine.filter(
          (item): item is TuiStatusItem =>
            typeof item === 'string' && TUI_STATUS_ITEMS.has(item as TuiStatusItem)
        )
      ),
    ];
  }
  if (raw.keymap && typeof raw.keymap === 'object' && !Array.isArray(raw.keymap)) {
    const keymap: UIConfig['keymap'] = {};
    const claimedBindings = new Set<string>();
    for (const [action, bindings] of Object.entries(raw.keymap as Record<string, unknown>)) {
      if (!TUI_KEYMAP_ACTIONS.has(action as TuiKeymapAction) || !Array.isArray(bindings)) continue;
      const normalized = bindings.filter(
        (binding): binding is string =>
          typeof binding === 'string' && TUI_KEY_BINDINGS.has(binding.trim().toLowerCase())
      );
      const unique = [...new Set(normalized.map(binding => binding.trim().toLowerCase()))].filter(
        binding => {
          if (claimedBindings.has(binding)) return false;
          claimedBindings.add(binding);
          return true;
        }
      );
      if (unique.length > 0) keymap[action as TuiKeymapAction] = unique;
    }
    if (Object.keys(keymap).length > 0) ui.keymap = keymap;
  }
  return Object.keys(ui).length > 0 ? ui : undefined;
}

interface LegacyUsageFields {
  totalSessions?: unknown;
  totalTokens?: unknown;
  totalCost?: unknown;
}

function sanitizeSandboxConfig(value: unknown): SandboxConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const sanitized: SandboxConfig = {};

  // Preserve invalid enum values as strings so sandbox planning fails closed
  // with an explicit diagnostic instead of silently downgrading to `none`.
  if (raw.profile !== undefined) {
    sanitized.profile = String(raw.profile) as SandboxConfig['profile'];
  }
  if (raw.backend !== undefined) {
    sanitized.backend = String(raw.backend) as SandboxConfig['backend'];
  }
  if (raw.allowNetwork !== undefined && typeof raw.allowNetwork === 'boolean') {
    sanitized.allowNetwork = raw.allowNetwork;
  }
  if (Array.isArray(raw.writableRoots)) {
    sanitized.writableRoots = raw.writableRoots.filter(
      (root): root is string => typeof root === 'string' && root.trim().length > 0
    );
  }
  if (raw.image !== undefined && typeof raw.image === 'string') {
    sanitized.image = raw.image;
  }

  return sanitized;
}

function sanitizeProjectConfig(value: unknown): ProjectConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const sanitized: ProjectConfig = {};

  if (Array.isArray(raw.allowedTools) && raw.allowedTools.every(item => typeof item === 'string')) {
    sanitized.allowedTools = [...(raw.allowedTools as string[])];
  }
  const sandbox = sanitizeSandboxConfig(raw.sandbox);
  if (sandbox) sanitized.sandbox = sandbox;
  if (typeof raw.lastSessionId === 'string') sanitized.lastSessionId = raw.lastSessionId;
  if (typeof raw.lastModel === 'string') sanitized.lastModel = raw.lastModel;
  if (typeof raw.hasTrustDialogAccepted === 'boolean') {
    sanitized.hasTrustDialogAccepted = raw.hasTrustDialogAccepted;
  }
  if (isEffortPreference(raw.defaultEffort)) sanitized.defaultEffort = raw.defaultEffort;
  return sanitized;
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
  const sanitized: GlobalConfig = { ...rest, schemaVersion: CONFIG_SCHEMA_VERSION };
  if (
    Array.isArray(rest.allowedTools) &&
    rest.allowedTools.every(item => typeof item === 'string')
  ) {
    sanitized.allowedTools = [...new Set(rest.allowedTools)];
  } else {
    delete sanitized.allowedTools;
  }
  if (!isEffortPreference(rest.defaultEffort)) delete sanitized.defaultEffort;

  const sandbox = sanitizeSandboxConfig(rest.sandbox);
  if (sandbox) sanitized.sandbox = sandbox;
  else delete sanitized.sandbox;

  if (rest.projects && typeof rest.projects === 'object') {
    sanitized.projects = Object.fromEntries(
      Object.entries(rest.projects).map(([projectPath, projectConfig]) => [
        projectPath,
        sanitizeProjectConfig(projectConfig),
      ])
    );
  }

  // UI renderer is a runtime choice, but product preferences are persisted.
  const persistedUi = sanitizeUiConfig(ui);
  if (persistedUi) sanitized.ui = persistedUi;

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
  withFileLockSync(path, () => saveGlobalConfigUnlocked(path, config), { waitMs: 10_000 });
}

function saveGlobalConfigUnlocked(path: string, config: GlobalConfig & LegacyUsageFields): void {
  // orion.json holds provider credentials; an interrupted in-place write makes
  // it unparseable and the loader falls back to defaults, wiping the config.
  atomicWriteFileSync(path, JSON.stringify(sanitizeGlobalConfig(config), null, 2), {
    mode: 0o600,
    fsync: true,
  });
}

/**
 * 更新全局配置（部分更新）
 */
export function updateGlobalConfig(updates: Partial<GlobalConfig>): GlobalConfig {
  ensureConfigDir();
  const path = getGlobalConfigPath();
  return withFileLockSync(
    path,
    () => {
      const config = loadGlobalConfig();
      const newConfig = { ...config, ...updates };
      saveGlobalConfigUnlocked(path, newConfig);
      return newConfig;
    },
    { waitMs: 10_000 }
  );
}

// ============================================================================
// 项目配置
// ============================================================================

export function getProjectConfig(projectPath: string): ProjectConfig {
  const config = loadGlobalConfig();
  return sanitizeProjectConfig(config.projects?.[projectPath]);
}

export function saveProjectConfig(projectPath: string, projectConfig: ProjectConfig): void {
  ensureConfigDir();
  const path = getGlobalConfigPath();
  withFileLockSync(
    path,
    () => {
      const config = loadGlobalConfig();
      config.projects = {
        ...config.projects,
        [projectPath]: projectConfig,
      };
      saveGlobalConfigUnlocked(path, config);
    },
    { waitMs: 10_000 }
  );
}

// ============================================================================
// 用户 ID
// ============================================================================

export function getOrCreateUserId(): string {
  ensureConfigDir();
  const path = getGlobalConfigPath();
  return withFileLockSync(
    path,
    () => {
      const config = loadGlobalConfig();
      if (config.userId) return config.userId;
      const userId = randomBytes(16).toString('hex');
      saveGlobalConfigUnlocked(path, { ...config, userId });
      return userId;
    },
    { waitMs: 10_000 }
  );
}

export function recordFirstStartTime(): void {
  ensureConfigDir();
  const path = getGlobalConfigPath();
  withFileLockSync(
    path,
    () => {
      const config = loadGlobalConfig();
      if (!config.firstStartTime) {
        saveGlobalConfigUnlocked(path, { ...config, firstStartTime: new Date().toISOString() });
      }
    },
    { waitMs: 10_000 }
  );
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
  atomicWriteFileSync(path, JSON.stringify(history, null, 2), { mode: 0o600 });
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
