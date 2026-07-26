# Rein 技术实现方案

> **Rein the AI, Unleash the Potential.**
>
> **版本**: 1.0 | **日期**: 2026-05-01 | **作者**: Linux2010
>
> 本文档定义了 Rein 从 MVP 到完整产品的迭代式技术实现路径，每一阶段都以「可运行」为目标。

---

## 总览

Rein 的实现分为 4 个 Phase，按优先级递进：

| Phase | 目标 | 预计范围 |
|-------|------|---------|
| **Phase 1**: CLI + LLM | 命令行能跑起来，能调用远端模型完成对话 | 新增 `src/services/llm.ts`，改造 `cli.ts` |
| **Phase 2**: Agent + Harness | Agent 通过 LLM 执行任务，Harness 提供安全边界 | Agent 接入 LLM，Harness 拦截 |
| **Phase 3**: Memory + Skills | 记忆持久化，技能系统，多轮上下文 | JSONL 持久化，技能加载器 |
| **Phase 4**: 完整功能 | 多 Agent 协作，OpenTask 集成，配置文件 | Gateway，MCP 工具链 |

---

## Phase 1: CLI + LLM（最快可用）

**目标**：用户通过命令行与 Rein 交互，Rein 调用远端 LLM API 完成对话。

### 1.1 需求

- [ ] 命令行输入 → 发送到 LLM → 显示回复
- [ ] 保持对话上下文（多轮对话）
- [ ] 环境变量配置 API Key、Base URL、Model
- [ ] 流式输出（streaming）
- [ ] 错误处理（网络错误、API 错误、超时）

### 1.2 技术方案

#### 1.2.1 LLM 服务层 — `src/services/llm.ts`

使用 `openai` npm 包（已在 `package.json` 中），兼容所有 OpenAI API 接口：

```typescript
// 核心接口
interface LLMConfig {
  apiKey: string;         // REIN_API_KEY
  baseUrl?: string;       // REIN_API_BASE_URL (支持第三方兼容)
  model: string;          // REIN_MODEL (默认 gpt-4o)
  maxTokens?: number;     // 单次最大输出 token
  temperature?: number;   // 温度 (默认 0.7)
}

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LLMResponse {
  content: string;
  usage?: { promptTokens: number; completionTokens: number; };
  model: string;
}

class LLMService {
  constructor(config: LLMConfig)
  chat(messages: Message[]): Promise<LLMResponse>
  chatStream(messages: Message[], onChunk: (text: string) => void): Promise<LLMResponse>
  setModel(model: string): void
  getModel(): string
}
```

**设计决策**：
- 使用 `openai` SDK（已在依赖中），它天然支持 OpenAI 兼容接口
- `baseUrl` 可配置，兼容 Claude (via OpenAI proxy)、本地 Ollama 等
- 流式/非流式双模式：交互模式用流式，非交互用非流式

#### 1.2.2 环境变量配置

```bash
# .env.example
REIN_API_KEY=sk-xxx
REIN_API_BASE_URL=https://api.openai.com/v1
REIN_MODEL=gpt-4o
REIN_MAX_TOKENS=4096
REIN_TEMPERATURE=0.7
```

配置加载优先级：
1. 命令行参数 `--model`, `--api-key`, `--base-url`
2. 环境变量 `REIN_API_KEY`, `REIN_API_BASE_URL`, `REIN_MODEL`
3. `.env` 文件（已有 `dotenv` 依赖）
4. 默认值

#### 1.2.3 CLI 改造 — `src/cli.ts`

在现有命令系统上新增：

| 命令 | 说明 |
|------|------|
| `chat <msg>` | 发送单条消息并获取回复（非交互模式） |
| `model <name>` | 切换当前模型 |
| `config` | 显示当前 LLM 配置 |
| `clear` | 清空对话历史 |
| 直接输入文本 | 进入对话模式（非命令的输入作为对话内容） |

**交互逻辑**：
```
rein > 帮我写一个排序算法
[正在生成...]
def bubble_sort(arr):
    ...
rein > 用 Python 的 sorted 怎么实现
[正在生成...]
使用 sorted() 函数...
rein > /model claude-sonnet-4-6
✔ Model changed to claude-sonnet-4-6
```

#### 1.2.4 对话上下文管理

在 `cli.ts` 中维护一个 `Message[]` 数组，包含 system prompt + 用户/助手消息：

