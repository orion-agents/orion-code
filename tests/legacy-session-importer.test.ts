import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import {
  createDeterministicLegacyRuntimeId,
  importLegacySessionV1,
  verifyLegacySessionImportReceiptV1,
} from '../src/runtime/legacy-session-importer';
import {
  getProjectSessionCompactPath,
  getProjectSessionGoalPath,
  getProjectSessionHarnessPath,
  getProjectSessionMessagesPath,
  getProjectSessionMetaPath,
  getProjectSessionTracePath,
  getProjectSessionsDir,
} from '../src/product/paths';

describe('legacy Session to v2 Thread import staging', () => {
  let root: string;
  let projectPath: string;
  let outputDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-legacy-import-'));
    projectPath = join(root, 'project');
    outputDir = join(root, 'thread-v2');
    mkdirSync(projectPath, { recursive: true });
    previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
    rmSync(root, { recursive: true, force: true });
  });

  test('dry-run is deterministic and performs no output write', () => {
    const sessionId = 'legacy-session-1';
    writeLegacySession(sessionId);

    const first = importLegacySessionV1({ projectPath, sessionId, outputDir, dryRun: true });
    const second = importLegacySessionV1({ projectPath, sessionId, outputDir, dryRun: true });

    expect(first.mode).toBe('dry_run');
    expect(first.receipt).toEqual(second.receipt);
    expect(existsSync(outputDir)).toBe(false);
    expect(verifyLegacySessionImportReceiptV1(first.receipt)).toBe(true);
    expect(first.receipt.threadId).toBe(
      createDeterministicLegacyRuntimeId('legacy-thread', resolve(projectPath), sessionId)
    );
    expect(first.receipt.recordMappings.map(mapping => mapping.targetKind)).toEqual(
      expect.arrayContaining([
        'thread',
        'item',
        'event',
        'harness_snapshot',
        'compact_checkpoint',
        'task_context',
      ])
    );
    expect(first.receipt.disposition).toBe('ready');
  });

  test('atomically stages one side-by-side receipt and is idempotent', () => {
    const sessionId = '30000000-0000-4000-8000-000000000001';
    writeLegacySession(sessionId);
    const boundaries: string[] = [];

    const staged = importLegacySessionV1({
      projectPath,
      sessionId,
      outputDir,
      onBoundary: boundary => boundaries.push(boundary),
    });
    expect(staged.mode).toBe('staged');
    expect(staged.receipt.threadId).toBe(sessionId);
    expect(boundaries).toEqual(['before_receipt_write', 'after_receipt_write']);
    expect(JSON.parse(readFileSync(staged.receiptPath, 'utf8'))).toEqual(staged.receipt);

    const repeated = importLegacySessionV1({ projectPath, sessionId, outputDir });
    expect(repeated.mode).toBe('already_staged');
    expect(repeated.receipt).toEqual(staged.receipt);
  });

  test('refuses to overwrite a receipt after the legacy source changes', () => {
    const sessionId = 'legacy-conflict';
    writeLegacySession(sessionId);
    importLegacySessionV1({ projectPath, sessionId, outputDir });
    writeFileSync(
      getProjectSessionMessagesPath(projectPath, sessionId),
      `${JSON.stringify({ role: 'user', content: 'changed', timestamp: 10 })}\n`,
      'utf8'
    );

    expect(() => importLegacySessionV1({ projectPath, sessionId, outputDir })).toThrow(
      'different import receipt'
    );
  });

  test('retains malformed lines and incomplete tool groups as indeterminate warnings', () => {
    const sessionId = 'legacy-indeterminate';
    writeLegacySession(sessionId);
    writeFileSync(
      getProjectSessionMessagesPath(projectPath, sessionId),
      [
        JSON.stringify({ role: 'user', content: 'run', timestamp: 1 }),
        JSON.stringify({
          role: 'assistant',
          content: '',
          timestamp: 2,
          tool_calls: [
            {
              id: 'call-unfinished',
              type: 'function',
              function: { name: 'exec_command', arguments: '{}' },
            },
          ],
        }),
        '{broken',
        '',
      ].join('\n'),
      'utf8'
    );

    const result = importLegacySessionV1({ projectPath, sessionId, outputDir, dryRun: true });
    expect(result.receipt.disposition).toBe('requires_review');
    expect(result.receipt.warnings.map(warning => warning.code)).toEqual(
      expect.arrayContaining(['malformed_jsonl_line', 'missing_tool_result'])
    );
    expect(result.receipt.recordMappings).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'indeterminate' })])
    );
  });

  test('rejects path traversal before reading legacy storage', () => {
    expect(() =>
      importLegacySessionV1({
        projectPath,
        sessionId: '../escape',
        outputDir,
        dryRun: true,
      })
    ).toThrow('path-safe');
  });

  function writeLegacySession(sessionId: string): void {
    mkdirSync(getProjectSessionsDir(projectPath), { recursive: true });
    writeFileSync(
      getProjectSessionMetaPath(projectPath, sessionId),
      JSON.stringify({
        id: sessionId,
        projectPath: resolve(projectPath),
        model: 'test-model',
        startTime: 100,
        updatedAt: 200,
        tokenCount: 0,
        cost: 0,
      }),
      'utf8'
    );
    writeFileSync(
      getProjectSessionMessagesPath(projectPath, sessionId),
      [
        JSON.stringify({ role: 'user', content: 'hello', timestamp: 101 }),
        JSON.stringify({ role: 'assistant', content: 'done', timestamp: 102 }),
        '',
      ].join('\n'),
      'utf8'
    );
    writeFileSync(
      getProjectSessionTracePath(projectPath, sessionId),
      `${JSON.stringify({
        sessionId,
        turnId: '1',
        timestamp: 101,
        type: 'turn_start',
      })}\n`,
      'utf8'
    );
    writeFileSync(getProjectSessionHarnessPath(projectPath, sessionId), '{"version":1}', 'utf8');
    writeFileSync(
      getProjectSessionCompactPath(projectPath, sessionId),
      '{"version":1,"checkpointId":"legacy-checkpoint"}',
      'utf8'
    );
    writeFileSync(
      getProjectSessionGoalPath(projectPath, sessionId),
      '{"version":1,"goalId":"legacy-goal"}',
      'utf8'
    );
  }
});
