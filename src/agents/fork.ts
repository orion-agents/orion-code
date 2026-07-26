/**
 * orion code - Fork Subagent
 *
 * Fork 一个子 Agent 继承父上下文，执行独立任务后返回结果。
 * 参考 OpenClaude 的 forkSubagent.ts 实现。
 */

import type { Message } from '../services/llm';
import type { OpenHorseTool } from '../framework/tool';
import type { PermissionMode } from '../commands/types';
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
  /** 可用工具（默认 TOOLS） */
  tools?: OpenHorseTool[];
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
    tools = TOOLS,
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

  // 工具执行器
  const toolExecutor = async (name: string, args: Record<string, unknown>) => {
    // 简化版：直接执行工具
    const tool = tools.find(t => t.name === name);
    if (!tool) {
      return JSON.stringify({ success: false, error: `Unknown tool: ${name}` });
    }
    // 调用工具的 execute
    const context = { cwd, config: { name: 'orion-code', mode: 'development' } };
    try {
      const result = await tool.execute(args, context);
      return JSON.stringify(result);
    } catch (err: any) {
      return JSON.stringify({ success: false, error: err.message });
    }
  };

  // 简化的 LLM（不使用完整 LLMService，避免依赖）
  // 这里假设有全局的 llm 实例可用
  const llm = getGlobalLLM();
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
  } catch (err: any) {
    return {
      success: false,
      content: '',
      error: err.message,
      duration: Date.now() - startTime,
    };
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 获取全局 LLM 实例（从 CLI 模块）
 * 注意：这是一个简化实现，实际应该通过参数传递 LLM
 */
function getGlobalLLM(): any {
  // 尝试从全局获取
  try {
    const cliModule = require('../cli');
    if (cliModule.llm) {
      return cliModule.llm;
    }
  } catch {
    // ignore
  }
  return null;
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
