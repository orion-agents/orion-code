# Orion Code 项目级目标

> 状态：Active
>
> 维护范围：Orion Code CLI、Agent Runtime、TUI、terminal-ui、Print、工具与扩展协议
>
> 当前发布基线：稳定版 `@orion-agents/orion-code@0.1.4`（`latest`）；维护预发布版
> `0.1.4-2`（`next`）。`main@611b659` 另含尚未进入上述 npm 产物的后续修复。
>
> 最近更新：2026-08-09

## 1. 项目使命

Orion Code 要成为一个**可靠、安全、可持续执行项目级目标的终端编码 Agent**：

> 用户只需要说明希望项目最终达到什么状态，Orion Code 就能在明确的权限边界内规划、
> 执行、验证并跨轮次继续工作；只有当当前证据能够证明目标已经完成时，才宣告完成。

它不是一个只生成代码片段的聊天机器人，也不是把模型输出直接连接到 Shell 的薄包装。
Orion Code 的核心价值是位于用户、模型和本地开发环境之间的 Agent Harness：保持目标、
约束执行、管理上下文、编排工具、记录证据，并让用户始终知道系统正在做什么。

## 2. 北极星体验

一个理想的 Orion Code 任务应形成以下闭环：

```text
项目级目标
  → 明确成功条件与边界
  → 制定可更新的执行计划
  → 在用户授权范围内操作
  → 持续验证代码、运行时与外部状态
  → 跨轮次、跨会话恢复
  → 逐项完成审计
  → 交付证据、风险与剩余事项
```

用户体验上的直接表现是：

1. 用户描述结果，不必手工拆成几十个微小提示。
2. Agent 能持续多轮执行，不会把一次模型回复误当成目标完成。
3. 会话重启、上下文压缩或 renderer 切换后，目标语义不会丢失或改变。
4. 高风险或外部动作可预览、可确认、可追踪、可恢复。
5. 最终结论来自构建、测试、文件、运行时、PR、发布状态等证据，而不是模型自信程度。

## 3. 目标用户与核心任务

### 3.1 目标用户

- 在终端中完成真实仓库工作的个人开发者；
- 需要 Agent 持续实现、诊断、测试、发布和维护项目的工程团队成员；
- 使用不同 LLM Provider、MCP Server 或项目 Skill，但希望保留一致执行体验的高级用户；
- 希望本地数据、权限和外部操作始终受自己控制的用户。

### 3.2 核心任务

Orion Code 优先支持以下工作：

- 理解现有代码库并实施跨文件功能或修复；
- 诊断失败并用可复现证据定位原因；
- 维护测试、文档、配置、迁移与发布资产；
- 运行持续数轮甚至跨会话的项目目标；
- 在明确授权下操作 Git、GitHub、npm、MCP 和本地工具；
- 对完成状态进行逐项验收，而不是只报告“已尝试”。

## 4. 项目级结果

### G1 — 目标忠实度

Orion Code 必须持续以用户定义的最终状态为准，不得为了更容易实现或更容易通过当前测试，
私自缩小、替换或重新解释目标。

必须具备：

- 持久化的目标状态、预算、阶段和完成条件；
- 可更新但不静默改写目标的计划；
- 多轮 continuation 和中断恢复；
- requirement-by-requirement 的完成审计；
- 目标未完成时保持 active，真正受阻时给出精确阻塞条件；
- 目标完成后保存验证证据和最终交付摘要。

### G2 — 安全且可控的自主执行

Orion Code 应尽可能自主完成正常工程步骤，但自主性不能突破用户授权。

必须具备：

- 工具和命令具有统一的风险元数据；
- 只读、状态写入、破坏性、外部发布等动作可区分；
- 破坏性动作默认预览，并要求显式确认；
- 路径、目标、分支、包名和外部资源在修改前被精确解析；
- 所有 renderer 使用同一确认协议，不能由 UI 私有分支绕过；
- 操作结果与返回状态一致，失败不能被包装为成功；
- 敏感信息不会进入日志、transcript、Git 或发布包。

### G3 — TUI 主产品、单一运行时

