# 记忆系统设计

> **记忆是 Agent 持续学习和改进的基础。**
>
> **版本**: 1.0 (MVP) | **日期**: 2026-05-01 | **作者**: Rein Team

---

## 一、三层记忆架构

参考 OpenClaw 的 builtin memory + Honcho + Hermes 的 MemoryManager 设计，Rein 采用三层记忆架构：

```
┌─────────────────────────────────────────────────────────────────┐
│                    Memory Manager (记忆管理器)                     │
│  统一接口 │ 数据流协调 │ 淘汰策略 │ 检索优化                        │
└────────────────────────┬────────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
┌───────▼──────┐ ┌──────▼───────┐ ┌───────▼───────┐
│  Working     │ │ Short-term   │ │ Long-term     │
│  Memory      │ │ Memory       │ │ Memory        │
│              │ │              │ │               │
│  当前任务     │ │ 近期会话     │ │ 持久知识       │
│  上下文       │ │ 记忆        │ │ 记忆          │
│              │ │              │ │               │
│  存储: 内存   │ │ 存储: JSONL  │ │ 存储: SQLite  │
│  TTL: 任务级  │ │ TTL: 24h    │ │ TTL: 永久     │
│  大小: <100KB │ │ 大小: <10MB  │ │ 大小: 无限     │
└──────────────┘ └──────────────┘ └───────────────┘
```

### 1.1 Working Memory（工作记忆）

当前任务的实时上下文，Agent 的"短期注意力"。

```typescript
interface WorkingMemory {
  // 当前任务信息
  task: {
    id: string;
    objective: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    createdAt: number;
  };
  // 最近的操作记录
  actions: Action[];
  // 工具调用结果
  toolResults: ToolResult[];
  // 当前上下文摘要
  contextSummary?: string;
}

interface Action {
  type: 'tool_call' | 'model_response' | 'user_input' | 'system_event';
  content: string;
  timestamp: number;
  // 是否需要保留到短期记忆
  persist: boolean;
}
```

**特点**：
- 存储位置：内存（Map/对象）
- 生命周期：任务级（任务结束自动清理）
- 大小限制：默认 < 100KB
- 淘汰策略：超出容量时丢弃最旧的非关键操作

### 1.2 Short-term Memory（短期记忆）

近期会话的历史记录，支持跨任务的上下文恢复。

```typescript
interface ShortTermMemory {
  // 会话记录列表
  sessions: SessionRecord[];
  // 按时间索引
  byTime: Map<number, string>;  // timestamp → sessionId
  // 按标签索引
  byTag: Map<string, Set<string>>;  // tag → sessionIds
}

interface SessionRecord {
  id: string;
  agentId: string;
  messages: Message[];
  tags: string[];
  summary?: string;       // 自动生成的会话摘要
  createdAt: number;
  lastAccessedAt: number;
}

interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  // 重要性评分 (0-1)
  importance: number;
}
```

**特点**：
- 存储位置：JSONL 文件（`~/.rein/memory/sessions/`）
- 生命周期：24 小时默认（可配置）
- 大小限制：单文件 < 10MB
- 淘汰策略：
  1. 超时的会话自动归档
  2. 低重要性评分的会话优先淘汰
  3. 超过容量时压缩（摘要化）

### 1.3 Long-term Memory（长期记忆）

持久化的知识存储，支持语义搜索和跨会话召回。

```typescript
interface LongTermMemory {
  // 记忆条目
  entries: MemoryEntry[];
  // 向量索引
  vectorIndex: VectorIndex;
  // 全文索引
  fullTextIndex: FullTextIndex;
}

interface MemoryEntry {
  id: string;
  content: string;           // 记忆内容
  embedding?: number[];      // 向量嵌入
  metadata: {
    source: 'conversation' | 'user' | 'derived' | 'skill';
    tags: string[];
    importance: number;      // 0-1, 决定保留优先级
    createdAt: number;
    lastAccessedAt: number;
    accessCount: number;
  };
}
```

