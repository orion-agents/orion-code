# Professional Code Review Loop — 使用与语义

> 状态：与 `src/services/code-review`（冻结契约）及 Web 审查运行端点对齐；
> 本文档是使用与语义说明，不是发布收据。覆盖版本：v0.3.27–v0.3.30。
>
> 关联：[v0.3.27 plan](../plan/v0.3.27-plan.md)（契约与切片）、
> [项目级目标 C6 / G9](../goals/orion-code-项目级目标.md)。

Orion 提供一条共享的专业代码审查回路：CLI 的 `/review` 与 Web Workbench 的
Review 面板复用同一运行器（`runCodeReview`）、同一冻结契约（`CodeReviewResultV1`）
与同一只读约束，不维护第二套审查引擎。

## 1. 审查什么：范围选择器

`ReviewSelectorV1` 只有两类范围：

| kind       | 含义           | 说明                                                                                                                                                          |
| ---------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worktree` | 当前工作区变更 | staged（index）、unstaged（工作区内容）与 untracked 作为**独立来源**捕获，不混源                                                                              |
| `base`     | 与基线的比较   | `ref` 在 admission 时冻结为 merge-base..HEAD 的不可变 OID，含 rename 追踪；ref 无法解析或无 merge base 时返回类型化错误（`ref_unresolved` / `no_merge_base`） |

两类范围都支持可选 `paths` 过滤。敏感文件与二进制条目在不读取内容的前提下跳过；
快照 reader 拒绝离开仓库根目录。

## 2. 怎么审：只读约束与预算

- **只读 workflow 约束**：默认拒绝一切非读工具（`read_file`、`list_files`、`glob`、
  `grep` 之外全部拒绝），dispatch 级 guard 的 digest 绑定进收据。审查不修改代码；
  修复是另一个显式任务。
- **预算只能收紧（tighten-only）**：默认预算为 50 文件 / 2 MiB 正文 / 1 MiB diff /
  50 次读工具调用 / 5 分钟 / 100 findings / 256 KiB 结果。超预算部分跳过并记录
  类型化原因，不会截断后冒充完整。

## 3. 结果怎么可信：状态、结论与 digest

- **运行状态**（`ReviewRunStateV1`）：`queued` / `running` / `completed` /
  `partial` / `failed` / `cancelled`。`queued` 与 `running` 永远不携带结论。
- **结论**（`ReviewConclusionV1`）：`findings` / `no_findings` / `inconclusive`。
  只有 `completed` + 覆盖完整 + 输出无无效 finding 时才可能给出 `no_findings`；
  partial / failed / cancelled / 不可信输出永远不能伪装成绿色的"无问题"。
- **findings**：P0–P3 优先级、标题、触发条件、影响、`fileKey` + side + 行号、
  证据文本；字段长度与总数受 `FINDING_TEXT_LIMITS` 与结果字节上限约束，契约无效
  的输出计数可见，不会被静默丢弃或隐藏。
- **digest 可验证**：每份收据带 digest，读回时重新计算校验；校验失败的收据不会
  被当作有效结论展示。
- **stale 只注记、不改写历史**：代码或规则变化后，历史收据被标记
  `stale`（`ReviewApplicabilityV1`），但内容不重写；把过期结果作为当前结论发送
  会在 Provider 前被阻止。

## 4. CLI：`/review`

`/review` 发起一次类型化审查：冻结快照 → 单轮有界模型补全 → 契约校验 →
digest 可验证收据 → TUI 投影。预算与取消即时生效；正常 BUILD 回合不残留审查期
权限。崩溃后已提交收据可恢复，半提交不完成。

## 5. Web：Review 面板的审查运行

- `POST /review/run` 快速准入并立即返回 `{ runId, status: 'running' }`；模型补全
  在后台继续，客户端轮询 `GET /review/runs` / `GET /review/runs/:runId`。
- 同一 Workspace 同时只允许一个运行中的审查：重复启动返回 409
  （`review_run_in_progress`）；Host 未配置模型返回 422（`review_no_model`）。
- 收据历史有界（最近 20 条，淘汰最旧的非运行记录），读回时重算 digest 并按
  admission 时的 `repositoryRevision` 对比标记 `stale`。
- **Host 重启后审查历史不保留**（内存态）；UI 如实显示这一边界，持久化属后续版本。
- Review 面板把 findings 按 P0→P3 分组、锚定到既有 diff 视图；每个 finding 可作为
  类型化文本送回对话草稿——**草稿不自动发送、不自动修复**，提交仍由用户确认。
- 写入端点全部经过 `assertMutation`（nonce + Origin 校验，失败 403）。

## 6. 资格状态（如实记录）

- 契约、快照、CLI 运行时、Web 闭环均已交付并有单测 / 真实 Host 端点测试。
- **人工标注付费质量评测：`not_run`**（本机与 CI 自动化环境无模型凭据）。
  未来按 v0.3.27 plan §9.3 验收：12 缺陷 + 8 干净样本、固定模型与预算、独立
  3 轮，每轮召回 ≥ 9/12、有效 finding precision ≥ 80%。
- 真实 Host + Chrome 全链路 E2E：`not_run`（同上）；CI 承载 exact-tarball
  与 Web E2E full suite 三连绿 gate。