TUI、terminal-ui、Print/JSON 和未来客户端应共享同一 Agent Runtime、命令语义、目标状态和
结构化事件协议。

产品边界：

- **TUI 是默认交互界面，也是未来面向公众的重点产品方向**；
- 面向用户的新交互、视觉体验、工作流入口和产品能力优先在 TUI 中设计和验收；
- **terminal-ui 只保留为技术版本**，用于 runtime 协议验证、诊断、兼容性排查和必要回退，
  不再作为与 TUI 并行发展的公众产品界面；
- Print/Text 和 Print/JSON 是自动化边界；
- **Ink 已废弃**，不再增加功能、修复非关键体验问题或承载新产品语义；在迁移窗口结束后删除；
- UI 负责展示和输入，不复制目标、命令、权限或 Agent 执行引擎；
- Help、palette、completion 和文档应来自同一命令注册信息。

这里的“terminal-ui 技术版本”不代表可以发生运行时语义分叉。它仍需消费共享事件、遵守
相同权限与目标状态，并承担最小 smoke/parity 验证；只是产品设计、公开文档和体验投入集中在
TUI。

### G4 — 可靠的终端原生体验

Orion Code 必须像一个可信赖的开发工具，而不是偶尔可用的演示程序。

必须保证：

- CJK 输入、多行编辑、粘贴、scrollback、resume 和 Ctrl+C 行为稳定；
- 用户输入、Agent 输出和工具活动具有清晰节奏与视觉层级；
- Banner 在不同宽度下保持已确认的几何，不因 ANSI 或 CJK 发生错位；
- Kitty/iTerm 图像协议只在能力探测成功后发送；
- 不支持图像协议的终端必须无乱码回退到像素或文本 Banner；
- renderer 变更必须经过真实 PTY，而不只依赖字符串快照。

### G5 — Provider 与扩展能力可替换

核心执行链不能绑定单一模型厂商或单一扩展生态。

必须保证：

- Provider、Model 与协议显式建模，错误能定位到配置、端点、协议或权限；
- 模型切换、fallback、context window 和用量状态具有一致语义；
- MCP、Skill 和内置工具通过清晰边界接入；
- 扩展不可绕过权限、审计、目标状态和输出协议；
- Provider 或扩展不可用时，系统说明原因与恢复路径，而不是静默降级或虚假成功。

### G6 — 本地优先、可迁移、可恢复

用户数据默认保存在本地，格式和生命周期必须可解释。

必须保证：

- 配置、会话、目标、记忆、artifact 和审计记录有明确作用域；
- 数据迁移采用 copy、verify、hash、atomic switch 等可恢复流程；
- 清理、修复和删除操作默认不破坏源数据；
- 历史数据不会被静默重写，兼容入口有明确弃用窗口；
- 项目目录、用户目录和 session 数据之间没有隐式串用。

## 5. 不可破坏的产品原则

以下原则优先于短期功能数量：

1. **目标优先于回合**：一次回复结束不代表项目目标结束。
2. **证据优先于判断**：完成结论必须能指向当前证据。
3. **单一引擎**：CLI、Desktop、Web 或 IDE 客户端不能各自复制 Agent 核心。
4. **TUI 产品优先**：公众体验和新增交互集中在 TUI；技术 renderer 不形成第二条产品线。
5. **结构化事件**：业务处理器不直接控制 stdout、进程退出或某个 renderer 的 surface。
6. **安全默认值**：无确认不执行破坏性动作；无能力探测不发送终端图像协议。
7. **兼容必须有期限**：旧命令、旧品牌、旧配置和废弃 renderer 只在声明的迁移窗口内保留。
8. **文档不得超前声称**：实验、兼容和条件能力不能被写成无条件稳定能力。
9. **真实环境验收**：本地 PATH、真实 PTY、生成 tarball 和外部服务状态都是发布证据。

## 6. 当前基线与主要缺口

### 6.1 已建立的基础

**v0.1.0～v0.1.3 基础（均已发布）：**

- npm 公共包 `@orion-agents/orion-code`、全局命令 `orion`、TUI 默认产品路径与
  terminal-ui/Print 技术边界已建立，Ink 明确废弃；
