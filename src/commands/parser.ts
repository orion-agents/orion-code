/**
 * orion code - Command Parser
 *
 * 解析输入，区分 `/` 前缀命令和非命令 chat 输入。
 * 提供命令建议功能。
 */

import { getCommandNames } from './index';

// ============================================================================
// 解析结果
// ============================================================================

export interface ParsedInput {
  isCommand: boolean;
  name: string;
  args: string;
}

function isPathLikeSlashInput(input: string): boolean {
  const firstToken = input.split(/\s+/u, 1)[0] || '';
  const slashBody = firstToken.slice(1);
  return slashBody.includes('/') || slashBody.includes('.');
}

// ============================================================================
// 解析器
// ============================================================================

/**
 * 解析用户输入
 * - `/` 前缀 → 命令
 * - 非 `/` 前缀 → 直接作为 chat 输入
 */
export function parseInput(line: string): ParsedInput {
  const trimmed = line.trim();
  if (!trimmed) {
    return { isCommand: false, name: '', args: '' };
  }

  // `/` 前缀且不是绝对路径 → 命令
  if (trimmed.startsWith('/') && !isPathLikeSlashInput(trimmed)) {
    const parts = trimmed.slice(1).split(/\s+/);
    const name = parts[0] || '';
    const args = parts.slice(1).join(' ');
    return { isCommand: true, name, args };
  }

  // 非 `/` 前缀 → 直接作为 chat 输入
  return { isCommand: false, name: '', args: trimmed };
}

/**
 * 构建命令建议（用于 Tab 补全和未知命令提示）
 */
export function buildCommandSuggestions(partial: string): string[] {
  const names = getCommandNames();
  if (!partial) return names;
  return names.filter(n => n.startsWith(partial));
}

/**
 * Readline completer 函数
 */
export function createCompleter(): (line: string) => [string[], string] {
  return (line: string): [string[], string] => {
    const trimmed = line.trim();
    if (trimmed.startsWith('/') && !isPathLikeSlashInput(trimmed)) {
      const partial = trimmed.slice(1);
      const suggestions = buildCommandSuggestions(partial);
      // 返回补全后的完整行（带 `/` 前缀）
      const completions = suggestions.map(s => '/' + s);
      return [completions, line];
    }
    return [[], line];
  };
}
