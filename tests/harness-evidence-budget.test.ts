import { buildHarnessContext } from '../src/harness/assembler';
import { buildEvidenceIndex, estimateTokens } from '../src/harness/evidence';
import type { ContextLedgerEntry, EvidenceRecord, HarnessState } from '../src/harness/types';

function ledgerEntry(id: string, content: string): ContextLedgerEntry {
  return {
    id,
    type: 'tool_result',
    content,
    source: { kind: 'tool', ref: 'exec_command' },
    importance: 3,
    ttl: 'task',
    createdAt: Date.now(),
  };
}

describe('Context Harness evidence accounting', () => {
  it('estimates ledger evidence from the compacted stored content', () => {
    const [record] = buildEvidenceIndex({
      ledger: [ledgerEntry('large', 'x'.repeat(40_000))],
    });

    expect(record.content.length).toBeLessThanOrEqual(700);
    expect(record.tokenEstimate).toBe(estimateTokens(record.content));
    expect(record.tokenEstimate).toBeLessThan(estimateTokens('x'.repeat(40_000)));
  });

  it('charges rendered evidence lines rather than stale oversized record estimates', () => {
    const evidenceIndex: EvidenceRecord[] = Array.from({ length: 10 }, (_, index) => ({
      id: `record-${index}`,
      kind: 'tool_result' as const,
      content: `${index} ${'evidence '.repeat(1000)}`,
      source: 'ledger' as const,
      importance: 3 as const,
      createdAt: Date.now() - index,
      tokenEstimate: 10_000,
      tags: ['evidence'],
      toolName: 'read_file',
    }));
    const state: HarnessState = {
      ledger: [],
      evidenceIndex,
      rootObjective: 'retain relevant evidence',
      updatedAt: Date.now(),
    };

    const result = buildHarnessContext(state, 'gpt-4o', { evidenceBudgetRatio: 0.3 });

    expect(result.stats.includedEvidence.length).toBeGreaterThan(4);
    expect(result.stats.includedEvidence.every(item => item.tokens < 10_000)).toBe(true);
    expect(result.text).toContain('record-9');
  });
});
