# v0.3.20 S0 基线：29 个 CI 失败的分类证据

> 采集：2026-10-05。CI 基准 = `Web E2E full suite`（run 35415716476，`main@7c2dc64` + 版本 bump，2026-09-19）：
> **29 failed / 55 passed**，21 spec，`workers: 1`。
> 本地复现：`codex/v0.3.20@5b03acf`（+本表注明的诊断改动），单 spec 定向跑，14 个 CI 失败 spec 全部复现一致。
> 分类口径见 `docs/plan/v0.3.20-plan.md` §3 S0。判定依据逐条标注：`CI` = CI 日志错误体，`本地` = 本地复现，`源码` = 产品源码核对，`探针` = `zz-probe-resize.spec.ts`（含事件级 instrumentation）。

## 总览

| 分类 | 数量 | 含义 |
| --- | --- | --- |
| **产品缺陷** | **2** | 产品源码具体位置、行为不满足已声明契约 |
| **断言漂移** | **25** | 断言引用的标记/文案/交互已按新契约改名，新契约有意为之 |
| **待 S3 深判** | **1** | 需要长时运行复现才能归因（files-editor） |
| **环境限制（本地）** | 4 | 本地失败但 CI 通过的用例，判 CI 为准 |

## 产品缺陷（2 个，S1 修复）

### D1 `aria-orientation` 放在 `<nav>` 上 —— axe critical

- **位置**：`web/src/layout/WorkPanelDock.tsx:247`（`<nav class="work-panel-rail" aria-label="工作面板快捷入口" aria-orientation>`）。
- **证据**：CI `Node 22 verification` 失败于 `scripts/smoke/web-workbench-browser.ts:74`，期望 `[]` 实得 axe `aria-allowed-attr`（impact **critical**，tags `wcag2a/wcag412`）：`role=navigation` 不允许 `aria-orientation`。v0.3.11 rail 改版引入。
- **连坐**：E2E-P0-08（axe-clean 断言）、WEB32-P0-12、WEB36-P1-03、WEB31-P0-12（其 axe 段）。
- **反向约束**：`PanelResizeHandle.tsx:197` 的 `aria-orientation` 合法（`role=separator`），勿动。
- **连带面**：`web-rail-panel.spec.ts:24` 断言 `aria-orientation="vertical"`，修复后须改为**几何判定**（rail 高 > 宽、按钮纵向堆叠）。

### D2 归档会话加载风暴 —— 无主 loading 态引发请求风暴

- **位置**：`web/src/reducer.ts` `case 'archived_sessions_loading'`——`ownerWorkspaceId` 保留旧值不认领本工作区；配合 `web/src/App.tsx:336-348` 的 eager-load effect（guard：`ownerWorkspaceId === workspaceId && status !== 'idle'`），首个 load 期间 guard 永不成立 → 每次渲染重新发起请求，直到某个响应落地。
- **证据（本地诊断跑，`E2E_EVIDENCE_MAX_CAPTURE_BYTES` 放大后）**：WEB31-P0-01 单跑仍失败，`GET /workspaces/<id>/sessions/archived` 被请求 **2476 次**（~31 次/秒，80 秒内）；console error 构成：36× 409（风暴的 Context CAS 连带）、9× `net::ERR_INSUFFICIENT_RESOURCES`（Chrome 连接耗尽，风暴所致）、5× 404。
- **历史**：v0.3.15 已修过 failed 路径的风暴（`archived_sessions_failed` 认领 owner，注释明说防 refetch storm），loading 路径漏了同样的认领。
- **连坐**：WEB31-P0-01（CI 12 console errors / 本地 50）、SET-P0-03（409 放大）、WEB32-P0-08（本地 301 请求失败）。
- **修复方向**：loading case 认领 `ownerWorkspaceId: action.workspaceId`（items 跨工作区清空逻辑不变）。

## 断言漂移（25 个，S2 修复）

