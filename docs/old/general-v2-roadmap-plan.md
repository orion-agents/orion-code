# OpenHorse V2 能力扩展路线图

> **基于 OpenClaude 参考的能力演进规划**
>
> **版本**: 2.0 | **日期**: 2026-05-02 | **作者**: Linux2010

---

## 概述

本文档定义 OpenHorse 从 MVP 到完整 Agent 框架的演进路径，参考 OpenClaude（63 模块，46 万行代码）的成熟设计，规划四个主要阶段的扩展。

### 路线图总览

| Phase | 主题 | 周期 | 核心交付 |
|-------|------|------|---------|
| **Phase 2** | 工具系统 | 4-6 周 | 文件/Shell/搜索工具 + Tool 抽象 |
| **Phase 3** | 高级 Agent | 6-8 周 | Coordinator + Task 链 + Buddy + 成本追踪 |
| **Phase 4** | CLI 增强 | 4-6 周 | 流式输出 + 交互 UI + slash 命令 |
| **Phase 5** | 集成扩展 | 8-12 周 | MCP + LSP + 多 Provider + Bridge |

### 与 Phase 1 的关系

Phase 1 已完成 MVP：
- CLI + LLM 基础对话
- Agent + Harness 框架骨架
- 基本记忆系统

Phase 2-5 在此基础上扩展，逐步对标 OpenClaude 的完整能力。

---

## Phase 2: 工具系统（4-6 周）

**目标**：建立完整的工具抽象层，让 Agent 能够安全操作文件系统和执行命令。

### 2.1 文件操作工具

参考 OpenClaude 的 FileRead/FileWrite/FileEdit 设计。

#### 2.1.1 Read 工具

```typescript
// src/tools/read.ts
interface ReadToolConfig {
  file_path: string;      // 绝对路径
  limit?: number;         // 读取行数限制
  offset?: number;        // 起始偏移
  pages?: string;         // PDF 专用页码
}

interface ReadToolResult {
  content: string;        // 文件内容
  lines: number;          // 总行数
  truncated: boolean;     // 是否截断
}
```

**功能点**：
- 文本文件读取（自动编码检测）
- 图片文件读取（返回描述）
- PDF 文件读取（按页）
- Jupyter Notebook 读取
- 大文件分页

#### 2.1.2 Write 工具

```typescript
// src/tools/write.ts
interface WriteToolConfig {
  file_path: string;      // 绝对路径
  content: string;         // 写入内容
  mode?: 'create' | 'overwrite' | 'append';
}
```

**安全约束**：
- 拒绝覆盖现有文件（需显式 overwrite）
- 路径白名单检查
- 文件大小限制

#### 2.1.3 Edit 工具

```typescript
// src/tools/edit.ts
interface EditToolConfig {
  file_path: string;
  old_string: string;     // 必须唯一匹配
  new_string: string;
  replace_all?: boolean;  // 全局替换
}
```

**特性**：
- 精确字符串替换
- 唯一性检查（拒绝模糊匹配）
- 支持 replace_all 批量替换

### 2.2 Shell 执行工具

参考 OpenClaude 的 Bash 工具设计。

```typescript
// src/tools/bash.ts
interface BashToolConfig {
  command: string;        // 要执行的命令
  description: string;    // 命令描述
  timeout?: number;       // 超时时间 (ms)
  run_in_background?: boolean;
}

interface BashToolResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration: number;
}
```

**安全机制**：
- 危险命令拦截（rm -rf /, :(){ :|:& };:, etc.）
- 沙箱选项（可选）
- 超时保护
- 工作目录锁定

### 2.3 搜索工具

#### 2.3.1 Glob 工具

```typescript
// src/tools/glob.ts
interface GlobToolConfig {
  pattern: string;        // glob 模式
  path?: string;          // 搜索目录
}
```

**特性**：
- 文件模式匹配
- 按修改时间排序
- 支持否定模式

#### 2.3.2 Grep 工具

