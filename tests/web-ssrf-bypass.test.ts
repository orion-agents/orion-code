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
import { isUrlSafeForSSRF } from '../src/tools/web';

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