**特点**：
- 存储位置：SQLite + sqlite-vec 扩展
- 生命周期：永久（除非手动删除或低重要性淘汰）
- 索引方式：
  - **向量索引**：语义搜索（嵌入向量）
  - **全文索引**：关键词搜索（FTS5）
  - **混合搜索**：结合两者最佳结果
- 淘汰策略：
  1. 低重要性 + 长期未访问 → 自动归档
  2. 存储空间限制 → 淘汰最低重要性条目

---

## 二、记忆管理器（Memory Manager）

参考 Hermes 的 MemoryManager 设计，统一协调三层记忆。

```typescript
class MemoryManager {
  // 三层记忆存储
  private working: WorkingMemoryStore;
  private shortTerm: ShortTermMemoryStore;
  private longTerm: LongTermMemoryStore;

  // 写入流程
  async write(message: Message, context: TaskContext): Promise<void> {
    // 1. 写入工作记忆（实时）
    await this.working.append(message);

    // 2. 判断是否需要持久化到短期记忆
    if (this.shouldPersist(message, context)) {
      await this.shortTerm.append(message, context);
    }

    // 3. 判断是否需要提取为长期记忆
    if (this.shouldExtract(message, context)) {
      await this.extractToLongTerm(message, context);
    }
  }

  // 读取流程（召回）
  async recall(query: string, options?: RecallOptions): Promise<MemoryResult> {
    const results = {
      working: await this.working.search(query, options),
      shortTerm: await this.shortTerm.search(query, options),
      longTerm: await this.longTerm.search(query, options),
    };
    return this.rerank(results, options);
  }

  // 记忆整理
  async consolidate(): Promise<void> {
    // 1. 将工作记忆中需要保留的内容迁移到短期记忆
    await this.working.flush();
    // 2. 压缩短期记忆中的过期内容
    await this.shortTerm.compress();
    // 3. 整理长期记忆的向量索引
    await this.longTerm.reindex();
  }
}
```

### 2.1 数据流

```
                    用户输入 / Agent 输出
                          │
                          ▼
              ┌───────────────────────┐
              │   Working Memory       │
              │   (实时写入)            │
              └───────────┬───────────┘
                          │
                  shouldPersist?
                  /              \
                YES              NO
                /                  \
    ┌───────────▼───────────┐    丢弃（任务结束）
    │   Short-term Memory    │
    │   (JSONL 文件)         │
    └───────────┬───────────┘
                │
        shouldExtract?
        /              \
      YES              NO
      /                  \
┌─────▼─────┐        保留在短期记忆中
│Long-term   │        (24h 后过期)
│Memory       │
│(SQLite+向量) │
└────────────┘
```

### 2.2 淘汰策略

| 层级 | 触发条件 | 动作 | 可恢复性 |
|------|---------|------|---------|
| **Working** | 任务结束 | 清除所有 | ❌ 不可恢复 |
| **Working→Short-term** | `shouldPersist` 为 true | 迁移 | ✅ 短期记忆可查 |
| **Short-term** | 超时 (24h) | 归档或删除 | ⚠️ 取决于配置 |
| **Short-term→Long-term** | `shouldExtract` 为 true | 提取关键内容 | ✅ 长期记忆可查 |
| **Long-term** | 低重要性 + 未访问 | 归档 | ✅ 可恢复 |

### 2.3 检索策略

```
查询请求
    │
    ▼
┌──────────────────────────┐
│ 混合检索                  │
│                          │
│  1. 向量搜索 (语义匹配)    │
│  2. 全文搜索 (关键词匹配)  │
│  3. 混合排序 (RRF)        │
│  4. 时间衰减加权           │
└──────────────────────────┘
    │
    ▼
返回 Top-K 结果
```

**RRF (Reciprocal Rank Fusion)**：结合向量搜索和全文搜索的结果排名，避免单一检索偏差。

```
score = Σ (1 / (k + rank_i))
其中 k = 60 (常数), rank_i = 在第 i 种检索中的排名
```

