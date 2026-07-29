# Agent 生命周期管理

> **Agent 不是静态进程，而是有状态、有生命周期的实体。**
>
> **版本**: 1.0 (MVP) | **日期**: 2026-05-01 | **作者**: Rein Team

---

## 一、Agent 状态机

Agent 在任何时刻都处于以下状态之一：

```
                           ┌──────────┐
                           │ CREATED  │
                           └────┬─────┘
                                │ initialize()
                                ▼
┌──────────┐    stop()    ┌──────────┐    task()    ┌──────────┐
│ DESTROYED│◄─────────────│ STOPPED  │─────────────▶│ WORKING  │
└──────────┘              └──────────┘              └────┬─────┘
                             ▲                           │
                             │                           │ task complete
                             │ unregister()              │ / error
                             │                           ▼
                             │                     ┌──────────┐
                             └─────────────────────│  IDLE    │
                                                   └──────────┘
```

### 状态定义

| 状态 | 说明 | 可执行操作 | 不可执行操作 |
|------|------|-----------|-------------|
| **CREATED** | 已注册，未初始化 | `initialize()` | `execute()` |
| **IDLE** | 就绪，等待任务 | `execute()`, `stop()` | `initialize()` |
| **WORKING** | 正在执行任务 | (等待完成/取消) | `initialize()`, `execute()` |
| **STOPPED** | 已停止，保留状态 | `initialize()`, `unregister()` | `execute()` |
| **DESTROYED** | 已销毁，资源释放 | (无) | 所有操作 |

### 状态转换约束

```typescript
interface StateTransition {
  from: AgentState;
  to: AgentState;
  guard?: () => boolean;     // 前置条件
  action?: () => void;       // 转换时执行的副作用
}

const VALID_TRANSITIONS: StateTransition[] = [
  { from: 'CREATED', to: 'IDLE', action: 'initResources' },
  { from: 'IDLE', to: 'WORKING', guard: 'hasTask' },
  { from: 'WORKING', to: 'IDLE', action: 'releaseTaskResources' },
  { from: 'WORKING', to: 'STOPPED', action: 'abortTask' },
  { from: 'STOPPED', to: 'IDLE', action: 'reinitResources' },
  { from: 'STOPPED', to: 'DESTROYED', action: 'cleanupAll' },
  { from: 'IDLE', to: 'DESTROYED', action: 'cleanupAll' },
];
```

---

## 二、Agent 生命周期阶段

### 2.1 注册阶段 (Registration)

Agent 被创建并注册到 Brain 决策层。

```typescript
interface AgentRegistration {
  id: string;            // 唯一标识
  name: string;          // 显示名称
  description: string;   // 能力描述
  capabilities: string[];// 能力标签
  config: AgentConfig;   // 配置
}

// 注册流程
Brain.registerAgent(agent: BaseAgent): void {
  // 1. 验证 Agent 配置
  validateAgentConfig(agent);

  // 2. 分配唯一 ID（如果未指定）
  agent.id = agent.id || generateId();

  // 3. 设置初始状态
  agent.state = 'CREATED';

  // 4. 注册到管理表
  this.agents.set(agent.id, agent);

  // 5. 注册能力索引
  for (const cap of agent.capabilities) {
    this.capabilityIndex.add(cap, agent.id);
  }

  // 6. 触发注册事件
  this.emit('agent:registered', agent);
}
```

### 2.2 初始化阶段 (Initialization)

Agent 从 CREATED 转换到 IDLE，加载必要的资源。

```typescript
class BaseAgent {
  async initialize(): Promise<void> {
    if (this.state !== 'CREATED') {
      throw new AgentStateError('Cannot initialize from state: ' + this.state);
    }

    // 1. 加载配置
    this.config = await loadAgentConfig(this.id);

    // 2. 初始化 LLM 客户端
    this.llm = await createLLMClient(this.config.model);

    // 3. 注册工具
    await this.registerTools();

    // 4. 加载记忆
    this.memory = await this.memoryManager.initialize(this.id);

    // 5. 构建系统提示
    this.systemPrompt = await this.buildSystemPrompt();

    // 6. 状态转换
    this.state = 'IDLE';
    this.emit('agent:initialized', this);
  }
}
```

### 2.3 执行阶段 (Execution)

Agent 从 IDLE 转换到 WORKING，执行分配的任务。

