# v0.1.15 开发计划 — Provider Registry 架构 + 轻量钩子 + 成本追踪增强

> **版本定位**: 从单模型到多提供商架构，建立钩子框架基础，完善成本追踪
> **基础版本**: v0.1.14 (已发布 npm)
> **创建日期**: 2026-06-06

---

## 范围控制

v0.1.15 的完整 roadmap 有 3-4 个月工作量。本次聚焦 **MVP 可交付范围**：

| 优先级 | 项目 | 范围 | 预估 |
|--------|------|------|------|
| **P0** | Provider Registry 核心 | 双层架构 + 内置 Provider + 环境变量路由 | 1-2 天 |
| **P0** | Transport Adapter | OpenAI + Anthropic 2 种 Adapter | 1 天 |
| **P1** | Hook Framework | 轻量注册/触发 + 3 个内置 Hook | 1 天 |
| **P1** | 成本追踪增强 | 模型定价 + 增量计数 + 预算告警 | 0.5 天 |
| P2 | Agent 协调 | 留到 v0.1.16 | — |
| P2 | 知识系统增强 | 留到 v0.1.16 | — |

**原则**: 参考 OpenClaude 的架构，但不抄复杂度。双层 Provider、3 种 Transport 核心够用，去掉进度轮询、复杂权限同步等重型设计。

---

## Phase 1: Provider Registry 核心

### 1.1 类型定义

```
src/providers/
├── types.ts          # ProviderDescriptor, TransportKind, ModelEntry
├── registry.ts       # ProviderRegistry 核心
├── builtin.ts        # 内置 Provider 列表
└── index.ts          # 聚合导出
```

**类型**:
- `TransportKind`: `'anthropic-native' | 'openai-compatible' | 'local'`
- `ProviderKind`: `'gateway' | 'vendor' | 'local'`
- `ProviderDescriptor`: id, kind, transport, label, defaultBaseUrl, defaultModel, authMethod
- `ModelEntry`: apiName, label, contextWindow, maxOutputTokens, pricing

**内置 Provider**（首批 7 个）:
| id | kind | transport | label |
|---|---|---|---|
| `anthropic` | vendor | anthropic-native | Anthropic |
| `openai` | vendor | openai-compatible | OpenAI |
| `qwen` | vendor | openai-compatible | Qwen (通义千问) |
| `deepseek` | vendor | openai-compatible | DeepSeek |
| `ollama` | local | local | Ollama |
| `gemini` | vendor | openai-compatible | Google Gemini |
| `dashscope` | gateway | openai-compatible | DashScope (阿里编码网关) |

### 1.2 ProviderRegistry 实现

核心 API:
- `registerProvider(desc: ProviderDescriptor): void`
- `getProvider(id: string): ProviderDescriptor | null`
- `resolveActiveRoute(env: Record<string, string>): string` — 从环境变量解析活跃 Provider
- `getTransportKind(routeId: string): TransportKind`
- `listProviders(): ProviderDescriptor[]`

**环境变量路由**: `OPENHORSE_PROVIDER=anthropic` 或 `ANTHROPIC_API_KEY` 存在时自动选 anthropic

### 1.3 Provider 配置管理

复用现有 `src/services/config.ts`，新增 `providerId` 字段，不新增文件格式。

**验收**:
- [ ] 7 个内置 Provider 注册
- [ ] 环境变量正确解析活跃路由
- [ ] `listProviders()` 返回正确列表
- [ ] 单元测试覆盖

---

## Phase 2: Transport Adapter

### 2.1 统一格式

```
src/providers/adapters/
├── base.ts           # TransportAdapter 接口 + UnifiedRequest/Response
├── openai-compatible.ts  # OpenAI Adapter
├── anthropic.ts      # Anthropic Adapter
└── index.ts
```

**统一请求/响应**:
- `UnifiedRequest`: model, messages, tools, maxTokens, temperature, stream
- `UnifiedResponse`: content, model, usage, toolCalls
- `UnifiedMessage`: role, content, toolCalls

### 2.2 OpenAI Compatible Adapter

