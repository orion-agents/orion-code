/**
 * Bug-hunt round 15 evidence: ContextLedger eviction keys removal on
 * source.ref, not on entry id. Many entries share the same source.ref (e.g.
 * every read_file call has ref 'read_file'), so the removeIds Set collapses
 * to one element and the filter removes ALL entries with that ref - not just
 * the overflow count. The ledger is over-evicted toward zero instead of being
 * trimmed to MAX_ENTRIES, losing retained evidence.
 *
 * Eviction must key on entry id (unique), not source.ref.
 */
import { ContextLedger } from '../src/harness/ledger';

describe('ContextLedger eviction (bug-hunt round 15)', () => {
  it('trims to roughly MAX_ENTRIES, not over-evicts to near-zero', () => {
    const ledger = new ContextLedger();
    // Every entry has the SAME source.ref ('read_file') and importance 3.
    for (let i = 0; i < ContextLedger.MAX_ENTRIES + 50; i++) {
      ledger.recordToolResult({
        name: 'read_file',
        args: { path: `/tmp/file-${i}.txt` },
        result: JSON.stringify({ success: true, output: 'x' }),
        duration: 1,
        success: true,
      });
    }
    const count = ledger.getEntries().length;
    expect(count).toBeLessThanOrEqual(ContextLedger.MAX_ENTRIES);
    // Before the fix, the shared-ref Set collapsed removal to ALL entries,
    // leaving 0. A correct trim keeps close to MAX_ENTRIES (allow some slack).
    expect(count).toBeGreaterThanOrEqual(ContextLedger.MAX_ENTRIES - 5);
  });

  it('does not evict high-importance user requirements when overflowing', () => {
    const ledger = new ContextLedger();
    ledger.recordUserRequirement('CRITICAL: must run tests');
    for (let i = 0; i < ContextLedger.MAX_ENTRIES + 10; i++) {
      ledger.recordToolResult({
        name: 'read_file',
        args: { path: `/tmp/file-${i}.txt` },
        result: JSON.stringify({ success: true, output: 'x' }),
        duration: 1,
        success: true,
      });
    }
    const entries = ledger.getEntries();
    expect(entries.some(e => e.type === 'user_requirement' && e.content.includes('CRITICAL'))).toBe(true);
  });
});
