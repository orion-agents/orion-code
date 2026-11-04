# Orion Code 水位评测报告 · skills-rsi-eval（2026-11-04）

- 基线：`refs/remotes/origin/main` @ `86af06a`（= tag `v0.3.50`，npm `latest=0.3.50`，publish `2026-11-02T03:52:07.285Z`，GitHub Release `v0.3.50`，PR #309）
- 分支：`codex/skills-eval-rsi`
- 执行环境：本机沙箱，**无任何模型凭据**（`ORION_CODE_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DASHSCOPE_API_KEY` 均为空）
- 复现方式：`.agents/skills/orion-self-eval/SKILL.md` 第 0~4 步

## 1. 水位结论（分层，不合并成单一数字）

| 层 | 问题 | 结论 | 证据 digest |
| --- | --- | --- | --- |
| T1 结构 | 运行时自带门禁是否通过、代价多少 | **GO** | `843806643471dd97`（harness-eval） |
| T2 对话回路 | 真实 turn 能否经生产入口走到合法终态、工具是否真执行 | **GO（3/3，假完成 0）** | `e18db8ef464dff29`（tier2 receipt，本报告同目录 `tier2-conversation-receipt.json`） |
| T3 真实模型判断力 | recall / precision / 假完成是否达标 | **not_run** | 无凭据 + 20 样本标注集 `HumanReview=PENDING` |

**一句话水位**：Orion Code 的**结构与回路已被可复核证据证明健康**；它的**判断力质量仍是未知量**——不是"好"也不是"差"，而是当前无法测。任何把 T1/T2 绿说成"agent 质量好"的表述都是越界。

## 2. T1 逐检查 actual（基线 86af06a，`npm run bench:harness:eval`）

| 检查 | actual | 阈值 |
| --- | --- | --- |
| successful-input-token-reduction | **76.114913%** | ≥30% |
| task-success-not-lower | 100 | ≥100 |
| false-completion-rate | 0 | 0 |
| model-request-growth | 0 | <5 |
| capability-expansion-rate | 0 | <10% |
| local-orchestration-p95 | **0.925459 ms** | <5 ms |
| same-environment-corpus | pass（corpus digest 一致） | — |
| receipt-modes | `baseline->candidate` | — |

对照：同一份 T1 在陈旧基线（本地 `main`，package 0.3.43）上 p95 = 0.869333 ms，差异属测量抖动，不构成回归证据。

## 3. T2 真对话逐任务观测（`conversation-eval.mjs`，脚本模型 + 生产 print 入口）

| 任务 | exit | toolEvents | 工具 | 工具失败 | errors | 会话 | modelRequests | 写副作用 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1-glob-workspace | 0 | 2 | `glob` | 0 | 0 | present | 2 | 0 |
| T2-read-file-sentinel | 0 | 2 | `read_file` | 0 | 0 | present | 2 | 0 |
| T3-grep-pattern | 0 | 2 | `grep` | 0 | 0 | present | 2 | 0 |

要点：`toolEventCount=2` 说明 **模型回合 → 工具执行 → 工具结果回填 → 终答** 走完整圈；`filesAdded=[]` 与 `sessionId=present` 说明读侧任务无写副作用且会话确实落盘。`content_matches` 断言把"答案里必须出现工具真实读到的内容"作为硬条件，因此**空转式假完成无法通过 T2**。

T2 当前只覆盖只读工具族。原因：print 模式对权限请求一律 `approved: false`，写类工具在此测的是"拒绝路径"而非"能力"——若要测写能力，必须显式设成一个断言拒绝行为的任务，而不是把它混进能力评分。

## 4. 发现与优化意见（按可执行优先级）

**F-1（阻塞级，结构性冲突）门禁要求"占版本号"，与质量条款 C 互斥。**
`release:check` 的 `Release ref` 检查要求 HEAD 即该版本 tag 提交；主干 tip 恰是 tag（main 的 push CI 里 `Release gate` 为 ✅），于是**任何从已发布主干切出、且不占版本号的迭代分支必然 NO-GO**。实测：本分支 `release-ref` ❌。
后果：条款 C 想要的"docs-only 周期不占版本号"在 CI 层面无法成立——要么违规占号，要么带红开 PR。
处置（二选一，**需人工评审，不在本 PR 擅自放宽**）：
(a) 给 `release-check` 增加非发布分支模式——HEAD 超前最新 tag 且分支名未声明版本时，post-release drift 记为信息项；
(b) 主干在两次发布之间保留 `UNRELEASED` 段落，发布分支才把版本写进顶层 section。

