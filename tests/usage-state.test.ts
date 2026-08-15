import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CostTracker } from '../src/core/cost-tracker';
import {
  appendUsageRecord,
  loadUsageLedger,
  loadUsageState,
  summarizeUsageLedger,
  UsageLedgerPersistenceError,
} from '../src/services/usage-state';

const fsModule = jest.requireActual<typeof import('fs')>('fs');

describe('durable usage ledger', () => {
  let configDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), 'openhorse-usage-'));
    process.env.ORION_CODE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
  });

  test('persists provider and estimated cost across tracker instances', () => {
    const persist = (record: Parameters<typeof appendUsageRecord>[0]) => {
      appendUsageRecord(record, { sessionId: 'session-a', projectPath: '/project' });
    };
    const first = new CostTracker({ onRecord: persist });
    first.record(
      {
        promptTokens: 100,
        completionTokens: 20,
        costUsd: 0.0042,
        requestId: 'provider-request',
      },
      { model: 'routed-model' }
    );

    const second = new CostTracker({
      pricing: { 'custom-model': { input: 2, output: 8 } },
      onRecord: persist,
    });
    second.record(
      { promptTokens: 1_000, completionTokens: 500, requestId: 'estimated-request' },
      { model: 'custom-model' }
    );

    const state = loadUsageState();
    const summary = summarizeUsageLedger();
    expect(state.usageRecords).toBe(2);
    expect(state.totalTokens).toBe(1_620);
    expect(state.providerCost).toBeCloseTo(0.0042);
    expect(state.estimatedCost).toBeCloseTo(0.006);
    expect(state.totalCost).toBeCloseTo(0.0102);
    expect(summary.bySource.provider.count).toBe(1);
    expect(summary.bySource.configured.count).toBe(1);
  });

  test('deduplicates repeated provider request ids while reading the ledger', () => {
    const tracker = new CostTracker();
    const record = tracker.record(
      { promptTokens: 10, completionTokens: 5, costUsd: 0.001, requestId: 'same-id' },
      { model: 'provider-model' }
    );
    appendUsageRecord(record);
    appendUsageRecord(record);

    const summary = summarizeUsageLedger();
    expect(summary.recordCount).toBe(1);
    expect(summary.totalTokens).toBe(15);
    expect(summary.totalCost).toBeCloseTo(0.001);
  });

  test('does not rewrite derived usage state during a read', () => {
    const usagePath = join(configDir, 'usage.json');
    expect(existsSync(usagePath)).toBe(false);
    expect(loadUsageState().totalTokens).toBe(0);
    expect(existsSync(usagePath)).toBe(false);
  });

  test('reports corrupt ledger lines while preserving valid records', () => {
    const tracker = new CostTracker();
    appendUsageRecord(
      tracker.record(
        { promptTokens: 3, completionTokens: 2, requestId: 'valid-request' },
        { model: 'valid-model' }
      )
    );
    appendFileSync(join(configDir, 'cost', 'usage-ledger.jsonl'), '{broken-json\n');

    const summary = summarizeUsageLedger();
    expect(summary.recordCount).toBe(1);
    expect(summary.droppedCorruptLines).toBe(1);
  });

  test('persists additive effort metadata while keeping reasoning tokens inside completion totals', () => {
    const tracker = new CostTracker();
    const entry = appendUsageRecord(
      tracker.record(
        {
          promptTokens: 50,
          completionTokens: 30,
          reasoningTokens: 12,
          effortRequested: 'high',
          effortEffective: 'high',
          effortSource: 'project',
          providerProtocol: 'openai-completions',
          requestId: 'reasoning-request',
        },
        { model: 'reasoning-model' }
      )
    );

    expect(entry.reasoningTokens).toBe(12);
    expect(entry.effortRequested).toBe('high');
    expect(entry.effortEffective).toBe('high');
    expect(entry.effortSource).toBe('project');
    expect(entry.providerProtocol).toBe('openai-completions');

    const summary = summarizeUsageLedger();
    expect(summary.reasoningTokens).toBe(12);
    expect(summary.completionTokens).toBe(30);
    expect(summary.totalTokens).toBe(80);
  });

  test.each([
    ['negative prompt tokens', { promptTokens: -1 }],
    ['NaN completion tokens', { completionTokens: Number.NaN }],
    ['infinite total tokens', { totalTokens: Number.POSITIVE_INFINITY }],
    ['fractional cached tokens', { cachedPromptTokens: 0.5 }],
    ['cached tokens above prompt tokens', { cachedPromptTokens: 3 }],
    ['mismatched total tokens', { totalTokens: 4 }],
    ['negative reasoning tokens', { reasoningTokens: -1 }],
    ['reasoning tokens above completion tokens', { reasoningTokens: 2 }],
    ['infinite cost', { costUsd: Number.POSITIVE_INFINITY }],
  ])('fails closed before writing an invalid record: %s', (_label, change) => {
    const record = {
      timestamp: new Date(),
      model: 'validation-model',
      promptTokens: 2,
      completionTokens: 1,
      cachedPromptTokens: 0,
      totalTokens: 3,
      costUsd: 0,
      costSource: 'fallback' as const,
      estimatedCost: 0,
      requestId: 'invalid-record',
      ...change,
    };

    expect(() => appendUsageRecord(record)).toThrow(
      expect.objectContaining<Partial<UsageLedgerPersistenceError>>({
        name: 'UsageLedgerPersistenceError',
        code: 'invalid_record',
      })
    );
    expect(loadUsageLedger()).toEqual([]);
  });

  test('rejects invalid persisted numeric fields instead of normalizing them to zero', () => {
    const ledgerPath = join(configDir, 'cost', 'usage-ledger.jsonl');
    appendUsageRecord({
      timestamp: new Date(),
      model: 'valid-model',
      promptTokens: 2,
      completionTokens: 1,
      cachedPromptTokens: 0,
      totalTokens: 3,
      costUsd: 0,
      costSource: 'fallback',
      estimatedCost: 0,
      requestId: 'valid-record',
    });
    appendFileSync(
      ledgerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        id: 'invalid-negative',
        timestamp: new Date().toISOString(),
        model: 'invalid-model',
        promptTokens: -1,
        completionTokens: 1,
        cachedPromptTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        costSource: 'fallback',
      })}\n`
    );

    expect(loadUsageLedger()).toHaveLength(1);
    expect(summarizeUsageLedger()).toMatchObject({ recordCount: 1, droppedCorruptLines: 1 });
  });

  test('fsyncs one newline-terminated JSON object before reporting append success', () => {
    const fsync = jest.spyOn(fsModule, 'fsyncSync');

    appendUsageRecord({
      timestamp: new Date(),
      model: 'durable-model',
      promptTokens: 2,
      completionTokens: 1,
      cachedPromptTokens: 0,
      totalTokens: 3,
      costUsd: 0,
      costSource: 'fallback',
      estimatedCost: 0,
      requestId: 'durable-record',
    });

    const raw = readFileSync(join(configDir, 'cost', 'usage-ledger.jsonl'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(raw)).toMatchObject({ requestId: 'durable-record', totalTokens: 3 });
    expect(fsync).toHaveBeenCalledTimes(1);
  });

  test('fails closed with uncertain durability when fsync fails after append', () => {
    jest.spyOn(fsModule, 'fsyncSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('simulated fsync failure'), { code: 'EIO' });
    });

    expect(() =>
      appendUsageRecord({
        timestamp: new Date(),
        model: 'durability-failure-model',
        promptTokens: 2,
        completionTokens: 1,
        cachedPromptTokens: 0,
        totalTokens: 3,
        costUsd: 0,
        costSource: 'fallback',
        estimatedCost: 0,
        requestId: 'uncertain-durability-record',
      })
    ).toThrow(
      expect.objectContaining<Partial<UsageLedgerPersistenceError>>({
        code: 'durability_failed',
        action: expect.stringContaining('same request ID'),
      })
    );
  });
});
