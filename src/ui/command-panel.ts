/**
 * orion code - 命令面板组件
 *
 * 交互式 slash 命令选择面板，支持 ↑↓ 导航、实时过滤、Enter 选择。
 *
 * Issue #32 #3.11: SIGWINCH 终端大小调整 + NO_COLOR 环境变量支持
 */

import chalk from 'chalk';
import { getCommands } from '../commands/index';
import type { SlashCommand } from '../commands/types';
import { renderCommandPalette } from './shared/command-palette';
import { buildCommandSuggestions } from './shared/command-suggestions';
import { renderFramedInputFrame } from './shared/input-frame';
import { stripAnsi, visualWidth } from './shared/text';

// ============================================================================
// 颜色常量 - Issue #32 #3.11: NO_COLOR 支持
// ============================================================================

// 检查 NO_COLOR 环境变量（https://no-color.org/）
const NO_COLOR = process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb';

// 如果 NO_COLOR 设置，使用无颜色的 chalk
const colorize = NO_COLOR ? {
  accent: (s: string) => s,
  dim: (s: string) => s,
  selected: (s: string) => s,
} : {
  accent: chalk.hex('#00D4AA'),
  dim: chalk.dim,
  selected: chalk.bgHex('#1E293B').hex('#E2E8F0'),
};

const ACCENT = colorize.accent;
const DIM = colorize.dim;
const SELECTED = colorize.selected;

type InputPromptRenderer = 'classic' | 'framed' | 'legacy' | 'v2';
type NormalizedInputPromptRenderer = 'classic' | 'framed';
interface InputRenderContext {
  prefixLines?: string[];
}

let inputPromptRenderer: NormalizedInputPromptRenderer = 'classic';
let inputRenderContextProvider: () => InputRenderContext = () => ({});
let inputStatusText = '';

export function setInputPromptRenderer(renderer: InputPromptRenderer): void {
  inputPromptRenderer = renderer === 'framed' || renderer === 'v2' ? 'framed' : 'classic';
}

export function setInputRenderContextProvider(provider: () => InputRenderContext): void {
  inputRenderContextProvider = provider;
}

export function setInputStatusText(statusText: string): void {
  inputStatusText = statusText;
}

// ============================================================================
// SIGWINCH 处理 - Issue #32 #3.11
// ============================================================================

let terminalWidth = process.stdout.columns || 80;

// 监听终端大小变化
if (process.stdout.isTTY) {
  process.stdout.on('resize', () => {
    terminalWidth = process.stdout.columns || 80;
    // 如果面板可见，重新渲染
    if (state.visible) {
      render();
    }
  });
}

// ============================================================================
// 状态管理
// ============================================================================

export interface CommandPanelState {
  visible: boolean;
  selectedIndex: number;
  filter: string;
  matches: SlashCommand[];
  moreCount: number;
  totalMatches: number;
}

const state: CommandPanelState = {
  visible: false,
  selectedIndex: 0,
  filter: '',
  matches: [],
  moreCount: 0,
  totalMatches: 0,
};

/** 面板高度（用于清除） */
let panelHeight = 0;
/** 已为面板预留的屏幕行数，避免底部绘制时反复滚屏 */
let reservedPanelHeight = 0;

/** 当前输入缓冲（供 CLI 读取） */
let pendingCommand: string | null = null;

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 显示命令面板
 * @param filter 过滤字符串（不含 "/"）
 */
export function showCommandPanel(filter: string = ''): void {
  state.visible = true;
  state.filter = filter;
  state.selectedIndex = 0;
  updateMatches();
  render();
}

/**
 * 隐藏命令面板
 */
export function hideCommandPanel(): void {
  if (state.visible) {
    clearPanel({ release: true });
    state.visible = false;
    state.matches = [];
    state.filter = '';
    state.selectedIndex = 0;
    state.moreCount = 0;
    state.totalMatches = 0;
  }
}

