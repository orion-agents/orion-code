# Harness 驾驭系统设计

> **Rein 的核心理念：Agent 容易跑偏，所以需要 Harness。**
>
> **版本**: 1.0 (MVP) | **日期**: 2026-05-01 | **作者**: Rein Team

---

## 一、为什么 Agent 需要 Harness？

AI Agent 的核心矛盾：

```
自由度 ████████████████████ 100%  →  Agent 很强，但会跑偏
约束力 ████████░░░░░░░░░░░░  40%  →  Agent 听话，但不好用

Harness 的目标：找到最优平衡点
```

### 问题场景

| 场景 | 无 Harness | 有 Harness |
|------|-----------|-----------|
| 任务执行 | Agent 可能偏离任务方向 | 目标约束确保不跑偏 |
| 文件操作 | 可能写入危险路径 | 边界检查拦截 |
| 命令执行 | 可能执行 `rm -rf /` | 沙箱隔离 + 白名单 |
| 结果交付 | 可能返回半成品 | 结果验证确保完整 |
| 长期运行 | 上下文漂移，行为退化 | 持续约束不漂移 |

### 设计哲学

> **Harness 不是束缚 Agent 的枷锁，而是引导 Agent 的缰绳。**
>
> - 松紧可调：从 `permissive` 到 `strict` 多级约束
> - 透明无感：约束嵌入系统提示，不影响 Agent 体验
> - 分层防御：约束 → 检查 → 验证 → 沙箱，四层递进

---

## 二、Harness 架构

### 2.1 四层防御模型

```
┌───────────────────────────────────────────────────────────┐
│  Layer 1: Goal Constraint (目标约束)                       │
│  "做什么" — 在系统提示中注入任务目标，防止 Agent 偏离方向     │
└────────────────────────┬──────────────────────────────────┘
                         ▼
┌───────────────────────────────────────────────────────────┐
│  Layer 2: Boundary Check (边界检查)                        │
│  "能做什么" — 每次操作前检查是否在允许范围内                │
└────────────────────────┬──────────────────────────────────┘
                         ▼
┌───────────────────────────────────────────────────────────┐
│  Layer 3: Result Validate (结果验证)                       │
│  "做得对不对" — 任务完成后验证结果是否符合预期               │
└────────────────────────┬──────────────────────────────────┘
                         ▼
┌───────────────────────────────────────────────────────────┐
│  Layer 4: Safety Sandbox (安全沙箱)                        │
│  "最坏情况" — 如果前面都失效，沙箱限制爆破半径               │
└───────────────────────────────────────────────────────────┘
```

### 2.2 各层详解

#### Layer 1: Goal Constraint（目标约束）

在 Agent 开始执行前，将任务目标转化为结构化约束注入系统提示。

```typescript
interface GoalConstraint {
  // 任务目标
  objective: string;
  // 必须满足的条件
  requirements: string[];
  // 禁止行为
  prohibitions: string[];
  // 成功标准
  successCriteria: string[];
  // 时间/次数限制
  limits: {
    maxSteps?: number;       // 最大步骤数
    maxTokens?: number;      // 最大 token 消耗
    timeout?: number;        // 超时（毫秒）
  };
}
```

**注入方式**：生成结构化的系统提示片段，追加到 Agent 的系统提示中。

```markdown
## Task Constraints
- Objective: Refactor the authentication module to use JWT
- Must: Update all auth endpoints, add token refresh logic
- Must not: Change the database schema, modify unrelated files
- Success criteria: All existing tests pass, new tests added for refresh logic
- Limits: Max 10 tool calls, max 50K tokens
```

**与 OpenClaw 的对比**：

| 维度 | OpenClaw | Rein Harness |
|------|---------|-------------|
| 约束方式 | SOUL.md + AGENTS.md（静态文件） | 动态注入（每次任务定制） |
| 约束粒度 | Agent 级（全局） | 任务级（精确到单次执行） |
| 约束时效 | 持久（跨会话） | 会话内（任务结束清除） |
| 可组合性 | 低（文件拼接） | 高（结构化组合） |

#### Layer 2: Boundary Check（边界检查）

在 Agent 每次工具调用前进行安全检查。

```typescript
interface BoundaryRule {
  // 允许的文件路径模式
  allowedPaths?: string[];
  // 禁止的文件路径模式
  deniedPaths?: string[];
  // 允许的命令白名单
  allowedCommands?: string[];
  // 禁止的命令黑名单
  deniedCommands?: string[];
  // 网络访问限制
  networkPolicy?: 'none' | 'dns-only' | 'allowlist' | 'full';
  // 环境变量访问
  envAccess?: 'none' | 'readonly' | 'full';
  // 资源限制
  resourceLimits?: {
    maxFileWriteSize?: number;    // 单次写入最大字节
    maxCpuTime?: number;          // CPU 时间上限（秒）
    maxNetworkRequests?: number;  // 网络请求上限
  };
}
```

