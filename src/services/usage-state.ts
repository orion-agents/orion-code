/**
 * Durable runtime usage accounting.
 *
 * Aggregate compatibility counters remain in usage.json. New model calls are
 * written to an append-only JSONL ledger so totals survive sessions and can be
 * audited or rebuilt after an interrupted write.
 */

import { appendFileSync, existsSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { atomicWriteFileSync } from './atomic-write';
import {
  ensureConfigDir,
  getGlobalConfigPath,
  getUsageLedgerPath,
  getUsageStatePath,
} from './config-dir';
import type { CostSource, UsageRecord } from '../core/cost-tracker';

export interface UsageState {
  schemaVersion: 2;
  totalSessions: number;
  totalTokens: number;
  totalCost: number;
  providerCost: number;
  estimatedCost: number;
  usageRecords: number;
  updatedAt: string;
  /** Counters predating the ledger, retained without double-counting. */
  baselineTokens: number;
  baselineCost: number;
}

export interface UsageLedgerEntry {
  schemaVersion: 1;
  id: string;
  timestamp: string;
  sessionId?: string;
  projectPath?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  totalTokens: number;
  costUsd: number;
  costSource: CostSource;
  requestId?: string;
  requestKind?: string;
  agentId?: string;
  taskId?: string;
}

export interface UsageLedgerSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalCost: number;
  providerCost: number;
  estimatedCost: number;
  recordCount: number;
  bySource: Record<CostSource, { cost: number; count: number }>;
  byModel: Record<string, { tokens: number; cost: number; count: number }>;
}

interface LegacyUsageFields {
  totalSessions?: unknown;
  totalTokens?: unknown;
  totalCost?: unknown;
}

interface StoredUsageState extends LegacyUsageFields {
  schemaVersion?: unknown;
  baselineTokens?: unknown;
  baselineCost?: unknown;
  updatedAt?: unknown;
}

const USAGE_SCHEMA_VERSION = 2 as const;

function nowIso(): string {
  return new Date().toISOString();
}

function toNonNegativeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

function readJsonFile(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function hasLegacyUsageFields(value: unknown): value is LegacyUsageFields {
  if (!value || typeof value !== 'object') return false;
  const record = value as LegacyUsageFields;
  return (
    record.totalSessions !== undefined
    || record.totalTokens !== undefined
    || record.totalCost !== undefined
  );
}

function emptyLedgerSummary(): UsageLedgerSummary {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    providerCost: 0,
    estimatedCost: 0,
    recordCount: 0,
    bySource: {
      provider: { cost: 0, count: 0 },
      configured: { cost: 0, count: 0 },
      builtin: { cost: 0, count: 0 },
      fallback: { cost: 0, count: 0 },
    },
    byModel: {},
  };
}

function isCostSource(value: unknown): value is CostSource {
  return value === 'provider'
    || value === 'configured'
    || value === 'builtin'
    || value === 'fallback';
}

function normalizeLedgerEntry(value: unknown): UsageLedgerEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<UsageLedgerEntry>;
  if (typeof entry.model !== 'string' || !isCostSource(entry.costSource)) return null;

  return {
    schemaVersion: 1,
    id: typeof entry.id === 'string' && entry.id ? entry.id : randomUUID(),
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : nowIso(),
    ...(typeof entry.sessionId === 'string' ? { sessionId: entry.sessionId } : {}),
    ...(typeof entry.projectPath === 'string' ? { projectPath: entry.projectPath } : {}),
    model: entry.model,
    promptTokens: toNonNegativeNumber(entry.promptTokens),
    completionTokens: toNonNegativeNumber(entry.completionTokens),
    cachedPromptTokens: toNonNegativeNumber(entry.cachedPromptTokens),
    totalTokens: toNonNegativeNumber(entry.totalTokens),
    costUsd: toNonNegativeNumber(entry.costUsd),
    costSource: entry.costSource,
    ...(typeof entry.requestId === 'string' ? { requestId: entry.requestId } : {}),
    ...(typeof entry.requestKind === 'string' ? { requestKind: entry.requestKind } : {}),
    ...(typeof entry.agentId === 'string' ? { agentId: entry.agentId } : {}),
    ...(typeof entry.taskId === 'string' ? { taskId: entry.taskId } : {}),
  };
}

export function loadUsageLedger(): UsageLedgerEntry[] {
  const path = getUsageLedgerPath();
  if (!existsSync(path)) return [];

  const entries: UsageLedgerEntry[] = [];
  const seen = new Set<string>();
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = normalizeLedgerEntry(JSON.parse(line));
      if (!entry) continue;
      const dedupeKey = entry.requestId || entry.id;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      entries.push(entry);
    } catch {
      // Ignore a corrupt or interrupted trailing line; earlier records remain valid.
    }
  }
  return entries;
}

export function summarizeUsageLedger(entries = loadUsageLedger()): UsageLedgerSummary {
  const summary = emptyLedgerSummary();
  for (const entry of entries) {
    summary.promptTokens += entry.promptTokens;
    summary.completionTokens += entry.completionTokens;
    summary.totalTokens += entry.totalTokens;
    summary.totalCost += entry.costUsd;
    summary.recordCount++;
    summary.bySource[entry.costSource].cost += entry.costUsd;
    summary.bySource[entry.costSource].count++;
    if (entry.costSource === 'provider') summary.providerCost += entry.costUsd;
    else summary.estimatedCost += entry.costUsd;

    if (!summary.byModel[entry.model]) {
      summary.byModel[entry.model] = { tokens: 0, cost: 0, count: 0 };
    }
    summary.byModel[entry.model].tokens += entry.totalTokens;
    summary.byModel[entry.model].cost += entry.costUsd;
    summary.byModel[entry.model].count++;
  }
  return summary;
}

