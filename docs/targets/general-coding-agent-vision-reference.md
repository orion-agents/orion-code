# Orion Code 一流 Coding-Agent 终极目标企划书

## 文档状态

- 状态：Target / North Star
- 日期：2026-06-19
- 目标版本区间：v0.2.x 之后持续演进
- 核心目标：将 Orion Code 打造成与 Codex、Claude Code 比肩的一流 coding-agent。

## 北极星

Orion Code 的终极形态不是“会聊天的 CLI”，而是一个能持续理解用户目标、读懂真实工程、规划并执行代码变更、验证结果、沉淀上下文、可被安全扩展的专业 coding-agent。

它应当做到：

- 像资深工程师一样理解代码库、拆解任务、执行修改、验证结果。
- 在长会话、多次打断、compact、resume 后仍然抓住用户核心目标。
- 让工具、MCP、skills、session、memory、permissions 成为统一 runtime 能力，而不是 UI 附属逻辑。
- 提供稳定、专业、低干扰的 CLI UI，支持长输出、中文输入法、多行输入、实时修正、会话恢复和工具执行观察。
- 保持本地优先、可审计、可配置、可扩展；远程、自动化和团队工作流作为后续演进目标接入同一 runtime。

## 调研摘要

Codex 官方最佳实践强调：强 coding-agent 需要清晰任务上下文、可复用项目指导、MCP 外部系统、skills 复用流程、自动化稳定工作流，以及测试和 review 闭环。Codex CLI 还提供交互 TUI、resume、模型切换、web search、MCP、permissions、review、cloud/exec 等能力。

Claude Code 官方将核心抽象为 agentic loop：收集上下文、采取行动、验证结果，并可被用户随时打断和修正。其工具能力覆盖文件、搜索、命令执行、web、代码智能；其会话能力覆盖本地 JSONL、resume/fork、context compact、CLAUDE.md、memory、skills、subagents、permissions 和 checkpoints。

对 Orion Code 的启发是：一流 coding-agent 的竞争力不只在模型，而在 harness、工具、上下文、验证、安全、UI 和可扩展生态的系统工程。

## 能力目标

### 1. 专业编码能力

Orion Code 必须能完成完整工程闭环，而不仅是生成片段。

- 代码库探索：快速识别架构、模块边界、关键路径、测试入口和运行方式。
- 代码修改：可靠读写、精确编辑、跨文件重构、迁移 API、补齐类型、更新文档。
- 调试能力：复现错误、读取日志、定位根因、提出方案、执行修复、回归验证。
- 测试能力：识别测试框架，生成最小有效测试，运行相关测试，解释失败并修复。
- Review 能力：按严重程度输出 bug、回归风险、安全风险和测试缺口。
- Git/PR 能力：检查 diff、拆分提交、生成 PR 描述、处理 review feedback。

验收标准：复杂任务结束时必须有“做了什么、验证了什么、风险是什么”的清晰收束；不能只停在建议。

### 2. 用户意图理解与 Harness

Orion Code 要有稳定的任务 contract，而不是把最新一句话粗暴当作全部目标。

- 维护 `rootObjective`、`activeInstruction`、constraints、non-goals、open questions、verification state。
- 区分新任务、补充、纠错、验证、配置、闲聊反馈。
- 短反馈如“继续”“不对”“灰色填充”不得覆盖根目标。
- 基于当前输入动态组装 prompt：核心目标优先，其次约束、计划、证据、最近 turn。
- compact/resume 后必须恢复任务语义，而不是只恢复聊天文本。
- 支持 `/harness` 和 `/harness explain` 解释当前入模上下文和舍弃原因。

验收标准：20+ 轮长会话后输入“继续”，agent 仍能接上正确任务、文件和下一步。

### 3. Prompt 组装与上下文预算

Prompt 不是固定模板，而是预算化上下文装配。

- 分层上下文：system policy、repo guidance、skills、MCP/tool facts、session capsule、turn summaries、ranked evidence、recent messages。
- 证据索引：工具结果、文件路径、验证输出、用户要求、决策记录都应转为可评分 evidence。
- 预算策略：核心目标和约束永不被低价值历史挤出；工具长输出默认摘要化。
- 可观测性：每轮记录 assembly stats，说明哪些 evidence 入模、哪些被省略。

验收标准：prompt assembly 可测试、可解释、可回放。

### 4. 专业工具系统

工具是 coding-agent 的手和眼，必须专业、可控、可扩展。

