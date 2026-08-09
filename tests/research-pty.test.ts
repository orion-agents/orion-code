import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { canRunPtySmoke } from './support/env';

function findPython(): string | null {
  for (const command of ['python3', 'python']) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
    if (result.status === 0) return command;
  }
  return null;
}

describe('Research renderer real-process parity', () => {
  const python = findPython();
  const smokeScript = join(__dirname, '..', 'scripts', 'research-renderer-pty-smoke.py');
  const maybeIt =
    python && existsSync(smokeScript) && process.platform !== 'win32' && canRunPtySmoke
      ? it
      : it.skip;

  maybeIt(
    'shows the same typed lifecycle through terminal PTY, TUI PTY, and print JSON',
    () => {
      const result = spawnSync(python as string, [smokeScript], {
        cwd: join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      });

      expect({
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
      }).toEqual(expect.objectContaining({ status: 0, signal: null }));
      expect(result.stdout).toContain('ORION_PTY_RUNNER_KIND=source');
      expect(result.stdout).toContain('RESEARCH_RENDERER_PTY_SMOKE_OK');
      expect(result.stdout).toContain('terminal_events=2');
      expect(result.stdout).toContain('tui_projection=True');
      expect(result.stdout).toContain('print_events=6');
    },
    125000
  );
});
