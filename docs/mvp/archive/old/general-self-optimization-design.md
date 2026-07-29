# 自我优化系统设计

> **Agent 的持续进化能力：从纠正中学习、自我反思、模式识别。**
>
> **版本**: 1.0 | **日期**: 2026-05-02 | **作者**: Linux2010

---

## 一、设计理念

### 1.1 核心原则

参考 ClawHub 下载量第一的 Self-Improving + Proactive Agent 技能（@ivangdavila，2000+ 下载），OpenHorse 的自我优化系统遵循三大核心原则：

| 原则 | 说明 | 实现方式 |
|------|------|---------|
| **Learn from Corrections** | 从用户纠正中学习，避免重复错误 | 显式纠正信号 → 记忆记录 → 行为调整 |
| **Self-Reflection** | 任务完成后自我反思，发现改进空间 | 工作总结 → 反思触发 → 建议生成 |
| **Pattern Recognition** | 识别重复模式，自动提取最佳实践 | 3 次重复 → 模式提取 → 规则固化 |

### 1.2 与 Harness 的关系

```
┌─────────────────────────────────────────────────────────────┐
│                     Harness 驾驭层                            │
│  目标约束 │ 边界检查 │ 结果验证 │ 安全沙箱                      │
│                                                             │
│  【硬约束】不可逾越的安全边界，由系统强制执行                    │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                   Self-Optimization 自我优化层                │
│  学习信号 │ 记忆升降级 │ 模式提取 │ 反思触发                    │
│                                                             │
│  【软规则】渐进式优化建议，可被用户覆盖或忽略                    │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                      Brain 决策层                             │
│  任务分解 │ 优先级 │ 路由 │ 状态管理                            │
│                                                             │
│  【执行层】综合 Harness 约束 + Self-Optimization 建议执行任务  │
└─────────────────────────────────────────────────────────────┘
```

**边界定义**：

| 层级 | 类型 | 可否覆盖 | 示例 |
|------|------|---------|------|
| **Harness** | 硬约束 | ❌ 不可 | 禁止执行 `rm -rf /` |
| **Self-Optimization** | 软规则 | ✅ 可 | "优先使用 async/await" |
| **User Override** | 用户指令 | ✅ 最高 | "这次用 Promise" |

**安全边界**：自我优化学习结果不能覆盖 Harness 硬约束。例如：
- 学习到"用户偏好简洁代码" → 可以应用
- 学习到"用户允许删除任意文件" → ❌ 被 Harness 边界检查拦截

### 1.3 设计哲学

| 原则 | 说明 |
|------|------|
| **渐进式** | 学习规则从观察 → 建议 → 固化，循序渐进 |
| **可追溯** | 每条规则有明确的来源（纠正/偏好/模式/反思） |
| **可回滚** | 学习结果可撤销，支持"忘记"命令 |
| **透明** | 每次引用学习结果时注明来源 |

---

## 二、三层记忆架构

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    Self-Optimization Memory                   │
│                                                             │
│  HOT (memory.md)      ≤100 行，始终加载                       │
│  WARM (projects/)     ≤200 行/文件，按上下文加载               │
│  COLD (archive/)      归档，显式查询加载                       │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 HOT Memory（热记忆）

**文件**：`memory.md`（位于项目根目录）

**特点**：
- ≤100 行，始终加载到上下文
- 存放高频使用、经过验证的规则
- 类似 CPU L1 缓存，快速访问

**内容格式**：

```markdown
# OpenHorse Memory Index

## User Preferences
- [Preference: terse responses](user/terse.md) — avoid trailing summaries

## Project Context
- [Project: React migration](project/react-migration.md) — migrating to React 18

## Domain Knowledge
- [Domain: TypeScript](domain/typescript.md) — type safety patterns
```

### 2.3 WARM Memory（温记忆）

**目录结构**：

```
memory/
├── user/           # 用户偏好
│   ├── terse.md    # 响应风格偏好
│   └── testing.md  # 测试偏好
├── project/        # 项目上下文
│   ├── react-migration.md
│   └── api-design.md
├── domain/         # 领域知识
│   ├── typescript.md
│   └── react.md
└── feedback/       # 反馈记录
    ├── no-mock-db.md
    └── prefer-bundle.md
```

