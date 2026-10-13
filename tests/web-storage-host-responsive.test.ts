import childProcess from 'child_process';
import { randomUUID } from 'crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { startOrionWebServer, type OrionWebServerHandle } from '../src/web/server';
import { WebWorkbenchController } from '../src/web/workbench-controller';
import { createFakeWebRuntime } from './support/web-runtime';
import { encodeProjectPath } from '../src/product/paths';

describe('Web Host responsiveness during failed Git identity discovery', () => {
  (process.platform === 'win32' ? test.skip : test)(
    'keeps real HTTP and SSE responsive and returns a retryable identity error without metadata',
    async () => {
      const fixture = mkdtempSync(join(tmpdir(), 'orion-host-storage-'));
      const workspace = join(fixture, 'workspace');
      const config = join(fixture, 'config');
      const originalConfig = process.env.ORION_CODE_CONFIG_DIR;
      let handle: OrionWebServerHandle | undefined;
      const abort = new AbortController();
      let heartbeat: NodeJS.Timeout | undefined;
      try {
        mkdirSync(workspace);
        process.env.ORION_CODE_CONFIG_DIR = config;
        childProcess.execFileSync('git', ['-C', workspace, 'init'], { stdio: 'ignore' });
        const host = await WebWorkbenchController.create({
          cwd: workspace,
          createRuntime: async cwd => createFakeWebRuntime(cwd),
        });
        handle = await startOrionWebServer({ cwd: workspace, workbench: host, port: 0 });
        const bootstrap = host.bootstrap(handle.nonce);
        const catalogBefore = readFileSync(join(config, 'session-catalog.json'), 'utf8');
        const stream = await fetch(`${handle.url}/api/v1/events`, { signal: abort.signal });
        const reader = stream.body!.getReader();
        await reader.read();
        // Invalidate the warm root identity without changing the logical root.
        childProcess.execFileSync('git', ['-C', workspace, 'config', 'core.ignorecase', 'true']);
        const slowGit = join(fixture, 'slow-git');
        writeFileSync(slowGit, '#!/bin/sh\nexec /bin/sleep 60\n', { mode: 0o755 });
        const nativeExec = childProcess.execFile;
        const syncProbe = jest.spyOn(childProcess, 'execFileSync');
        let started!: () => void;
        const probeStarted = new Promise<void>(resolveStarted => {
          started = resolveStarted;
        });
        let rootFailure: childProcess.ExecFileException | null = null;
        jest.spyOn(childProcess, 'execFile').mockImplementation(((...args: unknown[]) => {
          const commandArgs = args[1] as string[];
          const callback = args[3] as (
            error: childProcess.ExecFileException | null,
            stdout: string,
            stderr: string
          ) => void;
          if (commandArgs.includes('--show-toplevel')) {
            started();
            return nativeExec(
              slowGit,
              commandArgs,
              args[2] as childProcess.ExecFileOptionsWithStringEncoding,
              (error, stdout, stderr) => {
                rootFailure = error;
                callback(error, stdout, stderr);
              }
            );
          }
          return nativeExec(
            args[0] as string,
            commandArgs,
            args[2] as childProcess.ExecFileOptionsWithStringEncoding,
            callback
          );
        }) as typeof childProcess.execFile);
        let completed = false;
        const creating = fetch(`${handle.url}/api/v1/sessions`, {
          method: 'POST',
          headers: {
            Origin: handle.url,
            'Content-Type': 'application/json',
            'X-Orion-Web-Nonce': handle.nonce,
          },
          body: JSON.stringify({
            requestId: randomUUID(),
            name: 'must-not-persist',
            workspaceId: bootstrap.workspaceId,
            expectedContextRevision: bootstrap.contextRevision,
          }),
        }).then(response => {
          completed = true;
          return response;
        });
        await probeStarted;
        const healthSamples: number[] = [];
        const streamSamples: number[] = [];
        let lastFrame = performance.now();
        heartbeat = setInterval(() => host.eventHub.heartbeat(), 5);
        const sseReading = (async () => {
          while (streamSamples.length < 20) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const now = performance.now();
            streamSamples.push(now - lastFrame);
            lastFrame = now;
          }
        })();
        for (let index = 0; index < 20; index += 1) {
          const start = performance.now();
          expect((await fetch(`${handle.url}/api/v1/health`)).status).toBe(200);
          healthSamples.push(performance.now() - start);
        }
        expect(completed).toBe(false);
        await sseReading;
        const response = await creating;
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          code: 'project_storage_identity_unavailable',
        });
        expect(rootFailure).toMatchObject({ killed: true, signal: 'SIGKILL' });
        expect(syncProbe).not.toHaveBeenCalled();
        expect(host.listSessions()).toEqual([]);
        expect(existsSync(join(config, 'session-catalog.json'))).toBe(true);
        expect(readFileSync(join(config, 'session-catalog.json'), 'utf8')).toBe(catalogBefore);
        const sessionsDir = join(
          config,
          'projects',
          encodeProjectPath(realpathSync(workspace)),
          'sessions'
        );
        expect(existsSync(sessionsDir) ? readdirSync(sessionsDir) : []).toEqual([]);
        expect(host.contextRevision).toBe(bootstrap.contextRevision);
        const p95 = (samples: number[]) =>
          samples.slice().sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];
        console.log(
          'V0324_REAL_HTTP_SSE_GIT_TIMEOUT',
          JSON.stringify({
            healthSamples,
            streamSamples,
            healthP95Ms: p95(healthSamples),
            sseP95Ms: p95(streamSamples),
          })
        );
        expect(p95(healthSamples)).toBeLessThan(100);
        expect(p95(streamSamples)).toBeLessThan(100);
        jest.restoreAllMocks();
        const retry = await fetch(`${handle.url}/api/v1/sessions`, {
          method: 'POST',
          headers: {
            Origin: handle.url,
            'Content-Type': 'application/json',
            'X-Orion-Web-Nonce': handle.nonce,
          },
          body: JSON.stringify({
            requestId: randomUUID(),
            name: 'retry-created',
            workspaceId: bootstrap.workspaceId,
            expectedContextRevision: bootstrap.contextRevision,
          }),
        });
        expect(retry.status).toBe(201);
        expect(host.listSessions()).toHaveLength(1);
        abort.abort();
        await reader.cancel().catch(() => undefined);
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        abort.abort();
        jest.restoreAllMocks();
        await handle?.close();
        if (originalConfig === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
        else process.env.ORION_CODE_CONFIG_DIR = originalConfig;
        rmSync(fixture, { recursive: true, force: true });
      }
    },
    15_000
  );
});
