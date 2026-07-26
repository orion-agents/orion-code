/**
 * orion code - 工具预览组件
 *
 * 工具执行结果卡片化显示。
 */

import chalk from 'chalk';

const ACCENT = chalk.hex('#00D4AA');
const DIM = chalk.dim;
const SUCCESS = chalk.green;
const ERROR = chalk.red;

// ============================================================================
// 类型定义
// ============================================================================

export interface ToolPreview {
  name: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
  duration: number;
}

export interface DiffPreview {
  file: string;
  oldLines: string[];
  newLines: string[];
}

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 渲染工具卡片
 */
export function renderToolCard(tool: ToolPreview): string {
  const lines: string[] = [];
  const maxWidth = 60;

  // 标题
  const icon = tool.success ? SUCCESS('✓') : ERROR('✗');
  const title = `${icon} ${ACCENT(tool.name)}`;
  lines.push(DIM('┌─ ') + title + DIM(' ') + '─'.repeat(maxWidth - title.length - 5) + DIM('┐'));

  // 参数摘要
  const argsStr = compactArgs(tool.args);
  if (argsStr) {
    lines.push(DIM('│ ') + DIM(argsStr.slice(0, maxWidth - 4)) + DIM(' │'));
  }

  // 执行时间
  lines.push(DIM('│ ') + `${tool.duration}ms`.padEnd(maxWidth - 4) + DIM(' │'));

  // 分隔线
  lines.push(DIM('│ ') + '─'.repeat(maxWidth - 4) + DIM(' │'));

  // 结果摘要
  const resultLines = tool.result.split('\n').slice(0, 6);
  for (const line of resultLines) {
    const truncated = line.length > maxWidth - 4 ? line.slice(0, maxWidth - 7) + '...' : line;
    lines.push(DIM('│ ') + truncated.padEnd(maxWidth - 4) + DIM(' │'));
  }

  if (tool.result.split('\n').length > 6) {
    lines.push(DIM('│ ') + DIM(`... ${tool.result.split('\n').length - 6} more lines`).padEnd(maxWidth - 4) + DIM(' │'));
  }

  // 底部
  lines.push(DIM('└') + '─'.repeat(maxWidth - 2) + DIM('┘'));

  return lines.join('\n');
}

/**
 * 渲染紧凑工具行（用于单行显示）
 */
export function renderToolLine(name: string, args: Record<string, unknown>, success: boolean, duration?: number): string {
  const icon = success ? SUCCESS('✓') : ERROR('✗');
  const argsStr = compactArgs(args);
  const timeStr = duration !== undefined ? ` ${duration}ms` : '';

  return `  ${icon} ${ACCENT(name)} ${DIM(argsStr)}${timeStr}`;
}

/**
 * 渲染 Diff 预览
 */
export function renderDiffPreview(diff: DiffPreview): string {
  const lines: string[] = [];
  const maxWidth = 60;

  // 标题
  const title = `Edit: ${diff.file}`;
  lines.push(DIM('┌─ ') + ACCENT(title) + DIM(' ') + '─'.repeat(maxWidth - title.length - 5) + DIM('┐'));

  // 删除行
  for (const old of diff.oldLines) {
    const truncated = old.length > maxWidth - 6 ? old.slice(0, maxWidth - 9) + '...' : old;
    lines.push(DIM('│ ') + ERROR('- ') + DIM(truncated).padEnd(maxWidth - 6) + DIM(' │'));
  }

  // 添加行
  for (const new_ of diff.newLines) {
    const truncated = new_.length > maxWidth - 6 ? new_.slice(0, maxWidth - 9) + '...' : new_;
    lines.push(DIM('│ ') + SUCCESS('+ ') + DIM(truncated).padEnd(maxWidth - 6) + DIM(' │'));
  }

  // 底部
  lines.push(DIM('└') + '─'.repeat(maxWidth - 2) + DIM('┘'));

  return lines.join('\n');
}

/**
 * 渲染 Read 工具预览
 */
export function renderReadPreview(path: string, content: string, success: boolean): string {
  const lines: string[] = [];
  const maxWidth = 60;

  const icon = success ? SUCCESS('📖') : ERROR('📖');
  const title = `${icon} Read: ${path}`;
  lines.push(DIM('┌─ ') + title.slice(0, maxWidth - 5) + DIM(' ') + '─'.repeat(Math.max(0, maxWidth - title.length - 5)) + DIM('┐'));

  if (success && content) {
    const contentLines = content.split('\n').slice(0, 8);
    for (const line of contentLines) {
      const truncated = line.length > maxWidth - 4 ? line.slice(0, maxWidth - 7) + '...' : line;
      lines.push(DIM('│ ') + truncated.padEnd(maxWidth - 4) + DIM(' │'));
    }

    if (content.split('\n').length > 8) {
      lines.push(DIM('│ ') + DIM(`... ${content.split('\n').length - 8} more lines`).padEnd(maxWidth - 4) + DIM(' │'));
    }
  }

  lines.push(DIM('└') + '─'.repeat(maxWidth - 2) + DIM('┘'));

  return lines.join('\n');
}

// ============================================================================
// 内部辅助
// ============================================================================

function compactArgs(args: Record<string, unknown>): string {
  if (typeof args.path === 'string') {
    return args.path.length > 48 ? args.path.slice(0, 45) + '...' : args.path;
  }
  if (typeof args.command === 'string') {
    return args.command.length > 48 ? args.command.slice(0, 45) + '...' : args.command;
  }
  if (typeof args.pattern === 'string') {
    return args.pattern.length > 48 ? args.pattern.slice(0, 45) + '...' : args.pattern;
  }
  if (typeof args.file_path === 'string') {
    return args.file_path.length > 48 ? args.file_path.slice(0, 45) + '...' : args.file_path;
  }
  return '';
}