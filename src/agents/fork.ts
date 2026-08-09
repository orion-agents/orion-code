/**
 * orion code - Fork Subagent
 *
 * Fork 一个子 Agent 继承父上下文，执行独立任务后返回结果。
 * 参考 OpenClaude 的 forkSubagent.ts 实现。
 */

import type { LLMService, Message } from '../services/llm';
import type { OrionCodeTool, ToolContext } from '../framework/tool';
import type { PermissionMode } from '../commands/types';
import type { ToolConfirmationPolicy } from '../services/config';
import type { ToolAllowlistEvaluator } from '../services/tool-allowlist';
import { query, type PromptContext, getSystemPrompt } from '../framework';
import { TOOLS } from '../tools';

// ============================================================================
// 类型定义
// ============================================================================

export interface ForkOptions {
  /** 继承父上下文（messages + systemPrompt） */
  inheritContext: boolean;
  /** 权限模式 */
  permissionMode?: PermissionMode;
  /** LLM 服务实例。Fork 不会从 CLI 单例中隐式加载。 */
  llm?: LLMService;
  /** 可用工具（默认最小只读工具集） */
  tools?: OrionCodeTool[];
  /** 需要交互确认时的无 UI 回退策略 */
  toolConfirmation?: ToolConfirmationPolicy;
  /** 项目级工具 allow/ask/deny 规则 */
  toolAllowlist?: ToolAllowlistEvaluator;
  /** 最大轮次 */
  maxTurns?: number;
  /** 后台执行（不阻塞父 Agent） */
  background?: boolean;
  /** 任务描述 */
  taskDescription: string;
  /** 父消息历史 */
  parentMessages?: Message[];
  /** 父系统提示 */
  parentSystemPrompt?: string;
  /** 父工作目录 */
  cwd?: string;
  /** 父 memory/skills 内容 */
  memoryContent?: string;
  skillsContent?: string;
}

export interface ForkResult {
  success: boolean;
  content: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: string }>;
  error?: string;
  duration: number;
  tokenUsage?: { promptTokens: number; completionTokens: number };
}

// ============================================================================
// Fork 实现
// ============================================================================

/**
 * Fork 子 Agent 执行任务
 */
export async function forkSubagent(options: ForkOptions): Promise<ForkResult> {
  const {
    inheritContext = true,
    llm,
    tools = getDefaultForkTools(),
    permissionMode = 'plan',
    toolConfirmation,
    toolAllowlist,
    maxTurns = 5,
    background = false,
    taskDescription,
    parentMessages = [],
    parentSystemPrompt,
    cwd = process.cwd(),
    memoryContent = '',
    skillsContent = '',
  } = options;

  const startTime = Date.now();

  // 构建子 Agent 的消息历史
  let messages: Message[];

  if (inheritContext && parentMessages.length > 0) {
    // 继承父上下文，但添加任务消息
    messages = [...parentMessages];
    // 添加 Fork 任务提示
    messages.push({
      role: 'user',
      content: `[Fork Task] ${taskDescription}\n\nYou are a forked subagent. Complete this task independently and report results. Do not ask for clarification - make reasonable assumptions.`,
    });
  } else {
    // 创建独立上下文
    const promptCtx: PromptContext = {
      cwd,
      platform: process.platform,
      nodeVersion: process.version,
      tools,
      memoryContent,
      skillsContent,
    };
    const systemPrompt = parentSystemPrompt || getSystemPrompt(promptCtx);
    messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: taskDescription },
    ];
  }

  const toolContext: ToolContext = {
    cwd,
    config: { name: 'orion-code', mode: 'development' },
    permissionMode,
    toolAllowlist,
  };

  // query scheduler 在调用执行器前统一应用 tool policy、permission mode 与 allowlist。
  const toolExecutor = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find(t => t.name === name);
    if (!tool) {
      return JSON.stringify({ success: false, error: `Unknown tool: ${name}` });
    }
    try {
      const result = await tool.execute(args, toolContext);
      return JSON.stringify(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ success: false, error: message });
    }
  };

  if (!llm) {
    return {
      success: false,
      content: '',
      error: 'No LLM available for fork subagent',
      duration: Date.now() - startTime,
    };
  }

  // 执行查询
  let finalContent = '';
  let finalUsage: { promptTokens: number; completionTokens: number } | undefined;
  const toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string }> = [];

  try {
    for await (const event of query({
      messages,
      tools,
      toolExecutor,
      llm,
      maxTurns,
      permissionMode,
      toolConfirmation,
      toolAllowlist,
      toolContext,
      streamCallbacks: {
        onChunk: (chunk) => {
          if (!background) {
            // 非后台模式：输出到 stdout
            process.stdout.write(chunk);
          }
        },
      },
    })) {
      switch (event.type) {
        case 'tool_call':
          // 收集工具调用
          break;
        case 'tool_result':
          toolCalls.push({
            name: event.name,
            args: event.args,
            result: event.result,
          });
          break;
        case 'complete':
          finalContent = event.content;
          finalUsage = event.usage;
          break;
      }
    }

    return {
      success: true,
      content: finalContent,
      toolCalls,
      duration: Date.now() - startTime,
      tokenUsage: finalUsage,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      content: '',
      error: message,
      duration: Date.now() - startTime,
    };
  }
}

const DEFAULT_FORK_TOOL_NAMES = new Set([
  'read_file',
  'list_files',
  'glob',
  'grep',
  'batch_read',
]);

function getDefaultForkTools(): OrionCodeTool[] {
  return TOOLS.filter(tool => DEFAULT_FORK_TOOL_NAMES.has(tool.name));
}

// ============================================================================
// 防递归保护
// ============================================================================

const FORK_BOILERPLATE_TAG = '<FORK_SUBAGENT>';

/**
 * 检测消息是否来自 Fork Subagent（防止递归 Fork）
 */
export function isForkSubagentMessage(content: string): boolean {
  return content.includes(FORK_BOILERPLATE_TAG);
}

/**
 * 标记 Fork Subagent 消息
 */
export function markForkSubagentMessage(content: string): string {
  return `${FORK_BOILERPLATE_TAG}\n${content}`;
}

// ============================================================================
// 导出
// ============================================================================

export { ForkOptions as ForkSubagentOptions, ForkResult as ForkSubagentResult };
