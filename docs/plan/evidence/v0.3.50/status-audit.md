# v0.3.50 交付状态审计 — 三版滚动窗口（0.3.47–0.3.49）

> 审计日期：2026-11-02。
> 数据源：git tag（本地 + `git ls-remote` 远端交叉核对）、npm registry 直连
> （`curl --noproxy '*' -H 'Cache-Control: no-cache'`）、GitHub PR / Release。
> 方法：每版核对 ① git tag 存在且注释 tag 解引用（`^{}`）指向 main 合并提交；
> ② npm registry 同版本存在（`versions[ver]`）；③ `dist-tags.latest` 指向最新
> 已发布版本。
> 本轮开版欠账清偿依据：main 上 CHANGELOG 的 0.3.49 条目由 `candidate` 翻为
> `published`，回填真实 npm 发布时间戳 2026-11-01T20:19:49.434Z 与
> GitHub Release v0.3.49 链接。

## 审计结论表

| 版本    | git tag（注释 tag 解引用）  | tag 指向 main 合并提交 | npm 版本存在 | registry 入库时间         | registry shasum（sha1）                    | dist-tag latest    | 结论      |
| ------- | --------------------------- | ---------------------- | ----------- | ------------------------- | ------------------------------------------ | ------------------ | --------- |
| 0.3.47  | `v0.3.47` → `17d85e6…ecc0`  | 是（merge `17d85e6`）  | 是          | 2026-11-01T01:01:52.834Z  | `35a3b6a55c9fe9507bb44b18d0a58ddbb6884459` | 否（已被覆盖）     | published |
| 0.3.48  | `v0.3.48` → `bc4cdbb…a1ce`  | 是（merge `bc4cdbb`）  | 是          | 2026-11-01T12:28:23.832Z  | `193cac1d86101edd6fa0a3d82f571dda6f4c3d5a` | 否（已被覆盖）     | published |
| 0.3.49  | `v0.3.49` → `bb3c518…99a4f` | 是（merge `bb3c518`）  | 是          | 2026-11-01T20:19:49.434Z  | `4ebe49d7e801de7c182c2fe0b64bb953be645e87` | **是（=0.3.49）**  | published |

- 三版 `dist-tags.latest` 序列：0.3.47 → 0.3.48 → 0.3.49，连续推进无回退，符合预期。
- 本地 `git rev-parse v0.3.X^{}` 与 `git ls-remote --tags origin` 的 `refs/tags/v0.3.X^{}`
  完全吻合（17d85e6 / bc4cdbb / bb3c518），注释 tag 指向无漂移，且三版 tag 均位于
  `origin/main` 历史上（`git merge-base --is-ancestor` 校验均 yes）。
- 三版 registry shasum 与历史发布轮次记录一致（v0.3.47 轮 / v0.3.48 轮 / v0.3.49 轮），
  并以本轮 registry 直连复核确认，无篡改迹象。

## 0.3.49 发布事实回填（Step 0 开版欠账清偿依据）

- PR：#306（`docs: v0.3.49 - receipt backfill and delivery-status audit (PR4 automatable portion) (#306)`）
- squash 合并提交：`bb3c518322fbb71fcbdbc413610b1b8c20c99a4f`（main）
- git tag：`v0.3.49`（注释 tag，peel → `bb3c518…99a4f`，已推送）
- npm registry：`@orion-agents/orion-code@0.3.49`，`dist-tags.latest=0.3.49`
- registry shasum：`4ebe49d7e801de7c182c2fe0b64bb953be645e87`
- tarball 入库时间：`2026-11-01T20:19:49.434Z`
- GitHub Release：`https://github.com/orion-agents/orion-code/releases/tag/v0.3.49`
  （已建，`--latest`）
- CI 证据：run `41317993965`，18/18 作业逐项核对 success，聚合收据 decision=GO；
  tarball sha256 `8d5d2ffb94d4963b17635f6b17bc5a35f286950b06bd7cc597d68fce9ae40a32`
  与本地 Node 22 pack 逐字节一致（首轮 sha 不一致已定性为 Node 24/22 zlib 压缩流
  差异，tar 流与内容逐字节相同，详见 v0.3.49 轮汇报）。
- CHANGELOG 0.3.49 条目：本轮（v0.3.50 开版提交）由 `## [0.3.49] — 2026-11-01`
  （`Status: candidate`）翻转为 `Status: published`，并回填上述真实发布时间戳与
  Release 链接。

## 明确 not_run（沿用历轮口径）

- 人工标注付费质量评测（12 缺陷 + 8 干净样本、3 轮运行）：本环境无模型凭据，未运行。
- 真实 Host + Chrome 全链路审查 E2E：本环境无模型凭据与付费评测通道，未运行。

以上为诚实的 `not_run`（blocked by environment），不视为通过。