**特点**：
- ≤200 行/文件
- 按上下文加载（检测到 React 相关任务 → 加载 domain/react.md）
- 类似 CPU L2 缓存，按需访问

### 2.4 COLD Memory（冷记忆）

**目录结构**：

```
memory/
├── archive/        # 归档记忆
│   ├── 2025-01/    # 按月份归档
│   │   ├── old-project.md
│   │   └── deprecated-rule.md
│   └── 2025-02/
└── cold/           # 长期存储
    ├── historical-patterns.md
    └── obsolete-feedback.md
```

**特点**：
- 显式查询加载（用户问"以前怎么处理的"）
- 类似磁盘存储，容量大但访问慢
- 永不删除，只归档

### 2.5 文件结构图

```
~/.openhorse/
├── memory/
│   ├── memory.md              # HOT memory（索引文件）
│   ├── user/                  # WARM: 用户偏好
│   ├── project/               # WARM: 项目上下文
│   ├── domain/                # WARM: 领域知识
│   ├── feedback/              # WARM: 反馈记录
│   ├── archive/               # COLD: 按时间归档
│   └── cold/                  # COLD: 长期存储
└── config/
    └── self-optimization.json  # 自我优化配置
```

---

## 三、学习信号与触发器

### 3.1 学习信号类型

| 信号类型 | 触发条件 | 权重 | 示例 |
|---------|---------|------|------|
| **Explicit Correction** | 用户明确纠正 | ⭐⭐⭐⭐⭐ | "不要用 mock，用真实数据库" |
| **Explicit Preference** | 用户明确偏好 | ⭐⭐⭐⭐ | "我喜欢简洁的响应" |
| **Repeat Pattern** | 3 次重复行为 | ⭐⭐⭐ | 连续 3 次使用 async/await |
| **Self-Reflection** | 任务完成反思 | ⭐⭐ | "这次可以更快" |

### 3.2 学习信号检测

```typescript
interface LearningSignal {
  type: 'correction' | 'preference' | 'pattern' | 'reflection';
  source: 'user' | 'agent' | 'system';
  content: string;
  context: TaskContext;
  weight: number;  // 1-5
  timestamp: number;
}

interface SignalDetector {
  // 检测用户纠正信号
  detectCorrection(userInput: string): LearningSignal | null;

  // 检测用户偏好信号
  detectPreference(userInput: string): LearningSignal | null;

  // 检测重复模式信号
  detectPattern(actionHistory: Action[]): LearningSignal | null;

  // 触发自我反思信号
  triggerReflection(taskResult: TaskResult): LearningSignal | null;
}
```

### 3.3 触发条件详解

#### Explicit Corrections（显式纠正）

**触发关键词**：
- "不"、"不要"、"不对"、"错了"
- "应该是"、"改为"、"换成"
- "不要这样"、"这样不对"

**处理流程**：

```
用户输入包含纠正关键词
    │
    ▼
┌─────────────────────┐
│ 提取纠正内容          │
│ "不要用 mock DB" →   │
│ rule: "用真实 DB"     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 创建 feedback 记忆    │
│ 文件: feedback/      │
│ no-mock-db.md        │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 更新 memory.md 索引   │
│ 添加指向新文件        │
└─────────────────────┘
```

#### Explicit Preferences（显式偏好）

**触发关键词**：
- "我喜欢"、"我希望"、"请"
- "以后"、"每次"、"总是"
- "风格"、"方式"、"习惯"

**处理流程**：与纠正类似，但权重略低。

#### Repeat Pattern（重复模式）

**触发条件**：同一行为连续出现 3 次。

**检测逻辑**：

```typescript
function detectPattern(history: Action[]): LearningSignal | null {
  // 检测连续 3 次相同模式
  const recent = history.slice(-10);

  for (let i = 0; i < recent.length - 2; i++) {
    if (isSamePattern(recent[i], recent[i+1], recent[i+2])) {
      return {
        type: 'pattern',
        source: 'system',
        content: extractPattern(recent[i]),
        weight: 3,
        timestamp: Date.now()
      };
    }
  }
  return null;
}
```

