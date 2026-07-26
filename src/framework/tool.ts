/**
 * Orion Code - Tool System v2
 *
 * buildTool() factory pattern for general-purpose agent harness tools.
 */

// ============================================================================
// 类型定义
// ============================================================================

/** JSON Schema for tool input parameters */
export interface ToolInputJSONSchema {
  type: 'object';
  properties: Record<string, {
    type: string;
    description: string;
    enum?: string[];
  }>;
  required?: string[];
}

/** Tool execution result — unified envelope serialized as JSON
 *  into LLM tool result messages. Backward compatible: non-JSON outputs
 *  are auto-wrapped by executeTool. */
export interface ToolResult {
  /** Envelope schema version. 1 = current. Future versions may add fields. */
  schemaVersion?: number;
  success: boolean;
  output: string;
  error?: string;
  /** Compact summary for harness evidence and UI display (optional, falls back to output truncation) */
  summary?: string;
  /** Output size in bytes. Set at runtime by executeTool. */
  outputBytes?: number;
  /** Reference to a disk artifact for large outputs (set by executeTool when output > threshold) */
  artifactRef?: { id: string; outputBytes: number };
  metadata?: Record<string, unknown>;
}

/** Context passed to tool execute and permission checks
 *  Issue #32 #3.2: 支持 abortSignal */
export interface ToolContext {
  cwd: string;
  config: ToolConfig;
  abortSignal?: AbortSignal;
  /** Optional current session id for turn-level tool state tracking */
  sessionId?: string;
  /** Optional turn identifier for per-turn tool bookkeeping */
  turnId?: number | string;
}

/** Minimal config needed by tools */
export interface ToolConfig {
  name: string;
  mode: string;
}

/** Permission check result */
export interface PermissionResult {
  behavior: 'allow' | 'ask' | 'deny';
  reason?: string;
}

/** Orion Code tool definition */
export interface OrionCodeTool {
  /** Unique tool name */
  name: string;
  /** Alternative names */
  aliases?: string[];
  /** Description for LLM function calling */
  description: string;
  /** JSON Schema parameters */
  parameters: ToolInputJSONSchema;
  /** Execute the tool */
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;

  /** Check permissions before execution */
  checkPermissions?(args: Record<string, unknown>, context: ToolContext): PermissionResult;

  /** Can this tool run concurrently with other tools */
  isConcurrencySafe?(args: Record<string, unknown>): boolean;
  /** Is this a read-only operation */
  isReadOnly?(args: Record<string, unknown>): boolean;
  /** Is this a potentially destructive operation */
  isDestructive?(args: Record<string, unknown>): boolean;

  /** User-facing name for display */
  userFacingName?(args: Record<string, unknown>): string;
  /** Compact summary for tool result display */
  getSummary?(args: Record<string, unknown>, result: ToolResult): string;
}

/** @deprecated Use OrionCodeTool instead. */
export type OpenHorseTool = OrionCodeTool;

/** OpenAI function calling tool format */
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolInputJSONSchema;
  };
}

// ============================================================================
// buildTool 工厂
// ============================================================================

/** Default implementations for optional properties */
const TOOL_DEFAULTS = {
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isDestructive: () => false,
  checkPermissions: (): PermissionResult => ({ behavior: 'allow' }),
};

/**
 * Build an OrionCodeTool with default values filled in.
 *
 * @example
 * const myTool = buildTool({
 *   name: 'my_tool',
 *   description: 'Does something useful',
 *   parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] },
 *   execute: async (args) => ({ success: true, output: 'ok' }),
 *   isReadOnly: () => true,
 * });
 */
export function buildTool(def: OrionCodeTool): OrionCodeTool {
  return {
    isConcurrencySafe: TOOL_DEFAULTS.isConcurrencySafe,
    isReadOnly: TOOL_DEFAULTS.isReadOnly,
    isDestructive: TOOL_DEFAULTS.isDestructive,
    checkPermissions: TOOL_DEFAULTS.checkPermissions,
    ...def,
  };
}

// ============================================================================
// toOpenAITool 转换器
// ============================================================================

/** Convert an OrionCodeTool to OpenAI function calling format */
export function toOpenAITool(tool: OrionCodeTool): OpenAITool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/** Convert an array of OrionCodeTools to OpenAI format */
export function toOpenAITools(tools: OrionCodeTool[]): OpenAITool[] {
  return tools.map(toOpenAITool);
}
