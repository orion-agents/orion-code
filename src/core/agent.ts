/**
 * x-agent - Agent 基类
 *
 * 所有 Agent 的基础类，提供统一的生命周期管理和能力接口
 *
 * Issue #32 #2.4: 类型安全重构 - 引入泛型 + 鉴别联合
 */

import { EventEmitter } from 'eventemitter3';
import { v4 as uuidv4 } from 'uuid';

export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  maxRetries?: number;
  timeout?: number;
}

// Issue #32 #2.4: Skill 上下文泛型化
export interface SkillContext<P = Record<string, unknown>> {
  name: string;
  params?: P;
}

// Issue #32 #2.4: TaskResult 类型定义
// 渐进式迁移策略：保留宽松类型兼容现有代码，添加 kind 字段用于类型区分
export interface TaskResultData {
  kind?: 'file' | 'command' | 'metrics' | 'generic' | 'session';
  // File 类型
  content?: string;
  path?: string;
  // Command 类型
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  // Metrics 类型
  steps?: number;
  metrics?: Record<string, number>;
  // Session 类型
  summary?: string;
  // Generic 类型
  value?: unknown;
}

export interface Task {
  id: string;
  name: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  assignedTo: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  params?: Record<string, unknown>;
}

export abstract class BaseAgent extends EventEmitter {
  public readonly id: string;
  public readonly name: string;
  public readonly description: string;
  public readonly capabilities: string[];
  
  protected maxRetries: number;
  protected timeout: number;
  protected status: 'idle' | 'working' | 'error' = 'idle';

  constructor(config: AgentConfig) {
    super();
    this.id = config.id || uuidv4();
    this.name = config.name;
    this.description = config.description;
    this.capabilities = config.capabilities;
    this.maxRetries = config.maxRetries || 3;
    this.timeout = config.timeout || 30000;
  }

  /**
   * 执行任务
   */
  abstract execute(task: Task): Promise<TaskResult>;

  /**
   * 获取 Agent 状态
   */
  getStatus(): AgentStatus {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      capabilities: this.capabilities,
    };
  }

  /**
   * 注册技能 (Issue #32 #2.4: 泛型化)
   */
  registerSkill<P = unknown, R = unknown>(
    name: string,
    handler: (ctx: SkillContext<P>) => Promise<R> | R,
  ): void {
    this.on(`skill:${name}`, handler);
  }

  /**
   * 触发技能 (Issue #32 #2.4: 泛型化)
   */
  async triggerSkill<P = unknown, R = unknown>(
    name: string,
    params?: P,
  ): Promise<R[]> {
    const listeners = this.listeners(`skill:${name}`) as Array<
      (ctx: SkillContext<P>) => Promise<R> | R
    >;
    const ctx: SkillContext<P> = { name, params };
    return Promise.all(listeners.map(fn => fn(ctx)));
  }

  /**
   * 停止 Agent
   */
  stop(): void {
    this.status = 'idle';
    this.emit('stopped', { agentId: this.id });
  }
}

// Issue #32 #2.4: TaskResult 使用鉴别联合
export interface TaskResult<D extends TaskResultData = TaskResultData> {
  success: boolean;
  data?: D;
  error?: string;
  duration?: number;
}

export interface AgentStatus {
  id: string;
  name: string;
  status: string;
  capabilities: string[];
}
