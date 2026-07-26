/**
 * orion code - Team Memory 路径安全
 *
 * v0.1.11: 检测路径遍历攻击，确保 Team Memory 路径安全
 *
 * 检测类型：
 *   - Null byte injection
 *   - Path traversal (..)
 *   - URL-encoded traversal
 *   - Absolute path
 */

// ============================================================================
// Types
// ============================================================================

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathTraversalError';
  }
}

export interface PathSecurityCheckResult {
  safe: boolean;
  sanitizedKey: string;
  violations: string[];
}

// ============================================================================
// Security Checks
// ============================================================================

/**
 * 检查路径安全性并返回安全版本
 * @param key - 输入路径键
 * @returns 安全检查结果
 */
export function sanitizePathKey(key: string): PathSecurityCheckResult {
  const violations: string[] = [];
  let sanitizedKey = key;

  // 1. Null byte injection check
  if (key.includes('\0') || key.includes('%00')) {
    violations.push('Null byte detected');
  }

  // 2. Path traversal check (..)
  if (key.includes('..')) {
    violations.push('Path traversal detected');
  }

  // 3. URL-encoded traversal check
  if (/(%2e%2e|%252e|%e2e)/i.test(key)) {
    violations.push('URL-encoded traversal detected');
  }

  // 4. Absolute path check
  if (key.startsWith('/') || /^[A-Za-z]:/.test(key)) {
    violations.push('Absolute path detected');
  }

  // 5. Backslash traversal (Windows style)
  if (key.includes('..\\') || key.includes('\\..')) {
    violations.push('Backslash path traversal detected');
  }

  // 6. Double slash injection
  if (key.includes('//') || key.includes('\\\\')) {
    violations.push('Double slash detected');
  }

  // 7. Control characters check
  if (/[\x00-\x1f\x7f]/.test(key)) {
    violations.push('Control characters detected');
  }

  // If violations found, don't sanitize - return unsafe
  if (violations.length > 0) {
    return {
      safe: false,
      sanitizedKey: '',
      violations,
    };
  }

  // Sanitize: replace unsafe characters with underscore
  sanitizedKey = key.replace(/[^a-zA-Z0-9_.-]/g, '_');

  // Additional safety: limit length
  if (sanitizedKey.length > 64) {
    sanitizedKey = sanitizedKey.slice(0, 64);
  }

  return {
    safe: true,
    sanitizedKey,
    violations: [],
  };
}

/**
 * 验证路径键并抛出错误（如果不安全）
 * @param key - 输入路径键
 * @returns 安全的路径键
 * @throws PathTraversalError 如果检测到安全问题
 */
export function validateAndSanitizePath(key: string): string {
  const result = sanitizePathKey(key);

  if (!result.safe) {
    throw new PathTraversalError(
      `Path security violation: ${result.violations.join(', ')}`
    );
  }

  return result.sanitizedKey;
}

/**
 * 检查路径是否安全（不抛出错误）
 */
export function isPathSafe(key: string): boolean {
  return sanitizePathKey(key).safe;
}

// ============================================================================
// Path Validation for Team Memory
// ============================================================================

/**
 * 验证 Team Memory 存储路径
 * @param teamId - 团队 ID
 * @param memoryName - 记忆名称
 * @returns 安全的路径组件
 */
export function validateTeamMemoryPath(
  teamId: string,
  memoryName: string
): { safeTeamId: string; safeMemoryName: string } {
  const safeTeamId = validateAndSanitizePath(teamId);
  const safeMemoryName = validateAndSanitizePath(memoryName);

  return { safeTeamId, safeMemoryName };
}

/**
 * 构建安全的 Team Memory 文件路径
 * @param baseDir - 基础目录
 * @param teamId - 团队 ID
 * @param memoryName - 记忆名称
 * @returns 安全的完整路径
 */
export function buildSafeTeamMemoryPath(
  baseDir: string,
  teamId: string,
  memoryName: string
): string {
  const { safeTeamId, safeMemoryName } = validateTeamMemoryPath(teamId, memoryName);

  // 确保基础目录不包含路径遍历
  if (baseDir.includes('..') || baseDir.includes('\0')) {
    throw new PathTraversalError('Base directory contains unsafe characters');
  }

  // 构建路径：baseDir/teamId/memoryName.md
  const parts = [baseDir, safeTeamId, `${safeMemoryName}.md`];

  // 使用简单的路径拼接（避免 join 可能的问题）
  return parts.filter(p => p).join('/');
}

// ============================================================================
// Export
// ============================================================================

export const TEAM_PATH_SECURITY = {
  sanitizePathKey,
  validateAndSanitizePath,
  isPathSafe,
  validateTeamMemoryPath,
  buildSafeTeamMemoryPath,
  PathTraversalError,
};