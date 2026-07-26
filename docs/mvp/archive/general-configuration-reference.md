# Orion Code 配置说明

## 配置文件位置

```
~/.orion-code/orion.json
```

## 配置原则

**用户只需配置少量核心项**，其余参数由 Agent 智能控制。

## 用户配置项

| 字段 | 类型 | 环境变量 | 默认值 | 说明 |
|------|------|----------|--------|------|
| `apiKey` | string | `ORION_CODE_API_KEY` | `""` | LLM API Key |
| `apiBaseUrl` | string | `ORION_CODE_API_BASE_URL` | `(OpenAI 默认)` | API 地址 |
| `defaultModel` | string | `ORION_CODE_MODEL` | `gpt-4o` | 默认模型，按当前 `apiBaseUrl` 的模型 ID 原样传给 provider。 |
| `fallbackModel` | string | `ORION_CODE_FALLBACK_MODEL` | `(无)` | 备用模型（主模型过载时自动切换） |
| `toolConfirmation` | `allow` \| `deny` \| `ask` | `ORION_CODE_TOOL_CONFIRMATION` | `allow` | 工具需要确认时的兜底策略；`ask` 通过统一 runtime permission protocol 交给当前 renderer 展示 |
| `ui.confirmations` | `config` \| `interactive` | `ORION_CODE_UI_CONFIRMATIONS` | `config` | 工具确认由配置兜底，还是交给交互式 UI |
| `webSearch.provider` | string | `ORION_CODE_WEBSEARCH_PROVIDER` | `auto` | WebSearch 模式或 provider。`auto` 先 MCP 后 adapter；可设 `native`、`bailian`、`zhipu`、`tavily-mcp`、`tavily`、`brave`、`custom`、`ddg` |
| `webSearch.apiKey` | string | `ORION_CODE_WEBSEARCH_API_KEY` / provider env | 主 `apiKey` | WebSearch MCP 或 adapter API Key；未设置时 MCP 复用 Orion Code 主 API Key |
| `webSearch.endpoint` | string | `ORION_CODE_WEBSEARCH_MCP_ENDPOINT` | provider 默认值 | WebSearch MCP Streamable HTTP Endpoint |
| `webSearch.toolName` | string | `ORION_CODE_WEBSEARCH_MCP_TOOL` | 自动发现 | MCP 服务暴露多个工具时指定搜索工具名 |
| `webSearch.authType` | `bearer` \| `header` \| `query` \| `none` | `ORION_CODE_WEBSEARCH_AUTH_TYPE` | `bearer` | API Key 注入方式 |
| `webSearch.apiKeyHeader` | string | `ORION_CODE_WEBSEARCH_API_KEY_HEADER` | `Authorization` | `bearer` / `header` 模式下使用的 header 名 |
| `webSearch.apiKeyQueryParam` | string | `ORION_CODE_WEBSEARCH_API_KEY_QUERY_PARAM` | provider 默认值 | `query` 模式下使用的查询参数名 |
| `skills.paths` | string[] | `ORION_CODE_SKILLS_PATHS` | `[]` | 额外加载的 skills 根目录或单个 skill 目录 |

## Agent 内部控制（用户无需关心）

以下参数由 Agent 根据任务自动选择，**不暴露给用户配置**：

| 参数 | Agent 默认值 | 说明 |
|------|-------------|------|
| `maxTokens` | 8192 | 代码场景需要足够长输出 |
| `temperature` | 0.1 | 代码场景需要确定性输出 |
| `maxRetries` | 3 | 指数退避，自动调整 |
| `retryBaseDelay` | 500ms | 500ms → 1s → 2s → 4s |

## 内部标识（自动生成）

| 字段 | 说明 |
|------|------|
| `userId` | 用户唯一 ID（自动生成） |
| `firstStartTime` | 首次启动时间 |

## 运行状态文件

运行时统计不再写入 `orion.json`。它们由 Orion Code 自动维护在 `~/.orion-code/usage.json`，避免用户配置和状态计数混在一起。

| 文件 | 字段 | 说明 |
|------|------|------|
| `usage.json` | `totalSessions` | 累计会话数 |
| `usage.json` | `totalTokens` | 累计 token 消耗 |
| `usage.json` | `totalCost` | 累计费用 (USD) |

## 配置示例

### 最小配置（推荐）

```json
{
  "apiKey": "sk-xxx",
  "apiBaseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "defaultModel": "glm-5",
  "fallbackModel": "qwen-plus",
  "toolConfirmation": "allow",
  "skills": {
    "paths": [
      "~/project-skills/agents"
    ]
  }
}
```

## Skills

