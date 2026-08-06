/**
 * Issue #37, item 2: the SSRF blocklist covered only the *unused* half of IPv6
 * ULA (`fc00::/8`, reserved) and missed the allocated `fd00::/8`, plus it had no
 * entries for CGNAT (`100.64.0.0/10`) or the IETF protocol-assignment block
 * (`192.0.0.0/24`). Those ranges are not globally routable and must be blocked.
 */
import { isUrlSafeForSSRF } from '../src/tools/web';

describe('SSRF blocklist covers allocated ULA and non-routable ranges (issue #37 item 2)', () => {
  it.each([
    'http://[fd00::1]:8080/admin',
    'http://[fd12:3456:789a::1]/',
    'http://[fc00::1]/', // reserved half must still be blocked
    'http://[fe80::1]/', // link-local, regression guard
    'http://100.64.0.1/',
    'http://100.127.255.254/', // top of the /10
    'http://192.0.0.1/',
  ])('blocks internal/non-routable address %s', url => {
    const result = isUrlSafeForSSRF(url);
    expect(result.safe).toBe(false);
    expect(result.reason ?? '').toMatch(/Blocked/i);
  });

  it.each([
    'http://93.184.216.34/', // example.com public IPv4
    'https://github.com/orion-agents/orion-code',
  ])('allows genuinely public address %s', url => {
    expect(isUrlSafeForSSRF(url).safe).toBe(true);
  });

  it('fd00::/8 is now blocked where the old fc00-only anchor leaked it', () => {
    const leakedBefore = isUrlSafeForSSRF('http://[fd00::dead:beef]/');
    expect(leakedBefore.safe).toBe(false);
  });
});
