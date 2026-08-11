import { execFile } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { loadSessionIndex, updateSessionIndex } from '../src/services/session-index';
import { getProjectSessionsDir } from '../src/services/config-dir';
import {
  createSession,
  loadSessionMeta,
  readSessionMessages,
} from '../src/services/session-storage';
import { loadUsageState } from '../src/services/usage-state';

const execFileAsync = promisify(execFile);

describe('cross-process persistence coordination', () => {
  let configDir: string;
  let projectPath: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'orion-persistence-config-'));
    projectPath = mkdtempSync(join(tmpdir(), 'orion-persistence-project-'));
    originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
    if (originalConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
  });

  function runWorker(source: string): Promise<unknown> {
    return execFileAsync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', '-e', source],
      {
        cwd: process.cwd(),
        env: { ...process.env, ORION_CODE_CONFIG_DIR: configDir },
      }
    );
  }

  test('keeps usage increments monotone across processes', async () => {
    await Promise.all(
      Array.from({ length: 4 }, () =>
        runWorker(
          `const { incrementSessionCount } = require('./src/services/usage-state'); for (let i = 0; i < 15; i++) incrementSessionCount();`
        )
      )
    );
    expect(loadUsageState().totalSessions).toBe(60);
  });

  test('keeps every session-index tool update across processes', async () => {
    const project = JSON.stringify(projectPath);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        runWorker(
          `const { updateSessionIndex } = require('./src/services/session-index'); for (let i = 0; i < 10; i++) updateSessionIndex('shared', ${project}, { role: 'assistant', tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"shared.ts"}' } }] });`
        )
      )
    );
    expect(loadSessionIndex('shared', projectPath)).toMatchObject({
      tools: { read_file: 40 },
      files: ['shared.ts'],
    });
  });

  test('keeps transcript and metadata counters consistent across processes', async () => {
    const session = createSession(projectPath, 'test-model');
    const sessionId = JSON.stringify(session.id);
    const workers = 4;
    const operationsPerWorker = 6;

    await Promise.all(
      Array.from({ length: workers }, (_, worker) =>
        runWorker(
          `const { appendSessionMessage, updateSessionStats } = require('./src/services/session-storage'); ` +
            `for (let i = 0; i < ${operationsPerWorker}; i++) { ` +
            `appendSessionMessage(${sessionId}, { role: 'user', content: 'worker-${worker}-' + i, timestamp: i }); ` +
            `updateSessionStats(${sessionId}, 1, 0.01); }`
        )
      )
    );

    const expected = workers * operationsPerWorker;
    expect(readSessionMessages(session.id)).toHaveLength(expected);
    const meta = loadSessionMeta(session.id);
    expect(meta).toMatchObject({
      messageCount: expected,
      tokenCount: expected,
    });
    expect(meta?.cost).toBeCloseTo(expected * 0.01, 8);
  }, 20_000);

  test('rebuilds a structurally corrupt session index on the next update', () => {
    const sessionsDir = getProjectSessionsDir(projectPath);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'corrupt.index.json'), '{"sessionId":"corrupt"}');

    updateSessionIndex('corrupt', projectPath, { role: 'user', content: 'recovered topic' });

    expect(loadSessionIndex('corrupt', projectPath)).toMatchObject({
      sessionId: 'corrupt',
      topics: ['recovered topic'],
      files: [],
      tools: {},
    });
  });

  test('skips a malformed candidate and loads the next matching session', () => {
    const firstDir = join(configDir, 'projects', 'a', 'sessions');
    const secondDir = join(configDir, 'projects', 'b', 'sessions');
    mkdirSync(firstDir, { recursive: true });
    mkdirSync(secondDir, { recursive: true });
    writeFileSync(
      join(firstDir, 'same.json'),
      JSON.stringify({ id: 'same', projectPath: projectPath, startTime: 'invalid' })
    );
    writeFileSync(
      join(secondDir, 'same.json'),
      JSON.stringify({ id: 'same', projectPath, startTime: 123, model: 'test-model' })
    );

    const loaded = loadSessionMeta('same');
    expect(loaded).toMatchObject({ id: 'same', model: 'test-model', startTime: 123 });
  });

  test('does not leave lock files after successful updates', async () => {
    await runWorker(
      `const { incrementSessionCount } = require('./src/services/usage-state'); incrementSessionCount();`
    );
    expect(existsSync(join(configDir, 'usage.json.lock'))).toBe(false);
  });
});