/**
 * 导航选择
 */
export function navigatePanel(direction: 'up' | 'down'): void {
  if (!state.visible || state.matches.length === 0) return;

  if (direction === 'up') {
    state.selectedIndex = Math.max(0, state.selectedIndex - 1);
  } else {
    state.selectedIndex = Math.min(state.matches.length - 1, state.selectedIndex + 1);
  }
  render();
}

/**
 * 选择当前命令
 * @returns 选中命令的完整输入（含 "/"），或 null
 */
export function selectCommand(): string | null {
  if (!state.visible || state.matches.length === 0) return null;

  const cmd = state.matches[state.selectedIndex];
  pendingCommand = '/' + cmd.name;
  hideCommandPanel();
  return pendingCommand;
}

/**
 * 补全当前命令但不执行。
 */
export function completeSelectedCommand(): string | null {
  if (!state.visible || state.matches.length === 0) return null;

  const cmd = state.matches[state.selectedIndex];
  hideCommandPanel();
  return '/' + cmd.name + ' ';
}

/**
 * 更新过滤条件
 */
export function updatePanelFilter(filter: string): void {
  state.filter = filter;
  state.selectedIndex = 0;
  updateMatches();
  render();
}

/**
 * 获取面板是否可见
 */
export function isPanelVisible(): boolean {
  return state.visible;
}

/**
 * 获取当前选中的命令名
 */
export function getSelectedCommandName(): string | null {
  if (!state.visible || state.matches.length === 0) return null;
  return state.matches[state.selectedIndex].name;
}

/**
 * 获取待处理的命令（选择后的）
 */
export function getPendingCommand(): string | null {
  return pendingCommand;
}

/**
 * 清除待处理命令
 */
export function clearPendingCommand(): void {
  pendingCommand = null;
}

// ============================================================================
// 内部辅助
// ============================================================================

function updateMatches(): void {
  const result = buildCommandSuggestions(getCommands(), state.filter);
  state.matches = result.commands;
  state.moreCount = result.moreCount;
  state.totalMatches = result.total;
}

/** 上次渲染的面板行数 */
let lastPanelLines: string[] = [];

function render(): void {
  const title = state.filter ? `Matching "${state.filter}"` : 'Commands';
  const lines = renderCommandPalette({
    title,
    items: buildCommandSuggestions(state.matches, '').items,
    selectedIndex: state.selectedIndex,
    width: terminalWidth,
    moreCount: state.moreCount,
    emptyLabel: 'No matching commands',
    footer: '  ↑↓ Select  Tab Complete  Enter Run  Esc',
    theme: {
      accent: ACCENT,
      dim: DIM,
      selected: SELECTED,
    },
  });

  // 先清除上次的面板（使用保存的行数）
  clearPanel({ release: false });

  const panelOffset = getPanelOffsetRows();
  reservePanelSpace(lines.length + panelOffset);

  // 保存行数用于下次清除
  lastPanelLines = lines;
  panelHeight = lines.length;

  // 使用更安全的渲染方式：保存光标位置，清除下方区域，写入面板，恢复光标
  process.stdout.write('\x1b7');  // 保存光标位置

  if (panelOffset > 0) {
    process.stdout.write(`\x1b[${panelOffset}B\r`);
  }

  // 清除从面板起点到屏幕底部的内容（不移动输入光标）
  process.stdout.write('\x1b[J');  // 清除从光标到屏幕底部

  // 现在写入面板内容
  for (let index = 0; index < lines.length; index++) {
    if (index > 0 || panelOffset === 0) {
      process.stdout.write('\n');
    }
    process.stdout.write('\r' + lines[index]);
  }

  // 恢复光标到保存的位置
  process.stdout.write('\x1b8');
}

