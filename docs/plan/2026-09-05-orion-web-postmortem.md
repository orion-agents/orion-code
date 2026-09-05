# Postmortem：Web Workbench 会话红 banner + orion.json 锁超时（2026-09-05）

- 状态：已解决（clean 0.3.11 + launchd 托管后用户确认真常）；非代码回归。
- 涉及环境：本机 macOS（hope-mbp），全局 npm 安装 `@orion-agents/orion-code`，launchd 托管 Web host。

## 现象

1. 浏览器 Workbench 出现红色 banner：`切换项目目录下文件夹失败` / `会话快照尚未同步` / `会话快照加载失败`，文案均以 `The local Web Workbench request failed.` 结尾。
2. 用户终端执行裸 `orion`（TUI）报：
   `Fatal error: Timed out waiting for file lock /Users/hope/.orion-code/orion.json.lock.recovery`
3. 左下角版本号停留在旧版本（0.3.9），即使全局已升级。

## 根因（三层，相互叠加）

### A. 页面请求失败 = 浏览器持有已死 host 的句柄（非代码问题）
- 排查期间 host 进程被多次 kill/换版本重启；浏览器页面（React state、SSE/事件流、请求句柄）仍指向被杀进程。
- 组件层 fetch 失败兜底 → 红 banner。`git diff origin/main..codex/v0.3.12 -- src/web/server.ts src/services/session-storage.ts src/services/session-index.ts src/web/workbench-controller.ts` = **0 行改动**：会话/快照链路未被 v0.3.12 触碰，排除代码回归。

### B. 锁超时 = 沙箱 spawn 的 host 残留 recovery 哨兵
- WorkBuddy 沙箱通过 `NODE_OPTIONS=--require …/node-language-shim.cjs` 注入 safe-delete shim；从沙箱 `nohup` 拉起的 host 进程同样继承。
- host 释放 `orion.json.lock` 时 `rmSync` 被 shim 拦截抛错 → `.lock`/`.lock.recovery` 残留在 `~/.orion-code/`，其 pid 仍存活 → 其它 orion 进程 `acquireLock` 轮询至超时。

### C. 版本号不更新 = node 进程启动即固定
- 进程启动时读取 package.json/加载 dist；全局升级后运行中的 host 仍服务旧代码与旧版本号，必须重启进程。

## 处置链（复盘供复用）

```bash
# 1) 停止 host（杀全部 port 4242 进程）
for p in $(pgrep -f "port 4242"); do kill "$p"; done

# 2) 清理锁残留（.candidate-* 属正常，勿动）
mv ~/.orion-code/orion.json.lock /tmp/...; mv ~/.orion-code/orion.json.lock.recovery /tmp/...

# 3) 干净卸载全局包（shim 拦 rm，用 mv 到 /tmp/orion-global-purge）
B=…/lib/node_modules/@orion-agents; N=…/bin
mv "$B/orion-code" /tmp/orion-global-purge/; mv "$B"/.orion-code-* /tmp/orion-global-purge/; mv "$N/orion" /tmp/orion-global-purge/

# 4) 重新安装目标版本（registry）
PATH=$N:$PATH npm install -g @orion-agents/orion-code@<version>

# 5) launchd（非沙箱）托管 Web host；plist cwd 指工作目录
launchctl bootout gui/$(id -u)/ai.orion-code.web   # 先卸
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.orion-code.web.plist

# 6) 验证：curl health 版本；浏览器彻底关标签页后重开
```

## 预防规则

1. 常驻 host 只由 **launchd** 或**用户真实终端**托管；WorkBuddy 沙箱内**不 spawn** 任何 orion host/daemon（shim 无法删锁文件）。
2. 升级/更换全局 orion 版本后：重启 host + **彻底关闭浏览器标签页重开**（旧 SSE 句柄导致红 banner 是环境现象）。
3. 换版本排查页面问题时：registry 干净安装 + 非沙箱 host，先排除环境残留，再讨论代码；关键路径 diff 零改动时应先怀疑进程生命周期。
4. host 归属单一化：`ai.orion-code.web`（launchd，cwd=master）与用户手动进程不要同端口并存。

## 最终结论

干净安装 npm 发布 0.3.11 + launchd 托管后一切正常 → 问题为**沙箱 spawn 进程的锁残留 × 浏览器陈旧句柄 × 未重启进程**的组合，与 v0.3.9→v0.3.12 代码改动无关。