| # | 用例 | 原因 | 依据 |
| --- | --- | --- | --- |
| 1-2 | WEB33-P0-13/14 rail-panel | composer 自 v0.3.2（`e4c1979`）起要求「会话+配置」才启用（占位文案「选择会话并配置模型后开始」即契约）；断言在会话创建前 | CI+本地：`toBeEnabled` 63× disabled；源码 `ComposerControlCenter.tsx:59` |
| 3 | WEB33-P0-15 conversation | 同上——`createSession` 在断言之后才调用 | CI+本地 |
| 4 | WEB31-P0-04 foundation | `实时连接正常` 文案已改为 `本地 Web Host 连接正常`（`Inspector.tsx:878`） | CI+本地+源码 |
| 5 | WEB31-P0-11 foundation | 停靠栏 `role="tab"`（`Agent，`）→ rail 按钮（v0.3.11） | CI+本地 |
| 6 | WEB31-P0-12 foundation | `openInspector` fixture 点 `展开工作面板`——该按钮不存在；现为 rail 内 `打开工作面板`（`WorkPanelDock.tsx:339`） | CI+源码 |
| 7 | WEB33-P0-23 shell-regression | 同 6（同一 fixture helper） | CI+源码 |
| 8 | WEB31-P0-06 context-resources | `tabpanel`→`region 'Git 变更'` 是 v0.3.17 前的停靠栏结构；现为 `.git-views` tablist + `.git-panel` | CI+源码 |
| 9-10 | WEB33-P0-31/32 brand | v0.3.15 pixel brand 重构：`.brand-row` 已不存在；现为 `.project-rail-brand`/`OrionBrandMark` + `PixelWordmark` | CI+源码+git `-S brand-row` |
| 11 | WEB32-P0-01 layout | `折叠项目导航` 按钮已更名 `收起项目导航`（`ProjectNavigator.tsx:220`） | CI+源码 |
| 12 | WEB33-P0-24 shell-regression | 同 11 | CI+源码 |
| 13-14 | WEB32-P0-02/03 layout | `expectStoredWidths` 读 v2 legacy `workPanel.widthPx`；提交自 v0.3.12 S1.2 起写 `orion.web.right-workspace.v3` 的 per-workspace `detailWidthPx = max(360, w−48)` | 源码 + 探针（拖拽后 v3 提交路径核对） |
| 15 | WEB31-P0-03 professional-shell | 宽桌面求解器（>1180px，`App.tsx:190`）地板 = `max(360, w−48)+48 = 408`；断言的 320 是 v0.3.12 前契约 | 探针（408 精确复现）+源码 `App.tsx:648-665` |
| 16 | WEB36-P1-01 keyboard | 帮助按钮文案 `键盘快捷键帮助` → `查看键盘快捷键`（`WorkPanelDock.tsx:324`） | CI+源码 |
| 17 | WEB36-P1-02 keyboard | 主题循环经 Host 异步写回；测试点击后立即读 `dataset.theme` 读到旧值。探针证明 500ms 后 `system→light` 正常 | 探针 |
| 18 | WEB36-P0-01 keyboard | 键盘调宽功能正常（探针：ArrowRight 280→285→309 且落盘）；断言未等待异步生效 → 改 expect.poll | 探针 |
| 19 | WEB33-P0-03 theme | 会话标题 `<h1>` 已不存在于产品（全库仅启动/错误屏有 h1） | 源码 |
| 20 | WEB32-P0-11 queue-recovery | 离线文案已改为 `浏览器已离线，本地 Web Host 将在网络恢复后重连`（`reducer.ts:1835`） | CI+源码 |
| 21-23 | WEB31-P0-08/09/10 terminal | 三例全死于 `openTerminalPanel` 的旧停靠栏 tab 定位器（`终端，`）——**从未跑到 PTY 部分**；现为 rail `打开终端面板` / `data-work-panel-id="terminal"` | CI 日志（三例同一行号 276）+源码 |
| 24 | SET-P0-03 settings | 409 console errors 是测试自己「绕过 Host 改配置文件」的预期 CAS 冲突，未按 fixture 机制登记（`expectConsoleErrorOnce` 仅一处、且在别的用例） | manifest 事件（15× 409）+ 测试源码 :194 |
| 25 | WEB31-P0-02 / WEB32-P0-08/09/10（本地 4 例） | 本地沙箱失败、CI 通过；单跑 WEB32-P0-08 通过（0 错误）——连跑时的环境放大。**判 CI 为准** | 本地对照跑 |

## 待 S3 深判（1 个）

- **WEB33-P0-34 files-editor（5m）**：`.resource-error` + `重新加载` UI **存在**（`FilesPanel.tsx:392-443`），不是标记漂移；CI 在「外部改文件 → 编辑 → 保存被拒 → 点重新加载」链路的第 120 行点击处超时。需单独复现判定是产品缺陷（冲突恢复流）还是时序问题。判定基准 = CI 日志（本机 5 分钟用例，性价比后置）。

## 环境限制（本地，判 CI 为准）

- WEB31-P0-02、WEB32-P0-08/09/10 的本地失败：见上表 #25。**不作为产品缺陷证据**；D2 修复后重跑验证是否连带消失。

## 诊断设施（随本轮入库）

- `tests/e2e/fixtures/evidence.ts`：`MAX_CAPTURE_BYTES` / `MAX_EVENT_ENTRIES` 支持 `E2E_EVIDENCE_MAX_CAPTURE_BYTES` / `E2E_EVIDENCE_MAX_EVENT_ENTRIES` 环境变量覆盖（默认不变）——截断的证据无法分类，诊断跑需要更大缓冲。本表的 D2 定性直接依赖它。

## 修复顺位（供 S1/S2 执行）

1. **D1**（产品）：删 `aria-orientation`；同步 `web-rail-panel.spec.ts:24` 几何判定。
2. **D2**（产品）：loading case 认领 owner。
3. 共享 fixture（`fixtures/ui.ts` 的 `openInspector`/`collapseInspector`/`inspectorShortcuts`）——修 #6/#7/#21-23 四处。
4. 逐 spec 漂移修复（#1-5, #8-20）。
5. SET-P0-03 的 409 登记与 files-editor 深判（S3/S4）。

### D6 — the shortcut-help toggle→showModal handoff is racy (suspected product race, unfixed)

WEB36-P0-01/CI: pressing the second `Mod+/` toggle occasionally fails to open the dialog —
34 locator samples over 15s with the `open` attribute still absent (37413605332, full-suite
run-1; the same leg passed in runs 2-3 and locally). The test now retries the press with a
settle window. Suspected cause: the native `close` event's `setState(false)` racing the next
keydown's `setShortcutHelpOpen(o => !o)` toggle. Needs a dedicated look with React trace
data; low user impact (a second press opens it).