---

## 三、与 OpenClaw / Hermes 的对比

### 3.1 OpenClaw Memory 机制

OpenClaw 的记忆系统由三个部分组成：

| 组件 | 存储 | 特点 |
|------|------|------|
| **Workspace 文件** | Markdown (MEMORY.md, memory/) | 手动维护，Agent 读写 |
| **Builtin Memory** | SQLite + FTS5 + 向量 | 自动索引，支持混合搜索 |
| **Honcho (插件)** | 独立服务 | 跨会话，自动用户建模 |

### 3.2 Hermes Memory 机制

Hermes 的记忆系统采用 Provider 模式：

| 组件 | 存储 | 特点 |
|------|------|------|
| **Builtin Provider** | 本地文件 + SQLite | 内置，始终可用 |
| **Plugin Provider** | 外部服务 | 最多一个外部插件 |
| **Memory Manager** | 编排层 | 统一接口，多 Provider 协调 |

### 3.3 Rein 记忆系统对比

| 维度 | OpenClaw | Hermes | Rein |
|------|---------|--------|------|
| 记忆层级 | 文件 + SQLite + Honcho | 内置 + 插件 | 三层 (工作/短期/长期) |
| 工作记忆 | 无独立概念 | Context Engine | 独立层级（内存） |
| 短期记忆 | Session transcripts | 会话历史 | JSONL + 自动摘要 |
| 长期记忆 | MEMORY.md + 向量索引 | Builtin memory | SQLite + 向量 + 全文 |
| 写入策略 | Agent 主动写入 | Provider 同步 | 自动分级写入 |
| 读取策略 | 混合搜索 | Prefetch + Tool | 混合检索 + RRF |
| 淘汰策略 | Session pruning | 手动 | 自动分层淘汰 |
| 用户建模 | Honcho 插件 | Honcho 集成 | 内置（MVP 后） |
| 跨会话 | Honcho 自动 | Provider 同步 | Short-term + Long-term |

### 3.4 核心差异

1. **显式三层架构**：OpenClaw 和 Hermes 都没有显式的 Working Memory 概念，Rein 将工作记忆作为第一层，确保任务上下文高效管理。

2. **自动分级写入**：OpenClaw 依赖 Agent 主动写入 MEMORY.md，Rein 根据重要性自动决定记忆层级，减少 Agent 负担。

3. **可恢复淘汰**：Rein 的淘汰策略设计为可恢复的（归档而非删除），与 OpenClaw 的 session pruning（不可逆删除）不同。

4. **混合检索 RRF**：引入 RRF 算法结合多路检索结果，比单一检索更稳定。

---

## 四、MVP 实现计划

| 阶段 | 功能 | 优先级 |
|------|------|--------|
| **MVP** | Working Memory（内存存储） | P0 |
| **MVP** | Short-term Memory（JSONL 文件） | P0 |
| **MVP** | 基础写入流程 | P0 |
| **MVP** | 简单关键词搜索 | P0 |
| **MVP** | 超时淘汰 | P1 |
| **后续** | Long-term Memory（SQLite + 向量） | P1 |
| **后续** | 混合检索（向量 + 全文 + RRF） | P1 |
| **后续** | 自动摘要生成 | P1 |
| **后续** | 重要性评分模型 | P2 |
| **后续** | 用户建模 | P2 |
| **后续** | 跨会话知识提取 | P2 |

---

## 五、存储结构

```
~/.rein/
├── memory/
│   ├── working/
│   │   └── <taskId>.json        # 当前任务工作记忆
│   ├── sessions/
│   │   ├── 2026-05-01.jsonl     # 当日会话记录
│   │   └── 2026-05-02.jsonl
│   └── longterm/
│       └── memories.sqlite      # 长期记忆 SQLite 数据库
└── config.json                  # 记忆配置
```

---

*文档版本：v1.0 | 创建日期：2026-05-01 | 维护者：Rein Team*
