import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { launchPrintMode, PrintEventSink } from '../src/print-ui/launch';
import type { OpenHorseUiRuntime } from '../src/runtime/ui-events';
import { appendSessionMessage, createSession } from '../src/services/session-storage';
import { makeToolStartedEvent, makeToolFinishedEvent, resetToolEventSequence } from './test-helpers';

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
  const maybeIt = python && existsSync(smokeScript) && process.platform !== 'win32' ? it : it.skip;

  maybeIt('runs text, json, and piped stdin prompts without interactive UI', () => {
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
  }, 65000);
});

describe('print mode event sink', () => {
  beforeEach(() => resetToolEventSequence());

  function runtime(cwd = '/tmp/openhorse'): OpenHorseUiRuntime {
    return {
      cwd,
      version: 'test',
      config: { model: 'test-model' } as OpenHorseUiRuntime['config'],
      store: {
        getSnapshot: () => ({ currentModel: 'test-model' }),
        setProcessing: jest.fn(),
      } as unknown as OpenHorseUiRuntime['store'],
      llm: null,
      runtime: {} as OpenHorseUiRuntime['runtime'],
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
    sink.toolStarted(makeToolStartedEvent({ callId: 'call-1', name: 'read_file', args: { path: 'src/index.ts' } }));
    sink.toolFinished(makeToolFinishedEvent({
      callId: 'call-1',
      name: 'read_file',
      args: { path: 'src/index.ts' },
      success: true,
      duration: 12,
      summary: 'read ok',
    }));

    expect(sink.result()).toEqual(expect.objectContaining({
      content: 'answer',
      toolEvents: [
        { type: 'started', callId: 'call-1', name: 'read_file', args: { path: 'src/index.ts' }, sequence: 1 },
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
    }));
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
    expect(sink.result()).toEqual(expect.objectContaining({
      errors: [
        'Tool exec_command requires confirmation, but print mode is non-interactive. publishing changes external state',
      ],
    }));
  });

  it('uses non-interactive renderer capabilities for resume fallback', async () => {
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    const root = mkdtempSync(join(tmpdir(), 'orion-code-print-mode-'));
    const projectDir = join(root, 'project');
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');

    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout.push(String(chunk));
      return true;
    });
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      stderr.push(String(chunk));
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

      const exitCode = await launchPrintMode(runtime(projectDir), '/resume', { outputFormat: 'json' });
      const result = JSON.parse(stdout.join(''));

      expect(exitCode).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.content).toContain('Use /resume <number|session-id|name>');
      expect(result.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          title: '/resume',
          content: expect.stringContaining('Pick a Session'),
        }),
      ]));
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
});
