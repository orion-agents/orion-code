/**
 * orion code - 状态栏组件
 *
 * 实时显示 token 数和上下文百分比。成本只通过 /cost 按需查询。
 */

import chalk from 'chalk';

const ACCENT = chalk.hex('#00D4AA');
const DIM = chalk.dim;
const SUCCESS = chalk.green;
const WARN = chalk.yellow;

// ============================================================================
// 类型定义
// ============================================================================

export interface StatusBarStats {
  model: string;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  ctxPercent: number;
  mcpConnected: number;
  mcpTotal: number;
}

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 渲染状态栏
 */
export function renderStatusBar(stats: StatusBarStats): string {
  const parts: string[] = [
    `Orion Code`,
    `${ACCENT(stats.model)}`,
    `${formatTokens(stats.tokens)}`,
    `${formatCtx(stats.ctxPercent)}`,  // 添加 ctxPercent 显示
  ];

  if (stats.mcpTotal > 0) {
    const mcpStatus = stats.mcpConnected === stats.mcpTotal
      ? SUCCESS(`${stats.mcpConnected}/${stats.mcpTotal}`)
      : `${stats.mcpConnected}/${stats.mcpTotal}`;
    parts.push(`MCP ${mcpStatus}`);
  }

  return DIM('  ') + parts.join(DIM(' | '));
}

/**
 * 渲染紧凑状态栏（单行）
 */
export function renderCompactStatusBar(stats: StatusBarStats): string {
  const tokenStr = stats.tokens > 0 ? `${ACCENT(formatTokens(stats.tokens))}` : '';
  const ctxStr = stats.ctxPercent > 0 ? `${DIM(stats.ctxPercent + '% ctx')}` : '';

  const parts = [tokenStr, ctxStr].filter(Boolean);
  return parts.length > 0 ? DIM('  ') + parts.join(DIM(' ')) : '';
}

/**
 * 更新状态栏显示
 * 在 prompt 上方渲染状态栏
 */
export function updateStatusBarDisplay(stats: StatusBarStats): void {
  const bar = renderStatusBar(stats);

  // 保存光标位置，上移一行，清除，写入状态栏
  process.stdout.write('\x1b[s');     // 保存
  process.stdout.write('\x1b[A');     // 上移
  process.stdout.write('\x1b[2K');    // 清除
  process.stdout.write('\r' + bar);   // 写入
  process.stdout.write('\x1b[u');     // 恢复
}

/**
 * 清除状态栏
 */
export function clearStatusBar(): void {
  process.stdout.write('\x1b[s');
  process.stdout.write('\x1b[A');
  process.stdout.write('\x1b[2K');
  process.stdout.write('\x1b[u');
}

// ============================================================================
// 内部辅助
// ============================================================================

function formatTokens(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M tok`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K tok`;
  }
  return `${tokens} tok`;
}

function formatCtx(percent: number): string {
  if (percent === 0) return '';
  if (percent >= 80) {
    return WARN(`${percent}% ctx`);  // 高占用时警告色
  }
  return DIM(`${percent}% ctx`);
}
