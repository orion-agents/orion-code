/**
 * x-agent - 决策引擎
 *
 * 负责 Agent 的任务分配、优先级排序和调度
 *
 * Issue #32 #2.4: 类型安全重构
 */

import { Task, BaseAgent, AgentStatus } from './agent';

export interface BrainConfig {
  strategy?: 'fifo' | 'priority' | 'capability';
  maxConcurrent?: number;
}

// Issue #32 #2.4: BrainStatus 显式类型
export interface BrainStatus {
  agents: AgentStatus[];
  pendingTasks: number;
  strategy: string;
  lastError?: string;
}

export class Brain {
  private agents: Map<string, BaseAgent> = new Map();
  private taskQueue: Task[] = [];
  private config: BrainConfig;

  constructor(config: BrainConfig = {}) {
    this.config = {
      strategy: config.strategy || 'priority',
      maxConcurrent: config.maxConcurrent || 5,
    };
  }

  /**
   * 注册 Agent
   */
  registerAgent(agent: BaseAgent): void {
    this.agents.set(agent.id, agent);
  }

  /**
   * 提交任务
   * Issue #32 修复：返回 Promise，正确 await dispatch
   */
  async submitTask(task: Task): Promise<void> {
    this.taskQueue.push(task);
    await this.dispatch();
  }

  /**
   * 任务分发
   */
  private async dispatch(): Promise<void> {
    if (this.taskQueue.length === 0) return;

    const availableAgents = Array.from(this.agents.values())
      .filter(agent => agent.getStatus().status === 'idle');

    if (availableAgents.length === 0) return;

    // 按优先级排序
    const sortedTasks = this.sortTasks(this.taskQueue);
    const task = sortedTasks[0];

    if (!task) return;

    // 找到合适的 Agent
    const agent = this.findBestAgent(task, availableAgents);
    if (!agent) return;

    // 执行任务
    this.taskQueue = this.taskQueue.filter(t => t.id !== task.id);

    try {
      task.status = 'running';
      const result = await agent.execute(task);
      task.status = result.success ? 'completed' : 'failed';
    } catch (error) {
      task.status = 'failed';
    }
  }

  /**
   * 排序任务
   */
  private sortTasks(tasks: Task[]): Task[] {
    const priorityOrder = { P0: 0, P1: 1, P2: 2 };
    return [...tasks].sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  }

  /**
   * 找到最合适的 Agent
   */
  private findBestAgent(task: Task, agents: BaseAgent[]): BaseAgent | null {
    // 根据任务需求匹配 Agent 能力
    for (const agent of agents) {
      if (agent.capabilities.length > 0) {
        return agent;
      }
    }
    return agents[0] || null;
  }

  /**
   * 获取状态 (Issue #32 #2.4: 显式类型)
   */
  getStatus(): BrainStatus {
    return {
      agents: Array.from(this.agents.values()).map(a => a.getStatus()),
      pendingTasks: this.taskQueue.length,
      strategy: this.config.strategy || 'priority',
    };
  }
}
