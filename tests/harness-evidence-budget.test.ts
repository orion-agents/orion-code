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

  it('projects oversized contract items with a durable reference and never slices the final prompt', () => {
    const objective = `Objective ${'semantic contract '.repeat(300)}`;
    const state: HarnessState = {
      ledger: [],
      rootObjective: objective,
      activeInstruction: objective,
      activeConstraints: Array.from(
        { length: 8 },
        (_, index) => `constraint-${index} ${'must remain atomic '.repeat(80)}`
      ),
      nonGoals: Array.from(
        { length: 8 },
        (_, index) => `non-goal-${index} ${'must not happen '.repeat(80)}`
      ),
      updatedAt: 1,
    };

    const result = buildHarnessContext(state, 'gpt-4o', { evidenceBudgetRatio: 0.01 });

    expect(result.text).toContain('[full-ref:');
    expect(result.text).not.toContain('[truncated by Context Harness]');
    expect(result.stats.overBudget).toBe(true);
    expect(result.stats.sectionManifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'core',
          authority: 'system',
          source: 'harness_contract',
          selected: true,
          reason: expect.stringContaining('exceeds'),
        }),
        expect.objectContaining({ name: 'instruction', selected: true }),
      ])
    );
    expect(state.rootObjective).toBe(objective);
  });
});
