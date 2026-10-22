# v0.3.31 交付状态审计（0.3.28–0.3.30）

> 审计日期：2026-10-23。审计人：自动化轮（v0.3.31）。
>
> 口径：每版核对三项 —— ① git tag 存在且指向 main 合并提交；② npm registry
> 存在同版本（直连 curl，`Cache-Control: no-cache`，不依赖本地 npm 缓存）；
> ③ `dist-tags.latest` 指向最新已发布版本。
>
> 依据：项目级目标 §11.2「分别记录：实现候选、默认分支合并、tag、npm 版本」
> 与 G1「每项完成结论绑定当前代码或外部资源的证据」。

## 审计结果

| 版本   | tag（→ main 合并提交）        | registry shasum（npm SHA-1 口径）          | latest 指向     | 结论 |
| ------ | ----------------------------- | ------------------------------------------ | --------------- | ---- |
| 0.3.28 | `v0.3.28` → `8a4722b`（#284） | `fd7b1093b17b58ddbe12af98336c09199af13b43` | —               | 满足 |
| 0.3.29 | `v0.3.29` → `86c20aa`（#285） | `7cb7ac475da092ee9290c3e70c4848886ce7410e` | —               | 满足 |
| 0.3.30 | `v0.3.30` → `15887f5`（#286） | `46af3dc53962fb06da15199a10abe7e77a2a2fa8` | `latest=0.3.30` | 满足 |

- 采集方式：`git tag --list 'v0.3.*'`（本地，与 origin 同步）+ 直连
  `curl -s -H 'Cache-Control: no-cache' "https://registry.npmjs.org/@orion-agents%2Forion-code?t=<ts>"`
  解析 `versions` 与 `dist-tags`（2026-10-23 快照）。
- 口径说明：npm registry 的 `dist.shasum` 是 tarball 的 SHA-1（npm 口径），
  与本地 `npm pack` 产物文件 SHA-256（如 v0.3.30 证据中的 `7562962f…5b56`）
  为不同口径，两者均有效，不构成冲突。

## 结论

0.3.28 / 0.3.29 / 0.3.30 三版均满足「tag + registry + latest」三项核对，
无交付状态漂移残留。唯一被本版（v0.3.31）修正的漂移是文档侧：
v0.3.30 证据发布链路占位未回填、CHANGELOG 0.3.30 条目停留在 `candidate`。

## 明确 not_run

- 人工标注付费质量评测（12 缺陷 + 8 干净样本 × 3 轮）：自动化环境无模型凭据，
  门槛见 `docs/plan/v0.3.27-plan.md` §9.3。
- 真实 Host + Chrome 全链路审查 E2E：同上；CI 承载 exact tgz ×3 平台与
  Web E2E full suite 三连绿 gate。