```typescript
class BaseAgent {
  async execute(task: Task): Promise<TaskResult> {
    if (this.state !== 'IDLE') {
      throw new AgentStateError('Cannot execute from state: ' + this.state);
    }

    // 状态转换
    this.state = 'WORKING';
    this.currentTask = task;

    try {
      // 1. Harness pre-check
      const preCheck = await this.harness.preCheck(task);
      if (!preCheck.passed) {
        return { success: false, error: preCheck.reason };
      }

      // 2. 加载工作记忆
      const workingMemory = this.memory.createWorkingMemory(task.id);

      // 3. 构建执行上下文
      const context = {
        task,
        systemPrompt: this.systemPrompt,
        memory: workingMemory,
        tools: this.tools,
        constraints: preCheck.constraints,
      };

      // 4. Agent Loop (参考 OpenClaw 的 agent loop)
      let result = await this.agentLoop(context);

      // 5. Harness post-validate
      const validation = await this.harness.postValidate(result, task);

      if (!validation.passed) {
        // 根据策略决定重试还是报告
        if (this.shouldRetry(validation, task)) {
          result = await this.agentLoop({ ...context, correction: validation.suggestions });
        } else {
          return { success: false, error: 'Validation failed', details: validation };
        }
      }

      // 6. 持久化重要记忆
      await this.memory.consolidate(workingMemory);

      this.state = 'IDLE';
      return { success: true, data: result };

    } catch (error) {
      this.state = 'IDLE';  // 失败后回到 IDLE
      return { success: false, error: String(error) };
    }
  }

  // Agent Loop - 参考 OpenClaw 的 PI runtime
  private async agentLoop(context: AgentContext): Promise<any> {
    let turnCount = 0;
    const maxTurns = context.constraints?.limits?.maxSteps || 20;

    while (turnCount < maxTurns) {
      // 1. 构建消息列表
      const messages = this.buildMessages(context);

      // 2. 调用 LLM
      const response = await this.llm.chat(messages, {
        tools: context.tools.getSchemas(),
      });

      // 3. 处理响应
      if (response.toolCalls?.length) {
        // 执行工具调用
        for (const call of response.toolCalls) {
          // Harness boundary check
          await this.harness.checkBoundary(call);

          const result = await this.tools.execute(call);
          context.memory.append({
            type: 'tool_call',
            content: JSON.stringify({ call, result }),
            timestamp: Date.now(),
          });
        }
      } else {
        // 最终响应，退出循环
        return response.content;
      }

      turnCount++;
    }

    throw new Error('Agent loop exceeded max turns');
  }
}
```

### 2.4 销毁阶段 (Destruction)

Agent 资源释放，从系统中移除。

```typescript
class BaseAgent {
  async destroy(): Promise<void> {
    // 1. 如果有进行中的任务，中止
    if (this.state === 'WORKING') {
      await this.abortCurrentTask();
    }

    // 2. 关闭 LLM 连接
    this.llm?.close();

    // 3. 释放工具资源
    this.tools?.cleanup();

    // 4. 释放记忆资源
    this.memory?.dispose();

    // 5. 状态转换
    this.state = 'DESTROYED';

    // 6. 从管理表中移除
    this.brain?.unregisterAgent(this.id);

    this.emit('agent:destroyed', this);
  }
}
```

---

## 三、Brain 决策层

Brain 是 Agent 的调度中心，负责任务分配和 Agent 管理。

### 3.1 任务调度流程

```
任务提交
    │
    ▼
┌─────────────────────────┐
│ 1. 任务解析               │
│    - 提取能力需求          │
│    - 确定优先级            │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 2. Agent 匹配             │
│    - 根据能力标签匹配       │
│    - 过滤非 IDLE 状态      │
│    - 按负载排序            │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 3. 任务分发               │
│    - 发送到选定 Agent     │
│    - 等待完成             │
└───────────┬─────────────┘
            │
            ▼
    返回结果
```

### 3.2 调度策略

```typescript
type SchedulingStrategy = 'fifo' | 'priority' | 'capability' | 'load-balance';

class Brain {
  private findBestAgent(task: Task): BaseAgent | null {
    const available = Array.from(this.agents.values())
      .filter(a => a.state === 'IDLE');

    if (available.length === 0) return null;

    switch (this.config.strategy) {
      case 'fifo':
        return available[0];

      case 'priority':
        return thissortByPriority(available, task);

      case 'capability':
        return this.matchByCapability(available, task);

      case 'load-balance':
        return this.leastLoaded(available);

      default:
        return available[0];
    }
  }
}
```

---

## 四、与 Hermes Agent 的对比

### 4.1 Hermes Agent 架构

Hermes Agent 的生命周期管理嵌入在其 `AIAgent` 类中：

| 阶段 | Hermes 实现 | 说明 |
|------|-----------|------|
| **初始化** | `__init__` + config load | 加载 model, tools, memory |
| **运行** | `run_agent()` 主循环 | 消息 → LLM → 工具 → 循环 |
| **错误处理** | `error_classifier.py` | 结构化错误分类 + 恢复策略 |
| **压缩** | `context_engine.py` | 上下文窗口管理 |
| **记忆** | `memory_manager.py` | Provider 模式协调 |

