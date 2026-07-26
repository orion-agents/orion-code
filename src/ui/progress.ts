/**
 * orion code - 进度显示组件
 *
 * Issue #22 修复：批量工具调用进度显示
 * 提供 showProgress/hideProgress 函数，每秒更新一次进度指示。
 */

import chalk from 'chalk';

const DIM = chalk.dim;
const ACCENT = chalk.hex('#00D4AA');

let progressActive = false;

/**
 * 显示进度消息（原地更新，不换行）
 */
export function showProgress(message: string): void {
  // 检测 TTY
  if (!process.stdout.isTTY) return;

  // 检测 NO_COLOR
  if (process.env.NO_COLOR) {
    process.stdout.write(`\x1b[2K\r⏳ ${message}`);
    return;
  }

  process.stdout.write(`\x1b[2K\r${DIM('⏳')} ${ACCENT(message)}`);
  progressActive = true;
}

/**
 * 隐藏进度指示
 */
export function hideProgress(): void {
  if (!process.stdout.isTTY) return;
  if (progressActive) {
    process.stdout.write('\x1b[2K\r');
    progressActive = false;
  }
}

/**
 * 更新进度（如果已激活）
 */
export function updateProgress(message: string): void {
  if (progressActive) {
    showProgress(message);
  }
}

/**
 * 显示工具批量调用进度
 * @param count 当前已调用的工具数量
 * @param name 当前工具名称
 * @param total 总工具数量（可选）
 */
export function showToolProgress(count: number, name: string, total?: number): void {
  if (total) {
    showProgress(`Executing tool ${count}/${total}: ${name}`);
  } else {
    showProgress(`Executing tool ${count}: ${name}`);
  }
}

/**
 * 获取进度是否激活
 */
export function isProgressActive(): boolean {
  return progressActive;
}

/**
 * 清除进度并恢复提示符
 */
export function clearProgressAndRestorePrompt(prompt: string): void {
  hideProgress();
  if (process.stdout.isTTY) {
    process.stdout.write(prompt);
  }
}