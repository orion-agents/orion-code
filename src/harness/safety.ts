/**
 * orion code - Harness 安全边界检查
 *
 * 提供细粒度的安全策略、操作白名单/黑名单、危险模式检测、
 * 沙箱隔离建议和安全审计报告。
 */

import { EventEmitter } from 'eventemitter3';
import { existsSync, realpathSync } from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';

// ============================================================================
// 类型定义
// ============================================================================

/** 安全级别 */
export type SecurityLevel = 'safe' | 'warning' | 'dangerous' | 'blocked';

/** 安全检查结果 */
export interface SafetyCheck {
  /** 是否通过 */
  passed: boolean;
  /** 安全级别 */
  level: SecurityLevel;
  /** 原因 */
  reason?: string;
  /** 建议操作 */
  suggestion?: string;
}

export interface SafetyContext {
  path?: unknown;
  cwd?: unknown;
  output?: unknown;
  fsOp?: unknown;
  networkOp?: unknown;
  url?: unknown;
  /** True only when the downstream executor has actually applied isolation. */
  sandboxed?: unknown;
}

/** 安全策略配置 */
export interface SafetyPolicy {
  /** 是否启用安全检查 */
  enabled: boolean;
  /** 允许的操作 */
  allowed: string[];
  /** 禁止的操作（正则） */
  blocked: string[];
  /** 危险模式（正则） */
  dangerousPatterns: string[];
  /** 最大输出长度 */
  maxOutputLength: number;
  /** 是否启用沙箱模式 */
  sandboxMode: boolean;
  /** 允许的文件系统操作 */
  allowedFileSystemOps: ('read' | 'write' | 'delete' | 'execute')[];
  /** 禁止访问的路径 */
  blockedPaths: string[];
  /** 允许的网络操作 */
  allowedNetworkOps: ('http' | 'https' | 'ws' | 'wss')[];
}

/** 审计日志条目 */
export interface AuditLogEntry {
  timestamp: number;
  action: string;
  level: SecurityLevel;
  passed: boolean;
  reason?: string;
}

// ============================================================================
// 默认策略
// ============================================================================

const DEFAULT_POLICY: SafetyPolicy = {
  enabled: true,
  allowed: ['read', 'write', 'execute', 'network', 'git', 'npm', 'build'],
  blocked: [
    'rm\\s+-rf\\s+/',
    'mkfs',
    'dd\\s+of=/dev',
    ':\\(\\)\\s*\\{', // fork bomb
    'chmod\\s+777',
  ],
  dangerousPatterns: [
    'eval\\s*\\(',
    'exec\\s*\\(',
    'require\\s*\\(\\s*[\'"]child_process',
    'process\\.exit',
    'process\\.kill',
  ],
  maxOutputLength: 100000,
  sandboxMode: false,
  allowedFileSystemOps: ['read', 'write'],
  blockedPaths: ['/etc/shadow', '/etc/passwd', '/proc/'],
  allowedNetworkOps: ['https'],
};

// ============================================================================
// Constants - Issue #32 #3.1: auditLog 上限
// ============================================================================

const MAX_AUDIT_LOG_ENTRIES = 1000;

function cloneSafetyPolicy(policy: SafetyPolicy): SafetyPolicy {
  return {
    ...policy,
    allowed: [...policy.allowed],
    blocked: [...policy.blocked],
    dangerousPatterns: [...policy.dangerousPatterns],
    allowedFileSystemOps: [...policy.allowedFileSystemOps],
    blockedPaths: [...policy.blockedPaths],
    allowedNetworkOps: [...policy.allowedNetworkOps],
  };
}

// ============================================================================
// SafetyChecker - 安全边界检查器
// ============================================================================

export class SafetyChecker extends EventEmitter {
  private policy: SafetyPolicy;
  private auditLog: AuditLogEntry[] = [];
  private compiledBlocked: RegExp[] = [];
  private compiledDangerous: RegExp[] = [];

  constructor(policy: Partial<SafetyPolicy> = {}) {
    super();
    this.policy = cloneSafetyPolicy({ ...DEFAULT_POLICY, ...policy });
    // Invalid policy patterns match everything so malformed policy fails closed.
    this.compiledBlocked = this.policy.blocked.map(p => safeCompileRegex(p));
    this.compiledDangerous = this.policy.dangerousPatterns.map(p => safeCompileRegex(p));
  }

