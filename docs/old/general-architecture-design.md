# Rein 整体架构设计

> **Rein the AI, Unleash the Potential.**
> 通用 Agent 驾驭框架 — Universal Agent Harness Framework
>
> **版本**: 1.0 (MVP) | **日期**: 2026-05-01 | **作者**: Rein Team

---

## 一、项目定位

Rein 是一个 **通用 Agent 驾驭框架**，解决核心问题：

> AI 模型能力越来越强，但越强的 Agent 越容易跑偏。Rein 就是那根缰绳——给 AI 自由度，同时保持控制力。

### 为什么需要 Rein？

| 痛点 | Rein 的解决思路 |
|------|----------------|
| Agent 自由度过高导致行为不可控 | **Harness 驾驭系统**：目标约束 + 边界检查 + 结果验证 |
| 多 Agent 之间缺乏协调 | **Brain 决策层**：任务分解 + 优先级调度 + 路由分发 |
| Agent 没有持久记忆 | **三层记忆系统**：Working / Short-term / Long-term |
| Agent 生命周期不可管理 | **状态机驱动**：注册 → 初始化 → 执行 → 销毁 |
| Agent 操作缺乏安全边界 | **沙箱隔离**：操作白名单 + 危险检测 + 审计日志 |

### 与 OpenClaw / Hermes Agent 的关系

```
┌─────────────────────────────────────────────────────────────────┐
│                        AI Agent 生态位图                          │
├──────────┬──────────────┬──────────────┬────────────────────────┤
│          │   OpenClaw   │ Hermes Agent │       Rein (本框架)     │
├──────────┼──────────────┼──────────────┼────────────────────────┤
│ 定位     │ 个人AI助手平台│ 自进化AI助手  │ 通用Agent驾驭框架       │
│ 核心能力  │ 多渠道+网关  │ 学习闭环+技能 │ Harness约束+多Agent编排 │
│ 记忆     │ 向量搜索+工作 │ 内置+插件记忆 │ 三层记忆(工作/短期/长期) │
│ 安全     │ 网关+沙箱+策略│ 上下文扫描    │ Harness边界+安全沙箱    │
│ 部署     │ 本地优先      │ 本地/云端     │ 本地优先,可选云端       │
│ 关系     │ 参考其网关    │ 参考其学习闭环│ 互补,不重复造轮子        │
└──────────┴──────────────┴──────────────┴────────────────────────┘
```

**核心差异**：Rein 不替代 OpenClaw 或 Hermes，而是作为它们的 **Harness 补充层**——提供标准化的约束、验证和编排能力。Rein 可以嵌入 OpenClaw Gateway 作为额外的安全层，也可以独立运行作为轻量 Agent 框架。

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Channel 交互层                                │
│              Telegram │ Discord │ Web │ CLI │ MCP                    │
└────────────────────────┬────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────────┐
│                      Gateway 网关层                                  │
│         认证 │ 路由 │ 会话管理 │ 心跳 │ 定时任务                      │
└────────────────────────┬────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────────┐
│                  Harness 驾驭层 (Rein 核心)                           │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐              │
│   │ 目标约束  │ │ 边界检查  │ │ 结果验证  │ │ 安全沙箱  │              │
│   └──────────┘ └──────────┘ └──────────┘ └──────────┘              │
└────────────────────────┬────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────────┐
│                    Brain 决策层                                      │
│         任务分解 │ 优先级排序 │ Agent路由 │ 状态管理                   │
└─────────┬──────────┬──────────┬──────────┬──────────┬───────────────┘
          │          │          │          │          │
┌─────────▼┐ ┌──────▼──┐ ┌─────▼────┐ ┌──▼──────┐ ┌▼──────────┐
│ Leader   │ │ Coder   │ │ Analyst  │ │ Ops     │ │ Custom    │
│ Agent    │ │ Agent   │ │ Agent    │ │ Agent   │ │ Agent...  │
└────┬─────┘ └────┬────┘ └────┬─────┘ └──┬──────┘ └──┬────────┘
     │            │            │           │           │
