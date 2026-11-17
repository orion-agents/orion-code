# v0.3.65 交付状态审计（滚动窗口 0.3.62–0.3.64）

> 制定日期：2026-11-18。
> 审计方法：每版核对 ① git tag 存在且 `^{}` 解引用指向 main 合并提交（本地
> `git rev-parse` + `git ls-remote` 远端交叉核对）；② npm registry 同版本
> 存在（防缓存直连 curl）；③ `dist-tags.latest` 连续推进无回退。
> 审计时点基线：`main@e707312`、package `0.3.64`、npm `latest=0.3.64`。

## 1. 三版「tag + registry + latest」审计结果

| 版本   | tag 存在 | tag 对象（peel 前缀） | `^{}` 解引用 → main 合并提交    | npm registry 存在 | registry shasum（SHA-1）                   | 入库时间（UTC）           |
| ------ | -------- | --------------------- | ------------------------------- | ----------------- | ------------------------------------------ | ------------------------- |
| 0.3.62 | ✅       | `5d73db6d`            | `39282eff` = merge `39282ef` ✅ | ✅                | `0ead49878f21b0678e380926fd4dc0fa686ca7b4` | 2026-11-11T01:36:46.634Z  |
| 0.3.63 | ✅       | `63279c4c`            | `23626e6b` = merge `23626e6` ✅ | ✅                | `c39ce378d75899eefd19542eb2d5fe0567131569` | 2026-11-11T13:30:08.807Z  |
| 0.3.64 | ✅       | `98876e8c`            | `e707312f` = merge `e707312` ✅ | ✅                | `cb61dc613f34f18e8fd130e12aad3d649d30379a` | 2026-11-11T19:23:45.375Z  |

`dist-tags.latest` 序列：`0.3.62 → 0.3.63 → 0.3.64`，连续推进无回退
（防缓存直连 curl 复核 `dist-tags = { next: 0.3.19, latest: 0.3.64 }`，
0.3.65 尚不存在于 registry）。
远端 tag 双核验：`git ls-remote origin` 返回的三个 `^{}` peel 值与本地
`git rev-parse <tag>^{}` 逐字节一致（本地对象 `5d73db6d` / `63279c4c` /
`98876e8c` 与远端 tag 对象亦一致；本次审计在 v0.3.65 开版前实测）。

**结论：三版全部满足「tag + registry + latest」三条件，无欠账。**

## 2. v0.3.64 发布事实回填（上轮 v0.3.65 前完成）

- PR：https://github.com/orion-agents/orion-code/pull/324（squash 合并）。
- merge：`e707312`（`e707312f9f35b6d6dee5c216bb3f542173e6aa2e`，合并树
  `f645e87c` 与 PR head 树逐字节一致，8 文件全簿记类）。
- tag：annotated `v0.3.64`，tag 对象 `98876e8c`，peel → `e707312`。
- npm：`latest=0.3.64`，入库 `2026-11-11T19:23:45.375Z`，registry shasum
  `cb61dc613f34f18e8fd130e12aad3d649d30379a`。
- tarball：本地 sha256
  `7b24421551d24b219e62cdbf8c0d94a5d3d2ea6b3a5f4eea07234e7553738e45`
  （791 files / 1.80 MB packed），与 web-e2e-receipt 顶层 `tarballSha256`
  （decision GO）、release-receipt 全部 11 处 `tarballSha256`/`sha256`
  字段（`/artifact/tarball/sha256`、`runtimeMatrix[0..2]`、`/webE2E`、
  `primaryRuns[0..2]`、`runtimeRuns[0..2]`；顶层 decision GO）、本地
  release:check 工件多向逐字节一致；SHA-1 与 registry shasum 一致。
- CI：PR run `43080858526` **attempt 1 首跑 18/18 全部 success，零红零
  skipped，无 flake 重跑**（v0.3.29 以来最佳形态；`WEB32-P0-08` 与
  `terminal_journey` PTY 探针家族均未复现）。critical journey ×3、Node
  矩阵 ×3、Exact tgz ×3、audit（0 vulnerabilities）、release:check 全绿。
- GitHub Release：https://github.com/orion-agents/orion-code/releases/tag/v0.3.64
  （--latest，`/releases/latest` API 复核指向 v0.3.64；含 18 作业逐项
  门禁表 + 多向 sha + 安装命令 + docs-only 张力标注）。

## 3. 开放项（延续记录）

- `WEB32-P0-08` OpenAI fixture 45s 超时 flake 家族根因未定（见
  `docs/plan/evidence/v0.3.53/investigation-and-audit.md`）；v0.3.64 周期
  CI 全程未复现，维持瞬时 flake 家族观察。
- `terminal_journey` PTY 屏幕内容探针 flake 家族（Node 22/24/26 floor 均有
  出现记录）根因未定；v0.3.64 周期未复现，与本轮 docs-only 改动无因果
  （零产品代码）。
- v0.3.58 周期 attempt 1 首见 flake 家族「web-e2e-runtime 矩阵腿从未实例化
  → run conclusion=failure 但无失败作业记录」，v0.3.59–v0.3.64 未复现，
  清单保留观察。
- 主指令 docs-only 周期与质量条款 C（不占版本号）的张力持续存在；当前沿
  v0.3.38–v0.3.64 先例以用户显式「每轮推进一个版本号」要求优先，Release
  notes 均已如实标注。上一版 candidate 段由下一轮开版提交翻转的欠账节奏
  亦沿此先例（本轮即清偿 0.3.64 的欠账）。