  /**
   * 检查一个操作是否安全
   */
  check(action: string, context: SafetyContext = {}): SafetyCheck {
    if (!this.policy.enabled) {
      return { passed: true, level: 'safe' };
    }

    // 1. 检查是否被直接禁止
    const blockedMatch = this.compiledBlocked.find(re => re.test(action));
    if (blockedMatch) {
      return this.record({
        passed: false,
        level: 'blocked',
        reason: `Action matches blocked pattern`,
        suggestion: 'This action is explicitly forbidden by safety policy.',
        action,
      });
    }

    // 2. 检查危险模式
    const dangerousMatch = this.compiledDangerous.find(re => re.test(action));
    if (dangerousMatch) {
      return this.record({
        passed: false,
        level: 'dangerous',
        reason: `Action matches dangerous pattern: ${dangerousMatch}`,
        suggestion: 'Avoid using eval/exec-style operations. Use safe alternatives.',
        action,
      });
    }

    // 3. sandboxMode 必须由实际执行器证明已应用，不能只显示为 on。
    if (this.policy.sandboxMode && context.sandboxed !== true) {
      return this.record({
        passed: false,
        level: 'blocked',
        reason: 'Sandbox mode is required but no active sandbox was confirmed',
        suggestion: 'Run this operation through an executor that reports sandboxed=true.',
        action,
      });
    }

    // 4. 规范化路径并按路径段比较，避免 `..`/`.`/symlink 绕过和前缀误报。
    if (context.path !== undefined) {
      if (typeof context.path !== 'string' || context.path.trim() === '') {
        return this.record({
          passed: false,
          level: 'blocked',
          reason: 'Path safety check failed: path must be a non-empty string',
          action,
        });
      }
      const cwd = typeof context.cwd === 'string' ? context.cwd : process.cwd();
      const targetPath = canonicalPath(context.path, cwd);
      const blockedPath = this.policy.blockedPaths.find(bp =>
        isPathContained(canonicalPath(bp, cwd), targetPath)
      );
      if (blockedPath) {
        return this.record({
          passed: false,
          level: 'blocked',
          reason: `Access to blocked path: ${blockedPath}`,
          suggestion: 'Do not access system-critical paths.',
          action,
        });
      }
    }

    // 5. 检查输出长度
    if (context.output && typeof context.output === 'string') {
      if (context.output.length > this.policy.maxOutputLength) {
        return this.record({
          passed: false,
          level: 'warning',
          reason: `Output exceeds max length (${context.output.length} > ${this.policy.maxOutputLength})`,
          suggestion: 'Truncate or paginate large outputs.',
          action,
        });
      }
    }

    // 6. 检查文件系统操作权限
    if (
      context.fsOp !== undefined &&
      !this.policy.allowedFileSystemOps.includes(
        context.fsOp as SafetyPolicy['allowedFileSystemOps'][number]
      )
    ) {
      return this.record({
        passed: false,
        level: 'blocked',
        reason: `File system operation "${context.fsOp}" is not allowed`,
        suggestion: `Allowed operations: ${this.policy.allowedFileSystemOps.join(', ')}`,
        action,
      });
    }

    // 7. 网络操作必须完整解析协议；无法解析时 fail closed。
    const actionBase = action.split(' ')[0];
    const networkRequested =
      actionBase === 'network' ||
      context.networkOp !== undefined ||
      context.url !== undefined ||
      /\b(?:https?|wss?):\/\//i.test(action);
    if (networkRequested) {
      const networkOp = resolveNetworkOp(action, context);
      if (!networkOp || !this.policy.allowedNetworkOps.includes(networkOp)) {
        return this.record({
          passed: false,
          level: 'blocked',
          reason: networkOp
            ? `Network operation "${networkOp}" is not allowed`
            : 'Network operation could not be parsed safely',
          suggestion: `Allowed network operations: ${this.policy.allowedNetworkOps.join(', ')}`,
          action,
        });
      }
    }

    // 8. 通配符在 allowlist 任意位置均生效。
    if (!this.policy.allowed.includes('*') && !this.policy.allowed.includes(actionBase)) {
      return this.record({
        passed: true,
        level: 'warning',
        reason: `Action "${actionBase}" not in whitelist`,
        suggestion: 'Consider adding this action to the allowed list if it is safe.',
        action,
      });
    }

    return this.record({ passed: true, level: 'safe', action });
  }

