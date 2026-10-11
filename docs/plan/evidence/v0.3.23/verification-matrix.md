# v0.3.23 验证矩阵与评测证据（PR-4）— 2026-10-09

状态口径：pass / fail / not_run / blocked。本文件由实际执行的测试生成。

## 自动化验证（本分支本地执行）

| 层 | 套件 | 结果 |
| --- | --- | --- |
| Live Eval | tests/coding-task-eval-live.test.ts（14 场景：五分类、falseComplete 正交、隔离、abort、资源释放、command_exit_zero、invariant、收据序列化、A/B 对比、fake 12/12 回归、未授权拒绝） | **pass** |
| Fake Eval 回归 | tests/coding-task-eval.test.ts（12/12 solved、falseComplete 0、确定性） | **pass** |
| Repo Intelligence | tests/repo-intelligence.test.ts（9 场景：符号/导入边抽取、增量重建、删除回收、忽略表、Recall@2、预算选择、flag 默认关） | **pass** |
| Verified Repair | tests/verified-repair.test.ts（14 场景：四类归因解析、六种循环终局、防作弊三守则、五态映射） | **pass** |
| 回归 | tool-gateway 12 / durability-matrix 10 / issue-fixes-round13（去 auto-fix 后）等 | **pass** |
| 汇总 | 8 套件 122/122 | **pass** |
| 门禁 | release:check / lint / tsc / build | **pass** |

## 三方向交付与验收对照

| 计划验收项 | 状态 |
| --- | --- |
| A：live 模式接线完成（不再抛错），五分类 + falseComplete 正交 | **implemented + tested** |
| A：真实模型冒烟（12 fixture live 全量跑） | **blocked**——按任务书 4.9 需用户批准模型/轮次/预算后执行 |
| A：A/B 报告器 | **implemented + tested**（真实 A/B 轮次同上 blocked） |
| B：符号索引/增量/召回/预算选择 | **implemented + tested** |
| B：Recall@K 评测 | **implemented + tested**（注释任务集 Recall@2；更大任务集属 PR 后续扩展） |
| B：生产 assembler 深度接线 | **implemented（flag 关）**——ORION_CODE_REPO_INTELLIGENCE=on 启用；默认关闭故主路径零风险 |
| C：归因/有界循环/防作弊/五态 | **implemented + tested** |
| C：HarnessKernel 深度接线（修复循环挂入 turn） | **deferred**——循环控制器与五态映射已就绪并以注入式 verify/repair 测试；挂入 turn 循环需特性开关 + 全量回归，列入下一 PR |
| C：孤儿处理 | auto-fix 已删除（语义并入循环）；verification-profile 保留（classifyCommandSafety 被 ui-view-model 接线） |

## False Completion 防线（C4/C5 实证）

- exit-0 但机器检查失败 → `task_failed` + `falseComplete: true`（live 套件断言）。
- 删除测试文件 / 断言弱化 >20% / 改动验收文件 → `ForbiddenRepairError` → terminal `failed`。
- 无可信验证证据 → `unverified`（不并入 completed）。

## Live Eval 授权清单（执行前必填）

| 项 | 待批准值 |
| --- | --- |
| 模型 / Provider | （待定） |
| 每轮任务数 | 12（既有 fixture） |
| 轮数 | 建议 ≥3 |
| 预计 Token | 依 fake 基线推算 ≈ 13k/轮（真实模型通常 10–50×） |
| 成本上限 | （待定） |