- v0.1.2 将单 Session/单 Active Goal 接入 shared runtime：类型化 continuation、完成审计、
  evidence ledger、restart/resume 安全恢复和 renderer parity 已成为真实产品能力；
- v0.1.3 建立 sandbox POC、工具允许列表、计划模式权限门、SSRF/API-key 加固、Git 工具、
  模型配置和增量输入基础；
- command registry、结构化 runtime event、Provider/Model Registry、MCP、Skill、Subagent、本地会话/记忆
  和发布检查线已形成。

**v0.1.4 发布线（当前前置）：**

- `0.1.4` 已作为稳定 `latest` 发布；`0.1.4-2` 已作为 `next` 发布，承载
  Research-to-Evidence、Goal/runtime、安全、持久化、依赖治理和运行时矩阵的集中修复；
- ResearchPacket、受控 Web research、citation/quality、artifact CAS、Goal evidence bridge 以及
  TUI/terminal/Print 投影已接入 shared runtime；
- `main@611b659` 在已发布 `0.1.4-2` 之后又合并了配置目录并发创建、原生 SQLite
  延迟加载/可操作 ABI 诊断和跨进程 session 容量原子预留；它们是 **Merged**，不是
  已安装的 `0.1.4-2` 能力；
- `main` 的 CI 已覆盖 Node 20/22/24、coverage、typecheck、audit、release gate 和 dependency
  health；当前 GitHub open issue 列表为空，但这不代表没有已知加固项。

### 6.2 缺口状态

v0.1.5 必须以下列现实缺口为输入，不得重复规划已在 v0.1.4/main 关闭的 issue：

1. **发布产物落后 main。** `0.1.4-2` 不包含 `main` 上后续的配置目录并发修复、
   native SQLite 延迟加载/ABI 诊断和 session 容量原子锁；v0.1.5 必须从最终
   `main` 建立分支并在实际 tarball/registry install 中重验这些行为。
2. **命令合同仍不是单一控制面。** 当前为 46 个 canonical command；部分 handler 直接写
   `console.*`，runtime 仍用全局 console capture 转接给 renderer，且 availability 元数据尚未落地。
3. **Provider reasoning 不等于 effort 能力。** model profile 只有布尔标记，没有受支持级别、
   provider wire adapter、requested/effective 状态、fallback 语义和 reasoning usage 证据。
4. **CI 仍有确定性债务。** `main@611b659` 的首次 Node 22 运行在 Goal evidence 状态断言上
   失败，同 SHA 重跑成功；在找到时钟/工作区/并发根因前，不得把重跑当成稳定性证明。
5. **存储锁还有小概率加固点。** main 已关闭报告中的正常跨进程 slot race，但 recovery
   sentinel 自身的崩溃后双回收窗口、未受 registry lock 保护的未来 `cleanup()`、以及
   unreadable/corrupt session 容量计数策略需要单独硬化。
6. **多客户端只能是薄适配层。** v0.1.5 可以建立 experimental ACP v1 adapter，但必须复用
   shared runtime、权限、Goal、session 和 event；若 tool permission、cancel、resume 或 stdio 协议纯净性
   没有闭环，就不进 Registry、不宣称稳定 IDE 能力。

<details>
<summary>v0.1.1/v0.1.2 历史候选快照（已失效，不作当前状态）</summary>

**v0.1.1 已关闭：**

- `/target` 与 `/goal` 的 renderer 路由分叉（已收敛到 shared controller）；
- `/clear-history` 名称、输出与持久化不一致（已 deprecate，指向 `/clear`）；
- 命令注册表与静态文档未统一（已加 command contract + 契约测试）；
- 旧 Task/Agent 命令被误以为主执行链（已隐藏 + deprecate）；
- 中英文 README 与实际默认 UI 口径漂移（已收敛 TUI 主产品身份）；
- 对外文档对 TUI/terminal-ui/Ink 的表达不一致（已统一 product/technical/deprecated）。

**仍开放（v0.1.2 发布 Gate）：**

