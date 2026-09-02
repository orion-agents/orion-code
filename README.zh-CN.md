# Orion Code

面向终端与浏览器、本地优先的目标驱动 Coding Agent。

> v0.3.5 候选版本：面向 v0.3.x 多 Session Web Workbench 的会话连续性与运行时所有权修复。
> 会话快照状态与传输解耦、Session 切换即时完成，且 Workspace Context 切换不再中断其他
> Workspace 仍在运行的 Session actor。Candidate 源码不代表已创建 npm 发布、Git tag 或达到
> 可合并状态。

[English](README.md) ·
[v0.3.5 方案](docs/plan/v0.3.5-plan.md) ·
[v0.3.4 稳定化方案](docs/plan/v0.3.4-stabilization-plan.md) ·
[v0.3.4 合同](docs/architecture/v0.3.4-stabilization-contract.md) ·
[v0.3.4 E2E 方案](docs/test/v0.3.4-stabilization-e2e-plan.md) ·
[v0.3.4 迁移](docs/migration/v0.3.3-to-v0.3.4.md) ·
[v0.3.3 方案](docs/plan/v0.3.3-plan.md) ·
[v0.3.3 Web API](docs/architecture/v0.3.3-web-api.yaml) ·
[模式/权限合同](docs/architecture/agent-mode-permission-contract.md) ·
[v0.3.3 E2E 方案](docs/test/v0.3.3-web-workbench-e2e-plan.md) ·
[v0.3.3 迁移](docs/migration/v0.3.2-to-v0.3.3.md) ·
[v0.3.0 Web 方案](docs/plan/v0.3.0-web-workbench-plan.md) ·
[Settings 方案](docs/plan/v0.3.0-settings-integration-plan.md) ·
[Node 兼容方案](docs/plan/v0.3.0-node-runtime-compatibility-plan.md) ·
[Web API](docs/architecture/v0.3.0-web-api.yaml) ·
[迁移指南](docs/migration/v0.2.2-to-v0.3.0.md) ·
[Settings 迁移](docs/migration/v0.2.2-to-v0.3.0-settings.md) ·
[真实状态图册](docs/assets/screenshots/v0.3.0-web/README.md)

## v0.3.4 稳定了什么

- **Context 绑定写入。** Settings mutation 现在同时携带活动 Workspace 与 Context revision；陈旧页面
  不会写入或应用到另一个 Runtime。空 Session 名称和 busy slash command 也会保持持久态与活动回合不变。
- **统一敏感数据边界。** 结构化凭据、URL userinfo、canonical 文件目标、Git diff 路径、tool artifact
  和并发命令输出在进入浏览器或证据前统一检查与脱敏。
- **确定的 Terminal 传输。** PTY 代理对分片、浏览器写入背压与重连竞态都保持完整 Unicode，以及
  replay、live tail、exit、close 的严格顺序。
- **诚实的 durable/read 投影。** Tool receipt 与 journal fact 必须成对校验；symlink 在保留 lexical
  类型的同时投影有效目标类型；Review 将仓库真实总数与有界可见页分开显示。
- **Fail-closed 发布证据。** live canary 失败、重复 Runtime 证据，或混入“安全安装阶段”的生命周期
  script 都会阻止发布。

## v0.3.3 包含什么

- **一条执行主干、有界 Web Session actors。** Web Session 与终端产品共用 product bootstrap、
  AgentRuntimeController、Session/Thread、ToolGateway、审批、Goal、Plan、Skills 和 MCP。Web 最多允许
  3 个 Session turn 并行、4 个 actor 常驻；TUI/terminal 继续保持单活动 Session 合同。
- **Orion 方块工坊。** 内置像素工坊风格可与 system/light/dark 组合，不加载远程资产、动态主题代码或
  第二份 Settings 真相；classic 继续作为显式内置风格提供。
- **可恢复的 Web 工作台。** React 界面覆盖工作区/会话、对话与工具活动、BUILD/PLAN/AUTO、follow-up、
  interrupt、审批、Goal/Plan、模型/effort、Skills/MCP 和诊断。快照与 cursor replay 负责刷新和 SSE
  重连恢复。
- **专业项目工作台。** 左侧展示已注册项目并懒加载 Session，中间仍是唯一 Agent 会话。右侧可变宽面板
  提供 Agent、审阅、终端、文件和 Git；左栏可在 240–480px 鼠标调宽或折叠为 48px rail，窄屏使用互斥
  drawer 且不覆盖桌面偏好。
- **Composer Control Center。** 模式、Session 权限、模型、Effort 与 Context 都在输入框旁的可访问菜单中；
  Runtime 明确投影 current/last-good/pending/error，active turn 模型切换会安全延迟，切小上下文前先 Compact。
- **可审核 Plan 与有界 Context。** PLAN 写入 durable review 后等待 exact-digest 批准；结构化文件/目录/
  Review/Session/Skill 引用、带 revision 的队列编辑与 Session 草稿恢复让输入意图可见且可恢复。
- **本地安全边界。** Host 只绑定 `127.0.0.1`；写请求必须携带精确 Origin、进程 nonce、JSON body 和
  幂等键。响应设置严格 CSP，浏览器 payload 经过脱敏，大型工具结果按字节分页读取。
- **Host 管理的 Settings。** 外观、默认模型、工作区 Effort 与全局工具确认策略统一进入严格、带
  revision 的 `orion.json` Coordinator。原子批量保存、文件锁内 CAS、外部编辑 invalidation、
  last-good 恢复与明确的来源/作用域/生效时机，让浏览器、slash 命令、TUI 与 Runtime 使用同一持久真相。
