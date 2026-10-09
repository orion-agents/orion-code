# T22-03 发布验证矩阵与 E2E Gate — 2026-10-09

状态口径：**pass / fail / not_run / blocked**。`not_run` 指当前环境不具备执行条件且已注明
原因与替代证据通道；不得计为 pass。

## 当前 Gate 状态（采集自 2026-10-09，main `0d22c9a` + codex/v0.3.22）

| 层 | 内容 | 状态 | 证据通道 |
| --- | --- | --- | --- |
| Unit | Jest 定向套件（tool-gateway 12、durability-matrix 10、workspace/roots/discovery 系列 54） | **pass** | 本分支本地执行 |
| Runtime Integration | thread-event-store 17 + thread-runtime-v1 7 + durable-tool-receipt-reader 4（既有套件回归） | **pass** | 本分支本地执行（PR CI 复核） |
| CLI / TUI Smoke | 真实 CLI 启动与命令 | **not_run**（本环境未执行；由 `prepublishOnly` 与 Release CI 承担） | CI |
| Web Playwright E2E | critical journey ×3 + full suite 三轮连跑 | **pass**（v0.3.21 合并 run 37810271477：三轮 3×105 GO；critical 22/24 绿，26 首跑 SET-P0-13 flake 重跑绿） | GitHub Actions run 37810271477 |
| Node 22/24/26 verification（jest 矩阵） | 全量 Jest 矩阵 | **not_run**（本环境连续 6 次被外部取消，非超时非代码原因；替代证据 = CI 复核 + 定向本地套件） | CI（待一次完整 run） |
| Install | npm tarball 干净环境安装 + `orion --version` / `orion doctor` | **not_run**（发布时执行，见 release-receipt.md） | 发布流程 |
| Artifact | tarball SHA-256 对应核验 | **pass**（0.3.21：构建与 CI release-package 同源流水线） | release-receipt.md（发布后） |

## 阻断规则（本计划生效）

1. 任一适用 P0 E2E 无真实通过证据 → 阻断发布。
2. 重大失败或证据缺失 → 阻断发布。
3. E2E 因选择器失效而静默跳过 → 视为 fail（沿用 v0.3.20 的显式 skip + 登记流程）。
4. Source SHA、Test SHA、Artifact SHA 必须可对应核验（见 release-receipt.md）。

## 已知 flaky（修复跟踪）

- SET-P0-13 `selectSettingsSection('Advanced')` 偶发 click 120s 超时（run 37810271477 的
  Node 26 critical 首跑；重跑即绿）。根因方向：设置对话框导航可行动性。修复完成后本文件
  记录 pass 证据；在此之前它计入 known-flake，不视为产品缺陷阻断。

## prepublishOnly 缺口

`package.json` 的 `prepublishOnly` 不含 Playwright E2E（已核实）。处置：发布授权流程要求
发布前单独执行受影响 E2E 并把结果追加到本文件（或 release-receipt.md），而不是把 E2E 塞进
prepublishOnly 拖慢每次本地发布准备；CI 侧的 three-consecutive-runs 作业继续作为主 E2E 门禁。