```typescript
// src/tools/grep.ts
interface GrepToolConfig {
  pattern: string;        // 正则表达式
  path?: string;          // 搜索路径
  output_mode?: 'content' | 'files_with_matches' | 'count';
  glob?: string;          // 文件过滤
  context?: number;       // 上下文行数
}
```

**特性**：
- 基于 ripgrep 高性能搜索
- 正则表达式支持
- 文件类型过滤

### 2.4 Tool 抽象基类

```typescript
// src/tools/base.ts
abstract class BaseTool<TInput, TOutput> {
  abstract name: string;
  abstract description: string;

  // JSON Schema 输入验证
  abstract inputSchema: JSONSchema;

  // 执行入口
  abstract execute(input: TInput, context: ToolContext): Promise<TOutput>;

  // 安全检查（Harness 集成点）
  async validate(input: TInput, context: ToolContext): Promise<Result<void, ToolError>> {
    return Ok(undefined);
  }

  // 权限声明
  abstract permissions: Permission[];
}
```

**工具生命周期**：
1. 注册到 ToolRegistry
2. Agent 请求调用
3. Harness 边界检查
4. 权限验证
5. 执行
6. 结果验证

### 2.5 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/tools/base.ts` | 新增 | 工具抽象基类 |
| `src/tools/read.ts` | 新增 | 文件读取工具 |
| `src/tools/write.ts` | 新增 | 文件写入工具 |
| `src/tools/edit.ts` | 新增 | 文件编辑工具 |
| `src/tools/bash.ts` | 新增 | Shell 执行工具 |
| `src/tools/glob.ts` | 新增 | 文件搜索工具 |
| `src/tools/grep.ts` | 新增 | 内容搜索工具 |
| `src/tools/registry.ts` | 新增 | 工具注册表 |
| `src/harness/boundary-check.ts` | 修改 | 集成工具权限检查 |

### 2.6 验收标准

- [ ] Agent 可通过 Read 工具读取文件
- [ ] Agent 可通过 Write 工具创建文件
- [ ] Agent 可通过 Edit 工具编辑文件
- [ ] Agent 可通过 Bash 工具执行命令
- [ ] Agent 可通过 Glob/Grep 搜索文件
- [ ] 所有工具经过 Harness 边界检查
- [ ] 危险操作被正确拦截

---

## Phase 3: 高级 Agent（6-8 周）

**目标**：实现多 Agent 编排、任务链、辅助 Agent 和成本追踪。

### 3.1 Coordinator 协调器

参考 OpenClaude 的 coordinator 设计。

```typescript
// src/core/coordinator.ts
interface CoordinatorConfig {
  maxConcurrentAgents: number;
  taskTimeout: number;
  retryPolicy: RetryPolicy;
}

class Coordinator {
  // 任务分发
  async dispatch(task: Task): Promise<AgentAssignment>;

  // 多 Agent 编排
  async orchestrate(tasks: Task[]): Promise<OrchestrationResult>;

  // 冲突解决
  async resolveConflict(conflict: AgentConflict): Promise<Resolution>;
}
```

**编排模式**：

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| **Sequential** | 串行执行 | 有依赖的任务 |
| **Parallel** | 并行执行 | 独立任务 |
| **Conditional** | 条件分支 | 动态决策 |
| **Iterative** | 迭代执行 | 循环任务 |

### 3.2 Task 链

```typescript
// src/core/task.ts
interface Task {
  id: string;
  name: string;
  description: string;
  status: TaskStatus;
  dependencies: string[];  // 依赖任务 ID
  assignedAgent?: string;
  result?: TaskResult;
}

class TaskChain {
  // 添加任务
  add(task: Task): void;

  // 解析依赖顺序
  resolveExecutionOrder(): Task[];

  // 执行链
  async execute(context: ExecutionContext): Promise<ChainResult>;
}
```

**任务状态机**：

```
pending → ready → running → completed
                  ↓
                 failed → retrying
                  ↓
                 cancelled
```

