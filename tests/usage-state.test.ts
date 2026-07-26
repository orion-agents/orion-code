import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CostTracker } from '../src/core/cost-tracker';
import {
  appendUsageRecord,
  loadUsageState,
  summarizeUsageLedger,
} from '../src/services/usage-state';

describe('durable usage ledger', () => {
  let configDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), 'openhorse-usage-'));
    process.env.ORION_CODE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
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
      { model: 'routed-model' },
    );

    const second = new CostTracker({
      pricing: { 'custom-model': { input: 2, output: 8 } },
      onRecord: persist,
    });
    second.record(
      { promptTokens: 1_000, completionTokens: 500, requestId: 'estimated-request' },
      { model: 'custom-model' },
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
      { model: 'provider-model' },
    );
    appendUsageRecord(record);
    appendUsageRecord(record);

    const summary = summarizeUsageLedger();
    expect(summary.recordCount).toBe(1);
    expect(summary.totalTokens).toBe(15);
    expect(summary.totalCost).toBeCloseTo(0.001);
  });
});
