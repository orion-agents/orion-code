# v0.3.37 交付状态审计（0.3.34–0.3.36）与 v0.3.36 发布事实回填

> 审计日期：2026-10-25。审计人：自动化轮（v0.3.37）。
>
> 口径：每版核对三项 —— ① git tag 存在且指向 main 合并提交；② npm registry
> 存在同版本（直连 curl，`Cache-Control: no-cache`，不依赖本地 npm 缓存）；
> ③ `dist-tags.latest` 指向最新已发布版本。
>
> 依据：项目级目标 §11.2「分别记录：实现候选、默认分支合并、tag、npm 版本」
> 与 G1「每项完成结论绑定当前代码或外部资源的证据」。

## 审计结果

| 版本   | tag（→ main 合并提交）        | registry shasum（npm SHA-1 口径）          | tarball 入库时间（UTC）  | latest 指向     | 结论 |
| ------ | ----------------------------- | ------------------------------------------ | ------------------------ | --------------- | ---- |
| 0.3.34 | `v0.3.34` → `d511973`（#290） | `a9f5aa120e8e7277eed2d90837c6792bb1621837` | 2026-10-24T07:34:48.885Z | —               | 满足 |
| 0.3.35 | `v0.3.35` → `cfbb4e2`（#291） | `b54d87b2ade509af3479cbd19020b3df5a9f343b` | 2026-10-24T20:06:04.738Z | —               | 满足 |
| 0.3.36 | `v0.3.36` → `6ea1d16`（#292） | `cce4f6cff28966986046d170eac14a9b155fc51f` | 2026-10-25T01:59:21.552Z | `latest=0.3.36` | 满足 |

- 采集方式：`git tag --list 'v0.3.*'` + `git rev-list -n1 <tag>`（本地，与 origin
  同步）+ 直连
  `curl -s -H 'Cache-Control: no-cache' "https://registry.npmjs.org/@orion-agents%2Forion-code?t=<ts>"`
  解析 `versions` / `time` / `dist-tags`（2026-10-25 快照，本轮 v0.3.37 开发前
  现场采集；查询同时确认 0.3.37 尚未发布，避免误判）。
- 口径说明：npm registry 的 `dist.shasum` 是 tarball 的 SHA-1（npm 口径），
  与本地 `npm pack` 产物文件 SHA-256 为不同口径，两者均有效，不构成冲突。

## v0.3.36 发布链路事实（本版回填）

v0.3.36（发布收据回填与交付状态审计切片，plan `docs/plan/v0.3.36-plan.md`）的
发布事实如下，全部可由 git log / registry / GitHub 交叉验证：

- PR：https://github.com/orion-agents/orion-code/pull/292（squash 合并）。
- 合并提交：`6ea1d16`（main，完整 SHA
  `6ea1d167e7b9b3efd6879ee8b0056ad0bd15c873`）。
- tag：`v0.3.36`（指向 main 合并提交 `6ea1d16`）。
- npm：registry shasum `cce4f6cff28966986046d170eac14a9b155fc51f`；tarball 入库
  时间 2026-10-25T01:59:21.552Z。
- registry 确认：直连 curl（`Cache-Control: no-cache`）确认 0.3.36 存在且
  `dist-tags.latest=0.3.36`。
- GitHub Release：**历史欠账补发**。v0.3.36 当轮发布时 GitHub Release 步骤被遗漏
  （v0.3.28–v0.3.36 各轮均未创建，`gh release list` 的 Latest 停留在 v0.3.27），
  本轮（v0.3.37）于开版提交前补发：
  https://github.com/orion-agents/orion-code/releases/tag/v0.3.36 。自本轮起
  「GitHub Release 创建」固定为发布链路第 8 步，v0.3.37 发布完成后同样创建。

## 结论

0.3.34 / 0.3.35 / 0.3.36 三版均满足「tag + registry + latest」三项核对，无交付
状态漂移残留。唯一被本版（v0.3.37）修正的漂移是文档侧：CHANGELOG 0.3.36 条目
停留在 `candidate`、v0.3.36 发布事实未形成仓库内证据文件、GitHub Release 缺失
（已补发 v0.3.36）。

## 明确 not_run

- 人工标注付费质量评测（12 缺陷 + 8 干净样本 × 3 轮）：自动化环境无模型凭据，
  门槛见 `docs/plan/v0.3.27-plan.md` §9.3。
- 真实 Host + Chrome 全链路审查 E2E：同上；CI 承载 exact tgz ×3 平台与
  Web E2E full suite 三连绿 gate。
- v0.3.28–v0.3.35 的 GitHub Release 逐版补发：超出本版范围，由维护者决策；
  本版仅补发 v0.3.36 作为流程修复起点（CHANGELOG published 引用需要真实链接）。
