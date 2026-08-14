# v0.1.3-2 完成度审计（tech-team `targets` 模式）

> 审计日期：2026-08-04
> 模式：tech-team `targets` — 对照 `docs/archive/releases/v0.1.x/targets-v0.1.3-v0.1.3-2.md` 验收矩阵，以实际证据判定，不采信文档自陈。
> 结论前置：**in-scope P0/P1 开发已完成且目标测试绿灯；但作为发布候选 = No-Go。**

---

## 一、总判定

| 维度 | 结论 |
| --- | --- |
| in-scope P0/P1 开发（源码 + 目标单测/集成） | ✅ **完成**，tsc 0 错、lint 0 错、聚焦套件 194/194 通过 |
| 真实 e2e 逻辑套件（goal/subagent/continuity） | ✅ **3/3 通过** |
| e2e PTY smoke 套件 | ❌ **2/2 RED**（环境 EACCES + 陈旧英文断言，非产品回归） |
| 全量测试套件健康度 | ⚠️ **≥4 项 RED**：2 单测 + 2 PTY（同根因） |
| 发布门 P2（CHANGELOG / release:check / 工作树冻结） | ❌ **未完成 = No-Go** |
| 真实 PTY / CI / tarball clean install | 🟡 `not_run`（环境限制，须显式标注） |

**Go/No-Go：开发完成 = Yes；发布候选 = No-Go（工作树未冻结 + 发布门 P2 缺失 + e2e smoke 红）。**

---

