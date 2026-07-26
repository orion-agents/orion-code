/**
 * orion code - 文件路径补全组件
 *
 * 输入 @ 后自动补全文件路径，支持 glob 匹配。
 */

import chalk from 'chalk';
import { matchFiles, type FileMatch } from '../services/file-glob';
import { renderFramedPrompt } from './shared/input-frame';

const ACCENT = chalk.hex('#00D4AA');
const DIM = chalk.dim;
const SELECTED = chalk.bgHex('#1E293B').hex('#E2E8F0');

type FilePromptRenderer = 'classic' | 'framed' | 'legacy' | 'v2';
type NormalizedFilePromptRenderer = 'classic' | 'framed';
let filePromptRenderer: NormalizedFilePromptRenderer = 'classic';

export function setFileCompletionPromptRenderer(renderer: FilePromptRenderer): void {
  filePromptRenderer = renderer === 'framed' || renderer === 'v2' ? 'framed' : 'classic';
}

// ============================================================================
// 状态管理
// ============================================================================

export interface FileCompletionState {
  visible: boolean;
  query: string;       // @ 后的路径部分
  baseInput: string;   // @ 前的文本
  matches: FileMatch[];
  selectedIndex: number;
}

const state: FileCompletionState = {
  visible: false,
  query: '',
  baseInput: '',
  matches: [],
  selectedIndex: 0,
};

let panelHeight = 0;

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 显示文件补全面板
 * @param query @ 后的路径查询
 * @param baseInput @ 前的文本
 */
export function showFileCompletion(query: string, baseInput: string): void {
  state.visible = true;
  state.query = query;
  state.baseInput = baseInput;
  state.selectedIndex = 0;
  updateMatches();
  render();
}

/**
 * 隐藏文件补全面板
 */
export function hideFileCompletion(): void {
  if (state.visible) {
    clearPanel();
    state.visible = false;
    state.matches = [];
    state.query = '';
    state.selectedIndex = 0;
  }
}

/**
 * 导航选择
 */
export function navigateFiles(direction: 'up' | 'down'): void {
  if (!state.visible || state.matches.length === 0) return;

  if (direction === 'up') {
    state.selectedIndex = Math.max(0, state.selectedIndex - 1);
  } else {
    state.selectedIndex = Math.min(state.matches.length - 1, state.selectedIndex + 1);
  }
  render();
}

/**
 * 选择当前文件
 * @returns 选中文件的路径，或 null
 */
export function selectFile(): string | null {
  if (!state.visible || state.matches.length === 0) return null;

  const file = state.matches[state.selectedIndex];
  hideFileCompletion();
  return file.path;
}

/**
 * Tab 补全：补全到当前选中路径
 * @returns 补全后的完整输入
 */
export function completeFile(): string | null {
  if (!state.visible || state.matches.length === 0) return null;

  const file = state.matches[state.selectedIndex];
  // 继续显示面板（如果是目录）
  if (file.isDirectory) {
    state.query = file.path + '/';
    state.selectedIndex = 0;
    updateMatches();
    render();
    return null;
  }
  return file.path;
}

/**
 * 更新查询
 */
export function updateFileQuery(query: string): void {
  state.query = query;
  state.selectedIndex = 0;
  updateMatches();
  if (state.matches.length > 0) {
    render();
  } else {
    hideFileCompletion();
  }
}

/**
 * 获取面板是否可见
 */
export function isFileCompletionVisible(): boolean {
  return state.visible;
}

/**
 * 获取基础输入（@ 前的文本）
 */
export function getBaseInput(): string {
  return state.baseInput;
}

/**
 * 获取当前查询（@ 后的文本）
 */
export function getFileQuery(): string {
  return state.query;
}

/**
 * 获取完整输入（base + @ + query）
 */
export function getFullInput(): string {
  return state.baseInput + '@' + state.query;
}

// ============================================================================
// 内部辅助
// ============================================================================

function updateMatches(): void {
  state.matches = matchFiles(state.query, process.cwd());
}

function render(): void {
  clearPanel();

  if (state.matches.length === 0) {
    return;
  }

  const terminalWidth = process.stdout.columns || 80;
  const innerWidth = Math.min(terminalWidth - 4, 60);

  const lines: string[] = [];

  // 标题行
  const title = 'Files';
  lines.push(DIM(`┌─ ${title} `) + DIM('─'.repeat(innerWidth - title.length - 3)) + DIM('┐'));

  // 文件列表
  for (let i = 0; i < state.matches.length; i++) {
    const file = state.matches[i];
    const isSelected = i === state.selectedIndex;

    const icon = file.isDirectory ? '📁' : '📄';
    const pathDisplay = file.path.length > innerWidth - 6
      ? file.path.slice(0, innerWidth - 9) + '...'
      : file.path;

    if (isSelected) {
      lines.push(SELECTED(` ${icon} ${pathDisplay} `) + ' '.repeat(innerWidth - pathDisplay.length - 4) + SELECTED(' '));
    } else {
      lines.push(DIM('│ ') + ACCENT(icon + ' ' + pathDisplay) + ' '.repeat(innerWidth - pathDisplay.length - 4) + DIM(' │'));
    }
  }

  // 底部
  lines.push(DIM('└') + DIM('─'.repeat(innerWidth)) + DIM('┘'));

  // 操作提示
  lines.push(DIM('  ↑↓ Navigate  Tab Complete  Enter Select  Esc Cancel'));

  // 渲染
  for (const line of lines) {
    process.stdout.write('\n' + line);
  }

  panelHeight = lines.length;

  // 恢复光标
  process.stdout.write(`\x1b[${panelHeight}A`);
  process.stdout.write('\r');
}

function clearPanel(): void {
  if (panelHeight > 0) {
    for (let i = 0; i < panelHeight; i++) {
      process.stdout.write('\x1b[B');
      process.stdout.write('\x1b[2K');
    }
    process.stdout.write(`\x1b[${panelHeight}A`);
    process.stdout.write('\r');
    panelHeight = 0;
  }
}

/**
 * 重绘输入（带 @ 和路径）
 */
export function redrawInputWithFile(input: string): void {
  process.stdout.write('\r\x1b[2K');
  const prompt = filePromptRenderer === 'framed' ? renderFramedPrompt() : ACCENT('❯ ');
  process.stdout.write(prompt + input);
}
