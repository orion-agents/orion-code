/**
 * orion code - Memory 文件加载
 *
 * Memory 层级：Local > Project > User
 * 后加载覆盖前加载。
 */

import { existsSync, readFileSync } from 'fs';
import { getMemoryPath, MemoryType } from './config-dir';

// ============================================================================
// 类型定义
// ============================================================================

/** Memory 内容 */
export interface MemoryContent {
  /** Memory 类型 */
  type: MemoryType;
  /** 文件路径 */
  path: string;
  /** 内容文本 */
  content: string;
}

// ============================================================================
// 加载 Memory
// ============================================================================

/**
 * 加载单个 Memory 文件
 */
export function loadMemoryFile(type: MemoryType, cwd?: string): MemoryContent | null {
  const path = getMemoryPath(type, cwd);

  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, 'utf-8');
    return { type, path, content };
  } catch {
    return null;
  }
}

/**
 * 加载所有存在的 Memory 文件
 * 按 Local > Project > User 顺序返回
 */
export function loadAllMemory(cwd?: string): MemoryContent[] {
  const types: MemoryType[] = ['Local', 'Project', 'User'];
  const memories: MemoryContent[] = [];

  for (const type of types) {
    const memory = loadMemoryFile(type, cwd);
    if (memory) {
      memories.push(memory);
    }
  }

  return memories;
}

/**
 * 合并所有 Memory 内容
 * Local 覆盖 Project，Project 覆盖 User
 */
export function mergeMemoryContent(cwd?: string): string {
  const memories = loadAllMemory(cwd);
  if (memories.length === 0) {
    return '';
  }

  // 按 Local > Project > User 顺序合并
  // 后面的内容追加到前面
  return memories.map(m => m.content).join('\n\n---\n\n');
}

/**
 * 获取 Memory 摘要（用于显示）
 */
export function getMemorySummary(cwd?: string): string[] {
  const memories = loadAllMemory(cwd);
  return memories.map(m => `${m.type}: ${m.path}`);
}

// ============================================================================
// 系统 Prompt 集成
// ============================================================================

/**
 * 将 Memory 内容附加到系统 Prompt
 */
export function augmentSystemPrompt(basePrompt: string, cwd?: string): string {
  const memoryContent = mergeMemoryContent(cwd);

  if (!memoryContent) {
    return basePrompt;
  }

  return `${basePrompt}

---
# Memory (User Context)

${memoryContent}`;
}