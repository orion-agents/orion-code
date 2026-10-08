# v0.3.20 release receipt（发布事实收据）

- 采集时间：2026-10-08（本文件只陈述已被读取的事实，不补造任何未读取的收据）。
- 作用：为 `docs/plan/v0.3.21-plan.md` S0 提供可读的 v0.3.20 发布事实，并作为 README /
  `README.zh-CN.md` / CHANGELOG 状态校正的依据。

## 已读取的发布事实

| 事实 | 值 | 读取方式与时间 |
| --- | --- | --- |
| 合并 | PR #261 squash 合并至 `main`，merge commit `e658932634426bfd21ba397bc4248c4cbfebbdb2` | `gh pr view 261 --json state,mergedAt,mergeCommit`，2026-10-07 13:00:01Z（mergedAt） |
| Tag | annotated tag `v0.3.20` → `e658932`，已推送至 `origin` | `git push origin v0.3.20`（2026-10-07），`git tag -l` |
| npm 版本 | `@orion-agents/orion-code@0.3.20` | `npm publish` 输出 `+ @orion-agents/orion-code@0.3.20` |
| npm publishedAt | `2026-10-07T13:07:46.643Z` | registry metadata `time["0.3.20"]`，带 `Cache-Control: no-cache` 的直连读取 |
| npm tarball | `https://registry.npmjs.org/@orion-agents/orion-code/-/orion-code-0.3.20.tgz` | registry metadata `versions["0.3.20"].dist.tarball` |
| npm shasum | `1b47c51bb107026056c94aa45ac245281312e941` | registry metadata `versions["0.3.20"].dist.shasum` |
| registry `latest` | `0.3.20` | registry metadata `dist-tags.latest`，发布约 4 分钟传播后读取（与 v0.3.19 的传播延迟经验一致） |

## 读取命令

```bash
curl -s -H 'Cache-Control: no-cache' \
  "https://registry.npmjs.org/@orion-agents/orion-code?t=$(date +%s)"
# dist-tags.latest = 0.3.20
# versions["0.3.20"].time / dist.tarball / dist.shasum 如上

git tag -l v0.3.20          # v0.3.20（annotated → e658932）
gh pr view 261 --json state,mergedAt,mergeCommit
```

## 与历史文档的冲突校正

本收据写入时，README / `README.zh-CN.md` / CHANGELOG 仍描述 0.3.20 为
candidate / 未发布（例如 README.md「0.3.19 is published to npm and tagged `v0.3.19`;
0.3.20 is not.」）。同一次提交将三处状态改为与上表一致的 Published 事实描述。
`release:check` 的既有 CHANGELOG 门禁（tag 存在时不得写 unreleased/candidate）继续生效，
本版同时为 README 增加同型漂移检查（tag 存在时 README 不得把当前版本描述为未发布）。