### 4.2 对比分析

| 维度 | Hermes Agent | Rein |
|------|-------------|------|
| 状态模型 | 隐式（运行时状态） | 显式状态机（5 个状态） |
| 生命周期 | 创建即运行，无独立初始化 | 注册→初始化→执行→销毁（清晰阶段） |
| 错误处理 | 结构化错误分类器 | 结合 Harness 验证的错误恢复 |
| Agent 管理 | 单 Agent 为主 | 多 Agent 注册 + Brain 调度 |
| 任务分配 | 无（用户直接交互） | Brain 决策层自动分发 |
| 资源管理 | 进程内资源管理 | 显式 initialize/destroy 生命周期 |
| 状态转换约束 | 无 | 严格的前置条件和转换函数 |
| 能力匹配 | 无 | 基于能力标签的自动匹配 |

### 4.3 Rein 的核心改进

1. **显式状态机**：Hermes 没有显式的 Agent 状态概念，Rein 引入 5 个状态 + 严格转换规则，避免状态混乱。

2. **生命周期阶段**：Rein 将 Agent 生命周期拆分为注册、初始化、执行、销毁四个阶段，每个阶段职责清晰。

3. **Brain 调度**：Hermes 是单 Agent 交互模式，Rein 引入 Brain 决策层实现多 Agent 自动调度。

4. **能力匹配**：Rein 基于能力标签自动匹配最合适的 Agent，Hermes 依赖用户手动选择。

---

## 五、多 Agent 协作模式

### 5.1 Leader/Worker 模式

```
用户请求
    │
    ▼
┌─────────────────────┐
│   Leader Agent       │
│   (协调者)            │
│                       │
│  1. 理解用户意图       │
│  2. 分解任务为子任务   │
│  3. 分发到 Worker     │
│  4. 收集结果          │
│  5. 整合回复          │
└──────┬──┬──┬────────┘
       │  │  │
       ▼  ▼  ▼
   ┌────┐┌────┐┌────┐
   │C1  ││C2  ││A1  │
   └────┘└────┘└────┘
```

### 5.2 协作协议

```typescript
interface DelegationRequest {
  taskId: string;
  parentTaskId: string;
  capability: string;       // 需要的能力
  description: string;      // 子任务描述
  context?: any;            // 从父任务继承的上下文
  deadline?: number;        // 截止时间
}

interface DelegationResult {
  taskId: string;
  success: boolean;
  output: any;
  error?: string;
  duration: number;
}

interface LeaderAgent extends BaseAgent {
  // 分解任务
  decompose(task: Task): SubTask[];

  // 委派子任务
  delegate(subTask: SubTask): Promise<DelegationResult>;

  // 收集结果
  collect(results: DelegationResult[]): any;
}
```

---

## 六、Agent 类型

### 6.1 内置 Agent

| Agent 类型 | ID | 能力标签 | 说明 |
|-----------|----|---------|------|
| **Leader** | `leader` | `task-distribution`, `coordination`, `monitoring` | 协调者，负责任务分解和分发 |
| **Coder** | `coder` | `coding`, `code-review`, `debugging`, `refactoring` | 编码专家 |
| **Analyst** | `analyst` | `data-analysis`, `reporting`, `visualization` | 数据分析专家 |
| **Ops** | `ops` | `system-admin`, `deployment`, `monitoring` | 运维专家 |

### 6.2 自定义 Agent

```typescript
class CustomAgent extends BaseAgent {
  constructor(config: Partial<AgentConfig>) {
    super({
      id: config.id,
      name: config.name,
      capabilities: config.capabilities || [],
      systemPrompt: config.systemPrompt,
      tools: config.tools,
    });
  }

  async execute(task: Task): Promise<TaskResult> {
    // 自定义执行逻辑
  }
}
```

---

## 七、MVP 实现计划

| 阶段 | 功能 | 优先级 |
|------|------|--------|
| **MVP** | 显式状态机（5 状态 + 转换） | P0 |
| **MVP** | Agent 注册 + 初始化 | P0 |
| **MVP** | 单 Agent 执行循环 | P0 |
| **MVP** | 简单 FIFO 调度 | P1 |
| **MVP** | Leader + Coder 两种 Agent | P1 |
| **后续** | 多 Agent 协作 (Leader/Worker) | P1 |
| **后续** | 能力匹配调度 | P1 |
| **后续** | 任务分解 | P2 |
| **后续** | 自动弹性扩展 | P2 |

---

*文档版本：v1.0 | 创建日期：2026-05-01 | 维护者：Rein Team*
