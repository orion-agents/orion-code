# 源码优先质量轮训：下一轮任务清单（2026-08-27）

- 轮训频率：每 30 分钟。
- 执行模式：每轮只聚焦单一维度；未检测到问题时写“本轮未复现问题”。
- 自动轮次：安全与输入校验 -> 权限与边界控制 -> 持久化/并发一致性 -> TUI 交互与终端输出安全 -> 依赖/版本与供应链风险 -> 测试完整性与测试实现一致性 -> 性能与回归风险 -> Release/发布工程风险。

## 上一轮结论

- 上一轮执行维度：**依赖/版本与供应链风险**。
- 重点核查文件：`scripts/release/release-check.js`、`scripts/release/runtime-matrix.ts`、`scripts/release/dep-health-check.sh`、`tests/release-scripts.test.ts`。
- 发现新增风险：
  - `release-check.js` 与 `runtime-matrix.ts` 在验证阶段使用 `npm install` 安装发布包时未加 `--ignore-scripts`，存在执行包生命周期脚本的供应链风险，可能放大验证路径副作用。
- 对应 Issue：已在官方仓库提交 [#215](https://github.com/orion-agents/orion-code/issues/215)（标签：`dependencies` `security` `release`）。

## 本轮执行结论（2026-08-27）

- 本轮执行维度：**测试完整性与测试实现一致性**。
- 重点核查文件：`src/cli.ts`、`scripts/release/runtime-matrix.ts`、`tests/runtime-matrix.test.ts`、`tests/web-server.test.ts`。
- 发现新增风险：
  - `runtime-matrix.ts` 的命令执行与探针链路没有在 Jest 测试里直接执行；`tests/runtime-matrix.test.ts` 仅验证 receipt 构造与验签结果，未覆盖脚本参数与 `web_journey` 的实际执行路径。
  - `orion web` 的参数解析（`--port`、`--no-open`、`--cwd`）在 `src/cli.ts` 中存在，但当前测试集中没有独立的 CLI 级回归。
- 对应 Issue：已在官方仓库提交 [#218](https://github.com/orion-agents/orion-code/issues/218)（标签：`testing`）。

## 下一轮待办（本次新增）

1. 将本轮优化建议写入后续验证：
   - 为 `release-check.js` 与 `runtime-matrix.ts` 的 `npm install` 安装命令补充 `--ignore-scripts`。
   - 在 `tests/release-scripts.test.ts` 增加回归断言：验证安装命令包含 `--ignore-scripts`（避免验证路径执行发布包脚本）。
   - 跟进 Issue [#215](https://github.com/orion-agents/orion-code/issues/215) 修复。
   - 跟进 Issue [#218](https://github.com/orion-agents/orion-code/issues/218) 修复，并补齐 `runtime-matrix` 与 `orion web` 的回归测试。

2. 按规则继承尚未关闭优化项：
   - Issue [#206](https://github.com/orion-agents/orion-code/issues/206)（`reliability` `tech-debt`）仍按原计划在“持久化/并发一致性”待办中跟进。

3. 下一轮轮训维度候选（按规则自动推进）：
  - **性能与回归风险**。

## 本地 30 分钟定时任务（已创建）

- 已新增调度脚本：`scripts/quality-review/rotate-orion-review.sh`。
- 已新增 launchd 模板：`scripts/quality-review/com.orion-quality-review.plist`。
- 安装命令（按顺序执行）：`scripts/quality-review/install-launchd.sh`（内部先移除旧任务，再加载新任务）。
- 停止命令（按顺序执行）：`scripts/quality-review/remove-launchd.sh`。
- 轮询结果与日志会写入：`<repo>/.quality-review/last-pass.txt`、`<repo>/.quality-review/last-fail.txt`、`$HOME/Library/Logs/orion-quality-review.log`，可通过 `QUALITY_REVIEW_STATE_DIR` 与 `QUALITY_REVIEW_LOG` 覆盖。
- 启动项固定使用 `QUALITY_REVIEW_BRANCH=v0.3.1`，默认命令为 `npm run lint && npm run test -- --runInBand`（未显式设置时）。
- 启动项通过 `QUALITY_REVIEW_NODE_BIN=/Users/hope/.nvm/versions/node/v22.22.3/bin` 固定 Node ABI，避免登录 shell 与共享 native `node_modules` 选择不同 Node major。
- 新增行为：如远端未配置或远端无 `v0.3.1` 分支，任务会跳过 `git pull`，避免每次打点因 `origin` 缺失而报错并仍保持本地审查照常执行。
- 安全约束：定时任务不会自动切换分支；当前分支不匹配时跳过本轮，工作树存在本地改动时跳过 `git pull`。

注意：定时任务当前负责执行本地质量检查脚本；源码审查、缺陷确认与 Issue 提交仍需按你当前的轮训规则由本次对话流程继续承接。
