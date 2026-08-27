# Orion Code

面向终端的目标驱动 Coding Agent。

> v0.2.2：让 Thread 会话恢复具备单会话故障隔离，安全恢复中断的工具历史，并确保窄终端
> 始终可见 Goal 已用 token。

[English](README.md) · [架构主计划](docs/plan/v0.2.0-dsh-harness-redesign-plan.md) ·
[迁移指南](docs/migration/v0.1.9-to-v0.2.0.md) ·
[准出清单](docs/plan/v0.2.0-release-checklist.md)

## v0.2.0 带来了什么

Orion 现在只有一条产品执行主干：

```text
Thread → Turn → Step → Item
                    │
                    ├─ 冻结的 prompt/model/capability 快照
                    └─ Capability → Policy → Approval → Sandbox → Execute → durable receipt
```

- **默认更轻。** 普通 coding 首步只暴露 7 个精确 core tools，不再把全部 built-in schema
  重复发送给模型。Git、LSP、Web、Skill、MCP、batch 和 subagent 按任务选择。
- **执行路径唯一。** root turn 与 child agent 共用同一种 Agent Loop 和 ToolGateway；模型看到的 schema
  与实际 dispatch 由同一个 Step Snapshot 绑定。
- **扩展真正按需。** Skill catalog 只含有界描述，选中后才读取定义和资源；MCP server 在精确选择前
  不连接、不起进程、不打开 socket，空闲后释放 lease。
- **完成状态可证明。** history、TaskContext evidence、Goal、StopDecision、Capability 与 Plan receipts
  在同一个 TurnCommit 中提交。持续有进展的 Goal 可以运行 20+ turns，只在 completion audit 通过后
  自动退出。
- **崩溃后可恢复。** append-only runtime facts 是权威源；UI projection、Compact、旧 Session 迁移和
  resume 都进行 digest 校验，半提交或冲突状态 fail closed。
- **交互一致。** TUI、terminal、print、Plan、Goal、Compact 与 subagent 使用同一版本化协议。

架构借鉴 DeepSeek Harness 的 scope/resource lifecycle 和 Codex 的不可变执行契约，同时保留 Orion
自己的 Goal/Evidence 完成模型。Orion **不是**插件市场或任意 JavaScript 插件宿主；Model、Skills、
MCP 仍是用户可见的扩展边界。

## 安装

支持 Node.js 20、22、24。

安装已发布的 `0.2.2` 版本：

```bash
npm install -g @orion-agents/orion-code@0.2.2
orion --version
orion doctor
```

从源码运行：

```bash
git clone https://github.com/orion-agents/orion-code.git
cd orion-code
npm install
npm run build
npm run start
```

## 配置模型

Orion 读取 `~/.orion-code/orion.json`。可从
[`docs/orion.example.json`](docs/orion.example.json) 开始。Provider key 可使用本地值或
`$HUOSHAN_API_KEY` 这样的环境变量引用；不要提交密钥。

最小 OpenAI-compatible 示例：

```json
{
  "schemaVersion": 1,
  "providers": [
    {
      "id": "my-provider",
      "displayName": "My Provider",
      "baseUrl": "https://example.invalid/v1",
      "apiKey": "$MY_PROVIDER_API_KEY",
      "protocol": "openai-completions"
    }
  ],
  "models": [
    {
      "id": "my-model",
      "displayName": "My Model",
      "provider": "my-provider",
      "model": "model-name",
      "contextWindow": 200000,
      "maxOutputTokens": 8192
    }
  ],
  "defaultModel": "my-model",
  "toolConfirmation": "allow"
}
```

配置后运行 `orion doctor`。诊断不需要输出密钥本身。

## 使用 Orion

```bash
orion                         # 默认产品 TUI
orion --ui terminal           # 技术诊断 terminal fallback
orion -p "解释这个仓库"       # 实验性的非交互模式
orion -p --output-format json "运行 focused tests"
orion diff
orion commit
```

