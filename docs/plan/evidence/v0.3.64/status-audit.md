# v0.3.64 交付状态审计（滚动窗口 0.3.61–0.3.63）

> 制定日期：2026-11-12。
> 审计方法：每版核对 ① git tag 存在且 `^{}` 解引用指向 main 合并提交（本地
> `git rev-parse` + `git ls-remote` 远端交叉核对）；② npm registry 同版本
> 存在（防缓存直连 curl）；③ `dist-tags.latest` 连续推进无回退。
> 审计时点基线：`main@23626e6`、package `0.3.63`、npm `latest=0.3.63`。

## 1. 三版「tag + registry + latest」审计结果

| 版本   | tag 存在 | tag 对象（peel 前缀） | `^{}` 解引用 → main 合并提交    | npm registry 存在 | registry shasum（SHA-1）                   | 入库时间（UTC）           |
| ------ | -------- | --------------------- | ------------------------------- | ----------------- | ------------------------------------------ | ------------------------- |
| 0.3.61 | ✅       | `6113a224`            | `fb51d0e5` = merge `fb51d0e` ✅ | ✅                | `a13deed66fe0fa62677ce97ee322026aa2f54852` | 2026-11-10T14:32:12.700Z  |
| 0.3.62 | ✅       | `5d73db6d`            | `39282eff` = merge `39282ef` ✅ | ✅                | `0ead49878f21b0678e380926fd4dc0fa686ca7b4` | 2026-11-11T01:36:46.634Z  |
| 0.3.63 | ✅       | `63279c4c`            | `23626e6b` = merge `23626e6` ✅ | ✅                | `c39ce378d75899eefd19542eb2d5fe0567131569` | 2026-11-11T13:30:08.807Z  |

`dist-tags.latest` 序列：`0.3.61 → 0.3.62 → 0.3.63`，连续推进无回退
（防缓存直连 curl 复核 `dist-tags = { next: 0.3.19, latest: 0.3.63 }`，
0.3.64 尚不存在于 registry）。
远端 tag 双核验：`git ls-remote origin` 返回的三个 `^{}` peel 值与本地
`git rev-parse <tag>^{}` 逐字节一致（本地对象 `6113a224` / `5d73db6d` /
`63279c4c` 与远端 tag 对象亦一致；本次审计在 v0.3.64 开版前实测）。

**结论：三版全部满足「tag + registry + latest」三条件，无欠账。**

## 2. v0.3.63 发布事实回填（上轮 v0.3.64 前完成）

- PR：https://github.com/orion-agents/orion-code/pull/323（squash 合并）。
- merge：`23626e6`（`23626e6bf717e29a9ccb431fac854de290ad6f56`，合并树与
  PR head 树逐字节一致，8 文件全簿记类）。
- tag：annotated `v0.3.63`，tag 对象 `63279c4c`，peel → `23626e6`。
- npm：`latest=0.3.63`，入库 `2026-11-11T13:30:08.807Z`，registry shasum
  `c39ce378d75899eefd19542eb2d5fe0567131569`。
- tarball：本地 sha256
  `ba59b1c10f231e4d9ad69090a6e3e7bc008e4eb6e43870d30924c31aa38e49e2`
  （791 files / 1,884,295 B），与 web-e2e-receipt 顶层 + 全部 3 个 primary
  + 3 个 runtime runs 的 `tarballSha256`（decision 全 GO）、release-receipt
  两字段（`/artifact/tarball/sha256` + `/webE2E/tarballSha256`，GO）、上轮
  本地 release:check 工件多向逐字节一致；SHA-1 与 registry shasum 一致。
- CI：PR run `42981042494`。attempt 1：15 success + 1 failure（**Web E2E
  full suite three consecutive runs**，run-1/run-2 各红 `WEB32-P0-08`
  OpenAI fixture 48.4s/48.5s 超时——历史家族签名，run-3 GO）+ 2 skipped
  （双 Aggregate receipt 依赖）→ `gh run rerun --failed` 单次复跑 →
  attempt 2 **18/18 全部 success，零红零 skipped**，瞬时 flake 收口。
- GitHub Release：https://github.com/orion-agents/orion-code/releases/tag/v0.3.63
  （--latest，`/releases/latest` API 复核指向 v0.3.63；含 attempt 1/2
  双列逐作业门禁表 + WEB32-P0-08 flake 轨迹 + 多向 sha + 安装命令 +
  docs-only 张力标注）。

## 3. 开放项（延续记录）

- `WEB32-P0-08` OpenAI fixture 45s 超时 flake 家族根因未定（见
  `docs/plan/evidence/v0.3.53/investigation-and-audit.md`）；v0.3.63 周期
  attempt 1 再次复现（48.4s/48.5s 超时签名同型），attempt 2 转绿，维持
  瞬时 flake 家族观察。
- `terminal_journey` PTY 屏幕内容探针 flake 家族（Node 22/24/26 floor 均有
  出现记录）根因未定；v0.3.63 周期未复现，与本轮 docs-only 改动无因果
  （零产品代码）。
- v0.3.58 周期 attempt 1 首见 flake 家族「web-e2e-runtime 矩阵腿从未实例化
  → run conclusion=failure 但无失败作业记录」，v0.3.59–v0.3.63 未复现，
  清单保留观察。
- 主指令 docs-only 周期与质量条款 C（不占版本号）的张力持续存在；当前沿
  v0.3.38–v0.3.63 先例以用户显式「每轮推进一个版本号」要求优先，Release
  notes 均已如实标注。上一版 candidate 段由下一轮开版提交翻转的欠账节奏
  亦沿此先例（本轮即清偿 0.3.63 的欠账）。
