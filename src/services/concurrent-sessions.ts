/**
 * orion code - Concurrent Sessions
 *
 * 管理多个并发 CLI 会话，防止冲突。
 */

import { writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getCacheDir, ensureConfigDir } from './config-dir';

// ============================================================================
// 类型定义
// ============================================================================

export interface SessionInfo {
  /** 会话 ID */
  id: string;
  /** PID */
  pid: number;
  /** 启动时间 */
  startedAt: number;
  /** 工作目录 */
  cwd: string;
  /** 模型名称 */
  model?: string;
  /** 最后活动时间 */
  lastActivity: number;
  /** 状态 */
  status: 'active' | 'idle' | 'terminated';
}

export interface SessionManagerConfig {
  /** 最大会话数 */
  maxSessions: number;
  /** 会话超时时间 (ms) */
  sessionTimeout: number;
  /** 心跳间隔 (ms) */
  heartbeatInterval: number;
}

// ============================================================================
// Session Manager
// ============================================================================

export class SessionManager {
  private sessionId: string;
  private sessionPath: string;
  private config: SessionManagerConfig;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<SessionManagerConfig>) {
    this.config = {
      maxSessions: config?.maxSessions || 10,
      sessionTimeout: config?.sessionTimeout || 24 * 60 * 60 * 1000, // 24h
      heartbeatInterval: config?.heartbeatInterval || 60000, // 1min
    };

    ensureConfigDir();
    this.sessionId = this.generateSessionId();
    this.sessionPath = join(getCacheDir(), 'active-sessions');
    this.ensureSessionDir();
  }

  /**
   * 生成会话 ID
   */
  private generateSessionId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 6);
    return `${timestamp}-${random}`;
  }

  /**
   * 确保会话目录存在
   */
  private ensureSessionDir(): void {
    if (!existsSync(this.sessionPath)) {
      mkdirSync(this.sessionPath, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * 注册当前会话
   */
  register(options?: { model?: string }): SessionInfo {
    const session: SessionInfo = {
      id: this.sessionId,
      pid: process.pid,
      startedAt: Date.now(),
      cwd: process.cwd(),
      model: options?.model,
      lastActivity: Date.now(),
      status: 'active',
    };

    const filePath = this.getSessionFilePath(this.sessionId);
    writeFileSync(filePath, JSON.stringify(session, null, 2), { mode: 0o600 });

    // 启动心跳
    this.startHeartbeat();

    return session;
  }

  /**
   * 更新会话活动
   */
  updateActivity(): void {
    const filePath = this.getSessionFilePath(this.sessionId);
    if (!existsSync(filePath)) return;

    try {
      const content = readFileSync(filePath, 'utf-8');
      const session = JSON.parse(content) as SessionInfo;
      session.lastActivity = Date.now();
      session.status = 'active';
      writeFileSync(filePath, JSON.stringify(session, null, 2));
    } catch {
      // 忽略错误
    }
  }

  /**
   * 标记会话为空闲
   */
  setIdle(): void {
    const filePath = this.getSessionFilePath(this.sessionId);
    if (!existsSync(filePath)) return;

    try {
      const content = readFileSync(filePath, 'utf-8');
      const session = JSON.parse(content) as SessionInfo;
      session.status = 'idle';
      writeFileSync(filePath, JSON.stringify(session, null, 2));
    } catch {
      // 忽略错误
    }
  }

  /**
   * 结束会话
   */
  terminate(): void {
    this.stopHeartbeat();

    const filePath = this.getSessionFilePath(this.sessionId);
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
      } catch {
        // 忽略错误
      }
    }
  }

  /**
   * 获取所有活跃会话
   */
  getActiveSessions(): SessionInfo[] {
    const sessions: SessionInfo[] = [];
    const sessionsDir = this.sessionPath;

    if (!existsSync(sessionsDir)) {
      return sessions;
    }

    try {
      const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));

      for (const file of files) {
        const filePath = join(sessionsDir, file);
        try {
          const content = readFileSync(filePath, 'utf-8');
          const session = JSON.parse(content) as SessionInfo;

          // 检查是否过期
          if (Date.now() - session.lastActivity > this.config.sessionTimeout) {
            // 清理过期会话
            unlinkSync(filePath);
            continue;
          }

          // 检查进程是否存活
          if (!this.isProcessAlive(session.pid)) {
            unlinkSync(filePath);
            continue;
          }

          sessions.push(session);
        } catch {
          // 忽略解析错误
        }
      }
    } catch {
      // 忽略目录读取错误
    }

    return sessions;
  }

  /**
   * 获取当前会话 ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * 检查是否可以启动新会话
   */
  canStartNewSession(): boolean {
    const activeSessions = this.getActiveSessions();
    return activeSessions.length < this.config.maxSessions;
  }

  /**
   * 检查进程是否存活
   */
  private isProcessAlive(pid: number): boolean {
    try {
      // 发送信号 0 检查进程是否存在
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取会话文件路径
   */
  private getSessionFilePath(sessionId: string): string {
    return join(this.sessionPath, `${sessionId}.json`);
  }

  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.updateActivity();
    }, this.config.heartbeatInterval);
    if (this.heartbeatTimer && typeof (this.heartbeatTimer as any).unref === 'function') {
      (this.heartbeatTimer as any).unref();
    }
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 清理所有过期会话
   */
  cleanup(): number {
    let cleaned = 0;
    const sessionsDir = this.sessionPath;

    if (!existsSync(sessionsDir)) {
      return cleaned;
    }

    try {
      const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));

      for (const file of files) {
        const filePath = join(sessionsDir, file);
        try {
          const content = readFileSync(filePath, 'utf-8');
          const session = JSON.parse(content) as SessionInfo;

          // 检查是否过期
          const isExpired = Date.now() - session.lastActivity > this.config.sessionTimeout;
          const isDead = !this.isProcessAlive(session.pid);

          if (isExpired || isDead) {
            unlinkSync(filePath);
            cleaned++;
          }
        } catch {
          // 解析失败也清理
          try {
            unlinkSync(filePath);
            cleaned++;
          } catch {
            // 忽略
          }
        }
      }
    } catch {
      // 忽略目录读取错误
    }

    return cleaned;
  }
}

// ============================================================================
// 单例
// ============================================================================

let sessionManager: SessionManager | null = null;

export function getSessionManager(config?: Partial<SessionManagerConfig>): SessionManager {
  if (!sessionManager) {
    sessionManager = new SessionManager(config);
  }
  return sessionManager;
}

export function resetSessionManager(): void {
  if (sessionManager) {
    sessionManager.terminate();
  }
  sessionManager = null;
}
