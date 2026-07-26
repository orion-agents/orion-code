/**
 * orion code - Harness 安全边界检查
 *
 * 提供细粒度的安全策略、操作白名单/黑名单、危险模式检测、
 * 沙箱隔离建议和安全审计报告。
 */

import { EventEmitter } from 'eventemitter3';

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
    ':\\(\\)\\s*\\{',   // fork bomb
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
    this.policy = { ...DEFAULT_POLICY, ...policy };
    // Pre-compile regex patterns at construction time.
    // Invalid patterns fall back to a never-matching regex.
    this.compiledBlocked = this.policy.blocked.map(p => safeCompileRegex(p));
    this.compiledDangerous = this.policy.dangerousPatterns.map(p => safeCompileRegex(p));
  }

  /**
   * 检查一个操作是否安全
   */
  check(action: string, context?: Record<string, any>): SafetyCheck {
    if (!this.policy.enabled) {
      return { passed: true, level: 'safe' };
    }

    // 1. 检查是否被直接禁止
    const blockedMatch = this.compiledBlocked.find(re =>
      re.test(action),
    );
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
    const dangerousMatch = this.compiledDangerous.find(re =>
      re.test(action),
    );
    if (dangerousMatch) {
      return this.record({
        passed: false,
        level: 'dangerous',
        reason: `Action matches dangerous pattern: ${dangerousMatch}`,
        suggestion: 'Avoid using eval/exec-style operations. Use safe alternatives.',
        action,
      });
    }

    // 3. 检查被禁止的路径
    if (context?.path) {
      const blockedPath = this.policy.blockedPaths.find(bp =>
        (context.path as string).startsWith(bp),
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

    // 4. 检查输出长度
    if (context?.output && typeof context.output === 'string') {
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

    // 5. 检查文件系统操作权限
    if (context?.fsOp && !this.policy.allowedFileSystemOps.includes(context.fsOp as any)) {
      return this.record({
        passed: false,
        level: 'blocked',
        reason: `File system operation "${context.fsOp}" is not allowed`,
        suggestion: `Allowed operations: ${this.policy.allowedFileSystemOps.join(', ')}`,
        action,
      });
    }

    // 6. 检查是否在白名单中
    const actionBase = action.split(' ')[0];
    if (this.policy.allowed[0] !== '*' && !this.policy.allowed.includes(actionBase)) {
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
    this.policy = { ...this.policy, ...patch };
  }

  /**
   * 获取当前策略
   */
  getPolicy(): SafetyPolicy {
    return { ...this.policy };
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
      this.auditLog.shift();  // 移除最旧的条目
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
 * Invalid patterns return a never-matching regex instead of throwing.
 * Patterns longer than 500 chars are rejected to mitigate ReDoS.
 */
function safeCompileRegex(pattern: string): RegExp {
  if (pattern.length > 500) {
    // Overly long pattern — likely malicious or malformed.
    return /^$/; // matches empty string only (effectively never matches actions)
  }
  try {
    return new RegExp(pattern, 'i');
  } catch {
    // Invalid regex syntax — return never-matching pattern.
    return /^$/;
  }
}
