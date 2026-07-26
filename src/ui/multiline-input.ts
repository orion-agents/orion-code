/**
 * orion code - 多行输入组件
 *
 * 支持多行输入：通过 `\` 续行符方式。
 * 终端兼容性好，无需 Shift+Enter。
 */

import chalk from 'chalk';

const DIM = chalk.dim;

// ============================================================================
// 状态管理
// ============================================================================

export interface MultilineState {
  active: boolean;
  lines: string[];
}

const state: MultilineState = {
  active: false,
  lines: [],
};

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 检查是否进入多行模式（输入以 \ 结尾）
 */
export function shouldEnterMultiline(input: string): boolean {
  return input.endsWith('\\') && !input.endsWith('\\\\');
}

/**
 * 进入多行模式
 */
export function enterMultiline(currentInput: string): void {
  state.active = true;
  state.lines = [currentInput.slice(0, -1)]; // 移除末尾 \/
}

/**
 * 添加行到多行缓冲
 */
export function addMultilineLine(line: string): void {
  if (shouldEnterMultiline(line)) {
    state.lines.push(line.slice(0, -1));
  } else {
    state.lines.push(line);
    state.active = false;
  }
}

/**
 * 获取完整输入（合并所有行）
 */
export function getMultilineInput(): string {
  return state.lines.join('\n');
}

/**
 * 获取已确认的多行输入行
 */
export function getMultilineLines(): string[] {
  return [...state.lines];
}

/**
 * 重置多行状态
 */
export function resetMultiline(): void {
  state.active = false;
  state.lines = [];
}

/**
 * 检查多行模式是否激活
 */
export function isMultilineActive(): boolean {
  return state.active;
}

/**
 * 获取当前行数
 */
export function getMultilineLineCount(): number {
  return state.lines.length;
}

/**
 * 渲染续行指示器
 */
export function renderContinuationPrompt(): string {
  const lineNum = state.lines.length + 1;
  return DIM(`... (${lineNum}) `);
}

/**
 * 取消多行输入
 */
export function cancelMultiline(): void {
  resetMultiline();
}
