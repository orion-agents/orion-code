/**
 * Bug-hunt round 10 evidence: redaction leaks OpenAI project keys with dots.
 *
 * The `sk-` secret pattern uses the character class [A-Za-z0-9_-], which does
 * not include `.`. Modern OpenAI project keys are shaped like
 * `sk-proj-XXXX...YYYY.ZZZ` and contain dots, so the pattern stops at the first
 * dot and only redacts the prefix - the rest of the key leaks into the trace.
 */
import { redactTraceText } from '../src/services/redaction';

const SYNTHETIC_AWS_ACCESS_KEY_ID = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

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

  it.each([
    'GH_TOKEN=ghp_abcdefghijklmnopqrst',
    'GITHUB_TOKEN=github_pat_abcdefghijklmnop',
    `AWS_ACCESS_KEY_ID=${SYNTHETIC_AWS_ACCESS_KEY_ID}`,
    'AWS_SECRET_ACCESS_KEY=abcDEF1234567890abcDEF1234567890abcDEF12',
    'AWS_SESSION_TOKEN=session-token-with-sensitive-body',
  ])('redacts common GitHub and AWS environment secrets: %s', secret => {
    const result = redactTraceText(`exec ${secret} command`);
    expect(result).toContain('[REDACTED_SECRET]');
    expect(result).not.toContain(secret.split('=')[1]);
  });

  it('redacts standalone GitHub and AWS access token formats', () => {
    const result = redactTraceText(
      `tokens ghp_abcdefghijklmnopqrst github_pat_abcdefghijklmnop ${SYNTHETIC_AWS_ACCESS_KEY_ID}`
    );
    expect(result).not.toContain('ghp_abcdefghijklmnopqrst');
    expect(result).not.toContain('github_pat_abcdefghijklmnop');
    expect(result).not.toContain(SYNTHETIC_AWS_ACCESS_KEY_ID);
  });
});