function clearPanel(options: { release?: boolean } = {}): void {
  // 使用保存的行数清除
  const height = Math.max(reservedPanelHeight, lastPanelLines.length, panelHeight);
  if (height > 0) {
    // 保存当前光标位置
    process.stdout.write('\x1b7');

    const panelOffset = getPanelOffsetRows();
    if (panelOffset > 0) {
      process.stdout.write(`\x1b[${panelOffset}B\r`);
    }

    // 清除从光标到屏幕底部
    process.stdout.write('\x1b[J');

    // 恢复光标位置
    process.stdout.write('\x1b8');

    lastPanelLines = [];
    panelHeight = 0;
    if (options.release) {
      reservedPanelHeight = 0;
    }
  }
}

function reservePanelSpace(requiredHeight: number): void {
  if (requiredHeight <= reservedPanelHeight) return;

  const extraLines = requiredHeight - reservedPanelHeight;
  const panelOffset = getPanelOffsetRows();

  if (panelOffset > 0) {
    process.stdout.write(`\x1b[${panelOffset}B\r`);
  }
  process.stdout.write('\n'.repeat(extraLines));
  process.stdout.write(`\x1b[${extraLines + panelOffset}A`);
  if (lastInputCursorColumn > 0) {
    process.stdout.write(`\x1b[${lastInputCursorColumn}G`);
  }
  reservedPanelHeight = requiredHeight;
}

/** 上次渲染的总长度（prompt + input 的可见宽度） */
let lastTotalRendered = 0;
let lastInputBlockHeight = 0;
let lastInputCursorRow = 0;
let lastInputCursorColumn = 0;
let lastInputValue = '';
let lastInputModeIndicator = '';
let framedInputVisible = false;
let framedInputLeadingNewline = false;
let outputCursorColumn = 0;
let outputCursorColumnBeforeFrame = 0;
/** 是否是首次渲染（首次不清除） */
let isFirstRender = true;

/**
 * 重绘输入行（带 prompt）
 * v0.1.15: 修复换行残留 — 使用可见宽度计算（CJK 占 2 格）
 */
export function redrawInputWithPrompt(input: string, modeIndicator: string = ''): void {
  if (state.visible && (lastPanelLines.length > 0 || reservedPanelHeight > 0)) {
    clearPanel({ release: false });
  }

  if (inputPromptRenderer === 'framed') {
    redrawFramedInput(input, modeIndicator);
    return;
  }

  const prompt = ACCENT('❯ ') + (modeIndicator ? DIM(modeIndicator) : '');
  const promptWidth = visualWidth(stripAnsi(prompt));

  if (!isFirstRender) {
    const lastTotal = lastTotalRendered;

    // 使用可见宽度计算上次渲染占用的行数
    let lines = 1;
    if (lastTotal > 0) {
      lines = Math.ceil(lastTotal / terminalWidth);
    }

    // 光标在最后渲染行的下一行（wrap 后）
    const cursorOnNextLine = lastTotal > 0 && lastTotal % terminalWidth === 0;

    if (cursorOnNextLine) {
      process.stdout.write('\x1b[1A');
    }

    // 清除最后渲染行
    process.stdout.write('\x1b[2K');

    // 上移清除其余行
    for (let i = 1; i < lines; i++) {
      process.stdout.write('\x1b[1A\x1b[2K');
    }

    process.stdout.write('\r');
  }

  // 绘制新的输入
  process.stdout.write(prompt + input);

  // 记录可见总宽度（prompt + input）
  lastTotalRendered = promptWidth + visualWidth(input);
  lastInputCursorColumn = (lastTotalRendered % terminalWidth) + 1;
  isFirstRender = false;
}

