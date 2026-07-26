/**
 * orion code - Agent 执行器
 *
 * 将 LLM 集成到 Agent 执行流程中：
 *   - 构建系统提示词与任务上下文
 *   - 通过 LLM 驱动 Agent 执行
 *   - 支持流式输出、重试、Token 统计
 */

import { EventEmitter } from 'eventemitter3';
import { BaseAgent, Task, TaskResult } from '../core/agent';
import { LLMService, Message } from './llm';

// ============================================================================
// 类型定义
// ============================================================================

/** AgentRunner 配置 */
export interface AgentRunnerConfig {
  /** 最大重试次数 */
  maxRetries?: number;
  /** 是否在出错时回退到 BaseAgent.execute */
  fallbackOnError?: boolean;
  /** 自定义系统提示词模板 */
  systemPrompt?: string;
}

/** AgentRunner 执行结果（含 LLM 信息） */
export interface AgentRunnerResult extends TaskResult {
  /** LLM 回复内容 */
  llmContent?: string;
  /** Token 用量 */
  tokenUsage?: { promptTokens: number; completionTokens: number };
  /** 使用的模型 */
  model?: string;
  /** 重试次数 */
  retries: number;
}

/** AgentRunner 事件 */
export interface AgentRunnerEvents {
  'execute-start': (task: Task) => void;
  'execute-complete': (task: Task, result: AgentRunnerResult) => void;
  'execute-failed': (task: Task, error: Error) => void;
  'stream-chunk': (chunk: string) => void;
}

// ============================================================================
// 默认系统提示词
// ============================================================================

const DEFAULT_SYSTEM_PROMPT = `You are an AI agent in a multi-agent system.
Your core mission is to solve problems — persist through failures, try alternatives.

Respond in JSON format with the following structure:
{
  "success": boolean,
  "summary": "brief description of what was done",
  "details": "detailed output or explanation",
  "artifacts": ["list of created files or resources"]
}

When stuck, try at least 2 different approaches. Ask for clarification only when genuinely needed.`;

// ============================================================================
// AgentRunner - 将 LLM 集成到 Agent 执行
// ============================================================================

export class AgentRunner extends EventEmitter {
  private agent: BaseAgent;
  private llm: LLMService;
  private config: Required<AgentRunnerConfig>;

  constructor(agent: BaseAgent, llm: LLMService, config?: AgentRunnerConfig) {
    super();
    this.agent = agent;
    this.llm = llm;
    this.config = {
      maxRetries: config?.maxRetries ?? 3,
      fallbackOnError: config?.fallbackOnError ?? true,
      systemPrompt: config?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    };
  }

  /**
   * 执行任务 — 通过 LLM 驱动 Agent
   */
  async run(task: Task): Promise<AgentRunnerResult> {
    const startTime = Date.now();
    this.emit('execute-start', task);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const messages = this.buildMessages(task);

        const response = await this.llm.chat(messages);

        const duration = Date.now() - startTime;
        const result: AgentRunnerResult = {
          success: true,
          data: this.parseResponse(response.content),
          llmContent: response.content,
          tokenUsage: response.usage,
          model: response.model,
          duration,
          retries: attempt,
        };

        this.emit('execute-complete', task, result);
        return result;
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`[AgentRunner] Attempt ${attempt + 1} failed: ${lastError.message}`);
      }
    }

    // 所有重试失败，尝试 fallback
    if (this.config.fallbackOnError) {
      console.warn('[AgentRunner] All retries failed, using fallback execute');
      try {
        const fallbackResult = await this.agent.execute(task);
        const duration = Date.now() - startTime;
        const result: AgentRunnerResult = {
          ...fallbackResult,
          retries: this.config.maxRetries + 1,
          duration,
        };
        this.emit('execute-complete', task, result);
        return result;
      } catch {
        // fallback also fails, report the original error
      }
    }

    const duration = Date.now() - startTime;
    const errorResult: AgentRunnerResult = {
      success: false,
      error: lastError?.message ?? 'Unknown error',
      duration,
      retries: this.config.maxRetries + 1,
    };

    this.emit('execute-failed', task, lastError ?? new Error('Unknown error'));
    return errorResult;
  }

  /**
   * 流式执行 — 适合需要实时反馈的场景
   */
  async runStream(
    task: Task,
    onChunk?: (chunk: string) => void,
  ): Promise<AgentRunnerResult> {
    const startTime = Date.now();
    this.emit('execute-start', task);

    const messages = this.buildMessages(task);

    try {
      const response = await this.llm.chatStream(messages, (chunk: string) => {
        if (onChunk) onChunk(chunk);
        this.emit('stream-chunk', chunk);
      });

      const duration = Date.now() - startTime;
      const result: AgentRunnerResult = {
        success: true,
        data: this.parseResponse(response.content),
        llmContent: response.content,
        tokenUsage: response.usage,
        model: response.model,
        duration,
        retries: 0,
      };

      this.emit('execute-complete', task, result);
      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorResult: AgentRunnerResult = {
        success: false,
        error: error.message ?? 'Stream execution failed',
        duration,
        retries: 0,
      };

      this.emit('execute-failed', task, error instanceof Error ? error : new Error(String(error)));
      return errorResult;
    }
  }

  /**
   * 获取 Agent 引用
   */
  getAgent(): BaseAgent {
    return this.agent;
  }

  /**
   * 获取 LLM 引用
   */
  getLLM(): LLMService {
    return this.llm;
  }

  // ---- Internal ----

  /** 构建 LLM 对话消息 */
  private buildMessages(task: Task): Message[] {
    const agentStatus = this.agent.getStatus();

    const userContent = [
      `## Task: ${task.name}`,
      `**Description:** ${task.description}`,
      `**Priority:** ${task.priority}`,
      `**Agent:** ${agentStatus.name} (${agentStatus.id})`,
      `**Capabilities:** ${agentStatus.capabilities.join(', ')}`,
    ];

    if (task.params) {
      userContent.push(`**Parameters:** ${JSON.stringify(task.params, null, 2)}`);
    }

    userContent.push('Please analyze and execute this task. Respond in JSON format.');

    return [
      { role: 'system', content: this.config.systemPrompt },
      { role: 'user', content: userContent.join('\n') },
    ];
  }

  /** 解析 LLM 响应 */
  private parseResponse(content: string): any {
    // 尝试提取 JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // fall through to raw text
      }
    }
    return { summary: content };
  }
}