### 3.3 Buddy 辅助 Agent

参考 OpenClaude 的 buddy 设计，实现后台任务支持。

```typescript
// src/agents/buddy.ts
class BuddyAgent extends BaseAgent {
  // 后台执行
  async runBackground(task: Task): Promise<BackgroundHandle>;

  // 状态检查
  async checkStatus(handle: BackgroundHandle): Promise<TaskStatus>;

  // 结果获取
  async getResult(handle: BackgroundHandle): Promise<TaskResult>;

  // 取消任务
  async cancel(handle: BackgroundHandle): Promise<void>;
}
```

**应用场景**：
- 长时间运行的测试
- 异步代码生成
- 后台监控任务

### 3.4 成本追踪

参考 OpenClaude 的 cost-tracker 设计。

```typescript
// src/core/cost-tracker.ts
interface UsageMetrics {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
}

class CostTracker {
  // 记录使用
  record(model: string, usage: UsageMetrics): void;

  // 获取统计
  getStats(timeRange?: TimeRange): CostStats;

  // 预算检查
  checkBudget(limit: number): boolean;
}
```

**统计维度**：
- 按 Agent 统计
- 按任务统计
- 按时间统计
- 按 Provider 统计

### 3.5 QueryEngine 查询引擎

```typescript
// src/core/query-engine.ts
class QueryEngine {
  // 上下文检索
  async retrieveContext(query: string, options: RetrieveOptions): Promise<Context>;

  // 相关性排序
  rankRelevance(items: ContextItem[], query: string): RankedItem[];
}
```

### 3.6 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/core/coordinator.ts` | 新增 | 多 Agent 协调器 |
| `src/core/task.ts` | 新增 | Task 链抽象 |
| `src/agents/buddy.ts` | 新增 | 后台 Agent |
| `src/core/cost-tracker.ts` | 新增 | 成本追踪 |
| `src/core/query-engine.ts` | 新增 | 查询引擎 |
| `src/core/brain.ts` | 修改 | 集成 Coordinator |
| `src/core/agent.ts` | 修改 | 支持任务依赖 |

### 3.7 验收标准

- [ ] Coordinator 能调度多 Agent 并行执行
- [ ] Task 链能正确解析依赖顺序
- [ ] Buddy Agent 能在后台执行任务
- [ ] 成本追踪能统计 token 使用
- [ ] 预算超限能正确拦截

---

## Phase 4: CLI 增强（4-6 周）

**目标**：提升 CLI 交互体验，实现流式输出、交互式 UI 和 slash 命令系统。

### 4.1 流式输出

参考 OpenClaude 的 SSE 流式响应设计。

```typescript
// src/cli/stream.ts
interface StreamOptions {
  onToken: (token: string) => void;
  onComplete: (response: LLMResponse) => void;
  onError: (error: Error) => void;
}

class StreamHandler {
  async stream(messages: Message[], options: StreamOptions): Promise<void>;
}
```

**特性**：
- 实时 token 显示
- 打字机效果
- 中断支持
- 错误恢复

### 4.2 交互模式 UI

参考 OpenClaude 的 ink 终端 UI 设计。

```typescript
// src/cli/ui/components.ts
// 使用 ink 或 @clack/prompts 实现

components = {
  // 欢迎横幅
  Banner: () => ReactElement;

  // 加载动画
  Spinner: (text: string) => ReactElement;

  // 工具调用显示
  ToolCall: (tool: string, input: object) => ReactElement;

  // 进度条
  Progress: (current: number, total: number) => ReactElement;

  // 成本显示
  CostDisplay: (usage: UsageMetrics) => ReactElement;
}
```

**UI 布局**：