- **Goal 单 Session 闭环已有 pre-commit candidate，但尚未达到发布 GO**——
  RC2～RC15 均为历史、被取代或主动失效的候选。RC15 在 clean 验证后被独立 CR 发现五项缺口并主动
  失效：多目标外部完成聚合、Goal commit 后 cleanup 语义、并行 child scope 隔离、safe-integer fence
  validation 和 stderr flush。RC16 修复这些问题后，又因 unversioned npm、per-package version、shared
  PR/GitHub URL parser 与 Print shutdown rejection 边界被否决；RC17 继续修复后，仍因 legacy
  multi-target npm/PR/release fail-open 和 PR Oxford-comma 解析缺口被否决。RC18 关闭这些缺口后，
  后续对 Goal 存储、controller fail-closed、deletion fence 与 subagent scope 的审查又修改了
  source/package input，因此 RC18 数据只作历史证据，不再代表当前候选。当前 pre-commit
  candidate 保持 external assertion 调用绑定、subagent usage、Goal terminal persistence、
  deletion fence 诊断、renderer 切换连续性与 Print 确定性终止；当前已有聚焦回归、
  build/lint、Node 22 全量回归、预提交双 pack、clean-prefix install 与 identity-bound PTY 证据。
  Node 20/24 当前完整矩阵、full-source coverage、可重放 evidence manifest 与最终 merge artifact 仍待从
  最终提交重建，不沿用 RC18 测试计数、临时路径或包 hash。
  `--ignore-scripts` 安装下 better-sqlite3 原生模块不可用是预期限制，不代替标准安装证据。
  真实 macOS Terminal 因当前控制策略未验证，login-shell PATH 仍找不到
  `orion`；最终 merge artifact、远端 PR/CI/GitHub Release、npm v0.1.2 和发布后安装仍待关闭；
- **project metadata/storage cleanup 的本地安全 P0 实现保持关闭**——RC2/RC3/RC4/RC5
  均保留为 historical invalidated 候选；
  cleanup 路径只 atomic quarantine 并永久保留，不物理
  `rm`、不误报 deleted；vector 绑定 DB identity、完整 canonical rows、safe integers 并在
  `BEGIN IMMEDIATE` 内重验；plan token 为 256-bit process-local single-use，10 分钟过期；
  Node/macOS 无 race-safe directory-relative write 时可写 metadata repair fail-closed 禁用，
  preview 与 `/doctor` 保持只读；两轮独立对抗 CR 首轮发现 verify→rm 窗口与
  bigint 边界，修复后第二轮 APPROVE；
- quarantine recovery/purge lifecycle 以及 `projects/` 下空 quarantine 可能被再次
  quarantine 的幂等性改进归属 P2，不阻断当前数据安全；
- 高影响 Goal 的 preview→confirm→execute 运行时边界已有自动化验证，但其他存储/破坏性命令
  仍按独立版本持续收敛；
- 命令元数据已定义，但 help/palette/completion 尚未完全消费 risk/deprecated 元数据；
- Node 20 clean install 的安全审计已为 0；Ink/React/Yoga 原生与弃用依赖的物理移除由 v0.2 承接。

</details>

### 6.3 目标实现成熟度（现实状态层）

本节区分"北极星声明"与"当前代码现实"，避免滞后声称。成熟度分四档：
**stub**（类型/骨架存在但未接通）、**partial**（主路径可用但有断点）、**functional**（端到端可用但需加固）、**solid**（可发布、有证据、有回归）。