  /**
   * 批量检查一组操作
   */
  checkBatch(actions: string[]): SafetyCheck[] {
    return actions.map(action => this.check(action));
  }

  /**
   * 获取审计日志
   */
  getAuditLog(limit = 50): AuditLogEntry[] {
    return this.auditLog.slice(-limit);
  }

  /**
   * 获取审计摘要
   */
  getAuditSummary(): { total: number; passed: number; failed: number; blocked: number } {
    return {
      total: this.auditLog.length,
      passed: this.auditLog.filter(e => e.passed).length,
      failed: this.auditLog.filter(e => !e.passed && e.level !== 'blocked').length,
      blocked: this.auditLog.filter(e => e.level === 'blocked').length,
    };
  }

  /**
   * 更新策略
   */
  updatePolicy(patch: Partial<SafetyPolicy>): void {
    const nextPolicy = cloneSafetyPolicy({ ...this.policy, ...patch });
    const nextBlocked = nextPolicy.blocked.map(pattern => safeCompileRegex(pattern));
    const nextDangerous = nextPolicy.dangerousPatterns.map(pattern => safeCompileRegex(pattern));

    this.policy = nextPolicy;
    this.compiledBlocked = nextBlocked;
    this.compiledDangerous = nextDangerous;
  }

  /**
   * 获取当前策略
   */
  getPolicy(): SafetyPolicy {
    return cloneSafetyPolicy(this.policy);
  }

  /**
   * 清除审计日志
   */
  clearAuditLog(): void {
    this.auditLog = [];
  }

  // ---- Internal ----

  private record(check: SafetyCheck & { action: string }): SafetyCheck {
    // Issue #32 #3.1: 添加 auditLog 上限
    if (this.auditLog.length >= MAX_AUDIT_LOG_ENTRIES) {
      this.auditLog.shift(); // 移除最旧的条目
    }

    this.auditLog.push({
      timestamp: Date.now(),
      action: check.action,
      level: check.level,
      passed: check.passed,
      reason: check.reason,
    });

    this.emit('check', check);
    return check;
  }
}

/**
 * Safely compile a user-provided regex pattern.
 * Invalid patterns match every action (fail closed) instead of throwing.
 * Patterns longer than 500 chars are rejected to mitigate ReDoS.
 */
function safeCompileRegex(pattern: string): RegExp {
  if (pattern.length > 500) {
    // Overly long pattern — likely malicious or malformed.
    return /[\s\S]*/;
  }
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return /[\s\S]*/;
  }
}

function canonicalPath(input: string, cwd: string): string {
  const absolute = resolve(cwd, input);
  if (existsSync(absolute)) {
    try {
      return realpathSync.native(absolute);
    } catch {
      return absolute;
    }
  }

  // Resolve the nearest existing ancestor so non-existent children below a symlink
  // receive the same containment decision.
  const suffix: string[] = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return absolute;
    suffix.unshift(relative(parent, cursor));
    cursor = parent;
  }
  try {
    return resolve(realpathSync.native(cursor), ...suffix);
  } catch {
    return absolute;
  }
}

function isPathContained(parent: string, target: string): boolean {
  const rel = relative(parent, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function asNetworkOp(value: unknown): SafetyPolicy['allowedNetworkOps'][number] | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/:$/, '');
  return ['http', 'https', 'ws', 'wss'].includes(normalized)
    ? normalized as SafetyPolicy['allowedNetworkOps'][number]
    : undefined;
}

function resolveNetworkOp(
  action: string,
  context: SafetyContext
): SafetyPolicy['allowedNetworkOps'][number] | undefined {
  const explicit = asNetworkOp(context.networkOp);
  if (explicit) return explicit;

  const candidate = typeof context.url === 'string'
    ? context.url
    : action.match(/\b(?:https?|wss?):\/\/[^\s]+/i)?.[0];
  if (!candidate) return undefined;
  try {
    return asNetworkOp(new URL(candidate).protocol);
  } catch {
    return undefined;
  }
}
