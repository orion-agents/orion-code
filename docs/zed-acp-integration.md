# Zed 插件对接调研报告：让 Orion Code 进入 Zed 的 Agent 生态

> 调研日期：2026-08-08
> 调研目标：搞清楚如何把 Orion Code（一个 TypeScript 编写的终端 AI 编码 Agent / CLI harness）对接到 Zed 编辑器，让 Zed 用户一键安装并使用它。
> 信息来源：Zed 官方文档、`agentclientprotocol.com` 协议规范与 ACP Registry 仓储（含 `agent.schema.json`、CONTRIBUTING.md）、Zed 官方博客 "The ACP Registry is Live"（2026-01-28）。

---

## 0. 一句话结论

**不要把精力花在"Zed 插件（Agent Server Extension）"上——那条路已经在 Zed v1.5.0 被官方弃用。** 现在的正确路径是：让 Orion Code 实现 **ACP（Agent Client Protocol）** 协议，然后把一个 `agent.json` 提交到 **ACP Registry**。提交合并后，Zed（以及 JetBrains 系列 IDE）用户即可在编辑器内置的 Registry 页面一键安装，并且永远自动拿到最新版本。

---

## 1. 背景与目标

Orion Code 是一个目标驱动的终端编码 Agent，已有完整的运行时（`runtime/chat-controller.ts`）、工具框架、会话存储（`services/session-storage.ts`）和多种 UI 渲染器（TUI / terminal / ink / print），并已发布到 npm（`@orion-agents/orion-code`）。

用户期望把 Orion 暴露给 Zed，使 Zed 用户能直接在编辑器里调用它。这里存在一个**关键认知更新**：用户在需求里贴的 "Create an extension.toml → Add a SVG icon → Publish using the normal process" 这套 Agent Server Extension 流程，是**旧版** Zed 文档的描述。当前（2026-08）Zed 官方文档的 Agent Server Extensions 页面顶部明确写着：

> *"As of Zed `v1.5.0`, ACP extensions have been deprecated in favor of the ACP Registry."*

因此本报告以 **ACP Registry** 为主线，并保留旧路径作为对照。

---

## 2. 关键发现

1. **Agent Server Extensions（ACP Extensions）已弃用**：自 Zed v1.5.0 起，原先基于 `zed-industries/extensions` 仓库子模块的 Agent 扩展方式被弃用，官方 blog 明确"at some point we will deprecate the extension-based approach entirely"。两种安装方式并存期间，**Registry 版本优先**。
2. **ACP Registry 是新的分发层**：2026-01-28 上线，由 `agentclientprotocol.com/registry` 承载。开发者"提交一次，所有兼容 ACP 的客户端（Zed、JetBrains）都能用"。Zed 和 JetBrains IDE 已内置 Registry 支持。
3. **Registry 自动更新**：合并后，Registry 每隔约 1 小时自动检测 npm / PyPI / GitHub Releases 的最新版本并更新，无需再走 Zed 的扩展审核周期。
4. **Registry 强制要求认证**：CI 会验证 Agent 在 `initialize` 响应里返回 `authMethods`，且至少有一种 `type: "agent"` 或 `type: "terminal"`。这点和"仅本地免登录 CLI"的 Agent 不同，实现时必须处理。
5. **ACP 协议本身 = "Agent 界的 LSP"**：标准化编辑器↔编码 Agent 的通信，复用 MCP 的 JSON 表示，本地用 **stdio + JSON-RPC 2.0**，远程用 **HTTP / WebSocket**（远程支持仍在推进中）。

---

## 3. 两条对接路径对比

### 3.1 旧路径：Zed Agent Server Extension（已弃用，仅作对照）

- 在 `zed-industries/extensions` 仓库里以 **Git submodule** 形式添加自己的扩展仓库。
- 扩展仓库根目录放 `extension.toml`（含 `id` / `name` / `version` / `schema_version` / `authors` / `description` / `repository`），并提供一个 SVG 图标。
- 在顶层 `extensions.toml` 增加条目，运行 `pnpm sort-extensions`，提交 PR。
- 约束：ID 发布后不可改、不能含 `zed`/`extension` 字样、2025-10-01 起必须带合规 LICENSE、扩展代码编译为 WASM（wasm32-wasip2）运行在沙箱里。
- **结论：不推荐新项目走这条路。**

### 3.2 新路径：ACP Registry（推荐）