```
┌─────────────────────────────────────────────────┐
│ OpenHorse v2.0 | gpt-4o | $0.02                 │
├─────────────────────────────────────────────────┤
│ User: 帮我实现一个排序算法                       │
│                                                 │
│ Agent: 好的，我来帮你实现...                     │
│ ▓▓▓▓▓▓▓▓░░░░░░░░░░░░ generating...              │
│                                                 │
│ [Tool] write_file: sort.ts                      │
│ ✓ Success                                       │
│                                                 │
│ Agent: 已创建 sort.ts...                         │
├─────────────────────────────────────────────────┤
│ > _                                             │
└─────────────────────────────────────────────────┘
```

### 4.3 Slash 命令系统

参考 OpenClaude 的 slash 命令设计。

```typescript
// src/cli/commands/slash.ts
interface SlashCommand {
  name: string;
  description: string;
  usage: string;
  execute: (args: string[], context: CommandContext) => Promise<void>;
}

// 内置命令
const builtinCommands: SlashCommand[] = [
  { name: 'help', description: '显示帮助', ... },
  { name: 'model', description: '切换模型', ... },
  { name: 'config', description: '配置管理', ... },
  { name: 'clear', description: '清空历史', ... },
  { name: 'export', description: '导出对话', ... },
  { name: 'agent', description: 'Agent 管理', ... },
  { name: 'tool', description: '工具管理', ... },
  { name: 'cost', description: '成本统计', ... },
  { name: 'exit', description: '退出程序', ... },
];
```

**命令注册机制**：

```typescript
// src/cli/commands/registry.ts
class CommandRegistry {
  register(command: SlashCommand): void;
  unregister(name: string): void;
  get(name: string): SlashCommand | undefined;
  list(): SlashCommand[];
}
```

### 4.4 Provider 配置管理

```typescript
// src/services/provider-config.ts
interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: ModelConfig[];
  defaultModel?: string;
}

interface ModelConfig {
  id: string;
  name: string;
  maxTokens: number;
  pricing: { input: number; output: number };
}

class ProviderManager {
  // 添加 Provider
  addProvider(config: ProviderConfig): void;

  // 切换模型
  setModel(modelId: string): void;

  // 列出可用模型
  listModels(): ModelConfig[];
}
```

**配置文件**：

```json
// ~/.openhorse/providers.json
{
  "providers": [
    {
      "name": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "models": [
        { "id": "gpt-4o", "name": "GPT-4o", "maxTokens": 128000 }
      ]
    }
  ],
  "defaultProvider": "openai",
  "defaultModel": "gpt-4o"
}
```

### 4.5 快捷键支持

```typescript
// src/cli/keybindings.ts
const defaultKeybindings = {
  'ctrl+c': 'exit',
  'ctrl+l': 'clear',
  'ctrl+d': 'clear_history',
  'up': 'history_prev',
  'down': 'history_next',
  'tab': 'autocomplete',
};
```

### 4.6 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/cli/stream.ts` | 新增 | 流式输出处理 |
| `src/cli/ui/components.ts` | 新增 | UI 组件 |
| `src/cli/ui/layout.ts` | 新增 | UI 布局 |
| `src/cli/commands/slash.ts` | 新增 | Slash 命令 |
| `src/cli/commands/registry.ts` | 新增 | 命令注册表 |
| `src/cli/keybindings.ts` | 新增 | 快捷键 |
| `src/services/provider-config.ts` | 新增 | Provider 管理 |
| `src/cli.ts` | 修改 | 集成流式和 UI |

### 4.7 验收标准

- [ ] 流式输出实时显示 token
- [ ] 交互 UI 正确渲染
- [ ] `/help` 显示命令列表
- [ ] `/model` 能切换模型
- [ ] `/config` 能查看配置
- [ ] 快捷键正常工作

---

## Phase 5: 集成扩展（8-12 周）

**目标**：实现 MCP 协议、LSP 集成、多 Provider 支持和远程桥接。

### 5.1 MCP 协议

参考 OpenClaude 的 MCP 实现。

