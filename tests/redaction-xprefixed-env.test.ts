/**
 * Issue #241 companion: redaction must cover uppercase, X-prefixed environment
 * assignments whose secret suffix is hidden behind underscore word characters
 * (`X_CLIENT_SECRET=` etc.), which the lower-case field rules cannot reach.
 */
import { redactTraceText } from '../src/services/redaction';

describe('redaction of X-prefixed uppercase env secrets (issue #241)', () => {
  it('redacts export X_CLIENT_SECRET=… values', () => {
    const out = redactTraceText('export X_CLIENT_SECRET=supersecret value');
    expect(out).not.toContain('supersecret');
    expect(out).toContain('[REDACTED_SECRET]');
  });

  it('redacts bare CLIENT_SECRET= / AUTH_TOKEN= assignments', () => {
    for (const sample of ['CLIENT_SECRET=abc123', 'AUTH_TOKEN=abc123', 'PRIVATE_KEY=xyz789']) {
      const out = redactTraceText(sample);
      expect(out).toContain('[REDACTED_SECRET]');
      expect(out).not.toMatch(/=(?:abc123|xyz789)/);
    }
  });

  it('keeps URL userinfo fully redacted even when the password starts with token: (issue #234 regression)', () => {
    const out = redactTraceText('https://alice:token:xyz@host/path');
    expect(out).toContain('[REDACTED_CREDENTIAL]');
    expect(out).not.toContain('token:xyz');
  });

  it('redacts X-prefixed JSON keys like x-client-secret (issue #241)', () => {
    const out = redactTraceText('{"x-client-secret":"supersecret","x-api-key":"k123"}');
    expect(out).not.toContain('supersecret');
    expect(out).not.toContain('k123');
  });
});
