/**
 * Orion Code - UI components
 *
 * Output stream design:
 *   orion v0.1.14  │  glm-5  │  Qwen  │  ●
 *   ─────────────────────────────────────────────────────────
 *   ❯
 *   ─────────────────────────────────────────────────────────
 *     ? for shortcuts                                         ● In file.ts
 */

import chalk from 'chalk';

// ============================================================================
// 颜色常量
// ============================================================================

const BRAND = chalk.hex('#FF6B35');
const ACCENT = chalk.hex('#00D4AA');
const DIM = chalk.dim;
const GREEN = chalk.green;
const RED = chalk.red;
const YELLOW = chalk.yellow;

// Single line for separators
const SEP_LINE = '─';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// 使用终端控制码清除整行，避免宽字符（中文）残留

// ============================================================================
// Header Box
// ============================================================================

export interface HeaderBoxConfig {
  provider: string;
  model: string;
  endpoint?: string;  // kept for backward compat, no longer shown
  status: 'ready' | 'loading' | 'error' | 'processing';
  statusText?: string;
  version: string;
  width?: number;
}

/**
 * Renders a compact header line with model info
 */
export function renderHeaderBox(config: HeaderBoxConfig): string {
  const parts: string[] = [];

  // Model name
  parts.push(ACCENT(config.model));

  // Provider (shortened)
  const providerShort = config.provider === 'Alibaba Cloud' ? 'Qwen'
    : config.provider === 'Anthropic' ? 'Anthropic'
    : config.provider === 'OpenAI' ? 'OpenAI'
    : config.provider;
  if (providerShort) {
    parts.push(DIM(providerShort));
  }

  // Status
  const statusIcon = config.status === 'ready' ? GREEN('●')
    : config.status === 'loading' ? YELLOW('○')
    : config.status === 'error' ? RED('●')
    : config.status === 'processing' ? ACCENT('◌')
    : DIM('○');
  parts.push(statusIcon);

  return `  ${BRAND('orion')} ${DIM('v' + config.version)}  ${DIM('│')} ${parts.join(` ${DIM('│')} `)}`;
}

/**
 * Renders the full prompt area with separators
 * Returns { topSep, promptLine, bottomSep }
 */
export function renderPromptArea(modeText?: string): { topSep: string; promptLine: string; bottomSep: string } {
  const terminalWidth = process.stdout.columns || 80;
  const modeIndicator = modeText ? ` [${modeText}]` : '';
  const promptChar = '❯';

  // Top separator line
  const topSep = DIM(SEP_LINE.repeat(terminalWidth));

  // Prompt line: centered ❯ with mode indicator
  const promptLine = `${ACCENT(promptChar)}${modeIndicator ? DIM(modeIndicator) : ''}`;

  // Bottom separator line
  const bottomSep = DIM(SEP_LINE.repeat(terminalWidth));

  return { topSep, promptLine, bottomSep };
}

/**
 * Renders the input separator line with prompt (legacy, single-line version)
 */
export function renderPromptSeparator(modeText?: string): string {
  const terminalWidth = process.stdout.columns || 80;
  const modeIndicator = modeText ? DIM(`[${modeText}] `) : '';
  const promptChar = ACCENT('❯');
  const leftSep = SEP_LINE.repeat(10);
  const rightSepLength = terminalWidth - 12 - (modeText ? modeText.length + 3 : 0);
  const rightSep = SEP_LINE.repeat(Math.max(0, rightSepLength));

  return `${DIM(leftSep)} ${promptChar}${modeIndicator} ${DIM(rightSep)}`;
}

/**
 * Renders the footer bar with shortcuts and context
 */
export function renderFooterBar(contextFile?: string, effort?: string): string {
  const terminalWidth = process.stdout.columns || 80;

  // Left side: shortcuts hint
  const shortcuts = DIM('? for shortcuts');

  // Right side: file context and effort
  let rightSide = '';
  if (contextFile) {
    const fileIndicator = truncateLeft(contextFile, 30);
    rightSide += `${ACCENT('⧉')} ${DIM('In ' + fileIndicator)}`;
  }
  if (effort) {
    rightSide += `  ${ACCENT('●')} ${DIM(effort)}`;
  }

  // Calculate spacing
  const leftLen = stringWidth(shortcuts);
  const rightLen = stringWidth(rightSide);
  const spacing = Math.max(1, terminalWidth - leftLen - rightLen - 2);

  return `  ${shortcuts}${' '.repeat(spacing)}${rightSide}`;
}


/**
 * Truncate string from left side, adding ... if truncated
 */
function truncateLeft(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return '...' + str.slice(-(maxLen - 3));
}

/**
 * Get visible width of string (ANSI codes excluded)
 */
function stringWidth(str: string): number {
  // Remove ANSI escape codes
  const clean = str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  return clean.length;
}

// ============================================================================
// Spinner
// ============================================================================

export interface Spinner {
  start: (text?: string) => void;
  stop: () => void;
  update: (text?: string) => void;
}

export function createSpinner(): Spinner {
  let interval: NodeJS.Timeout | null = null;
  let frame = 0;
  let currentText = '';
  let startTime = Date.now();
  let isRunning = false;
  let shouldStop = false;

  function render(): void {
    if (!isRunning || shouldStop) return;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    // 确保清除整行并重新定位
    process.stdout.write(`\r\x1b[2K${spinner} ${currentText} (${elapsed}s)`);
    frame++;
  }

  return {
    start(text = 'Thinking') {
      if (isRunning) return;
      isRunning = true;
      shouldStop = false;
      currentText = text;
      startTime = Date.now();
      frame = 0;
      render();
      interval = setInterval(render, 100);
    },

    stop() {
      if (!isRunning) return;
      // 先设置标记，防止 clearInterval 前 pending 的回调仍渲染
      shouldStop = true;
      isRunning = false;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      // 清除整行并定位到行首
      process.stdout.write('\r\x1b[2K');
    },

    update(text) {
      if (text) currentText = text;
    },
  };
}

// ============================================================================
// 工具调用行
// ============================================================================

export function toolLine(
  name: string,
  args: Record<string, unknown>,
  success: boolean,
  duration?: number,
): string {
  const argSummary = compactArgs(args);
  const status = success
    ? `${GREEN('✓')}${duration !== undefined ? ` ${duration}ms` : ''}`
    : `${RED('✗')}${duration !== undefined ? ` ${duration}ms` : ''}`;
  return `  ${ACCENT('▸')} ${ACCENT(name)} ${DIM(argSummary)} ${status}`;
}

function compactArgs(args: Record<string, unknown>): string {
  if (typeof args.path === 'string') {
    return args.path.length > 48 ? args.path.slice(0, 45) + '...' : args.path;
  }
  if (typeof args.command === 'string') {
    return args.command.length > 48 ? args.command.slice(0, 45) + '...' : args.command;
  }
  for (const val of Object.values(args)) {
    if (typeof val === 'string') {
      return val.length > 48 ? val.slice(0, 45) + '...' : val;
    }
  }
  return '';
}