**检查流程**：

```
工具调用请求
    │
    ▼
┌─────────────┐     NO     ┌─────────────┐
│ 路径检查     │ ─────────▶│  拒绝执行    │
│ (allowed/   │            │  + 日志记录   │
│  denied)    │            └─────────────┘
└──────┬──────┘
       │ YES
       ▼
┌─────────────┐     NO     ┌─────────────┐
│ 命令检查     │ ─────────▶│  拒绝执行    │
│ (白名单/     │            │  + 日志记录   │
│  黑名单)     │            └─────────────┘
└──────┬──────┘
       │ YES
       ▼
┌─────────────┐     NO     ┌─────────────┐
│ 资源检查     │ ─────────▶│  拒绝执行    │
│ (大小/时间/  │            │  + 日志记录   │
│  次数)       │            └─────────────┘
└──────┬──────┘
       │ YES
       ▼
   允许执行
```

**与 OpenClaw 的对比**：

| 维度 | OpenClaw | Rein Harness |
|------|---------|-------------|
| 检查时机 | Gateway 层（工具分发前） | Harness 层（Agent 调用前） |
| 检查粒度 | Agent 级配置 | 任务级配置 + Agent 配置继承 |
| 检查方式 | allow/deny 列表 | allow/deny + 模式匹配 + 资源限制 |
| 反馈机制 | 静默拒绝 | 拒绝 + 结构化错误 + 建议替代方案 |

#### Layer 3: Result Validate（结果验证）

任务执行完成后，验证结果是否符合约束中定义的成功标准。

```typescript
interface ValidationResult {
  passed: boolean;
  checks: {
    name: string;
    passed: boolean;
    details?: string;
  }[];
  errors?: string[];
  suggestions?: string[];  // 如果失败，给出改进建议
}

interface ResultValidator {
  // 验证任务输出是否完整
  validateCompleteness(output: any, criteria: string[]): ValidationResult;
  // 验证文件修改是否符合预期
  validateFileChanges(files: FileChange[], expected: ExpectedChange[]): ValidationResult;
  // 验证命令输出是否合理
  validateCommandOutput(output: string, expected: string[]): ValidationResult;
  // 验证是否有意外副作用
  validateSideEffects(before: Snapshot, after: Snapshot): ValidationResult;
}
```

**验证流程**：

```
任务执行完成
    │
    ▼
┌─────────────────────────────────┐
│ 1. 检查成功标准 (successCriteria) │
│    - 每个标准是否满足？            │
└──────────────────┬──────────────┘
                   │
                   ▼
┌─────────────────────────────────┐
│ 2. 检查禁止行为 (prohibitions)    │
│    - 是否有任何禁止行为发生？      │
└──────────────────┬──────────────┘
                   │
                   ▼
┌─────────────────────────────────┐
│ 3. 检查资源消耗 (limits)          │
│    - 是否超出步骤/token/时间限制？ │
└──────────────────┬──────────────┘
                   │
           ┌───────┴───────┐
           │               │
        PASS           FAIL
           │               │
           ▼               ▼
    返回结果        重试/修正/报告
```

#### Layer 4: Safety Sandbox（安全沙箱）

最底层防御，限制 Agent 操作的实际影响范围。

```typescript
interface SandboxConfig {
  // 沙箱模式
  mode: 'none' | 'permissive' | 'strict';
  // 文件系统
  filesystem: {
    // 允许的工作目录
    allowedRoots: string[];
    // 是否只读
    readOnly: boolean;
    // 临时文件隔离
    tempIsolation: boolean;
  };
  // 网络
  network: {
    // 是否允许网络访问
    enabled: boolean;
    // 允许的目标域名/IP
    allowedTargets?: string[];
  };
  // 进程
  process: {
    // 允许的命令白名单
    allowedCommands: string[];
    // 危险命令黑名单
    deniedCommands: string[];
    // 是否允许管道
    allowPipes: boolean;
    // 是否允许重定向
    allowRedirection: boolean;
  };
}
```

**沙箱模式对比**：

| 模式 | 文件访问 | 网络 | 命令 | 适用场景 |
|------|---------|------|------|---------|
| `none` | 无限制 | 无限制 | 无限制 | 本地开发、信任环境 |
| `permissive` | 工作目录内 | DNS 查询 | 白名单 | 日常使用 |
| `strict` | 只读+临时 | 无 | 最小集 | 公开交互、不可信输入 |

