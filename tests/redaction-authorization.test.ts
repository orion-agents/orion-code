/**
 * Issue #37, item 1: secret redaction leaked non-Bearer credentials to disk.
 *
 * Before the fix, the `authorization` pattern only matched the scheme name when
 * it was `Bearer`; for `Basic` / `Token` / `ApiKey` / `Negotiate` the optional
 * `(?:Bearer\s+)?` group did not participate, so the scheme token was consumed
 * and the actual credential survived verbatim in the session transcript files
 * persisted under ~/.orion-code.
 *
 * These cases must FULLY redact the credential regardless of scheme, and the
 * `Proxy-Authorization` variant must be covered too.
 */
import { redactTraceText } from '../src/services/redaction';

describe('redaction: non-Bearer Authorization schemes (issue #37 item 1)', () => {
  it('redacts Basic credentials in an Authorization header', () => {
    const input = 'curl -H "Authorization: Basic YWRtaW46aHVudGVyMg==" https://api.x.com';
    const out = redactTraceText(input);
    expect(out).toContain('Authorization: [REDACTED_SECRET]');
    expect(out).not.toContain('YWRtaW46aHVudGVyMg==');
  });

  it('redacts Token credentials', () => {
    const out = redactTraceText('Authorization: Token 9f8a7b6c5d4e3f2a1b0c');
    expect(out).toContain('[REDACTED_SECRET]');
    expect(out).not.toContain('9f8a7b6c5d4e3f2a1b0c');
  });

  it('redacts ApiKey credentials', () => {
    const out = redactTraceText('Authorization: ApiKey s3cr3t-api-key-value');
    expect(out).toContain('[REDACTED_SECRET]');
    expect(out).not.toContain('s3cr3t-api-key-value');
  });

  it('redacts Negotiate credentials', () => {
    const out = redactTraceText('Authorization: Negotiate abcdef0123456789');
    expect(out).toContain('[REDACTED_SECRET]');
    expect(out).not.toContain('abcdef0123456789');
  });

  it('still redacts Bearer credentials (regression guard)', () => {
    const out = redactTraceText('Authorization: Bearer sk-realsecret123');
    expect(out).toContain('[REDACTED_SECRET]');
    expect(out).not.toContain('sk-realsecret123');
  });

  it('redacts Proxy-Authorization (Basic)', () => {
    const out = redactTraceText('Proxy-Authorization: Basic cHJveHk6c2VjcmV0');
    expect(out).toContain('[REDACTED_SECRET]');
    expect(out).not.toContain('cHJveHk6c2VjcmV0');
  });

  it('redacts a bare shell-echoed Authorization line', () => {
    const out = redactTraceText('echo "Authorization: Basic dXNlcjpwYXNz" >> headers.txt');
    expect(out).toContain('[REDACTED_SECRET]');
    expect(out).not.toContain('dXNlcjpwYXNz');
  });
});