- 内置工具：文件读写、glob、grep、shell、git、LSP、diagnostics、web、todo、plan、memory。
- 工具协议：统一 schema、权限元数据、风险等级、超时、取消、重试、结果摘要。
- 工具执行：严格按序记录 tool call/result，支持 abortSignal，失败时给出可行动错误。
- 安全策略：命令白名单/黑名单、危险命令提示、网络与文件系统权限 profile。
- 结果回传：UI 展示摘要，session 保存结构化结果，harness 保存可用 evidence。

验收标准：任意 UI 下工具行为一致，且工具事件顺序不乱。

### 5. CLI UI 与交互体验

CLI UI 是 coding-agent 的工作台，不应污染 runtime。

- 保持 UI/runtime 分离：terminal、ink、tui、print、future remote 只作为 renderer adapter。
- 输入体验：中文 IME、Backspace、软换行、多行输入、历史搜索、Tab 补全稳定。
- 运行中交互：输出流式展示时输入框常驻，可输入修正目标；Ctrl+C 首次中断，二次退出。
- Transcript：完整保留可见历史；overlay、picker、help 不进入对话历史。
- Markdown：标题、列表、表格、代码块、diff、工具结果、错误块有清晰层级。
- Session picker：可滚动、显示 size、项目归属、名称、更新时间，支持搜索和直接 ID。
- Resize：窗口宽度变化后不串屏、不重复 status、不污染 scrollback。

验收标准：CLI 长时间使用仍保持可读、可输入、可恢复、可审计。

### 6. Session、Memory 与 Project Guidance

Orion Code 必须记住该记住的东西，也必须知道什么不该塞进上下文。

- Session 存储在 `~/.orion-code/`，按 projectKey 隔离，支持多 session picker、rename、冲突提示、恢复指定 session。
- Transcript 与 harness sidecar 分离：聊天历史、任务状态、证据索引、turn summaries 独立持久化。
- 支持 compact：自动/手动 compact 输出结构化 state，再输出自然语言 summary。
- 支持 project guidance：`AGENTS.md`、Orion Code 自有指导文件、skills 说明按层级加载。
- Memory：保存稳定偏好、项目事实和反复出现的决策，避免保存秘密和短期噪声。

验收标准：resume 后能看到应显示的历史，并能继续正确任务；compact 前的旧细节可不展示但语义要保留。

### 7. Skills、MCP、Hooks 与插件生态

Orion Code 要从“单体 CLI”进化为可扩展 agent platform。

- Skills：支持 repo/user/system scope，metadata 轻量入模，按需加载 `SKILL.md`、references、scripts。
- MCP：支持 stdio/http MCP server，工具发现、资源读取、prompts、auth、tool approval policy。
- Hooks：支持 pre-tool、post-tool、pre-submit、post-turn、session lifecycle hooks。
- Plugins：长期目标支持打包 skills、MCP 配置、hooks、assets、commands。
- Subagents：为 research、review、test、security、docs 等任务提供隔离上下文的专业子代理。

验收标准：新增外部能力不需要改 query 内核，只需要注册到 runtime capability layer。

### 8. 安全、权限与可恢复性

专业 coding-agent 必须默认可控。

- 权限模式：read-only、workspace-edit、auto、full-access，支持项目配置和命令行覆盖。
- 文件权限：workspace roots、deny secrets、deny glob、外部路径审批。
- 网络权限：disabled/cache/live/allowlist，web 内容默认不可信。
- Checkpoint：关键文件编辑前创建可恢复快照；支持撤销到某个 turn。
- Git safety：不覆盖用户未提交改动；提交前显示 diff；禁止隐式 destructive command。
- Secret hygiene：不把密钥写进 session、日志、prompt stats 或错误报告。

验收标准：用户能理解 agent 即将做什么，也能回滚 agent 已经做过什么。

### 9. 自动化、远程与团队工作流

一流 coding-agent 不只服务交互式本地会话。

- Non-interactive：长期目标是提供 `orion exec` / print renderer，输出机器可读 JSON，适合 CI 和脚本；当前 v0.2.x 只把它作为后续 renderer 目标和协议验证方向。
- Remote control：UI 和 runtime 通过事件协议分离，为后续远程 TUI/web/Telegram 等入口留接口；远程入口不得复制 agent/harness/tool/session 逻辑。
- GitHub 工作流：PR review、CI failure fix、commit plan、release notes 自动化。
- Scheduled tasks：支持定时检查、回归测试、依赖升级提醒。
- Team policy：支持项目级配置、组织级默认、安全策略和 shared skills。

