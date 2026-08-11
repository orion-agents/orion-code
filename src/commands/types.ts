/**
 * orion code - Slash Command System
 *
 * 使用 `/` 前缀的命令系统，支持 Tab 补全、命令建议、参数定义。
 * 非 `/` 前缀的输入直接作为 chat 消息处理。
 */

import type { OrionCodeRuntime } from '../init';
import type { Store } from '../framework/store';
import type { LLMService } from '../services/llm';
import type { OrionCodeCLIConfig, UIRenderer } from '../services/config';
import type { SessionMeta } from '../services/session-storage';
import type { CompactCoordinator } from '../services/compact';
import type {
  EditPreviewRequest,
  ModelPickerRequest,
  RuntimeSessionRestoredEvent,
  SessionPickerRequest,
  UiRendererCapabilities,
} from '../runtime/ui-events';

// ============================================================================
// 类型定义 (continued)
// ============================================================================

export type CommandUiRenderer = UIRenderer | 'print';

/** 命令执行上下文 */
export interface CommandContext {
  cwd: string;
  config: OrionCodeCLIConfig;
  store: Store;
  llm: LLMService | null;
  compactCoordinator?: CompactCoordinator;
  runtime: OrionCodeRuntime;
  /** 当前会话 ID（用于记录消息） */
  sessionId?: string;
  /** Lazily create or return the active session. */
  ensureSession?: () => SessionMeta;
  /** Switch the active session after /resume. */
  setSession?: (session: SessionMeta) => void;
  /** Notify renderer-independent runtime protocol consumers after /resume. */
  sessionRestored?: (event: RuntimeSessionRestoredEvent) => void;
  /** Return the active session if one exists. */
  getSession?: () => SessionMeta | null;
  /** Abort signal for the current CLI turn. */
  abortSignal?: AbortSignal;
  /** Optional current turn ID for per-turn command-side context checks. */
  turnId?: number | string;
  /** Write output while preserving the live input frame, when supported by the UI. */
  writeOutput?: (text: string) => void;
  /** Write one line while preserving the live input frame, when supported by the UI. */
  writeLine?: (text?: string) => void;
  /** Ask the active renderer to clear its viewport without deleting session data. */
  clearView?: () => void;
  /** Ask the active renderer to begin graceful shutdown. */
  requestShutdown?: (reason?: string) => void;
  /** Active renderer adapter identity, including non-config renderers such as print mode. */
  uiRenderer?: CommandUiRenderer;
  /** Renderer adapter capabilities. Business commands should prefer these over renderer-name checks. */
  uiCapabilities?: UiRendererCapabilities;
}

/** 命令执行结果 */
export interface CommandResult {
  success: boolean;
  output?: string;
  error?: string;
  /** 需要后续处理（如 chat） */
  continueAsChat?: boolean;
  chatInput?: string;
  /** Structured session picker request forwarded to renderer adapters. */
  sessionPicker?: SessionPickerRequest;
  /** Structured model picker request forwarded to renderer adapters (interactive switching). */
  modelPicker?: ModelPickerRequest;
  /** Structured edit preview request forwarded to renderer adapters. */
  editPreview?: EditPreviewRequest;
  /** Shared provider-aware effort state event projected by every renderer. */
  effortEvent?: import('../runtime/ui-events').RuntimeEffortEvent;
}

/** 命令参数定义 */
export interface CommandParam {
  name: string;
  description: string;
  required?: boolean;
  default?: string;
}

/** 命令类型 */
export type CommandType = 'builtin' | 'tool' | 'chat';

/** Command category used by Ink palettes and grouped help output. */
export type CommandCategory =
  | 'workflow'
  | 'session'
  | 'context'
  | 'tools'
  | 'model'
  | 'system'
  | 'diagnostics'
  | 'legacy';

/** Permission Mode - controls how tools/edits are handled */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto';

/** Agent working mode. This is deliberately independent from tool confirmation policy. */
export type AgentMode = 'interactive' | 'plan' | 'auto';

export const AGENT_MODES: AgentMode[] = ['interactive', 'plan', 'auto'];

/** Permission mode cycle order */
export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto'];

/** Get next permission mode in cycle order */
export function getNextPermissionMode(current: PermissionMode): PermissionMode {
  const idx = PERMISSION_MODES.indexOf(current);
  return PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length];
}

/** Get mode display text */
export function getModeDisplayText(mode: AgentMode): string {
  switch (mode) {
    case 'plan':
      return 'plan mode on';
    case 'auto':
      return 'auto mode';
    default:
      return 'interactive mode';
  }
}

