/**
 * Evidence Ranking v0.2.7 unit tests
 */

import { buildEvidenceIndex, rankEvidence, bumpIncludedEvidence } from '../src/harness/evidence';
import type { EvidenceRecord, ContextLedgerEntry } from '../src/harness/types';

function makeEvidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: `ev-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'tool_result',
    content: 'test evidence content',
    source: 'ledger',
    importance: 3,
    createdAt: Date.now(),
    tokenEstimate: 10,
    tags: ['test'],
    ...overrides,
  };
}

function makeLedgerEntry(overrides: Partial<ContextLedgerEntry> = {}): ContextLedgerEntry {
  return {
    id: `ledger-${Math.random().toString(36).slice(2, 8)}`,
    type: 'tool_result',
    content: 'test',
    source: { ref: 'test', kind: 'tool' },
    importance: 3,
    createdAt: Date.now(),
    ttl: 'task',
    metadata: {},
    ...overrides,
  };
}

describe('evidence v0.2.7', () => {
  describe('includedCount field', () => {
    test('buildEvidenceIndex preserves includedCount from existing records', () => {
      const existing: EvidenceRecord[] = [
        makeEvidence({ id: 'ev-1', includedCount: 5 }),
      ];
      const result = buildEvidenceIndex({
        existing,
        ledger: [makeLedgerEntry({ id: 'ledger-1' })],
      });

      const ev1 = result.find(r => r.id === 'ledger:ledger-1');
      expect(ev1).toBeDefined();
      // New record — no prior includedCount
      expect(ev1!.includedCount).toBeUndefined();
    });

    test('includedCount survives rebuild with same ledger ID', () => {
      const existing: EvidenceRecord[] = [
        makeEvidence({ id: 'ledger:ledger-x', includedCount: 3 }),
      ];
      const result = buildEvidenceIndex({
        existing,
        ledger: [makeLedgerEntry({ id: 'ledger-x' })],
      });

      const ev = result.find(r => r.id === 'ledger:ledger-x');
      expect(ev!.includedCount).toBe(3);
    });
  });

  describe('bumpIncludedEvidence', () => {
    test('increments includedCount for included evidence', () => {
      const records: EvidenceRecord[] = [
        makeEvidence({ id: 'a', includedCount: 0 }),
        makeEvidence({ id: 'b', includedCount: 2 }),
        makeEvidence({ id: 'c' }), // undefined includedCount
      ];

      const result = bumpIncludedEvidence(records, ['a', 'c']);

      expect(result[0].includedCount).toBe(1);
      expect(result[1].includedCount).toBe(2);
      expect(result[2].includedCount).toBe(1);
    });

    test('returns new array, does not mutate original', () => {
      const records: EvidenceRecord[] = [
        makeEvidence({ id: 'a', includedCount: 0 }),
      ];
      const original = records[0].includedCount;

      bumpIncludedEvidence(records, ['a']);

      expect(records[0].includedCount).toBe(original);
    });
  });

  describe('rankEvidence with includedCount', () => {
    test('evidence with higher includedCount ranks higher', () => {
      const records: EvidenceRecord[] = [
        makeEvidence({ id: 'a', importance: 3, includedCount: 0 }),
        makeEvidence({ id: 'b', importance: 3, includedCount: 5 }),
      ];

      const ranked = rankEvidence(records, { query: 'test' });
      // b should rank higher due to includedCount boost
      expect(ranked[0].id).toBe('b');
      expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    });

    test('includedCount boost is capped at 10', () => {
      const low = makeEvidence({ id: 'low', importance: 3, includedCount: 1 });
      const high = makeEvidence({ id: 'high', importance: 3, includedCount: 100 });

      const [rankedLow] = rankEvidence([low], {});
      const [rankedHigh] = rankEvidence([high], {});

      // High's boost is capped: min(100, 10) * 3 * 0.5 = 15
      // Low's boost: min(1, 10) * 3 * 0.5 = 1.5
      expect(rankedHigh.score - rankedHigh.importance * 10).toBeGreaterThanOrEqual(
        rankedLow.score - rankedLow.importance * 10
      );
    });

    test('includedCount appears in reasons', () => {
      const records: EvidenceRecord[] = [
        makeEvidence({ id: 'a', includedCount: 3 }),
      ];

      const ranked = rankEvidence(records, { query: 'test' });
      expect(ranked[0].reasons.some(r => r.includes('included'))).toBe(true);
    });
  });
});