```typescript
const conversationHistory: Message[] = [
  { role: 'system', content: SYSTEM_PROMPT },
  { role: 'user', content: '...' },
  { role: 'assistant', content: '...' },
];
```

SYSTEM_PROMPT 定义 Rein 的行为边界和身份。

### 1.3 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/services/llm.ts` | **新增** | LLM 服务封装 |
| `src/services/config.ts` | **新增** | 配置加载（环境变量 + .env + 命令行） |
| `src/cli.ts` | **修改** | 新增对话模式、chat/model/config 命令 |
| `.env.example` | **新增** | 环境变量模板 |
| `package.json` | **微调** | 确保 openai 依赖版本正确 |

### 1.4 验收标准

1. `npm start` 启动后可以看到 Rein banner
2. 输入文字后，能调用远端 LLM 并显示流式回复
3. 多轮对话能保持上下文
4. `/model` 命令能切换模型
5. `/config` 命令能显示当前配置
6. 配置错误时给出明确错误信息
7. `Ctrl+C` / `exit` 正常退出

---

## Phase 2: Agent + Harness

**目标**：Agent 通过 LLM 执行实际任务，Harness 在 Agent 执行前后提供安全边界。

### 2.1 核心改动

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/core/agent.ts` | 修改 | BaseAgent 增加 LLM 调用能力 |
| `src/agents/leader.ts` | 修改 | Leader 能通过 LLM 分析并分解任务 |
| `src/agents/coder.ts` | 修改 | Coder 能通过 LLM 生成代码 |
| `src/init.ts` | 修改 | 初始化时注入 LLM 服务到 Agent |
| `src/harness/safety.ts` | 修改 | 增加 LLM 输出的安全检查 |

### 2.2 关键设计

- Agent.execute() 内部调用 LLMService 生成执行结果
- Harness.preCheck() 在 Agent 执行前验证任务安全性
- Harness.postValidate() 在 LLM 输出后进行安全检查
- 支持 tool-use 模式：LLM 决定调用哪些工具

---

## Phase 3: Memory + Skills

**目标**：记忆持久化到磁盘，技能系统可加载/执行。

### 3.1 核心改动

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/memory/store.ts` | 修改 | 增加 JSONL 持久化后端 |
| `src/skills/registry.ts` | 新增 | 技能注册与发现 |
| `src/skills/loader.ts` | 新增 | 从文件系统加载技能 |
| `src/cli.ts` | 修改 | 增加 /memory 查看历史对话 |

### 3.2 记忆持久化

- JSONL 格式：每行一条 JSON 记录
- 文件路径：`~/.rein/memories/YYYY-MM-DD.jsonl`
- 工作记忆仍在内存，短期/长期记忆写入文件

### 3.3 技能系统

- 技能定义：`.rein/skills/*.md` 格式的 Markdown 文件
- 包含：技能名称、描述、输入参数、执行逻辑
- 加载时注册到 Agent

---

## Phase 4: 完整功能

**目标**：多 Agent 协作，OpenTask 集成，完整配置系统。

### 4.1 核心改动

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/gateway/` | 新增 | 网关层（HTTP/WebSocket） |
| `src/tools/` | 新增 | 工具集（exec, filesystem, web, git） |
| `src/config/` | 新增 | Zod 验证的配置系统 |
| `src/agents/analyst.ts` | 新增 | Analyst Agent |
| `src/agents/ops.ts` | 新增 | Ops Agent |

### 4.2 目标

- 支持 Telegram/Discord 等多渠道接入
- MCP 协议集成外部工具
- OpenTask 协议任务管理
- 多 Agent 协作执行复杂任务

---

## 附录：依赖规划

| 依赖 | 引入阶段 | 用途 |
|------|---------|------|
| `openai` | Phase 1 | LLM 调用（已有） |
| `dotenv` | Phase 1 | 环境变量加载（已有） |
| `chalk` | Phase 1 | 终端颜色（已有） |
| `commander` | Phase 1 | CLI 命令解析（已有） |
| `@clack/prompts` | Phase 1 | 交互式提示（已有） |
| `figlet` | Phase 1 | ASCII Art banner（已有） |
| `eventemitter3` | Phase 1 | 事件系统（已有） |
| `uuid` | Phase 1 | 唯一标识（已有） |
| `zod` | Phase 3 | 配置验证 |
| `better-sqlite3` | Phase 4 | 长期记忆向量存储 |
| `pino` | Phase 4 | 结构化日志 |

---

*创建日期：2026-05-01 | 维护者：Linux2010*