当前 `src/services/llm.ts` 已经使用 OpenAI SDK，本质上已经是 OpenAI compatible。
**工作**: 将现有 LLMService 迁移到统一格式，保留向后兼容。

### 2.3 Anthropic Native Adapter

新增 Anthropic SDK 调用，支持:
- `messages.create()` 流式/非流式
- Tool use (tool_choice, tools)
- cache_control (可选，v0.1.16)

**验收**:
- [ ] OpenAI Adapter 通过测试
- [ ] Anthropic Adapter 通过测试
- [ ] 流式响应正确解析
- [ ] 工具调用正确转换

---

## Phase 3: Hook Framework

### 3.1 HookRegistry

```
src/hooks/
├── registry.ts       # HookRegistry 核心
├── types.ts          # HookEvent, HookDefinition, HookContext
├── builtin.ts        # 内置 Hooks
└── index.ts
```

**Hook 事件**:
- `SessionStart` / `SessionEnd` — 会话生命周期
- `PreToolUse` / `PostToolUse` — 工具调用前后
- `ToolUseFailed` — 工具失败

**核心 API**:
- `register(hook: HookDefinition): void`
- `trigger(event: HookEvent, ctx: HookContext): Promise<HookResult[]>`
- `triggerIntercept(event, ctx): Promise<HookContext>` — 拦截模式，可修改上下文

### 3.2 内置 Hooks

| Hook | Event | 功能 |
|------|-------|------|
| `session-start` | SessionStart | 初始化会话状态 |
| `tool-security-check` | PreToolUse | 工具调用前安全检查（复用现有 safety） |
| `session-persist` | SessionEnd | 持久化会话数据 |

**验收**:
- [ ] HookRegistry 核心实现
- [ ] 3 个内置 Hook 注册并正确触发
- [ ] 拦截模式测试通过
- [ ] 钩子失败不影响主流程

---

## Phase 4: 成本追踪增强

### 4.1 模型定价数据库

```
src/services/cost-tracker.ts (增强现有文件)
```

内置定价:
| 模型 | 输入 $/MTok | 输出 $/MTok |
|------|---|---|
| claude-opus-4-7 | 15 | 75 |
| claude-sonnet-4-6 | 3 | 15 |
| claude-haiku-4-5 | 0.8 | 4 |
| gpt-4o | 2.5 | 10 |
| gpt-4o-mini | 0.15 | 0.6 |
| deepseek-chat | 0.27 | 1.1 |
| qwen-plus | 0.4 | 2 |
| glm-5 | 0 | 0 (当前默认) |

### 4.2 预算告警

新增 `setBudgetAlert(limit: number, callback: () => void)`
超过预算时输出警告：`⚠ Cost alert: $0.95 of $1.00 budget used`

**验收**:
- [ ] 定价数据覆盖 8+ 模型
- [ ] 费用计算正确
- [ ] 预算告警触发

---

## 文件结构变化

```
src/
├── providers/              # 新增
│   ├── types.ts
│   ├── registry.ts
│   ├── builtin.ts
│   ├── adapters/
│   │   ├── base.ts
│   │   ├── openai-compatible.ts
│   │   └── anthropic.ts
│   └── index.ts
├── hooks/                  # 新增
│   ├── registry.ts
│   ├── types.ts
│   ├── builtin.ts
│   └── index.ts
├── services/
│   ├── llm.ts              # 迁移到统一格式
│   ├── config.ts           # 新增 providerId 字段
│   └── cost-tracker.ts     # 增强定价 + 预算告警
```

---

## 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Anthropic SDK 依赖冲突 | 中 | 独立安装，与 OpenAI SDK 无冲突 |
| 现有配置不兼容新 Provider 架构 | 中 | 保留向后兼容，旧配置自动迁移 |
| 钩子性能开销 | 低 | 超时控制 + 并行执行 |

---

## 验收标准

- [ ] 支持切换至少 3 个 Provider (Anthropic, Qwen, Ollama)
- [ ] Hook 框架正常工作，3 个内置 Hook 触发
- [ ] 成本追踪显示正确的模型定价
- [ ] 全量测试通过
- [ ] npm 发布 openhorse@0.1.15

---

*创建日期: 2026-06-06*
