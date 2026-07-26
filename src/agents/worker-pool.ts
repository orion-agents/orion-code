/**
 * orion code - Worker Pool
 *
 * 管理多个并发 Subagent，支持任务队列和结果收集。
 */

import type { Task } from '../core/agent';
import { forkSubagent, type ForkOptions, type ForkResult } from './fork';

// ============================================================================
// 类型定义
// ============================================================================

export interface WorkerInfo {
  id: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  task?: Task;
  startTime?: number;
}

export interface WorkerPoolConfig {
  /** 最大 Worker 数量 */
  maxWorkers?: number;
  /** 单任务超时（ms） */
  taskTimeout?: number;
  /** 默认 ForkOptions */
  defaultForkOptions?: Partial<ForkOptions>;
}

// ============================================================================
// Worker Pool 实现
// ============================================================================

export class WorkerPool {
  private workers: Map<string, WorkerInfo> = new Map();
  private taskQueue: Task[] = [];
  private results: Map<string, ForkResult> = new Map();
  private maxWorkers: number;
  private taskTimeout: number;
  private defaultForkOptions: Partial<ForkOptions>;
  private nextWorkerId = 0;

  constructor(config?: WorkerPoolConfig) {
    this.maxWorkers = config?.maxWorkers || 3;
    this.taskTimeout = config?.taskTimeout || 60000;
    this.defaultForkOptions = config?.defaultForkOptions || {};
  }

  /**
   * 提交任务到 Pool
   * @returns Worker ID
   */
  async submit(task: Task, forkOptions?: Partial<ForkOptions>): Promise<ForkResult> {
    // 检查是否有空闲 Worker
    const idleWorkers = this.getIdleWorkers();

    if (idleWorkers.length > 0 || this.workers.size < this.maxWorkers) {
      // 有空闲 Worker 或未达到上限：直接执行
      const workerId = this.allocateWorker(task);
      const result = await this.executeTask(workerId, task, forkOptions);
      return result;
    }

    // 无空闲 Worker：加入队列
    this.taskQueue.push(task);

    // 等待有空闲 Worker
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.getIdleWorkers().length > 0) {
          clearInterval(checkInterval);
          const workerId = this.allocateWorker(task);
          this.executeTask(workerId, task, forkOptions).then(resolve);
        }
      }, 100);

      // 超时处理
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve({
          success: false,
          content: '',
          error: 'Task queue timeout',
          duration: this.taskTimeout,
        });
      }, this.taskTimeout);
    });
  }

  /**
   * 批量提交任务
   */
  async submitBatch(tasks: Task[], forkOptions?: Partial<ForkOptions>): Promise<Map<string, ForkResult>> {
    const promises: Promise<void>[] = [];

    for (const task of tasks) {
      promises.push(
        this.submit(task, forkOptions).then((result) => {
          this.results.set(task.id, result);
        })
      );
    }

    await Promise.all(promises);
    return this.results;
  }

  /**
   * 广播消息到所有 Worker
   */
  broadcast(message: string): void {
    for (const [workerId, info] of this.workers) {
      if (info.status === 'running') {
        // 通知正在运行的 Worker（简化：通过事件）
        console.log(`[WorkerPool] Broadcasting to ${workerId}: ${message.slice(0, 50)}...`);
      }
    }
  }

  /**
   * 收集所有结果
   */
  collectResults(): Map<string, ForkResult> {
    return new Map(this.results);
  }

  /**
   * 清除已完成的结果
   */
  clearResults(): void {
    for (const [taskId, result] of this.results) {
      if (result.success) {
        this.results.delete(taskId);
      }
    }
  }

  /**
   * 获取 Pool 状态
   */
  getStatus(): {
    totalWorkers: number;
    runningWorkers: number;
    idleWorkers: number;
    queueLength: number;
    completedTasks: number;
  } {
    return {
      totalWorkers: this.workers.size,
      runningWorkers: this.workers.size - this.getIdleWorkers().length,
      idleWorkers: this.getIdleWorkers().length,
      queueLength: this.taskQueue.length,
      completedTasks: this.results.size,
    };
  }

  /**
   * 停止所有 Worker
   */
  stopAll(): void {
    for (const [workerId, info] of this.workers) {
      if (info.status === 'running') {
        this.workers.set(workerId, { ...info, status: 'failed' });
      }
    }
    this.taskQueue = [];
  }

  // ============================================================================
  // 内部方法
  // ============================================================================

  private getIdleWorkers(): WorkerInfo[] {
    return Array.from(this.workers.values()).filter(w => w.status === 'idle' || w.status === 'completed');
  }

  private allocateWorker(task: Task): string {
    // 查找空闲 Worker
    for (const [id, info] of this.workers) {
      if (info.status === 'idle' || info.status === 'completed') {
        this.workers.set(id, {
          ...info,
          status: 'running',
          task,
          startTime: Date.now(),
        });
        return id;
      }
    }

    // 创建新 Worker
    const workerId = `worker-${this.nextWorkerId++}`;
    this.workers.set(workerId, {
      id: workerId,
      status: 'running',
      task,
      startTime: Date.now(),
    });
    return workerId;
  }

  private async executeTask(
    workerId: string,
    task: Task,
    forkOptions?: Partial<ForkOptions>
  ): Promise<ForkResult> {
    const options: ForkOptions = {
      inheritContext: this.defaultForkOptions.inheritContext ?? true,
      ...this.defaultForkOptions,
      ...forkOptions,
      taskDescription: task.description,
      maxTurns: forkOptions?.maxTurns ?? this.defaultForkOptions.maxTurns ?? 3,
    };

    try {
      const result = await forkSubagent(options);

      // 更新 Worker 状态
      this.workers.set(workerId, {
        id: workerId,
        status: result.success ? 'completed' : 'failed',
        task,
        startTime: Date.now(),
      });

      // 保存结果
      this.results.set(task.id, result);

      // 处理队列中的下一个任务
      if (this.taskQueue.length > 0) {
        const nextTask = this.taskQueue.shift();
        if (nextTask) {
          this.executeTask(workerId, nextTask, forkOptions).catch(() => {
            // Prevent unhandled rejection from recursive call.
          });
        }
      }

      return result;
    } catch (err: any) {
      this.workers.set(workerId, {
        id: workerId,
        status: 'failed',
        task,
        startTime: Date.now(),
      });

      const result: ForkResult = {
        success: false,
        content: '',
        error: err.message,
        duration: Date.now() - (this.workers.get(workerId)?.startTime || Date.now()),
      };
      this.results.set(task.id, result);
      return result;
    }
  }
}

// ============================================================================
// 单例
// ============================================================================

let defaultPool: WorkerPool | null = null;

export function getWorkerPool(config?: WorkerPoolConfig): WorkerPool {
  if (!defaultPool) {
    defaultPool = new WorkerPool(config);
  }
  return defaultPool;
}

export function resetWorkerPool(): void {
  defaultPool = null;
}