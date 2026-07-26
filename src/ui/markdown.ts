/**
 * orion code - 终端 Markdown 渲染器
 *
 * Issue #25 修复：使用 marked-terminal 渲染 Markdown
 * 支持：标题、粗体、斜体、行内代码、代码块、列表、引用、表格、链接。
 *
 * 检测 TTY 和 NO_COLOR 环境变量，非 TTY 输出原始 Markdown。
 */

import chalk from 'chalk';
import { marked } from 'marked';
// @ts-expect-error - marked-terminal 没有 TypeScript 类型定义
import TerminalRenderer from 'marked-terminal';

// ============================================================================
// 颜色常量
// ============================================================================

const ACCENT = chalk.hex('#00D4AA');
const CODE_BG = chalk.bgHex('#1E293B');
const CODE_TEXT = chalk.hex('#E2E8F0');
const QUOTE = chalk.hex('#64748B');
const DIM = chalk.dim;
const BOLD = chalk.bold;
const ITALIC = chalk.italic;
const CYAN = chalk.cyan;

const DEFAULT_MAX_WIDTH = 80;

// 初始化 marked-terminal renderer
let terminalRenderer: any = null;

function initRenderer(): void {
  if (terminalRenderer) return;

  try {
    terminalRenderer = new TerminalRenderer({
      showEscapePrefix: false,
      code: chalk.yellow,
      blockquote: chalk.dim.gray,
      heading: chalk.bold.cyan,
      firstHeading: chalk.bold.magenta,
      hr: chalk.dim,
      listitem: chalk.green,
      table: chalk.cyan,
      paragraph: chalk.white,
      strong: chalk.bold,
      em: chalk.italic,
      codespan: chalk.bgGray.white,
      ref: chalk.cyan,
      tab: 2,
    });

    marked.setOptions({
      renderer: terminalRenderer,
    });
  } catch (e) {
    // marked-terminal 初始化失败，使用 fallback
    terminalRenderer = null;
  }
}

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 将 markdown 文本渲染为带 ANSI 颜色的终端输出
 * Issue #25 修复：使用 marked-terminal 或 fallback
 */
export function renderMarkdown(text: string, maxWidth = DEFAULT_MAX_WIDTH): string {
  // 检测 TTY
  if (!process.stdout.isTTY) {
    return text;  // 非 TTY 返回原始 Markdown（用于 pipe 到文件）
  }

  // 检测 NO_COLOR
  if (process.env.NO_COLOR) {
    return stripMarkdownSyntax(text);  // 去除 Markdown 符号，输出纯文本
  }

  // 尝试使用 marked-terminal
  initRenderer();
  if (terminalRenderer) {
    try {
      return marked.parse(text) as string;
    } catch (e) {
      // marked 解析失败，使用 fallback
      return renderMarkdownFallback(text, maxWidth);
    }
  }

  // fallback：使用原有渲染器
  return renderMarkdownFallback(text, maxWidth);
}

/**
 * Fallback 渲染器（当 marked-terminal 不可用时）
 */
export function renderMarkdownFallback(text: string, maxWidth = DEFAULT_MAX_WIDTH): string {
  const lines = text.split('\n');
  const result: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 代码块 ```
    if (line.trimStart().startsWith('```')) {
      const codeBlockLines: string[] = [];
      const lang = line.trim().slice(3).trim();
      if (lang) {
        result.push(DIM(`┌─ ${lang}`));
      }
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeBlockLines.push(lines[i]);
        i++;
      }
      // 渲染代码块
      for (const codeLine of codeBlockLines) {
        result.push(CODE_BG(' ') + CODE_TEXT(codeLine));
      }
      if (lang) {
        result.push(DIM('└' + '─'.repeat(Math.min(maxWidth - 3, 70))));
      }
      i++; // skip closing ```
      continue;
    }

    // 空行
    if (line.trim() === '') {
      result.push('');
      i++;
      continue;
    }

    // 分隔线
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
      result.push(DIM('─'.repeat(maxWidth - 2)));
      i++;
      continue;
    }

    // 引用 >
    if (line.trimStart().startsWith('>')) {
      const quoteText = line.trimStart().slice(1).trim();
      const wrapped = wrapText(quoteText, maxWidth - 4);
      for (const w of wrapped) {
        result.push(QUOTE(`│ ${w}`));
      }
      i++;
      continue;
    }

    // 标题
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();
      const prefix = '  '.repeat(level - 1);
      const styled = level <= 2 ? BOLD(CYAN(prefix + ' ' + headingText))
        : level <= 4 ? BOLD(CYAN(prefix + headingText))
        : BOLD(DIM(headingText));
      result.push(styled);
      result.push(DIM('─'.repeat(Math.min(headingText.length + prefix.length + 2, maxWidth - 2))));
      i++;
      continue;
    }

    // 列表项
    const listMatch = line.match(/^(\s*)[-*]\s+(.*)/);
    if (listMatch) {
      const indent = listMatch[1].length;
      const content = listMatch[2].trim();
      const styledContent = renderInline(content);
      const prefix = ' '.repeat(indent) + ACCENT('•');
      const wrapped = wrapText(styledContent, maxWidth - indent - 2);
      if (wrapped.length > 0) {
        result.push(prefix + ' ' + wrapped[0]);
        for (let w = 1; w < wrapped.length; w++) {
          result.push(' '.repeat(indent + 2) + wrapped[w]);
        }
      }
      i++;
      continue;
    }

    // 数字列表
    const numListMatch = line.match(/^(\s*)\d+\.\s+(.*)/);
    if (numListMatch) {
      const indent = numListMatch[1].length;
      const content = numListMatch[2].trim();
      const styledContent = renderInline(content);
      const wrapped = wrapText(styledContent, maxWidth - indent - 4);
      if (wrapped.length > 0) {
        result.push(' '.repeat(indent) + '1. ' + wrapped[0]);
        for (let w = 1; w < wrapped.length; w++) {
          result.push(' '.repeat(indent + 3) + wrapped[w]);
        }
      }
      i++;
      continue;
    }

    // 普通文本行 — 无首行缩进
    const content = renderInline(line.trim());
    if (content) {
      const wrapped = wrapText(content, maxWidth);
      result.push(...wrapped);
    }

    i++;
  }

  return result.join('\n');
}

