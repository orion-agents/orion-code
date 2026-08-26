import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { launchPrintMode, PrintEventSink } from '../src/print-ui/launch';
import { AgentRuntimeController } from '../src/runtime/agent-runtime-controller';
import type { OrionCodeUiRuntime } from '../src/runtime/ui-events';
import { appendSessionMessage, createSession } from '../src/services/session-storage';
import { canRunCliSmoke } from './support/env';
import {
  makeToolStartedEvent,
  makeToolFinishedEvent,
  resetToolEventSequence,
} from './test-helpers';

function findPython(): string | null {
  for (const command of ['python3', 'python']) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
    if (result.status === 0) return command;
  }
  return null;
}

describe('print mode smoke', () => {
  const python = findPython();
  const smokeScript = join(__dirname, '..', 'scripts', 'smoke', 'print-mode-smoke.py');
  const maybeIt =
    python && existsSync(smokeScript) && process.platform !== 'win32' && canRunCliSmoke
      ? it
      : it.skip;

  maybeIt(
    'runs text, json, and piped stdin prompts without interactive UI',
    () => {
      const result = spawnSync(python as string, [smokeScript], {
        cwd: join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });

      expect({
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
      }).toEqual(expect.objectContaining({ status: 0, signal: null }));
    },
    65000
  );
});

