/**
 * x-agent - Leader Agent (协调者)
 * 
 * 负责任务分发、Agent 管理和整体协调
 */

import { BaseAgent, AgentConfig, Task, TaskResult } from '../core/agent';

export class LeaderAgent extends BaseAgent {
  constructor(config?: Partial<AgentConfig>) {
    super({
      id: config?.id || 'leader',
      name: config?.name || 'Leader',
      description: config?.description || '协调者 Agent - 负责任务分发和整体协调',
      capabilities: config?.capabilities || ['task-distribution', 'coordination', 'monitoring'],
      ...config,
    });
  }

  async execute(task: Task): Promise<TaskResult> {
    const startTime = Date.now();
    
    console.log(`[Leader] Executing task: ${task.name}`);
    this.status = 'working';
    this.emit('task-started', task);

    try {
      // Leader 的任务通常是协调和分发
      const result = await this.coordinateTask(task);
      
      const duration = Date.now() - startTime;
      this.status = 'idle';
      this.emit('task-completed', { task, result, duration });
      
      return { success: true, data: result, duration };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.status = 'error';
      this.emit('task-failed', { task, error });
      
      return { success: false, error: String(error), duration };
    }
  }

  private async coordinateTask(task: Task): Promise<any> {
    // Leader 协调逻辑
    return {
      message: `Task "${task.name}" coordinated by Leader`,
      timestamp: new Date().toISOString(),
    };
  }
}
