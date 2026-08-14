import { existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { canRunPtySmoke } from './support/env';

function findPython(): string | null {
  for (const command of ['python3', 'python']) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
    if (result.status === 0) return command;
  }
  return null;
}

describe('agent mode PTY tool execution', () => {
  const python = findPython();
  const smokeScript = join(__dirname, '..', 'scripts', 'smoke', 'agent-modes-pty-smoke.py');
  const maybeIt =
    python && existsSync(smokeScript) && process.platform !== 'win32' && canRunPtySmoke
      ? it
      : it.skip;

  maybeIt(
    'reuses grants across BUILD and PLAN while AUTO authorizes and hard guards remain',
    () => {
      const result = spawnSync(python as string, [smokeScript], {
        cwd: join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 150000,
        maxBuffer: 1024 * 1024,
      });

      expect({
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
      }).toEqual(expect.objectContaining({ status: 0, signal: null }));
      expect(result.stdout).toContain('AGENT_MODES_PTY_OK');
    },
    155000
  );
});
