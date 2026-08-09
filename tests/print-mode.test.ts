import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { Store } from '../src/framework/store';
import { launchPrintMode, PrintEventSink } from '../src/print-ui/launch';
import { AgentRuntimeController } from '../src/runtime/agent-runtime-controller';
import { loadConfig } from '../src/services/config';
import { loadGoal } from '../src/services/goal-storage';
import type { OrionCodeUiRuntime } from '../src/runtime/ui-events';
import { appendSessionMessage, createSession } from '../src/services/session-storage';
import { TOOLS } from '../src/tools';
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
  const smokeScript = join(__dirname, '..', 'scripts', 'print-mode-smoke.py');
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
      runtime: {} as OrionCodeUiRuntime['runtime'],
      isConfigured: true,
      ensureSession: jest.fn(),
      setSession: jest.fn(),
      getSession: jest.fn(() => null),
      shutdown: jest.fn(),
    };
  }

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

  it('pauses an active Goal, invalidates continuation, emits JSON evidence, and exits', async () => {
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    const root = mkdtempSync(join(tmpdir(), 'orion-code-print-goal-stop-'));
    const projectDir = join(root, 'project');
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');

    const session = createSession(projectDir, 'test-model');
    const config = loadConfig({ apiKey: 'test-key', model: 'test-model' });
    const store = new Store({ config, tools: TOOLS, currentModel: 'test-model' });
    const chatStream = jest.fn(async () => ({
      content: 'The first bounded print turn completed.',
      model: 'test-model',
      usage: { promptTokens: 7, completionTokens: 3 },
    }));
    const printRuntime: OrionCodeUiRuntime = {
      cwd: projectDir,
      version: 'test',
      config,
      store,
      llm: {
        getModel: jest.fn(() => 'test-model'),
        chatStream,
      } as unknown as OrionCodeUiRuntime['llm'],
      runtime: {} as OrionCodeUiRuntime['runtime'],
      isConfigured: true,
      getSession: jest.fn(() => session),
      ensureSession: jest.fn(() => session),
      setSession: jest.fn(),
      shutdown: jest.fn(),
    };
    const shutdown = jest.fn(async () => undefined);
    printRuntime.shutdown = shutdown;

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
      const exitCode = await launchPrintMode(printRuntime, '/target verify print termination', {
        outputFormat: 'json',
      });
      const result = JSON.parse(stdout.join(''));
      const stored = loadGoal(projectDir, session.id);
      const providerCallsAtExit = chatStream.mock.calls.length;
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(exitCode).toBe(0);
      expect(result.entries.filter((entry: { role: string }) => entry.role === 'error')).toEqual(
        []
      );
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(providerCallsAtExit).toBeGreaterThan(0);
      expect(chatStream).toHaveBeenCalledTimes(providerCallsAtExit);
      expect(result.goalEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'goal_updated',
            goal: expect.objectContaining({ status: 'active' }),
            reason: 'target_create',
          }),
          expect.objectContaining({
            type: 'goal_continuation',
            phase: 'deferred',
            reason: 'runtime stopping',
          }),
        ])
      );
      expect(result.goalEvents.at(-1)).toEqual(
        expect.objectContaining({
          type: 'goal_continuation',
          phase: 'deferred',
          reason: 'runtime stopping',
        })
      );
      expect(stored.ok).toBe(true);
      if (!stored.ok) throw new Error(stored.message);
      expect(stored.value).toEqual(
        expect.objectContaining({
          status: 'paused',
          continuationCount: 1,
          stopReason: expect.objectContaining({
            kind: 'user',
            message: 'Paused by interrupt.',
          }),
        })
      );
      expect(stored.value.tokensUsed).toBeGreaterThan(0);
      expect(stored.value.tokensUsed).toBe(stored.value.lastTurn?.totalTokens);
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
});
