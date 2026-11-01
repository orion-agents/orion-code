# v0.3.48 交付状态审计 — 三版滚动窗口（0.3.45–0.3.47）

> 审计日期：2026-11-01。
> 数据源：git tag（本地 + `git ls-remote` 远端交叉核对）、npm registry 直连
> （`curl --noproxy '*' -H 'Cache-Control: no-cache'`）、GitHub PR / Release。
> 方法：每版核对 ① git tag 存在且注释 tag 解引用（`^{}`）指向 main 合并提交；
> ② npm registry 同版本存在（`versions[ver]`）；③ `dist-tags.latest` 指向最新
> 已发布版本。
> 本轮开版欠账清偿依据：main 上 CHANGELOG 的 0.3.47 条目由 `candidate` 翻为
> `published`，回填真实 npm 发布时间戳 2026-11-01T01:01:52.834Z 与
> GitHub Release v0.3.47 链接。

## 审计结论表

| 版本    | git tag（注释 tag 解引用）            | tag 指向 main 合并提交 | npm 版本存在 | registry 入库时间            | registry shasum                          | dist-tag latest | 结论     |
| ------- | ------------------------------------ | ---------------------- | ----------- | --------------------------- | ---------------------------------------- | --------------- | -------- |
| 0.3.45  | `v0.3.45` → `4216ab0…f29e`           | 是（merge `4216ab0`）   | 是          | 2026-10-28T23:12:19.822Z    | `cd499a01c076a2cf79b927051cd07efded4d76e1` | 否（已被覆盖）  | published |
| 0.3.46  | `v0.3.46` → `2bccc47…6e83`           | 是（merge `2bccc47`）   | 是          | 2026-10-29T10:25:59.871Z    | `52cdf53ede91794b73b461f541e703231275e643` | 否（已被覆盖）  | published |
| 0.3.47  | `v0.3.47` → `17d85e6…ecc0`           | 是（merge `17d85e6`）   | 是          | 2026-11-01T01:01:52.834Z    | `35a3b6a55c9fe9507bb44b18d0a58ddbb6884459` | **是（=0.3.47）** | published |

- 三版 `dist-tags.latest` 序列：0.3.45 → 0.3.46 → 0.3.47，连续推进无回退，符合预期。
- 本地 `git rev-parse v0.3.X^{}` 与 `git ls-remote --tags origin` 的 `refs/tags/v0.3.X^{}`
  完全吻合（4216ab0 / 2bccc47 / 17d85e6），注释 tag 指向无漂移，且三版 tag 均位于
  `origin/main` 历史上（`git merge-base --is-ancestor` 校验均 yes）。
- 三版 registry shasum 与历史发布轮次记录一致（v0.3.45 轮 / v0.3.46 轮 / v0.3.47 轮），
  并以本轮 registry 直连复核确认，无篡改迹象。

## 0.3.47 发布事实回填（Step 0 开版欠账清偿依据）

- PR：#304（`docs: v0.3.47 - receipt backfill and delivery-status audit (PR4 automatable portion) (#304)`）
- squash 合并提交：`17d85e6e9dfd5a0e82fb743db40e7ae30fa8ecc0`（main）
- git tag：`v0.3.47`（注释 tag，peel → `17d85e6…ecc0`，已推送）
- npm registry：`@orion-agents/orion-code@0.3.47`，`dist-tags.latest=0.3.47`
- registry shasum：`35a3b6a55c9fe9507bb44b18d0a58ddbb6884459`
- tarball 入库时间：`2026-11-01T01:01:52.834Z`
- GitHub Release：`https://github.com/orion-agents/orion-code/releases/tag/v0.3.47`（已建，`--latest`）
- CHANGELOG 0.3.47 条目：本轮（v0.3.48 开版提交）由 `## [0.3.47] — 2026-10-29`
  （`Status: candidate`）翻转为 `## [0.3.47] — 2026-11-01`（`Status: published`），
  并回填上述真实发布时间戳与 Release 链接。

## 0.3.45 / 0.3.46 发布事实（同源复核，滚动窗口保留）

- 0.3.45：PR #302，merge `4216ab0`，tag `v0.3.45`（peel → `4216ab0`），
  registry shasum `cd499a01c076a2cf79b927051cd07efded4d76e1`，入库 2026-10-28T23:12:19.822Z，
  Release https://github.com/orion-agents/orion-code/releases/tag/v0.3.45。
- 0.3.46：PR #303，merge `2bccc47`，tag `v0.3.46`（peel → `2bccc47`），
  registry shasum `52cdf53ede91794b73b461f541e703231275e643`，入库 2026-10-29T10:25:59.871Z，
  Release https://github.com/orion-agents/orion-code/releases/tag/v0.3.46。

## 明确 `not_run`（如实记录，不伪造）

- 人工标注付费质量评测（12 缺陷 + 8 干净样本、3 轮运行）：本自动化环境无模型凭据，
  不在本版执行，记为 `not_run`。
- 真实 Host + Chrome 全链路审查 E2E：同上，无模型凭据，记为 `not_run`。

## 历史 GitHub Release 欠账说明

v0.3.28–v0.3.35 的 GitHub Release 是否逐版补发由维护者决策，不在本版范围内处理；
v0.3.36 起每轮均已在本轮发布链路中创建 `--latest` Release，链条完整。