```typescript
// src/mcp/protocol.ts
interface MCPTool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

interface MCPServer {
  // 工具发现
  listTools(): Promise<MCPTool[]>;

  // 工具调用
  callTool(name: string, args: object): Promise<MCPToolResult>;

  // 资源访问
  readResource(uri: string): Promise<Resource>;

  // Prompt 获取
  getPrompt(name: string, args: object): Promise<Prompt>;
}

class MCPClient {
  async connect(serverPath: string): Promise<void>;
  async disconnect(): Promise<void>;
  getServer(): MCPServer;
}
```

**MCP 服务器配置**：

```json
// ~/.openhorse/mcp-servers.json
{
  "servers": [
    {
      "name": "filesystem",
      "command": "mcp-server-filesystem",
      "args": ["--root", "/workspace"]
    },
    {
      "name": "github",
      "command": "mcp-server-github",
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  ]
}
```

### 5.2 LSP 集成

```typescript
// src/lsp/client.ts
interface LSPCapabilities {
  completion: boolean;
  hover: boolean;
  definition: boolean;
  references: boolean;
  diagnostics: boolean;
}

class LSPClient {
  // 启动 LSP 服务器
  async start(language: string): Promise<void>;

  // 代码补全
  getCompletion(uri: string, position: Position): Promise<CompletionItem[]>;

  // 跳转定义
  gotoDefinition(uri: string, position: Position): Promise<Location>;

  // 查找引用
  findReferences(uri: string, position: Position): Promise<Location[]>;

  // 获取诊断
  getDiagnostics(uri: string): Promise<Diagnostic[]>;
}
```

**支持的语言服务器**：

| 语言 | LSP 服务器 |
|------|-----------|
| TypeScript | typescript-language-server |
| Python | pyright / pylsp |
| Go | gopls |
| Rust | rust-analyzer |
| Java | jdtls |

### 5.3 多 Provider 支持

参考 OpenClaude 的 200+ 模型支持。

```typescript
// src/providers/base.ts
interface Provider {
  name: string;
  models: Model[];

  // 统一接口
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse>;
  chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<ChatChunk>;
  embed(text: string): Promise<number[]>;
}

// 内置 Provider
const builtinProviders = [
  new OpenAIProvider(),
  new AnthropicProvider(),
  new GeminiProvider(),
  new GroqProvider(),
  new OllamaProvider(),
  new OpenRouterProvider(),
];
```

**统一消息格式**：

```typescript
// 消息格式适配
interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

interface ContentPart {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  image?: { url: string };
  toolUse?: { id: string; name: string; input: object };
  toolResult?: { id: string; output: object };
}
```

### 5.4 Bridge 远程桥接

参考 OpenClaude 的 Bridge 设计，实现与 Claude Code 兼容。

```typescript
// src/bridge/client.ts
interface BridgeConfig {
  endpoint: string;
  apiKey: string;
  timeout: number;
}

class BridgeClient {
  // 转发请求到远程
  async forward(request: BridgeRequest): Promise<BridgeResponse>;

  // 工具代理
  async proxyTool(tool: string, args: object): Promise<object>;

  // 健康检查
  async healthCheck(): Promise<boolean>;
}
```

**应用场景**：
- 远程模型访问
- 分布式 Agent 执行
- 云端工具代理

### 5.5 记忆系统增强

```typescript
// src/memory/manager.ts
class MemoryManager {
  // 工作记忆（内存）
  workingMemory: WorkingMemory;

  // 短期记忆（JSONL）
  shortTermMemory: ShortTermMemory;

  // 长期记忆（向量）
  longTermMemory: LongTermMemory;

  // 技能记忆（Markdown）
  skillMemory: SkillMemory;

  // 记忆迁移
  async migrate(source: MemoryStore, target: MemoryStore): Promise<void>;
}
```

**向量存储集成**：

```typescript
// src/memory/vector.ts
class VectorStore {
  // 嵌入生成
  async embed(text: string): Promise<number[]>;

  // 相似性搜索
  async search(query: number[], k: number): Promise<VectorMatch[]>;

  // 添加向量
  async add(id: string, vector: number[], metadata: object): Promise<void>;
}
```

