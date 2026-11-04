# v0.3.51 交付状态审计 — 三版滚动窗口（0.3.48–0.3.50）

> 审计日期：2026-11-02。
> 数据源：git tag（本地 + `git ls-remote` 远端交叉核对）、npm registry 直连
> （`curl --noproxy '*' -H 'Cache-Control: no-cache'`）、GitHub PR / Release。
> 方法：每版核对 ① git tag 存在且注释 tag 解引用（`^{}`）指向 main 合并提交；
> ② npm registry 同版本存在（`versions[ver]`）；③ `dist-tags.latest` 指向最新
> 已发布版本。
> 本轮开版欠账状态修正：main 上 CHANGELOG 的 0.3.50 条目已由 #311（`0eaccff`，
> 2026-11-04）翻转为 `published` 并回填真实 npm 发布时间戳
> 2026-11-02T03:52:07.285Z 与 GitHub Release v0.3.50 链接，故 v0.3.51 切片不再
> 重复该状态翻转，仅新增 0.3.51 条目与本三版审计。

## 审计结论表

| 版本    | git tag（注释 tag 解引用）  | tag 指向 main 合并提交 | npm 版本存在 | registry 入库时间         | registry shasum（sha1）                    | dist-tag latest    | 结论      |
| ------- | --------------------------- | ---------------------- | ----------- | ------------------------- | ------------------------------------------ | ------------------ | --------- |
| 0.3.48  | `v0.3.48` → `bc4cdbb…a1ce`  | 是（merge `bc4cdbb`）  | 是          | 2026-11-01T12:28:23.832Z  | `193cac1d86101edd6fa0a3d82f571dda6f4c3d5a` | 否（已被覆盖）     | published |
| 0.3.49  | `v0.3.49` → `bb3c518…99a4f` | 是（merge `bb3c518`）  | 是          | 2026-11-01T20:19:49.434Z  | `4ebe49d7e801de7c182c2fe0b64bb953be645e87` | 否（已被覆盖）     | published |
| 0.3.50  | `v0.3.50` → `86af06a…5757f` | 是（merge `86af06a`）  | 是          | 2026-11-02T03:52:07.285Z  | `a1165b7d33ae55499774f69fd16fa0fc0b54fccd` | **是（=0.3.50）**  | published |

- 三版 `dist-tags.latest` 序列：0.3.48 → 0.3.49 → 0.3.50，连续推进无回退，符合预期。
- 本地 `git rev-parse v0.3.X^{}` 与 `git ls-remote --tags origin` 的 `refs/tags/v0.3.X^{}`
  完全吻合（bc4cdbb / bb3c518 / 86af06a），注释 tag 指向无漂移，且三版 tag 均位于
  `origin/main` 历史上（`git merge-base --is-ancestor` 校验均 yes）。
- 三版 registry shasum 与历史发布轮次记录一致（v0.3.48 轮 / v0.3.49 轮 / v0.3.50 轮），
  并以本轮 registry 直连复核确认，无篡改迹象。

## 0.3.50 发布事实回填（Step 0 开版欠账清偿依据）

- PR：#309（`docs: v0.3.50 - receipt backfill and delivery-status audit (PR4 automatable portion) (#309)`）
- squash 合并提交：`86af06ad91168437038e1e59b01c2567abe0757f`（main）
- git tag：`v0.3.50`（注释 tag，peel → `86af06a…5757f`，已推送）
- npm registry：`@orion-agents/orion-code@0.3.50`，`dist-tags.latest=0.3.50`
- registry shasum：`a1165b7d33ae55499774f69fd16fa0fc0b54fccd`
- tarball 入库时间：`2026-11-02T03:52:07.285Z`
- GitHub Release：`https://github.com/orion-agents/orion-code/releases/tag/v0.3.50`
  （已建，`--latest`）
- CI 证据：PR run `41369460372` 最终 18/18 作业逐项核对 success（WEB32-P0-08 时序
  flake 经规程内 rerun 转绿），聚合收据 decision=GO；tarball sha256
  `5f263575e7a614b15ffe5e2107f735d25f96c4b60f698c96de76b9909694c2e9` 与本地
  Node 22 pack 逐字节一致。
- CHANGELOG 0.3.50 条目：已由 #311（`0eaccff`，2026-11-04）在 main 上翻转为
  `Status: published` 并回填上述真实发布时间戳与 Release 链接；v0.3.51 冲突解决
  时以 main 文本为权威，不重复翻转。

## 明确 not_run（沿用历轮口径）

- 人工标注付费质量评测（12 缺陷 + 8 干净样本、3 轮运行）：本环境无模型凭据，未运行。
- 真实 Host + Chrome 全链路审查 E2E：本环境无模型凭据与付费评测通道，未运行。

以上为诚实的 `not_run`（blocked by environment），不视为通过。
