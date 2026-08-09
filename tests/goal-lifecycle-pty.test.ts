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

describe('v0.1.2 Goal lifecycle PTY acceptance', () => {
  const python = findPython();
  const smokeScript = join(__dirname, '..', 'scripts', 'goal-lifecycle-pty-smoke.py');
  const maybeIt =
    python && existsSync(smokeScript) && process.platform !== 'win32' && canRunPtySmoke
      ? it
      : it.skip;

  maybeIt(
    'survives failure, repair, compact, restart, resume, and audited completion in both renderers',
    () => {
      const result = spawnSync(python as string, [smokeScript], {
        cwd: join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 180000,
        maxBuffer: 2 * 1024 * 1024,
      });

      expect({
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
      }).toEqual(expect.objectContaining({ status: 0, signal: null }));
      expect(result.stdout).toContain('GOAL_LIFECYCLE_PTY_TUI_OK');
      expect(result.stdout).toContain('GOAL_LIFECYCLE_PTY_TERMINAL_OK');
      expect(result.stdout).toContain('GOAL_LIFECYCLE_PTY_OK');
    },
    185000
  );
});