function normalizeStoredUsage(value: unknown): {
  totalSessions: number;
  baselineTokens: number;
  baselineCost: number;
  updatedAt: string;
} {
  if (!value || typeof value !== 'object') {
    return { totalSessions: 0, baselineTokens: 0, baselineCost: 0, updatedAt: nowIso() };
  }
  const parsed = value as StoredUsageState;
  const isV2 = parsed.schemaVersion === USAGE_SCHEMA_VERSION;
  return {
    totalSessions: toNonNegativeNumber(parsed.totalSessions),
    baselineTokens: toNonNegativeNumber(isV2 ? parsed.baselineTokens : parsed.totalTokens),
    baselineCost: toNonNegativeNumber(isV2 ? parsed.baselineCost : parsed.totalCost),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : nowIso(),
  };
}

function buildUsageState(stored: ReturnType<typeof normalizeStoredUsage>): UsageState {
  const ledger = summarizeUsageLedger();
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    totalSessions: stored.totalSessions,
    totalTokens: stored.baselineTokens + ledger.totalTokens,
    totalCost: stored.baselineCost + ledger.totalCost,
    providerCost: ledger.providerCost,
    estimatedCost: stored.baselineCost + ledger.estimatedCost,
    usageRecords: ledger.recordCount,
    updatedAt: stored.updatedAt,
    baselineTokens: stored.baselineTokens,
    baselineCost: stored.baselineCost,
  };
}

function writeUsageState(state: UsageState): void {
  ensureConfigDir();
  atomicWriteFileSync(getUsageStatePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

function stripLegacyUsageFields(): void {
  const path = getGlobalConfigPath();
  const parsed = readJsonFile(path);
  if (!hasLegacyUsageFields(parsed)) return;
  const {
    totalSessions: _totalSessions,
    totalTokens: _totalTokens,
    totalCost: _totalCost,
    ...config
  } = parsed as Record<string, unknown>;
  void _totalSessions;
  void _totalTokens;
  void _totalCost;
  atomicWriteFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function loadUsageState(): UsageState {
  ensureConfigDir();
  const existing = readJsonFile(getUsageStatePath());
  let stored = normalizeStoredUsage(existing);

  if (!existing) {
    const legacy = readJsonFile(getGlobalConfigPath());
    if (hasLegacyUsageFields(legacy)) stored = normalizeStoredUsage(legacy);
  }

  const state = buildUsageState(stored);
  writeUsageState(state);
  stripLegacyUsageFields();
  return state;
}

export function saveUsageState(state: UsageState): void {
  const normalized = buildUsageState({
    totalSessions: toNonNegativeNumber(state.totalSessions),
    baselineTokens: toNonNegativeNumber(state.baselineTokens),
    baselineCost: toNonNegativeNumber(state.baselineCost),
    updatedAt: nowIso(),
  });
  writeUsageState(normalized);
}

export function updateUsageState(
  updates: Partial<Omit<UsageState, 'schemaVersion'>>,
): UsageState {
  const current = loadUsageState();
  const next = buildUsageState({
    totalSessions: toNonNegativeNumber(updates.totalSessions ?? current.totalSessions),
    baselineTokens: toNonNegativeNumber(updates.baselineTokens ?? current.baselineTokens),
    baselineCost: toNonNegativeNumber(updates.baselineCost ?? current.baselineCost),
    updatedAt: nowIso(),
  });
  writeUsageState(next);
  return next;
}

export function incrementSessionCount(): void {
  const state = loadUsageState();
  updateUsageState({ totalSessions: state.totalSessions + 1 });
}

/** Compatibility API: adds non-ledger counters to the pre-ledger baseline. */
export function updateTokenStats(tokens: number, cost: number): void {
  const state = loadUsageState();
  updateUsageState({
    baselineTokens: state.baselineTokens + Math.max(0, tokens),
    baselineCost: state.baselineCost + Math.max(0, cost),
  });
}

export function appendUsageRecord(
  record: UsageRecord,
  context: { sessionId?: string; projectPath?: string } = {},
): UsageLedgerEntry {
  ensureConfigDir();
  const entry: UsageLedgerEntry = {
    schemaVersion: 1,
    id: randomUUID(),
    timestamp: record.timestamp.toISOString(),
    ...context,
    model: record.model,
    promptTokens: record.promptTokens,
    completionTokens: record.completionTokens,
    cachedPromptTokens: record.cachedPromptTokens,
    totalTokens: record.totalTokens,
    costUsd: record.costUsd,
    costSource: record.costSource,
    ...(record.requestId ? { requestId: record.requestId } : {}),
    ...(record.requestKind ? { requestKind: record.requestKind } : {}),
    ...(record.agentId ? { agentId: record.agentId } : {}),
    ...(record.taskId ? { taskId: record.taskId } : {}),
  };
  appendFileSync(getUsageLedgerPath(), `${JSON.stringify(entry)}\n`, { encoding: 'utf-8', mode: 0o600 });
  return entry;
}
