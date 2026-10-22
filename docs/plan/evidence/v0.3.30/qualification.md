# v0.3.30 资格证据（PR4 可自动化切片）

> 记录日期：2026-10-22。本文件只记录实际执行过的检查；未执行项如实记 `not_run`。

## 范围

- Plan：`docs/plan/v0.3.30-plan.md`（PR4 可自动化子切片：文档对齐 + 使用文档 +
  发布状态修正 + 六处版本 bump）。
- 不含生产代码改动；`src/` 与 `web/src/` 未触碰；未新增 E2E 场景。

## 本地检查

| 检查                    | 结果            | 备注                                                                                                    |
| ----------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `npm run build`         | pass            | v0.3.30 worktree 全新构建；web-client vite 构建成功（ReviewPanel/GitPanel/TerminalPanel 等产物正常）    |
| prettier（改动文件）    | pass            | 仅对本次改动文件 `--write`；曾误格式化既有 evidence 文件，已 `git restore` 还原并核实工作区只含预期改动 |
| `npm run release:check` | 见下            | Version consistency / README pin / CHANGELOG 状态门禁                                                   |
| 相关 Jest 套件          | pass（CI 为准） | 本轮无 `src/`、`web/src/` 改动，无新增测试对象；release:check 内置套件结果见下                          |

## release:check 结果（2026-10-22，本地）

- PASS：Version consistency（`release-branch=codex/v0.3.30`、shrinkwrap 顶层与
  `packages[""]` 均 0.3.30、README 两处 pin 与 summary 均 0.3.30）。
- PASS：CHANGELOG entry（`[0.3.30] — UNRELEASED`，candidate 规则命中）。
- PASS：ESLint（0 errors）、`tsc --noEmit`（0 type errors）、`git diff --check`。
- PASS：npm package artifact（exact-tgz 791 files / packed 1.79 MB，
  sha256 `7562962f711fe89377f88a294bb5bb8cb3ef4651a5b35860cb64ec1106ab5b56`，
  consumer lifecycle install/version/help/native/Web ok）。
- FAIL（预期内，发布前提交后消除）：Clean worktree —— 门禁在提交前运行，
  8 个 dirty 条目即本次改动本身。
- Jest 套件：376 passed / 5 failed。其中 `coding-task-eval` 为版本 pin 断言
  未随 bump（`packageVersion` 期望 0.3.29），已修正为 0.3.30 后单独重跑通过；
  其余 4 个（`release-scripts` / `storage-maintenance` / `vector` /
  `dependency-health`）为本机 better-sqlite3 `NODE_MODULE_VERSION 147 vs 127`
  环境问题（与 v0.3.29 轮结论一致），以 CI 同名 job 绿为准。

## 发布链路（合并后回填）

- PR：待填
- squash 合并提交：待填
- tag：`v0.3.30`（指向 main 合并提交）
- npm：`npm pack --ignore-scripts` 产出的精确 tgz 与字节数：待填
- registry 确认：直连 curl（`Cache-Control: no-cache`）结果：待填

## 明确 not_run

- 人工标注付费质量评测（12 缺陷 + 8 干净样本 × 3 轮）：自动化环境无模型凭据，
  门槛见 `docs/plan/v0.3.27-plan.md` §9.3。
- 真实 Host + Chrome 全链路审查 E2E：同上；CI 承载 exact tgz ×3 平台与
  Web E2E full suite 三连绿 gate。
