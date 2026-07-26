# Issue #35 修复计划 — LSP 未安装导致进程崩溃

> **严重度**: Critical
> **影响版本**: v0.1.10 ~ v0.1.12（所有全局安装用户）
> **提出者**: @tianxingzhivlog-droid
> **创建日期**: 2026-06-02

---

## 1. 问题描述

未安装 `typescript-language-server` 时，Agent 自主调用 `lsp_get_*` 工具会触发 `ERR_UNHANDLED_ERROR`，整个 openhorse REPL 进程直接崩溃退出。用户丢失会话上下文、未保存的工作，且没有任何错误提示。

### 触发路径

```
Agent 调用 lsp_get_definition
  → LspManager.getClient(language, cwd)
    → new LspClient(language, cwd).start()
      → spawn('typescript-language-server', ['--stdio'])
        → 二进制不存在 → child_process 异步 emit 'error'(ENOENT)
          → this.emit('error', err.message)  // LspClient 是 EventEmitter
            → 无监听器 → Node 默认 throw → 进程 crash
```

### 关键问题

1. **无二进制预检**: `spawn()` 前不检查 `typescript-language-server` 是否在 PATH 中
2. **裸 emit('error')**: `LspClient` 的 `child.on('error')` 直接 `this.emit('error', …)`，但 `LspManager` 从未注册 `'error'` 监听器
3. **stderr 走 error 通道**: `child.stderr.on('data')` 的数据也被 `emit('error')` 转发，这是 Node 的保留通道
4. **try/catch 抓不到异步事件**: tool 层的 `try { await client.start() }` 已经 resolve 后 ENOENT 才到达

---

## 2. 根因分析

**文件**: `src/tools/lsp.ts`

```typescript
class LspClient extends EventEmitter {
  private process: ChildProcess | null = null;

  async start(): Promise<void> {
    const command = this.getLspCommand();
    this.process = spawn(command.cmd, command.args, { … });

    // 问题 1: stderr 数据走 'error' 事件（Node 保留通道，会 crash）
    this.process.stderr?.on('data', (data: Buffer) => {
      this.emit('error', data.toString());
    });

    // 问题 2: child ENOENT 异步事件转发，无监听器检查
    this.process.on('error', (err) => {
      this.emit('error', err.message);
    });
    …
  }
}

// LspManager 从未给 client 注册 error listener
async getClient(language: string, projectRoot: string) {
  const client = new LspClient(language, projectRoot);
  await client.start();  // 没有 .catch()，没有 .on('error')
  this.clients.set(key, client);
}
```

按 Node.js `EventEmitter` 规范，无监听器时 `emit('error', …)` 会触发 `events.js:509` 的 `throw err`——进程级崩溃。

---

## 3. 修复方案

### 修复 1: `start()` 做二进制预检

```typescript
private static probeBinary(cmd: string): boolean {
  const res = spawnSync(
    process.platform === 'win32' ? 'where' : 'which',
    [cmd],
    { stdio: 'ignore' }
  );
  return res.status === 0;
}

async start(): Promise<void> {
  const command = this.getLspCommand();

  // 预检：二进制是否存在 → 同步抛，被 tool 层 try/catch 捕获
  if (!LspClient.probeBinary(command.cmd)) {
    throw new Error(
      `LSP binary "${command.cmd}" not found in PATH. ` +
      `Install it first: npm i -g ${command.cmd}` +
      (command.cmd === 'typescript-language-server' ? ' typescript' : '')
    );
  }
  …
}
```

**效果**: `spawn` 前就知道二进制不存在，走同步异常路径，被 tool 层 `try/catch` 正常捕获，返回 `{success: false}`。

### 修复 2: `child.error` 转为安全处理

```typescript
this.process.on('error', (err: NodeJS.ErrnoException) => {
  const msg = err.code === 'ENOENT'
    ? `LSP binary "${command.cmd}" failed to start (ENOENT).`
    : `LSP process error: ${err.message}`;

  // 保底：无监听器时只 warn，不要 crash
  if (this.listenerCount('error') === 0) {
    console.warn(`[LSP] ${msg}`);
  } else {
    this.emit('error', msg);
  }
  this.process = null;
});
```

**效果**: 即便预检漏掉、spawn 后 ENOENT 仍然到达，`listenerCount === 0` 检查确保不崩溃。

### 修复 3: stderr 改为自定义事件

```typescript
this.process.stderr?.on('data', (data: Buffer) => {
  if (this.listenerCount('stderr') > 0) {
    this.emit('stderr', data.toString());
  }
});
```

**效果**: stderr 不再走 Node 保留的 `'error'` 通道，彻底消除意外 crash。

### 修复 4: `LspManager.getClient` 加兜底 listener

```typescript
async getClient(language: string, projectRoot: string) {
  const key = `${language}:${projectRoot}`;
  if (!this.clients.has(key)) {
    const client = new LspClient(language, projectRoot);

    // 兜底：确保 client 永远有 'error' 监听器
    client.on('error', (msg) => {
      console.warn(`[LSP:${language}] ${msg}`);
    });

    try {
      await client.start();
    } catch (err) {
      // start() 失败不要缓存坏 client
      client.dispose?.();
      throw err;
    }
    this.clients.set(key, client);
  }
  return this.clients.get(key)!;
}
```

**效果**: 多层兜底——预检 + listenerCount + manager listener——三层防护，任何一层都不会漏。

---

## 4. 修改范围

| 文件 | 预计变更 |
|------|----------|
| `src/tools/lsp.ts` | +35 / -8 行（核心修复） |
| `tests/lsp-crash.test.ts` | +50 行（新增） |

**不修改 happy path 行为**，只接住异常路径。

---

## 5. 测试方案

```typescript
describe('LSP crash prevention', () => {
  it('should not crash when typescript-language-server is missing', async () => {
    // 确保二进制不存在
    jest.mock('child_process', () => ({
      spawnSync: jest.fn().mockReturnValue({ status: 1 }),
    }));

    const result = await executeLspGetDefinition({
      file: 'test.ts',
      line: 10,
      column: 5,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should not crash on async ENOENT', async () => {
    // 模拟预检通过但 spawn 后异步 ENOENT
    // 验证 listenerCount 兜底生效
  });
});
```

---

## 6. 验收标准

- [ ] 未装 LSP 时调用 `lsp_get_*` 返回 `{success: false}`，进程不崩溃
- [ ] 已装 LSP 时 happy path 行为不变
- [ ] `tests/lsp-crash.test.ts` 新增测试通过
- [ ] `npm test` 全量通过

---

*创建日期: 2026-06-06*
