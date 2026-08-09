/**
 * orion code - Concurrent Sessions
 *
 * 管理多个并发 CLI 会话，防止冲突。
 */

import { writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { atomicWriteFileSync } from './atomic-write';
import { getCacheDir, ensureConfigDir } from './config-dir';
import { debugError } from '../utils/debug-log';
import { withFileLockSync } from './file-lock';

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
    // randomUUID is collision-resistant across processes and time, unlike the
    // previous Date.now()+random scheme that collided within the same
    // millisecond and let one process overwrite another's session file.
    return randomUUID();
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

    // The registry sentinel serializes the complete slot reservation across
    // processes. Keeping live-session reaping, maxSessions enforcement, and
    // the exclusive session-file create in one critical section prevents two
    // simultaneous CLI launches from both observing the same free slot.
    withFileLockSync(join(this.sessionPath, '.registry'), () => {
      if (!this.canStartNewSession()) {
        throw new Error(
          `Cannot start new session: the concurrent session limit (${this.config.maxSessions}) has been reached.`
        );
      }

      // Exclusive-create so a (now statistically impossible) ID collision
      // fails loudly instead of overwriting another process's session file.
      this.writeSessionFileExclusive(session);
    });

    // 启动心跳
    this.startHeartbeat();

    return session;
  }

  /**
   * 以排他方式写入会话文件；若 ID 冲突（EEXIST）则重新生成并重试。
   */
  private writeSessionFileExclusive(session: SessionInfo): void {
    const MAX_RETRIES = 3;
    let targetPath = this.getSessionFilePath(this.sessionId);
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        session.id = this.sessionId;
        writeFileSync(targetPath, JSON.stringify(session, null, 2), {
          mode: 0o600,
          flag: 'wx',
        });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          // Statistically near-impossible with randomUUID, but regenerate and
          // retry rather than clobbering the existing session.
          this.sessionId = this.generateSessionId();
          targetPath = this.getSessionFilePath(this.sessionId);
          continue;
        }
        throw error;
      }
    }
    throw new Error(
      `Failed to create exclusive session file after ${MAX_RETRIES} attempts: ${targetPath}`
    );
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
      // Atomic replacement prevents another process from observing a
      // truncated heartbeat record and under-counting active sessions.
      atomicWriteFileSync(filePath, JSON.stringify(session, null, 2), { mode: 0o600 });
    } catch (error) {
      // A failed heartbeat makes this session look dead to every other
      // process, so it eventually gets reaped. Keep going, but record why.
      debugError('concurrent-sessions.updateActivity', error, filePath);
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
      atomicWriteFileSync(filePath, JSON.stringify(session, null, 2), { mode: 0o600 });
    } catch (error) {
      // The session stays marked 'active' and keeps occupying a slot.
      debugError('concurrent-sessions.setIdle', error, filePath);
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
      } catch (error) {
        // Leaves a stale session file behind; `cleanup()` reaps it later.
        debugError('concurrent-sessions.terminate', error, filePath);
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
        } catch (error) {
          // Corrupt record: skip this session rather than failing the listing.
          debugError('concurrent-sessions.parseSession', error, filePath);
        }
      }
    } catch (error) {
      // An unreadable directory must NOT be reported as "no active sessions":
      // that silently disables the concurrency limit and lets maxSessions be
      // bypassed. Fail closed so the caller (e.g. register -> canStartNewSession)
      // refuses to start rather than assuming the slot is free.
      debugError('concurrent-sessions.listSessions', error, sessionsDir);
      throw error;
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
    } catch (error) {
      // Intentional liveness probe: throwing *is* the "process is gone"
      // answer (ESRCH). EPERM means the process exists but cannot be signalled.
      return (error as NodeJS.ErrnoException).code === 'EPERM';
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
    // `unref()` exists on Node's Timeout but not on the browser timer id that
    // `setInterval` yields under a DOM lib, so probe for it instead of assuming.
    const timer: { unref?: () => void } | null = this.heartbeatTimer;
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
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
        } catch (parseError) {
          // 解析失败也清理
          debugError('concurrent-sessions.cleanupParse', parseError, filePath);
          try {
            unlinkSync(filePath);
            cleaned++;
          } catch (unlinkError) {
            // The corrupt file survives and will be retried next cleanup.
            debugError('concurrent-sessions.cleanupUnlink', unlinkError, filePath);
          }
        }
      }
    } catch (error) {
      // Cleanup silently does nothing, so stale sessions accumulate.
      debugError('concurrent-sessions.cleanup', error, sessionsDir);
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