`orion -p` 是早期实验性的非交互入口；需要确认弹层或实时 steering 的任务应使用 TUI。

### BUILD、PLAN、AUTO

按 `Shift+Tab` 循环 `BUILD → PLAN → AUTO`。状态栏和输入框边框会显示当前模式。Mode 决定工作流，
Authority、approval、路径边界和 sandbox policy 是独立状态轴。

- **BUILD**：正常协作开发。
- **PLAN**：使用同一套可用工具完成探索；将 decision-complete plan 写入 durable PlanReceipt；自动退出
  Plan、恢复 BUILD/AUTO，并在新的 logical turn 中执行。
- **AUTO**：在已配置 Authority 内取消交互确认；hard policy 与 sandbox 边界仍然 fail closed。

任务式进入：

```text
/plan 重构 storage boundary 并验证 crash recovery
```

不存在 `exit_plan_mode` 工具，也没有 `/mode` 命令。

### Durable Goal

```text
/goal 修复开放问题，运行准出门禁，仅在证据完整后停止
/goal status
/goal pause
/goal resume
/goal clear
```

`/goal <objective>` 创建 Goal。有进展的 Goal 没有固定 turn-count 上限；资源预算、连续无进展、阻塞、
provider/persistence 错误和用户中断仍产生明确 StopDecision。证据审计通过后，Goal 提交完成并自动退出。

v0.2.0 breaking cut 已删除 `/target`、`/goal exit`、`edit`、`replace`、`confirm`、`budget` 和
`clear --yes`，不会把旧命令静默解释为新目标。

### 常用命令

- `/help`、`/status`、`/doctor`、`/harness explain`
- `/tools`、`/skills`、`/skill <name>`、`/mcp`
- `/context`、`/memory`、`/usage`、`/trace`、`/last-tool`
- `/model`、`/effort`、`/permissions`、`/config`
- `/compact`、`/resume`、`/session`
- `/diff`、`/commit-plan`、`/review`、`/research`、`/security`、`/test-gen`

安装版本中的 `/help` 是命令清单的权威来源。

## Runtime 保证

- 每个 Thread 最多一个 active turn；steer、follow-up、interrupt、overload 和 maintenance 都返回 typed
  admission outcome。
- 每个已开始的 tool Item 恰好一个 durable terminal outcome。嵌套 batch child 保留 parent/child
  invocation lineage，并重新进入 ToolGateway。
- 慢 renderer 可以合并 ephemeral delta，但 durable events 不会静默丢失且可以 replay。
- Compact 只有在 source history、TaskContext、projection 与 pointer CAS 都通过后才提交。
- v0.1.9 Session 采用 side-by-side materialization；event replay 与 projection digest 验证后才切 active
  index。
- public exports 只提供产品 runtime/protocol 与 Model/Skill/MCP 配置边界，不暴露内部 service locator
  或插件 SDK。

## 开发与验证

```bash
npm run lint
npm run build
npm test -- --runInBand
npm run test:coverage -- --runInBand
npm run test:harness-confluence
npm run bench:harness:baseline
npm run bench:harness
npm run bench:harness:compare -- <baseline.json> <candidate.json>
npm run prepublishOnly
```

正式准出还会只构建一次 exact tarball，并在 Node 20/22/24 安装同一个 hash，验证 package identity、
native SQLite、TUI、terminal、print、Goal、subagent、Skill、MCP、Compact 与 resume。详见
[`v0.2.0 准出清单`](docs/plan/v0.2.0-release-checklist.md)。

## 安全

不要提交 `.env`、`~/.orion-code`、本地数据库或凭据。文件访问受 project boundary 限制，symlink 和
non-regular path escape 会 fail closed，所有副作用通过同一 Authority/Policy/Approval/Sandbox 链。

## License

MIT，见 [LICENSE](LICENSE)。
