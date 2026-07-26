/**
 * orion code - 流式 Markdown 渲染器
 *
 * 支持流式渲染：标题、粗体、斜体、行内代码、列表、引用、链接、分割线、代码块
 */

import chalk from 'chalk';

const CODE_BG = chalk.bgHex('#1E293B');
const CODE_TEXT = chalk.hex('#E2E8F0');
const DIM = chalk.dim;
const BOLD = chalk.bold;
const CYAN = chalk.cyan;
const GREEN = chalk.green;
const MAGENTA = chalk.magenta;

/**
 * 去除 ANSI 颜色码
 */

// ============================================================================
// 类型定义
// ============================================================================

export interface StreamRendererState {
  inCodeBlock: boolean;
  codeBlockLang: string;
  codeBlockBuffer: string;
  pendingInline: string;
}

// ============================================================================
// 流式渲染器
// ============================================================================

export class StreamMarkdownRenderer {
  private state: StreamRendererState = {
    inCodeBlock: false,
    codeBlockLang: '',
    codeBlockBuffer: '',
    pendingInline: '',
  };

  /**
   * 输入 chunk，返回渲染后的 ANSI 字符串
   */
  feed(chunk: string): string {
    if (!chunk) return '';

    if (!this.state.inCodeBlock) {
      const codeStart = chunk.indexOf('```');
      if (codeStart >= 0) {
        // 先渲染代码块前的内容
        const before = chunk.slice(0, codeStart);
        const after = chunk.slice(codeStart);
        const langMatch = after.match(/```(\w+)?/);
        this.state.codeBlockLang = langMatch?.[1] || '';
        this.state.inCodeBlock = true;
        this.state.codeBlockBuffer = '';

        const langDisplay = this.state.codeBlockLang ? ` ${this.state.codeBlockLang}` : '';
        return this.renderInlineBuffer(before) + '\n' + DIM(`┌─${langDisplay}`) + '\n';
      }

      // 非代码块：积累内容，遇到换行时渲染
      this.state.pendingInline += chunk;
      return this.consumePending();
    }

    // === 代码块内 ===
    const codeEnd = chunk.indexOf('```');
    if (codeEnd >= 0) {
      const codeContent = chunk.slice(0, codeEnd);
      const after = chunk.slice(codeEnd + 3);
      const fullCode = this.state.codeBlockBuffer + codeContent;
      const lines = fullCode.split('\n');

      let output = '';
      for (const line of lines) {
        if (line.trim()) {
          output += CODE_BG(' ') + CODE_TEXT(line) + '\n';
        }
      }
      output += DIM('└──') + '\n';

      this.state.inCodeBlock = false;
      this.state.codeBlockLang = '';
      this.state.codeBlockBuffer = '';

      return output + after;
    }

    this.state.codeBlockBuffer += chunk;

    // 输出已完成的行
    const lines = this.state.codeBlockBuffer.split('\n');
    if (lines.length > 1) {
      let output = '';
      for (let i = 0; i < lines.length - 1; i++) {
        output += CODE_BG(' ') + CODE_TEXT(lines[i]) + '\n';
      }
      this.state.codeBlockBuffer = lines[lines.length - 1];
      return output;
    }

    return '';
  }

  /**
   * 消耗 pendingInline 中已完成的部分
   */
  private consumePending(): string {
    let output = '';
    const nlIndex = this.state.pendingInline.lastIndexOf('\n');
    if (nlIndex === -1) return '';

    // 保留最后一个 \n（可能后面还有内容）
    const complete = this.state.pendingInline.slice(0, nlIndex);
    this.state.pendingInline = this.state.pendingInline.slice(nlIndex);

    const lines = complete.split('\n');
    for (const line of lines) {
      if (line === '') continue;
      output += this.renderLine(line) + '\n';
    }

    return output;
  }

  /**
   * 渲染一段文本的 Markdown 元素
   */
  private renderInlineBuffer(text: string): string {
    if (!text) return '';

    const lines = text.split('\n');
    const output: string[] = [];

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (line === '' && li < lines.length - 1) {
        output.push('');
        continue;
      }
      output.push(this.renderLine(line));
    }

    return output.join('\n');
  }

  /**
   * 渲染单行 Markdown
   */
  private renderLine(line: string): string {
    // Horizontal rule
    if (/^(-{3,}|[*]{3,})$/.test(line.trim())) {
      return DIM('─'.repeat(Math.min(line.length, 60)));
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const styled = this.renderInline(text);
      if (level <= 2) return '\n' + BOLD(CYAN(styled));
      if (level <= 4) return '\n' + BOLD(GREEN(styled));
      return '\n' + MAGENTA(styled);
    }

    // Blockquote
    if (line.startsWith('> ')) {
      return DIM('│ ') + this.renderInline(line.slice(2));
    }
    if (line.startsWith('>')) {
      return DIM('│ ') + this.renderInline(line.slice(1).trim());
    }

    // Unordered list
    const listMatch = line.match(/^(\s*)([-*+])\s+(.*)$/);
    if (listMatch) {
      return listMatch[1] + CYAN('• ') + this.renderInline(listMatch[3]);
    }

    // Ordered list
    const orderedMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (orderedMatch) {
      return orderedMatch[1] + CYAN(orderedMatch[2] + '.') + ' ' + this.renderInline(orderedMatch[3]);
    }

    return this.renderInline(line);
  }

  /**
   * 渲染 inline Markdown 元素
   */
  private renderInline(text: string): string {
    // Inline code: `code`
    text = text.replace(/`([^`]+)`/g, (_m, code) => CODE_BG(' ') + CODE_TEXT(code));

    // Bold: **text** or __text__
    text = text.replace(/\*\*(.+?)\*\*/g, (_m, b) => BOLD(b));
    text = text.replace(/__(.+?)__/g, (_m, b) => BOLD(b));

    // Italic: *text* or _text_
    text = text.replace(/\*(.+?)\*/g, (_m, i) => chalk.italic(i));
    text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, (_m, i) => chalk.italic(i));

    // Links: [text](url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, lt, url) => {
      return BOLD(CYAN(lt)) + DIM(` (${url})`);
    });

    return text;
  }

  /**
   * 结束时输出剩余内容
   */
  flush(): string {
    let output = '';

    if (this.state.inCodeBlock && this.state.codeBlockBuffer) {
      const lines = this.state.codeBlockBuffer.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          output += CODE_BG(' ') + CODE_TEXT(line) + '\n';
        }
      }
      output += DIM('└── (incomplete)') + '\n';
    }

    if (this.state.pendingInline) {
      output += this.renderInlineBuffer(this.state.pendingInline);
      this.state.pendingInline = '';
    }

    return output;
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.state = {
      inCodeBlock: false,
      codeBlockLang: '',
      codeBlockBuffer: '',
      pendingInline: '',
    };
  }
}

/**
 * 创建流式渲染器
 */
export function createStreamRenderer(): StreamMarkdownRenderer {
  return new StreamMarkdownRenderer();
}
