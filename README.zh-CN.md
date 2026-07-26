# Orion Code

> **Orion Code — 通用 Agent 驾驭框架**
> 一个 CLI 驱动的编码 Agent，具备安全边界、工具编排、记忆系统和上下文管理。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.0-blue.svg)](https://www.typescriptlang.org)
[![npm](https://img.shields.io/npm/v/orion-code.svg)](https://www.npmjs.com/package/orion-code)

---

**🌍 语言**: [English](README.md) | 简体中文

---

## 概览

**Orion Code** 是一个终端编码 Agent，它将 LLM API 封装在安全检查、工具编排、会话管理和上下文感知的驾驭层中。

### 核心理念

| 维度 | 说明 |
|------|------|
| **AI 如马** | 强大的模型需要引导和约束 |
| **Orion Code 如缰** | 精准控制方向，防止跑偏失控 |
| **Harness 系统** | 安全边界、任务约束、结果验证 |
| **工具调用** | LLM 自动调用工具完成任务 |
| **记忆系统** | 分层记忆：工作 / 短期 / 长期 / 语义搜索 |
| **MCP 协议** | 支持连接外部 MCP Server |

---

## 核心特性

| 特性 | 说明 |
|------|------|
| **工具编排** | 20+ 内置工具：文件读写、搜索、Shell、网页、记忆、任务、计划 |
| **多模型支持** | OpenAI、Claude、DashScope（GLM/Qwen/Kimi）、自定义端点 |
| **上下文感知** | 每个模型独立的上下文窗口，95% 自动压缩 |
| **动态发现** | 启动时自动通过 `/models` 端点发现模型信息 |
| **MCP 协议** | 完整 MCP 支持，心跳检测 + 指数退避重连 |
| **记忆系统** | 用户 / 项目 / 会话记忆，支持语义搜索 |
| **会话管理** | 会话持久化、历史恢复、摘要生成 |
| **安全边界** | Bash 安全检查、审计日志、权限模式 |
| **流式输出** | 实时 LLM 响应，Markdown 渲染 |
| **Terminal UI** | 默认稳定 scrollback 终端 UI；Ink/TUI 仅作为显式 beta 实验 |
| **Print Mode** | 实验性 `-p/--print` 一次性入口，用于后续自动化/remote UI 验证 |
| **状态栏** | 实时显示 Token 用量、成本、模型、上下文百分比 |
| **精简配置** | 仅 4 个用户字段，其余由 Agent 内部管理 |

---

## 快速开始

### 环境要求

- Node.js >= 18.0
- npm >= 9.0

### 安装运行

```bash
# 克隆
git clone https://github.com/Linux2010/orion-code.git
cd orion-code

# 安装依赖
npm install

# 构建
npm run build

# 配置 API Key（任选一种）
# 方式 1: 环境变量
export ORION_CODE_API_KEY=your-api-key

# 方式 2: .env 文件
cp .env.example .env

# 方式 3: ~/.orion-code/orion-code.json（推荐）
# 首次运行时自动创建

# 启动默认稳定 terminal UI
npm start

# 显式尝试 beta renderer
npm start -- --ui tui
npm start -- --ui ink

# 尝试早期实验性的非交互入口
npm start -- --print "review the current git diff"
```

### 全局安装

```bash
npm link
# 任意目录运行
orion-code
```

---

## 配置

### 用户配置 (`~/.orion-code/orion-code.json`)

仅 **4 个字段** 对用户开放，其余由 Agent 内部管理：

```json
{
  "apiKey": "sk-xxx",
  "apiBaseUrl": "https://coding.dashscope.aliyuncs.com/v1",
  "defaultModel": "glm-5",
  "fallbackModel": "qwen-plus"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `apiKey` | 是 | LLM API 密钥 |
| `apiBaseUrl` | 否 | API 端点 URL |
| `defaultModel` | 否 | 默认模型（`glm-5`） |
| `fallbackModel` | 否 | 失败时的降级模型 |

### Agent 内部参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxTokens` | 8192 | 最大输出 Token 数 |
| `temperature` | 0.1 | 采样温度 |
| `maxRetries` | 3 | 失败重试次数 |
| `retryBaseDelay` | 1000ms | 重试基础延迟 |

### 配置优先级

```
CLI 参数 > ~/.orion-code/orion-code.json > 环境变量 > 内部默认
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ORION_CODE_API_KEY` | - | LLM API 密钥 |
| `ORION_CODE_API_BASE_URL` | - | API 基础 URL |
| `ORION_CODE_MODEL` | `glm-5` | 默认模型 |
| `ORION_CODE_MODE` | `development` | 运行模式 |
| `ORION_CODE_LOG_LEVEL` | `info` | 日志级别 |
| `ORION_CODE_EMBEDDING_PROVIDER` | - | Embedding 服务（ollama/openai） |

详见 [docs/config.md](docs/config.md)。

---

## 支持的模型

### 模型家族

| 服务商 | 模型 | 端点 |
|--------|------|------|
| **GLM（智谱）** | `glm-5`, `glm-4` | DashScope coding |
| **Qwen（通义）** | `qwen-turbo`, `qwen-plus`, `qwen-max`, `qwen-long` | DashScope coding |
| **OpenAI** | `gpt-4o`, `gpt-4o-mini`, `gpt-4` | OpenAI API |
| **Claude** | `claude-sonnet-4-6`, `claude-opus-4-8` | Anthropic API |
| **DeepSeek** | `deepseek-chat`, `deepseek-reasoner` | DeepSeek API |

### 上下文窗口

Orion Code 跟踪每个模型的上下文窗口，在 **95% 用量时自动压缩**：

| 模型 | 上下文 | 最大输出 |
|------|--------|----------|
| `glm-5` | 202,752 | 8,192 |
| `qwen-long` | 1,000,000 | 8,192 |
| `qwen-plus` | 131,072 | 8,192 |
| `gpt-4o` | 128,000 | 16,384 |
| `claude-sonnet-4-6` | 200,000 | 16,000 |
| `claude-opus-4-8` | 200,000 | 32,000 |

未知模型默认使用 **128,000** 上下文。

### 动态发现

启动时 Orion Code 会查询 `/models` 端点获取上下文数据。若端点不支持（如 DashScope coding 返回 404），则静默回退到内置数据库。

### 模型命令

```bash
/model               # 显示当前模型
/model list          # 列出所有可用模型
/model glm-5         # 切换到 GLM-5
```

---

## 工具列表

### 文件操作

| 工具 | 说明 |
|------|------|
| `read_file` | 读取文件内容 |
| `write_file` | 写入文件 |
| `edit_file` | 编辑文件（行替换） |
| `list_files` | 列出目录内容 |
| `glob` | Glob 模式搜索文件 |
| `grep` | 正则搜索文件内容 |

### Shell 执行

| 工具 | 说明 |
|------|------|
| `exec_command` | 执行 Shell 命令（带安全检查） |

### 网络工具

| 工具 | 说明 |
|------|------|
| `web_fetch` | 抓取网页内容 |
| `web_search` | 网络搜索 |

### 记忆系统

| 工具 | 说明 |
|------|------|
| `memory_save` | 保存记忆 |
| `memory_recall` | 搜索记忆 |
| `memory_forget` | 删除记忆 |

### 任务管理

| 工具 | 说明 |
|------|------|
| `todo_write` | 创建/更新任务列表 |
| `enter_plan_mode` | 进入计划模式 |
| `exit_plan_mode` | 退出计划模式 |

---

## 上下文管理

### 自动压缩 (Auto-Compact)

当上下文使用量达到 **95%** 时，Orion Code 自动压缩对话历史：

1. **生成摘要** — 通过 LLM 对早期消息生成摘要
2. **替换旧消息** — 用 `[Context Summary]` 块替代
3. **保留关键信息** — 保留系统消息和最近消息
4. **状态栏通知** — 显示压缩信息

```
Compact: 30 → 8 messages | Context: 45% → 12%
```

### 基于 Token 的阈值

与基于消息数量的方案不同，Orion Code 使用 API 返回的 **实际 Token 数** 进行精确的上下文感知：

```
ctxPercent = (promptTokens / 模型上下文窗口) × 100
```

仅当 `ctxPercent >= 95%` 时触发压缩，不基于消息数量。

### 30 秒间隔

为避免过度压缩，自动压缩最多每 30 秒执行一次。手动 `/compact` 命令可绕过此限制。

---

## MCP 协议

完整支持 MCP (Model Context Protocol) 服务器：

### 配置 MCP Server

创建 `~/.orion-code/mcp.json`：

```json
{
  "servers": {
    "telegram": {
      "command": "node",
      "args": ["path/to/plugin-telegram/dist/index.js"],
      "env": {}
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-filesystem", "/allowed/dir"]
    }
  }
}
```

### MCP 命令

```bash
/mcp                # 显示 MCP Server 连接状态
```

启动时自动连接，支持心跳检测和指数退避重连。

---

## 交互命令

| 命令 | 别名 | 说明 |
|------|------|------|
| `/help` | `/h` | 显示帮助信息 |
| `/status` | `/s` | 系统状态总览 |
| `/model` | - | 查看或切换模型 |
| `/config` | - | 显示当前配置 |
| `/cost` | - | 显示 Token 用量和成本 |
| `/compact` | - | 手动触发上下文压缩 |
| `/sessions` | - | 列出最近会话 |
| `/resume` | - | 恢复上次会话 |
| `/memory` | - | 记忆系统状态 |
| `/memory reindex` | - | 重建语义搜索索引 |
| `/skills` | - | 列出已加载技能 |
| `/mcp` | - | MCP Server 状态 |
| `/agents` | - | Agent 列表 |
| `/safety` | - | 安全检查配置 |
| `/task` | - | 任务管理 |
| `/run` | - | 通过 Agent 执行任务 |
| `/clear` | - | 清屏 |
| `/clear-history` | `/reset` | 清除对话历史 |
| `/exit` | `/q` | 退出 |

---

## 项目结构

```
orion-code/
├── bin/
│   └── orion-code                  # CLI 入口
├── src/
│   ├── cli.ts                     # CLI 交互入口
│   ├── commands/                  # 斜杠命令
│   │   ├── index.ts               # 命令注册表
│   │   ├── parser.ts              # 输入解析器
│   │   └── types.ts               # 命令类型
│   ├── core/                      # 核心逻辑
│   │   ├── agent.ts               # Agent 基类
│   │   ├── brain.ts               # 决策引擎
│   │   └── strategy-tracker.ts    # 策略追踪
│   ├── agents/                    # Agent 实现
│   │   ├── leader.ts              # 协调者 Agent
│   │   ├── coder.ts               # 编码 Agent
│   │   └── router.ts              # Agent 路由
│   ├── framework/
│   │   ├── store.ts               # 状态管理
│   │   ├── query.ts               # 查询引擎（异步生成器）
│   │   └── tool-state.ts          # 工具状态
│   ├── harness/                   # 安全与约束
│   │   ├── safety.ts              # 安全检查
│   │   └── bash-safety.ts         # Bash 命令安全
│   ├── memory/                    # 记忆系统
│   │   ├── storage.ts             # 记忆存储
│   │   ├── semantic-search.ts     # 语义搜索
│   │   ├── embeddings.ts          # Embedding 生成
│   │   └── vector-store.ts        # 向量存储（SQLite vec0）
│   ├── skills/                    # 技能系统
│   │   ├── loader.ts              # 技能加载器
│   │   └── registry.ts            # 技能注册表
│   ├── services/
│   │   ├── llm.ts                 # LLM 服务（重试/降级）
│   │   ├── config.ts              # 配置加载
│   │   ├── global-config.ts       # 全局配置
│   │   ├── model-context.ts       # 模型上下文数据库 + 发现
│   │   ├── session-storage.ts     # 会话持久化
│   │   ├── atomic-write.ts        # 原子写入
│   │   ├── agent-runner.ts        # Agent 执行器
│   │   ├── task-manager.ts        # 任务管理器
│   │   └── file-glob.ts           # 文件匹配
│   ├── services/compact/          # 上下文压缩
│   │   ├── auto-compact.ts        # 基于 Token 的自动压缩
│   │   ├── compact.ts             # 压缩实现
│   │   └── summary-generator.ts   # 摘要生成
│   ├── tools/                     # 工具实现
│   │   ├── index.ts               # 工具注册表
│   │   ├── mcp.ts                 # MCP 客户端
│   │   ├── todo.ts                # 任务工具
│   │   ├── plan.ts                # 计划工具
│   │   ├── web.ts                 # 网页工具
│   │   └── memory.ts              # 记忆工具
│   └── ui/                        # UI 组件
│       ├── box.ts                 # UI 框
│       ├── markdown.ts            # Markdown 渲染
│       ├── status-bar.ts          # 状态栏
│       ├── stream-markdown.ts     # 流式 Markdown
│       ├── tool-preview.ts        # 工具预览卡片
│       └── suggestions.ts         # 命令建议
├── tests/                         # 测试套件
├── docs/                          # 文档
│   ├── version/                   # 版本发布说明
│   ├── roadmap/                   # 版本路线图
│   └── config.md                  # 配置指南
├── .env.example                   # 环境变量模板
├── package.json
└── tsconfig.json
```

---

## 版本历史

### v0.1.16（当前开发中）

- **基于 Token 的自动压缩** — 95% 上下文使用量触发（替代消息数量阈值）
- **模型上下文感知** — 每个模型独立的上下文窗口（15+ 已知模型）
- **动态模型发现** — 启动时查询 `/models` 端点
- **精简用户配置** — 仅 4 个字段：`apiKey`、`apiBaseUrl`、`defaultModel`、`fallbackModel`
- **Agent 内部管理** — `maxTokens`、`temperature`、`retries` 由 Agent 内部控制
- **用户可配置 Fallback 模型**
- **命令面板渲染优化**
- **上下文编排工作流** — 多 Agent 上下文管理

### v0.1.15

- **完整 Markdown 流式渲染** — 语法高亮
- **CJK 文本宽度计算修复** — 终端显示
- **命令面板输入清除优化**
- 表格渲染移除（改为原始透传）

### v0.1.14

- LSP 崩溃修复、紧凑 UI、精简 Agent 输出

### v0.1.10 — v0.1.13

- MCP 客户端（心跳/重连）、语义搜索、技能系统、原子写入、模型别名、存储修复

### v0.1.1 — v0.1.9

- CLI 框架、Harness 系统、记忆系统、会话管理、工具编排

详见 `docs/version/` 目录。

---

## 开发

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 构建
npm run build

# 运行测试
npm test

# 代码检查
npm run lint

# 格式化
npm run format
```

---

## Roadmap

| 版本 | 目标 |
|------|------|
| v0.1.16 | 上下文感知、自动压缩、配置精简 |
| v0.1.17 | Agent 生命周期增强、工具编排优化 |
| v0.1.18 | 插件/Hook 系统 |
| v0.1.19 | VS Code 扩展 |
| v0.1.20 | Web UI 面板 |

详见 `docs/roadmap/` 目录。

---

## 贡献

欢迎提交 Issue 和 Pull Request！

---

## 许可

MIT License — 详见 [LICENSE](LICENSE)

---

**Orion Code — Universal Agent Harness Framework.**

*"AI 如马，Orion Code 如缰。"*
