/**
 * orion code - 任务管理器
 *
 * 提供完整的任务 CRUD 和状态管理：
 *   - 创建、读取、更新、删除任务
 *   - 状态转换（pending → running → completed/failed）
 *   - 按状态、优先级、标签过滤
 *   - 事件驱动的状态变更通知
 */

import { EventEmitter } from 'eventemitter3';
import { Task, TaskResult } from '../core/agent';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// 类型定义
// ============================================================================

/** 任务优先级 */
export type Priority = 'P0' | 'P1' | 'P2';

/** 任务状态 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** 扩展任务记录 */
export interface TaskRecord {
  /** 唯一 ID */
  id: string;
  /** 任务名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 优先级 */
  priority: Priority;
  /** 分配给 */
  assignedTo: string;
  /** 当前状态 */
  status: TaskStatus;
  /** 附加参数 */
  params?: Record<string, any>;
  /** 执行结果 */
  result?: TaskResult;
  /** 标签 */
  tags: string[];
  /** 重试次数 */
  retries: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 完成/失败时间 */
  completedAt?: number;
  /** 开始执行时间 */
  startedAt?: number;
}

/** 创建任务参数 */
export interface CreateTaskOptions {
  name: string;
  description: string;
  priority?: Priority;
  assignedTo?: string;
  params?: Record<string, any>;
  tags?: string[];
  maxRetries?: number;
}

/** 更新任务参数 */
export interface UpdateTaskOptions {
  name?: string;
  description?: string;
  priority?: Priority;
  assignedTo?: string;
  params?: Record<string, any>;
  tags?: string[];
  maxRetries?: number;
}

/** 过滤选项 */
export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  priority?: Priority | Priority[];
  assignedTo?: string;
  tags?: string[];
  createdAfter?: number;
  createdBefore?: number;
}

/** 任务统计 */
export interface TaskStats {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}

// ============================================================================
// 有效状态转换
// ============================================================================

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['running', 'cancelled'],
  running: ['completed', 'failed'],
  completed: [],
  failed: ['pending'],  // 可重试
  cancelled: ['pending'], // 可恢复
};

// ============================================================================
// TaskManager - 任务管理器
// ============================================================================

export class TaskManager extends EventEmitter {
  private tasks: Map<string, TaskRecord> = new Map();

  /** Evict oldest completed/failed tasks when map exceeds this size. */
  private static readonly MAX_TASKS = 1000;

  // ==========================================================================
  // CRUD
  // ==========================================================================

  /**
   * 创建任务
   */
  create(options: CreateTaskOptions): TaskRecord {
    // Evict oldest terminal tasks if at capacity.
    if (this.tasks.size >= TaskManager.MAX_TASKS) {
      const terminal = [...this.tasks.values()]
        .filter(t => t.status === 'completed' || t.status === 'failed')
        .sort((a, b) => a.updatedAt - b.updatedAt);
      for (const t of terminal) {
        if (this.tasks.size < TaskManager.MAX_TASKS) break;
        this.tasks.delete(t.id);
      }
    }

    const now = Date.now();
    const record: TaskRecord = {
      id: uuidv4(),
      name: options.name,
      description: options.description,
      priority: options.priority ?? 'P1',
      assignedTo: options.assignedTo ?? 'leader',
      status: 'pending',
      params: options.params,
      tags: options.tags ?? [],
      retries: 0,
      maxRetries: options.maxRetries ?? 3,
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(record.id, record);
    this.emit('created', record);
    return record;
  }

  /**
   * 按 ID 获取任务
   */
  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  /**
   * 更新任务
   */
  update(id: string, updates: UpdateTaskOptions): TaskRecord | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;

    if (updates.name !== undefined) task.name = updates.name;
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.priority !== undefined) task.priority = updates.priority;
    if (updates.assignedTo !== undefined) task.assignedTo = updates.assignedTo;
    if (updates.params !== undefined) task.params = updates.params;
    if (updates.tags !== undefined) task.tags = updates.tags;
    if (updates.maxRetries !== undefined) task.maxRetries = updates.maxRetries;

