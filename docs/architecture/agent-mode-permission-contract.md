# Agent Mode、Permission 与 Composer Control 合同

本文冻结 Orion Code v0.3.2 的 Agent mode、Session permission、model/effort、Context 与
Plan review 边界。它是产品语义说明；wire contract 以
[`v0.3.2 OpenAPI`](v0.3.2-web-api.yaml)和 TypeScript discriminated union 为准。

## 独立状态轴

| 状态轴     | 值                                         | 权威源                         | 生效边界                          |
| ---------- | ------------------------------------------ | ------------------------------ | --------------------------------- |
| Agent mode | `build` / `plan` / `auto`                  | active Session runtime         | idle 时立即；active turn 后继请求 |
| Permission | project default / `ask` / `allow` / `deny` | Session composer preferences   | 下一个 ToolGateway admission      |
| Model      | registry model id                          | Session metadata + coordinator | idle 时原子切换；busy 时延迟      |
| Effort     | `auto` 或模型支持的 level                  | Session metadata               | 与模型相同                        |
| Context    | usage/capacity/source/revision             | Runtime projection             | event/snapshot revision           |

Mode 不授予 Authority。`auto` 只在已有 Authority 内减少交互确认；显式 deny、capability、policy、
sandbox 和 containment 优先。`allow` 需要用户风险确认，也不会跳过这些边界。

BUILD、PLAN、AUTO 使用同一个完整 Tool registry。Goal 是叠加在 base mode 上的目标生命周期，
不会改变此授权合同。

## 授权优先级

Tool authorization 按以下顺序解析：

1. tool-owned hard denial 始终优先；
2. 显式 project/machine/session `deny` 始终优先；
3. AUTO 或 Session Allow 只批准剩余且已满足 Authority 的 invocation；
4. 其余情况再应用 durable grant、工具专用 edit 规则和 interactive confirmation。

Workspace containment、OS sandbox、command safety、input validation 与 runtime capability guard
在所有模式中都保持启用。AUTO 是 prompt-free，不是 policy-free。WebSearch/WebFetch、MCP 和
`subtask` research 也遵循相同规则；需要禁止网络时必须配置显式 capability/tool deny，不能依赖
PLAN 或 BUILD 名称暗示限制。

## Source 与作用域

权限必须同时展示 effective value、Session override、project default 和 source。清除 override
恢复 project default，不写 global setting。模型与 Effort 属于当前 Session；Settings 中的
default model 只影响新 Session。页面不能把“当前 Session”与“全局默认”混为一谈。

## 并发与失败

所有 mutation 使用 UUID requestId，并绑定 active workspace/session/context 与 control revision。

- 同 requestId + 同 body 只执行一次；同 requestId + 不同 body 返回冲突；
- stale context/session/control/queue/plan revision 返回 409，且零 Runtime/provider/tool/file 副作用；
- active turn 中允许接受 deferred model/mode，但 UI 必须显示 pending；
- compact、metadata persist 或 runtime rebind 任一步失败时回滚到 last-good；
- 客户端不能在网络恢复、replay reset 或 409 后自动重放高风险 mutation。

## Plan review

PLAN turn 只提交 durable PlanReceipt 并进入 `awaiting_review`。只有 exact plan digest 的：

- `approve`：durably resolve，然后创建独立 BUILD request；
- `continue`：携带非空 feedback，durably resolve，然后创建独立 PLAN request；
- `cancel`：durably cancel，不创建执行 request。

刷新、SSE 重连和 Host restart 通过 Thread projection 恢复 review。corrupt/missing receipt、stale
digest 或 active turn 均 fail-closed。UI 不重算 Plan digest，也不把按钮点击本身当作 durable receipt。

## Context 与结构化引用

Context usage 必须带 source (`provider` / `estimated`)、capacity、used、revision 与模型身份。
estimated 值显示 `~`；没有 Runtime breakdown 时浏览器不从 transcript 反推 system/tools/messages。

结构化引用仅携带 opaque identity、revision 与 digest。Host 在 prompt assembly 时重新解析并验证：

- workspace containment 与 symlink/non-regular 边界；
- sensitive file deny 与 browser-safe derivative；
- stale revision/digest；
- 单引用 64KiB、总引用 256KiB；
- prompt manifest 与最终 request digest。

任何失败都会阻止发送；原始敏感内容不得进入 DOM、SSE、截图或 release evidence。

## 可观测性与兼容性

每个已调度 Tool invocation 都投影 typed permission decision。durable receipt、trace 和 renderer-neutral
tool activity 必须携带 authorization source，例如 `mode_auto`、`allowlist_allow`、`config_allow` 或
`user`。TUI、terminal、print 与 Web 只显示 Runtime 已验证的 provenance，不从模式文案反推授权。

本合同延续 v0.3.0 的兼容性决策：AUTO 允许 Authority 内的无人值守执行，但仍受 hard denial 与
显式边界约束。未来如增加独立 network-policy 轴，必须作为新的 typed policy 出现，不能静默重载
workflow mode 或 Session permission。
