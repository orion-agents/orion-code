import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { debugError } from '../src/utils/debug-log';
import {
  getDiagnosticLogPath,
  getDiagnosticMetrics,
  getRecentDiagnosticEvents,
  runWithDiagnosticTrace,
} from '../src/utils/observability';

describe('structured diagnostics', () => {
  let configDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'orion-observability-'));
    originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
  });

  test('persists redacted JSON diagnostics by default without polluting stderr', () => {
    const stderr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    runWithDiagnosticTrace({ traceId: 'trace-1', sessionId: 'session-1', turnId: 'turn-1' }, () =>
      debugError('auth.test', new Error('apiKey=sk-supersecret123'), '/tmp/project')
    );

    expect(stderr).not.toHaveBeenCalled();
    expect(existsSync(getDiagnosticLogPath())).toBe(true);
    const event = JSON.parse(readFileSync(getDiagnosticLogPath(), 'utf8').trim());
    expect(event).toMatchObject({
      level: 'error',
      scope: 'auth.test',
      traceId: 'trace-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
    });
    expect(event.message).toContain('[REDACTED_SECRET]');
    expect(event.message).not.toContain('sk-supersecret123');
  });

  test('maintains bounded in-memory events and aggregate metrics', () => {
    debugError('storage.test', new Error('failed'));
    expect(getRecentDiagnosticEvents().at(-1)).toMatchObject({ scope: 'storage.test' });
    expect(getDiagnosticMetrics()['diagnostic.error']).toBeGreaterThan(0);
    expect(getDiagnosticMetrics()['diagnostic.scope.storage.test']).toBeGreaterThan(0);
  });
});