function redrawFramedInput(input: string, modeIndicator: string): void {
  const wasVisible = framedInputVisible;
  if (framedInputVisible) {
    clearPreviousFramedInput();
  }

  const leadingNewline = !wasVisible && outputCursorColumn > 0;
  outputCursorColumnBeforeFrame = outputCursorColumn;
  if (leadingNewline) {
    process.stdout.write('\n');
  }

  const context = inputRenderContextProvider();
  const frameInput = [
    ...(context.prefixLines || []),
    input,
  ].join('\n');
  const frame = renderFramedInputFrame({
    input: frameInput,
    modeIndicator,
    width: terminalWidth,
    statusText: inputStatusText,
  });

  process.stdout.write(frame.output);

  const rowsToCursor = frame.height - 1 - frame.cursorRow;
  if (rowsToCursor > 0) {
    process.stdout.write(`\x1b[${rowsToCursor}A`);
  }
  process.stdout.write(`\r\x1b[${frame.cursorColumn}G`);

  lastInputBlockHeight = frame.height;
  lastInputCursorRow = frame.cursorRow;
  lastInputCursorColumn = frame.cursorColumn;
  lastTotalRendered = visualWidth(input);
  lastInputValue = input;
  lastInputModeIndicator = modeIndicator;
  framedInputVisible = true;
  framedInputLeadingNewline = leadingNewline;
  isFirstRender = false;
}

function clearPreviousFramedInput(): void {
  if (lastInputBlockHeight <= 0 || !framedInputVisible) return;

  if (lastInputCursorRow > 0) {
    process.stdout.write(`\x1b[${lastInputCursorRow}A`);
  }
  process.stdout.write('\r');

  for (let i = 0; i < lastInputBlockHeight; i++) {
    process.stdout.write('\x1b[2K');
    if (i < lastInputBlockHeight - 1) {
      process.stdout.write('\x1b[1B');
    }
  }

  if (lastInputBlockHeight > 1) {
    process.stdout.write(`\x1b[${lastInputBlockHeight - 1}A`);
  }

  if (framedInputLeadingNewline) {
    process.stdout.write('\x1b[1A');
    process.stdout.write(`\r\x1b[${outputCursorColumnBeforeFrame + 1}G`);
    outputCursorColumn = outputCursorColumnBeforeFrame;
  } else {
    outputCursorColumn = 0;
    process.stdout.write('\r');
  }

  framedInputVisible = false;
}

export function clearRenderedInput(): void {
  if (inputPromptRenderer === 'framed') {
    clearPreviousFramedInput();
  } else {
    process.stdout.write('\x1b[2K\r');
  }
  resetRenderLength();
}

function getPanelOffsetRows(): number {
  return inputPromptRenderer === 'framed' ? 2 : 0;
}

/**
 * 重置渲染长度跟踪
 */
export function resetRenderLength(): void {
  lastTotalRendered = 0;
  lastInputBlockHeight = 0;
  lastInputCursorRow = 0;
  lastInputCursorColumn = 0;
  lastInputValue = '';
  lastInputModeIndicator = '';
  framedInputVisible = false;
  framedInputLeadingNewline = false;
  outputCursorColumn = 0;
  outputCursorColumnBeforeFrame = 0;
  isFirstRender = true;
}

export function writeOutputPreservingInput(text: string): void {
  if (inputPromptRenderer !== 'framed' || !framedInputVisible) {
    process.stdout.write(text);
    trackOutputCursor(text);
    return;
  }

  const input = lastInputValue;
  const modeIndicator = lastInputModeIndicator;
  clearPreviousFramedInput();
  process.stdout.write(text);
  trackOutputCursor(text);
  redrawFramedInput(input, modeIndicator);
}

export function writeLinePreservingInput(text: string = ''): void {
  writeOutputPreservingInput(text + '\n');
}

function trackOutputCursor(text: string): void {
  const plain = stripAnsi(text);
  for (const ch of plain) {
    if (ch === '\n') {
      outputCursorColumn = 0;
    } else if (ch === '\r') {
      outputCursorColumn = 0;
    } else {
      outputCursorColumn += visualWidth(ch);
      if (outputCursorColumn >= terminalWidth) {
        outputCursorColumn = outputCursorColumn % terminalWidth;
      }
    }
  }
}