#### Self-Reflection（自我反思）

**触发时机**：任务完成后，Brain 主动触发反思。

**反思内容**：
- 任务执行效率分析
- 可能的改进建议
- 发现的新模式

---

## 四、自动升降级机制

### 4.1 升降级规则

| 触发 | 动作 | 条件 |
|------|------|------|
| **新学习** | 创建 WARM 记忆 | 初次学习信号 |
| **3 次成功应用** | 升级到 HOT | 连续 3 次成功引用 |
| **7 天未用** | 降级到 WARM | HOT 记忆未被引用 |
| **30 天未用** | 降级到 COLD | WARM 记忆未被引用 |
| **90 天未用** | 归档 | COLD 记忆未被引用 |
| **用户请求** | 删除/忘记 | 用户明确"忘记 X" |

**注意**：永不自动删除，只归档。归档记忆可恢复。

### 4.2 状态转换图

```
                    ┌─────────────┐
                    │  NEW 学习    │
                    └─────────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │  WARM (温记忆)          │
              │  新规则初始位置          │
              └───────────┬───────────┘
                          │
            ┌─────────────┴─────────────┐
            │                           │
     3 次成功应用                    30 天未用
            │                           │
            ▼                           ▼
┌─────────────────────┐       ┌─────────────────────┐
│  HOT (热记忆)         │       │  COLD (冷记忆)        │
│  高频使用规则          │       │  归档存储             │
│  ≤100 行              │       │  显式查询加载         │
└──────────┬──────────┘       └──────────┬──────────┘
           │                             │
     7 天未用                        90 天未用
           │                             │
           ▼                             ▼
┌─────────────────────┐       ┌─────────────────────┐
│  降级到 WARM          │       │  归档 (archive)       │
└─────────────────────┘       │  永不删除             │
                              │  可恢复               │
                              └─────────────────────┘
```

### 4.3 升降级实现

```typescript
interface MemoryPromoter {
  // 检查并执行升降级
  async reviewAndPromote(): Promise<void>;

  // 升级：WARM → HOT
  async promoteToHot(memoryFile: MemoryFile): Promise<void>;

  // 降级：HOT → WARM
  async demoteToWarm(memoryFile: MemoryFile): Promise<void>;

  // 降级：WARM → COLD
  async demoteToCold(memoryFile: MemoryFile): Promise<void>;

  // 归档：COLD → archive
  async archive(memoryFile: MemoryFile): Promise<void>;
}

class MemoryPromoterImpl implements MemoryPromoter {
  async reviewAndPromote(): Promise<void> {
    const now = Date.now();

    // 1. 检查 HOT 记忆，7 天未用降级
    for (const hot of this.hotMemories) {
      if (now - hot.lastAccessed > 7 * DAY) {
        await this.demoteToWarm(hot);
      }
    }

    // 2. 检查 WARM 记忆，30 天未用降级
    for (const warm of this.warmMemories) {
      if (now - warm.lastAccessed > 30 * DAY) {
        await this.demoteToCold(warm);
      }
    }

    // 3. 检查 COLD 记忆，90 天未用归档
    for (const cold of this.coldMemories) {
      if (now - cold.lastAccessed > 90 * DAY) {
        await this.archive(cold);
      }
    }

    // 4. 检查 WARM 记忆，3 次成功应用升级
    for (const warm of this.warmMemories) {
      if (warm.successCount >= 3) {
        await this.promoteToHot(warm);
      }
    }
  }
}
```

---

## 五、与 Harness 的集成

### 5.1 Harness 事件驱动学习

Harness 的四层防御产生事件，Self-Optimization 监听并学习：

| Harness 事件 | 学习机会 |
|-------------|---------|
| **Boundary Check 拒绝** | 学习"避免该操作" |
| **Result Validate 失败** | 学习"改进方法" |
| **Sandbox 限制触发** | 学习"安全边界意识" |
| **用户覆盖 Harness** | 学习"用户例外情况" |

