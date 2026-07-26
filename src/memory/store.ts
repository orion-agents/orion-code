/**
 * orion code - 基础记忆系统（内存版）
 *
 * 提供三层记忆架构：
 *   - 工作记忆 (Working): 当前上下文，容量小，LRU 淘汰
 *   - 短期记忆 (Short-term): 最近历史，容量中等，自动晋升
 *   - 长期记忆 (Long-term): 持久化存储，容量大，支持检索
 *
 * 所有数据保存在内存中，进程重启后丢失。
 * 未来可扩展为文件/数据库后端。
 */

import { EventEmitter } from 'eventemitter3';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// 类型定义
// ============================================================================

/** 记忆条目 */
export interface MemoryEntry {
  /** 唯一标识 */
  id: string;
  /** 内容 */
  content: unknown;
  /** 创建时间戳 */
  createdAt: number;
  /** 最后访问时间戳 */
  lastAccessedAt: number;
  /** 访问次数 */
  accessCount: number;
  /** 标签 */
  tags: string[];
  /** 来源 Agent ID */
  source?: string;
}

/** 记忆层级 */
export type MemoryTier = 'working' | 'short-term' | 'long-term';

/** 记忆配置 */
export interface MemoryStoreConfig {
  /** 工作记忆容量 */
  workingCapacity: number;
  /** 短期记忆容量 */
  shortTermCapacity: number;
  /** 短期记忆淘汰后是否自动晋升到长期 */
  autoPromoteToLongTerm: boolean;
  /** TTL - 工作记忆条目最大存活时间 (ms)，0 表示不限制 */
  workingTTL: number;
}

/** 记忆查询选项 */
export interface MemoryQuery {
  /** 搜索关键词 */
  query?: string;
  /** 标签过滤 */
  tags?: string[];
  /** 来源过滤 */
  source?: string;
  /** 时间范围起点 */
  after?: number;
  /** 时间范围终点 */
  before?: number;
  /** 最大返回数 */
  limit?: number;
}

// ============================================================================
// MemoryStore - 记忆存储
// ============================================================================

export class MemoryStore extends EventEmitter {
  private static readonly MAX_LONG_TERM = 10000;
  private working: MemoryEntry[] = [];
  private shortTerm: MemoryEntry[] = [];
  private longTerm: Map<string, MemoryEntry> = new Map();
  private config: MemoryStoreConfig;

  constructor(config: Partial<MemoryStoreConfig> = {}) {
    super();
    this.config = {
      workingCapacity: config.workingCapacity ?? 10,
      shortTermCapacity: config.shortTermCapacity ?? 100,
      autoPromoteToLongTerm: config.autoPromoteToLongTerm ?? true,
      workingTTL: config.workingTTL ?? 0,
    };
  }

  // ==========================================================================
  // 工作记忆操作
  // ==========================================================================

  /** 写入工作记忆 */
  pushWorking(
    content: unknown,
    options?: { tags?: string[]; source?: string },
  ): MemoryEntry {
    const entry = this.createEntry(content, options);
    this.working.push(entry);
    this.emit('write', { tier: 'working' as MemoryTier, id: entry.id });

    // LRU 淘汰
    this.evictWorking();
    return entry;
  }

  /** 读取工作记忆 */
  readWorking(): MemoryEntry[] {
    this.expireWorking();
    this.touchAll(this.working);
    return [...this.working];
  }

  /** 清空工作记忆 */
  clearWorking(): number {
    const count = this.working.length;
    // 高频访问的晋升到短期
    const important = this.working.filter(e => e.accessCount >= 3);
    important.forEach(e => this.promoteToShortTerm(e));
    this.working = [];
    this.emit('clear', { tier: 'working' as MemoryTier, count });
    return count;
  }

  // ==========================================================================
  // 短期记忆操作
  // ==========================================================================

  /** 写入短期记忆 */
  pushShortTerm(
    content: unknown,
    options?: { tags?: string[]; source?: string },
  ): MemoryEntry {
    const entry = this.createEntry(content, options);
    this.promoteToShortTerm(entry);
    this.emit('write', { tier: 'short-term' as MemoryTier, id: entry.id });
    return entry;
  }

  /** 读取短期记忆 */
  readShortTerm(): MemoryEntry[] {
    this.touchAll(this.shortTerm);
    return [...this.shortTerm];
  }

  // ==========================================================================
  // 长期记忆操作
  // ==========================================================================

  /** 写入长期记忆 */
  pushLongTerm(
    content: unknown,
    options?: { tags?: string[]; source?: string },
  ): MemoryEntry {
    const entry = this.createEntry(content, options);
    this.longTerm.set(entry.id, entry);
    this.emit('write', { tier: 'long-term' as MemoryTier, id: entry.id });
    return entry;
  }