## 二、代码质量证据

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx tsc --noEmit` | ✅ 0 errors |
| 静态检查 | `npm run lint` | ✅ 0 errors / **137 warnings**（全部 `no-explicit-any`，历史风格项，非阻塞，符合 AGENTS.md） |
| 聚焦套件（v0.1.3-2 范围） | `jest --testPathPattern "(tool-scheduler|sandbox|tool-allowlist|web-ssrf-bypass|git-tools|tool-confirmation|incremental-input|goal-tools|config|permission-mode)"` | ✅ **12 suites / 194 tests passed** |
| 真实 e2e 逻辑 | `goal-lifecycle-pty` / `subagent-e2e` / `goal-continuity-e2e` | ✅ **3/3 passed** |
| e2e/PTY 全量 | `jest --testPathPattern "(e2e|pty)"` | ❌ **2 failed / 1 skipped / 3 passed** |

> 注：文档自陈 "173/173" 是聚焦子集；本次用相同选择器实测 194/194（含额外 grouped suite），全绿。但**该数字排除了宽泛单测中已腐烂的用例**（见第三节）。

---

## 三、测试腐烂（关键发现，影响"完成"判定）

v0.1.3 §8 G4 将状态文案默认值由英文改为中文：
- 源码（`src/runtime/agent-runtime-controller.ts:533`）：`'已接收补充，正在中断当前轮…'`
- 但下列测试/脚本仍断言**旧版英文串** `Revision received. Interrupting current response`（或其 `...` 变体）→ 超时/断言失败：

| 文件:行 | 类型 | 状态 |
| --- | --- | --- |
| `tests/agent-runtime-controller.test.ts:1967` | 单测 | ❌ 1 failed（102 其余 passed） |
| `tests/runtime-ui-parity.test.ts:252` | 单测 | ❌ 1 failed |
| `scripts/terminal-ui-pty-smoke.py:625` | e2e smoke | ❌ 超时（且进程因 sandbox EACCES safe-delete 退出 1） |
| `scripts/tui-ui-pty-smoke.py:718` | e2e smoke | ❌ 超时（功能实际跑通，见捕获 stdout） |

- `tests/ink-ui.test.ts:520` 以该串作输入测 helper，非断言真实输出，**不受影响**。
- **根因**：§8 改了用户可见文案但**未同步测试资产**。功能本身正确（PTY 捕获输出可见 `已接收补充，正在中断当前轮…` / `Interrupted.` / `Completed` / resume 恢复 60 条消息）。
- **影响**：若按全量 `npm test` 跑，至少有 4 项红；"173/173" 的绿灯靠 cherry-pick 隐藏了这 4 项。

---

## 四、发布门 P2 缺口（No-Go 主因）

| 项 | 现状 |
| --- | --- |
| CHANGELOG.md | ❌ 仓库无 `CHANGELOG` 文件 |
| `release:check` / `release:patch` 脚本 | ❌ `package.json` scripts 无对应项 |
| 版本身份一致性 | ✅ README 已写 v0.1.3（无 0.1.2 残留 No-Go）；dist 已含中文串，dist/src 在该点一致 |
| **工作树冻结 / 所有权边界** | ❌ **169 个 dirty tracked 文件，其中 123 个为无关 `docs/mvp/archive/*` 删除**；另有未跟踪调试文件 `probe_dbg.ts`、`sandbox_evidence.ts`、一批未命名 `docs/img` 图片、`.claude/`。计划明文：dirty-worktree 所有权未解决 = No-Go。 |
| 真实 PTY / CI / tarball clean install | 🟡 `not_run`（本沙箱限制，须显式标注，不得默认为 met） |

---

## 五、验收矩阵（逐条，per targets doc）

| 验收项 | 证据 | 判定 |
| --- | --- | --- |
| §1.1 plan mode 绕过修复 | tool-scheduler.test.ts 通过 | ✅ met |
| §1.2 沙箱接线 | sandbox.test.ts 30/30（含 docker OS 强执行） | ✅ met |
| §1.3 allowlist 引擎 | tool-allowlist.test.ts 38/38 | ✅ met |
| §1.5 SSRF/key | web-ssrf-bypass.test.ts 21/21 | ✅ met |
| §2 Git 工具 | git-tools.test.ts 7/7（真实仓库） | ✅ met |
| v0.1.3 §7 TUI 权限 | tool-confirmation/permission-mode 通过 | ✅ met |
| v0.1.3 §8 增量输入 | incremental-input.test.ts 通过 | ✅ met（但 §8 文案改动致别处单测腐烂，见三） |
| v0.1.3 fix A | goal-tools.test.ts 通过 | ✅ met |
| P1-E 配置迁移 | config/global-config.test.ts 通过 | ✅ met |
| §1.4 Hook 系统 | 计划已 OUT OF SCOPE | ⚪ out-of-scope |
| §3/§4/§5 子代理·MCP·上下文工程 | 计划已 OUT OF SCOPE | ⚪ out-of-scope |
| §7.3 Goal 覆盖（P0-C） | 目标文档列为 P0，但本轮未见于交付证据；建议补 `goal-storage` sidecar CAS 测试 | 🟡 partial/unverified |
| §7 CHANGELOG / release:check | 缺失 | ❌ unmet |
| 工作树冻结 | 169 dirty / 123 无关删除 | ❌ unmet (No-Go) |
| 真实 PTY/CI/clean-install | 环境限制 | 🟡 not_run |

---

## 六、建议行动（按优先级）

1. **冻结工作树边界（阻断项）**：仅收 v0.1.3-2 in-scope 文件进候选 commit；将 123 个 `docs/mvp/archive` 删除与 `probe_dbg.ts`/`sandbox_evidence.ts`/未命名图片/`.claude` 移出本轮（暂存或单独处理）。未经变更所有者授权不得整体提交。
2. **修复 §8 文案导致的测试腐烂（低成本、明确正确）**：将 `agent-runtime-controller.test.ts:1967`、`runtime-ui-parity.test.ts:252`、`scripts/*-pty-smoke.py:625/718` 的英文断言改为中文 `'已接收补充，正在中断当前轮…'`（保留计划 §8 G4 的中文用户文案）。
3. **补 P2 发布门**：新增 `CHANGELOG.md`（区分 candidate/merged/published）与 `npm run release:check`（version 一致性 + `git diff --check` + build/lint/test + `npm pack --dry-run` + dirty-worktree 检查）。
4. **真实 PTY/clean-install 证据**：在本机真实 Terminal 跑 `orion --version`/`--help` 与 tarball clean install，结果标 `met`/`not_run`，不得用本地 jest 绿灯替代。
5. **P0-C Goal sidecar 覆盖**：补充 `goal-storage` CAS/lock/quarantine 测试（当前证据缺失，目标文档列为 P0）。

---

## 七、一句话答复

> **v0.1.3-2 的 in-scope 安全/工具/交互开发已完成且单测绿灯，但版本尚未"做完"：工作树未冻结（大量无关删除）、缺 CHANGELOG/release 脚本、且 e2e smoke 因 §8 文案改动遗留的陈旧英文断言而红。按计划的 Go/No-Go，当前为 No-Go；修掉 4 处过时断言并冻结文件边界后即可进入发布门。**
