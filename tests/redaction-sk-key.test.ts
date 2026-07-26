/**
 * Bug-hunt round 10 evidence: redaction leaks OpenAI project keys with dots.
 *
 * The `sk-` secret pattern uses the character class [A-Za-z0-9_-], which does
 * not include `.`. Modern OpenAI project keys are shaped like
 * `sk-proj-XXXX...YYYY.ZZZ` and contain dots, so the pattern stops at the first
 * dot and only redacts the prefix - the rest of the key leaks into the trace.
 */
import { redactTraceText } from '../src/services/redaction';

describe('redaction sk- key with dots (bug-hunt round 10)', () => {
  it('fully redacts an sk-proj key that contains dots (no body leakage)', () => {
    const key = 'sk-proj-abcDEF1234567890ab.cdef-ghi_jkl';
    const result = redactTraceText(`found ${key} in the logs`);
    // Before the fix: "sk-proj-abcDEF1234567890ab" was redacted but
    // ".cdef-ghi_jkl" leaked. The distinctive tail must not survive.
    expect(result).not.toMatch(/cdef-ghi_jkl/);
    expect(result).toContain('[REDACTED_SECRET]');
  });

  it('fully redacts a classic sk- key (regression)', () => {
    const result = redactTraceText('token: sk-abcdefgh1234567890XYZ');
    expect(result).not.toMatch(/abcdefgh1234567890XYZ/);
    expect(result).toContain('[REDACTED_SECRET]');
  });
});
