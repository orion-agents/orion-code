/**
 * Orion Code - Minimal Terminal UI Utilities
 *
 * 简化的终端 UI 工具，不依赖 React hooks
 */

// ============================================================================
// ANSI 颜色辅助函数
// ============================================================================

export const COLORS = {
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
};

export const STYLES = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  reset: '\x1b[0m',
};

export const CURSOR = {
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
};

export const SCREEN = {
  clear: '\x1b[2J',
  home: '\x1b[H',
  clearLine: '\x1b[2K',
};

// ============================================================================
// Spinner
// ============================================================================

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function createSpinner(onUpdate: (frame: string) => void): { start: () => void; stop: () => void } {
  let frameIndex = 0;
  let timer: NodeJS.Timeout | null = null;

  return {
    start: () => {
      timer = setInterval(() => {
        frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
        onUpdate(SPINNER_FRAMES[frameIndex]);
      }, 80);
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

// ============================================================================
// 输入处理
// ============================================================================

export function setupRawInput(
  onChar: (char: string, key: { name: string; ctrl: boolean }) => void
): { cleanup: () => void } {
  if (!process.stdin.isTTY) {
    return { cleanup: () => {} };
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  const handler = (data: string) => {
    const char = data.charAt(0);
    const key = {
      name: char,
      ctrl: char === '\x03', // Ctrl+C
    };
    onChar(data, key);
  };

  process.stdin.on('data', handler);

  return {
    cleanup: () => {
      process.stdin.setRawMode(false);
      process.stdin.removeListener('data', handler);
    },
  };
}

// ============================================================================
// 渲染辅助
// ============================================================================

export function clearScreen(): void {
  process.stdout.write(SCREEN.clear + SCREEN.home);
}

export function hideCursor(): void {
  process.stdout.write(CURSOR.hide);
}

export function showCursor(): void {
  process.stdout.write(CURSOR.show);
}