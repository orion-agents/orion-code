/**
 * Native background/daemon lifecycle for `orion web` (issue #247, S1+S2).
 *
 * A foreground `orion web --background` parent spawns the real host detached,
 * waits for it to publish a pidfile under the config home, then returns. The
 * detached child redirects its stdio to per-host log files and keeps the
 * fail-closed approval / context / sandbox semantics untouched — this is a
 * process-lifecycle concern only, still bound to 127.0.0.1.
 *
 * The pidfile shape is intentionally tiny and human-readable:
 *
 *   { "pid": 12345, "port": 4242, "url": "http://127.0.0.1:4242",
 *     "startedAt": 1725000000000, "workspace": "/abs/path" }
 */
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { getConfigHome } from '../product/paths';

export const HOST_PIDFILE_BASE = 'web-host';
export const HOST_DAEMON_CHILD_ENV = 'ORION_WEB_DAEMON_CHILD';
export const DAEMON_READY_TIMEOUT_MS = 8_000;
export const DAEMON_POLL_MS = 120;

export interface HostPidfile {
  readonly pid: number;
  readonly port: number;
  readonly url: string;
  readonly workspace: string;
  readonly startedAt: number;
}

export type HostDaemonStatus =
  | { readonly state: 'running'; readonly pidfile: HostPidfile }
  | { readonly state: 'stopped' }
  | { readonly state: 'stale'; readonly pid: number; readonly port: number };

export function hostLogsDirectory(): string {
  return join(getConfigHome(), 'logs');
}

export function hostPidfilePath(port: number): string {
  return join(getConfigHome(), `${HOST_PIDFILE_BASE}.${port}.pid`);
}

export function parseHostPidfile(raw: string): HostPidfile | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.pid !== 'number' ||
      typeof record.port !== 'number' ||
      typeof record.url !== 'string' ||
      typeof record.workspace !== 'string' ||
      typeof record.startedAt !== 'number'
    ) {
      return null;
    }
    return Object.freeze({
      pid: record.pid,
      port: record.port,
      url: record.url,
      workspace: record.workspace,
      startedAt: record.startedAt,
    });
  } catch {
    return null;
  }
}

export function readHostPidfile(port: number): HostPidfile | null {
  const path = hostPidfilePath(port);
  if (!existsSync(path)) return null;
  try {
    return parseHostPidfile(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function writeHostPidfile(pidfile: HostPidfile): void {
  mkdirSync(getConfigHome(), { recursive: true });
  writeFileSync(hostPidfilePath(pidfile.port), JSON.stringify(pidfile, null, 2), 'utf8');
}

export function clearHostPidfile(port: number): void {
  try {
    rmSync(hostPidfilePath(port), { force: true });
  } catch {
    // Pidfile removal is best-effort: a locked/restricted filesystem must not
    // turn `orion web stop` into a failure after the process is already gone.
  }
}

/** Cross-platform process-liveness probe used by `status`. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function hostDaemonStatus(port: number): HostDaemonStatus {
  const pidfile = readHostPidfile(port);
  if (!pidfile) return { state: 'stopped' };
  if (isProcessAlive(pidfile.pid)) {
    return { state: 'running', pidfile };
  }
  return { state: 'stale', pid: pidfile.pid, port };
}

/** Build the argument vector used to re-launch the current CLI detached. */
function childArgs(webArgs: readonly string[]): readonly string[] {
  const entry = process.argv[1];
  if (!entry) throw new Error('Unable to determine the CLI entry to relaunch.');
  return [entry, 'web', ...webArgs];
}

/**
 * Parent-side entry for `--background`: spawn the host detached, redirect its
 * stdio to `~/.orion-code/logs/web-<port>.log`, and wait for the pidfile so the
 * foreground command can print the URL and exit cleanly.
 */
export function spawnBackgroundHost(options: {
  readonly cwd: string;
  readonly port: number;
  readonly webArgs: readonly string[];
}): Promise<{ readonly child: ChildProcess; readonly pidfile: HostPidfile }> {
  const logsDirectory = hostLogsDirectory();
  mkdirSync(logsDirectory, { recursive: true });
  const logPath = join(logsDirectory, `web-${options.port}.log`);
  const output = openSync(logPath, 'a');
  const child = spawn(process.execPath, childArgs(options.webArgs), {
    cwd: options.cwd,
    detached: true,
    stdio: ['ignore', output, output],
    env: { ...process.env, [HOST_DAEMON_CHILD_ENV]: '1' },
  });
  child.unref();

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
    const poll = () => {
      const pidfile = readHostPidfile(options.port);
      if (pidfile && pidfile.pid === child.pid) {
        resolve({ child, pidfile });
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        reject(
          new Error(
            `Background host exited before readiness (code ${child.exitCode ?? 'signal'}); see ${logPath}`
          )
        );
        return;
      }
      if (Date.now() > deadline) {
        reject(
          new Error(
            `Background host did not become ready within ${DAEMON_READY_TIMEOUT_MS}ms; see ${logPath}`
          )
        );
        return;
      }
      setTimeout(poll, DAEMON_POLL_MS);
    };
    poll();
  });
}

/** Terminate a background host by pidfile (SIGTERM, then escalate to SIGKILL). */
export function stopBackgroundHost(port: number): Promise<'stopped' | 'not_running'> {
  const status = hostDaemonStatus(port);
  if (status.state !== 'running') return Promise.resolve('not_running');
  const { pidfile } = status;
  return new Promise(resolve => {
    try {
      process.kill(pidfile.pid, 'SIGTERM');
    } catch {
      clearHostPidfile(port);
      resolve('stopped');
      return;
    }
    const deadline = Date.now() + 4_000;
    const poll = () => {
      if (!isProcessAlive(pidfile.pid)) {
        clearHostPidfile(port);
        resolve('stopped');
        return;
      }
      if (Date.now() > deadline) {
        try {
          process.kill(pidfile.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
        clearHostPidfile(port);
        resolve('stopped');
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}
