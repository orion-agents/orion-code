/**
 * Bug-hunt round 4 evidence: SSRF protection bypassed via IP encoding.
 *
 * isUrlSafeForSSRF only matched the hostname string against regexes, so any
 * encoded form of a private IP that the OS resolver still parses to that IP
 * slipped through:
 *   - decimal integer:  http://2130706433/  (== 127.0.0.1)
 *   - hex:              http://0x7f000001/  (== 127.0.0.1)
 *   - octal:            http://0177.0.0.1/  (== 127.0.0.1)
 *   - IPv6-mapped IPv4: http://[::ffff:127.0.0.1]/
 *   - bare 0:           http://0/            (== 0.0.0.0)
 *
 * Each of these must be reported unsafe.
 */
import { isUrlSafeForSSRF, webFetchTool, clearWebFetchCache } from '../src/tools/web';
import type { ToolContext } from '../src/framework/tool';

describe('SSRF IP-encoding bypass', () => {
  it('blocks decimal-integer form of 127.0.0.1', () => {
    expect(isUrlSafeForSSRF('http://2130706433/').safe).toBe(false);
  });

  it('blocks hex form of 127.0.0.1', () => {
    expect(isUrlSafeForSSRF('http://0x7f000001/').safe).toBe(false);
  });

  it('blocks octal form of 127.0.0.1', () => {
    expect(isUrlSafeForSSRF('http://0177.0.0.1/').safe).toBe(false);
  });

  it('blocks IPv6-mapped IPv4 of 127.0.0.1', () => {
    expect(isUrlSafeForSSRF('http://[::ffff:127.0.0.1]/').safe).toBe(false);
  });

  it('blocks IPv6 localhost [::1] (bracketed form)', () => {
    expect(isUrlSafeForSSRF('http://[::1]/').safe).toBe(false);
  });

  it('blocks bare 0 (resolves to 0.0.0.0)', () => {
    expect(isUrlSafeForSSRF('http://0/').safe).toBe(false);
  });

  it('blocks decimal form of 10.0.0.1 (private class A)', () => {
    // 10.0.0.1 == 167772161
    expect(isUrlSafeForSSRF('http://167772161/').safe).toBe(false);
  });

  it('still allows a normal public hostname', () => {
    expect(isUrlSafeForSSRF('https://example.com/path').safe).toBe(true);
  });

  it('still blocks literal 127.0.0.1', () => {
    expect(isUrlSafeForSSRF('http://127.0.0.1/').safe).toBe(false);
  });
});

describe('SSRF protocol and credential bypass', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://example.com/x',
    'gopher://example.com/x',
    'data:text/plain,hello',
  ])('blocks non-http(s) protocol: %s', url => {
    const result = isUrlSafeForSSRF(url);
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/Blocked protocol|Invalid URL/);
  });

  it('blocks URLs carrying embedded credentials', () => {
    const result = isUrlSafeForSSRF('https://user:pass@example.com/x');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('embedded credentials');
  });
});

/**
 * Bug-hunt evidence (v0.1.3-2 §1.5): SSRF bypass via HTTP redirect.
 *
 * fetchUrl used `redirect: 'follow'`, so only the FIRST url went through
 * isUrlSafeForSSRF. A public, attacker-controlled URL could answer 302 with
 * `Location: http://169.254.169.254/latest/meta-data/` and the agent would
 * fetch cloud metadata. Every hop must now be re-validated.
 */
describe('SSRF redirect-chain enforcement', () => {
  const originalFetch = global.fetch;
  const context = { cwd: '/repo', config: { name: 'orion-code', mode: 'test' } } as ToolContext;

  const okResponse = (overrides: Record<string, unknown> = {}) =>
    ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: jest.fn().mockResolvedValue('public content'),
      ...overrides,
    }) as unknown as Response;

  const redirectTo = (location: string, status = 302) =>
    ({
      ok: false,
      status,
      statusText: 'Found',
      headers: new Headers({ location }),
      text: jest.fn().mockResolvedValue(''),
    }) as unknown as Response;

  beforeEach(() => {
    clearWebFetchCache();
    global.fetch = jest.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it.each([
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback', 'http://127.0.0.1:8080/admin'],
    ['private class A', 'http://10.0.0.5/internal'],
    ['decimal-encoded loopback', 'http://2130706433/'],
  ])('blocks a redirect from a public host to %s', async (_label, target) => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(redirectTo(target));

    const result = await webFetchTool.execute(
      { url: 'https://public.example/start', prompt: 'read' },
      context
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('SSRF');
    // the dangerous hop must never be requested
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('blocks a protocol downgrade to file:// via redirect', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(redirectTo('file:///etc/passwd'));

    const result = await webFetchTool.execute(
      { url: 'https://public.example/start', prompt: 'read' },
      context
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('SSRF');
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('allows a redirect chain that stays on public hosts', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(redirectTo('https://other.example/step2'))
      .mockResolvedValueOnce(redirectTo('https://final.example/end', 301))
      .mockResolvedValueOnce(okResponse());

    const result = await webFetchTool.execute(
      { url: 'https://public.example/start', prompt: 'read' },
      context
    );

    expect(result.success).toBe(true);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(3);
    expect(result.output).toContain('Final URL (after redirects)');
  });

  it('stops after too many redirects instead of looping forever', async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string) =>
      redirectTo(`${url}/next`)
    );

    const result = await webFetchTool.execute(
      { url: 'https://public.example/start', prompt: 'read' },
      context
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Too many redirects');
    // maxRedirects = 5 -> at most 6 requests
    expect((global.fetch as jest.Mock).mock.calls.length).toBeLessThanOrEqual(6);
  });
});