┌────▼────────────▼────────────▼───────────▼───────────▼───────────┐
│                   Skills + Tools 工具层                            │
│    Web搜索 │ 浏览器 │ Git │ 数据库 │ MCP │ Shell │ 文件系统        │
└────────────────────────┬─────────────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────────────┐
│                   Memory 记忆层                                    │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐           │
│   │ Working  │ │Short-term│ │ Long-term│ │  Skills  │           │
│   │ Memory   │ │ Memory   │ │ Memory   │ │ Memory   │           │
│   └──────────┘ └──────────┘ └──────────┘ └──────────┘           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、核心模块职责

### 3.1 Gateway 网关层

参考 OpenClaw 的 Gateway 设计，提供：

| 组件 | 职责 | 参考 |
|------|------|------|
| **Auth** | 客户端认证、设备配对 | OpenClaw `gateway.auth.*` |
| **Router** | 消息路由到正确 Agent 和会话 | OpenClaw 多 Agent 路由 |
| **Session** | 会话生命周期管理、隔离 | OpenClaw 会话模型 |
| **Heartbeat** | 定时健康检查 | OpenClaw heartbeat |
| **Cron** | 定时任务调度 | OpenClaw cron jobs |

### 3.2 Harness 驾驭层（Rein 核心创新）

这是 Rein 与 OpenClaw/Hermes 最核心的差异点。

| 组件 | 职责 | 参考 |
|------|------|------|
| **Goal Constraint** | 任务执行前注入目标约束，防止 Agent 偏离方向 | OpenClaw SOUL.md/AGENTS.md + Hermes prompt guidance |
| **Boundary Check** | 每次操作前检查是否在安全边界内 | OpenClaw sandbox + tool policy |
| **Result Validate** | 任务完成后验证结果是否符合预期 | Hermes 执行纪律 guidance |
| **Safety Sandbox** | 沙箱隔离执行环境，限制爆破半径 | OpenClaw Docker/SSH sandbox |

详见 [Harness 驾驭系统设计](./harness-design.md)

### 3.3 Brain 决策层

参考 Hermes Agent 的 Agent 管理 + OpenClaw 的路由逻辑：

| 组件 | 职责 | 参考 |
|------|------|------|
| **Task Decomposer** | 将复杂任务分解为子任务 | OpenClaw sub-agents |
| **Scheduler** | 基于优先级和能力的调度 | Hermes priority-based routing |
| **Router** | 将任务分发给最合适的 Agent | OpenClaw multi-agent routing |
| **State Manager** | 维护 Agent 状态机 | Hermes agent lifecycle |
| **Coordinator** | 多 Agent 协作协调 | OpenClaw delegate architecture |

详见 [Agent 生命周期管理](./agent-lifecycle.md)

### 3.4 Memory 记忆层

综合 OpenClaw 和 Hermes 的记忆设计：

| 层级 | 存储 | 策略 | 参考 |
|------|------|------|------|
| **Working** | 内存 | 当前任务上下文，任务结束清除 | Hermes context engine |
| **Short-term** | 文件 (JSONL) | 24h 过期，定期压缩 | OpenClaw session transcripts |
| **Long-term** | SQLite + 向量索引 | 持久化，语义搜索 | OpenClaw builtin memory |
| **Skills** | Markdown 文件 | 手动/自动维护，技能索引 | Hermes skills system |

详见 [记忆系统设计](./memory-system.md)

### 3.5 Skills + Tools 工具层

| 类别 | 工具 | 说明 |
|------|------|------|
| **Runtime** | exec, process | 命令执行（受 Harness 约束） |
| **Filesystem** | read, write, edit | 文件操作 |
| **Web** | search, fetch, browser | 网络能力 |
| **Git** | clone, commit, push | 版本控制 |
| **MCP** | MCP 协议工具 | 外部工具集成 |
| **Messaging** | send, notify | 消息通道 |

---

## 四、技术栈

| 层级 | 技术选型 | 理由 |
|------|---------|------|
| 运行时 | Node.js 24 + TypeScript 5 | 与 OpenClaw 生态一致、异步强 |
| LLM SDK | OpenAI 兼容接口 | 统一封装，支持多模型 |
| 向量存储 | sqlite-vec | 嵌入式，零依赖 |
| CLI | commander + @clack/prompts | 已有依赖 |
| 配置 | Zod + JSON5 | 类型安全 + 人类可读 |
| 日志 | pino | 高性能结构化日志 |
| 测试 | Vitest | 快速、与 TS 原生集成 |

