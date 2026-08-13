/**
 * Orion Code - Tool System v2
 *
 * buildTool() factory pattern for general-purpose agent harness tools.
 */

// ============================================================================
// 类型定义
// ============================================================================

/** JSON Schema for tool input parameters */
export interface ToolInputJSONSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, ToolInputJSONSchemaProperty>;
  required?: string[];
  items?: ToolInputJSONSchemaProperty;
  /** Array bound, sent to the provider so it can cap generated arguments. */
  maxItems?: number;
  minItems?: number;
}

export interface ToolInputJSONSchema {
  type: 'object';
  properties: Record<string, ToolInputJSONSchemaProperty>;
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
  /** Typed external state emitted only by allowlisted adapters/commands. */
  externalAssertion?: import('./external-assertion').ToolExternalAssertion;
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
  /**
   * Active permission mode for this turn.
   *
   * The scheduler resolves permissions once, at the *parent* tool call. Any
   * tool that dispatches other tools (`batch_read`) therefore has to re-run the
   * gate itself, otherwise the sub-steps run unchecked. These two fields are
   * what makes that possible.
   */
  permissionMode?: string;
  /** Project-scoped allowlist evaluator, for the same reason as `permissionMode`. */
  toolAllowlist?: import('../services/tool-allowlist').ToolAllowlistEvaluator;
  /** Confirmation policy inherited from the active logical request. */
  toolConfirmation?: import('../services/config').ToolConfirmationPolicy;
  /**
   * Renderer-owned confirmation bridge for tools that dispatch nested calls.
   * Nested tools must fail closed when this callback is absent.
   */
  confirmToolUse?: (request: {
    name: string;
    args: Record<string, unknown>;
    reason?: string;
    abortSignal?: AbortSignal;
  }) => Promise<boolean>;
  /**
   * Runtime bridge for the bounded Plan lifecycle. Plan tools cannot import a
   * renderer Store directly, so the active runtime projects the transition.
   */
  onPlanModeChange?: (transition: {
    active: boolean;
    currentPlan: string | null;
    returnMode: 'interactive' | 'auto';
  }) => 'interactive' | 'auto' | void;
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
  /**
   * Does this tool mutate local workspace files?
   * Used by permission mode `acceptEdits` to auto-approve file edits while
   * still confirming other side-effecting tools (bash / network / git / MCP).
   */
  isFileEdit?(args: Record<string, unknown>): boolean;

  /** User-facing name for display */
  userFacingName?(args: Record<string, unknown>): string;
  /** Compact summary for tool result display */
  getSummary?(args: Record<string, unknown>, result: ToolResult): string;
}

/**
 * Records which security-sensitive callbacks were declared by a tool.
 *
 * `buildTool()` still supplies compatibility defaults for the public API, but
 * the scheduler must be able to distinguish an explicit `false` from a
 * missing risk declaration. Missing declarations are not evidence that a
 * tool is safe.
 */
export interface ToolMetadataPresence {
  hasPermissionCheck: boolean;
  hasReadOnly: boolean;
  hasDestructive: boolean;
  hasFileEdit: boolean;
}

const TOOL_METADATA = new WeakMap<OrionCodeTool, ToolMetadataPresence>();

/** Return the declared security metadata for a tool, conservatively. */
export function getToolMetadataPresence(tool: OrionCodeTool | undefined): ToolMetadataPresence {
  if (!tool) {
    return {
      hasPermissionCheck: false,
      hasReadOnly: false,
      hasDestructive: false,
      hasFileEdit: false,
    };
  }

  return (
    TOOL_METADATA.get(tool) ?? {
      hasPermissionCheck: typeof tool.checkPermissions === 'function',
      hasReadOnly: typeof tool.isReadOnly === 'function',
      hasDestructive: typeof tool.isDestructive === 'function',
      hasFileEdit: typeof tool.isFileEdit === 'function',
    }
  );
}

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
  isFileEdit: () => false,
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
  const tool: OrionCodeTool = {
    isConcurrencySafe: TOOL_DEFAULTS.isConcurrencySafe,
    isReadOnly: TOOL_DEFAULTS.isReadOnly,
    isDestructive: TOOL_DEFAULTS.isDestructive,
    isFileEdit: TOOL_DEFAULTS.isFileEdit,
    checkPermissions: TOOL_DEFAULTS.checkPermissions,
    ...def,
  };

  TOOL_METADATA.set(tool, {
    hasPermissionCheck: typeof def.checkPermissions === 'function',
    hasReadOnly: typeof def.isReadOnly === 'function',
    hasDestructive: typeof def.isDestructive === 'function',
    hasFileEdit: typeof def.isFileEdit === 'function',
  });

  return tool;
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