- Fork `github.com/agentclientprotocol/registry`。
- 新建目录 `<agent-id>/`，放 `agent.json`（遵循 `agent.schema.json`）和 `icon.svg`（16x16、单色 `currentColor`）。
- 提交 PR，CI 自动按 schema + ID 规则 + 分发 URL 可达性 + 图标 + 认证做校验。
- 合并后即刻对所有 ACP 客户端可用，且版本自动滚动更新。
- 分发方式三选一（可组合）：**binary**（各平台压缩包）、**npx**（npm 包）、**uvx**（PyPI 包）。

### 3.3 对比表

| 维度 | Agent Server Extension（旧） | ACP Registry（新，推荐） |
|---|---|---|
| 状态 | Zed v1.5.0 起弃用 | 官方主推，2026-01 上线 |
| 分发载体 | `zed-industries/extensions` 子模块 + PR | `agentclientprotocol/registry` 子目录 + PR |
| 清单格式 | `extension.toml` | `agent.json` |
| 客户端覆盖 | 仅 Zed | Zed + JetBrains + 任意 ACP 客户端（"实现一次，处处可用"） |
| 更新节奏 | 依赖 Zed 扩展审核/发布周期 | 每小时自动从 npm/PyPI/GitHub Releases 拉最新 |
| 运行沙箱 | 必须为 WASM（wasm32-wasip2） | 按分发方式自行运行（npm/npx 或直接二进制） |
| 认证要求 | 无强制 | **强制** `authMethods`（agent/terminal 其一） |
| 图标 | SVG（无严格尺寸/配色约束） | 必须 16x16、正方形、单色 `currentColor` |

---

## 4. ACP 协议基础（Orion 必须实现的部分）

### 4.1 架构与传输

- **Agent（服务端）**：Orion 这一侧。本地 Agent 作为编辑器子进程启动，通过 **stdio 上的 JSON-RPC 2.0** 通信；远程 Agent 走 HTTP / WebSocket（规范仍在完善）。
- **Client（客户端）**：Zed / JetBrains 这一侧，负责 UI 与编排。
- 用户可读文本默认用 **Markdown**；协议复用 MCP 的 JSON 表示，并扩展出 diff 等编码 UX 类型。

### 4.2 初始化握手 `initialize`

Client 必须先发 `initialize`，协商协议版本、能力、认证方法：

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": true }, "terminal": true },
    "clientInfo": { "name": "zed", "title": "Zed", "version": "1.5.0" }
  }
}
```

Agent 必须回显协商后的协议版本、自身能力与 `authMethods`：

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "loadSession": true,
      "promptCapabilities": { "image": true, "audio": true, "embeddedContext": true },
      "mcpCapabilities": { "http": true, "sse": true }
    },
    "agentInfo": { "name": "orion", "title": "Orion Code", "version": "0.1.4" },
    "authMethods": [
      { "id": "terminal-login", "name": "Terminal login", "type": "terminal",
        "description": "Sign in via your existing Orion terminal session / API key" }
    ]
  }
}
```

> 协议版本是单个整数（MAJOR），仅在破坏性变更时递增；当前为 `1`。协商规则：Client 发其支持的最高版本，Agent 若支持则回相同值，否则回自身最高支持值。

### 4.3 能力协商（capabilities）

- **Client 能力**：`fs.readTextFile` / `fs.writeTextFile`（文件读写）、`terminal`（shell 执行）、`elicitation`、`session.configOptions.boolean` 等。
- **Agent 能力**：`loadSession`、`promptCapabilities`（image/audio/embeddedContext）、`mcpCapabilities`（http/sse）、`auth.logout`、`session.delete`、`additionalDirectories` 等。
- 所有未显式声明的能力均视为**不支持**；新增能力不算破坏性变更。

### 4.4 认证（注册表强制校验）

- Agent 在 `initialize` 响应里通过 `authMethods` 宣告可用认证方式；每条有 `id`，Client 后续调用 `authenticate` 时回传该 `id`。
- 认证方法类型：**`agent`**（Agent 自带登录流，默认类型，可省略 `type`）与 **`terminal`**（借助终端登录，例如复用本机已登录的 Orion 会话 / `ORION_CODE_API_KEY`）。
- 支持登出的 Agent 需额外宣告 `agentCapabilities.auth.logout: {}`，并提供 `logout` 方法。
- **Registry CI 校验**：`verify_agents.py --auth-check` 要求 `initialize` 返回 `authMethods` 且至少含一个 `type: "agent"` 或 `"terminal"`。**这是 Orion 入册的硬性门槛。**

```json
// Client 选择某认证方式
{ "jsonrpc": "2.0", "id": 1, "method": "authenticate", "params": { "methodId": "terminal-login" } }
// Agent 成功返回空结果 {}
```

### 4.5 会话生命周期（必修方法）

