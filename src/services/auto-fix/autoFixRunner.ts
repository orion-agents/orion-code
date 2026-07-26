/**
 * orion code - AutoFix Runner
 *
 * 代码修改后自动运行 lint + test，检测并尝试修复错误。
 */

import { execFile } from 'child_process';
import type { AutoFixConfig, AutoFixTrigger } from './autoFixConfig';
import { detectAutoFixConfig } from './autoFixConfig';

// ============================================================================
// 类型定义
// ============================================================================

export interface AutoFixResult {
  success: boolean;
  lintPassed: boolean;
  testPassed: boolean;
  buildPassed?: boolean;
  errors: AutoFixError[];
  fixAttempts: number;
  duration: number;
}

export interface AutoFixError {
  type: 'lint' | 'test' | 'build';
  file?: string;
  line?: number;
  message: string;
  fixable: boolean;
}

export interface AutoFixContext {
  projectPath: string;
  changedFiles: string[];
  trigger: AutoFixTrigger;
}

// ============================================================================
// AutoFix Runner
// ============================================================================

export class AutoFixRunner {
  private config: AutoFixConfig;
  private projectPath: string;
  private fixAttempts: number = 0;
  private lastRunTime: number = 0;

  constructor(projectPath?: string, config?: AutoFixConfig) {
    this.projectPath = projectPath || process.cwd();
    this.config = config || detectAutoFixConfig(this.projectPath);
  }

  /**
   * 运行 AutoFix
   */
  async run(_context: AutoFixContext): Promise<AutoFixResult> {
    if (!this.config.enabled) {
      return {
        success: true,
        lintPassed: true,
        testPassed: true,
        errors: [],
        fixAttempts: 0,
        duration: 0,
      };
    }

    const startTime = Date.now();
    const errors: AutoFixError[] = [];
    let lintPassed = true;
    let testPassed = true;
    let buildPassed = true;

    // 1. 运行 lint
    if (this.config.lintCommand) {
      const lintResult = await this.runCommand(this.config.lintCommand);
      lintPassed = lintResult.success;
      if (!lintResult.success) {
        errors.push(...this.parseLintErrors(lintResult.output));
      }
    }

    // 2. 运行 build（如果有）
    if (this.config.buildCommand) {
      const buildResult = await this.runCommand(this.config.buildCommand);
      buildPassed = buildResult.success;
      if (!buildResult.success) {
        errors.push(...this.parseBuildErrors(buildResult.output));
      }
    }

    // 3. 运行 test
    if (this.config.testCommand) {
      const testResult = await this.runCommand(this.config.testCommand);
      testPassed = testResult.success;
      if (!testResult.success) {
        errors.push(...this.parseTestErrors(testResult.output));
      }
    }

    const duration = Date.now() - startTime;

    return {
      success: lintPassed && testPassed && buildPassed,
      lintPassed,
      testPassed,
      buildPassed,
      errors,
      fixAttempts: this.fixAttempts,
      duration,
    };
  }

  /**
   * 快速检查（仅 lint）
   */
  async quickCheck(_files: string[]): Promise<{ passed: boolean; errors: AutoFixError[] }> {
    if (!this.config.lintCommand) {
      return { passed: true, errors: [] };
    }

    const lintResult = await this.runCommand(this.config.lintCommand);
    const errors = lintResult.success ? [] : this.parseLintErrors(lintResult.output);

    return {
      passed: lintResult.success,
      errors,
    };
  }

  /**
   * 获取配置
   */
  getConfig(): AutoFixConfig {
    return this.config;
  }

  /**
   * 启用/禁用
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  // ============================================================================
  // 内部方法
  // ============================================================================

  private async runCommand(command: string): Promise<{ success: boolean; output: string }> {
    return new Promise((resolve) => {
      const [cmd, ...args] = command.split(' ');

      execFile(cmd, args, {
        cwd: this.projectPath,
        timeout: this.config.timeout,
        maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        const output = stdout.toString() + stderr.toString();
        resolve({
          success: !error,
          output,
        });
      });
    });
  }

  private parseLintErrors(output: string): AutoFixError[] {
    const errors: AutoFixError[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      // ESLint 格式: /path/to/file.ts:10:5: error message
      const match = line.match(/^([^:]+):(\d+):(\d+):\s+(.+)$/);
      if (match) {
        errors.push({
          type: 'lint',
          file: match[1],
          line: parseInt(match[2]),
          message: match[4],
          fixable: line.includes('--fix'),
        });
      }

      // 简化格式: error: message at file:line
      const simpleMatch = line.match(/error:\s+(.+)\s+at\s+([^:]+):(\d+)/);
      if (simpleMatch) {
        errors.push({
          type: 'lint',
          file: simpleMatch[2],
          line: parseInt(simpleMatch[3]),
          message: simpleMatch[1],
          fixable: false,
        });
      }
    }

    return errors;
  }

  private parseBuildErrors(output: string): AutoFixError[] {
    const errors: AutoFixError[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      // TypeScript 格式: src/file.ts(10,5): error TS1234: message
      const match = line.match(/^([^(]+)\((\d+),(\d+)\):\s+error\s+TS\d+:\s+(.+)$/);
      if (match) {
        errors.push({
          type: 'build',
          file: match[1],
          line: parseInt(match[2]),
          message: match[4],
          fixable: false,
        });
      }
    }

    return errors;
  }

  private parseTestErrors(output: string): AutoFixError[] {
    const errors: AutoFixError[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      // Jest 格式: FAIL src/test.ts
      if (line.includes('FAIL') || line.includes('Error:')) {
        errors.push({
          type: 'test',
          message: line.trim(),
          fixable: false,
        });
      }

      // Mocha 格式: AssertionError: ...
      if (line.startsWith('AssertionError')) {
        errors.push({
          type: 'test',
          message: line.trim(),
          fixable: false,
        });
      }
    }

    return errors.slice(0, 10);  // 限制数量
  }
}

// ============================================================================
// 单例
// ============================================================================

let autoFixRunner: AutoFixRunner | null = null;

export function getAutoFixRunner(projectPath?: string, config?: AutoFixConfig): AutoFixRunner {
  if (!autoFixRunner) {
    autoFixRunner = new AutoFixRunner(projectPath, config);
  }
  return autoFixRunner;
}

export function resetAutoFixRunner(): void {
  autoFixRunner = null;
}