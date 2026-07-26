/**
 * orion code - MEMORY.md 入口管理
 *
 * v0.1.11: 限制 MEMORY.md 为 200行/25KB，自动截断 + 警告
 *
 * 提供加载、截断、验证功能
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getMemoryDir, MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES, ENTRYPOINT_NAME } from './storage';

// ============================================================================
// Types
// ============================================================================

export interface TruncatedContent {
  content: string;
  originalLines: number;
  originalBytes: number;
  wasLineTruncated: boolean;
  wasByteTruncated: boolean;
  warning?: string;
}

export interface EntrypointValidationResult {
  valid: boolean;
  lines: number;
  bytes: number;
  exceedsLineLimit: boolean;
  exceedsByteLimit: boolean;
  warning?: string;
}

// ============================================================================
// Loading
// ============================================================================

/**
 * 加载 MEMORY.md 内容
 * @param projectPath - 项目路径
 * @returns 文件内容或空字符串
 */
export function loadEntrypoint(projectPath?: string): string {
  const path = join(getMemoryDir(projectPath), ENTRYPOINT_NAME);
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}

/**
 * 加载并解析 MEMORY.md 行数
 */
export function getEntrypointStats(projectPath?: string): { lines: number; bytes: number } {
  const content = loadEntrypoint(projectPath);
  if (!content) return { lines: 0, bytes: 0 };

  const lines = content.split('\n');
  return {
    lines: lines.length,
    bytes: content.length,
  };
}

// ============================================================================
// Truncation
// ============================================================================

/**
 * 截断 MEMORY.md 内容（如果需要）
 * @param content - 原始内容
 * @returns 截断后的内容及元信息
 */
export function truncateIfNeeded(content: string): TruncatedContent {
  if (!content) {
    return {
      content: '',
      originalLines: 0,
      originalBytes: 0,
      wasLineTruncated: false,
      wasByteTruncated: false,
    };
  }

  const lines = content.split('\n');
  const originalLines = lines.length;
  const originalBytes = content.length;

  let wasLineTruncated = false;
  let wasByteTruncated = false;
  let warning: string | undefined;

  // Step 1: 按行数截断
  if (lines.length > MAX_ENTRYPOINT_LINES) {
    lines.splice(MAX_ENTRYPOINT_LINES);
    wasLineTruncated = true;
    warning = `MEMORY.md truncated to ${MAX_ENTRYPOINT_LINES} lines (original: ${originalLines})`;
  }

  // Step 2: 按字节截断
  const currentContent = lines.join('\n');
  if (currentContent.length > MAX_ENTRYPOINT_BYTES) {
    while (lines.join('\n').length > MAX_ENTRYPOINT_BYTES && lines.length > 10) {
      lines.pop();
    }
    wasByteTruncated = true;
    if (!warning) {
      warning = `MEMORY.md truncated to fit ${MAX_ENTRYPOINT_BYTES} bytes limit`;
    } else {
      warning += `, and to fit ${MAX_ENTRYPOINT_BYTES} bytes`;
    }
  }

  // Add truncation warning line if needed
  if (wasLineTruncated || wasByteTruncated) {
    lines.push('');
    lines.push('> WARNING: MEMORY.md truncated. Keep index entries concise (each under ~150 chars).');
  }

  return {
    content: lines.join('\n'),
    originalLines,
    originalBytes,
    wasLineTruncated,
    wasByteTruncated,
    warning,
  };
}

// ============================================================================
// Validation
// ============================================================================

/**
 * 验证 MEMORY.md 是否符合限制
 */
export function validateEntrypoint(projectPath?: string): EntrypointValidationResult {
  const stats = getEntrypointStats(projectPath);

  const exceedsLineLimit = stats.lines > MAX_ENTRYPOINT_LINES;
  const exceedsByteLimit = stats.bytes > MAX_ENTRYPOINT_BYTES;

  let warning: string | undefined;
  if (exceedsLineLimit || exceedsByteLimit) {
    const issues: string[] = [];
    if (exceedsLineLimit) {
      issues.push(`${stats.lines} lines (max: ${MAX_ENTRYPOINT_LINES})`);
    }
    if (exceedsByteLimit) {
      issues.push(`${stats.bytes} bytes (max: ${MAX_ENTRYPOINT_BYTES})`);
    }
    warning = `MEMORY.md exceeds limits: ${issues.join(', ')}`;
  }

  return {
    valid: !exceedsLineLimit && !exceedsByteLimit,
    lines: stats.lines,
    bytes: stats.bytes,
    exceedsLineLimit,
    exceedsByteLimit,
    warning,
  };
}

/**
 * 检查单行是否符合限制（~150 字符）
 */
export function validateLineLength(line: string): { valid: boolean; length: number } {
  const MAX_LINE_CHARS = 150;
  return {
    valid: line.length <= MAX_LINE_CHARS,
    length: line.length,
  };
}

// ============================================================================
// Export Constants
// ============================================================================

export { MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES, ENTRYPOINT_NAME } from './storage';