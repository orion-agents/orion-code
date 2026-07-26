import type {
  ContextLedgerEntry,
  EvidenceKind,
  EvidenceRecord,
  RankedEvidenceRecord,
  TurnSummary,
} from './types';
import { estimateTokens as estimateTokensImpl } from '../utils/token-estimate';

export function estimateTokens(text: string): number {
  return Math.max(1, estimateTokensImpl(text));
}

function compact(text: string, max = 700): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? normalized.slice(0, max - 3) + '...' : normalized;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function ledgerKind(type: ContextLedgerEntry['type']): EvidenceKind {
  switch (type) {
    case 'user_requirement':
      return 'requirement';
    case 'test_result':
    case 'verification':
      return 'verification';
    case 'skill':
      return 'skill';
    case 'risk':
    case 'blocker':
      return 'risk';
    case 'todo':
      return 'todo';
    case 'file_fact':
      return 'file_fact';
    case 'decision':
      return 'decision';
    default:
      return 'tool_result';
  }
}

function tokenize(text: string): Set<string> {
  const lower = text.toLowerCase();
  const ascii = lower.match(/[a-z0-9_.-]{2,}/g) ?? [];
  const chinese = lower.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  return new Set([...ascii, ...chinese]);
}

function tagsFor(content: string, extras: string[] = []): string[] {
  return [...new Set([...tokenize(content), ...extras.map(item => item.toLowerCase()).filter(Boolean)])].slice(0, 32);
}

function evidenceFromLedger(entry: ContextLedgerEntry): EvidenceRecord {
  const toolName = asString(entry.metadata?.toolName);
  const path = asString(entry.metadata?.path) || asString(entry.metadata?.changedFile);
  const success = asBool(entry.metadata?.success);
  const kind = ledgerKind(entry.type);
  const verificationStatus = kind === 'verification'
    ? success === true
      ? 'passed'
      : success === false
        ? 'failed'
        : 'unknown'
    : undefined;

  return {
    id: `ledger:${entry.id}`,
    kind,
    content: compact(entry.content),
    source: 'ledger',
    sourceId: entry.id,
    importance: entry.importance,
    createdAt: entry.createdAt,
    tokenEstimate: estimateTokens(entry.content),
    tags: tagsFor(entry.content, [entry.type, entry.source.ref ?? '', toolName ?? '', path ?? '']),
    path,
    toolName,
    verificationStatus,
    metadata: entry.metadata,
  };
}

function evidenceFromTurnSummary(summary: TurnSummary): EvidenceRecord {
  const content = compact([
    `Turn ${summary.turn}: ${summary.userIntent}`,
    summary.assistantOutcome ? `Outcome: ${summary.assistantOutcome}` : '',
    summary.filesTouched.length > 0 ? `Files: ${summary.filesTouched.join(', ')}` : '',
    summary.toolsUsed.length > 0 ? `Tools: ${summary.toolsUsed.join(', ')}` : '',
    summary.verification.passed.length > 0 ? `Passed: ${summary.verification.passed.join('; ')}` : '',
    summary.verification.failed.length > 0 ? `Failed: ${summary.verification.failed.join('; ')}` : '',
    summary.unresolved.length > 0 ? `Unresolved: ${summary.unresolved.join('; ')}` : '',
  ].filter(Boolean).join(' '));

  return {
    id: `turn:${summary.id}`,
    kind: 'turn_summary',
    content,
    source: 'turn_summary',
    sourceId: summary.id,
    importance: summary.unresolved.length > 0 || summary.verification.failed.length > 0 ? 5 : 4,
    taskEpoch: summary.taskEpoch,
    createdAt: summary.createdAt,
    tokenEstimate: estimateTokens(content),
    tags: tagsFor(content, [...summary.filesTouched, ...summary.toolsUsed, summary.intentKind]),
    path: summary.filesTouched[0],
    toolName: summary.toolsUsed[0],
    verificationStatus: summary.verification.failed.length > 0
      ? 'failed'
      : summary.verification.passed.length > 0
        ? 'passed'
        : undefined,
  };
}

export function buildEvidenceIndex(params: {
  ledger?: ContextLedgerEntry[];
  turnSummaries?: TurnSummary[];
  existing?: EvidenceRecord[];
}): EvidenceRecord[] {
  const byId = new Map<string, EvidenceRecord>();
  for (const record of params.existing ?? []) {
    byId.set(record.id, record);
  }
  for (const entry of params.ledger ?? []) {
    const record = evidenceFromLedger(entry);
    // Preserve includedCount from existing record
    const existing = byId.get(record.id);
    if (existing) record.includedCount = existing.includedCount;
    byId.set(record.id, record);
  }
  for (const summary of params.turnSummaries ?? []) {
    const record = evidenceFromTurnSummary(summary);
    const existing = byId.get(record.id);
    if (existing) record.includedCount = existing.includedCount;
    byId.set(record.id, record);
  }
  return [...byId.values()].sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt);
}

/**
 * Bump the includedCount for evidence that was selected into the prompt.
 * Call this after assembleMessages() with the included evidence IDs.
 */
export function bumpIncludedEvidence(
  records: EvidenceRecord[],
  includedIds: string[],
): EvidenceRecord[] {
  const idSet = new Set(includedIds);
  return records.map(r =>
    idSet.has(r.id) ? { ...r, includedCount: (r.includedCount ?? 0) + 1 } : r
  );
}

export function rankEvidence(
  records: EvidenceRecord[],
  params: {
    query?: string;
    taskEpoch?: number;
    activeInstruction?: string;
    rootObjective?: string;
    now?: number;
  } = {},
): RankedEvidenceRecord[] {
  const queryTokens = tokenize([
    params.query ?? '',
    params.activeInstruction ?? '',
    params.rootObjective ?? '',
  ].join(' '));
  const now = params.now ?? Date.now();

  return records.map(record => {
    let score = record.importance * 10;
    const reasons: string[] = [`importance ${record.importance}`];

    if (params.taskEpoch !== undefined && record.taskEpoch === params.taskEpoch) {
      score += 10;
      reasons.push('same task epoch');
    }

    const ageHours = Math.max(0, (now - record.createdAt) / 3_600_000);
    const recency = Math.max(0, 8 - Math.floor(ageHours / 6));
    if (recency > 0) {
      score += recency;
      reasons.push('recent');
    }

    let overlap = 0;
    for (const tag of record.tags) {
      if (queryTokens.has(tag)) overlap++;
    }
    if (overlap > 0) {
      score += overlap * 4;
      reasons.push(`${overlap} keyword match${overlap === 1 ? '' : 'es'}`);
    }

    if (record.path && (params.query ?? '').includes(record.path)) {
      score += 12;
      reasons.push('mentioned path');
    }

    if (record.toolName && (params.query ?? '').toLowerCase().includes(record.toolName.toLowerCase())) {
      score += 8;
      reasons.push('mentioned tool');
    }

    if (record.kind === 'verification') {
      score += record.verificationStatus === 'failed' ? 14 : 10;
      reasons.push('verification evidence');
    }

    if (record.kind === 'risk' || record.kind === 'todo') {
      score += 8;
      reasons.push('open risk or todo');
    }

    // Learning signal: evidence that was frequently included in past prompts
    // gets a small boost — "if it was useful before, it's likely useful again"
    if (record.includedCount && record.includedCount > 0) {
      const boost = Math.min(record.includedCount, 10) * record.importance * 0.5;
      score += boost;
      reasons.push(`included ${record.includedCount}x before`);
    }

    return { ...record, score, reasons };
  }).sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
}
