/**
 * orion code - Harness 引擎（兼容 API）
 *
 * This module is kept for the public package API. The CLI runtime now uses the
 * ContextHarness, but external users may still import HarnessEngine from
 * `orion`.
 */

import { EventEmitter } from 'eventemitter3';
import { Task, TaskResult, BaseAgent } from '../core/agent';
import { SafetyChecker, SafetyPolicy } from './safety';

/** Harness 配置 */
export interface HarnessConfig {
  goalConstraint: boolean;
  maxSteps: number;
  boundaryCheck: boolean;
  allowedActions: string[];
  blockedActions: string[];
  resultValidation: boolean;
  sandbox: boolean;
  timeout: number;
  safetyPolicy?: Partial<SafetyPolicy>;
}

/** Harness 验证结果 */
export interface HarnessVerdict {
  passed: boolean;
  stage: 'pre-exec' | 'post-exec';
  reason?: string;
  suggestion?: string;
}

/** Harness 执行上下文 */
export interface HarnessContext {
  task: Task;
  agentId: string;
  steps: number;
  startedAt: number;
  metadata?: Record<string, unknown>;
}

/** Harness 执行结果 */
export interface HarnessExecutionResult {
  harnessPassed: boolean;
  preCheck: HarnessVerdict | null;
  postValidate: HarnessVerdict | null;
  taskResult: TaskResult;
  context: HarnessContext;
}

const DEFAULT_CONFIG: HarnessConfig = {
  goalConstraint: true,
  maxSteps: 50,
  boundaryCheck: true,
  allowedActions: ['*'],
  blockedActions: ['rm -rf /', 'eval', 'exec'],
  resultValidation: true,
  sandbox: false,
  timeout: 60000,
};

export class HarnessEngine extends EventEmitter {
  private config: HarnessConfig;
  private safetyChecker: SafetyChecker | null;

  constructor(config?: Partial<HarnessConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.safetyChecker = this.config.sandbox
      ? new SafetyChecker(this.config.safetyPolicy)
      : null;
  }

  preCheck(task: Task): HarnessVerdict {
    if (this.safetyChecker) {
      const safety = this.safetyChecker.check(task.name, {
        path: task.params?.path,
        output: task.description,
      });
      if (!safety.passed) {
        return {
          passed: false,
          stage: 'pre-exec',
          reason: safety.reason,
          suggestion: safety.suggestion,
        };
      }
    }

    if (this.config.blockedActions.length > 0 && task.params?.actions) {
      const actions = task.params.actions;
      if (Array.isArray(actions) && actions.every(a => typeof a === 'string')) {
        const blocked = (actions as string[]).filter(a => this.config.blockedActions.includes(a));
        if (blocked.length > 0) {
          return {
            passed: false,
            stage: 'pre-exec',
            reason: `Blocked actions detected: ${blocked.join(', ')}`,
            suggestion: 'Remove blocked actions or update harness policy.',
          };
        }
      }
    }

    if (this.config.allowedActions[0] !== '*' && task.params?.actions) {
      const actions = task.params.actions;
      if (Array.isArray(actions) && actions.every(a => typeof a === 'string')) {
        const disallowed = (actions as string[]).filter(a => !this.config.allowedActions.includes(a));
        if (disallowed.length > 0) {
          return {
            passed: false,
            stage: 'pre-exec',
            reason: `Actions not in whitelist: ${disallowed.join(', ')}`,
            suggestion: 'Add actions to allowed list or use wildcard "*".',
          };
        }
      }
    }

    if (this.config.goalConstraint && !task.description) {
      return {
        passed: false,
        stage: 'pre-exec',
        reason: 'Task has no description — goal constraint violated',
        suggestion: 'Provide a task description to define the goal.',
      };
    }

    return { passed: true, stage: 'pre-exec' };
  }

  postValidate(result: TaskResult, task: Task): HarnessVerdict {
    if (!this.config.resultValidation) {
      return { passed: true, stage: 'post-exec' };
    }

    if (result.duration && result.duration > this.config.timeout) {
      return {
        passed: false,
        stage: 'post-exec',
        reason: `Execution exceeded timeout: ${result.duration}ms > ${this.config.timeout}ms`,
        suggestion: 'Increase timeout or optimize task execution.',
      };
    }

    if (result.data?.steps && (result.data.steps as number) > this.config.maxSteps) {
      return {
        passed: false,
        stage: 'post-exec',
        reason: `Execution exceeded max steps: ${result.data.steps} > ${this.config.maxSteps}`,
        suggestion: 'Reduce complexity or increase maxSteps.',
      };
    }

    if (this.config.boundaryCheck && task.params?.boundary) {
      const boundary = task.params.boundary as Record<string, number>;
      if (result.data?.metrics) {
        const metrics = result.data.metrics as Record<string, number>;
        for (const [key, max] of Object.entries(boundary)) {
          if (metrics[key] !== undefined && metrics[key] > max) {
            return {
              passed: false,
              stage: 'post-exec',
              reason: `Metric "${key}" exceeded boundary: ${metrics[key]} > ${max}`,
              suggestion: `Ensure ${key} stays within ${max}.`,
            };
          }
        }
      }
    }

    return { passed: true, stage: 'post-exec' };
  }

  async execute(
    agent: BaseAgent,
    task: Task,
    metadata?: Record<string, unknown>,
  ): Promise<HarnessExecutionResult> {
    const context: HarnessContext = {
      task,
      agentId: agent.id,
      steps: 0,
      startedAt: Date.now(),
      metadata,
    };

    this.emit('pre-check', { task, agentId: agent.id });
    const preCheck = this.preCheck(task);
    if (!preCheck.passed) {
      this.emit('blocked', { task, verdict: preCheck });
      return {
        harnessPassed: false,
        preCheck,
        postValidate: null,
        taskResult: { success: false, error: preCheck.reason, duration: 0 },
        context,
      };
    }

    this.emit('execute-start', { task, agentId: agent.id });

    let taskResult: TaskResult;
    try {
      taskResult = await this.executeWithTimeout(agent.execute(task), this.config.timeout);
      context.steps++;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : error && typeof error === 'object' && 'message' in error
            ? String((error as Record<string, unknown>).message)
            : 'Execution failed';
      taskResult = {
        success: false,
        error: errorMessage,
        duration: Date.now() - context.startedAt,
      };
    }

    this.emit('execute-complete', { task, result: taskResult });
    const postValidate = this.postValidate(taskResult, task);
    this.emit('post-validate', { task, verdict: postValidate });

    return {
      harnessPassed: postValidate.passed,
      preCheck,
      postValidate,
      taskResult,
      context,
    };
  }

  getConfig(): HarnessConfig {
    return { ...this.config };
  }

  updateConfig(patch: Partial<HarnessConfig>): void {
    this.config = { ...this.config, ...patch };
    if (patch.sandbox !== undefined || patch.safetyPolicy !== undefined) {
      this.safetyChecker = this.config.sandbox
        ? new SafetyChecker(this.config.safetyPolicy)
        : null;
    }
  }

  getSafetyChecker(): SafetyChecker | null {
    return this.safetyChecker;
  }

  private executeWithTimeout<T>(promise: Promise<T>, timeout: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Execution timed out after ${timeout}ms`)), timeout),
      ),
    ]);
  }
}
