import { execFile } from 'child_process';

import { startOrionWebServer, type OrionWebServerHandle } from './server';
import { HOST_DAEMON_CHILD_ENV, spawnBackgroundHost, writeHostPidfile } from './host-daemon';

export interface RunOrionWebOptions {
  readonly cwd: string;
  readonly port?: number;
  readonly open?: boolean;
  readonly background?: boolean;
  /** Full `orion web` arguments of the relaunched child (excludes --background). */
  readonly backgroundArgs?: readonly string[];
  readonly stdout?: Pick<NodeJS.WriteStream, 'write'>;
  readonly stderr?: Pick<NodeJS.WriteStream, 'write'>;
}

export async function runOrionWeb(options: RunOrionWebOptions): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const isDaemonChild = process.env[HOST_DAEMON_CHILD_ENV] === '1';
  const port = options.port ?? 3080;
  if (options.background && !isDaemonChild) {
    // Parent side: launch detached and wait for its pidfile, then print the URL.
    const { pidfile } = await spawnBackgroundHost({
      cwd: options.cwd,
      port,
      webArgs: options.backgroundArgs ?? [],
    });
    stdout.write(`Orion Code Web Workbench running in the background: ${pidfile.url}\n`);
    stdout.write(`pid ${pidfile.pid} · logs ~/.orion-code/logs/web-${port}.log\n`);
    stdout.write(`Manage it with: orion web status|stop [--port ${port}]\n`);
    return;
  }
  const handle = await startOrionWebServer({ cwd: options.cwd, port: options.port });
  if (isDaemonChild) {
    writeHostPidfile({
      pid: process.pid,
      port: handle.port,
      url: handle.url,
      workspace: handle.workbench.workspace,
      startedAt: Date.now(),
    });
  }
  stdout.write(`Orion Code Web Workbench: ${handle.url}\n`);
  stdout.write(`Workspace: ${handle.workbench.workspace}\n`);
  if (options.open !== false) {
    openBrowser(handle.url, error => {
      if (error) stderr.write(`Could not open a browser automatically: ${error.message}\n`);
    });
  }
  await waitForShutdown(handle);
}

function waitForShutdown(handle: OrionWebServerHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    let closing = false;
    const cleanup = () => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      handle.server.off('error', fail);
    };
    const shutdown = () => {
      if (closing) return;
      closing = true;
      cleanup();
      handle.close().then(resolve, reject);
    };
    const fail = (error: Error) => {
      if (closing) return;
      closing = true;
      cleanup();
      handle.close().then(
        () => reject(error),
        () => reject(new Error('Web host failed and could not shut down cleanly.'))
      );
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    handle.server.once('error', fail);
  });
}

function openBrowser(url: string, callback: (error?: Error) => void): void {
  let command: string;
  let args: string[];
  if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  execFile(command, args, { windowsHide: true }, error => callback(error ?? undefined));
}