### 5.6 gRPC 服务

```typescript
// src/grpc/server.ts
// 可选的 gRPC 接口

service OpenHorseService {
  rpc Chat(ChatRequest) returns (stream ChatResponse);
  rpc ExecuteTask(TaskRequest) returns (TaskResponse);
  rpc GetAgentStatus(AgentId) returns (AgentStatus);
  rpc StreamEvents(Empty) returns (stream AgentEvent);
}
```

### 5.7 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/mcp/protocol.ts` | 新增 | MCP 协议实现 |
| `src/mcp/client.ts` | 新增 | MCP 客户端 |
| `src/lsp/client.ts` | 新增 | LSP 客户端 |
| `src/providers/base.ts` | 新增 | Provider 抽象 |
| `src/providers/openai.ts` | 新增 | OpenAI Provider |
| `src/providers/anthropic.ts` | 新增 | Anthropic Provider |
| `src/providers/gemini.ts` | 新增 | Gemini Provider |
| `src/bridge/client.ts` | 新增 | Bridge 客户端 |
| `src/memory/vector.ts` | 新增 | 向量存储 |
| `src/grpc/server.ts` | 新增 | gRPC 服务（可选） |

### 5.8 验收标准

- [ ] MCP 工具能被正确发现和调用
- [ ] LSP 能提供代码补全
- [ ] 能切换多个 Provider
- [ ] Bridge 能转发请求到远程
- [ ] 记忆持久化到向量存储

---

## 附录 A：依赖规划

| 依赖 | 引入阶段 | 用途 |
|------|---------|------|
| `ink` | Phase 4 | 终端 UI |
| `@inkjs/ui-components` | Phase 4 | UI 组件 |
| `ripgrep` (via exec) | Phase 2 | 内容搜索 |
| `@modelcontextprotocol/sdk` | Phase 5 | MCP 协议 |
| `vscode-languageserver-protocol` | Phase 5 | LSP 协议 |
| `@grpc/grpc-js` | Phase 5 | gRPC 服务 |
| `better-sqlite3` | Phase 5 | 长期记忆 |
| `sqlite-vec` | Phase 5 | 向量索引 |

---

## 附录 B：与 OpenClaude 能力对照

| OpenClaude 能力 | OpenHorse 对应阶段 |
|----------------|-------------------|
| 文件操作工具 | Phase 2 |
| Shell 执行工具 | Phase 2 |
| 搜索工具 | Phase 2 |
| Coordinator | Phase 3 |
| Task 链 | Phase 3 |
| Buddy Agent | Phase 3 |
| 成本追踪 | Phase 3 |
| 流式输出 | Phase 4 |
| 交互模式 UI | Phase 4 |
| slash 命令 | Phase 4 |
| Provider 配置 | Phase 4 |
| MCP 协议 | Phase 5 |
| LSP 集成 | Phase 5 |
| 多 Provider | Phase 5 |
| Bridge 桥接 | Phase 5 |
| 向量存储 | Phase 5 |

---

## 附录 C：里程碑时间线

```
2026-05-02 ─────────────────────────────────────────────────────►

Phase 2: 工具系统
├── Week 1-2: Tool 抽象 + 文件工具
├── Week 3-4: Shell + 搜索工具
└── Week 5-6: 集成测试 + 文档

Phase 3: 高级 Agent
├── Week 7-9: Coordinator + Task 链
├── Week 10-12: Buddy + 成本追踪
└── Week 13-14: 集成测试 + 文档

Phase 4: CLI 增强
├── Week 15-17: 流式输出 + UI
├── Week 18-19: slash 命令
└── Week 20: Provider 配置

Phase 5: 集成扩展
├── Week 21-26: MCP + LSP
├── Week 27-30: 多 Provider + Bridge
└── Week 31-34: 向量存储 + 文档
```

---

*创建日期: 2026-05-02 | 作者: Linux2010*