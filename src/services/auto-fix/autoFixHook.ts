/**
 * orion code - AutoFix Hook
 *
 * Post-sampling hook，在工具执行后触发 AutoFix。
 */

import type { QueryEvent } from '../../framework/query';
import { getAutoFixRunner, type AutoFixContext } from './autoFixRunner';
import type { AutoFixTrigger } from './autoFixConfig';

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * 检查工具调用是否触发 AutoFix
 */
export function shouldTriggerAutoFix(
  toolName: string,
  args: Record<string, unknown>,
  triggers: AutoFixTrigger[]
): { trigger: boolean; files: string[] } {
  const result = { trigger: false, files: [] as string[] };

  for (const trigger of triggers) {
    if (trigger.type === 'file_edit' && toolName === 'edit_file') {
      const path = args.path as string;
      if (path && matchesPattern(path, trigger.filePattern)) {
        result.trigger = true;
        result.files.push(path);
      }
    }

    if (trigger.type === 'file_write' && toolName === 'write_file') {
      const path = args.path as string;
      if (path && matchesPattern(path, trigger.filePattern)) {
        result.trigger = true;
        result.files.push(path);
      }
    }

    if (trigger.type === 'post_tool' && toolName === trigger.filePattern) {
      result.trigger = true;
    }
  }

  return result;
}

/**
 * AutoFix Hook 处理器
 */
export async function autoFixHook(
  event: QueryEvent,
  triggers: AutoFixTrigger[]
): Promise<void> {
  if (event.type !== 'tool_result') {
    return;
  }

  // 检查是否触发
  const check = shouldTriggerAutoFix(event.name, event.args, triggers);

  if (!check.trigger) {
    return;
  }

  // 运行 AutoFix
  const runner = getAutoFixRunner();
  const context: AutoFixContext = {
    projectPath: process.cwd(),
    changedFiles: check.files,
    trigger: triggers[0],
  };

  const result = await runner.run(context);

  if (!result.success) {
    console.log(`[AutoFix] ${result.errors.length} issues found after ${event.name}`);
    for (const err of result.errors.slice(0, 5)) {
      console.log(`  - ${err.type}: ${err.message}`);
    }
  } else {
    console.log(`[AutoFix] All checks passed (${result.duration}ms)`);
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

function matchesPattern(path: string, pattern?: string): boolean {
  if (!pattern) return true;

  // 简化 glob 匹配
  if (pattern.startsWith('**/*.')) {
    const ext = pattern.slice(5);
    return path.endsWith(ext);
  }

  if (pattern.includes('*')) {
    // Escape all regex special chars, then replace glob wildcard.
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped.replace(/\*/g, '.*'));
    return regex.test(path);
  }

  return path === pattern;
}

// ============================================================================
// 导出
// ============================================================================

export { autoFixHook as postToolHook };