---

## 三、执行流程：pre-check → execute → post-validate

### 3.1 完整流程

```
                         ┌─────────────────────┐
                         │   Task Submitted     │
                         └─────────┬───────────┘
                                   │
                         ┌─────────▼───────────┐
                         │  Brain 决策层         │
                         │  选择 Agent + 路由     │
                         └─────────┬───────────┘
                                   │
                   ┌───────────────▼───────────────┐
                   │   PRE-CHECK (约束+检查)         │
                   │                                │
                   │  1. Goal Constraint 注入        │
                   │  2. Boundary Rule 加载          │
                   │  3. Sandbox 初始化              │
                   │  4. 快照 (Snapshot) 记录        │
                   └───────────────┬───────────────┘
                                   │
                           ┌───────▼───────┐
                           │   EXECUTE      │
                           │   Agent 执行    │
                           │   工具调用...   │
                           └───────┬───────┘
                                   │
                          ┌────────▼────────┐
                          │ POST-VALIDATE    │
                          │                  │
                          │  1. 结果完整性验证 │
                          │  2. 副作用检查    │
                          │  3. 资源消耗检查  │
                          │  4. 快照对比      │
                          └────────┬────────┘
                                   │
                           ┌───────┴───────┐
                           │               │
                        PASS          FAIL
                           │               │
                           ▼               ▼
                   ┌───────────┐   ┌──────────────┐
                   │ 返回结果   │   │ 重试/修正/报告 │
                   │ 清理资源   │   │ 回滚变更      │
                   └───────────┘   └──────────────┘
```

### 3.2 关键设计点

#### Snapshot（快照）

在执行前记录系统状态快照，用于执行后的副作用检测：

```typescript
interface Snapshot {
  // 文件状态
  files: Map<string, { size: number; hash: string; mtime: number }>;
  // 进程状态
  processes: string[];
  // 环境变量
  env: Record<string, string>;
  // 时间戳
  timestamp: number;
}
```

#### 回滚机制

当验证失败时，基于快照回滚变更：

```typescript
interface RollbackManager {
  // 记录变更
  trackChange(type: 'file' | 'env' | 'process', before: any, after: any): void;
  // 回滚所有变更
  rollback(): Promise<void>;
  // 选择性回滚
  rollbackByPattern(pattern: (change: Change) => boolean): Promise<void>;
}
```

---

## 四、与 OpenClaw Gateway 的约束机制对比

| 维度 | OpenClaw Gateway | Rein Harness |
|------|-----------------|-------------|
| **约束注入** | 静态文件 (SOUL.md, AGENTS.md) | 动态结构化约束 (GoalConstraint) |
| **任务感知** | 无（Agent 级全局约束） | 有（任务级精确约束） |
| **边界检查** | Gateway 层工具分发控制 | 多层级（路径+命令+资源） |
| **结果验证** | 无（依赖模型自行判断） | 结构化验证（Criteria + SideEffect） |
| **状态快照** | 无 | 有（执行前后快照对比） |
| **回滚机制** | 无 | 有（基于快照的变更回滚） |
| **沙箱粒度** | Docker/SSH 完整隔离 | 轻量级（MVP）→ Docker（后续） |
| **约束配置** | JSON 配置文件 | TypeScript 接口 + 配置文件 |
| **可组合性** | 低（文件拼接） | 高（约束对象组合） |
| **执行流程** | 单步（直接执行） | 三阶段（pre-check → execute → post-validate） |

### 核心优势总结

1. **任务级精度**：OpenClaw 是 Agent 级约束（全局），Rein 是任务级约束（精确到单次执行）
2. **闭环验证**：OpenClaw 只有执行前检查，Rein 增加执行后验证，形成闭环
3. **状态可追溯**：快照 + 回滚机制确保变更可逆
4. **可组合**：约束对象可以按需组合，不依赖文件拼接

---

## 五、MVP 实现计划

| 阶段 | 功能 | 优先级 |
|------|------|--------|
| **MVP** | Goal Constraint 注入 | P0 |
| **MVP** | Boundary Check（路径+命令） | P0 |
| **MVP** | 简单结果验证（Completeness） | P1 |
| **MVP** | Sandbox（none/permissive） | P1 |
| **后续** | 完整结果验证（SideEffect + Snapshot） | P1 |
| **后续** | Docker 沙箱后端 | P2 |
| **后续** | 回滚机制 | P2 |
| **后续** | 约束模板系统 | P2 |

---

*文档版本：v1.0 | 创建日期：2026-05-01 | 维护者：Rein Team*