| 目标                      | 北极星声明                                         | 当前成熟度                    | 关键差距                                                                                                 |
| ------------------------- | -------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| G1 目标忠实度             | 持久化目标、跨回合继续、逐项证据关闭               | **solid（单 Session 范围）**  | v0.1.2 已发布并经 v0.1.4 加固；多 Goal/跨 Session 调度仍属 v0.2                                          |
| G2 安全自主               | 统一风险元数据、破坏性预览确认、失败不被包装为成功 | **functional（加固中）**      | tool/sandbox/fork/web/Git 安全门已有广泛回归；command 统一参数/确认和 ACP 权限桥仍待闭环                 |
| G3 TUI 主产品、单一运行时 | 共享 runtime/命令/目标/事件                        | **functional（加固中）**      | Goal/Research 已共享 runtime 并有 PTY/parity；command console capture 与 renderer-private 路由仍是主缺口 |
| G4 终端原生体验           | CJK/scrollback/resume/Ctrl+C 稳定                  | **functional（加固中）**      | TUI/terminal/research/Goal PTY 已有回归；每个新 picker/协议入口仍必须重做真实 PTY                        |
| G5 Provider 可替换        | Provider/Model 显式建模、错误可定位                | **functional（effort 缺口）** | registry/fallback/diagnostics/runtime matrix 已有；能力级别和 provider-aware effort wire 尚未建立        |
| G6 本地优先、可恢复       | 数据可解释、迁移可恢复、清理不破坏源               | **functional（加固中）**      | atomic/CAS/quarantine/native ABI 边界已加固；极端 stale-lock 回收与未来 cleanup 边界仍待硬化             |

**关键认知**：G1 仍是使命核心。当前不再是“Goal pre-commit candidate”阶段；单 Session
Goal 已发布。v0.1.5 的重点是不让命令重构、effort 或 ACP 新客户端绕过这条
已稳定的目标/证据/权限链，并把 **Candidate → Merged → Published → Registry/Client verified**
继续作为不可混淆的证据状态。

## 7. 分阶段交付方向

### 阶段 A - v0.1.x：可靠性与语义收敛

目标：让当前 CLI 的公开能力与真实行为一致。

阶段 A 的版本归属如下，不得互相包装或提前透支：

**v0.1.1（已完成、已发布）：命令契约与身份收敛**

- 统一 command contract、目标命令路由和 renderer event 协议；
- 收敛过时、重复和条件命令；
- 将公开体验和新交互收敛到 TUI，固化 spacing、Banner、CJK、resume 和 PTY 回归；
- 将 terminal-ui 收敛为技术参考与诊断回退，只维护关键兼容、runtime parity 和 smoke test；
- 在帮助和文档中明确 Ink 废弃，不再增加功能，并为后续删除建立迁移与回归门槛；
- 统一 README、帮助、版本文档和包元数据；
- 建立 clean install、tarball、真实 PATH 与发布证据链。

**v0.1.2（已完成、已发布）：Goal 骨架端到端闭环**

- 让 v0.1.1 已存在但未接通的 Goal 骨架真正端到端工作（见 6.3 G1 差距）；
- 结构化 continuation（取代 marker 字符串），不污染 transcript；
- `update_goal complete|blocked` 两阶段提交，runtime audit 才能改变终态；
- 逐 criterion 的 completion audit 与证据账本，模型文本不能自封通过；
- session resume 重绑 GoalCoordinator，跨 session 隔离，restart 进入安全恢复态；
- Goal events 接入 shared runtime、view-model 与 TUI/terminal-ui parity；
- 精确 per-turn accounting、预算 preflight 与 stop reason 分层；
- v0.1.1 sidecar 向后兼容读取、corrupt recovery 与回滚。

**v0.1.3（已完成、已发布）：工具、权限与 Provider 加固**

- 完成 sandbox/allowlist/plan-mode/SSRF/Git 工具的主要安全闭环；
- 建立 Provider/Model Registry、fallback 诊断、增量输入和进一步的 TUI 权限交互。

**v0.1.4 发布线（已发布 stable/next，main 仍有 merged-only 修复）：Research-to-Evidence 与维护收敛**

- 结构化 ResearchPacket、受控 Web research、citation/quality 与 Goal evidence boundary；
- 持久化/CAS、provider recovery、原生依赖、运行时矩阵和发布门的系统加固。

**v0.1.5（规划中）：命令控制面、provider-aware effort 与受控多客户端 POC**

- 先把 v0.1.4/main 的 merged-only 修复纳入可安装产物，并关闭已知 CI/锁残余；
- 让 help/palette/completion/docs 来自单一 typed command descriptor，handler 不再依赖全局 console capture；
- 建立可验证的 effort capability/adapter/usage 链，对不支持的 provider 诚实不可用；
- ACP 只作复用 shared runtime 的 experimental v1 适配层；只有在权限、取消、恢复、PTY 和
  package/Registry 证据齐全时，才能升格为稳定对外能力。

