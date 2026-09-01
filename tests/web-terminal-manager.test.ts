import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  TerminalManagerV1,
  type TerminalBackendV1,
  type TerminalProcessV1,
} from '../src/web/terminal-manager';

class FakeTerminalProcess implements TerminalProcessV1 {
  readonly pid = 999_999;
  readonly process = 'fake-shell';
  cols = 100;
  rows = 30;
  readonly writes: Array<string | Buffer> = [];
  readonly kills: string[] = [];
  paused = false;
  alive = true;
  survivesKill = false;
  pauseCalls = 0;
  resumeCalls = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();

  write(data: string | Buffer): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  kill(signal = 'default'): void {
    this.kills.push(signal);
    if (signal === 'SIGKILL' && !this.survivesKill) this.alive = false;
  }

  pause(): void {
    this.paused = true;
    this.pauseCalls += 1;
  }

  resume(): void {
    this.paused = false;
    this.resumeCalls += 1;
  }

  isAlive(): boolean {
    return this.alive;
  }

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(event: { exitCode: number; signal?: number }): void {
    this.alive = false;
    for (const listener of this.exitListeners) listener(event);
  }
}

describe('TerminalManagerV1', () => {
  let root: string;
  let workspaceA: string;
  let workspaceB: string;
  let active: { workspaceId: string; contextRevision: string };
  let processes: FakeTerminalProcess[];
  let spawnOptions: Array<{
    file: string;
    args: readonly string[];
    options: Parameters<TerminalBackendV1['spawn']>[2];
  }>;
  let manager: TerminalManagerV1;
  let now: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-web-terminal-'));
    workspaceA = join(root, 'workspace-a');
    workspaceB = join(root, 'workspace-b');
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);
    active = { workspaceId: 'workspace-a', contextRevision: 'revision-a' };
    processes = [];
    spawnOptions = [];
    now = 1_700_000_000_000;
    const backend: TerminalBackendV1 = {
      spawn: (file, args, options) => {
        const process = new FakeTerminalProcess();
        process.cols = options.cols;
        process.rows = options.rows;
        processes.push(process);
        spawnOptions.push({ file, args, options });
        return process;
      },
    };
    manager = new TerminalManagerV1({
      backend,
      now: () => now,
      ticketTtlMs: 100,
      idleTimeoutMs: 60_000,
      forceKillDelayMs: 10,
      shutdownGraceMs: 20,
      forceKillGraceMs: 100,
      getActiveContext: () => active,
      resolveWorkspace: id =>
        id === 'workspace-a' ? workspaceA : id === 'workspace-b' ? workspaceB : undefined,
    });
  });

  afterEach(async () => {
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
  });

  test('creates only in the active Context and scrubs provider secrets from the PTY environment', () => {
    const previousSecret = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'OPAQUE_TERMINAL_ENV_SECRET';
    try {
      expect(() =>
        manager.create({
          workspaceId: 'workspace-a',
          expectedContextRevision: 'stale',
        })
      ).toThrow(expect.objectContaining({ status: 409, code: 'context_revision_conflict' }));
      const result = manager.create({
        workspaceId: 'workspace-a',
        expectedContextRevision: 'revision-a',
        cols: 120,
        rows: 40,
      });

      expect(result.terminal).toMatchObject({
        workspaceId: 'workspace-a',
        state: 'running',
        cols: 120,
        rows: 40,
      });
      expect(result.ticket).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(spawnOptions[0].options.cwd).toBe(realpathSync(workspaceA));
      expect(spawnOptions[0].options.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(JSON.stringify(spawnOptions[0].options.env)).not.toContain(
        'OPAQUE_TERMINAL_ENV_SECRET'
      );
    } finally {
      if (previousSecret === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousSecret;
    }
  });

  test('consumes tickets once, expires them and replaces the previous input owner', () => {
    const created = manager.create({
      workspaceId: 'workspace-a',
      expectedContextRevision: 'revision-a',
    });
    const replaced = jest.fn();
    const first = manager.attach({
      terminalId: created.terminal.id,
      ticket: created.ticket,
      afterSequence: 0,
      onFrame: jest.fn(),
      onExit: jest.fn(),
      onReplaced: replaced,
    });
    first.write('printf ok\r');
    first.resize(140, 50);
    expect(processes[0].writes).toEqual(['printf ok\r']);
    expect(processes[0]).toMatchObject({ cols: 140, rows: 50 });
    expect(() =>
      manager.attach({
        terminalId: created.terminal.id,
        ticket: created.ticket,
        afterSequence: 0,
        onFrame: jest.fn(),
        onExit: jest.fn(),
        onReplaced: jest.fn(),
      })
    ).toThrow(expect.objectContaining({ status: 403, code: 'terminal_ticket_invalid' }));

    const nextTicket = manager.issueAttachTicket({
      terminalId: created.terminal.id,
      workspaceId: 'workspace-a',
      expectedContextRevision: 'revision-a',
    });
    const second = manager.attach({
      terminalId: created.terminal.id,
      ticket: nextTicket.ticket,
      afterSequence: 0,
      onFrame: jest.fn(),
      onExit: jest.fn(),
      onReplaced: jest.fn(),
    });
    expect(replaced).toHaveBeenCalledTimes(1);
    expect(() => first.write('stale')).toThrow(
      expect.objectContaining({ code: 'terminal_replaced' })
    );
    second.dispose();

    const expiring = manager.issueAttachTicket({
      terminalId: created.terminal.id,
      workspaceId: 'workspace-a',
      expectedContextRevision: 'revision-a',
    });
    now += 101;
    expect(() =>
      manager.attach({
        terminalId: created.terminal.id,
        ticket: expiring.ticket,
        afterSequence: 0,
        onFrame: jest.fn(),
        onExit: jest.fn(),
        onReplaced: jest.fn(),
      })
    ).toThrow(expect.objectContaining({ status: 403, code: 'terminal_ticket_invalid' }));
  });

  test('retains a bounded 2MiB replay window and reports a reconnect gap', () => {
    const created = manager.create({
      workspaceId: 'workspace-a',
      expectedContextRevision: 'revision-a',
    });
    processes[0].emitData('a'.repeat(1024 * 1024));
    processes[0].emitData('b'.repeat(1024 * 1024));
    processes[0].emitData('c'.repeat(1024 * 1024));

    const connection = manager.attach({
      terminalId: created.terminal.id,
      ticket: created.ticket,
      afterSequence: 0,
      onFrame: jest.fn(),
      onExit: jest.fn(),
      onReplaced: jest.fn(),
    });
    expect(connection.gap).toMatchObject({
      type: 'gap',
      earliestSequence: expect.any(Number),
      latestSequence: expect.any(Number),
    });
    expect(connection.terminal.earliestSequence).toBeGreaterThan(1);
    expect(
      connection.replay.reduce((bytes, frame) => bytes + Buffer.byteLength(frame.data), 0)
    ).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  test('coalesces a burst of small PTY chunks into one bounded output frame', async () => {
    const created = manager.create({
      workspaceId: 'workspace-a',
      expectedContextRevision: 'revision-a',
    });
    const frames: Array<{ type: 'output'; sequence: number; data: string }> = [];
    manager.attach({
      terminalId: created.terminal.id,
      ticket: created.ticket,
      afterSequence: 0,
      onFrame: frame => frames.push(frame),
      onExit: jest.fn(),
      onReplaced: jest.fn(),
    });

    for (let index = 0; index < 100; index += 1) processes[0].emitData('0123456789');

    expect(frames).toEqual([]);
    await waitFor(() => frames.length > 0);
    expect(frames).toEqual([{ type: 'output', sequence: 1, data: '0123456789'.repeat(100) }]);
  });

  test('never splits a Unicode surrogate pair across terminal output frames', () => {
    const created = manager.create({
      workspaceId: 'workspace-a',
      expectedContextRevision: 'revision-a',
    });
    const frames: string[] = [];
    manager.attach({
      terminalId: created.terminal.id,
      ticket: created.ticket,
      afterSequence: 0,
      onFrame: frame => frames.push(frame.data),
      onExit: jest.fn(),
      onReplaced: jest.fn(),
    });

    const output = `${'a'.repeat(7_999)}😀z`;
    processes[0].emitData(output);

    expect(frames.join('')).toBe(output);
    expect(frames).toHaveLength(2);
    expect(frames[0].charCodeAt(frames[0].length - 1)).not.toBeGreaterThanOrEqual(0xd800);
    expect(frames[1].charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
  });

  test('buffers a delayed surrogate pair and replaces an orphan only on final exit', async () => {
    const created = manager.create({
      workspaceId: 'workspace-a',
      expectedContextRevision: 'revision-a',
    });
    const frames: string[] = [];
    const exits: number[] = [];
    manager.attach({
      terminalId: created.terminal.id,
      ticket: created.ticket,
      afterSequence: 0,
      onFrame: frame => frames.push(frame.data),
      onExit: event => exits.push(event.exitCode),
      onReplaced: jest.fn(),
    });

    processes[0].emitData('\ud83d');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(frames).toEqual([]);

    processes[0].emitData('\ude00');
    await waitFor(() => frames.length === 1);
    expect(frames).toEqual(['😀']);

    processes[0].emitData('\ud83d');
    processes[0].emitExit({ exitCode: 0 });
    expect(frames).toEqual(['😀', '\ufffd']);
    expect(exits).toEqual([0]);
    expect(frames.join('')).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u
    );
  });

  test('pauses and resumes the PTY exactly once for connection backpressure', () => {
    const created = manager.create({
      workspaceId: 'workspace-a',
      expectedContextRevision: 'revision-a',
    });
    const connection = manager.attach({
      terminalId: created.terminal.id,
      ticket: created.ticket,
      afterSequence: 0,
      onFrame: jest.fn(),
      onExit: jest.fn(),
      onReplaced: jest.fn(),
    });

    connection.setOutputPaused(true);
    connection.setOutputPaused(true);
    expect(processes[0]).toMatchObject({ paused: true, pauseCalls: 1, resumeCalls: 0 });
    connection.setOutputPaused(false);
    connection.setOutputPaused(false);
    expect(processes[0]).toMatchObject({ paused: false, pauseCalls: 1, resumeCalls: 1 });

    connection.setOutputPaused(true);
    connection.dispose();
    expect(processes[0]).toMatchObject({ paused: false, pauseCalls: 2, resumeCalls: 2 });
  });

  test('enforces two terminals per Workspace and four globally', () => {
    for (let index = 0; index < 2; index += 1) {
      manager.create({
        workspaceId: 'workspace-a',
        expectedContextRevision: 'revision-a',
      });
    }
    expect(() =>
      manager.create({
        workspaceId: 'workspace-a',
        expectedContextRevision: 'revision-a',
      })
    ).toThrow(expect.objectContaining({ code: 'terminal_workspace_limit_reached' }));

    active = { workspaceId: 'workspace-b', contextRevision: 'revision-b' };
    for (let index = 0; index < 2; index += 1) {
      manager.create({
        workspaceId: 'workspace-b',
        expectedContextRevision: 'revision-b',
      });
    }
    expect(() =>
      manager.create({
        workspaceId: 'workspace-b',
        expectedContextRevision: 'revision-b',
      })
    ).toThrow(expect.objectContaining({ code: 'terminal_limit_reached' }));
  });

  test('closes the terminal and removes it after process exit', () => {
    const created = manager.create({
      workspaceId: 'workspace-a',
      expectedContextRevision: 'revision-a',
    });
    const closing = manager.closeTerminal({
      terminalId: created.terminal.id,
      workspaceId: 'workspace-a',
      expectedContextRevision: 'revision-a',
    });
    expect(closing.state).toBe('closing');
    expect(processes[0].kills).toContain('SIGTERM');
    processes[0].emitExit({ exitCode: 0, signal: 15 });
    expect(manager.list('workspace-a')).toEqual([]);
  });

  test('waits for graceful process-tree exit before completing shutdown', async () => {
    manager.create({
      workspaceId: 'workspace-a',
      expectedContextRevision: 'revision-a',
    });
    const shuttingDown = manager.shutdown();
    setTimeout(() => processes[0].emitExit({ exitCode: 0, signal: 15 }), 5);

    await shuttingDown;

    expect(processes[0].kills).toContain('SIGTERM');
    expect(processes[0].kills).not.toContain('SIGKILL');
    expect(manager.list('workspace-a')).toEqual([]);
  });

  test('force-kills and verifies a process tree when the PTY omits its exit callback', async () => {
    manager.create({
      workspaceId: 'workspace-a',
      expectedContextRevision: 'revision-a',
    });

    await manager.shutdown();

    expect(processes[0].kills).toEqual(expect.arrayContaining(['SIGTERM', 'SIGKILL']));
    expect(manager.list('workspace-a')).toEqual([]);
  });

  test('fails shutdown explicitly instead of claiming an unkillable tree was removed', async () => {
    const stubbornProcess = new FakeTerminalProcess();
    stubbornProcess.survivesKill = true;
    const stubbornManager = new TerminalManagerV1({
      backend: { spawn: () => stubbornProcess },
      resolveWorkspace: id => (id === 'workspace-a' ? workspaceA : undefined),
      getActiveContext: () => active,
      forceKillDelayMs: 5,
      shutdownGraceMs: 10,
      forceKillGraceMs: 20,
    });
    stubbornManager.create({
      workspaceId: 'workspace-a',
      expectedContextRevision: 'revision-a',
    });

    await expect(stubbornManager.shutdown()).rejects.toMatchObject({
      status: 503,
      code: 'terminal_shutdown_incomplete',
    });
    expect(stubbornManager.list('workspace-a')).toHaveLength(1);

    stubbornProcess.alive = false;
    await waitFor(() => stubbornManager.list('workspace-a').length === 0);
  });
});

describe('TerminalManagerV1 real process-tree shutdown', () => {
  test('does not orphan a background child after Host shutdown', async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'orion-web-terminal-tree-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const active = { workspaceId: 'workspace', contextRevision: 'revision' };
    const manager = new TerminalManagerV1({
      resolveWorkspace: id => (id === active.workspaceId ? workspace : undefined),
      getActiveContext: () => active,
      forceKillDelayMs: 100,
      shutdownGraceMs: 250,
      forceKillGraceMs: 2_000,
    });
    let childPid: number | undefined;
    try {
      if (!manager.available) return;
      const created = manager.create({
        workspaceId: active.workspaceId,
        expectedContextRevision: active.contextRevision,
      });
      const connection = manager.attach({
        terminalId: created.terminal.id,
        ticket: created.ticket,
        afterSequence: 0,
        onFrame: () => undefined,
        onExit: () => undefined,
        onReplaced: () => undefined,
      });
      const pidFile = join(workspace, 'background.pid');
      connection.write(`sleep 30 & printf '%s' $! > ${quoteShellWord(pidFile)}\r`);
      await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().length > 0);
      childPid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(Number.isSafeInteger(childPid)).toBe(true);
      expect(isProcessAlive(childPid)).toBe(true);

      await manager.shutdown();

      await waitFor(() => !isProcessAlive(childPid), 2_000);
      expect(isProcessAlive(childPid)).toBe(false);
    } finally {
      await manager.shutdown().catch(() => undefined);
      if (childPid && isProcessAlive(childPid)) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // The owned fixture child already exited.
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});

function quoteShellWord(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for terminal fixture state.');
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
}