/** Command execution classification. */
export type CommandExecution = 'builtin' | 'agent-workflow' | 'renderer-local';

/** Product audience used to keep compatibility and internal commands out of default surfaces. */
export type CommandAudience = 'primary' | 'advanced' | 'compatibility' | 'internal';

/** Behaviour when a command is submitted while an agent turn is active. */
export type CommandBusyPolicy = 'immediate' | 'queue-next' | 'reject-busy';

/** Registration source. Built-ins are reserved and cannot be shadowed by extensions. */
export type CommandSourceKind = 'builtin' | 'skill' | 'mcp-prompt' | 'plugin';
export type CommandTrust = 'core' | 'user' | 'project' | 'remote';

export interface CommandSource {
  kind: CommandSourceKind;
  id: string;
  trust: CommandTrust;
}

/** Observable effects used by renderers, permission routing, and documentation. */
export type CommandSideEffect =
  | 'none'
  | 'agent-request'
  | 'session-state'
  | 'project-config'
  | 'global-config'
  | 'workspace-write'
  | 'renderer-view'
  | 'process-lifecycle';

export type CommandDefaultAction = 'execute' | 'show-status' | 'open-picker' | 'show-help';

export interface CommandLifecycle {
  status: 'stable' | 'deprecated' | 'internal';
  since?: string;
  removeIn?: string;
  replacement?: string;
}

export interface CommandCompatibilityAlias {
  name: string;
  lifecycle: CommandLifecycle & { status: 'deprecated'; replacement: string };
}

/**
 * Parser-facing argument contract. `raw` preserves the user's values and never
 * performs shell expansion. Domain handlers may layer a stricter schema on top.
 */
export interface CommandArgumentSchema {
  kind: 'none' | 'raw' | 'subcommands';
  opaqueTail: boolean;
  subcommands?: string[];
}

/** Command risk level used for safety metadata and permission routing. */
export type CommandRisk = 'read-only' | 'state-write' | 'destructive';

/** Conditional availability descriptor. */
export interface CommandAvailability {
  available: boolean;
  reason?: string;
}

/** Deprecation metadata for commands that have a planned removal window. */
export interface CommandDeprecation {
  since: string;
  replacement?: string;
  removeIn?: string;
}

/** Slash 命令定义 */
export interface SlashCommand {
  name: string;
  aliases?: string[];
  /** Exact legacy spellings that execute but never appear in discovery surfaces. */
  compatibilityAliases?: CommandCompatibilityAlias[];
  /** 描述（可以是 getter 函数支持动态） */
  description: string;
  /** Product-facing grouping for command palettes and help output. */
  category?: CommandCategory;
  /** Lower values appear earlier inside grouped command lists. */
  priority?: number;
  /** 参数提示（显示在命令名后面） */
  argumentHint?: string;
  params?: CommandParam[];
  type: CommandType;
  /** 是否隐藏（不显示在 help 中） */
  isHidden?: boolean;
  /** Where the command logic lives. */
  execution?: CommandExecution;
  /** Renderers where this command is meaningful. Omit for all-renderer commands. */
  rendererScope?: CommandUiRenderer[];
  /** Safety classification. Commands without metadata default to 'state-write'. */
  risk?: CommandRisk;
  /** Dynamic availability check. Unavailable commands explain why in help/palette. */
  availability?: (ctx: CommandContext) => CommandAvailability;
  /** Deprecation lifecycle metadata. */
  deprecated?: CommandDeprecation;
  execute(ctx: CommandContext, args: string): Promise<CommandResult> | CommandResult;

  /** Registered descriptors populate these fields; raw extension definitions may omit them. */
  id?: string;
  source?: CommandSource;
  audience?: CommandAudience;
  sideEffects?: CommandSideEffect[];
  busyPolicy?: CommandBusyPolicy;
  defaultAction?: CommandDefaultAction;
  lifecycle?: CommandLifecycle;
  argumentSchema?: CommandArgumentSchema;
}

/** Fully validated command returned by the shared registry. */
export interface RegisteredSlashCommand extends SlashCommand {
  id: string;
  source: CommandSource;
  audience: CommandAudience;
  sideEffects: CommandSideEffect[];
  busyPolicy: CommandBusyPolicy;
  defaultAction: CommandDefaultAction;
  lifecycle: CommandLifecycle;
  argumentSchema: CommandArgumentSchema;
}

/** List of renderers that a command scope can apply to. */
export const ALL_RENDERER_SCOPES: CommandUiRenderer[] = ['tui', 'terminal', 'ink', 'print'];

/** Default risk when no explicit metadata is present on a command. */
export const DEFAULT_COMMAND_RISK: CommandRisk = 'state-write';
