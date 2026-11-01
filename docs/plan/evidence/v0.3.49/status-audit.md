# v0.3.49 交付状态审计 — 三版滚动窗口（0.3.46–0.3.48）

> 审计日期：2026-11-01。
> 数据源：git tag（本地 + `git ls-remote` 远端交叉核对）、npm registry 直连
> （`curl -H 'Cache-Control: no-cache'`）、GitHub PR / Release。
> 方法：每版核对 ① git tag 存在且注释 tag 解引用（`^{}`）指向 main 合并提交；
> ② npm registry 同版本存在（`versions[ver]`）；③ `dist-tags.latest` 指向最新
> 已发布版本。
> 本轮开版欠账清偿依据：main 上 CHANGELOG 的 0.3.48 条目由 `candidate` 翻为
> `published`，回填真实 npm 发布时间戳 2026-11-01T12:28:23.832Z 与
> GitHub Release v0.3.48 链接。

## 审计结论表

| 版本    | git tag（注释 tag 解引用）  | tag 指向 main 合并提交 | npm 版本存在 | registry 入库时间         | registry shasum                            | dist-tag latest    | 结论      |
| ------- | --------------------------- | ---------------------- | ----------- | ------------------------- | ------------------------------------------ | ------------------ | --------- |
| 0.3.46  | `v0.3.46` → `2bccc47…6e83`  | 是（merge `2bccc47`）  | 是          | 2026-10-29T10:25:59.871Z  | `52cdf53ede91794b73b461f541e703231275e643` | 否（已被覆盖）     | published |
| 0.3.47  | `v0.3.47` → `17d85e6…ecc0`  | 是（merge `17d85e6`）  | 是          | 2026-11-01T01:01:52.834Z  | `35a3b6a55c9fe9507bb44b18d0a58ddbb6884459` | 否（已被覆盖）     | published |
| 0.3.48  | `v0.3.48` → `bc4cdbb…a1ce`  | 是（merge `bc4cdbb`）  | 是          | 2026-11-01T12:28:23.832Z  | `193cac1d86101edd6fa0a3d82f571dda6f4c3d5a` | **是（=0.3.48）**  | published |

- 三版 `dist-tags.latest` 序列：0.3.46 → 0.3.47 → 0.3.48，连续推进无回退，符合预期。
- 本地 `git rev-parse v0.3.X^{}` 与 `git ls-remote --tags origin` 的 `refs/tags/v0.3.X^{}`
  完全吻合（2bccc47 / 17d85e6 / bc4cdbb），注释 tag 指向无漂移，且三版 tag 均位于
  `origin/main` 历史上（`git merge-base --is-ancestor` 校验均 yes）。
- 三版 registry shasum 与历史发布轮次记录一致（v0.3.46 轮 / v0.3.47 轮 / v0.3.48 轮），
  并以本轮 registry 直连复核确认，无篡改迹象。

## 0.3.48 发布事实回填（Step 0 开版欠账清偿依据）

- PR：#305（`docs: v0.3.48 - receipt backfill and delivery-status audit (PR4 automatable portion) (#305)`）
- squash 合并提交：`bc4cdbbc15a94f32ebc75ea884d605dd472fa1ce`（main）
- git tag：`v0.3.48`（注释 tag，peel → `bc4cdbb…a1ce`，已推送）
- npm registry：`@orion-agents/orion-code@0.3.48`，`dist-tags.latest=0.3.48`
- registry shasum：`193cac1d86101edd6fa0a3d82f571dda6f4c3d5a`
- tarball 入库时间：`2026-11-01T12:28:23.832Z`
- GitHub Release：`https://github.com/orion-agents/orion-code/releases/tag/v0.3.48`
  （已建，`--latest`，创建于 2026-11-01T12:29:08Z）
- CHANGELOG 0.3.48 条目：本轮（v0.3.49 开版提交）由 `## [0.3.48] — 2026-11-01`
  （`Status: candidate`）翻转为 `Status: published`，并回填上述真实发布时间戳与
  Release 链接。

## 明确 not_run（沿用历轮口径）

- 人工标注付费质量评测（12 缺陷 + 8 干净样本、3 轮运行）：本环境无模型凭据，未运行。
- 真实 Host + Chrome 全链路审查 E2E：本环境无模型凭据与付费评测通道，未运行。

以上为诚实的 `not_run`（blocked by environment），不视为通过。