### 5.2 学习结果注入 Harness

Self-Optimization 的学习结果可以增强 Harness：

```typescript
interface HarnessIntegration {
  // 学习结果注入 preCheck
  async injectPreCheck(learning: Learning): Promise<void>;

  // 学习结果注入 postValidate
  async injectPostValidate(learning: Learning): Promise<void>;

  // 检查学习是否违反 Harness 约束
  async validateLearningSafety(learning: Learning): Promise<boolean>;
}
```

**注入示例**：

```
学习: "用户偏好使用真实数据库测试"

注入 preCheck:
- 添加建议: "检测到测试任务，建议使用真实数据库（基于用户偏好）"

注入 postValidate:
- 添加验证: "检查是否使用了 mock，如有则提示用户偏好"
```

### 5.3 安全边界

**学习结果不能覆盖 Harness 约束**：

```typescript
async validateLearningSafety(learning: Learning): Promise<boolean> {
  // 1. 检查学习内容是否涉及危险操作
  if (this.containsDangerousOperation(learning.content)) {
    return false;  // 拒绝学习
  }

  // 2. 检查学习是否试图绕过 Harness
  if (this.attemptsBypassHarness(learning.content)) {
    return false;  // 拒绝学习
  }

  // 3. 检查学习是否与现有 Harness 约束冲突
  if (this.conflictsWithHarness(learning.content)) {
    // 降级为"建议"而非"规则"
    learning.weight = 1;
  }

  return true;
}
```

---

## 六、冲突解决规则

### 6.1 优先级层级

```
┌─────────────────────────────────────┐
│  Level 1: 用户当前指令（最高）         │
│  "这次用 Promise" — 立即生效          │
└──────────────────┬──────────────────┘
                   │
┌──────────────────▼──────────────────┐
│  Level 2: 项目级记忆                  │
│  project/react-migration.md          │
└──────────────────┬──────────────────┘
                   │
┌──────────────────▼──────────────────┐
│  Level 3: 领域级记忆                  │
│  domain/typescript.md                │
└──────────────────┬──────────────────┘
                   │
┌──────────────────▼──────────────────┐
│  Level 4: 全局级记忆（最低）           │
│  user/terse.md                       │
└─────────────────────────────────────┘
```

### 6.2 冲突解决规则

| 规则 | 说明 | 示例 |
|------|------|------|
| **项目 > 领域 > 全局** | 更具体的规则优先 | 项目规则覆盖全局规则 |
| **新 > 旧（同级别）** | 最新学习优先 | 新偏好覆盖旧偏好 |
| **纠正 > 偏好 > 模式** | 权重高的优先 | 纠正覆盖模式 |
| **模糊时问用户** | 无法确定时询问 | "发现冲突，请确认" |

### 6.3 冲突检测与解决

```typescript
interface ConflictResolver {
  // 检测冲突
  detectConflict(memories: MemoryFile[]): Conflict | null;

  // 解决冲突
  resolveConflict(conflict: Conflict): Resolution;
}

interface Conflict {
  memories: MemoryFile[];
  type: 'same-level' | 'cross-level';
  description: string;
}

interface Resolution {
  action: 'apply-higher' | 'apply-newer' | 'ask-user';
  winner?: MemoryFile;
  question?: string;
}
```

---

## 七、压缩与维护策略

### 7.1 文件超限处理

| 超限类型 | 处理方式 |
|---------|---------|
| **HOT > 100 行** | 合并相似规则、降级低频规则 |
| **WARM > 200 行** | 拆分文件、提取摘要、降级冷门规则 |
| **COLD 空间不足** | 归档到压缩文件 |

### 7.2 心跳驱动的定期维护

```typescript
interface MaintenanceScheduler {
  // 每日心跳：检查升降级
  async dailyHeartbeat(): Promise<void>;

  // 每周心跳：压缩与合并
  async weeklyHeartbeat(): Promise<void>;

  // 每月心跳：归档清理
  async monthlyHeartbeat(): Promise<void>;
}
```

**心跳触发**：
- Agent 启动时触发日常心跳
- 用户请求时触发即时检查
- 定时任务触发周期维护

