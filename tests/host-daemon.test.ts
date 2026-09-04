/**
 * v0.3.9 — native background host lifecycle (issue #247 S1+S2).
 * Pure pidfile/status/stop semantics run against the Jest-isolated config root
 * (setup-env already points ORION_CODE_CONFIG_DIR at a per-process temp dir).
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  hostLogsDirectory,
  hostPidfilePath,
  isProcessAlive,
  parseHostPidfile,
  readHostPidfile,
  writeHostPidfile,
} from '../src/web/host-daemon';

describe('web host daemon (issue #247 S1/S2)', () => {
  it('parses and rejects malformed pidfiles strictly', () => {
    expect(
      parseHostPidfile(
        JSON.stringify({
          pid: 42,
          port: 3080,
          url: 'http://127.0.0.1:3080',
          workspace: '/tmp/demo',
          startedAt: 1_700_000_000_000,
        })
      )
    ).toMatchObject({ pid: 42, port: 3080 });
    expect(parseHostPidfile('not-json')).toBeNull();
    expect(parseHostPidfile(JSON.stringify({ pid: 'x' }))).toBeNull();
    expect(parseHostPidfile('')).toBeNull();
  });

  it('writes and reads back a pidfile under the config home', () => {
    const port = 4099;
    writeHostPidfile({
      pid: 12345,
      port,
      url: `http://127.0.0.1:${port}`,
      workspace: '/tmp/demo',
      startedAt: 1_700_000_000_000,
    });
    expect(readHostPidfile(port)).toMatchObject({ pid: 12345, port });
    expect(hostPidfilePath(port)).toContain('web-host');
    expect(hostLogsDirectory()).toContain('logs');
  });

  it('probes process liveness without killing the target', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2_147_483_647)).toBe(false);
  });
});
