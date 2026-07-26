import { EventEmitter } from 'events';
import { Store } from '../src/framework/store';
import { loadConfig } from '../src/services/config';
import {
  launchTuiUI,
  parseExternalEditorCommand,
  statusSnapshotString,
} from '../src/tui-ui/launch';
import type { OpenHorseUiRuntime } from '../src/runtime/ui-events';

class FakeTTYInput extends EventEmitter {
  isTTY = true;
  rawModeValues: boolean[] = [];
  resumed = false;
  paused = false;

  setRawMode(value: boolean): void {
    this.rawModeValues.push(value);
  }

  resume(): void {
    this.resumed = true;
  }

  pause(): void {
    this.paused = true;
  }
}

class FakeTTYOutput extends EventEmitter {
  isTTY = true;
  writable = true;
  columns = 64;
  rows = 12;
  chunks: string[] = [];

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }

  text(): string {
    return this.chunks.join('');
  }
}

class FailingTTYOutput extends FakeTTYOutput {
  private writeCount = 0;

  constructor(private readonly acceptedWrites: number) {
    super();
  }

  override write(chunk: string | Uint8Array): boolean {
    this.writeCount += 1;
    if (this.writeCount > this.acceptedWrites) {
      this.writable = false;
      throw new Error('simulated terminal output failure');
    }
    return super.write(chunk);
  }
}

function makeRuntime(): OpenHorseUiRuntime {
  const config = loadConfig({
    apiKey: 'sk-test',
    model: 'glm-5',
    ui: { renderer: 'tui', confirmations: 'config' },
  });
  const store = new Store({
    config,
    tools: [],
    currentModel: config.model,
  });

  return {
    cwd: '/tmp/openhorse-project',
    version: '0.2.3-test',
    config,
    store,
    llm: null,
    runtime: {} as any,
    isConfigured: true,
    ensureSession: jest.fn(() => ({
      id: 'session-test',
      projectPath: '/tmp/openhorse-project',
      model: 'glm-5',
      startTime: Date.now(),
      tokenCount: 0,
      cost: 0,
      messageCount: 0,
    })),
    setSession: jest.fn(),
    getSession: jest.fn(() => null),
    shutdown: jest.fn(async () => undefined),
  };
}

