# Orion Code

> **Orion Code — 通用 Agent 驾驭框架**
> 一个 CLI 驱动的编码 Agent，具备安全边界、工具编排、记忆系统和上下文管理。
>
> v0.1.4 — Goal 连续性、模型配置与命令沙箱 POC

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.0-blue.svg)](https://www.typescriptlang.org)
[![npm](https://img.shields.io/npm/v/%40orion-agents%2Forion-code.svg)](https://www.npmjs.com/package/@orion-agents/orion-code)

---

**🌍 语言**: [English](README.md) | 简体中文

---

## 概览

**Orion Code** 是一个终端编码 Agent，它将 LLM API 封装在安全检查、工具编排、会话管理和上下文感知的驾驭层中。

### 核心理念

| 维度                | 说明                                    |
| ------------------- | --------------------------------------- |
| **AI 如马**         | 强大的模型需要引导和约束                |
| **Orion Code 如缰** | 精准控制方向，防止跑偏失控              |
| **Harness 系统**    | 安全边界、任务约束、结果验证            |
| **工具调用**        | LLM 自动调用工具完成任务                |
| **记忆系统**        | 分层记忆：工作 / 短期 / 长期 / 语义搜索 |
| **MCP 协议**        | 支持连接外部 MCP Server                 |

---

## 核心特性

| 特性            | 说明                                                                       |
| --------------- | -------------------------------------------------------------------------- |
| **工具编排**    | 29 个内置工具：文件读写、Shell、网页、记忆、Git、LSP、Goal 和计划          |
| **多模型支持**  | OpenAI、Claude、DashScope（GLM/Qwen/Kimi）、自定义端点                     |
| **上下文感知**  | 每个模型独立的上下文窗口，95% 自动压缩                                     |
| **动态发现**    | 启动时自动通过 `/models` 端点发现模型信息                                  |
| **MCP 协议**    | 完整 MCP 支持，心跳检测 + 指数退避重连                                     |
| **记忆系统**    | 用户 / 项目 / 会话记忆，支持语义搜索                                       |
| **会话管理**    | 会话持久化、历史恢复、摘要生成                                             |
| **持久 Goal**   | typed 多轮 continuation、安全 restart/resume、逐项证据审计                 |
| **安全边界**    | Bash 安全检查、审计日志、权限模式                                          |
| **流式输出**    | 实时 LLM 响应，Markdown 渲染                                               |
| **TUI**         | 默认且面向公众的主产品界面；支持 transcript、inspector、CJK 输入和工具输出 |
| **terminal-ui** | 仅用于 runtime 验证、诊断、兼容性排查和必要回退的技术版本                  |
| **Ink**         | 已废弃，不再承接新功能，计划在 v0.2.0 删除                                 |
| **Print Mode**  | 实验性 `-p/--print` 一次性入口，用于后续自动化/remote UI 验证              |
| **状态栏**      | 实时显示 Token 用量、成本、模型、上下文百分比                              |
| **模型配置**    | `providers + models` profile，可显式绑定端点、协议和上下文能力             |

---

## 快速开始

### 环境要求

- Node.js 20、22 或 24 LTS
- npm >= 9.0

### 安装运行

```bash
# 克隆
git clone https://github.com/orion-agents/orion-code.git
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

# 方式 3: ~/.orion-code/orion.json（推荐）
# 首次运行时自动创建

# 启动默认公众产品 TUI
npm start

# 显式启动 TUI
npm start -- --ui tui

# 技术诊断/兼容回退
npm start -- --ui terminal

# 已废弃的兼容 renderer（v0.2.0 删除）
npm start -- --ui ink

# 尝试早期实验性的非交互入口
npm start -- --print "review the current git diff"
```

### 全局安装

固定安装 v0.1.4-2 维护预发布版本：

```bash
npm install -g @orion-agents/orion-code@0.1.4-2
# 或通过预发布 dist-tag 安装：
npm install -g @orion-agents/orion-code@next
# 任意目录运行
orion
```

也可以在源码工作树中使用 `npm ci && npm run build && npm start`。

> **预发布状态**：`0.1.4-2` 已通过 npm `next` dist-tag 发布，并已创建
> `v0.1.4-2` 标签。稳定版 `latest` 仍为 `0.1.4`。

公众体验、交互优化和新增工作流优先落在 TUI。`terminal-ui` 不作为与
TUI 并行发展的公众产品；Ink 只保留迁移期兼容，不再增加产品能力。

### 持久 Goal 安全契约

`/target <目标>` 在当前 session 创建唯一 Active Goal。自动 continuation 是结构化 runtime
请求，不会伪装成用户输入，也不会写入 transcript。进程重启或 `/resume` 后，原 Active Goal
会以可见的 paused 恢复态加载；用户必须显式执行 `/target resume` 才会继续。

模型只能请求 `complete` 或 `blocked`，不能直接写入终态。Orion 会记录真实工具/runtime
证据并逐项审计 success criterion；缺失、失败、未映射、类型不匹配、过期或 stale 证据都会让 Goal 保持未完成。
需要人工验收的 criterion 只能由用户执行 `/target confirm <criterion-id>` 生成可信的 `user`
evidence，模型工具不能伪造该确认。
v0.1.2 只覆盖单 Session、单 Active Goal，不承诺多 Goal 调度或无人值守后台执行。

---

## 配置

### 用户配置 (`~/.orion-code/orion.json`)

当前推荐使用 `providers + models` 格式。旧的
`apiKey/apiBaseUrl/defaultModel/fallbackModel` 四字段格式仍可兼容读取，但启动时会提示迁移：

```json
{
  "providers": [
    {
      "id": "my-provider",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "$MY_API_KEY",
      "protocol": "openai-completions"
    }
  ],
  "models": [
    {
      "id": "my-model",
      "provider": "my-provider",
      "model": "model-name",
      "contextWindow": 200000,
      "maxOutputTokens": 64000
    }
  ],
  "defaultModel": "my-model",
  "toolConfirmation": "deny",
  "subagents": { "mode": "auto", "maxParallel": 3 }
}
```

`provider.apiKey` 支持 `$ENV_VAR` 引用；模型上下文和最大输出应按实际 Provider
能力填写。renderer 不从配置文件持久化读取：直接运行 `orion` 使用默认 TUI，
`--ui terminal` 只用于技术诊断和兼容回退。

### 配置优先级

```
CLI 参数 > ~/.orion-code/orion.json > 环境变量 > 内部默认
```

### 项目级工具规则（`allowedTools`）

权限规则写在 `projects["<项目绝对路径>"].allowedTools`，只作用于该仓库。规则叠加在
工具自身的权限策略之上：**只能收紧，不能放宽**。

```json
{
  "projects": {
    "/Users/me/work/api": {
      "allowedTools": [
        "exec_command(git status*)",
        "exec_command(npm test*)",
        "ask:exec_command(git push*)",
        "deny:read_file(*.env)"
      ]
    }
  }
}
```

- 语法：`[allow|ask|deny:]工具名[(参数通配)]`；`*` 匹配任意字符串，`?` 匹配单个字符，
  工具名写 `*` 表示匹配所有工具。
- 参数通配匹配的是调用参数中的 `command` / `file_path` / `path` / `url` / `pattern` /
  `query`（按此顺序取第一个非空字符串）。
- 冲突时按“最严格优先”解析：`deny` > `ask` > `allow`，与书写顺序无关。
- `allow` 仅用于免去交互确认，**不会**覆盖工具自身的 `deny`、**不会**突破 plan 模式的
  只读约束，也**不会**自动放行破坏性调用。
- 无法解析的条目会被忽略而不是静默放行，可通过 `/config` 查看解析结果与非法条目。

### 命令执行沙箱（`sandbox`）

`exec_command` 可在操作系统级沙箱内执行。这是**安全 POC**：后端在运行
时实测探测，已配置但不可用的沙箱会**fail closed**（拒绝执行），而不会静默降级为
无沙箱执行。

```json
{
  "sandbox": {
    "profile": "none",
    "backend": "auto",
    "allowNetwork": false,
    "writableRoots": [],
    "image": "alpine:latest"
  }
}
```

- **归属** — `sandbox` 位于全局配置（`~/.orion-code/orion.json`），并可在项目级
  `projects["<项目绝对路径>"].sandbox` 覆盖。项目级按 key 单独覆盖，缺省 key 继承全局。
- **`profile`** — `none`（默认，不隔离，等价于旧版 `sh -c`）、`read-only`（任何位置不可写、无网络）、
  `workspace-write`（写权限限定在工作区与临时目录，除非 `allowNetwork: true` 否则仍禁网）。
  未知取值（如新版 Orion 写入的更严格值）一律硬失败，绝不降级为 `none`。
- **`backend`** — `auto`（默认，自动选首个可用后端）、`seatbelt`（macOS `sandbox-exec`）、
  `bubblewrap`（Linux `bwrap`）或 `docker`。每个后端都用真实执行探针校验，从不靠 `which` 推断。
- **`image`** — 仅 `docker` 需要，指定运行所用的容器镜像。
- **`writableRoots`** — `workspace-write` 可写入的额外宿主根目录（除工作区与临时目录外）。
  非字符串 / 空项会被丢弃。
- **迁移 / 回滚** — 新增 `sandbox` 完全向后兼容：默认 `profile: "none"` 与旧行为完全一致。
  删除该 key（或回退到沙箱前的版本）是安全回滚；旧版 Orion 会忽略该未知字段。不涉及任何敏感信息，无需脱敏。
- **已知限制** — `seatbelt` 不能嵌套在另一沙箱内（例如 Orion 自身运行在应用沙箱中时）；
  `docker` 在独立进程树中运行命令，只约束被 bind-mount 的部分（镜像根文件系统已通过 `--read-only` 设为只读）；
  各后端均不限制 CPU / 内存。

### 环境变量

| 变量                            | 默认值        | 说明                            |
| ------------------------------- | ------------- | ------------------------------- |
| `ORION_CODE_API_KEY`            | -             | LLM API 密钥                    |
| `ORION_CODE_API_BASE_URL`       | -             | API 基础 URL                    |
| `ORION_CODE_MODEL`              | `gpt-4o`      | 默认模型                        |
| `ORION_CODE_MODE`               | `development` | 运行模式                        |
| `ORION_CODE_LOG_LEVEL`          | `info`        | 日志级别                        |
| `ORION_CODE_EMBEDDING_PROVIDER` | -             | Embedding 服务（ollama/openai） |

运行 `/config` 可查看当前生效配置，`orion --help` 可查看 CLI 级覆盖方式。

---

## 支持的模型

### 模型家族

| 服务商           | 模型                                               | 端点             |
| ---------------- | -------------------------------------------------- | ---------------- |
| **GLM（智谱）**  | `glm-5`, `glm-4`                                   | DashScope coding |
| **Qwen（通义）** | `qwen-turbo`, `qwen-plus`, `qwen-max`, `qwen-long` | DashScope coding |
| **OpenAI**       | `gpt-4o`, `gpt-4o-mini`, `gpt-4`                   | OpenAI API       |
| **Claude**       | `claude-sonnet-4-6`, `claude-opus-4-8`             | Anthropic API    |
| **DeepSeek**     | `deepseek-chat`, `deepseek-reasoner`               | DeepSeek API     |

### 上下文窗口

Orion Code 跟踪每个模型的上下文窗口，在 **95% 用量时自动压缩**：

| 模型                | 上下文    | 最大输出 |
| ------------------- | --------- | -------- |
| `glm-5`             | 202,752   | 8,192    |
| `qwen-long`         | 1,000,000 | 8,192    |
| `qwen-plus`         | 131,072   | 8,192    |
| `gpt-4o`            | 128,000   | 16,384   |
| `claude-sonnet-4-6` | 200,000   | 16,000   |
| `claude-opus-4-8`   | 200,000   | 32,000   |

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

| 工具         | 说明               |
| ------------ | ------------------ |
| `read_file`  | 读取文件内容       |
| `write_file` | 写入文件           |
| `edit_file`  | 编辑文件（行替换） |
| `list_files` | 列出目录内容       |
| `glob`       | Glob 模式搜索文件  |
| `grep`       | 正则搜索文件内容   |

### Shell 执行

| 工具           | 说明                          |
| -------------- | ----------------------------- |
| `exec_command` | 执行 Shell 命令（带安全检查） |

### 网络工具

| 工具         | 说明         |
| ------------ | ------------ |
| `web_fetch`  | 抓取网页内容 |
| `web_search` | 网络搜索     |

### 记忆系统

| 工具            | 说明     |
| --------------- | -------- |
| `memory_save`   | 保存记忆 |
| `memory_recall` | 搜索记忆 |
| `memory_forget` | 删除记忆 |

### 任务管理

| 工具              | 说明              |
| ----------------- | ----------------- |
| `todo_write`      | 创建/更新任务列表 |
| `enter_plan_mode` | 进入计划模式      |
| `exit_plan_mode`  | 退出计划模式      |

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

## 常用交互命令

| 命令                   | 说明                                                |
| ---------------------- | --------------------------------------------------- |
| `/help`                | 显示当前 renderer 可用的完整命令列表                |
| `/target`（`/goal`）   | 创建、查看、暂停、恢复、替换或清除持久 Goal         |
| `/status`              | 系统状态总览                                        |
| `/model`               | 查看或切换模型                                      |
| `/config`              | 显示当前生效配置                                    |
| `/usage`               | 显示详细 Token 用量和成本                           |
| `/compact`             | 手动触发上下文压缩                                  |
| `/sessions`            | 列出或搜索最近会话                                  |
| `/resume`              | 恢复已有会话                                        |
| `/memory`              | 查看记忆状态；`/memory reindex` 重建语义索引        |
| `/skills`              | 列出已加载技能                                      |
| `/tools`               | 列出内置和 MCP 工具                                 |
| `/mcp`                 | 查看 MCP Server 状态                                |
| `/doctor`              | 运行配置、工具、MCP、Skill、Session 和 Harness 诊断 |
| `/diff`                | 只读汇总当前 Git 工作区改动                         |
| `/commit`              | 生成只读 commit 计划和建议消息                      |
| `/context-clear --yes` | 清除当前内存中的模型上下文，保留已保存 session      |
| `/clear`               | 只清理当前视图，不删除 session 数据                 |
| `/exit`                | 安全关闭并退出                                      |

完整列表及 renderer 范围以 `/help` 为准。`/cost` 是 `/usage` 的废弃兼容入口；
`/task`、`/run`、`/clear-history` 仅保留为隐藏的迁移兼容命令，不属于公开工作流。

---

## 项目结构

```
orion-code/
├── bin/
│   └── orion                     # npm 全局命令入口
├── src/
│   ├── cli.ts                    # CLI 入口和 renderer 选择
│   ├── commands/                 # 斜杠命令注册表与处理器
│   ├── core/                     # Agent 核心状态
│   ├── framework/                # Query 与 Tool 抽象
│   ├── runtime/                  # Shared runtime、Goal、事件与 Subagent
│   ├── services/                 # 配置、LLM、Session、Storage、MCP
│   ├── tools/                    # 内置工具
│   ├── tui-ui/                   # 默认公众 TUI
│   ├── terminal-ui/              # 技术诊断 renderer
│   ├── print-ui/                 # 实验性 Print/Text 与 Print/JSON
│   └── skills/                   # 内置 Skill
├── tests/                        # Jest 测试套件
├── test-runtime/                 # 运行时 smoke 脚本
├── docs/
│   ├── goals/                    # 项目 Goal、证据与恢复说明
│   ├── mvp/                      # 版本计划与发布说明
│   └── plan/                     # 执行计划与准出报告
├── package.json
└── tsconfig.json
```

---

## 版本历史

### v0.1.4-2（已发布至 next）

- 汇总 v0.1.4 后续的安全、持久化、Goal/runtime、Research、依赖与发布门禁修复；
- 以 npm `next` dist-tag 发布，不移动稳定版 `latest`。

### v0.1.4（已发布）

- 版本元数据对齐：`package.json` / `package-lock.json` 升至 `0.1.4`，`orion --version`、
  出站 `User-Agent` 与崩溃/遥测上报不再误报 `0.1.3`；
- 类型安全推进：外部边界（LLM provider、MCP wire、工具返回）由 `any` 收窄为 `unknown` +
  类型守卫，顺带修复被 `any` 掩盖的真实缺陷；
- 可靠性：持久化与鉴权路径不再静默吞掉异常，ESLint 启用 `no-empty` 门禁。

### v0.1.3（已发布）

- `/model` 与 `/models` 拆分：`/model` 只显示当前模型信息，`/models` 承接交互式切换；
- `modelRegistry` 成为模型展示与切换的唯一事实源，静态 catalog 退为 legacy fallback；
- 内置 catalog 补全（火山方舟 / xf-yun / deepseek 等），未配置上下文时正确回退；
- 命令沙箱 POC、只读 Git 工具与工具 allowlist 的安全基线。

> 完整变更与交付状态（已发布 / 已合并 / 候选）以 `CHANGELOG.md` 为准。

### v0.1.2（已发布）

- 单 Session、单 Active Goal 的 typed continuation；
- restart/resume 后安全暂停，必须显式恢复；
- runtime evidence ledger、逐 criterion completion audit 与精确 stop reason；
- TUI 主产品体验和 terminal-ui/Print 事件语义一致。

### v0.1.1（已发布）

- 命令契约、TUI 默认路径、OpenHorse 迁移和数据安全收敛；
- terminal-ui 定位为技术诊断版本，Ink 正式废弃。

### v0.1.0（已发布）

- Orion Code 首个公开基线版本。

详见 `docs/mvp/` 和 `docs/plan/`。

---

## Research-to-Evidence（v0.1.4，实验性）

> **状态标记：experimental（实验性）。** 把只读 `research` 子 agent 的结果转化为**可追踪、可恢复**的研究→证据闭环。

核心保证（违反任一即 No-Go，绝不发布）：

- **只接专用 WebSearch / WebFetch**，不暴露通用 MCP、不授予 write/exec。
- **SSRF / DNS 重解析 / 重定向 / 响应大小 / 超时** 全部走既有守卫：选择期做 lexical SSRF 预检，逐跳防护委托给真实 WebFetch 工具。
- **claim 必须有 source 绑定**才能进入 `observed`；无独立验证的 claim 永远停在 `partial`/`unmet`，绝不被算作已验证/完成。
- **安全闸门失败 → `blocked`/`failed` + 结构化原因**，绝不伪装成命中；provider fallback 只换 provider，不降级 source status，也不把失败写成成功。
- 研究证据（web）与执行验证证据（file / 测试 / 构建 / 文件事实）**明确区分**，web 摘要不能替代执行验证。
- 包与源元数据**原子 CAS 保存**，project / session / Goal 作用域隔离；恢复只推导状态、不重放外部副作用；旧 schema 版本 fail-closed。

模块：`src/runtime/subagents/{research-types,research-contract,research-citation,web-research-adapter,research-renderer,research-artifact,research-quality}.ts`。

> 真实终端（PTY）与外部状态证据在 CI 中标记为 `not_run`；本地测试不视为发布完成。

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

# 发布前只读检查（不会 tag / push / publish）
npm run release:check
```

---

## Roadmap

| 版本   | 目标                                                |
| ------ | --------------------------------------------------- |
| v0.1.2 | Goal 连续性、证据审计、恢复与发布可信度             |
| v0.2.0 | 在项目级 Goal 约束下评估多目标等非 patch 兼容性能力 |

详见[项目级目标](https://github.com/orion-agents/orion-code/blob/main/docs/goals/orion-code-项目级目标.md)。

---

## 贡献

欢迎提交 Issue 和 Pull Request！

---

## 许可

MIT License — 详见 [LICENSE](LICENSE)

---

**Orion Code — Universal Agent Harness Framework.**

_"AI 如马，Orion Code 如缰。"_