describe('print mode event sink', () => {
  beforeEach(() => resetToolEventSequence());

  function runtime(cwd = '/tmp/openhorse'): OrionCodeUiRuntime {
    return {
      cwd,
      version: 'test',
      config: { model: 'test-model' } as OrionCodeUiRuntime['config'],
      store: {
        getSnapshot: () => ({ currentModel: 'test-model' }),
        setProcessing: jest.fn(),
      } as unknown as OrionCodeUiRuntime['store'],
      llm: null,
      isConfigured: true,
      ensureSession: jest.fn(),
      setSession: jest.fn(),
      getSession: jest.fn(() => null),
      shutdown: jest.fn(),
    };
  }

  it('preserves stable command identity in JSON transcript entries', () => {
    const sink = new PrintEventSink(runtime(), 'json');
    sink.append({
      role: 'system',
      content: 'status output',
      command: {
        id: 'builtin.system.status',
        name: 'status',
        source: { kind: 'builtin', id: 'orion-code', trust: 'core' },
        success: true,
      },
    });

    expect(sink.result().entries[0]).toMatchObject({
      content: 'status output',
      command: { id: 'builtin.system.status', name: 'status', success: true },
    });
  });

  it('keeps structured tool events in json results without polluting content', () => {
    const sink = new PrintEventSink(runtime(), 'json');

    sink.append({ role: 'assistant', content: 'answer' });
    sink.toolStarted(
      makeToolStartedEvent({ callId: 'call-1', name: 'read_file', args: { path: 'src/index.ts' } })
    );
    sink.toolFinished(
      makeToolFinishedEvent({
        callId: 'call-1',
        name: 'read_file',
        args: { path: 'src/index.ts' },
        success: true,
        duration: 12,
        summary: 'read ok',
      })
    );

    expect(sink.result()).toEqual(
      expect.objectContaining({
        content: 'answer',
        toolEvents: [
          {
            type: 'started',
            callId: 'call-1',
            name: 'read_file',
            args: { path: 'src/index.ts' },
            sequence: 1,
          },
          {
            type: 'finished',
            callId: 'call-1',
            name: 'read_file',
            args: { path: 'src/index.ts' },
            success: true,
            duration: 12,
            summary: 'read ok',
            sequence: 1,
          },
        ],
      })
    );
  });

  it('keeps reasoning lifecycle entries structured without polluting answer content', () => {
    const sink = new PrintEventSink(runtime(), 'json');

    sink.append({ role: 'assistant', title: 'reasoning', content: 'Model reasoning started' });
    sink.append({ role: 'assistant', content: 'final answer' });

    expect(sink.result()).toEqual(
      expect.objectContaining({
        content: 'final answer',
        entries: expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            title: 'reasoning',
            content: 'Model reasoning started',
          }),
        ]),
      })
    );
  });

  it('records non-interactive permission requests as deterministic print mode errors', () => {
    const sink = new PrintEventSink(runtime(), 'json');

    sink.showPermissionRequest({
      id: 'permission-1',
      name: 'exec_command',
      args: { command: 'npm publish' },
      reason: 'publishing changes external state',
    });

    expect(sink.hasErrors()).toBe(true);
    expect(sink.result()).toEqual(
      expect.objectContaining({
        errors: [
          'Tool exec_command requires confirmation, but print mode is non-interactive. publishing changes external state',
        ],
      })
    );
  });

  it('sanitizes Goal and research lifecycle fields before text stderr output', () => {
    const writes: string[] = [];
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      writes.push(String(chunk));
      return true;
    });
    const sink = new PrintEventSink(runtime(), 'text');

    try {
      sink.goalEvent({
        type: 'goal_plan_updated',
        goalId: 'goal-1',
        planRevision: 1,
        phase: 'execution',
        nextAction: 'next\x1b[2J-safe\x9b31m-step',
      });
      sink.researchEvent({
        type: 'research_source',
        packetId: 'packet-1',
        sourceId: 'source-safe',
        status: 'failed',
        provider: 'provider\x1b]0;hijack\x07',
        failureReason: 'reason\x9d52;c;payload\x9c-safe',
      });
    } finally {
      stderr.mockRestore();
    }

    const output = writes.join('');
    expect(output).not.toMatch(/[\x1b\x80-\x9f]/u);
    expect(output).toContain('next-safe-step');
    expect(output).toContain('provider=provider');
    expect(output).toContain('failure=reason-safe');
  });

  it('fails print mode when Goal shutdown state cannot be persisted', () => {
    const sink = new PrintEventSink(runtime(), 'json');
    const message =
      'Goal continuation deferred but persistence failed: Goal persistence failed (io_error).';

    sink.setStatus(message);

    expect(sink.hasErrors()).toBe(true);
    expect(sink.result()).toEqual(
      expect.objectContaining({
        statuses: [message],
        errors: [message],
      })
    );
  });

  it('uses non-interactive renderer capabilities for resume fallback', async () => {
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    const root = mkdtempSync(join(tmpdir(), 'orion-code-print-mode-'));
    const projectDir = join(root, 'project');
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');

    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk, callbackOrEncoding?, callback?) => {
        stdout.push(String(chunk));
        const done =
          typeof callbackOrEncoding === 'function'
            ? callbackOrEncoding
            : typeof callback === 'function'
              ? callback
              : undefined;
        done?.();
        return true;
      });
    const stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: any, callbackOrEncoding?: any, callback?: any) => {
        stderr.push(String(chunk));
        const done =
          typeof callbackOrEncoding === 'function'
            ? callbackOrEncoding
            : typeof callback === 'function'
              ? callback
              : undefined;
        done?.();
        return true;
      });

    try {
      for (const content of ['first session', 'second session']) {
        const session = createSession(projectDir, 'test-model');
        appendSessionMessage(session.id, {
          role: 'user',
          content,
          timestamp: Date.now(),
        });
      }

      const exitCode = await launchPrintMode(runtime(projectDir), '/resume', {
        outputFormat: 'json',
      });
      const result = JSON.parse(stdout.join(''));

      expect(exitCode).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.content).toContain('Use /resume <number|session-id|name>');
      expect(result.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            title: '/resume',
            content: expect.stringContaining('Pick a Session'),
          }),
        ])
      );
      expect(stderr.join('')).toBe('');
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      if (previousConfigDir === undefined) {
        delete process.env.ORION_CODE_CONFIG_DIR;
      } else {
        process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops the controller before runtime shutdown', async () => {
    const order: string[] = [];
    const stopSpy = jest
      .spyOn(AgentRuntimeController.prototype, 'stopActiveTurn')
      .mockImplementation(async () => {
        order.push('controller-stop');
      });
    const printRuntime = runtime();
    printRuntime.shutdown = jest.fn(async () => {
      order.push('runtime-shutdown');
    });

    const stdout: string[] = [];
    const stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk, callbackOrEncoding?, callback?) => {
        stdout.push(String(chunk));
        const done =
          typeof callbackOrEncoding === 'function'
            ? callbackOrEncoding
            : typeof callback === 'function'
              ? callback
              : undefined;
        done?.();
        order.push('stdout-flushed');
        return true;
      });
    const stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((_chunk, callbackOrEncoding?, callback?) => {
        const done =
          typeof callbackOrEncoding === 'function'
            ? callbackOrEncoding
            : typeof callback === 'function'
              ? callback
              : undefined;
        done?.();
        order.push('stderr-flushed');
        return true;
      });

    try {
      await expect(launchPrintMode(printRuntime, '/exit', { outputFormat: 'json' })).resolves.toBe(
        0
      );
      expect(order).toEqual([
        'controller-stop',
        'runtime-shutdown',
        'stdout-flushed',
        'stderr-flushed',
      ]);
      expect(JSON.parse(stdout.join(''))).toEqual(
        expect.objectContaining({ goalEvents: [], errors: [] })
      );
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      stopSpy.mockRestore();
    }
  });

  it('does not resolve until redirected stderr reports its queued diagnostics flushed', async () => {
    const stopSpy = jest
      .spyOn(AgentRuntimeController.prototype, 'stopActiveTurn')
      .mockImplementation(async () => undefined);
    const stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((_chunk: any, callbackOrEncoding?: any, callback?: any) => {
        const done =
          typeof callbackOrEncoding === 'function'
            ? callbackOrEncoding
            : typeof callback === 'function'
              ? callback
              : undefined;
        done?.();
        return true;
      });
    // Every write onto the mocked stream has to be tracked, not just the most
    // recent one. Node emits unrelated diagnostics (e.g. the DEP0040 punycode
    // deprecation) asynchronously onto stderr, and a single-slot reference lets
    // such a write overwrite flushStderr()'s callback -- releasing the wrong one
    // leaves the launch promise pending until the test times out.
    const pendingStderrWrites: Array<() => void> = [];
    const releaseStderr = (): void => {
      while (pendingStderrWrites.length > 0) {
        pendingStderrWrites.shift()?.();
      }
    };
    const stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((_chunk, callbackOrEncoding?, callback?) => {
        const done =
          typeof callbackOrEncoding === 'function'
            ? callbackOrEncoding
            : typeof callback === 'function'
              ? callback
              : undefined;
        if (done) {
          pendingStderrWrites.push(done);
        }
        return false;
      });

    try {
      let settled = false;
      const launch = launchPrintMode(runtime(), '/exit', { outputFormat: 'json' }).then(code => {
        settled = true;
        return code;
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      releaseStderr();
      await expect(launch).resolves.toBe(0);
      expect(settled).toBe(true);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      stopSpy.mockRestore();
    }
  });

  it('emits and flushes JSON before rethrowing the original shutdown error', async () => {
    const order: string[] = [];
    const shutdownError = new Error('synthetic shutdown failure');
    const stopSpy = jest
      .spyOn(AgentRuntimeController.prototype, 'stopActiveTurn')
      .mockImplementation(async () => {
        order.push('controller-stop');
      });
    const printRuntime = runtime();
    printRuntime.shutdown = jest.fn(async () => {
      order.push('runtime-shutdown');
      throw shutdownError;
    });
    const stdout: string[] = [];
    const stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk, callbackOrEncoding?, callback?) => {
        stdout.push(String(chunk));
        const done =
          typeof callbackOrEncoding === 'function'
            ? callbackOrEncoding
            : typeof callback === 'function'
              ? callback
              : undefined;
        done?.();
        order.push('stdout-flushed');
        return true;
      });
    const stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((_chunk, callbackOrEncoding?, callback?) => {
        const done =
          typeof callbackOrEncoding === 'function'
            ? callbackOrEncoding
            : typeof callback === 'function'
              ? callback
              : undefined;
        done?.();
        order.push('stderr-flushed');
        return true;
      });

    try {
      await expect(launchPrintMode(printRuntime, '/exit', { outputFormat: 'json' })).rejects.toBe(
        shutdownError
      );
      expect(order).toEqual([
        'controller-stop',
        'runtime-shutdown',
        'stdout-flushed',
        'stderr-flushed',
      ]);
      expect(JSON.parse(stdout.join(''))).toEqual(
        expect.objectContaining({ goalEvents: [], errors: [] })
      );
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      stopSpy.mockRestore();
    }
  });

  it('drains streamed text and stderr before rethrowing the original shutdown error', async () => {
    const order: string[] = [];
    const shutdownError = new Error('synthetic shutdown failure');
    const stopSpy = jest
      .spyOn(AgentRuntimeController.prototype, 'stopActiveTurn')
      .mockImplementation(async () => {
        order.push('controller-stop');
      });
    const printRuntime = runtime();
    printRuntime.shutdown = jest.fn(async () => {
      order.push('runtime-shutdown');
      throw shutdownError;
    });
    const stdout: string[] = [];
    let stdoutFlushes = 0;
    const stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk, callbackOrEncoding?, callback?) => {
        stdout.push(String(chunk));
        const done =
          typeof callbackOrEncoding === 'function'
            ? callbackOrEncoding
            : typeof callback === 'function'
              ? callback
              : undefined;
        if (done) {
          stdoutFlushes += 1;
          done();
          order.push('stdout-flushed');
        }
        return true;
      });
    const stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((_chunk, callbackOrEncoding?, callback?) => {
        const done =
          typeof callbackOrEncoding === 'function'
            ? callbackOrEncoding
            : typeof callback === 'function'
              ? callback
              : undefined;
        done?.();
        order.push('stderr-flushed');
        return true;
      });

    try {
      await expect(launchPrintMode(printRuntime, '/help', { outputFormat: 'text' })).rejects.toBe(
        shutdownError
      );
      expect(stdout.join('')).toContain('Commands:');
      expect(stdoutFlushes).toBe(1);
      expect(order).toEqual([
        'controller-stop',
        'runtime-shutdown',
        'stdout-flushed',
        'stderr-flushed',
      ]);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      stopSpy.mockRestore();
    }
  });

  it('returns failure JSON when stopping cannot persist the Goal state', async () => {
    const message =
      'Goal continuation deferred but persistence failed: Goal persistence failed (io_error).';
    const stopSpy = jest
      .spyOn(AgentRuntimeController.prototype, 'stopActiveTurn')
      .mockImplementation(async function (this: AgentRuntimeController) {
        (this as any).eventSink.emit({ type: 'status_changed', message });
      });
    const stdout: string[] = [];
    const stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: any, callbackOrEncoding?: any, callback?: any) => {
        stdout.push(String(chunk));
        const done =
          typeof callbackOrEncoding === 'function'
            ? callbackOrEncoding
            : typeof callback === 'function'
              ? callback
              : undefined;
        done?.();
        return true;
      });
    const stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((_chunk: any, callbackOrEncoding?: any, callback?: any) => {
        const done =
          typeof callbackOrEncoding === 'function'
            ? callbackOrEncoding
            : typeof callback === 'function'
              ? callback
              : undefined;
        done?.();
        return true;
      });

    try {
      await expect(launchPrintMode(runtime(), '/exit', { outputFormat: 'json' })).resolves.toBe(1);
      expect(JSON.parse(stdout.join(''))).toEqual(
        expect.objectContaining({ statuses: [message], errors: [message] })
      );
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      stopSpy.mockRestore();
    }
  });

});