---

## 五、与 OpenClaw Gateway 的对比

```
┌─────────────────────────┬──────────────────────┬──────────────────────┐
│         维度            │     OpenClaw Gateway   │     Rein Harness     │
├─────────────────────────┼──────────────────────┼──────────────────────┤
│ 架构定位                │ 完整的AI助手平台       │ Agent 约束+编排框架   │
│ 网关                    │ WebSocket + HTTP       │ 可选嵌入或独立       │
│ 渠道支持                │ 25+ 渠道内置           │ 通过 MCP 插件接入     │
│ Agent 模型              │ 独立 Agent 实例        │ Leader/Worker 协作    │
│ 约束机制                │ 基于配置文件的软约束    │ 三层硬约束 + 结果验证  │
│ 安全沙箱                │ Docker/SSH/Openshell   │ 轻量沙箱 (MVP: exec)  │
│ 记忆                    │ SQLite + 向量 + Honcho  │ 三层记忆 (内置)       │
│ 复杂度                  │ 高 (完整平台)          │ 低 (专注核心)         │
│ 可嵌入性                │ 低 (独立运行)          │ 高 (可嵌入 OpenClaw)  │
└─────────────────────────┴──────────────────────┴──────────────────────┘
```

**设计理念**：Rein 不做 OpenClaw 已经做好的事（渠道接入、设备配对、OAuth 管理），而是专注于 OpenClaw 做得不够的事——**执行约束、任务编排、结果验证**。

---

## 六、项目结构

```
rein-agent/
├── src/
│   ├── index.ts              # 公共 API 导出
│   ├── cli.ts                # CLI 入口
│   ├── init.ts               # 初始化入口
│   ├── core/
│   │   ├── agent.ts          # Agent 基类（状态机）
│   │   ├── brain.ts          # 决策引擎（调度+路由）
│   │   └── harness.ts        # Harness 总控制器
│   ├── harness/
│   │   ├── goal-constraint.ts  # 目标约束
│   │   ├── boundary-check.ts   # 边界检查
│   │   ├── result-validate.ts  # 结果验证
│   │   └── safety-sandbox.ts   # 安全沙箱
│   ├── agents/
│   │   ├── leader.ts         # 协调者 Agent
│   │   ├── coder.ts          # 编码专家 Agent
│   │   └── ...               # 更多 Agent 类型
│   ├── memory/
│   │   ├── store.ts          # 记忆存储基类
│   │   ├── working.ts        # 工作记忆
│   │   ├── short-term.ts     # 短期记忆
│   │   ├── long-term.ts      # 长期记忆
│   │   └── manager.ts        # 记忆管理器
│   ├── gateway/
│   │   ├── server.ts         # 网关服务
│   │   ├── session.ts        # 会话管理
│   │   └── router.ts         # 消息路由
│   └── tools/
│       ├── registry.ts       # 工具注册表
│       ├── exec.ts           # 执行工具
│       ├── filesystem.ts     # 文件工具
│       └── web.ts            # 网络工具
├── docs/
│   ├── architecture.md       # 本文档
│   ├── harness-design.md     # Harness 设计
│   ├── memory-system.md      # 记忆系统设计
│   └── agent-lifecycle.md    # Agent 生命周期
├── tests/
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## 七、MVP 范围

MVP 版本聚焦最小可用功能集：

| 模块 | MVP 功能 | 后续迭代 |
|------|---------|---------|
| **Harness** | 目标约束 + 边界检查 | 结果验证 + 安全沙箱 |
| **Brain** | 单 Agent 执行 + 简单调度 | 多 Agent 协作 + 智能路由 |
| **Memory** | Working + Short-term | Long-term 向量搜索 + Skills |
| **Gateway** | CLI 交互 | 多渠道接入 + WebSocket |
| **Tools** | exec + filesystem | MCP + web + browser |
| **Agent** | Leader + Coder | Analyst + Ops + 自定义 |

---

*文档版本：v1.0 | 创建日期：2026-05-01 | 维护者：Rein Team*
