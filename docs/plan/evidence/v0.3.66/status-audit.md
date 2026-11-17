# v0.3.66 交付状态审计（滚动窗口 0.3.63–0.3.65）

> 制定日期：2026-11-18。
> 审计方法：每版核对 ① git tag 存在且 `^{}` 解引用指向 main 合并提交（本地
> `git rev-parse` + `git ls-remote` 远端交叉核对）；② npm registry 同版本
> 存在（防缓存直连 curl）；③ `dist-tags.latest` 连续推进无回退。
> 审计时点基线：`main@00c735d`、package `0.3.65`、npm `latest=0.3.65`。

## 1. 三版「tag + registry + latest」审计结果

| 版本   | tag 存在 | tag 对象（peel 前缀） | `^{}` 解引用 → main 合并提交    | npm registry 存在 | registry shasum（SHA-1）                   | 入库时间（UTC）           |
| ------ | -------- | --------------------- | ------------------------------- | ----------------- | ------------------------------------------ | ------------------------- |
| 0.3.63 | ✅       | `63279c4c`            | `23626e6b` = merge `23626e6` ✅ | ✅                | `c39ce378d75899eefd19542eb2d5fe0567131569` | 2026-11-11T13:30:08.807Z  |
| 0.3.64 | ✅       | `98876e8c`            | `e707312f` = merge `e707312` ✅ | ✅                | `cb61dc613f34f18e8fd130e12aad3d649d30379a` | 2026-11-11T19:23:45.375Z  |
| 0.3.65 | ✅       | `e922f010`            | `00c735d4` = merge `00c735d` ✅ | ✅                | `eb5f7f767aacefd446caba5d9050a9ba2c4793a3` | 2026-11-17T22:23:35.074Z  |

`dist-tags.latest` 序列：`0.3.63 → 0.3.64 → 0.3.65`，连续推进无回退
（防缓存直连 curl 复核 `dist-tags = { next: 0.3.19, latest: 0.3.65 }`，
0.3.66 尚不存在于 registry）。
远端 tag 双核验：`git ls-remote origin` 返回的三个 `^{}` peel 值与本地
`git rev-parse <tag>^{}` 逐字节一致（本地对象 `63279c4c` / `98876e8c` /
`e922f010` 与远端 tag 对象亦一致；本次审计在 v0.3.66 开版前实测）。

**结论：三版全部满足「tag + registry + latest」三条件，无欠账。**

## 2. v0.3.65 发布事实回填（上轮 v0.3.66 前完成）

- PR：https://github.com/orion-agents/orion-code/pull/325（squash 合并）。
- merge：`00c735d`（`00c735d40aaaef674078b4324af33e96cdf689d2`，合并树
  `efd4e63a` 与 PR head 树逐字节一致，8 文件全簿记类）。
- tag：annotated `v0.3.65`，tag 对象 `e922f010`，peel → `00c735d`。
- npm：`latest=0.3.65`，入库 `2026-11-17T22:23:35.074Z`，registry shasum
  `eb5f7f767aacefd446caba5d9050a9ba2c4793a3`。
- tarball：本地 sha256
  `2db0ba1849af9573badb1707e0300f3ffc55ade9fcc864bf302f9877a27e5582`
  （791 files / 1.80 MB packed），与 web-e2e-receipt 顶层 `tarballSha256`
  （decision GO）、release-receipt 全部 11 处 `tarballSha256`/`sha256`
  字段（顶层 decision GO）、本地 release:check 工件多向逐字节一致；
  SHA-1 与 registry shasum 一致。
- CI：PR run `44184194490` **attempt 1 首跑 18/18 全部 success，零红零
  skipped，无 flake 重跑**（连续第二轮；v0.3.64 轮亦然）。critical
  journey ×3、Node 矩阵 ×3、Exact tgz ×3、audit（0 vulnerabilities）、
  release:check 全绿。
- GitHub Release：https://github.com/orion-agents/orion-code/releases/tag/v0.3.65
  （--latest，`/releases/latest` API 复核指向 v0.3.65；含 18 作业逐项
  门禁表 + 多向 sha + 安装命令 + docs-only 张力标注）。

## 3. 开放项（延续记录）

- `WEB32-P0-08` OpenAI fixture 45s 超时 flake 家族根因未定（见
  `docs/plan/evidence/v0.3.53/investigation-and-audit.md`）；v0.3.64 与
  v0.3.65 两个周期 CI 全程未复现，维持瞬时 flake 家族观察。
- `terminal_journey` PTY 屏幕内容探针 flake 家族（Node 22/24/26 floor 均有
  出现记录）根因未定；连续两个周期未复现。
- v0.3.58 周期 attempt 1 首见 flake 家族「web-e2e-runtime 矩阵腿从未实例化
  → run conclusion=failure 但无失败作业记录」，v0.3.59–v0.3.65 未复现，
  清单保留观察。
- 历轮 docs-only 周期与质量条款 C（不占版本号）的张力沿 v0.3.38–v0.3.65
  先例处理；**本轮（v0.3.66）为产品修复轮（含 `web/`、`tests/` 产品代码
  delta），版本推进与质量条款 C 无张力**。
- 本轮新增开放项：浏览器 journey `WEB39-P0-06` 首跑结果待 CI 观察；若红且
  非 flake 签名，按 plan §5 处置（修真实回归后重走 CI）。
