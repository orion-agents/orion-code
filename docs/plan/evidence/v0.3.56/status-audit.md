# v0.3.56 交付状态审计 — 三版滚动窗口（0.3.53–0.3.55）

> 审计日期：2026-11-09。
> 数据源：git tag（本地 `git rev-parse <tag>{}` + `git ls-remote` 远端交叉核对）、
> npm registry 直连（`curl --noproxy '*' -H 'Cache-Control: no-cache'`，防缓存
> 时间戳参数）、GitHub PR / Release / CI。
> 方法：每版核对 ① git tag 存在且注释 tag 解引用（`^{}`）指向 main 合并提交；
> ② npm registry 同版本存在（`versions[ver]`）；③ `dist-tags.latest` 指向最新
> 已发布版本且连续推进无回退。
> 本轮开版欠账清偿依据：main 上 CHANGELOG 的 0.3.55 条目由 `candidate` 翻为
> `published`，回填真实 npm 发布时间戳 `2026-11-08T19:05:26.012Z` 与 GitHub
> Release v0.3.55 链接；README / README.zh-CN 首部摘要同步改写为
> 「0.3.55 已发布、0.3.56 candidate」。

## 审计结论表

| 版本   | git tag（注释 tag 解引用）    | tag 指向 main 合并提交 | npm 版本存在 | registry 入库时间        | registry shasum（sha1）                    | dist-tag latest   | 结论      |
| ------ | ----------------------------- | ---------------------- | ------------ | ------------------------ | ------------------------------------------ | ----------------- | --------- |
| 0.3.53 | `v0.3.53` → `3d7c581…0118a`   | 是（merge `3d7c581`）  | 是           | 2026-11-08T02:39:25.949Z | `d98b82d6c673541b277305363832a4df4a0d8cf1` | 否（已被覆盖）    | published |
| 0.3.54 | `v0.3.54` → `f55ddc7…b46469`  | 是（merge `f55ddc7`）  | 是           | 2026-11-08T07:39:20.165Z | `58fb5fca4d6c92254d54dd561754bae39a9a0b56` | 否（已被覆盖）    | published |
| 0.3.55 | `v0.3.55` → `213676c…dc377`   | 是（merge `213676c`）  | 是           | 2026-11-08T19:05:26.012Z | `bc65972dc439fb880253b6d4f71c776f96c2ec41` | **是（=0.3.55）** | published |

- 三版 `dist-tags.latest` 序列：0.3.53 → 0.3.54 → 0.3.55，连续推进无回退；
  本轮防缓存直连复核 `latest=0.3.55`（`dist-tags.next` 仍停在 `0.3.19`，
  为历史遗留 dist-tag，与 latest 判定无关）。
- 本地 `git rev-parse v0.3.X^{}` 与远端 `refs/tags/v0.3.X^{}` 一致
  （3d7c581 / f55ddc7 / 213676c），三版 tag 均位于 `origin/main` 历史上。
- 注释 tag 对象亦双端一致：`4af80f8e`（0.3.53）/ `027f6a90`（0.3.54）/
  `6d3e3ff3`（0.3.55）。
- 三版 registry shasum 与历轮发布记录一致，并以本轮直连复核确认，无篡改迹象。

## 0.3.55 发布事实回填（Step 0 开版欠账清偿依据）

- PR：#315（`docs: v0.3.55 candidate - v0.3.54 release-completion bookkeeping`）
- squash 合并提交：`213676c05b09a6e0f9cb33e3c31a47f05f6dc377`（main，树
  bc126932 与 PR head `7a9348f` 树逐字节一致）
- git tag：`v0.3.55`（注释 tag，tag 对象 `6d3e3ff3…941a75e`，peel →
  `213676c…dc377`，已推送，`git ls-remote origin refs/tags/v0.3.55^{}` 远端一致）
- npm registry：`@orion-agents/orion-code@0.3.55`，`dist-tags.latest=0.3.55`
- registry shasum：`bc65972dc439fb880253b6d4f71c776f96c2ec41`
- tarball 入库时间：`2026-11-08T19:05:26.012Z`（registry `time` 字段；publish
  成功输出早于入库约 5.5 分钟，属既有 CDN 传播延迟）
- tarball sha256：`2d03ee85a96848335ca0aeb5c1844eb7975a6b58b62c29812385c53a008b055e`
  （与 CI run `42484313194` attempt 3 的 `release-receipt.tarball.sha256` 及
  `web-e2e-receipt.tarballSha256` 三向逐字节一致，decision GO；791 files /
  1,883,340 B，本地 SHA-1 `bc65972d…2ec41` 与 registry shasum 一致）
- GitHub Release：https://github.com/orion-agents/orion-code/releases/tag/v0.3.55
  （已建，`--latest`，notes 含 18 作业逐项门禁表 + flake note + 三向 sha +
  安装命令）
- CI 门禁：
  - PR run `42484313194`（HEAD `7a9348f`，分支 `codex/v0.3.55`）：
    attempt 1/2 因 Node 26 floor `terminal_journey` PTY 探针连红（历史 flake
    家族，同 tarball 在 Node 22/24 floor 探针绿、Node 26 完整验证绿），
    **attempt 3 经单次 `gh run rerun --failed` 后 18/18 全部 success，零红零
    skipped**（含长期基线 skipped 的 Aggregate fail-closed receipt 也转
    success）；逐作业核对用 curl + `/attempts/3/jobs` API。
  - audit 0 vulnerabilities、type-check、Node 22/24/26、critical journey ×3、
    Web E2E full suite 三连跑、release gate 全绿。
  - 本地构建：干净 worktree detach 到 `213676c` 后 `npm run build` +
    `npm pack --ignore-scripts`（791 files / 1,883,340 B），sha 核验三向一致。
- CHANGELOG 0.3.55 条目：本轮（v0.3.56 开版提交）由 `Status: candidate` 翻转为
  `Status: published`，section 日期 `2026-11-08` 与真实发布日一致（无需改动），
  并回填上述真实发布时间戳与 Release 链接。

## 开放事项（如实记录，不视为已解决）

- `WEB32-P0-08` 根因**仍未确定**：v0.3.53 的调查
  （`docs/plan/evidence/v0.3.53/investigation-and-audit.md`）记录了运行时事实、
  四个静态假设与其中两个被代码证据证伪的判据；v0.3.55 周期 CI attempt 3
  三连跑全绿未复现该 flake，不构成修复。后续轮次若复现，仍按「单次复跑定性 →
  仍红即停止」处置，并在证据充足时才修改 `src/` 并发代码。
- Node 26 floor `terminal_journey` PTY 探针 flake 家族（v0.3.55 attempt 1/2
  连红、attempt 3 绿）：根因未定，历轮按「单次复跑 → 绿=瞬时 flake」处置。

## 明确 not_run（沿用历轮口径）

- 人工标注付费质量评测（12 缺陷 + 8 干净样本、3 轮运行）：本环境无模型凭据，未运行。
- 真实 Host + Chrome 全链路审查 E2E（付费评测通道）：本环境无凭据，未运行。

以上为诚实的 `not_run`（blocked by environment），不视为通过。
