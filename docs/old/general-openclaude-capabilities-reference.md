# OpenClaude 核心能力参考

> **OpenClaude v0.7.0** — 63 个模块，46 万行代码  
> 本文档提取 OpenClaude 的核心能力设计，作为 OpenHorse 的扩展参考。

---

## 一、工具系统（30+ 工具）

| 类别 | 工具 | 说明 |
|------|------|------|
| **文件操作** | FileRead, FileWrite, FileEdit | 读/写/编辑文件 |
| **Shell** | Bash, PowerShell, REPL | 执行命令 |
| **搜索** | Glob, Grep | 文件搜索/内容搜索 |
| **代码** | LSP, MCP | 语言服务协议/MCP |
| **交互** | AskUserQuestion, SendMessage | 用户问答/消息发送 |
| **工作流** | EnterPlanMode, ExitPlanMode | 计划模式切换 |
| **调度** | ScheduleCron, Sleep | 定时任务/延迟 |
| **协作** | EnterWorktree, SuggestBackgroundPR | 分支/PR 建议 |
| **监控** | Monitor | 运行监控 |

## 二、Agent 架构

| 组件 | 说明 |
|------|------|
| **coordinator** | Agent 协调器，多 Agent 编排 |
| **Task** | 任务抽象，支持任务链 |
| **Tool** | 工具基类，统一接口 |
| **QueryEngine** | 查询引擎，上下文检索 |
| **context** | 上下文管理，历史维护 |
| **cost-tracker** | 成本追踪，token 统计 |
| **buddy** | 辅助 Agent，后台任务 |

## 三、CLI 能力

| 功能 | 说明 |
|------|------|
| **流式输出** | SSE 流式响应 |
| **交互模式** | ink 终端 UI |
| **命令系统** | slash 命令（/help, /config 等）|
| **Provider 配置** | 多模型配置保存 |
| **成本显示** | 实时 token/费用统计 |
| **快捷键** | 键盘导航 |

## 四、集成能力

| 集成 | 说明 |
|------|------|
| **Provider** | 200+ 模型支持 |
| **MCP** | MCP 协议完整支持 |
| **LSP** | 语言服务协议 |
| **Bridge** | 远程桥接（Claude Code 兼容）|
| **gRPC** | gRPC 服务 |
| **VS Code** | 编辑器扩展 |
| **Android** | 移动端支持 |

## 五、记忆系统

| 组件 | 说明 |
|------|------|
| **memdir** | 记忆目录管理 |
| **history** | 对话历史 |
| **context** | 上下文窗口管理 |
| **migrations** | 数据迁移 |

---

*生成日期: 2026-05-02*
