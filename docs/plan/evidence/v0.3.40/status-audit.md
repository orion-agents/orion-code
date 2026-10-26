# v0.3.40 交付状态审计（滚动窗口：0.3.37–0.3.39）

> 采集时间：2026-10-26（v0.3.40 开版轮）。
>
> 方法：① `git tag --list 'v0.3.*'` + `git rev-parse <tag>{}`（本地与 origin 强制同步
> 后核对，`git ls-remote` 交叉验证）；② npm registry 直连 curl（`Cache-Control:
> no-cache`、`--noproxy '*'`）核对版本存在性、shasum 与入库时间；③ 同一响应的
> `dist-tags.latest` 核对最新已发布指向。

## 三版审计表

| 版本   | git tag 指向                                                        | registry shasum                            | 入库时间                 | dist-tag        | 结论 |
| ------ | ------------------------------------------------------------------- | ------------------------------------------ | ------------------------ | --------------- | ---- |
| 0.3.37 | `v0.3.37` → `8fb6ef0`（main squash 合并提交，#293）                  | `31754d58e735d6ff78ce76fc7bed183c6fcf8512` | 2026-10-25T15:03:25.053Z | —               | 满足 |
| 0.3.38 | `v0.3.38` → `4cb727e`（main squash 合并提交，#295）                  | `5c15a05421c53d66cc543c9d9ab4516e1e04d18f` | 2026-10-25T20:50:25.203Z | —               | 满足 |
| 0.3.39 | `v0.3.39` → `5a51932`（main squash 合并提交，#296；注释 tag object `f64523b`） | `00ed86afcab446a5ce9fbf8c80199af23d3688f8` | 2026-10-26T03:17:19.937Z | `latest=0.3.39` | 满足 |

三项核对口径：① tag 存在且可解析到 commit；② registry 同版本 tarball 存在且
shasum 与发布轮记录一致；③ `dist-tags.latest` 指向最新已发布版本（当前 0.3.39）。
0.3.37 / 0.3.38 的 dist-tag 列为「—」表示已被后续版本覆盖，属预期滚动。

## v0.3.39 发布事实回填

- PR：#296（`codex/v0.3.39`，docs-only 切片）。
- 合并：squash merge → `5a5193256a27fc437d9c915c8f2a1ff78655617e`。
- tag：`v0.3.39`（注释 tag object `f64523b`，peel → `5a51932`）。
- npm：`@orion-agents/orion-code@0.3.39`，registry `latest=0.3.39`，tarball 入库
  **2026-10-26T03:17:19.937Z**，registry shasum
  `00ed86afcab446a5ce9fbf8c80199af23d3688f8`。
- GitHub Release：https://github.com/orion-agents/orion-code/releases/tag/v0.3.39
  （非 draft，`--latest`）。
- 发布轮质量门禁：CI 18/18 全部 success（首轮 17/18，唯一失败为 Web E2E full
  suite 三连跑中 WEB32-P0-08 OpenAI fixture 45s 超时 flake，`gh run rerun
  --failed` 一次后转绿）；本地 tarball sha256 `a73c6ec3f862d304f5b2eec73fcab5f2f
  eaae29546a8b824b02641ea3f517d51` 与 CI web-e2e-receipt `tarballSha256` 逐字节
  一致。

## 结论

0.3.37 / 0.3.38 / 0.3.39 三版均满足「tag + registry + latest」三项核对，无交付
状态漂移残留。本轮（v0.3.40）修正的漂移为文档侧：main CHANGELOG 0.3.39 条目
停留在 `candidate`，本版翻转为 `published` 并回填真实时间戳与 Release 链接。

## 明确 not_run

- 人工标注付费质量评测（12 缺陷 + 8 干净样本、3 轮运行）：本自动化环境无模型
  凭据，未运行，如实记 `not_run`（非 pass）。
- 真实 Host + Chrome 全链路审查 E2E：同上，`not_run`。
- 自 v0.3.36 轮起新发布版本均即时创建 GitHub Release，历史欠账（v0.3.28–v0.3.35）
  不再扩大，是否逐版补发由维护者决策。