验收标准：本地 CLI、脚本、远程入口共用同一 runtime 行为。

## 目标架构

```text
UI Renderers
  terminal stable / ink beta / tui beta / print future / remote future
        |
        v
UI Event Protocol
  input, interrupt, picker decision, permission decision
  assistant delta, tool event, status, error, transcript event
        |
        v
Agent Runtime Core
  turn controller / command dispatch / query runner / tool executor
        |
        v
Harness & Context Engine
  intent, evidence, prompt assembly, compact, resume reconciliation
        |
        v
Capabilities
  built-in tools / MCP / skills / hooks / subagents / memory / session
```

核心原则：

- UI 不决定 agent 能做什么。
- Tool 不直接污染 UI 或 session；通过 runtime event 汇报。
- Harness 不依赖某个 renderer。
- Session 不只是 transcript，而是可恢复的任务状态。
- 新能力优先进入 runtime，再由各 UI adapter 暴露。

## 路线图

### Phase 1：Runtime 边界完成

- 统一 terminal/ink/tui 的 turn controller；print 作为早期非交互协议验证路径，remote 保持后续目标。
- 统一 `AgentRuntimeEvent` 与 `AgentRuntimeInput`。
- 消除 UI 内重复实现的 live revision、Ctrl+C、session restore、permission 逻辑。
- 建立 renderer parity tests。

### Phase 2：Harness v3

- 引入更完整的 evidence index 和 prompt assembly stats。
- compact/resume 做结构化 reconcile。
- `/harness explain` 输出可读诊断。
- 将工具结果、验证结果、用户约束都纳入评分。

### Phase 3：工具与权限专业化

- 工具 schema、风险等级、超时、取消、审批策略统一。
- shell/git/LSP/web/MCP 事件结构化。
- 权限 profile 与项目配置落地。
- checkpoint 与撤销能力落地。

### Phase 4：CLI UI 专业化

- Terminal UI 作为主力稳定 renderer：完整 scrollback、可靠中文 IME、Backspace、软换行、多行输入、session picker、markdown 和工具事件展示。
- Ink / TUI 作为实验 beta renderer：用于验证 React 组件化、alternate-screen、精确 cursor、resize、overlay 等方案，不作为默认产品路径，不能影响 terminal 稳定性。
- Print mode 作为后续非交互 renderer：面向 CI、脚本、日志和机器可读 JSON 输出。
- Remote UI 作为后续远程入口：通过 runtime event protocol 接入，不复制 agent/harness/tool/session 逻辑。
- 建立 PTY smoke、golden frame、IME/backspace、tool order、renderer parity 回归测试。

### Phase 5：生态与团队化

- Skills 全链路：发现、触发、加载、依赖、验证。
- MCP 全链路：stdio/http/auth/tool policy/resources/prompts。
- Hooks 与插件机制。
- Subagents 与多工作区任务。
- GitHub/CI/remote/automation，但必须通过同一 runtime/event protocol 扩展。

## 一流标准

Orion Code 达到目标时，应满足：

- 用户给模糊目标，Orion Code 能主动探索、澄清、计划并执行。
- 用户多次中断修正，Orion Code 不跑偏，且 session 不被污染。
- 用户退出、compact、resume 后，Orion Code 仍知道核心目标和下一步。
- 工具调用有序、可取消、可审计、可复现。
- UI 长时间使用不串屏、不丢历史、不影响 agent 行为。
- 项目约定、skills、MCP、memory 能自然参与任务，不挤爆上下文。
- 每个版本都有自动化测试覆盖 runtime、harness、tools、UI renderer 和 PTY 行为。
- 任何新 UI 或远程入口接入后，agent 实质能力不发生分叉。

## 参考资料

- OpenAI Codex Best Practices: https://developers.openai.com/codex/learn/best-practices
- OpenAI Codex CLI Features: https://developers.openai.com/codex/cli/features
- OpenAI Codex Agent Skills: https://developers.openai.com/codex/skills
- OpenAI Codex MCP: https://developers.openai.com/codex/mcp
- OpenAI Codex Permissions: https://developers.openai.com/codex/permissions
- Claude Code How It Works: https://code.claude.com/docs/en/how-claude-code-works
- Claude Code Common Workflows: https://code.claude.com/docs/en/common-workflows
- Claude Code Memory: https://code.claude.com/docs/en/memory
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Claude Code Hooks: https://code.claude.com/docs/en/hooks
