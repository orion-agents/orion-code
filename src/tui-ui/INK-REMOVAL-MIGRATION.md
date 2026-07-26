# Ink/React/Yoga 删除迁移清单

> **状态**：v0.2.21 将 Ink 标记为 deprecated beta。本清单记录后续版本完全删除
> Ink/React/Yoga 所需的步骤。不修改 docs/*，不 stage/push docs/*。

---

## 前置条件

- [x] TUI 已达到 recommended beta 能力水平
- [x] Shared composer 已迁移到 `src/runtime/composer/`，Ink 为 compatibility re-export
- [x] CLI/help/config 已标注 Ink 为 deprecated
- [ ] TUI 通过 30 分钟以上长会话 smoke 测试
- [ ] 真实终端矩阵验证完成（macOS Terminal, iTerm2, VS Code Terminal）

---

## 第一阶段：确认 TUI 功能覆盖

| Ink 组件 | TUI 对应 | 状态 |
|----------|---------|------|
| `Markdown.tsx` | `src/runtime/rich-text/*` | ✅ 已实现 |
| `PromptInput.tsx` | `src/runtime/composer/*` | ✅ 已迁移 |
| `StatusLine.tsx` | `TuiStatusState` + layout | ✅ 已实现 |
| `ToolActivity.tsx` | `TuiRuntimeToolEvent` + timeline | ✅ 已实现 |
| `Transcript.tsx` | `InlineTerminalSurface` commit/live | ✅ 已实现 |
| `NativeCursor.tsx` | `TuiTerminalWriter` cursor bracket | ✅ 已实现 |
| `SelectList.tsx` | `TuiOverlayState` pickers | ✅ 已实现 |
| `PixelHorseBanner.tsx` | N/A (decorative) | 可删除 |
| `RunningHorseIndicator.tsx` | TUI status animation | 可删除或迁移 |

---

## 第二阶段：文件级迁移动作

### 可直接删除的 Ink 文件

```
src/ink-ui/App.tsx
src/ink-ui/components/Markdown.tsx
src/ink-ui/components/NativeCursor.tsx
src/ink-ui/components/PixelHorseBanner.tsx
src/ink-ui/components/RunningHorseIndicator.tsx
src/ink-ui/components/SelectList.tsx
src/ink-ui/components/StatusLine.tsx
src/ink-ui/components/ToolActivity.tsx
src/ink-ui/components/Transcript.tsx
src/ink-ui/controllers/chat-controller.ts
src/ink-ui/hooks/use-raw-input-bridge.ts
src/ink-ui/hooks/use-terminal-size.ts
src/ink-ui/launch.tsx
src/ink-ui/screens/ReplScreen.tsx
src/ink-ui/types.ts
```

### 已迁移到 runtime 的 Ink 算法文件（删除后需确认无外部引用）

```
src/ink-ui/runtime/grapheme.ts       → src/runtime/composer/grapheme.ts (re-export)
src/ink-ui/runtime/input-buffer.ts   → src/runtime/composer/buffer.ts (re-export)
src/ink-ui/runtime/prompt-layout.ts  → src/runtime/composer/layout.ts (re-export)
```

### 保留但需审查的 Ink 文件

```
src/ink-ui/runtime/layout-budget.ts   — 独立 layout 算法，可能被 TUI 复用
src/ink-ui/runtime/native-cursor.ts   — cursor 控制逻辑，TUI 已有替代
src/ink-ui/runtime/raw-input.ts       — raw input 桥接，TUI 已有 input-parser
src/ink-ui/runtime/transcript-state.ts — transcript 状态管理，TUI 已有 state.ts
```

---

## 第三阶段：依赖移除

### package.json

```diff
- "ink": "^3.2.0",
- "react": "^17.0.2",
- "@types/react": "^17.0.83",
```

### package-lock.json

- 移除 `ink`, `react`, `@types/react`, `yoga-layout-prebuilt`, `@types/yoga-layout`
- 及其传递依赖

### 代码引用清理

1. 搜索并移除所有 `import ... from 'ink'` 和 `import ... from 'react'`
2. 搜索并移除所有 `import ... from '../ink-ui/...'` （除 compatibility re-export 外）
3. 移除 `src/runtime/ui-events.ts` 中 `OrionCodeInkRuntime` deprecated type alias (via OpenHorseInkRuntime)
4. 移除 `src/runtime/chat-controller.ts` 中 deprecated Ink type aliases
5. 更新 `tsconfig.json` 如果有 Ink/JSX 相关 compiler options

---

## 第四阶段：测试收口

1. 删除 `tests/ink-*` 相关测试（如有）
2. 保留 `tests/runtime-ui-parity.test.ts` 中 Ink parity 部分改为只验证 TUI
3. 运行完整门禁确认无回归
4. 更新 CLI 帮助文档移除 `--ui ink` 选项

---

## 第五阶段：验证

- [ ] `npm run build` 无 error
- [ ] `npx jest --runInBand` 全量通过
- [ ] PTY smoke 测试通过
- [ ] `grep -r "ink" src/ --include='*.ts'` 无残留引用
- [ ] `grep -r "react" src/ --include='*.ts'` 无残留引用
- [ ] package-lock.json 不包含 ink/react/yoga

---

## 风险

1. **Ink compatibility re-exports**：`src/ink-ui/runtime/{grapheme,input-buffer,prompt-layout}.ts`
   目前 re-export `src/runtime/composer/*`。如果外部代码直接 import 这些路径，需要
   逐步迁移到 `src/runtime/composer/*`，然后才能安全删除 re-export 文件。

2. **第三方 renderer 集成**：如果社区有基于 Ink 的自定义 renderer，删除 Ink 会
   破坏它们。建议在删除前至少发布一个 minor version 明确标注 Ink deprecated。

3. **Yoga 布局测试**：如果现有测试依赖 Yoga 布局引擎的行为，需要在 TUI 中提供
   等效的 layout 测试。
