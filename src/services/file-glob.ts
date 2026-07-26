/**
 * orion code - 文件匹配服务
 *
 * 用于 @-提及文件路径补全。
 * 使用 Node.js 内置 fs 模块，无需额外依赖。
 */

import { readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

// ============================================================================
// 类型定义
// ============================================================================

export interface FileMatch {
  path: string;
  isDirectory: boolean;
}

export interface FileMatchOptions {
  limit?: number;
  caseSensitive?: boolean;
}

// ============================================================================
// Gitignore 解析
// ============================================================================

const DEFAULT_IGNORE = ['node_modules', '.git', 'dist', '.DS_Store', '*.log'];

/**
 * 解析 .gitignore 文件
 */
function parseGitignore(cwd: string): string[] {
  const gitignorePath = join(cwd, '.gitignore');
  const patterns: string[] = [...DEFAULT_IGNORE];

  if (existsSync(gitignorePath)) {
    try {
      const content = readFileSync(gitignorePath, 'utf-8');
      const lines = content.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));

      patterns.push(...lines);
    } catch {
      // ignore
    }
  }

  return patterns;
}

/**
 * 检查路径是否被忽略
 */
function isIgnored(path: string, ignorePatterns: string[]): boolean {
  const name = path.split('/').pop() || path;

  for (const pattern of ignorePatterns) {
    if (pattern.startsWith('*.')) {
      const ext = pattern.slice(2);
      if (name.endsWith(ext)) return true;
    } else if (pattern.endsWith('/**')) {
      const base = pattern.slice(0, -3);
      if (path.startsWith(base)) return true;
    } else if (name === pattern) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// 文件匹配
// ============================================================================

/**
 * 匹配文件路径
 * @param query 用户输入的路径查询（@ 后的部分）
 * @param cwd 当前工作目录
 * @returns 匹配的文件列表（默认最多 20 个）
 */
export function matchFiles(query: string, cwd: string, options: FileMatchOptions = {}): FileMatch[] {
  const ignorePatterns = parseGitignore(cwd);
  const results: FileMatch[] = [];
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
    ? Math.floor(options.limit)
    : 20;
  const caseSensitive = options.caseSensitive ?? false;

  try {
    // 解析查询路径
    const parts = query.split('/');
    const dirPath = parts.length > 1 ? join(cwd, parts.slice(0, -1).join('/')) : cwd;
    const filterPrefix = parts.length > 1 ? parts[parts.length - 1] : query;
    const normalizedFilter = caseSensitive ? filterPrefix : filterPrefix.toLowerCase();

    if (!existsSync(dirPath)) {
      return [];
    }

    const entries = readdirSync(dirPath);

    for (const entry of entries) {
      const entryPath = parts.length > 1
        ? parts.slice(0, -1).join('/') + '/' + entry
        : entry;

      // 过滤
      const comparableEntry = caseSensitive ? entry : entry.toLowerCase();
      if (normalizedFilter && !comparableEntry.startsWith(normalizedFilter)) {
        continue;
      }

      // 检查忽略
      if (isIgnored(entryPath, ignorePatterns)) {
        continue;
      }

      // 检查隐藏文件
      if (entry.startsWith('.')) {
        continue;
      }

      const fullPath = join(dirPath, entry);
      const isDirectory = statSync(fullPath).isDirectory();

      results.push({
        path: entryPath,
        isDirectory,
      });

      if (results.length >= limit) {
        break;
      }
    }
  } catch {
    // 目录读取失败
  }

  // 排序：目录优先
  results.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.path.localeCompare(b.path);
  });

  return results;
}

/**
 * 快速匹配顶层路径
 */
export function matchTopLevel(cwd: string): FileMatch[] {
  return matchFiles('', cwd);
}

/**
 * 检查路径是否存在
 */
export function pathExists(path: string, cwd: string): boolean {
  const fullPath = resolve(cwd, path);
  return existsSync(fullPath);
}