Orion Code 启动时会自动加载以下 skills 来源：

1. 内置 skills；
2. 用户级 `~/.orion-code/skills/<name>/SKILL.md`；
3. 配置项 `skills.paths` 或环境变量 `ORION_CODE_SKILLS_PATHS` 指定的额外路径；
4. 项目级 `<project>/.orion-code/skills/<name>/SKILL.md`。

优先级为：project > configured paths > user > builtin。

`skills.paths` 中的每一项可以是：

- skills 根目录，例如 `~/project-skills/agents`，其下包含多个 `<name>/SKILL.md`；
- 单个 skill 目录，例如 `~/project-skills/agents/coding-squad`。

`ORION_CODE_SKILLS_PATHS` 使用系统路径分隔符分隔多个路径；macOS/Linux 为 `:`，Windows 为 `;`。

### OpenAI

```json
{
  "apiKey": "sk-xxx",
  "defaultModel": "gpt-4o",
  "toolConfirmation": "allow"
}
```

### Openclaw 风格（可选）

你可参考本机 openclaw 的模型配置同步更新 Orion Code 的本地配置。Orion Code 不会自动读取 openclaw 的配置文件；仅作为迁移参考。

注意：openclaw 的 `bailian` provider 当前使用 `anthropic-messages` 协议；Orion Code 现有 LLM 客户端使用 OpenAI-compatible chat completions，所以应选择 openclaw 中 `api: "openai-completions"` 的 provider，例如 `astroncodingplan`。

示例同步后的 Orion Code 配置：

```json
{
  "apiBaseUrl": "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2",
  "defaultModel": "xopglm51",
  "fallbackModel": "astron-code-latest",
  "toolConfirmation": "allow"
}
```

### 本地 Ollama

```json
{
  "apiBaseUrl": "http://localhost:11434/v1",
  "defaultModel": "qwen2.5-coder:latest",
  "toolConfirmation": "allow"
}
```

## Tool Confirmation

`toolConfirmation` only applies when a tool returns `ask` from its permission
check and the session is in the default permission mode.

- `allow`: run the tool without prompting. This remains the default for local
  iteration and scripted use.
- `deny`: reject tools that would need confirmation while still allowing safe/read-only tools.
- `ask`: route confirmation through the shared runtime permission protocol.
  The stable `terminal` UI is the primary supported prompt path; beta `ink` and
  `tui` renderers also consume the same runtime event.

Tools that return `deny` from safety checks are still blocked regardless of this setting.

## UI

v0.2.9 起，默认启动路径是稳定的 scrollback terminal renderer。这是当前主力产品 UI。它使用轻量 raw editor 管理当前输入缓冲，但不进入 alternate screen，也不绘制会污染 shell scrollback 的全屏 overlay；中文提交文本、Backspace、运行中输入恢复、shell scrollback 和窗口历史都在普通终端窗口里工作。renderer-owned TUI 和 Ink/React UI 仍保留为显式 beta 实验模式。

- 默认启动 `orion`：使用稳定 scrollback terminal UI。
- `orion --ui terminal`：显式使用稳定 scrollback terminal UI。
- `orion --ui tui`：显式启用 renderer-owned TUI。它使用单一 input parser、frame model 和 terminal writer 管理输入、输出、overlay、状态栏和光标，适合继续验证高级交互。
- `orion --ui ink`：显式启用实验 Ink UI。中文 IME 场景请优先使用默认 terminal UI。
- `orion --ui legacy` / `orion --ui v2`：仅作为旧参数兼容入口，会回退到稳定 terminal UI；它们不是可配置 renderer。
- `ORION_CODE_UI` / `ORION_CODE_UI_RENDERER` 不再切换 renderer，避免 `.env` 或 `~/.orion-code.env` 遗留配置让默认启动误入实验 UI。
- `ui.confirmations: "config"`：工具确认沿用 `toolConfirmation` 兜底。
- `ui.confirmations: "interactive"`：预留给后续 permission dialog。
- `toolConfirmation: "ask"`：当前 renderer 通过统一 runtime permission protocol 处理确认；稳定 `terminal` 是主力验证路径，实验 `tui` / `ink` 仍只用于 beta 交互验证。

默认 terminal UI 当前支持：