**F-2（高危陷阱，本轮亲身命中）本地 `main` 会静默落后已发布版本。**
`git fetch` 前本地 `main` = `fa03965`（package 0.3.43），而 origin/main = `86af06a`（v0.3.50），**落后 7 个提交**；npm 早已是 0.3.50。直接 `git worktree add -b … main` 会基于陈旧代码开发——我第一次跑出的 T2 digest 就是 `f88596148fe737f4`（基线 0.3.43），变基后才得到 `e18db8ef464dff29`。
处置（已落地）：`orion-self-eval` 第 0 步强制 `git fetch origin main` + `rev-list --left-right --count` + `merge-base --is-ancestor <最新tag> origin/main`；`orion-rsi-loop` 第 1 步同样禁止从本地 `main` 开分支。

**F-3（主干红）main 的 push CI 有失败作业。**
run `41384830430`：`Web E2E full suite three consecutive runs` ❌，其余 12 个作业 ✅（含 `Release gate`）。按条款 B，主干带红时不应发布新版本；这条红也污染所有后续基线。历史同类现象指向 WEB3x 计时 flake 家族，需按"隔离复跑定性"处理而非改断言。

**F-4（测量缺口，RSI 最高杠杆）T3 不可测。**
既无凭据，20 样本标注集的 `HumanReview` 仍是 `PENDING`。这意味着**关于"质量"的任何自我改进都无法被验证**，回路只能在 T1/T2 上空转成本优化。
处置：先签认标注集（人工，成本低），再开一次最小预算的 T3（3 轮，产出 recall/precision/假完成率与有效终态数），把阈值钉进 CI 收据，之后才谈"变强了"。

**F-5（信息级，品牌/供应链）npm 上裸名 `orion-code` 是他人无关包（latest 1.5.9）。**
本项目正确使用 `@orion-agents/orion-code`，README 双版本安装 pin 也都是 scoped 形式；但任何人手敲 `npm i -g orion-code` 会装到别人的包。建议：文档显著标注 scoped 必填，并考虑在 release notes 里固定这句警示。

**F-6（已修复）主干发布状态欠账。**
`v0.3.50` 已 tag、已发布、已有 Release，但 `CHANGELOG.md` / `README.md` / `README.zh-CN.md` 仍写 `candidate` / `候选版本`，导致 `release:check` 的 changelog + readme 两项对**每个**从主干切出的分支报红。实测修复后两项转 ✅（见本报告 §1 前的验证记录）。注意该 section 里连 "from `candidate` to `published`" 这类历史叙述也会命中门禁的 candidate 关键字——这是关键字式状态检测的脆弱点，长期应由结构化字段替代正文关键词。

## 5. RSI 方向（下一轮起，按杠杆排序）

1. **让 T3 变可测**（F-4）：唯一能衡量"判断力"的层，缺它则整个自迭代只能在成本/结构维度优化。
2. **解掉 F-1 的门禁-条款冲突**：否则"小步快改"的迭代分支永远带着一个与代码无关的红灯，评审信号被长期噪声化。
3. **修主干 E2E 红灯（F-3）**：红主干会让每一次基线比较都失去意义。
4. **把水位收据接入 CI**：T2 目前是本地产物；作为 artifact 上传后，digest 才能进入历史序列，形成真正的棘轮（否则"改好了"仍然只是叙述）。
5. **扩充 T2 语料**：加入写路径的拒绝行为断言、预算熔断断言、会话恢复断言（resume 后消息不重复），把"回路完整性"从 3 个任务扩到覆盖失败分支。
6. **把状态检测从关键词升级为结构化字段**（F-6 尾注）：消除"正文提到 candidate 就算未发布"这类误伤。

## 6. 本轮自身遵守的护栏

未修改任何门禁阈值或断言来换取绿灯；F-1 以"报告 + 待评审方案"形式上交；所有数字来自本轮命令输出（非记忆、非上一轮摘要）；提交按文件精确 `git add`；不动主工作区未跟踪草稿；PR 不自动合并。
