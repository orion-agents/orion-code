import { spawn, type ChildProcess, type ChildProcessByStdio } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import type { Readable } from 'stream';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import { join, parse, resolve, sep } from 'path';

import { loadWebE2EArtifactState } from './artifact';
import type { WebE2EArtifactStateV1 } from './artifact-types';
import type { WebE2EEvidenceCollector } from './evidence';

const STARTUP_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const HOST_URL_PREFIX = 'Orion Code Web Workbench:';
const HOST_URL_PATTERN = /^Orion Code Web Workbench: (http:\/\/127\.0\.0\.1:(\d{1,5}))$/u;
const FORBIDDEN_ENVIRONMENT_KEYS = new Set([
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'ORION_CODE_CONFIG_DIR',
  'ORION_CODE_DISABLE_ENV_FILES',
  'TMPDIR',
  'TMP',
  'TEMP',
]);

type OrionChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface StartOrionHostOptions {
  readonly state?: WebE2EArtifactStateV1;
  readonly workspace?: string;
  readonly configRoot?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly evidence?: WebE2EEvidenceCollector;
  /** Bind a stable loopback port for same-origin restart tests. Defaults to an ephemeral port. */
  readonly port?: number;
  readonly startupTimeoutMs?: number;
}

export interface OrionHostExitV1 {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface OrionHostHandle {
  readonly url: string;
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly workspace: string;
  readonly configRoot: string;
  readonly homeDirectory: string;
  readonly launcherDirectory: string;
  readonly process: ChildProcess;
  readonly environmentKeys: readonly string[];
  waitForExit(): Promise<OrionHostExitV1>;
  stop(): Promise<OrionHostExitV1>;
}

export async function startOrionHost(
  options: StartOrionHostOptions = {}
): Promise<OrionHostHandle> {
  const state = options.state ?? loadWebE2EArtifactState();
  const hostId = randomUUID();
  const hostRoot = join(state.rawRoot, 'hosts', hostId);
  const launcherDirectory = join(hostRoot, 'launcher');
  const temporaryDirectory = join(hostRoot, 'tmp');
  const homeDirectory = join(hostRoot, 'home');
  const configRoot = resolve(options.configRoot ?? join(hostRoot, 'config'));
  const workspace = resolve(options.workspace ?? join(hostRoot, 'workspace'));
  const requestedPort = boundedPort(options.port);
  for (const path of [
    hostRoot,
    launcherDirectory,
    temporaryDirectory,
    homeDirectory,
    configRoot,
    workspace,
  ]) {
    mkdirPrivate(path);
  }
  options.evidence?.addPrivatePath(hostRoot, '<HOST_ROOT>');
  options.evidence?.addPrivatePath(configRoot, '<CONFIG_ROOT>');
  options.evidence?.addPrivatePath(workspace, '<WORKSPACE_ROOT>');
  for (const [key, value] of Object.entries(options.environment ?? {})) {
    if (/(?:api[_-]?key|token|secret|authorization|password|credential)/iu.test(key)) {
      options.evidence?.addSecretValue(value);
    }
  }

  const environment = hostEnvironment({
    configRoot,
    temporaryDirectory,
    homeDirectory,
    extra: options.environment ?? {},
  });
  const child = spawn(
    process.execPath,
    [
      state.installation.binaryPath,
      'web',
      '--no-open',
      '--port',
      String(requestedPort),
      '--cwd',
      workspace,
    ],
    {
      cwd: launcherDirectory,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    }
  );
  const exitPromise = observeExit(child);
  child.stdout.on('data', chunk => options.evidence?.recordStdout(chunk));
  child.stderr.on('data', chunk => options.evidence?.recordStderr(chunk));
  const lines = createInterface({ input: child.stdout });

  let parsed: { readonly url: string; readonly port: number };
  try {
    parsed = await waitForHostUrl(
      child,
      lines,
      exitPromise,
      boundedTimeout(options.startupTimeoutMs, STARTUP_TIMEOUT_MS)
    );
    if (requestedPort !== 0 && parsed.port !== requestedPort) {
      throw new Error('Installed Orion did not bind the requested Web Host port.');
    }
  } catch (error) {
    await terminateProcessTree(child, exitPromise).catch(() => undefined);
    lines.close();
    throw error;
  }

  let stopPromise: Promise<OrionHostExitV1> | undefined;
  const stop = (): Promise<OrionHostExitV1> => {
    stopPromise ??= terminateProcessTree(child, exitPromise).finally(() => lines.close());
    return stopPromise;
  };
  return Object.freeze({
    url: parsed.url,
    host: '127.0.0.1' as const,
    port: parsed.port,
    workspace,
    configRoot,
    homeDirectory,
    launcherDirectory,
    process: child,
    environmentKeys: Object.freeze(Object.keys(environment).sort()),
    waitForExit: () => exitPromise,
    stop,
  });
}

export function createOrionHostEnvironment(options: {
  readonly configRoot: string;
  readonly temporaryDirectory: string;
  readonly homeDirectory: string;
  readonly environment?: Readonly<Record<string, string>>;
}): NodeJS.ProcessEnv {
  return hostEnvironment({
    configRoot: resolve(options.configRoot),
    temporaryDirectory: resolve(options.temporaryDirectory),
    homeDirectory: resolve(options.homeDirectory),
    extra: options.environment ?? {},
  });
}

async function waitForHostUrl(
  child: OrionChildProcess,
  lines: ReadlineInterface,
  exitPromise: Promise<OrionHostExitV1>,
  timeoutMs: number
): Promise<{ readonly url: string; readonly port: number }> {
  let lineListener: ((line: string) => void) | undefined;
  const urlPromise = new Promise<{ readonly url: string; readonly port: number }>(
    (resolveUrl, reject) => {
      lineListener = line => {
        if (!line.startsWith(HOST_URL_PREFIX)) return;
        const match = HOST_URL_PATTERN.exec(line);
        if (!match) {
          reject(new Error(`Installed Orion emitted an invalid Web Host URL line.`));
          return;
        }
        const port = Number(match[2]);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
          reject(new Error('Installed Orion emitted an invalid Web Host port.'));
          return;
        }
        const parsed = new URL(match[1]);
        if (
          parsed.protocol !== 'http:' ||
          parsed.hostname !== '127.0.0.1' ||
          parsed.port !== String(port) ||
          parsed.pathname !== '/'
        ) {
          reject(new Error('Installed Orion Web Host URL escaped the loopback origin contract.'));
          return;
        }
        resolveUrl(Object.freeze({ url: parsed.origin, port }));
      };
      lines.on('line', lineListener);
    }
  );
  const earlyExit = exitPromise.then(exit => {
    throw new Error(
      `Installed Orion exited before Web Host startup (code=${exit.code}, signal=${exit.signal}).`
    );
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for installed Orion Web Host.`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([urlPromise, earlyExit, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (lineListener) lines.off('line', lineListener);
    void child;
  }
}

function hostEnvironment(options: {
  readonly configRoot: string;
  readonly temporaryDirectory: string;
  readonly homeDirectory: string;
  readonly extra: Readonly<Record<string, string>>;
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'LANG',
    'LC_ALL',
    'CI',
    'SystemRoot',
    'ComSpec',
    'PATHEXT',
    'WINDIR',
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(options.extra)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey === 'ORION_CODE_CONFIG_DIR') {
      if (resolve(value) !== options.configRoot) {
        throw new Error('Web E2E Host environment config root does not match the fixture.');
      }
      continue;
    }
    if (FORBIDDEN_ENVIRONMENT_KEYS.has(normalizedKey)) {
      throw new Error(`Web E2E Host environment cannot override ${key}.`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(`Web E2E Host environment key is invalid: ${key}.`);
    }
    environment[key] = value;
  }
  environment.ORION_CODE_DISABLE_ENV_FILES = '1';
  environment.ORION_CODE_CONFIG_DIR = options.configRoot;
  environment.TMPDIR = options.temporaryDirectory;
  environment.TMP = options.temporaryDirectory;
  environment.TEMP = options.temporaryDirectory;
  if (process.platform === 'win32') {
    const root = parse(options.homeDirectory).root;
    environment.USERPROFILE = options.homeDirectory;
    environment.HOMEDRIVE = root.replace(/[\\/]$/u, '');
    environment.HOMEPATH = `${sep}${options.homeDirectory.slice(root.length)}`;
  } else {
    environment.HOME = options.homeDirectory;
  }
  environment.NO_PROXY = '127.0.0.1,localhost';
  return environment;
}

function observeExit(child: OrionChildProcess): Promise<OrionHostExitV1> {
  return new Promise(resolveExit => {
    child.once('error', () => resolveExit(Object.freeze({ code: null, signal: null })));
    child.once('exit', (code, signal) => resolveExit(Object.freeze({ code, signal })));
  });
}

async function terminateProcessTree(
  child: OrionChildProcess,
  exitPromise: Promise<OrionHostExitV1>
): Promise<OrionHostExitV1> {
  if (child.exitCode !== null || child.signalCode !== null) return exitPromise;
  signalProcessTree(child, 'SIGTERM');
  const graceful = await settleWithin(exitPromise, SHUTDOWN_TIMEOUT_MS);
  if (graceful) return graceful;
  signalProcessTree(child, 'SIGKILL');
  const forced = await settleWithin(exitPromise, SHUTDOWN_TIMEOUT_MS);
  if (!forced) throw new Error('Installed Orion Web Host did not terminate after SIGKILL.');
  return forced;
}

function signalProcessTree(child: OrionChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.pid < 1) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') throw error;
  }
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>(resolveTimeout => {
        timer = setTimeout(() => resolveTimeout(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1_000 || candidate > 60_000) {
    throw new Error('Web E2E Host startup timeout must be from 1000 through 60000ms.');
  }
  return candidate;
}

function boundedPort(value: number | undefined): number {
  const candidate = value ?? 0;
  if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > 65_535) {
    throw new Error('Web E2E Host port must be an integer from 0 through 65535.');
  }
  return candidate;
}

function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
