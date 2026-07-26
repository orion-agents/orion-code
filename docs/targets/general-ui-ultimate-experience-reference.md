# Orion Code UI 终极体验目标

状态：面向 v0.2.14 及后续版本的目标文档

这份文档的目标不是做一轮简单的界面美化，而是定义 Orion Code CLI UI 的长期验收标准。Orion Code 的 UI 应该成为一个专业、稳定、可审计的 coding-agent 工作台：长会话不丢上下文，中文输入稳定，工具执行过程清楚，终端历史完整保留，并且 UI 表现层不能影响 agent 内核行为。

当前主力产品界面是稳定的 `terminal` 渲染器。`tui` 和 `ink` 继续作为 beta 实验界面，用来验证全屏布局、组件化渲染、精确光标、复杂 overlay 等方向。`print` 和远程 UI 是后续扩展入口，也必须复用同一套 runtime 协议。

## 当前 UI 基线

- `terminal` 是稳定默认路径。它以终端滚动历史为核心，不使用全屏 alternate screen，保留 shell 历史，负责日常输入编辑、多行粘贴、`$EDITOR` 编辑、命令补全、会话选择和终端权限确认。
- `tui` 是 beta 级全屏渲染实验路径。它适合验证更专业的终端布局、窗口 resize、overlay 和 frame 管理，但不能拥有另一套 agent runtime。
- `ink` 是 beta 级 React/Ink 实验路径。它适合验证组件化状态栏、Transcript、PromptInput 和布局模型，但在原生光标、窗口变化、中文输入法和滚动历史方面风险更高。
- 共享边界已经存在：`AgentRuntimeInput`、`AgentRuntimeEvent`、`OpenHorseUiRuntime` 和 renderer adapter。后续 UI 工作必须扩展这条边界，不能把 agent 逻辑搬进某个 UI。

## 核心目标

Orion Code 的稳定终端 UI 最终要达到这几个目标：

- 用户可以粘贴、编辑、中断、恢复、继续任务，而且不会丢状态。
- 长输出仍然能在终端滚动历史中完整查看和搜索。
- 工具调用按真实发生顺序展示，并提供足够信息用于审计。
- 状态信息默认克制，但需要诊断时可以展开。
- UI 出问题不能改变模型、工具、harness、memory、session、permission、MCP 或 skills 的行为。

一句话总结：UI 是 agent 的工作台，不是 agent 的大脑。Orion Code 要先把稳定终端体验做到专业，再让 `tui`、`ink`、`print`、远程 UI 通过同一套协议逐步追平。

## 产品原则

### 一个 runtime，多种界面

Agent loop、工具、权限、会话存储、harness、compact、memory、skills、MCP 和 loop budget 都属于 runtime。UI 只能负责输入采集、状态展示、选择交互和视觉组织。

### Terminal 优先

发布质量以 `terminal` 为准。`tui` 和 `ink` 可以探索更复杂的表现方式，但在输入稳定性和 runtime parity 达标前，不能作为默认产品路径。

### 终端滚动历史是产品能力

稳定终端 UI 不能清屏，不能重复打印 prompt/status，不能污染 transcript，不能隐藏重要历史。compact 可以隐藏旧细节，但必须保留任务语义。

### 中文输入是一等能力

中文输入法、CJK 宽度、emoji 宽度、Backspace、软换行、多行粘贴、历史导航、光标定位都属于发布门槛，不是后续 polish。

### Overlay 不能污染对话记录

快捷键说明、picker、权限提示、补全列表、状态刷新都不能写成假的用户消息或 assistant 消息。它们应该是 UI 状态，或者是明确的系统提示。

### 时间顺序不可破坏

assistant 输出、工具开始、工具结束、错误、验证、用户修正必须按照真实发生顺序展示。UI 可以折叠细节，但不能重排时间线。

## 目标体验

### 启动体验

- 展示简洁 banner，包含版本、模型/服务商、项目、会话、renderer 和已加载能力。
- 不清空 shell 历史。
- 只显示一条明确的 ready 信息，避免重复 status 行。
- 配置错误、skills 加载失败、MCP 异常、模型路由问题要给出可操作诊断。

### 输入体验

- 支持中文输入法、CJK 宽度、emoji 宽度、Backspace、Delete、Home、End、Ctrl+U、Ctrl+W、方向键和历史导航。
- 多行输入必须可靠：`/paste`、`$EDITOR`、bracketed paste、检测到的多行粘贴都只能提交一次。
- Tab 补全覆盖 slash command 和 `@file` 路径，并且不污染 transcript。
- 长输出、窗口变化、运行中修正后，prompt 位置仍然稳定。

### 运行中体验

- 用紧凑的运行状态替代裸露的 `Turn N...`，明确区分思考、读取、执行、验证、compact、等待权限等状态。
- 模型或工具运行时允许用户输入修正目标。第一次 Ctrl+C 中断当前 turn，短时间内第二次 Ctrl+C 退出进程。
- 被中断的 assistant partial 输出不能作为正式 assistant 消息持久化，除非 runtime 明确标记为可持久化。
- 触发 loop budget 时，要说明具体预算、当前进度和推荐的下一步，而不是只说停止。

### 工具时间线

- 每个工具调用都按顺序展示：排队、运行、完成、失败、跳过。
- 终端宽度足够时，默认展示完整命令和路径；如果被截断，必须提供确定方式查看完整内容，例如 `/last-tool`、`/loop-stats`、artifact 链接或 transcript detail。
- 长工具输出在 transcript 中摘要展示，完整输出保存在 session/artifact 中。
- runtime 做只读工具批量化时，UI 应该显示成一个分组操作，而不是刷屏式单工具列表。