规范规定所有 Agent **必须**支持以下方法（其余可选，按 capability 声明）：

- `session/new` — 创建会话
- `session/prompt` — 发送用户输入（可携带文本 / 图片 / 音频 / 内嵌资源，按 `promptCapabilities`）
- `session/cancel` — 取消进行中的请求
- `session/update` — 更新会话状态

可选：`session/load`、`session/list`、`session/delete` 等。流式输出通过 notifications（work/progress）回传，Markdown 作为默认文本格式。

---

## 5. ACP Registry 提交规范（`agent.json`）

### 5.1 必填字段（`agent.schema.json`）

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | string | `^[a-z][a-z0-9-]*$`，目录名须一致，全局唯一 |
| `name` | string | 展示名，>=1 字符 |
| `version` | string | `x.y.z` 语义版本 |
| `description` | string | 简述，>=1 字符 |
| `distribution` | object | 至少一种分发方式（`binary` / `npx` / `uvx`） |

可选：`repository`（URI）、`website`（URI）、`authors`（数组）、`license`（SPDX 或 `"proprietary"`）、`icon`（由构建从 `icon.svg` 自动填入）。

### 5.2 分发方式

- **binary**：按平台给出压缩包（`.zip`/`.tar.gz`/`.tgz`/`.tar.bz2`/`.tbz2` 或裸二进制），不支持安装器（`.dmg`/`.pkg`/`.deb`/`.rpm`/`.msi`/`.appimage`）。每平台需 `archive` + `cmd`，建议带 `sha256`。平台键：`darwin-aarch64` / `darwin-x86_64` / `linux-aarch64` / `linux-x86_64` / `windows-aarch64` / `windows-x86_64`。**URL 不得含 `/latest/`。**
- **npx**：`{ "package": "@scope/pkg@1.0.0", "args": ["--acp"] }`（适合已发 npm 的 Node 项目）。
- **uvx**：`{ "package": "your-pkg", "args": ["serve", "--acp"] }`（适合 Python 项目）。

### 5.3 图标要求

- 必须 `icon.svg`，**16x16、正方形**（`width`=`height` 或 `viewBox` 等）。
- **单色，使用 `currentColor`**：`fill`/`stroke` 仅允许 `currentColor` / `none` / `inherit`，硬编码颜色（`#FF0000`、`red`、`rgb(...)`）会直接校验失败。

### 5.4 校验与自动更新

- CI 逐项校验：schema、ID 规则、版本格式、分发结构/URL 可达性（HTTP 200）、图标规范、**认证支持**。
- 合并后 Registry 每小时自动同步 npm / PyPI / GitHub Releases 的最新版本；无 `repository` 的 binary 仍需手动 PR 升版本。
- 本地预检：`SKIP_URL_VALIDATION=1 uv run --with jsonschema .github/workflows/build_registry.py`；认证预检：`python3 .github/workflows/verify_agents.py --auth-check --agent <id>`。

---

## 6. Orion Code 对接方案（落地建议）

### 6.1 现状盘点

- **无 ACP 实现**：全仓搜索 `acp` / `agentclientprotocol` 零命中，需从零实现协议服务端。
- **CLI 为手写解析**（非 commander/cac）：`src/cli.ts` 用 `process.argv` 手动分发（`orion`、`orion -p "task"`、`--ui tui|terminal|ink`、`doctor`/`diff`/`commit` 等）。新增子命令成本低。
- **已有会话与运行时**：`runtime/chat-controller.ts`（含 `createCommandContext`、`abortSignal`、`turnId`，天然支持单轮/取消）、`services/session-storage.ts`、`framework/` 工具框架、MCP 管理 `tools/mcp`。这些正好对应 ACP 的 `session/new` / `session/prompt` / `session/cancel`。
- **已发布 npm**：`orion` 命令软链到 `@orion-agents/orion-code`，因此 `npx` 分发最自然。

### 6.2 推荐架构：新增 `orion acp` 子命令

在 `src/cli.ts` 增加 `orion acp` 分支，启动一个**stdio JSON-RPC 2.0 服务器**，复用现有运行时：

1. 进程启动后监听 stdin，按行（或带长度前缀）解析 JSON-RPC 请求。
2. 实现协议方法：`initialize`、`authenticate`/`logout`（若需）、`session/new`、`session/prompt`、`session/cancel`、`session/update`。
3. `session/new` 内部调用现有 `createSession()`；`session/prompt` 内部复用 `chat-controller` 的 turn 执行（含工具调用、MCP、abort），把进度通过 `session/update` notification 以 Markdown 流式回传；`session/cancel` 复用 `abortSignal`。
4. 认证：采用 `type: "terminal"` 方法，复用本机已登录态或 `ORION_CODE_API_KEY` 环境变量（与现有配置体系一致），满足 Registry 的强制校验。

