/**
 * orion code - AutoFix 配置
 *
 * 定义 lint、test 命令和修复策略。
 */

// ============================================================================
// 类型定义
// ============================================================================

export interface AutoFixConfig {
  /** 是否启用 */
  enabled: boolean;
  /** Lint 命令 */
  lintCommand?: string;
  /** Test 命令 */
  testCommand?: string;
  /** Build 命令 */
  buildCommand?: string;
  /** 超时时间（ms） */
  timeout: number;
  /** 最大修复尝试次数 */
  maxFixAttempts: number;
  /** 触发条件 */
  triggers: AutoFixTrigger[];
}

export interface AutoFixTrigger {
  /** 触发类型 */
  type: 'file_edit' | 'file_write' | 'manual' | 'post_tool';
  /** 文件模式（glob） */
  filePattern?: string;
}

// ============================================================================
// 默认配置
// ============================================================================

export const DEFAULT_AUTOFIX_CONFIG: AutoFixConfig = {
  enabled: true,
  lintCommand: 'npm run lint',
  testCommand: 'npm test',
  buildCommand: 'npm run build',
  timeout: 60000,
  maxFixAttempts: 3,
  triggers: [
    { type: 'file_edit', filePattern: '**/*.ts' },
    { type: 'file_write', filePattern: '**/*.ts' },
    { type: 'file_edit', filePattern: '**/*.js' },
  ],
};

/**
 * 检测项目配置
 */
export function detectAutoFixConfig(projectPath: string): AutoFixConfig {
  // 尝试读取 package.json
  try {
    const pkgPath = join(projectPath, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

    const config: AutoFixConfig = { ...DEFAULT_AUTOFIX_CONFIG };

    // 检测 lint 命令
    if (pkg.scripts?.lint) {
      config.lintCommand = 'npm run lint';
    } else if (pkg.scripts?.eslint) {
      config.lintCommand = 'npm run eslint';
    }

    // 检测 test 命令
    if (pkg.scripts?.test) {
      config.testCommand = 'npm test';
    }

    // 检测 build 命令
    if (pkg.scripts?.build) {
      config.buildCommand = 'npm run build';
    }

    return config;
  } catch {
    return DEFAULT_AUTOFIX_CONFIG;
  }
}

// ============================================================================
// 导入辅助（放在末尾避免循环依赖）
// ============================================================================

import { join } from 'path';
import { readFileSync } from 'fs';