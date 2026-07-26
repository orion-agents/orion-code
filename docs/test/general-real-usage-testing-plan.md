# Orion Code 真实使用测试技术方案

## 目标

真实使用测试用于验证 Orion Code 在开发者日常工作流中的稳定性，而不是只验证单个函数或 mock 场景。重点覆盖：

- CLI UI 是否可连续使用，不清屏、不串屏、不污染对话历史。
- agent loop 是否能完成真实编码任务，并控制不必要的模型交互。
- tool、session、harness、memory、MCP、skills 是否在同一项目上下文中协同工作。
- 长会话、窗口变化、中文输入、多行粘贴、resume/compact 后是否仍能保持可用。

本方案用于经验传递：后续每个 UI 或 runtime 版本都应按此方案抽样执行。

## 测试分层

### 1. 自动化基线

先跑自动化，确认基础能力没有明显回归：

```bash
npm run build
npm test -- --runInBand tests/ink-ui.test.ts
npm test -- --runInBand tests/ink-ui-pty.test.ts
npm test -- --runInBand tests/runtime-ui-parity.test.ts tests/runtime-ui-view-model.test.ts tests/terminal-ui.test.ts
python3 -m py_compile scripts/ink-ui-pty-smoke.py scripts/terminal-ui-pty-smoke.py
git diff --check
```

如修改了 session、harness、compact、tool scheduler，再追加：

```bash
npm test -- --runInBand tests/session-commands.test.ts tests/session-storage.test.ts
npm test -- --runInBand tests/harness.test.ts tests/harness-intent.test.ts tests/compact.test.ts
npm test -- --runInBand tests/tool-scheduler.test.ts tests/query.test.ts tests/tools.test.ts
```

### 2. Mock PTY 交互

Mock PTY 用于稳定复现 UI 行为，不依赖真实模型：

```bash
npm test -- --runInBand tests/ink-ui-pty.test.ts
```

必须观察这些断言是否覆盖：

- CJK 输入、删除、光标位置。
- 多行 paste 不提前提交。
- slash palette、permission picker、session picker 不进入 transcript。
- streaming 中输入 revision 不导致 tool 或 assistant 输出乱序。
- resize 后只保留一个 prompt frame，不出现重复 status、残缺边框或 prompt/transcript 交叠。

### 3. 真人真实终端测试

使用 macOS Terminal、iTerm2 或用户主力终端直接运行：

```bash
npm run start
npm run start -- --ui ink
```

如需保存证据，可用：

```bash
script -q /tmp/orion-real-test.log npm run start
```

注意不要把 API key、完整私有路径、未脱敏 tool output 提交到仓库。

## 真实任务矩阵

每轮版本至少覆盖以下任务：

| 场景 | 操作 | 通过标准 |
| --- | --- | --- |
| 普通问答 | 输入一句中文问题 | 输出完整，prompt 可继续输入 |
| CJK 编辑 | 输入中文、左右移动、删除、继续输入 | 候选词和光标不明显错位，Backspace 不吞字符 |
| 多行输入 | 使用 paste 或 `/paste` 输入 5-20 行 | 不被拆成多次提交，显示不覆盖 |
| 窗口变化 | 输出过程中拖窄、拖宽、连续 resize | 不出现重复 status、残缺边框、错位 prompt、历史串行 |
| 长输出 | 要求生成长报告或读取较大文件 | scrollback 可查看，prompt 不丢失 |
| 工具顺序 | 要求读取多个文件、运行测试 | tool call 按实际顺序展示和持久化 |
| 运行中修正 | agent 输出时输入新目标 | 当前 turn 被中断或重启，session 不写入错误 partial |
| `/resume` | 恢复最近和指定 session | 可见历史、harness state、session meta 一致 |
| compact 后继续 | 长会话触发 compact 后输入“继续” | 仍接上 root objective 和 next action |
| 失败命令 | 运行一个必然失败的命令 | 错误层级清楚，不把失败描述成成功 |
| 权限请求 | 触发写文件或 shell 风险命令 | allow/deny 后 UI 状态和 transcript 一致 |
| skills/MCP | 使用已配置 skill 或 MCP tool | agent 能找到正确路径和工具，不误读目录为文件 |

## 推荐人工测试脚本

### Terminal 默认 UI

1. 启动 `npm run start`。
2. 输入：`你可以做什么？`
3. 输入一段中文长句，执行光标移动、删除、追加。
4. 粘贴 10 行文本，确认不会自动拆成多轮提交。
5. 执行：`读取 package.json，然后总结脚本含义`。
6. 执行一个失败命令：`运行测试: npm test -- --runInBand __missing__.test.ts`。
7. 输入 `/status`、`/loop-stats`、`/resume`，确认输出不污染正在编辑的 prompt。
8. 使用 Ctrl+C：第一次中断或提示，第二次退出。

### Ink Beta UI

1. 启动 `npm run start -- --ui ink`。
2. 执行普通问答和长输出。
3. 输出过程中拖动窗口宽度：40、80、120、60、最终 100 列附近。
4. 确认最终屏幕只有一个稳定输入框，status 没有重复打印。
5. 输入中文并观察输入法候选词位置。
6. 粘贴多行文本，确认 bracketed paste marker 不显示。
7. 输入 `/resume`，滚动选择 session。

Ink 当前是 beta renderer。若 terminal UI 正常但 Ink 异常，应归类为 renderer 问题，不应改动 agent runtime、tool、session schema。

## 记录模板

每次真实测试保存一份记录，建议放在 `docs/exp/runs/` 或 issue/PR 描述中：

```markdown
## Orion Code Real Usage Test

- Version:
- Branch:
- Commit:
- OS / Terminal:
- Terminal size:
- UI renderer: terminal / ink
- Model / provider:
- Config dir:
- Test date:

### Cases

| Case | Result | Evidence | Notes |
| --- | --- | --- | --- |
| CJK edit | pass/fail | screenshot/log | |
| Resize during output | pass/fail | screenshot/log | |
| Multiline paste | pass/fail | screenshot/log | |
| Resume | pass/fail | session id | |

### Failures

- Symptom:
- Reproduction steps:
- Expected:
- Actual:
- Suspected layer: renderer/runtime/provider/tool/session/harness/storage
- Log path:
- Screenshot path:
```

## 失败分层规则

定位问题时先分层，避免把 UI 问题改成 runtime 问题：

- `renderer`：光标、边框、status、窗口 resize、overlay、输入框错位。
- `runtime`：turn 状态、中断、revision、permission decision、event 顺序。
- `provider`：API limit、模型 4xx/5xx、stream 中断、context overflow。
- `tool`：命令退出码、路径错误、权限策略、tool result 截断。
- `session`：resume 后历史缺失、session id 不一致、meta/messages 不一致。
- `harness`：root objective 丢失、短反馈覆盖主目标、compact 后不能继续。
- `storage`：`~/.orion-code/projects/<project>/` 下 memory/session/artifacts/checkpoints 不一致。

## 发布前验收线

进入发布前，至少满足：

- 自动化基线全部通过。
- terminal 默认 UI 完成一轮真实编码任务。
- Ink beta UI 完成 resize、多行 paste、session picker smoke。
- 至少恢复一个旧 session，确认 transcript 和 harness 语义可用。
- 失败命令、provider 错误、权限拒绝都有清晰可行动提示。
- 没有把 terminal escape、paste marker、overlay/help 内容写入 durable transcript。

不满足以上条件时，不应发布为稳定 UI 改进；可以降级为 beta known issue，并在版本计划中明确记录。
