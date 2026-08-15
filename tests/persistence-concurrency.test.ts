import { execFile } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
import {
  loadUsageLedger,
  loadUsageState,
  summarizeUsageLedger,
  UsageLedgerPersistenceError,
} from '../src/services/usage-state';
import { getUsageLedgerPath } from '../src/services/config-dir';

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

  test('serializes the usage JSONL ledger with its own cross-process lock', async () => {
    const marker = join(configDir, 'ledger-lock-held');
    const holder = runWorker(
      `const { mkdirSync, writeFileSync } = require('fs'); ` +
        `const { dirname } = require('path'); ` +
        `const { getUsageLedgerPath } = require('./src/services/config-dir'); ` +
        `const { withFileLockSync } = require('./src/services/file-lock'); ` +
        `const ledger = getUsageLedgerPath(); mkdirSync(dirname(ledger), { recursive: true }); ` +
        `withFileLockSync(ledger, () => { ` +
        `writeFileSync(${JSON.stringify(marker)}, 'held'); ` +
        `const until = Date.now() + 1500; while (Date.now() < until) {} });`
    );
    const deadline = Date.now() + 5_000;
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(existsSync(marker)).toBe(true);

    const startedAt = Date.now();
    await runWorker(
      `const { appendUsageRecord } = require('./src/services/usage-state'); ` +
        `appendUsageRecord({ timestamp: new Date(), model: 'locked-model', ` +
        `promptTokens: 1, completionTokens: 1, cachedPromptTokens: 0, totalTokens: 2, ` +
        `costUsd: 0, costSource: 'fallback', requestId: 'locked-request' });`
    );
    const elapsed = Date.now() - startedAt;
    await holder;

    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(loadUsageLedger()).toHaveLength(1);
  }, 20_000);

  test('preserves every complete JSONL record from concurrent writer processes', async () => {
    const workers = 4;
    const recordsPerWorker = 20;
    await Promise.all(
      Array.from({ length: workers }, (_, worker) =>
        runWorker(
          `const { appendUsageRecord } = require('./src/services/usage-state'); ` +
            `for (let i = 0; i < ${recordsPerWorker}; i++) appendUsageRecord({ ` +
            `timestamp: new Date(), model: 'worker-${worker}', promptTokens: 1, ` +
            `completionTokens: 1, cachedPromptTokens: 0, totalTokens: 2, costUsd: 0, ` +
            `costSource: 'fallback', requestId: 'worker-${worker}-' + i });`
        )
      )
    );

    const expected = workers * recordsPerWorker;
    const rawLines = readFileSync(getUsageLedgerPath(), 'utf8').trimEnd().split('\n');
    expect(rawLines).toHaveLength(expected);
    expect(rawLines.map(line => JSON.parse(line))).toHaveLength(expected);
    expect(loadUsageLedger()).toHaveLength(expected);
    expect(summarizeUsageLedger()).toMatchObject({
      recordCount: expected,
      totalTokens: expected * 2,
    });
  }, 20_000);

  test('returns a typed actionable error when the usage-ledger lock times out', async () => {
    const marker = join(configDir, 'ledger-timeout-lock-held');
    const holder = runWorker(
      `const { mkdirSync, writeFileSync } = require('fs'); ` +
        `const { dirname } = require('path'); ` +
        `const { getUsageLedgerPath } = require('./src/services/config-dir'); ` +
        `const { withFileLockSync } = require('./src/services/file-lock'); ` +
        `const ledger = getUsageLedgerPath(); mkdirSync(dirname(ledger), { recursive: true }); ` +
        `withFileLockSync(ledger, () => { writeFileSync(${JSON.stringify(marker)}, 'held'); ` +
        `const until = Date.now() + 3000; while (Date.now() < until) {} });`
    );
    const deadline = Date.now() + 5_000;
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(existsSync(marker)).toBe(true);

    let failure: unknown;
    try {
      await runWorker(
        `const { appendUsageRecord } = require('./src/services/usage-state'); ` +
          `try { appendUsageRecord({ timestamp: new Date(), model: 'timeout-model', ` +
          `promptTokens: 1, completionTokens: 1, cachedPromptTokens: 0, totalTokens: 2, ` +
          `costUsd: 0, costSource: 'fallback', requestId: 'timeout-record' }); } ` +
          `catch (error) { process.stdout.write(JSON.stringify({ name: error.name, code: error.code, ` +
          `action: error.action, message: error.message })); }`
      ).then(result => {
        failure = JSON.parse((result as { stdout: string }).stdout);
      });
    } finally {
      await holder;
    }

    expect(failure).toMatchObject<Partial<UsageLedgerPersistenceError>>({
      name: 'UsageLedgerPersistenceError',
      code: 'lock_timeout',
      action: expect.stringContaining('Retry'),
    });
    expect(loadUsageLedger()).toEqual([]);
  }, 20_000);

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
