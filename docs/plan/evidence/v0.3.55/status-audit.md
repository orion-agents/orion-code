# v0.3.55 交付状态审计 — 三版滚动窗口（0.3.52–0.3.54）

> 审计日期：2026-11-08。
> 数据源：git tag（本地 `git rev-parse <tag>{}` + `git ls-remote` 远端交叉核对）、
> npm registry 直连（`curl --noproxy '*' -H 'Cache-Control: no-cache'`，防缓存
> 时间戳参数）、GitHub PR / Release / CI。
> 方法：每版核对 ① git tag 存在且注释 tag 解引用（`^{}`）指向 main 合并提交；
> ② npm registry 同版本存在（`versions[ver]`）；③ `dist-tags.latest` 指向最新
> 已发布版本且连续推进无回退。
> 本轮开版欠账清偿依据：main 上 CHANGELOG 的 0.3.54 条目由 `candidate` 翻为
> `published`，回填真实 npm 发布时间戳 `2026-11-08T07:39:20.165Z` 与 GitHub
> Release v0.3.54 链接；README / README.zh-CN 首部摘要同步改写为
> 「0.3.54 已发布、0.3.55 candidate」。

## 审计结论表

| 版本   | git tag（注释 tag 解引用）    | tag 指向 main 合并提交 | npm 版本存在 | registry 入库时间        | registry shasum（sha1）                    | dist-tag latest   | 结论      |
| ------ | ----------------------------- | ---------------------- | ------------ | ------------------------ | ------------------------------------------ | ----------------- | --------- |
| 0.3.52 | `v0.3.52` → `a054c44…8821ce`  | 是（merge `a054c44`）  | 是           | 2026-11-04T23:09:25.161Z | `507ba5b79fc1fdf2d575c0b2a1b1a16efbebdd68` | 否（已被覆盖）    | published |
| 0.3.53 | `v0.3.53` → `3d7c581…0118a`   | 是（merge `3d7c581`）  | 是           | 2026-11-08T02:39:25.949Z | `d98b82d6c673541b277305363832a4df4a0d8cf1` | 否（已被覆盖）    | published |
| 0.3.54 | `v0.3.54` → `f55ddc7…b46469`  | 是（merge `f55ddc7`）  | 是           | 2026-11-08T07:39:20.165Z | `58fb5fca4d6c92254d54dd561754bae39a9a0b56` | **是（=0.3.54）** | published |

- 三版 `dist-tags.latest` 序列：0.3.52 → 0.3.53 → 0.3.54，连续推进无回退；
  本轮防缓存直连复核 `latest=0.3.54`（`dist-tags.next` 仍停在 `0.3.19`，
  为历史遗留 dist-tag，与 latest 判定无关）。
- 本地 `git rev-parse v0.3.X^{}` 与远端 `refs/tags/v0.3.X^{}` 一致
  （a054c44 / 3d7c581 / f55ddc7），三版 tag 均位于 `origin/main` 历史上。
- 三版 registry shasum 与历轮发布记录一致，并以本轮直连复核确认，无篡改迹象。

## 0.3.54 发布事实回填（Step 0 开版欠账清偿依据）

- PR：#314（`docs: v0.3.54 - v0.3.53 release-completion bookkeeping`）
- squash 合并提交：`f55ddc7ecd1f16d8ba2b147c158d9a22f9b74669`（main）
- git tag：`v0.3.54`（注释 tag，peel → `f55ddc7…b46469`，已推送，
  `git ls-remote origin refs/tags/v0.3.54^{}` 远端一致）
- npm registry：`@orion-agents/orion-code@0.3.54`，`dist-tags.latest=0.3.54`
- registry shasum：`58fb5fca4d6c92254d54dd561754bae39a9a0b56`
- tarball 入库时间：`2026-11-08T07:39:20.165Z`（registry `time` 字段；publish
  成功输出早于入库约 3 分钟，属既有 CDN 传播延迟，重发取得权威信号
  `E409 previously staged 0.3.54`）
- tarball sha256：`2d063ca06b1a269f26ae8fedf013393f23429905dd9e0351f3c975d546d2f85d`
  （与 CI run `42456978544` 的 `release-package` artifact 及
  `web-e2e-receipt.tarballSha256` 逐字节一致，`web-e2e-receipt.json` 的
  `decision=GO`；本轮从该 artifact 直取复核）
- GitHub Release：https://github.com/orion-agents/orion-code/releases/tag/v0.3.54
  （已建，`--latest`，2026-11-08T07:40:38Z）
- CI 门禁：
  - PR run `42456978544`（HEAD `4bcda3b`，分支 `codex/v0.3.54`）：
    **18/18 首跑全绿，零复跑**（含 audit 0 vulnerabilities、type-check、
    Node 22/24/26、critical journey ×3、Web E2E full suite 三连跑、release
    gate、双 Aggregate receipt 均 success）。
  - 合并后 push CI run `42459319685`（HEAD `f55ddc7`）：**18/18 全绿，
    零复跑**，main 完全干净。
  - 本地构建：干净 worktree detach 到 `f55ddc7` 后 `npm run build` +
    `npm pack --ignore-scripts`（791 files），sha 核验三向一致（本地 tgz ==
    CI web-e2e-receipt == 本地 release:check 工件）。
- CHANGELOG 0.3.54 条目：本轮（v0.3.55 开版提交）由 `Status: candidate` 翻转为
  `Status: published`，section 日期 `2026-11-08` 与真实发布日一致（无需改动），
  并回填上述真实发布时间戳与 Release 链接。

## 开放事项（如实记录，不视为已解决）

- `WEB32-P0-08` 根因**仍未确定**：v0.3.53 的调查
  （`docs/plan/evidence/v0.3.53/investigation-and-audit.md`）记录了运行时事实、
  四个静态假设与其中两个被代码证据证伪的判据；v0.3.54 周期 CI 全绿未复现
  该 flake，不构成修复。后续轮次若复现，仍按「单次复跑定性 → 仍红即停止」
  处置，并在证据充足时才修改 `src/` 并发代码。

## 明确 not_run（沿用历轮口径）

- 人工标注付费质量评测（12 缺陷 + 8 干净样本、3 轮运行）：本环境无模型凭据，未运行。
- 真实 Host + Chrome 全链路审查 E2E（付费评测通道）：本环境无凭据，未运行。

以上为诚实的 `not_run`（blocked by environment），不视为通过。
