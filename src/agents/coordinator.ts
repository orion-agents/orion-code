/**
 * orion code - Coordinator
 *
 * 多 Agent 协调器，负责任务分配和结果聚合。
 * 与 Fork/Worker Pool 模式配合使用。
 */

import type { Task } from '../core/agent';
import type { ForkResult } from './fork';
import { getAgentRouter, classifyTask } from './router';
import { getWorkerPool, type WorkerPool } from './worker-pool';

// ============================================================================
// 类型定义
// ============================================================================

export interface CoordinatorConfig {
  /** 协调模式 */
  mode?: 'distribute' | 'pipeline' | 'parallel';
  /** 最大并行任务 */
  maxParallel?: number;
  /** 结果聚合策略 */
  aggregationStrategy?: 'first' | 'best' | 'all';
}

export interface TaskAssignment {
  taskId: string;
  agentId: string;
  reason: string;
  confidence: number;
}

export interface CoordinatorResult {
  success: boolean;
  assignments: TaskAssignment[];
  results: Map<string, ForkResult>;
  summary: string;
  duration: number;
}

// ============================================================================
// Coordinator 实现
// ============================================================================

export class Coordinator {
  private agents: Map<string, AgentProfile> = new Map();
  private taskAssignments: Map<string, TaskAssignment> = new Map();
  private pendingTasks: Task[] = [];
  private completedTasks: Map<string, ForkResult> = new Map();
  private config: CoordinatorConfig;
  private workerPool: WorkerPool;

  constructor(config?: CoordinatorConfig) {
    this.config = {
      mode: config?.mode || 'distribute',
      maxParallel: config?.maxParallel || 3,
      aggregationStrategy: config?.aggregationStrategy || 'best',
    };
    this.workerPool = getWorkerPool({ maxWorkers: this.config.maxParallel });

    // 注册默认 Agent
    this.registerDefaultAgents();
  }

  /**
   * 注册 Agent
   */
  registerAgent(profile: AgentProfile): void {
    this.agents.set(profile.id, profile);
  }

  /**
   * 分配任务到最合适的 Agent
   */
  assignTask(task: Task): TaskAssignment {
    const router = getAgentRouter();
    const routeResult = router.route(task);

    const assignment: TaskAssignment = {
      taskId: task.id,
      agentId: routeResult.agentId,
      reason: routeResult.reason,
      confidence: routeResult.confidence,
    };

    this.taskAssignments.set(task.id, assignment);
    return assignment;
  }

  /**
   * 执行任务（协调模式）
   */
  async execute(task: Task): Promise<CoordinatorResult> {
    const startTime = Date.now();
    const assignments: TaskAssignment[] = [];

    switch (this.config.mode) {
      case 'distribute':
        // 分发模式：单任务分配到最合适 Agent
        const assignment = this.assignTask(task);
        assignments.push(assignment);

        const result = await this.workerPool.submit(task, {
          taskDescription: task.description,
          maxTurns: 5,
        });

        this.completedTasks.set(task.id, result);

        return {
          success: result.success,
          assignments,
          results: new Map([[task.id, result]]),
          summary: result.content.slice(0, 200),
          duration: Date.now() - startTime,
        };

      case 'parallel':
        // 并行模式：任务分解后并行执行
        const subtasks = this.decomposeTask(task);
        const batchAssignments: TaskAssignment[] = [];

        for (const sub of subtasks) {
          const subAssignment = this.assignTask(sub);
          batchAssignments.push(subAssignment);
        }

        const batchResults = await this.workerPool.submitBatch(subtasks);
        const aggregated = this.aggregateResults(batchResults);

        return {
          success: aggregated.success,
          assignments: batchAssignments,
          results: batchResults,
          summary: aggregated.summary,
          duration: Date.now() - startTime,
        };

      case 'pipeline':
        // 流水线模式：任务按顺序执行
        const pipelineTasks = this.createPipeline(task);
        const pipelineAssignments: TaskAssignment[] = [];
        const pipelineResults: Map<string, ForkResult> = new Map();

        for (const stage of pipelineTasks) {
          const stageAssignment = this.assignTask(stage);
          pipelineAssignments.push(stageAssignment);

          const stageResult = await this.workerPool.submit(stage, {
            taskDescription: stage.description,
            maxTurns: 3,
          });

          pipelineResults.set(stage.id, stageResult);

          if (!stageResult.success) {
            // 流水线失败：停止后续阶段
            return {
              success: false,
              assignments: pipelineAssignments,
              results: pipelineResults,
              summary: `Pipeline failed at stage ${stage.name}: ${stageResult.error}`,
              duration: Date.now() - startTime,
            };
          }
        }

        return {
          success: true,
          assignments: pipelineAssignments,
          results: pipelineResults,
          summary: 'Pipeline completed successfully',
          duration: Date.now() - startTime,
        };
    }

    // 默认返回（防止 TypeScript 报错）
    return {
      success: false,
      assignments: [],
      results: new Map(),
      summary: 'Unknown mode',
      duration: Date.now() - startTime,
    };
  }