  /** 按 ID 读取长期记忆 */
  readLongTerm(id: string): MemoryEntry | undefined {
    const entry = this.longTerm.get(id);
    if (entry) {
      entry.lastAccessedAt = Date.now();
      entry.accessCount++;
    }
    return entry;
  }

  /** 按 ID 删除长期记忆 */
  deleteLongTerm(id: string): boolean {
    const existed = this.longTerm.delete(id);
    if (existed) {
      this.emit('delete', { id });
    }
    return existed;
  }

  // ==========================================================================
  // 全局检索
  // ==========================================================================

  /** 搜索记忆（全层级） */
  search(query: MemoryQuery, tier?: MemoryTier): MemoryEntry[] {
    const results: MemoryEntry[] = [];
    const lowerQuery = (query.query ?? '').toLowerCase();

    const matches = (entry: MemoryEntry): boolean => {
      if (query.source && entry.source !== query.source) return false;
      if (query.tags?.length && !query.tags.some(t => entry.tags.includes(t))) return false;
      if (query.after && entry.createdAt < query.after) return false;
      if (query.before && entry.createdAt > query.before) return false;
      if (lowerQuery) {
        const contentStr = JSON.stringify(entry.content).toLowerCase();
        const tagsStr = entry.tags.join(' ').toLowerCase();
        if (!contentStr.includes(lowerQuery) && !tagsStr.includes(lowerQuery)) return false;
      }
      return true;
    };

    if (!tier || tier === 'working') {
      this.readWorking().filter(matches).forEach(e => results.push(e));
    }
    if (!tier || tier === 'short-term') {
      this.readShortTerm().filter(matches).forEach(e => results.push(e));
    }
    if (!tier || tier === 'long-term') {
      Array.from(this.longTerm.values()).filter(matches).forEach(e => results.push(e));
    }

    const limit = query.limit ?? results.length;
    return results.slice(0, limit);
  }

  // ==========================================================================
  // 统计与管理
  // ==========================================================================

  /** 获取各层记忆数量 */
  getStats(): Record<MemoryTier, number> {
    return {
      working: this.working.length,
      'short-term': this.shortTerm.length,
      'long-term': this.longTerm.size,
    };
  }

  /** 获取全部记忆条目 */
  getAll(tier?: MemoryTier): MemoryEntry[] {
    const entries: MemoryEntry[] = [];
    if (!tier || tier === 'working') entries.push(...this.readWorking());
    if (!tier || tier === 'short-term') entries.push(...this.readShortTerm());
    if (!tier || tier === 'long-term') entries.push(...Array.from(this.longTerm.values()));
    return entries;
  }

  /** 重置记忆系统 */
  reset(): void {
    this.working = [];
    this.shortTerm = [];
    this.longTerm.clear();
    this.emit('reset');
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  private createEntry(
    content: unknown,
    options?: { tags?: string[]; source?: string },
  ): MemoryEntry {
    const now = Date.now();
    return {
      id: uuidv4(),
      content,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      tags: options?.tags ?? [],
      source: options?.source,
    };
  }

  private evictWorking(): void {
    if (this.working.length <= this.config.workingCapacity) return;

    // 按最后访问时间排序，淘汰最久的
    const toRemove = this.working.length - this.config.workingCapacity;
    const sorted = [...this.working].sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

    for (let i = 0; i < toRemove; i++) {
      const evicted = sorted[i];
      this.working = this.working.filter(e => e.id !== evicted.id);
      this.promoteToShortTerm(evicted);
      this.emit('evict', { from: 'working' as MemoryTier, id: evicted.id });
    }
  }

  private expireWorking(): void {
    if (this.config.workingTTL <= 0) return;
    const cutoff = Date.now() - this.config.workingTTL;
    const expired = this.working.filter(e => e.createdAt < cutoff);
    this.working = this.working.filter(e => e.createdAt >= cutoff);
    expired.forEach(e => {
      this.emit('expire', { id: e.id });
    });
  }

  private promoteToShortTerm(entry: MemoryEntry): void {
    entry.lastAccessedAt = Date.now();
    this.shortTerm.push(entry);

    if (this.shortTerm.length > this.config.shortTermCapacity) {
      const evicted = this.shortTerm.shift();
      if (evicted && this.config.autoPromoteToLongTerm) {
        this.longTerm.set(evicted.id, evicted);
        // Bound long-term memory to prevent unbounded growth.
        if (this.longTerm.size > MemoryStore.MAX_LONG_TERM) {
          const oldest = [...this.longTerm.entries()]
            .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt)
            .shift();
          if (oldest) this.longTerm.delete(oldest[0]);
        }
        this.emit('evict', { from: 'short-term' as MemoryTier, id: evicted.id });
      }
    }
  }

  private touchAll(entries: MemoryEntry[]): void {
    const now = Date.now();
    entries.forEach(e => {
      e.lastAccessedAt = now;
      e.accessCount++;
    });
  }
}
