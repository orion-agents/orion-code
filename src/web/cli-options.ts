/**
 * CLI option parsing for `orion web` (extracted from the CLI entry so the
 * grammar has a unit-testable surface — issue #218 regression coverage).
 */

export const DEFAULT_WEB_PORT = 3080;

export interface WebCliOptions {
  readonly port: number;
  readonly open: boolean;
  readonly cwd: string;
  readonly background: boolean;
}

export function parseWebCliOptions(args: readonly string[]): WebCliOptions {
  let port = DEFAULT_WEB_PORT;
  let open = true;
  let cwd = process.cwd();
  let background = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--background' || argument === '--daemon') {
      background = true;
      continue;
    }
    if (argument === '--no-open') {
      open = false;
      continue;
    }
    if (argument === '--port' || argument.startsWith('--port=')) {
      const portValue = argument === '--port' ? args[++index] : argument.slice('--port='.length);
      if (!portValue || !/^\d+$/u.test(portValue)) {
        throw new Error('--port must be an integer from 0 through 65535.');
      }
      port = Number(portValue);
      if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
        throw new Error('--port must be an integer from 0 through 65535.');
      }
      continue;
    }
    if (argument === '--cwd' || argument.startsWith('--cwd=')) {
      const cwdValue = argument === '--cwd' ? args[++index] : argument.slice('--cwd='.length);
      if (!cwdValue?.trim()) throw new Error('--cwd requires a directory path.');
      cwd = cwdValue;
      continue;
    }
    throw new Error(`Unknown orion web option: ${argument}`);
  }
  return { port, open, cwd, background };
}
