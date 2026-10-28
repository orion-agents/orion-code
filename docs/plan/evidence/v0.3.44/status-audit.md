# v0.3.44 交付状态审计 — 三版滚动窗口（0.3.41–0.3.43）

> 审计日期：2026-10-28。
> 数据源：git tag（本地 + `git ls-remote` 远端交叉核对）、npm registry 直连
> （`curl --noproxy '*' -H 'Cache-Control: no-cache'`）、GitHub PR / Release。
> 方法：每版核对 ① git tag 存在且注释 tag 解引用（`^{}`）指向 main 合并提交；
> ② npm registry 同版本存在（`versions[ver]`）；③ `dist-tags.latest` 指向最新
> 已发布版本。
> 本轮开版欠账清偿依据：main 上 CHANGELOG 的 0.3.43 条目由 `candidate` 翻为
> `published`，回填真实 npm 发布时间戳 2026-10-27T19:02:04.278Z 与
> GitHub Release v0.3.43 链接。

## 审计结论表

| 版本    | git tag（注释 tag 解引用）            | tag 指向 main 合并提交 | npm 版本存在 | registry 入库时间            | registry shasum                          | dist-tag latest | 结论     |
| ------- | ------------------------------------ | ---------------------- | ----------- | --------------------------- | ---------------------------------------- | --------------- | -------- |
| 0.3.41  | `v0.3.41` → `2abc8e3…a0f5`           | 是（merge `2abc8e3`）   | 是          | 2026-10-27T00:30:30.123Z    | `a8556876c957687bc8c2f3c868d198fe881cf160` | 否（已被覆盖）  | published |
| 0.3.42  | `v0.3.42` → `50628a7…dcea`           | 是（merge `50628a7`）   | 是          | 2026-10-27T06:27:35.184Z    | `87bc5caef92306411a727577b559939177393774` | 否（已被覆盖）  | published |
| 0.3.43  | `v0.3.43` → `fa03965…11ab`           | 是（merge `fa03965`）   | 是          | 2026-10-27T19:02:04.278Z    | `87f24a01a9331c1137e62815f8a31ce1ea4b8bcc` | **是（=0.3.43）** | published |

- 三版 `dist-tags.latest` 序列：0.3.41 → 0.3.42 → 0.3.43，连续推进无回退，符合预期。
- 本地 `git rev-parse v0.3.X^{}` 与 `git ls-remote --tags origin` 的 `refs/tags/v0.3.X^{}`
  完全吻合，注释 tag 指向无漂移，且三版 tag 均位于 `origin/main` 历史上
  （`git merge-base --is-ancestor` 校验均 yes）。
- 三版 registry shasum 与历史发布轮次记录一致（v0.3.41 轮 / v0.3.42 轮 / v0.3.43 轮），
  无篡改迹象。

## 0.3.43 发布事实回填（Step 0 开版欠账清偿依据）

- PR：#300（`docs: v0.3.43 - receipt backfill and delivery-status audit (PR4 automatable portion) (#300)`）
- squash 合并提交：`fa039652e228b24add0cfb017283cf5947ef11ab`（main）
- git tag：`v0.3.43`（注释 tag，peel → `fa03965…11ab`，已推送）
- npm registry：`@orion-agents/orion-code@0.3.43`，`dist-tags.latest=0.3.43`
- registry shasum：`87f24a01a9331c1137e62815f8a31ce1ea4b8bcc`
- tarball 入库时间：`2026-10-27T19:02:04.278Z`
- GitHub Release：`https://github.com/orion-agents/orion-code/releases/tag/v0.3.43`（已建，`--latest`）
- CHANGELOG 0.3.43 条目：本轮（v0.3.44 开版提交）由 `## [0.3.43] — UNRELEASED`
  （`Status: candidate`）翻转为 `## [0.3.43] — 2026-10-27`（`Status: published`），
  并回填上述真实发布时间戳与 Release 链接。

## 0.3.41 / 0.3.42 发布事实（同源复核，滚动窗口保留）

- 0.3.41：PR #298，merge `2abc8e3`，tag `v0.3.41`（peel → `2abc8e3`），
  registry shasum `a8556876c957687bc8c2f3c868d198fe881cf160`，入库 2026-10-27T00:30:30.123Z，
  Release https://github.com/orion-agents/orion-code/releases/tag/v0.3.41。
- 0.3.42：PR #299，merge `50628a7`，tag `v0.3.42`（peel → `50628a7`），
  registry shasum `87bc5caef92306411a727577b559939177393774`，入库 2026-10-27T06:27:35.184Z，
  Release https://github.com/orion-agents/orion-code/releases/tag/v0.3.42。

## 明确 `not_run`（如实记录，不伪造）

- 人工标注付费质量评测（12 缺陷 + 8 干净样本、3 轮运行）：本自动化环境无模型凭据，
  不在本版执行，记为 `not_run`。
- 真实 Host + Chrome 全链路审查 E2E：同上，无模型凭据，记为 `not_run`。

## 历史 GitHub Release 欠账说明

v0.3.28–v0.3.35 的 GitHub Release 是否逐版补发由维护者决策，不在本版范围内处理；
v0.3.36 起每轮均已在本轮发布链路中创建 `--latest` Release，链条完整。
