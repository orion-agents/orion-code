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
/**
 * Deep-ish copy of the default config.
 *
 * A bare `{ ...DEFAULT_AUTOFIX_CONFIG }` shares the `triggers` array between
 * every caller, and returning the singleton itself let `AutoFixRunner.setEnabled`
 * mutate the module-level default process-wide (every Runner constructed
 * afterwards inherited the disabled state).
 */
function cloneDefaultConfig(): AutoFixConfig {
  return {
    ...DEFAULT_AUTOFIX_CONFIG,
    triggers: DEFAULT_AUTOFIX_CONFIG.triggers.map(trigger => ({ ...trigger })),
  };
}

export function detectAutoFixConfig(projectPath: string): AutoFixConfig {
  // 尝试读取 package.json
  try {
    const pkgPath = join(projectPath, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

    const config: AutoFixConfig = cloneDefaultConfig();

    // Detection must clear the command when the script is absent: the field is
    // pre-populated from the defaults, so skipping the branch left
    // `npm run lint` in place and the runner reported "Missing script: lint"
    // as a lint failure for a linter the project does not have.

    // 检测 lint 命令
    if (pkg.scripts?.lint) {
      config.lintCommand = 'npm run lint';
    } else if (pkg.scripts?.eslint) {
      config.lintCommand = 'npm run eslint';
    } else {
      config.lintCommand = undefined;
    }

    // 检测 test 命令
    config.testCommand = pkg.scripts?.test ? 'npm test' : undefined;

    // 检测 build 命令
    config.buildCommand = pkg.scripts?.build ? 'npm run build' : undefined;

    return config;
  } catch {
    return cloneDefaultConfig();
  }
}

// ============================================================================
// 导入辅助（放在末尾避免循环依赖）
// ============================================================================

import { join } from 'path';
import { readFileSync } from 'fs';