  /**
   * 收集所有已完成结果
   */
  collectResults(): Map<string, ForkResult> {
    return new Map(this.completedTasks);
  }

  /**
   * 获取协调器状态
   */
  getStatus(): {
    registeredAgents: number;
    pendingTasks: number;
    completedTasks: number;
    mode: string;
  } {
    return {
      registeredAgents: this.agents.size,
      pendingTasks: this.pendingTasks.length,
      completedTasks: this.completedTasks.size,
      mode: this.config.mode || 'distribute',
    };
  }

  // ============================================================================
  // 内部方法
  // ============================================================================

  private registerDefaultAgents(): void {
    this.registerAgent({
      id: 'coder',
      name: 'Coder',
      capabilities: ['implement', 'write', 'fix', 'refactor'],
      priority: 60,
    });

    this.registerAgent({
      id: 'leader',
      name: 'Leader',
      capabilities: ['coordinate', 'plan', 'organize'],
      priority: 50,
    });

    this.registerAgent({
      id: 'reviewer',
      name: 'Reviewer',
      capabilities: ['review', 'check', 'audit', 'analyze'],
      priority: 55,
    });

    this.registerAgent({
      id: 'tester',
      name: 'Tester',
      capabilities: ['test', 'verify', 'validate'],
      priority: 55,
    });
  }

  /**
   * 任务分解（将大任务拆分为子任务）
   */
  private decomposeTask(task: Task): Task[] {
    // 简化实现：基于关键词分解
    const classification = classifyTask(task.name, task.description);

    // 根据类别分解
    if (classification.category === 'coding') {
      return [
        { ...task, id: `${task.id}-impl`, name: `${task.name}-impl`, description: `Implement: ${task.description}` },
        { ...task, id: `${task.id}-test`, name: `${task.name}-test`, description: `Write tests for: ${task.name}`, assignedTo: 'tester' },
        { ...task, id: `${task.id}-review`, name: `${task.name}-review`, description: `Review implementation`, assignedTo: 'reviewer' },
      ];
    }

    // 默认：不分解
    return [task];
  }

  /**
   * 创建流水线任务序列
   */
  private createPipeline(task: Task): Task[] {
    return [
      { ...task, id: `${task.id}-plan`, name: `Plan`, description: `Plan approach for: ${task.description}`, assignedTo: 'leader' },
      { ...task, id: `${task.id}-impl`, name: `Implement`, description: `Execute: ${task.description}`, assignedTo: 'coder' },
      { ...task, id: `${task.id}-verify`, name: `Verify`, description: `Verify results`, assignedTo: 'reviewer' },
    ];
  }

  /**
   * 聚合结果
   */
  private aggregateResults(results: Map<string, ForkResult>): { success: boolean; summary: string } {
    switch (this.config.aggregationStrategy) {
      case 'first':
        const firstResult = results.values().next().value;
        return { success: firstResult?.success || false, summary: firstResult?.content || '' };

      case 'best':
        // 找到最好的结果
        let best: ForkResult | null = null;
        for (const result of results.values()) {
          if (result.success && (!best || result.content.length > best.content.length)) {
            best = result;
          }
        }
        return { success: best?.success || false, summary: best?.content || 'No successful results' };

      case 'all':
        // 合并所有结果
        const allContent = Array.from(results.values())
          .map(r => r.content)
          .filter(c => c)
          .join('\n\n---\n\n');
        const allSuccess = Array.from(results.values()).every(r => r.success);
        return { success: allSuccess, summary: allContent.slice(0, 500) };
    }

    // 默认返回
    return { success: false, summary: 'Unknown aggregation strategy' };
  }
}

// ============================================================================
// Agent Profile
// ============================================================================

interface AgentProfile {
  id: string;
  name: string;
  capabilities: string[];
  priority: number;
}

// ============================================================================
// 单例
// ============================================================================

let defaultCoordinator: Coordinator | null = null;

export function getCoordinator(config?: CoordinatorConfig): Coordinator {
  if (!defaultCoordinator) {
    defaultCoordinator = new Coordinator(config);
  }
  return defaultCoordinator;
}

export function resetCoordinator(): void {
  defaultCoordinator = null;
}