**范围约束**：v0.1.x 仍只承诺单 Session、单 Active Goal 的可靠性闭环，不提前承诺
v0.2 的多目标、跨 Session 调度或 unattended 后台执行。

退出条件：已发布能力与文档相符；v0.1.5 的 P0 不破坏 G1/G2/G3，并从最终 merge SHA 重建
Node 矩阵、coverage、PTY、tarball、clean install 和发布证据。

### 阶段 B - v0.2：完整的项目目标运行时

目标：将“项目级目标”从单 Session 能力提升为 Agent Runtime 的核心状态机，扩展到多目标与跨 Session 调度。

v0.1.2 已关闭单 Session 单 Goal 闭环后，v0.2 承接扩展：

- 多 Goal 并发、目标队列、优先级与 DAG 调度；
- 跨 Session 目标恢复与调度，unattended background daemon；
- Goal、计划、todo、subagent task 与 artifact 的完整关系图；
- 通用阶段编排器与远程 worker；
- 稳定的 completion/blocked runtime 协议在多目标下的一致性；
- 团队策略、云同步与远程审计（基于同一 runtime）；
- Ink、React、Yoga 的物理删除及相应破坏性 CLI 变更。

退出条件：一个非平凡仓库目标能够跨多轮、跨会话执行，并用当前证据证明完成或精确阻塞；多客户端对同一 session、目标和权限状态产生一致结果。

### 阶段 C — v0.3+：共享协议与多客户端

目标：在不复制核心引擎的前提下扩展使用场景。

- 稳定的 SDK、App Server 或进程间协议；
- Desktop、IDE 或远程 UI 只作为受控客户端；
- 可观察的 task/subagent 树和结构化 artifact；
- 可移植的 MCP/Skill 扩展契约；
- 团队策略与审计能力建立在同一 runtime 上。

v0.1.5 的 ACP POC 若达到发布门，只代表“已有受控薄适配层”，不提前改写本阶段对
稳定 SDK、多客户端一致性、远程运行和团队策略的退出条件。

退出条件：不同客户端对同一 session、目标和权限状态产生一致结果。

## 8. 项目级成功指标

以下指标作为版本和架构决策的共同验收标准：

| 维度            | 成功条件                                                | 主要证据                                                                                  |
| --------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 目标连续性      | active 目标能跨回合、压缩和 session resume 保持语义     | 状态持久化测试、resume PTY、目标事件日志                                                  |
| 完成可信度      | 每个完成结论都逐项对应成功条件与当前证据                | completion audit、测试/文件/外部状态记录                                                  |
| 安全性          | 所有破坏性入口无确认时不产生副作用                      | command contract、negative test、审计日志                                                 |
| Renderer 一致性 | 共享命令在 TUI/terminal-ui/Print 产生等价 runtime event | parity test、真实 PTY                                                                     |
| 安装可靠性      | 公共包可从干净环境安装并运行                            | `npm pack`、registry install、`orion --version`                                           |
| 质量门槛        | 构建、lint、全量测试和聚焦回归全部通过                  | CI/本地日志；覆盖率不低于仓库 70% 指南；仅允许有 owner、期限和明确审批的分支覆盖率 waiver |
| 文档一致性      | README、帮助、配置示例和版本文档不互相矛盾              | registry 契约测试、文档审计                                                               |
| 可恢复性        | 中断、失败、迁移和清理都有明确恢复路径                  | recovery test、迁移 hash、rollback 记录                                                   |

不得用总测试数量替代未覆盖的 PTY、破坏性动作、外部发布或真实安装验收。

## 9. Definition of Done

### 9.1 单个功能或修复

只有同时满足以下条件才算完成：

- 行为与项目级目标和当前版本计划一致；
- 所有 renderer 和调用边界均已考虑；
- 正常路径、失败路径和取消路径有测试；
- 对数据、权限、兼容和迁移的影响已说明；
- 用户可见文档与实际行为一致；
- 没有把实验能力描述为稳定能力。

### 9.2 单个版本