> 关键原则：**不要在 ACP 模式里拉起 TUI/Ink UI**，ACP 模式下 UI 由 Zed 负责；Orion 只做"后端 Agent 引擎"。

### 6.3 分发方式选择：**npx 优先**

Orion 已是 npm 包，最省事：`distribution.npx = { "package": "@orion-agents/orion-code@<version>", "args": ["acp"] }`。若未来要摆脱 Node 运行时依赖，再补 `binary` 分发（用 esbuild/pkg/deno compile 等打各平台单文件二进制）。

### 6.4 `agent.json` 草案（供提交 Registry 用）

```json
{
  "id": "orion-code",
  "name": "Orion Code",
  "version": "0.1.4",
  "description": "Goal-driven coding agent for the terminal. Runs as an ACP server so Zed users can drive it in-editor.",
  "repository": "https://github.com/orion-agents/orion-code",
  "website": "https://github.com/orion-agents/orion-code#readme",
  "authors": ["Orion Code Team"],
  "license": "MIT",
  "distribution": {
    "npx": {
      "package": "@orion-agents/orion-code@0.1.4",
      "args": ["acp"]
    }
  }
}
```

配套 `icon.svg`（16x16、单色 `currentColor`，例如一个 `viewBox="0 0 16 16"` 的简单路径，避免硬编码颜色）。

---

## 7. 落地步骤清单

1. [ ] 在 `src/cli.ts` 增加 `orion acp` 子命令骨架（stdio JSON-RPC 循环）。
2. [ ] 实现 `initialize`（返回 `protocolVersion:1` + `agentCapabilities` + `authMethods` 含 `type:"terminal"`）。
3. [ ] 实现 `session/new`、`session/prompt`（复用 `chat-controller` 单轮执行）、`session/cancel`、`session/update`（Markdown 流式通知）。
4. [ ] 实现 `authenticate`/`logout`（terminal 登录态 / API key）。
5. [ ] 用 Registry 的 `verify_agents.py --auth-check --agent orion-code` 本地验证认证与方法暴露。
6. [ ] 准备 16x16 单色 `icon.svg`。
7. [ ] 确保 `@orion-agents/orion-code` 已发版到 npm（版本与 `agent.json` 一致）。
8. [ ] Fork `agentclientprotocol/registry`，新建 `orion-code/` 目录，放 `agent.json` + `icon.svg`，提交 PR。
9. [ ] 合并后请在 Zed 的 ACP Registry 页面确认可一键安装，并验证自动版本更新。

---

## 8. 风险与注意事项

- **认证是硬门槛**：Registry CI 强制 `authMethods` 含 `agent`/`terminal`。若 Orion 当前完全免登录，必须先补一个 terminal 登录态/API key 路径，否则 PR 校验不过。
- **不要投资旧扩展路径**：Agent Server Extension 已被官方标注"最终会整体弃用"，且要求 WASM 沙箱编译，投入产出比差。
- **版本必须一致**：`agent.json` 的 `version` 要与 npm 发布版本、binary URL / npm `@version` 严格对齐；URL 不得含 `/latest/`。
- **stdio 协议细节**：JSON-RPC 2.0 的批处理、通知（无 `id`）与请求（有 `id`）要区分清楚；流式输出走 notification 而非阻塞响应，避免 Zed 端超时。
- **远程 Agent 支持仍在完善**：若未来要做云端 Orion，HTTP/WebSocket 传输尚未稳定，先以 stdio 本地子进程为主。
- **Registry 自动更新依赖发布源**：npx 分发会自动跟随 npm latest；若改用 binary，且无 `repository`，版本升级仍需手动 PR。

---

## 9. 参考链接

- Zed 官方博客《The ACP Registry is Live》（2026-01-28）：https://zed.dev/blog/acp-registry
- Zed ACP Extensions（弃用说明）：https://zed.dev/docs/extensions/agent-servers
- Zed 扩展开发总文档：https://zed.dev/docs/extensions/developing-extensions
- ACP Registry 页面：https://agentclientprotocol.com/registry
- ACP Registry 仓储（含 `agent.schema.json`、CONTRIBUTING.md）：https://github.com/agentclientprotocol/registry
- ACP 协议介绍 / 初始化 / 认证规范：
  - https://agentclientprotocol.com/get-started/introduction
  - https://agentclientprotocol.com/protocol/v1/initialization
  - https://agentclientprotocol.com/protocol/v1/authentication
- Registry 分发元数据 CDN：`curl https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