- **有边界地参考 DSH。** 方案基于固定 DeepSeek Harness revision 做了源码审计。DSH Web 实际使用
  POST 加两条下行 WebSocket；Orion 有意选择 JSON HTTP 加一条可 replay 的 SSE，同时保留 Orion 的
  Model/Skills/MCP 边界。

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

支持 Node.js 22.12+、24 和 26。生产环境建议使用 Node 24 LTS，当前开发环境也支持 Node 26
Current。Node 20 已结束上游维护，不再属于 v0.3 Runtime 合同。

当 npm 已存在不可变的 `0.3.4` 发布凭据后：

```bash
npm install -g @orion-agents/orion-code@0.3.5
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
orion web                     # 启动本地 Web Workbench 并打开浏览器
orion web --no-open --port 0  # 使用操作系统分配的 loopback 端口
orion web --cwd /path/to/repo # 指定另一个已存在工作区
orion -p "解释这个仓库"       # 实验性的非交互模式
orion -p --output-format json "运行 focused tests"
orion diff
orion commit
```

`orion -p` 是早期实验性的非交互入口；需要确认弹层或实时 steering 的任务应使用 TUI。

### 本地 Web Workbench

`orion web` 在同一个 loopback origin 提供打包后的客户端与 `/api/v1/*`，不提供 LAN bind。
Provider 凭据仍通过 Orion 配置/环境变量管理；浏览器负责选择工作区和会话、执行或 steer 任务、回答
审批并查看运行态。关闭或刷新 tab 不会替用户批准/拒绝，pending approval 仍由 Runtime 持有；停止
Host 时会 abort 并 fail-closed。

浏览器展示已提交 Plan receipt，并进入 durable `awaiting_review`。批准会创建独立 BUILD request；继续规划
携带反馈创建独立 PLAN request；取消不产生执行副作用。三种操作均绑定 exact digest，刷新或 Host restart
后可恢复，stale review fail-closed。

多项目导航不会创建多个 Runtime；跨项目 Session 选择是一次带 revision guard 的原子 Context 切换。
桌面左栏可在 240–480px 调整或折叠为 48px rail，右栏为 320–720px；均采用 IDE 式鼠标拖动且不提供
键盘精细调宽。窄屏自动使用 drawer，且不覆盖桌面宽度偏好。文件、Git 和审阅保持只读；创建终端需要
显式 user gesture，短期 ticket 与输出均不进入 Workbench SSE。

#### Host 管理的 Settings

Settings dialog 从当前 Host 读取设置，不把浏览器存储当成第二配置真源。主题和减少动效会跨刷新、端口
和 Host 重启保留；默认模型只影响新建 Session，当前 Session 仍通过 `/model` 或会话控制显式切换；
Effort 是当前 workspace 的 project default，Session override 优先；工具确认是全局策略，只能在 Runtime
idle 时保存，并从下一个 logical request 生效。`allow` 不会绕过 hard policy、sandbox 或工作区边界。

每次保存都是一次原子 CAS batch。并发标签页或外部 `orion.json` 编辑会显示冲突但保留草稿；非法 JSON
只会让页面进入 invalid 状态，Runtime 继续使用 last-good，Web 绝不覆盖坏文件。Provider 凭据不会进入
Web API，页面只显示 readiness，打开本地配置文件的动作也不接受 path。优先级、旧 appearance 一次迁移
和回滚方法见 [Settings 迁移说明](docs/migration/v0.2.2-to-v0.3.0-settings.md)。

### BUILD、PLAN、AUTO

使用 Composer 模式菜单选择 `BUILD`、`PLAN` 或 `AUTO`；旁边的权限菜单选择 Project default、Ask、
Allow 或 Deny。Mode 决定工作流，Authority、approval、路径边界和 sandbox policy 是独立状态轴；Allow
与 AUTO 不会覆盖 hard policy 或显式 Deny。

- **BUILD**：正常协作开发。
- **PLAN**：使用同一套可用工具完成探索；将 decision-complete plan 写入 durable PlanReceipt；等待
  批准、继续规划或取消。
- **AUTO**：在已配置 Authority 内取消交互确认；hard policy 与 sandbox 边界仍然 fail closed。

任务式进入：

```text
/plan 重构 storage boundary 并验证 crash recovery
```

不存在 `exit_plan_mode` 工具。Web 通过 Composer 选择模式；终端界面保留原有模式控制。

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
npm run test:web-e2e -- --grep @settings
```

正式准出还会只构建一次 exact tarball，并在 Node 22/24/26 安装同一个 hash，验证 package identity、
native SQLite、TUI、terminal、print、Web、Goal、subagent、Skill、MCP、Compact 与 resume；
WEB33-P0-01..12 验证内置外观合同，WEB33-P0-16..24 验证并行 Session actors、标签页本地前台切换、
有界队列、右侧 rail 与唯一 Settings 入口。详见 [`v0.3.3 方案`](docs/plan/v0.3.3-plan.md)与
[`v0.3.3 E2E 资格计划`](docs/test/v0.3.3-web-workbench-e2e-plan.md)。v0.3.4 的安全与稳定化增量见
[`v0.3.4 测试计划`](docs/test/v0.3.4-stabilization-e2e-plan.md)；它不会把 source gate 当成发布凭据。

## 安全

不要提交 `.env`、`~/.orion-code`、本地数据库或凭据。文件访问受 project boundary 限制，symlink 和
non-regular path escape 会 fail closed，所有副作用通过同一 Authority/Policy/Approval/Sandbox 链。

## License

MIT，见 [LICENSE](LICENSE)。