### 7.3 透明操作

每次引用记忆时注明来源：

```markdown
应用规则：使用真实数据库测试
来源：[feedback/no-mock-db.md](memory/feedback/no-mock-db.md)
原因：用户纠正（2026-05-01）
```

---

## 八、API 设计

### 8.1 SelfOptimizer 接口

```typescript
interface SelfOptimizer {
  // 从执行结果学习
  learnFromOutcome(result: TaskResult, context: TaskContext): Promise<Learning | null>;

  // 应用学习结果
  applyLearnings(context: TaskContext): Promise<AppliedLearning[]>;

  // 定期审查与压缩
  reviewAndCompact(): Promise<MaintenanceResult>;

  // 用户请求：忘记
  forget(pattern: string): Promise<void>;

  // 用户请求：回忆
  recall(query: string): Promise<MemorySearchResult>;
}
```

### 8.2 learnFromOutcome()

```typescript
async learnFromOutcome(
  result: TaskResult,
  context: TaskContext
): Promise<Learning | null> {
  // 1. 检测学习信号
  const signals = this.detectSignals(result, context);

  // 2. 合并相同信号
  const merged = this.mergeSignals(signals);

  // 3. 验证学习安全性
  if (!await this.validateSafety(merged)) {
    return null;
  }

  // 4. 创建记忆文件
  const memory = await this.createMemory(merged);

  // 5. 更新索引
  await this.updateIndex(memory);

  return merged;
}
```

### 8.3 applyLearnings()

```typescript
async applyLearnings(
  context: TaskContext
): Promise<AppliedLearning[]> {
  // 1. 加载 HOT 记忆（始终加载）
  const hotMemories = await this.loadHotMemories();

  // 2. 按上下文加载 WARM 记忆
  const warmMemories = await this.loadWarmMemories(context);

  // 3. 解决冲突
  const resolved = await this.resolveConflicts([...hotMemories, ...warmMemories]);

  // 4. 注入到上下文
  await this.injectToContext(resolved);

  // 5. 更新访问时间
  await this.updateAccessTime(resolved);

  return resolved;
}
```

### 8.4 reviewAndCompact()

```typescript
async reviewAndCompact(): Promise<MaintenanceResult> {
  const result = {
    promoted: [],
    demoted: [],
    archived: [],
    merged: [],
  };

  // 1. 执行升降级
  await this.reviewAndPromote(result);

  // 2. 压缩超限文件
  await this.compressOverflow(result);

  // 3. 合并相似规则
  await this.mergeSimilar(result);

  // 4. 归档过期记忆
  await this.archiveExpired(result);

  return result;
}
```

---

## 九、实施计划

### 9.1 Phase 2.5: 基础记录

**目标**：建立最简学习记录机制。

| 功能 | 说明 |
|------|------|
| `learnings.md` | 单文件学习记录 |
| 纠正信号检测 | 检测关键词，记录纠正 |
| 基础索引 | memory.md 累引文件 |
| 手动忘记 | `/forget` 命令 |

**时间**：Phase 2.5（2 周）

### 9.2 Phase 3: 完整三层记忆 + 自动升降级

**目标**：完整记忆架构。

| 功能 | 说明 |
|------|------|
| HOT/WARM/COLD 目录 | 三层记忆结构 |
| 自动升降级 | 3 次成功升级，7/30/90 天降级 |
| 上下文加载 | 检测任务类型，按需加载 WARM |
| 冲突解决 | 优先级层级，解决规则冲突 |

**时间**：Phase 3（4 周）

### 9.3 Phase 4: Harness 集成 + 自我反思

**目标**：与 Harness 深度集成。

| 功能 | 说明 |
|------|------|
| Harness 事件监听 | 学习 Harness 拒绝/失败事件 |
| 学习注入 Harness | preCheck/postValidate 注入学习结果 |
| 自我反思触发 | 任务完成后主动反思 |
| 安全边界检查 | 学习不能覆盖 Harness 约束 |

**时间**：Phase 4（3 周）

### 9.4 Phase 5: 跨任务泛化 + 技能进化

