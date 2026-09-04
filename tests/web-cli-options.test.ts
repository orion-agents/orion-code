/**
 * v0.3.9 — regression coverage for the `orion web` CLI option grammar
 * (issue #218 command-level tests). The grammar is exercised directly so the
 * background/daemon matrix, ports and cwd handling stay locked down without
 * spawning a host.
 */
import { parseWebCliOptions } from '../src/web/cli-options';

describe('orion web CLI options (issue #218)', () => {
  it('defaults to open port 4242 (M42) on the current cwd', () => {
    expect(parseWebCliOptions([])).toEqual({
      port: 4242,
      open: true,
      cwd: process.cwd(),
      background: false,
    });
  });

  it('parses --no-open, --port (space and =), --cwd and --background', () => {
    const options = parseWebCliOptions([
      '--background',
      '--no-open',
      '--port',
      '43120',
      '--cwd',
      '/tmp/demo',
    ]);
    expect(options).toEqual({
      port: 43120,
      open: false,
      cwd: '/tmp/demo',
      background: true,
    });
    expect(parseWebCliOptions(['--port=7000']).port).toBe(7000);
    expect(parseWebCliOptions(['--cwd=/tmp/other']).cwd).toBe('/tmp/other');
    expect(parseWebCliOptions(['--daemon']).background).toBe(true);
  });

  it('rejects malformed ports and unknown options', () => {
    expect(() => parseWebCliOptions(['--port', 'abc'])).toThrow(/--port/);
    expect(() => parseWebCliOptions(['--port', '70000'])).toThrow(/--port/);
    expect(() => parseWebCliOptions(['--port', '-1'])).toThrow(/--port/);
    expect(() => parseWebCliOptions(['--bogus'])).toThrow(/Unknown orion web option/);
    expect(() => parseWebCliOptions(['--cwd', '  '])).toThrow(/--cwd requires/);
  });
});