function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('tui-ui launch', () => {
  it('parses external editor commands without invoking a shell', () => {
    expect(parseExternalEditorCommand('code --wait')).toEqual(['code', '--wait']);
    expect(
      parseExternalEditorCommand(
        '"/Applications/Visual Studio Code.app/Contents/MacOS/Electron" --wait'
      )
    ).toEqual(['/Applications/Visual Studio Code.app/Contents/MacOS/Electron', '--wait']);
    expect(parseExternalEditorCommand("vim -c 'set number'")).toEqual(['vim', '-c', 'set number']);
    expect(() => parseExternalEditorCommand("vim 'unfinished")).toThrow(
      'unterminated quote or escape'
    );
  });

  it('shows current context pressure in the TUI status line', () => {
    const runtime = makeRuntime();
    runtime.store.setContextUsage({
      modelId: 'glm-5',
      usedTokens: 172339,
      contextWindow: 202752,
      percent: 85,
      source: 'estimated',
      warningThresholdPercent: 80,
      autoCompactThresholdPercent: 95,
      autoCompactEnabled: true,
    });

    const status = statusSnapshotString(runtime);
    expect(status).toContain('model=glm-5  ctx=85% /compact');
    expect(status).not.toContain('cost=');
  });

  it('owns terminal mode setup/teardown around the renderer', async () => {
    const input = new FakeTTYInput();
    const output = new FakeTTYOutput();
    const runtime = makeRuntime();

    const launch = launchTuiUI(runtime, { input: input as any, output: output as any });
    input.emit('data', Buffer.from('/exit\r'));
    await launch;

    expect(input.rawModeValues).toEqual([true, false]);
    expect(input.resumed).toBe(true);
    expect(input.paused).toBe(true);
    // v0.2.21: primary-screen inline surface - NO alternate screen.
    expect(output.text()).not.toContain('\x1b[?1049h');
    expect(output.text()).not.toContain('\x1b[?1049l');
    expect(output.text()).toContain('\x1b[?2004h');
    expect(output.text()).toContain('\x1b[?2004l');
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it('keeps CJK prompt editing visible through the real launch path', async () => {
    const input = new FakeTTYInput();
    const output = new FakeTTYOutput();
    const runtime = makeRuntime();

    const launch = launchTuiUI(runtime, { input: input as any, output: output as any });
    input.emit('data', Buffer.from('开源小？事收到', 'utf8'));
    // Let the typed-state render flush before the next keystroke so the
    // pre-backspace prompt state is emitted to the stream.
    await tick();
    await tick();
    input.emit('data', Buffer.from('\x7f'));
    await tick();
    await tick();
    input.emit('data', Buffer.from('\x15/exit\r'));
    await launch;

    const text = output.text();
    expect(text).toContain('开源小？事收到');
    expect(text).toContain('开源小？事收');
    expect(input.rawModeValues).toEqual([true, false]);
  });

  it('routes asynchronous console diagnostics through the owned surface', async () => {
    const input = new FakeTTYInput();
    const output = new FakeTTYOutput();
    const runtime = makeRuntime();
    const originalError = console.error;
    const originalDebug = console.debug;

    const launch = launchTuiUI(runtime, { input: input as any, output: output as any });
    await tick();
    console.error('\x1b[31mbackground MCP diagnostic\x1b[0m');
    console.debug('background debug diagnostic');
    await tick();
    await tick();
    input.emit('data', Buffer.from('/exit\r'));
    await launch;

    expect(output.text()).toContain('background MCP diagnostic');
    expect(output.text()).toContain('background debug diagnostic');
    expect(output.text()).not.toContain('\x1b[31mbackground MCP diagnostic');
    expect(console.error).toBe(originalError);
    expect(console.debug).toBe(originalDebug);
  });
});

// ============================================================================
// Slice 7: Exception recovery and lifecycle
// ============================================================================

describe('slice 7: lifecycle and exception recovery', () => {
  it('restores raw mode and stops when the inline surface fails', async () => {
    const input = new FakeTTYInput();
    const output = new FailingTTYOutput(1);
    const runtime = makeRuntime();

    await launchTuiUI(runtime, { input: input as any, output: output as any });

    expect(input.rawModeValues).toContain(true);
    expect(input.rawModeValues).toContain(false);
    expect(input.paused).toBe(true);
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it('restores terminal on every exit path: raw mode, cursor, autowrap, bracketed paste', async () => {
    const input = new FakeTTYInput();
    const output = new FakeTTYOutput();
    const runtime = makeRuntime();

    const launch = launchTuiUI(runtime, { input: input as any, output: output as any });
    input.emit('data', Buffer.from('/exit\r'));
    await launch;

    // Every exit path must restore these.
    expect(input.rawModeValues).toContain(false);
    const text = output.text();
    expect(text).toContain('\x1b[?25h'); // show cursor
    expect(text).toContain('\x1b[?7h'); // enable autowrap
    expect(text).toContain('\x1b[?2004l'); // disable bracketed paste
    // Must NOT clear primary-screen history.
    expect(text).not.toContain('\x1b[2J'); // no full clear
    expect(text).not.toContain('\x1b[?1049'); // no alternate screen
  });

  it('once guard prevents duplicate cleanup on concurrent stop calls', async () => {
    const input = new FakeTTYInput();
    const output = new FakeTTYOutput();
    const runtime = makeRuntime();

    const launch = launchTuiUI(runtime, { input: input as any, output: output as any });
    // Wait for startup.
    await tick();
    // Trigger multiple exit signals rapidly.
    input.emit('data', Buffer.from('/exit\r'));
    input.emit('data', Buffer.from('/exit\r'));
    input.emit('data', Buffer.from('/exit\r'));
    await launch;

    // Runtime shutdown should only be called once.
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
    // Raw mode should only be restored once (setRawMode(false) called once).
    const falseCount = input.rawModeValues.filter(v => !v).length;
    expect(falseCount).toBe(1);
  });

  it('SIGTERM triggers direct cleanup without double-Ctrl+C semantics', async () => {
    const input = new FakeTTYInput();
    const output = new FakeTTYOutput();
    const runtime = makeRuntime();

    const launch = launchTuiUI(runtime, { input: input as any, output: output as any });
    await tick();
    // Simulate SIGTERM.
    process.emit('SIGTERM' as any);
    await launch;

    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(input.rawModeValues).toContain(false);
  });

  it('SIGTERM exits an active Inspector and restores the primary screen', async () => {
    const input = new FakeTTYInput();
    const output = new FakeTTYOutput();
    const runtime = makeRuntime();

    const launch = launchTuiUI(runtime, { input: input as any, output: output as any });
    await tick();
    input.emit('data', Buffer.from('\x0f'));
    await tick();
    await tick();
    expect(output.text()).toContain('\x1b[?1049h');

    process.emit('SIGTERM' as any);
    await launch;

    expect(output.text()).toContain('\x1b[?1049l');
    expect(output.text().lastIndexOf('\x1b[?1049l')).toBeGreaterThan(
      output.text().lastIndexOf('\x1b[?1049h')
    );
    expect(input.rawModeValues).toContain(false);
  });

  it('SIGHUP triggers direct cleanup', async () => {
    const input = new FakeTTYInput();
    const output = new FakeTTYOutput();
    const runtime = makeRuntime();

    const launch = launchTuiUI(runtime, { input: input as any, output: output as any });
    await tick();
    // Simulate SIGHUP.
    process.emit('SIGHUP' as any);
    await launch;

    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(input.rawModeValues).toContain(false);
  });

  it('does not accept input after stopping', async () => {
    const input = new FakeTTYInput();
    const output = new FakeTTYOutput();
    const runtime = makeRuntime();

    const launch = launchTuiUI(runtime, { input: input as any, output: output as any });
    await tick();
    // Exit.
    input.emit('data', Buffer.from('/exit\r'));
    await launch;

    // Input after stop should be ignored (no crash).
    input.emit('data', Buffer.from('should be ignored'));
    // No additional shutdown calls.
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it('resize after stopping is a no-op', async () => {
    const input = new FakeTTYInput();
    const output = new FakeTTYOutput();
    const runtime = makeRuntime();

    const launch = launchTuiUI(runtime, { input: input as any, output: output as any });
    await tick();
    input.emit('data', Buffer.from('/exit\r'));
    await launch;

    // Resize after stop should not crash.
    output.emit('resize');
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
  });
});
