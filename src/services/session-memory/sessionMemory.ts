/**
 * orion code - Session Memory 服务
 *
 * 自动维护会话笔记 SESSION_MEMORY.md 文件。
 * 参考 OpenClaude 的 sessionMemory.ts 实现。
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { Message } from '../llm';


// ============================================================================
// 类型定义
// ============================================================================

export interface SessionMemoryConfig {
  /** 输出文件名 */
  filename?: string;
  /** 最大更新频率（工具调用次数） */
  updateFrequency?: number;
  /** 是否启用 */
  enabled?: boolean;
}

export interface SessionMemoryEntry {
  timestamp: number;
  topic: string;
  actions: string[];
  decisions: string[];
  filesModified: string[];
  openQuestions: string[];
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: SessionMemoryConfig = {
  filename: 'SESSION_MEMORY.md',
  updateFrequency: 5,
  enabled: true,
};

// ============================================================================
// Session Memory 实现
// ============================================================================

export class SessionMemory {
  private config: SessionMemoryConfig;
  private projectPath: string;
  private toolCallCount: number = 0;
  private entries: SessionMemoryEntry[] = [];
  private lastUpdateTime: number = 0;

  constructor(projectPath: string, config?: SessionMemoryConfig) {
    this.projectPath = projectPath;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // 加载现有记忆
    this.load();
  }

  /**
   * 记录工具调用
   */
  recordToolCall(name: string, args: Record<string, unknown>, result: string): void {
    if (!this.config.enabled) return;

    this.toolCallCount++;

    // 提取关键信息
    const entry = this.extractEntry(name, args, result);
    this.entries.push(entry);

    // 检查是否需要更新文件
    if (this.toolCallCount >= this.config.updateFrequency!) {
      this.update();
      this.toolCallCount = 0;
    }
  }

  /**
   * 从消息更新记忆
   */
  updateFromMessages(messages: Message[]): void {
    if (!this.config.enabled) return;

    // 提取最近消息的关键信息
    const recentMessages = messages.slice(-10);
    const entry = this.extractFromMessages(recentMessages);

    if (entry) {
      this.entries.push(entry);
      this.update();
    }
  }

  /**
   * 强制更新
   */
  forceUpdate(): void {
    this.update();
  }

  /**
   * 获取记忆内容
   */
  getContent(): string {
    const filePath = this.getFilePath();
    if (!existsSync(filePath)) {
      return '';
    }
    return readFileSync(filePath, 'utf-8');
  }

  /**
   * 获取最新条目
   */
  getLatestEntries(count: number = 5): SessionMemoryEntry[] {
    return this.entries.slice(-count);
  }

  /**
   * 清除记忆
   */
  clear(): void {
    this.entries = [];
    const filePath = this.getFilePath();
    if (existsSync(filePath)) {
      writeFileSync(filePath, '');
    }
  }

  // ============================================================================
  // 内部方法
  // ============================================================================

  private getFilePath(): string {
    return join(this.projectPath, this.config.filename!);
  }

  private load(): void {
    const filePath = this.getFilePath();
    if (!existsSync(filePath)) {
      return;
    }

    // 解析现有文件（简化：不解析，仅保留）
    // 实际实现应该解析 Markdown 格式
  }

  private update(): void {
    const filePath = this.getFilePath();
    const content = this.generateMarkdown();
    writeFileSync(filePath, content, 'utf-8');
    this.lastUpdateTime = Date.now();
  }

  private generateMarkdown(): string {
    const lines: string[] = [];

    lines.push('# Session Memory');
    lines.push('');
    lines.push(`> Last updated: ${new Date().toISOString()}`);
    lines.push('');

    // 按时间分组
    const recent = this.entries.slice(-20);

    if (recent.length === 0) {
      lines.push('No activities recorded yet.');
      return lines.join('\n');
    }

    // 主题
    const topics = [...new Set(recent.map(e => e.topic).filter(Boolean))];
    if (topics.length > 0) {
      lines.push('## Topics Discussed');
      lines.push('');
      for (const t of topics.slice(0, 5)) {
        lines.push(`- ${t}`);
      }
      lines.push('');
    }

    // 文件修改
    const files = [...new Set(recent.flatMap(e => e.filesModified))];
    if (files.length > 0) {
      lines.push('## Files Modified');
      lines.push('');
      for (const f of files.slice(0, 15)) {
        lines.push(`- ${f}`);
      }
      lines.push('');
    }

    // 决策
    const decisions = recent.flatMap(e => e.decisions).filter(Boolean);
    if (decisions.length > 0) {
      lines.push('## Key Decisions');
      lines.push('');
      for (const d of decisions.slice(0, 5)) {
        lines.push(`- ${d}`);
      }
      lines.push('');
    }

    // 开放问题
    const questions = recent.flatMap(e => e.openQuestions).filter(Boolean);
    if (questions.length > 0) {
      lines.push('## Open Questions');
      lines.push('');
      for (const q of questions.slice(0, 5)) {
        lines.push(`- ${q}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private extractEntry(
    name: string,
    args: Record<string, unknown>,
    _result: string
  ): SessionMemoryEntry {
    const entry: SessionMemoryEntry = {
      timestamp: Date.now(),
      topic: '',
      actions: [name],
      decisions: [],
      filesModified: [],
      openQuestions: [],
    };

    // 提取文件路径
    if (typeof args.path === 'string') {
      entry.filesModified.push(args.path);
    }
    if (typeof args.file_path === 'string') {
      entry.filesModified.push(args.file_path);
    }

    // 提取主题（从 result 或 args）
    if (typeof args.query === 'string') {
      entry.topic = args.query.slice(0, 50);
    }
    if (typeof args.message === 'string') {
      entry.topic = args.message.slice(0, 50);
    }

    return entry;
  }

  private extractFromMessages(messages: Message[]): SessionMemoryEntry | null {
    // 提取最近用户消息作为主题
    const userMsg = messages.filter(m => m.role === 'user').pop();
    if (!userMsg) return null;

    const entry: SessionMemoryEntry = {
      timestamp: Date.now(),
      topic: userMsg.content?.slice(0, 80) || '',
      actions: [],
      decisions: [],
      filesModified: [],
      openQuestions: [],
    };

    // 提取工具调用
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          entry.actions.push(tc.function.name);

          try {
            const args = JSON.parse(tc.function.arguments);
            if (args.path) {
              entry.filesModified.push(args.path);
            }
          } catch {
            // ignore
          }
        }
      }
    }

    return entry;
  }
}

// ============================================================================
// 单例
// ============================================================================

let sessionMemoryInstance: SessionMemory | null = null;

export function getSessionMemory(projectPath?: string, config?: SessionMemoryConfig): SessionMemory {
  if (!sessionMemoryInstance) {
    sessionMemoryInstance = new SessionMemory(projectPath || process.cwd(), config);
  }
  return sessionMemoryInstance;
}

export function resetSessionMemory(): void {
  sessionMemoryInstance = null;
}