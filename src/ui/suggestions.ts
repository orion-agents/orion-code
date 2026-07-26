/**
 * orion code - 命令建议渲染
 *
 * 实时显示 slash 命令建议，提供交互式输入体验。
 */

import chalk from 'chalk';
import { findCommand, getCommandNames } from '../commands/index';

// ============================================================================
// 颜色常量
// ============================================================================

const ACCENT = chalk.hex('#00D4AA');
const DIM = chalk.dim;
const INFO = chalk.cyan;

// ============================================================================
// 建议渲染
// ============================================================================

/** 建议区域高度（用于清除） */
let suggestionAreaHeight = 0;

/**
 * 构建命令建议列表
 * @param partial 用户输入的部分命令名（不含 "/"）
 * @returns 匹配的命令名列表
 */
export function buildCommandSuggestions(partial: string): string[] {
  const names = getCommandNames();
  if (!partial) return names.slice(0, 10); // 限制显示数量
  return names.filter(n => n.startsWith(partial)).slice(0, 10);
}

/**
 * 更新建议显示
 * @param input 当前输入（包含 "/" 前缀）
 */
export function updateSuggestions(input: string): void {
  clearSuggestions();

  if (input.startsWith('/')) {
    const partial = input.slice(1);
    const matches = buildCommandSuggestions(partial);

    if (matches.length > 0) {
      // 保存光标位置
      process.stdout.write('\x1b[s');
      // 移动到下一行
      process.stdout.write('\n');

      // 渲染建议标题
      if (partial === '') {
        process.stdout.write(DIM('  Commands:\n'));
      } else {
        process.stdout.write(DIM(`  Matching "${partial}":\n`));
      }

      // 渲染每个匹配的命令
      matches.forEach(m => {
        const cmd = findCommand(m);
        if (cmd) {
          const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
          const desc = cmd.description;
          process.stdout.write(`  ${ACCENT(`/${m}`)}${DIM(hint)} - ${INFO(desc)}\n`);
        }
      });

      suggestionAreaHeight = matches.length + 2; // +2 for title and blank line

      // 恢复光标位置
      process.stdout.write('\x1b[u');
    }
  }
}

/**
 * 清除建议区域
 */
export function clearSuggestions(): void {
  if (suggestionAreaHeight > 0) {
    // 保存光标位置
    process.stdout.write('\x1b[s');

    // 向下移动并清除每一行
    for (let i = 0; i < suggestionAreaHeight; i++) {
      process.stdout.write('\x1b[B');  // 下移一行
      process.stdout.write('\x1b[2K'); // 清除整行
    }

    // 移回原位置
    process.stdout.write('\x1b[u');
    suggestionAreaHeight = 0;
  }
}

/**
 * 重绘输入行
 * @param input 当前输入
 * @param modeIndicator 模式指示器文本
 */
export function redrawInput(input: string, modeIndicator: string = ''): void {
  // 移动到行首并清除整行
  process.stdout.write('\r\x1b[2K');

  // 绘制 prompt 和输入
  const prompt = ACCENT('❯ ') + DIM(modeIndicator);
  process.stdout.write(prompt + input);
}

/**
 * 显示所有命令建议（输入 "/" 时触发）
 */
export function showAllSuggestions(): void {
  updateSuggestions('/');
}

/**
 * 获取当前建议区域高度
 */
export function getSuggestionHeight(): number {
  return suggestionAreaHeight;
}