**目标**：高级学习能力。

| 功能 | 说明 |
|------|------|
| 跨任务泛化 | 从单一任务提取通用规则 |
| 技能进化 | 学习结果固化为可复用技能 |
| 主动建议 | 主动提出改进建议 |
| ClawHub 集成 | 学习结果可分享到 ClawHub |

**时间**：Phase 5（4 周）

---

## 十、与 ClawHub self-improving 对比

| 维度 | ClawHub skill | OpenHorse |
|------|--------------|-----------|
| **记忆架构** | 单层（MEMORY.md） | 三层（HOT/WARM/COLD） |
| **学习信号** | 用户纠正 + 偏好 | 纠正 + 停好 + 模式 + 反思 |
| **升降级** | 无 | 自动升降级（3 次成功升级，时间衰减降级） |
| **Harness 集成** | 无 | 事件驱动学习 + 学习注入 Harness |
| **安全边界** | 无 | 学习不能覆盖 Harness 约束 |
| **冲突解决** | 无 | 优先级层级 + 冲突检测 |
| **压缩维护** | 手动 | 心跳驱动自动维护 |
| **透明性** | 无来源标注 | 每次引用注明来源 |
| **可回滚** | 无 | 支持"忘记"命令 |
| **自我反思** | 无 | 任务完成触发反思 |
| **模式识别** | 无 | 3 次重复自动提取模式 |
| **跨任务泛化** | 无 | Phase 5 支持 |

### 核心优势

1. **三层记忆**：比 ClawHub 单层记忆更高效，按热度分层加载
2. **自动升降级**：无需手动维护，系统自动调整记忆热度
3. **Harness 集成**：学习结果增强 Harness，形成正向循环
4. **安全边界**：学习不能突破 Harness，确保安全
5. **多信号源**：纠正 + 停好 + 模式 + 反思，学习机会更多

---

## 十一、存储结构

```
~/.openhorse/
├── memory/
│   ├── memory.md              # HOT memory 累引（≤100 行）
│   ├── user/                  # WARM: 用户偏好
│   │   ├── terse.md           # 响应风格偏好
│   │   ├── testing.md         # 测试偏好
│   │   └── commit-style.md    # 提交风格偏好
│   ├── project/               # WARM: 项目上下文
│   │   ├── react-migration.md # React 迁移上下文
│   │   └── api-design.md      # API 设计上下文
│   ├── domain/                # WARM: 领域知识
│   │   ├── typescript.md      # TypeScript 知识
│   │   ├── react.md           # React 知识
│   │   └── nodejs.md          # Node.js 知识
│   ├── feedback/              # WARM: 反馈记录
│   │   ├── no-mock-db.md      # "不要用 mock 数据库"
│   │   ├── prefer-bundle.md   # "优先单 PR"
│   │   └── no-summary.md      # "不要末尾总结"
│   ├── archive/               # COLD: 按时间归档
│   │   ├── 2025-01/
│   │   ├── 2025-02/
│   │   └── 2025-03/
│   └── cold/                  # COLD: 长期存储
│       ├── historical-patterns.md
│       └── obsolete-feedback.md
├── config/
│   └── self-optimization.json  # 自我优化配置
└── logs/
    └── learning.log            # 学习日志
```

---

## 十二、配置示例

```json
{
  "selfOptimization": {
    "enabled": true,
    "learningSignals": {
      "correction": true,
      "preference": true,
      "pattern": true,
      "reflection": true
    },
    "promotion": {
      "successThreshold": 3,
      "demotionDays": {
        "hotToWarm": 7,
        "warmToCold": 30,
        "coldToArchive": 90
      }
    },
    "limits": {
      "hotMaxLines": 100,
      "warmMaxLines": 200
    },
    "maintenance": {
      "dailyHeartbeat": true,
      "weeklyCompress": true,
      "monthlyArchive": true
    },
    "safety": {
      "noOverrideHarness": true,
      "noDangerousOperations": true
    }
  }
}
```

---

*文档版本：v1.0 | 创建日期：2026-05-02 | 维护者：Linux2010*