### 对话记录展示

- Markdown、代码块、表格、diff、错误块、命令摘要要稳定换行，颜色克制。
- 不要给每一段内容都加装饰性边框。边框只用于命令输出、diff、权限提示等明确分组内容。
- 用户输入、assistant 回复、工具摘要、resume 标记要作为不同 transcript entry 展示。
- renderer 本地帮助信息、picker、status refresh 不进入 durable session history。

### 状态和诊断

- 默认状态栏只保留必要信息：模型、会话、tokens/context、cost、运行状态、权限模式。
- 详细信息通过 `/status`、`/loop-stats`、`/harness`、`/skills`、`/mcp`、`/doctor` 展开。
- 诊断必须区分层级：renderer、runtime、provider、tool、session、memory、MCP、skills。不能把 UI resize bug 说成 agent-loop 问题。

### Picker 和权限交互

- command、session、model、file、edit-preview、permission picker 都走共享 runtime 协议。
- session picker 支持分页、搜索、id 前缀、全局序号、标题匹配、size、project 和 `/resume --last`。
- 权限提示必须展示工具名、命令/路径范围、cwd、风险等级和可选操作。

### Resume 和 Compact

- `/resume` 要从 durable session entry 恢复可见 transcript。
- compact 可以移除旧细节，但当前目标、约束、下一步、验证状态和未解决问题必须通过 harness state 保留下来。
- compact 后再 resume，用户输入“继续”时，必须接上正确的 root objective。

### 窗口变化和终端行为

- 终端宽度变化后，prompt 和 status 要重新排版，不能重复打印、串行、错位。
- 窄终端优先隐藏低优先级状态字段，而不是破坏布局。
- PTY 测试必须覆盖 resize、长输出、中文输入、多行粘贴、picker、运行中修正和工具顺序。

## 架构目标

```text
用户输入
  -> Renderer Adapter（terminal 稳定 / tui beta / ink beta / print 后续 / remote 后续）
  -> AgentRuntimeInput
  -> Agent Runtime Core
       -> query / tools / harness / session / memory / MCP / skills / permissions
  -> AgentRuntimeEvent
  -> Renderer Adapter
  -> UI View
```

下一步应稳定一套 renderer 无关的 UI View Model：

- `TranscriptBlock`：用户、assistant、工具、错误、系统标记、resume 标记。
- `ToolActivity`：调用 id、工具名、参数摘要、状态、输出摘要、artifact 指针、耗时、顺序编号。
- `PromptState`：输入 buffer、光标、模式、补全候选、历史状态。
- `PickerState`：命令、会话、模型、文件、权限、编辑预览。
- `StatusSnapshot`：模型、会话、成本、tokens、ctx、loop budget、MCP、skills、权限模式、运行状态。

renderer 应该渲染 View Model，而不是从原始字符串里反推 agent 语义。

## 非目标

- 不把 agent-loop、permission、session、memory、skills、MCP、harness 逻辑搬进 `terminal`、`tui` 或 `ink`。
- 不在 `ink` 或 `tui` 达到输入可靠性和 runtime parity 前设为默认。
- v0.2.x 不强制 Rust/native rewrite。
- 稳定 `terminal` 渲染器不清空 shell scrollback。
- 不通过改模型 prompt 或工具语义来掩盖 UI 渲染问题。

## 分阶段路线

### 第一阶段：Terminal 体验打磨

- 清理运行状态展示。
- 改善完整命令展示和长输出查看。
- 保证长输出、resize、live revision 后 prompt 稳定。
- 增强 CJK、paste、resize、工具顺序的 PTY 覆盖。

### 第二阶段：Transcript 和工具详情

- 引入结构化 transcript/tool view model。
- 增加长命令和长工具输出的折叠摘要。
- 增加 `/last-tool` 或等价的工具详情查看命令。
- 确保 session 持久化和 resume 使用同一份 durable event 数据。

### 第三阶段：输入和 Picker 精进

- 强化多行、paste、`$EDITOR`、历史搜索、Tab 补全、`@file`、slash palette、session picker、permission picker。
- 尽量统一 terminal、TUI、Ink 的键盘模型。

### 第四阶段：Renderer Parity

- 让 `tui` 和 `ink` 通过 command input、permission decision、session picker、live revision、tool ordering、transcript restoration 的 parity 测试。
- 在 CJK 输入、光标、resize、scrollback 预期明确达标前，继续保持 beta。

### 第五阶段：Print 和 Remote UI

- 增加面向脚本和 CI 的确定性 `print` / exec 输出。
- 增加远程 UI 协议支持，但不能复制 agent runtime 行为。
- 远程客户端只作为同一事件流上的 renderer adapter。

## 验收标准

- `npm test -- --runInBand tests/runtime-ui-parity.test.ts tests/terminal-ui.test.ts` 通过。
- PTY smoke 覆盖 terminal 启动、中文输入、多行粘贴、resize、`/resume`、权限提示、Ctrl+C 中断和工具时间线顺序。
- 手动长会话测试中，终端 scrollback 和 durable resume history 都可用。
- UI renderer 变更不能改变模型 prompt、工具可用性、session 持久化、harness state 或权限决策；如果必须改变，需要 runtime 测试同步表达这个意图。
- 用户可见错误必须说明错误层级：renderer、runtime、provider、tool、session、memory、MCP 或 skills。
