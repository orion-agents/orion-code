import { existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

function findPython(): string | null {
  for (const command of ['python3', 'python']) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
    if (result.status === 0) return command;
  }
  return null;
}

describe('Ink UI PTY smoke', () => {
  const python = findPython();
  const smokeScript = join(__dirname, '..', 'scripts', 'ink-ui-pty-smoke.py');
  const maybeIt = python && existsSync(smokeScript) && process.platform !== 'win32' ? it : it.skip;

  maybeIt('keeps CJK input, streaming edits, tool ordering, slash palette, and cursor anchoring stable in a real pseudo terminal', () => {
    // PTY smoke can be sensitive to port reuse timing. Retry up to 3 times with
    // exponential backoff so a single transient bind failure doesn't fail the suite.
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = spawnSync(python as string, [smokeScript], {
        cwd: join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      });

      if (result.status === 0 && result.signal === null) {
        // Success — no need to retry.
        expect({ status: result.status, signal: result.signal }).toEqual(
          expect.objectContaining({ status: 0, signal: null }),
        );
        return;
      }

      lastError = { status: result.status, signal: result.signal, stderr: result.stderr?.slice(-500) };
      if (attempt < 3) {
        // Wait for any lingering mock server sockets to release.
        const backoffMs = attempt * 2000;
        const end = Date.now() + backoffMs;
        while (Date.now() < end) { /* busy-wait for port release */ }
      }
    }

    // All retries exhausted — surface the last error.
    throw new Error(
      `PTY smoke failed after 3 attempts. Last error: ${JSON.stringify(lastError)}`,
    );
  }, 400000);
});
