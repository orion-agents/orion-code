/**
 * orion code - Slash Command System
 *
 * 使用 `/` 前缀的命令系统，支持 Tab 补全、命令建议、参数定义。
 * 非 `/` 前缀的输入直接作为 chat 消息处理。
 */

import type { OpenHorseRuntime } from '../init';
import type { Store } from '../framework/store';
import type { LLMService } from '../services/llm';
import type { OpenHorseCLIConfig, UIRenderer } from '../services/config';
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
  config: OpenHorseCLIConfig;
  store: Store;
  llm: LLMService | null;
  compactCoordinator?: CompactCoordinator;
  runtime: OpenHorseRuntime;
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

/** Permission mode cycle order */
export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto'];

/** Get next permission mode in cycle order */
export function getNextPermissionMode(current: PermissionMode): PermissionMode {
  const idx = PERMISSION_MODES.indexOf(current);
  return PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length];
}

/** Get mode display text */
export function getModeDisplayText(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return 'plan mode on';
    case 'acceptEdits':
      return 'auto-accept edits';
    case 'auto':
      return 'auto mode';
    default:
      return '';
  }
}

/** Command execution classification. */
export type CommandExecution = 'builtin' | 'agent-workflow' | 'renderer-local';

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
}

/** List of renderers that a command scope can apply to. */
export const ALL_RENDERER_SCOPES: CommandUiRenderer[] = ['tui', 'terminal', 'ink', 'print'];

/** Default risk when no explicit metadata is present on a command. */
export const DEFAULT_COMMAND_RISK: CommandRisk = 'state-write';
