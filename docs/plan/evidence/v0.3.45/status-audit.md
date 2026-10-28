# v0.3.45 交付状态审计（0.3.42–0.3.44）

> 审计日期：2026-10-28（v0.3.45 开版轮）
> 审计对象：近三版 `0.3.42` / `0.3.43` / `0.3.44` 的「tag 存在 + npm 版本存在 +
> `dist-tags.latest` 指向」三项交付证据交叉核对。
> 数据来源：
> - `git ls-remote --tags origin 'refs/tags/v0.3.4[2-4]'` 远端 tag 对象 SHA。
> - registry 直连 curl（`--noproxy '*' -H 'Cache-Control: no-cache'`）
>   `https://registry.npmjs.org/@orion-agents/orion-code`，读取 `time` 与
>   `dist-tags.latest`。

## 结论

三版均满足交付三要素（tag 存在且 peel 指向 main 合并提交；npm registry 同版本存在；
`dist-tags.latest` 指向最新已发布版本）。无 `candidate`/`npm-published` 漂移残留。

| 版本   | git tag（注释 tag peel → main 合并提交）        | npm registry 版本 | 入库时间 (ISO-8601)        | dist-tags.latest | GitHub Release                                   | 判定   |
| ------ | ----------------------------------------------- | ----------------- | -------------------------- | ---------------- | ------------------------------------------------ | ------ |
| 0.3.42 | `v0.3.42` → `87317cc44ee9…7cf17a` (merge `50628a7`, PR #299) | `0.3.42` EXISTS   | `2026-10-27T06:27:35.184Z` | `0.3.44` (滚动)  | https://github.com/orion-agents/orion-code/releases/tag/v0.3.42 | met    |
| 0.3.43 | `v0.3.43` → `d3ef1535323…e42e` (merge `fa03965`, PR #300)     | `0.3.43` EXISTS   | `2026-10-27T19:02:04.278Z` | `0.3.44` (滚动)  | https://github.com/orion-agents/orion-code/releases/tag/v0.3.43 | met    |
| 0.3.44 | `v0.3.44` → `1530bf505e6…42e` (merge `95d5aa3`, PR #301)      | `0.3.44` EXISTS   | `2026-10-28T06:08:32.080Z` | `0.3.44`         | https://github.com/orion-agents/orion-code/releases/tag/v0.3.44 | met    |

## 校验明细

### 0.3.42（PR #299, merge `50628a7`）
- tag `v0.3.42`：`87317cc44ee9e8eae86012f7305d1fc45b7cf17a`（注释 tag，peel → `50628a7`）。
- npm：`0.3.42` EXISTS，`latest=0.3.44`（滚动覆盖），入库 `2026-10-27T06:27:35.184Z`。
- GitHub Release：https://github.com/orion-agents/orion-code/releases/tag/v0.3.42 已建。

### 0.3.43（PR #300, merge `fa03965`）
- tag `v0.3.43`：`d3ef15353233dcde58c16b30db3963e045aade2c`（注释 tag，peel → `fa03965`）。
- npm：`0.3.43` EXISTS，`latest=0.3.44`（滚动覆盖），入库 `2026-10-27T19:02:04.278Z`。
- GitHub Release：https://github.com/orion-agents/orion-code/releases/tag/v0.3.43 已建。

### 0.3.44（PR #301, merge `95d5aa3`）
- tag `v0.3.44`：`1530bf505e64993045226aeb53308f88c281e42e`（注释 tag，peel → `95d5aa3`）。
- npm：`0.3.44` EXISTS，`latest=0.3.44`，入库 `2026-10-28T06:08:32.080Z`。
- GitHub Release：https://github.com/orion-agents/orion-code/releases/tag/v0.3.44 已建。
- npm registry shasum（SHA-1）：`e9a334780e65ca0d8f62ddc22143ab94d2561f68`。

## v0.3.44 发布事实回填（本轮开版欠账清偿）

- PR：#301（https://github.com/orion-agents/orion-code/pull/301）
- 合并提交：`95d5aa3`（squash merge 至 `main`）
- tag：`v0.3.44`（注释 tag `1530bf5`，peel → `95d5aa3`）
- npm：`@orion-agents/orion-code@0.3.44`，`dist-tags.latest=0.3.44`，入库
  `2026-10-28T06:08:32.080Z`
- GitHub Release：https://github.com/orion-agents/orion-code/releases/tag/v0.3.44
- CHANGELOG：main 上 `[0.3.44] — UNRELEASED` / `Status: candidate`（开版时）→ 本轮
  翻转为 `## [0.3.44] — 2026-10-28` / `Status: published`（真实时间戳 + Release 链接）。

## 明确 not_run（不伪造完成）

- 人工标注付费质量评测（12 缺陷 + 8 干净样本、3 轮运行）：本自动化环境无模型凭据，
  继续 `not_run`，不在本版声明完成。
- 真实 Host + Chrome 全链路审查 E2E：同上为 `not_run`。
- TurnCommit 收据投影与跨重启恢复、`start_code_review` 协议命令化、finding Context
  结构化注入：仍属 PR4 剩余项，不在本版范围。

## 滚动窗口说明

相对 v0.3.44 轮（审计 0.3.41–0.3.43）前移一版至 0.3.42–0.3.44；三版均 `met`。
