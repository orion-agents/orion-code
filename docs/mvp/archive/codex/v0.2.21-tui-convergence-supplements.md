# OpenHorse v0.2.21 TUI 规划评估与技术补充方案

在阅读并深度分析了 Codex 针对 `v0.2.21` 规划的 [TUI 能力收敛技术方案](file:///Users/hope/ai-project/openhorse/docs/codex/v0.2.21-tui-convergence-plan.md) 后，我们对该计划的合理性进行了系统评估，并在此基础上整理了若干项关键的技术补充与细化方案。

---

## 1. 总体合理性评估 (Reasonableness Evaluation)

Codex 提出的 `v0.2.21` TUI 规划是**非常合理且高度专业**的，精准地切中了高级终端交互在工程实践中的核心痛点。

### 核心亮点与合理设计：
1. **Primary-Screen Inline TUI 的产品决策**：
   *   *合理性*：这是该计划中最关键且最正确的决定。进入 Alternate Screen（类似 Vim 的全屏模式）会割裂开发者的正常命令历史流，使他们无法使用终端原生的滚动（Scrollback）和复制。通过将已完成的消息（Finalized Entries）直接 append 进终端的 stdout，同时在底部维护一个限定高度的 Live Region（显示状态、多行输入、工具执行详情），能完美复用终端原生的滚动与选择。
2. **去 React / 去 Yoga 的解耦路线**：
   *   *合理性*：React 运行时在 CLI 环境下有额外的渲染心跳和状态管理开销；Yoga 布局引擎对终端 resize 的处理极易发生清屏或位置错乱。采用纯 TypeScript 实现的 frame/cell/SGR span 缓存与增量 layout 极大地降低了系统复杂度，并使 UI 渲染逻辑变得高度可测。
3. **对事件驱动和 UI-Runtime 边界的坚守**：
   *   *合理性*：TUI 仅仅是一个从事件源（`AgentRuntimeController`）读取状态的 Renderer，不染指 Session 存储、MCP 机制、权限审批策略等核心逻辑。这极大地保证了系统的底层稳定性。

---

## 2. 关键技术补充方案 (Technical Supplements & Refinements)

虽然总体框架十分严密，但在**工具输出色彩保留、窗口 Resize 性能、子进程集成安全、交互可观测性**等细节上，建议补充以下具体技术设计：

### 补充一：针对工具输出 (Tool Outputs) 的轻量级 ANSI-to-Style 解析器
*   **挑战描述**：方案提到“模型与工具输出中的 ANSI 必须 sanitize，以防止 ANSI 污染 frame 布局”。但是，很多外部工具（例如 `jest`、`eslint`、甚至编译脚本）会输出标准的 SGR ANSI 彩色逃逸码（如红色代表测试失败、绿色代表通过）。如果一律将其暴力 sanitize 抹除，用户将丢失最直观的代码状态反馈（如测试红绿灯）。
*   **补充方案**：
    *   在 `src/runtime/rich-text/sanitizer.ts` 中设计一个**轻量级 SGR 解析器**。
    *   它不需要支持复杂的控制字符（如光标移动），仅对基本的文本渲染样式 SGR 逃逸码（`\x1b[30m` 到 `\x1b[39m`，以及 `\x1b[1m` 粗体、`\x1b[2m` 暗淡等）进行解析。
    *   在工具流输出时，将原始文本转换为 `StyledRow` 或 `StyledSpan[]` 数组，最终送给 layout 引擎。这样既隔离了原生 ANSI 对 frame 的绝对坐标污染，又完美保留了外部工具的色彩和样式。

```typescript
// 建议在 sanitizer 中增加的转换接口
export interface AnsiParser {
  parse(rawText: string): StyledSpan[];
}
```

### 补充二：窗口 Resize 的防抖与信号抑制机制 (Resize Debouncing)
*   **挑战描述**：用户在拉伸终端窗口时，操作系统会高频触发 `SIGWINCH` 信号。如果 TUI 对每一次 resize 信号都立即重新进行 Layout Budget 预算计算、重建 visual layout cache 并进行重绘，在复杂的 Markdown 渲染或长 Timeline 存在时，很容易导致绘制积压，出现屏幕严重闪烁或 CPU 占用瞬时飙升。
*   **补充方案**：
    *   在 TUI 交互监听器中对 `resize` 动作引入 **50ms - 100ms 的防抖机制（Debounce）**。
    *   只有在窗口尺寸稳定后，才触发一次性的缓存清除和 Live Region 重绘。防抖期间，TUI 可暂时锁定当前输入，或显示临时的尺寸调整中状态。

### 补充三：子进程挂起 (Suspend) 期间的 Bracketed Paste 状态显式控制
*   **挑战描述**：为防止用户长文本粘贴时自动触发 command/prompt 提交，TUI 默认会开启 Bracketed Paste 模式（允许用户一次性粘贴多行内容并能安全进行二次编辑）。然而，当 TUI 调起外部交互式编辑器（例如用户通过 `$EDITOR` 唤起 Vim 或 Nano 进行冲突解决或编辑预览时），这些子进程可能不期望或无法妥善处理 Bracketed Paste。
*   **补充方案**：
    *   在 `TuiTerminalSurface.suspend()` 执行时，必须显式发送 **禁用 Bracketed Paste** 的终端逃逸序列：`\x1b[?2004l`。
    *   在子进程退出、触发 `TuiTerminalSurface.restore()` 时，重新开启 Bracketed Paste：`\x1b[?2004h`。
    *   这保证了被挂起的 TUI 在移交 TTY控制权时不会污染子进程的输入行为。

### 补充四：双重 Ctrl+C 中断状态的可视化反馈 (Ctrl+C Visual Affordance)
*   **挑战描述**：方案设计为“第一次 Ctrl+C 终止当前运行的 Task/Turn，第二次 Ctrl+C 直接强制退出系统”。在实际交互中，如果大模型正在流式输出，用户按下第一次 Ctrl+C 时，底层终止操作可能由于清理网络连接或等待正在执行的 Tool 释放锁而有几百毫秒的延迟。用户若看不到反馈，会误以为 Ctrl+C 无效，极易连续敲击导致直接意外退出了整个 OpenHorse CLI 会话。
*   **补充方案**：
    *   当第一次 Ctrl+C 信号被捕获且触发 `status = 'aborting'` 时，底部状态栏（Status Bar）必须立即闪烁并渲染明显的黄色警告标识：
        *   `[⚠️ Interrupting... Press Ctrl+C again to force exit]`
    *   这能有效防止用户过度狂躁敲击键盘而导致非预期的物理退出。

### 补充五：环境规范（NO_COLOR 与 FORCE_COLOR）的标准化解析
*   **挑战描述**：业界目前有统一的 `no-color.org`（支持 `NO_COLOR` 环境变置来完全隐去彩色控制）以及 `FORCE_COLOR` 规范。
*   **补充方案**：
    *   TUI 在启动和解析 `NO_COLOR` / `FORCE_COLOR` 时，统一在 `src/runtime/` 层做环境变量解析。
    *   当 `NO_COLOR` 被设定时，TuiColor 转化逻辑自动将前景色、背景色归一化为 undefined（退化到终端默认前/背景色），仅保留粗体或下划线样式。

---

## 3. 补充实施步骤推荐 (Recommended Next Steps)

建议在 Codex 规划的 `P0 实施切片` 中插入以下具体的开发任务：

*   **在切片 1 (Shared Composer Core) 时**：把 `NO_COLOR` 的环境变量检测和光标防抖的共享计时器直接在 `src/runtime/` 中设计完毕。
*   **在切片 2 (Styled Frame & ANSI Writer) 时**：编写专门的单元测试，验证含有 Jest 彩色输出的 ANSI 串经过 Sanitizer 转换后，能够正确映射为带有 `TuiColor` 信息的 `StyledSpan` 序列。
*   **在切片 9 (Teardown & Crash Safety) 时**：加入 PTY 模拟测试，测试在 Vim 子进程拉起和退出时，Bracketed Paste 逃逸码的开启与关闭是否如预期被执行。
