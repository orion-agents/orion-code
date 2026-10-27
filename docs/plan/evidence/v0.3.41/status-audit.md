# v0.3.41 交付状态审计 — 三版滚动窗口（0.3.38–0.3.40）

> 审计日期：2026-10-27。
> 数据源：git tag（本地 + `git ls-remote` 远端交叉核对）、npm registry 直连
>（`curl --noproxy '*' -H 'Cache-Control: no-cache'`）、GitHub PR / Release。
> 方法：每版核对 ① git tag 存在且注释 tag 解引用（`^{}`）指向 main 合并提交；
> ② npm registry 同版本存在（`versions[ver]`）；③ `dist-tags.latest` 指向最新
> 已发布版本。

## 审计结论表

| 版本    | git tag（注释 tag 解引用）            | tag 指向 main 合并提交 | npm 版本存在 | registry 入库时间            | registry shasum                          | dist-tag latest | 结论     |
| ------- | ------------------------------------ | ---------------------- | ----------- | --------------------------- | ---------------------------------------- | --------------- | -------- |
| 0.3.38  | `v0.3.38` → `4cb727e…2708c`          | 是（merge `4cb727e`）   | 是          | 2026-10-25T20:50:25.203Z    | `5c15a05421c53d66cc543c9d9ab4516e1e04d18f` | 否（已被覆盖）  | published |
| 0.3.39  | `v0.3.39` → `5a51932…5617e`          | 是（merge `5a51932`）   | 是          | 2026-10-26T03:17:19.937Z    | `00ed86afcab446a5ce9fbf8c80199af23d3688f8` | 否（已被覆盖）  | published |
| 0.3.40  | `v0.3.40` → `ef45214…58a1`           | 是（merge `ef45214`）   | 是          | 2026-10-26T18:21:55.395Z    | `5ab9c3e3c76d4224340736f0351c5e48b1f74f3b` | **是（=0.3.40）** | published |

- 三版 `dist-tags.latest` 序列：0.3.38 → 0.3.39 → 0.3.40，连续推进无回退，符合预期。
- 本地 `git rev-parse v0.3.X^{}` 与 `git ls-remote --tags origin` 的 `refs/tags/v0.3.X^{}`
  完全吻合，注释 tag 指向无漂移。
- 三版 registry shasum 与历史发布轮次记录一致（v0.3.38 轮 / v0.3.39 轮 / v0.3.40 轮），
  无篡改迹象。

## 0.3.40 发布事实回填（Step 0 开版欠账清偿依据）

- PR：#297（`docs: v0.3.40 — receipt backfill and delivery-status audit (PR4 automatable portion) (#297)`）
- squash 合并提交：`ef45214c9163b85d423f364d6c71c077d31d58a1`（main）
- git tag：`v0.3.40`（注释 tag，peel → `ef45214…58a1`，已推送）
- npm registry：`@orion-agents/orion-code@0.3.40`，`dist-tags.latest=0.3.40`
- registry shasum：`5ab9c3e3c76d4224340736f0351c5e48b1f74f3b`
- tarball 入库时间：`2026-10-26T18:21:55.395Z`
- GitHub Release：`https://github.com/orion-agents/orion-code/releases/tag/v0.3.40`（已建，`--latest`）
- CHANGELOG 0.3.40 条目：本轮（v0.3.41 开版提交）由 `Status: candidate` 翻转为
  `Status: published`，并回填上述真实发布时间戳与 Release 链接。

## 0.3.38 / 0.3.39 发布事实（同源复核，滚动窗口保留）

- 0.3.38：PR #295，merge `4cb727e`，tag `v0.3.38`（peel → `4cb727e`），
  registry shasum `5c15a05421c53d66cc543c9d9ab4516e1e04d18f`，入库 2026-10-25T20:50:25.203Z，
  Release https://github.com/orion-agents/orion-code/releases/tag/v0.3.38。
- 0.3.39：PR #296，merge `5a51932`，tag `v0.3.39`（peel → `5a51932`），
  registry shasum `00ed86afcab446a5ce9fbf8c80199af23d3688f8`，入库 2026-10-26T03:17:19.937Z，
  Release https://github.com/orion-agents/orion-code/releases/tag/v0.3.39。

## 明确 `not_run`（如实记录，不伪造）

- 人工标注付费质量评测（12 缺陷 + 8 干净样本、3 轮运行）：本自动化环境无模型凭据，
  不在本版执行，记为 `not_run`。
- 真实 Host + Chrome 全链路审查 E2E：同上，无模型凭据，记为 `not_run`。

## 历史 GitHub Release 欠账说明

v0.3.28–v0.3.35 的 GitHub Release 是否逐版补发由维护者决策，不在本版范围内处理；
v0.3.36 起每轮均已在本轮发布链路中创建 `--latest` Release，链条完整。