    task.updatedAt = Date.now();
    this.emit('updated', task);
    return task;
  }

  /**
   * 删除任务
   */
  delete(id: string): boolean {
    const existed = this.tasks.delete(id);
    if (existed) {
      this.emit('deleted', { id });
    }
    return existed;
  }

  // ==========================================================================
  // 状态管理
  // ==========================================================================

  /**
   * 将任务状态转换为 running
   */
  start(id: string): TaskRecord | undefined {
    return this.transition(id, 'running');
  }

  /**
   * 将任务标记为完成
   */
  complete(id: string, result?: TaskResult): TaskRecord | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;

    const updated = this.transition(id, 'completed');
    if (updated) {
      updated.result = result;
      updated.completedAt = Date.now();
    }
    return updated;
  }

  /**
   * 将任务标记为失败
   */
  fail(id: string, error?: string, result?: TaskResult): TaskRecord | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;

    const updated = this.transition(id, 'failed');
    if (updated) {
      updated.result = result ?? { success: false, error: error ?? 'Task failed' };
      updated.completedAt = Date.now();
    }
    return updated;
  }

  /**
   * 取消任务
   */
  cancel(id: string): TaskRecord | undefined {
    return this.transition(id, 'cancelled');
  }

  /**
   * 重试任务（从 failed 回到 pending）
   */
  retry(id: string): TaskRecord | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;

    if (task.retries >= task.maxRetries) {
      console.warn(`[TaskManager] Task "${task.name}" exceeded max retries (${task.maxRetries})`);
      return undefined;
    }

    task.retries++;
    const updated = this.transition(id, 'pending');
    return updated;
  }

  /**
   * 获取任务统计
   */
  getStats(): TaskStats {
    const stats: TaskStats = {
      total: this.tasks.size,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const task of this.tasks.values()) {
      stats[task.status]++;
    }

    return stats;
  }

  // ==========================================================================
  // 查询与过滤
  // ==========================================================================

  /**
   * 列出所有任务
   */
  list(filter?: TaskFilter): TaskRecord[] {
    let results = Array.from(this.tasks.values());

    if (!filter) return results;

    // 状态过滤
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      results = results.filter(t => statuses.includes(t.status));
    }

    // 优先级过滤
    if (filter.priority) {
      const priorities = Array.isArray(filter.priority) ? filter.priority : [filter.priority];
      results = results.filter(t => priorities.includes(t.priority));
    }

    // 分配目标过滤
    if (filter.assignedTo) {
      results = results.filter(t => t.assignedTo === filter.assignedTo);
    }

    // 标签过滤
    if (filter.tags?.length) {
      results = results.filter(t => filter.tags!.some(tag => t.tags.includes(tag)));
    }

    // 时间范围过滤
    if (filter.createdAfter) {
      results = results.filter(t => t.createdAt >= filter.createdAfter!);
    }
    if (filter.createdBefore) {
      results = results.filter(t => t.createdAt <= filter.createdBefore!);
    }

    return results;
  }

  /**
   * 获取待处理任务（按优先级排序）
   */
  getPending(): TaskRecord[] {
    const pending = this.list({ status: 'pending' });
    const priorityOrder = { P0: 0, P1: 1, P2: 2 };
    return pending.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  }

  /**
   * 按 Agent ID 获取任务
   */
  getByAgent(agentId: string): TaskRecord[] {
    return this.list({ assignedTo: agentId });
  }

  // ==========================================================================
  // 转换到 Task 类型（兼容 Brain）
  // ==========================================================================

  /**
   * 将 TaskRecord 转换为 Brain 可用的 Task
   */
  toTask(record: TaskRecord): Task {
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      priority: record.priority,
      assignedTo: record.assignedTo,
      status: record.status as Task['status'],
      params: record.params,
    };
  }

  // ==========================================================================
  // 工具方法
  // ==========================================================================

  /** 清除所有已完成/已取消/已失败的任务 */
  cleanup(states: TaskStatus[] = ['completed', 'cancelled', 'failed']): number {
    let count = 0;
    for (const [id, task] of this.tasks) {
      if (states.includes(task.status)) {
        this.tasks.delete(id);
        count++;
        this.emit('deleted', { id });
      }
    }
    return count;
  }

  /** 清除所有任务 */
  reset(): void {
    this.tasks.clear();
    this.emit('reset');
  }

  // ---- Internal ----

  /**
   * 状态转换（带合法性校验）
   */
  private transition(id: string, target: TaskStatus): TaskRecord | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;

    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed.includes(target)) {
      console.warn(
        `[TaskManager] Invalid transition: "${task.status}" → "${target}" for task "${task.name}"`,
      );
      return undefined;
    }

    const previous = task.status;
    task.status = target;
    task.updatedAt = Date.now();

    if (target === 'running') {
      task.startedAt = Date.now();
    }

    this.emit('status-change', { task, from: previous, to: target });
    this.emit(target, task);

    return task;
  }
}
