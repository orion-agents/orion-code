/**
 * v0.2.26 — Completion audit unit tests.
 */

import { auditCompletion, auditBlocked, blockerFingerprint, blockersMatch } from '../src/runtime/goals/completion-audit';

describe('completion audit', () => {
  describe('auditCompletion', () => {
    it('passes when evidence refs are present and verification summary exists', () => {
      const result = auditCompletion({
        objective: 'Fix authentication bug',
        evidenceRefs: ['test result 1', 'lint passed'],
        verificationSummary: 'All tests pass, auth bug fixed',
      });
      expect(result.passed).toBe(true);
    });

    it('fails when no evidence refs are provided', () => {
      const result = auditCompletion({
        objective: 'Fix authentication bug',
        evidenceRefs: [],
        verificationSummary: 'Seems fixed',
      });
      expect(result.passed).toBe(false);
      expect(result.remainingRequirements).toBeDefined();
    });

    it('fails when verification summary is empty', () => {
      const result = auditCompletion({
        objective: 'Fix authentication bug',
        evidenceRefs: ['some test'],
        verificationSummary: '',
      });
      expect(result.passed).toBe(false);
    });
  });

  describe('auditBlocked', () => {
    it('allows blocked when same blocker has 3+ consecutive turns', () => {
      const result = auditBlocked({
        blocker: { fingerprint: 'fp1', summary: 'Test', consecutiveTurns: 3, firstSeenAt: Date.now(), lastSeenAt: Date.now() },
        noProgressCount: 3,
      });
      expect(result.allowed).toBe(true);
    });

    it('rejects blocked when consecutive turns are below threshold', () => {
      const result = auditBlocked({
        blocker: { fingerprint: 'fp1', summary: 'Test', consecutiveTurns: 1, firstSeenAt: Date.now(), lastSeenAt: Date.now() },
        noProgressCount: 1,
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe('blockerFingerprint', () => {
    it('generates a fingerprint from key fields', () => {
      const fp = blockerFingerprint('auth-module', '500', 'Server error');
      expect(fp).toBeTruthy();
      expect(typeof fp).toBe('string');
    });
  });

  describe('blockersMatch', () => {
    it('returns true for identical fingerprints', () => {
      const fp = blockerFingerprint('test', '500', 'error');
      expect(blockersMatch({ fingerprint: fp, firstSeenAt: 0, lastSeenAt: 0, consecutiveTurns: 1, summary: '' }, fp)).toBe(true);
    });

    it('returns false for different fingerprints', () => {
      expect(blockersMatch(
        { fingerprint: 'aaa', firstSeenAt: 0, lastSeenAt: 0, consecutiveTurns: 1, summary: '' },
        'bbb',
      )).toBe(false);
    });
  });
});