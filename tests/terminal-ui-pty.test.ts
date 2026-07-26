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

describe('Default terminal agent flow PTY smoke', () => {
  const python = findPython();
  const smokeScript = join(__dirname, '..', 'scripts', 'terminal-ui-pty-smoke.py');
  const maybeIt = python && existsSync(smokeScript) && process.platform !== 'win32' ? it : it.skip;

  maybeIt('keeps input stable and verifies context, tool confirmation, and resume', () => {
    const result = spawnSync(python as string, [smokeScript], {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });

    expect({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual(expect.objectContaining({ status: 0, signal: null }));
  }, 65000);
});