版本发布前必须完成：

- `npm run build`；
- `npm run lint`；
- 适用的全量 Jest、契约测试和真实 PTY；
- 目标 Node 支持矩阵验证；
- `npm pack --dry-run` 和 tarball 干净安装；
- 用户实际终端/PATH smoke test；
- 版本号、Banner、帮助、README、release note 和 npm metadata 一致；
- P0 问题关闭，并有明确的 Go/No-Go 记录；
- 回滚、弃用和迁移路径可执行。

### 9.3 项目目标

不得因为“代码已写完”“测试大多通过”或“模型认为完成”而关闭项目目标。必须：

1. 重新读取原始目标及其所有显式要求；
2. 为每项要求找到权威证据；
3. 将证据判定为完成、矛盾、不完整或缺失；
4. 对矛盾、不完整和缺失项继续工作；
5. 只有全部要求被证明且无必要工作剩余时，才能标记 complete。

## 10. 明确非目标

当前项目不以以下方向为核心：

- 通用闲聊或内容生成产品；
- 自建基础模型或 GPU 推理平台；
- 默认云同步用户代码、会话或记忆；
- 无人监督地执行外部发布、付款、删除或大范围系统修改；
- 为每种 UI 维护独立 Agent 引擎；
- 将 terminal-ui 继续建设为与 TUI 并行的公众产品，或继续为 Ink 开发新能力；
- 以命令数量、模型数量或 Demo 效果替代可靠性；
- 在 CLI 基础语义未稳定前同时扩张 Desktop、Web 和 IDE 产品面。

## 11. 主要风险与控制

| 风险                        | 控制方式                                          |
| --------------------------- | ------------------------------------------------- |
| 目标被回合式聊天稀释        | 持久化目标状态；每轮重新对齐成功条件              |
| Renderer 行为分叉           | 单一 runtime、结构化事件、parity contract         |
| 高风险命令误操作            | 风险元数据、preview、精确目标、显式确认           |
| Provider 配置误诊为代码错误 | 先验证 config、protocol、base URL 和直接请求      |
| 文档声称超过实现            | 发布前文档审计；条件/实验/兼容状态显式标记        |
| 终端图像输出乱码            | 能力探测、surface 预留、清理和 ANSI/text fallback |
| 本地数据迁移损坏            | copy/verify/hash/atomic switch/rollback           |
| 测试总量掩盖关键缺口        | 单独记录 PTY、安全、安装和外部状态证据            |
| 依赖与 Node 版本漂移        | 明确支持矩阵、干净安装、原生模块 smoke test       |

## 12. 决策与文档维护

发生冲突时，按以下顺序决策：

1. 用户明确的当前目标与授权边界；
2. 本项目级目标中的安全原则和不可破坏约束；
3. 当前版本计划与验收门槛；
4. 当前代码、测试和真实运行证据；
5. 历史兼容与实现便利性。

本文档只维护长期方向、边界和项目级成功条件。具体实施任务、排期和版本差异应维护在
`docs/plan/`、issue 或 PR 中，并反向链接到本目标。历史 `docs/mvp/` 文档可保留但不作当前状态源。

以下情况必须更新本文档：

- 项目使命、目标用户或主要产品边界改变；
- 默认客户端或核心 runtime 边界改变；
- 本地优先、安全确认或完成审计原则改变；
- 新阶段取代当前长期交付方向；
- 项目级成功指标被正式调整。

## 13. 关联文档

- [v0.1.0～v0.1.3 已发布历史](../../CHANGELOG.md)
- v0.1.2 Goal 骨架端到端闭环（已完成、已发布）
- [v0.1.4 Research-to-Evidence 计划](../plan/v0.1.4-plan.md)
- [v0.1.4 发布检查清单](../plan/v0.1.4-release-checklist.md)
- [v0.1.5 发布收敛、命令、Effort 与 ACP v1 计划](../plan/v0.1.5-plan.md)
- [Goal evidence and recovery](goal-evidence-and-recovery.md)
- [English README](../../README.md)
- [简体中文 README](../../README.zh-CN.md)
- [Repository Guidelines](../../AGENTS.md)