// ============================================================================
// 内部辅助
// ============================================================================

/** 渲染行内格式：粗体、斜体、行内代码 */
function renderInline(text: string): string {
  // 行内代码 `code`
  text = text.replace(/`([^`]+)`/g, (_, code) => CODE_BG(' ') + CODE_TEXT(code) + CODE_BG(' '));

  // 粗体 **text**
  text = text.replace(/\*\*(.+?)\*\*/g, (_, inner) => BOLD(inner));

  // 斜体 *text*
  text = text.replace(/\*(.+?)\*/g, (_, inner) => ITALIC(inner));

  return text;
}

/** 文本换行 */
function wrapText(text: string, maxWidth: number): string[] {
  if (text.includes('\x1b')) {
    // 包含 ANSI 转义序列，需要特殊处理
    return wrapAnsiText(text, maxWidth);
  }

  if (text.length <= maxWidth) return [text];

  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const testLine = current ? `${current} ${word}` : word;
    if (testLine.length > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = testLine;
    }
  }

  if (current) lines.push(current);
  return lines;
}

/** 换行文本（包含 ANSI 转义序列） */
function wrapAnsiText(text: string, maxWidth: number): string[] {
  const visualLen = text.replace(/\x1b\[[0-9;]*m/g, '').length;
  if (visualLen <= maxWidth) return [text];

  // 简单截断（对于太长的行）
  const lines: string[] = [];
  let current = '';
  let currentVisualLen = 0;
  let openAnsi = '';

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\x1b') {
      // 收集完整的 ANSI 转义序列
      let ansi = '\x1b';
      i++;
      while (i < text.length && text[i] !== 'm') {
        ansi += text[i];
        i++;
      }
      ansi += 'm';
      openAnsi = ansi; // track last open sequence
      current += ansi;
      continue;
    }

    currentVisualLen++;
    current += text[i];

    if (currentVisualLen >= maxWidth) {
      lines.push(current + '\x1b[0m'); // reset before wrapping
      current = openAnsi; // continue with the same color
      currentVisualLen = 0;
    }
  }

  if (current) lines.push(current);
  return lines;
}

/**
 * 去除 Markdown 语法符号（用于 NO_COLOR 模式）
 */
function stripMarkdownSyntax(text: string): string {
  let result = text;

  // 去除标题符号
  result = result.replace(/^#{1,6}\s+/gm, '');

  // 去除粗体和斜体符号
  result = result.replace(/\*\*(.+?)\*\*/g, '$1');
  result = result.replace(/\*(.+?)\*/g, '$1');

  // 去除行内代码符号
  result = result.replace(/`([^`]+)`/g, '$1');

  // 去除链接，保留文本
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 去除引用符号
  result = result.replace(/^>\s+/gm, '');

  // 去除列表符号
  result = result.replace(/^[-*]\s+/gm, '  ');
  result = result.replace(/^\d+\.\s+/gm, '  ');

  // 保留代码块内容但去除 ``` 标记
  result = result.replace(/^```[\w]*\n/gm, '');
  result = result.replace(/^```$/gm, '');

  return result;
}