- 轻量 raw editor 历史、光标移动、Backspace、中文提交文本和运行中输入恢复。
- `/` 命令补全和 `@` 项目文件补全。
- `/paste` 多行输入，`/end` 提交，`/cancel` 取消。
- 行尾 `\` 续行。
- `/edit` 使用 `$VISUAL`、`$EDITOR` 或 `vi` 编辑长输入。
- `/resume` session picker 打印完整候选列表，用户可输入序号、id 或名称恢复。
- agent 输出过程中可以继续输入普通文本作为修正目标；当前 turn 会中断，并以最新输入重启。
- 运行中的 slash command 不并发执行；需要先中断当前 turn。
- 两次 `Ctrl+C` 退出；运行中第一次中断当前 turn。
- 不清屏、不进入 alternate screen，终端 scrollback 保留完整输出。

renderer-owned TUI 当前支持：

- 底部受控输入框、CJK 输入、Backspace、Ctrl+U/Ctrl+W、Alt/手动多行输入。
- `/` 命令面板、Tab/Enter 补全或选择，完整命令可直接 Enter 提交。
- `@` 项目文件 picker，Tab/Enter 补全当前文件引用。
- `?` 快捷键 overlay，仅显示在 live frame 中，不写入 transcript。
- PageUp/PageDown 滚动查看 TUI 内部 transcript scrollback。
- `/resume` session picker 可滚动选择，session 行展示消息数和历史 size。
- agent 输出过程中继续输入会触发 live revision，中断当前 turn 并以最新目标重启。
- 两次 `Ctrl+C` 退出；运行中第一次中断当前 turn。

启动示例：

```bash
orion --ui terminal
orion --ui tui
orion --ui ink
```

## Print Mode

`-p` / `--print` 是后续非交互 renderer 目标的早期实验入口，适合验证脚本、CI、远程 harness 和管道调用需要的事件协议。它复用同一套 agent runtime，因此 tools、MCP、skills、session、harness 与交互模式一致；但它不是当前主力交互 UI，也不作为 v0.2.9 的完整自动化/remote UI 交付范围。

```bash
orion -p "review the current git diff"
echo "summarize this project" | orion --print
orion --print --output-format json "list next actions"
```

- 默认 `--output-format text`：assistant 内容输出到 stdout，状态和工具进度输出到 stderr。
- `--output-format json`：输出 `{ content, entries, statuses, errors, sessionId, model }`，方便上层程序读取。
- print mode 不渲染 banner、prompt、picker 或交互确认；需要选择 session 时请直接使用 `/resume <session-id>` 或 `/resume --last`。
- print mode 当前只保证确定性非交互行为；更完整的 automation/remote UI 能力留到后续迭代。

## Doctor Diagnostics

`orion doctor` 和 `/doctor` 会检查当前 coding-agent runtime 的关键能力，适合排查“模型不可用、MCP 工具没加载、skills 未触发、项目规则没入模、session 没恢复”等问题。

```bash
orion doctor
orion doctor --output-format json
```

检查项包括：

- API key、模型和 LLM 初始化状态。
- tool confirmation 与 UI confirmation 是否匹配。
- built-in tools 与 MCP tools 数量。
- `~/.orion-code/mcp.json` 是否存在、server 是否 connected/dead/disconnected。
- skills 数量与 auto-trigger 数量。
- `AGENTS.md`、`CLAUDE.md`、`.orion-code/instructions.md`、`.cursor/rules/*` 等项目规则是否加载。
- 当前 project session、harness objective、context size。

## Workspace Diff

`orion diff` 和 `/diff` 提供确定性的 Git 工作区摘要，不调用 LLM，不修改文件。它适合在 review、commit、PR、resume 后快速确认当前真实变更。

```bash
orion diff
orion diff --output-format json
/diff --max-files 80
```

报告包括：

- Git root、branch、HEAD、clean/dirty 状态。
- staged、unstaged、untracked 文件列表。
- staged/unstaged diff stat。
- 非 Git 目录会返回清晰的 not-a-git-repository 诊断。

## Commit Planning

`orion commit` 和 `/commit` 基于同一份 workspace diff 生成只读 commit plan 和建议消息。默认不会 stage、commit 或 push，适合作为提交前检查或给 LLM review 提供事实基础。

```bash
orion commit
orion commit --output-format json
/commit --max-files 50
```

报告包括：

- 建议 commit message。
- staged、unstaged、untracked 文件摘要。
- 是否 `Ready yes/no`：只有存在 staged 变更且没有 unstaged/untracked 时才是 ready。
- warnings 和 next steps，例如先 review untracked 或 stage intended files。

## MCP Servers

通用 MCP server 配置放在 `~/.orion-code/mcp.json`。当前版本支持 stdio transport，并把已连接 server 的工具暴露为普通 agent tool，命名格式为 `mcp__<server>__<tool>`。

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/hope/ai-project"],
      "env": {
        "EXAMPLE_TOKEN": "${EXAMPLE_TOKEN}"
      }
    }
  }
}
```

- `type` 可省略，默认等同 `stdio`。
- `command` / `args` / `env` / `cwd` 支持 `${ENV_NAME}` 环境变量展开。
- `disabled: true` 可临时跳过某个 server。
- 旧格式顶层 `servers` 仍兼容，但新配置建议使用 `mcpServers`。
- `/mcp` 查看连接状态；`mcp_list` / `mcp_call` 仍保留用于显式调试。

## WebSearch

`web_search` 参考 OpenClaude 的分层策略：`auto` 模式先调用当前模型 provider 对应的 WebSearch MCP；如果 MCP 不可用或被 provider 拒绝，再尝试 adapter 链。显式指定 `native` / `bailian` / `zhipu` / `tavily-mcp` 时只走 MCP；显式指定 `tavily` / `brave` / `custom` / `ddg` 时只走 adapter。

### MCP Profiles

Orion Code 内置 MCP provider profile，会根据 `apiBaseUrl` / model 自动推断：

| Provider | 匹配条件 | 默认 endpoint | 默认 Key |
|----------|----------|---------------|----------|
| `bailian` | `apiBaseUrl` 包含 `dashscope.aliyuncs.com` 或 `coding.dashscope.aliyuncs.com` | `https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp` | `ORION_CODE_WEBSEARCH_API_KEY` → `DASHSCOPE_API_KEY` → 主 `apiKey` |
| `zhipu` | `apiBaseUrl` 包含 `bigmodel.cn`，或非 DashScope 的 `glm*` 模型 | `https://open.bigmodel.cn/api/mcp/web_search_prime/mcp` | `ORION_CODE_WEBSEARCH_API_KEY` → `GLM_API_KEY` / `ZHIPU_API_KEY` / `BIGMODEL_API_KEY` → 主 `apiKey` |
| `tavily-mcp` | 显式设置 `webSearch.provider` / `ORION_CODE_WEBSEARCH_PROVIDER` | `https://mcp.tavily.com/mcp/` | `TAVILY_API_KEY`，通过 query 参数 `tavilyApiKey` |

通常不需要在 `~/.orion-code/orion.json` 里写 `webSearch`。如果当前模型 provider 的 MCP 接受同一个 key，Orion Code 会自动复用主 `apiKey`。

百炼普通 Key 可以通过环境变量覆盖：

```bash
export DASHSCOPE_API_KEY=sk-xxx
```

也可以使用 Orion Code 专用环境变量：

```bash
export ORION_CODE_WEBSEARCH_API_KEY=sk-xxx
```

### Adapter Fallbacks

`auto` 模式下 MCP 失败后会按顺序尝试 adapter：

1. `tavily`：需要 `TAVILY_API_KEY`
2. `brave`：需要 `BRAVE_API_KEY`
3. `custom`：需要 `ORION_CODE_WEBSEARCH_API` 或 `WEB_SEARCH_API`
4. `ddg`：DuckDuckGo HTML fallback，无需 key，但可能被限流或被网络环境阻断

示例：

```bash
export ORION_CODE_WEBSEARCH_PROVIDER=tavily
export TAVILY_API_KEY=tvly-xxx
```

只有需要覆盖 MCP provider、endpoint、toolName、headers 或鉴权方式时，才添加 `webSearch`：

```json
{
  "webSearch": {
    "provider": "bailian",
    "endpoint": "https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp",
    "apiKey": "sk-xxx",
    "authType": "bearer"
  }
}
```

实测：当前 `sk-sp` Coding Plan key 请求官方百炼 WebSearch MCP endpoint 返回 `401`，几个 `coding.dashscope.aliyuncs.com/.../WebSearch/mcp` 猜测路径返回 `404`。Orion Code 不会本地拦截 `sk-sp`；如果 provider 后续支持同一个 key，会直接工作，否则会返回真实 HTTP 错误并提示覆盖 `webSearch.provider` / `endpoint` / `apiKey`。

在默认 `auto` 模式下，上述 MCP 失败会继续走 adapter fallback；如果你希望严格只测 MCP，设置：

```bash
export ORION_CODE_WEBSEARCH_PROVIDER=native
```

## 配置加载优先级

```
命令行参数 > ~/.orion-code/orion.json > 环境变量 > Agent 内部默认值
```

## OpenClaude 参考

OpenClaude 的用户配置方式：
- `--model` / 设置 → 主模型
- `--fallback-model` → 备用模型（过载时自动切换）
- Provider Profile → apiKey + baseUrl + model 持久化
- 其余参数（temperature, max_tokens 等）由内部根据任务自动选择
