# v0.3.23 Baseline（PR-0 基线冻结）— 2026-10-09

## 基线事实

| 项 | 值 |
| --- | --- |
| Main SHA | `9f09e0a5f6b9e2894dae7e72971c2cdc826f0006`（#265，v0.3.22） |
| Package Version | `0.3.22` |
| Node（本机执行） | v22.22.3（engines `^22.12.0 \|\| ^24.0.0 \|\| ^26.0.0`） |
| npm latest | `0.3.22`（publishedAt `2026-10-09T06:46:01.644Z`，registry 直连核验） |
| Release Tag | `v0.3.22`（GitHub Release 已建，非 draft/pre） |
| Worktree 路径 | `/Users/hope/ai-project/orion-code.worktrees/v0.3.23` |
| Development Branch | `codex/v0.3.23` |
| 计划 | `docs/plan/v0.3.23-plan.md`（分支 `v0.3.23-plan`，commit `bd7eb94`） |

## PR-0 完成的发布文档漂移修复

进入本周期时 main 的 `release:check` 为 FAIL（3 项：changelog、readme、release-ref）——tag
`v0.3.22` 与 npm 0.3.22 已存在，但 CHANGELOG `[0.3.22]` 仍写 UNRELEASED、README 仍写
candidate。本次修复：CHANGELOG `[0.3.22] → 2026-10-09 published`（refs/tags/v0.3.22 →
9f09e0a，#265，含 GitHub Release 链接），README ×2 改为已发布事实陈述（未引入任何
v0.3.23 candidate 字样，避免 summary-version 门禁）。修复后 CHANGELOG.md entry 与
README release state 两项检查恢复 PASS。

## 三方向既有实现盘点（源码核对，详见计划 §3）

| 能力 | 生产接线状态 |
| --- | --- |
| HarnessKernel 完成审计 + harness/verification | 已接线（task-context-service → 生产） |
| services/auto-fix/（AutoFixRunner + autoFixHook） | 孤儿模块（零外部消费者）→ PR-3 并入后删除 |
| services/verification-profile.ts（命令安全分类/完成门禁） | 孤儿模块（零外部消费者）→ PR-3 并入后删除 |
| file-context / project-instructions / session-memory | 已接线（product-orion-runtime / product-bootstrap） |
| LSP 诊断 | `lsp_get_diagnostics`（descriptors.ts:350）+ diagnostic-tracking，已接线 |
| coding-task-eval live 模式 | 缺口（:315 抛错）→ PR-1 接线 |
| 停止/进度控制 | stop-controller / progress-controller 已接线，PR-3 复用 |

## 当前测试状态（四态口径）

| 套件 | 状态 |
| --- | --- |
| release:check --skip-tests | **pass**（漂移修复后；version/ref/pack 三项由 PR-1 开版收敛） |
| ESLint / tsc --noEmit | **pass** |
| 全量 Jest | **not_run**（PR-1 起按受影响套件执行；CI 为替代通道） |
| Web E2E 三轮连跑 / critical ×3 | **not_run**（随 PR CI 执行） |
| Live Coding Eval 真实模型冒烟 | **blocked**（需用户授权模型与预算后执行） |
| Node 22/24/26 jest 矩阵 | **not_run**（本环境历史性被外部取消；CI 替代通道） |
