import childProcess from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';

import {
  createSession,
  loadSessionMeta,
  resolveProjectPath,
} from '../src/services/session-storage';
import { WebWorkbenchController } from '../src/web/workbench-controller';
import { createFakeWebRuntime } from './support/web-runtime';
import { resolveProjectStoragePathAsync } from '../src/product/paths';

describe('responsive Web Session creation', () => {
  let workspace: string;
  let controller: WebWorkbenchController | undefined;
  const originalPath = process.env.PATH;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'orion-responsive-session-'));
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    jest.restoreAllMocks();
    await controller?.shutdown();
    controller = undefined;
    rmSync(workspace, { recursive: true, force: true });
  });

  async function boot(): Promise<WebWorkbenchController> {
    controller = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async cwd => createFakeWebRuntime(cwd),
      createSessionRuntime: jest.fn(async cwd => createFakeWebRuntime(cwd)),
    });
    return controller;
  }

  test('supplied branch metadata bypasses synchronous Git while legacy callers retain it', () => {
    resolveProjectPath(workspace);
    const syncGit = jest.spyOn(childProcess, 'execFileSync').mockReturnValue('legacy-branch\n');
    const supplied = createSession(workspace, 'test-model', { gitBranch: 'web-branch' });
    const unavailable = createSession(workspace, 'test-model', {});
    expect(supplied.gitBranch).toBe('web-branch');
    expect(unavailable.gitBranch).toBeUndefined();
    expect(syncGit).not.toHaveBeenCalled();

    const legacy = createSession(workspace, 'test-model');
    expect(legacy.gitBranch).toBe('legacy-branch');
    expect(syncGit).toHaveBeenCalledTimes(1);
  });

  test('pending Git allows event-loop work and Session selection without creating actors', async () => {
    const host = await boot();
    const existing = createSession(workspace, 'test-model', {});
    let finishProbe!: (error: Error | null, stdout: string) => void;
    const asyncGit = jest.spyOn(childProcess, 'execFile').mockImplementation(((
      ...args: unknown[]
    ) => {
      finishProbe = args[3] as typeof finishProbe;
      return new childProcess.ChildProcess();
    }) as typeof childProcess.execFile);
    const syncGit = jest.spyOn(childProcess, 'execFileSync');
    const pending = host.createSession('new session');
    let completed = false;
    void pending.then(() => {
      completed = true;
    });

    await new Promise<void>(resolve => setImmediate(resolve));
    expect(completed).toBe(false);
    expect(host.listSessions().map(session => session.id)).toContain(existing.id);
    expect(await host.activateSession(existing.id)).toMatchObject({
      result: 'foreground_session_selected',
      sessionRuntime: { phase: 'cold', resident: false },
    });
    expect(asyncGit).toHaveBeenCalledWith(
      'git',
      ['-C', realpathSync(workspace), 'rev-parse', '--abbrev-ref', 'HEAD'],
      expect.objectContaining({ timeout: 250, killSignal: 'SIGKILL', maxBuffer: 4_096 }),
      expect.any(Function)
    );

    finishProbe(null, 'feature/responsive\n');
    const created = await pending;
    expect(loadSessionMeta(created.id)?.gitBranch).toBe('feature/responsive');
    expect(syncGit).not.toHaveBeenCalled();
    expect(host.sessionRuntimeSummary(created.id)).toMatchObject({
      phase: 'cold',
      resident: false,
    });
    expect(host.runtime.getSession()).toBeNull();
  });

  test('rechecks Context after the probe before creating any durable Session', async () => {
    const host = await boot();
    const nextWorkspace = join(workspace, 'next');
    mkdirSync(nextWorkspace);
    await resolveProjectStoragePathAsync(nextWorkspace);
    let finishProbe!: (error: Error | null, stdout: string) => void;
    jest.spyOn(childProcess, 'execFile').mockImplementation(((...args: unknown[]) => {
      finishProbe = args[3] as typeof finishProbe;
      return new childProcess.ChildProcess();
    }) as typeof childProcess.execFile);
    const baseline = host.bootstrap('nonce');
    const pending = host.createSession('stale creation', {
      workspaceId: baseline.workspaceId,
      expectedContextRevision: baseline.contextRevision,
    });
    await host.switchWorkspace(nextWorkspace, {
      workspaceId: baseline.workspaceId,
      expectedContextRevision: baseline.contextRevision,
    });
    finishProbe(null, 'old-workspace-branch');
    await expect(pending).rejects.toMatchObject({ code: 'context_revision_conflict' });
    expect(host.listSessions()).toEqual([]);
    await host.switchWorkspace(workspace, {
      workspaceId: host.bootstrap('nonce').workspaceId,
      expectedContextRevision: host.contextRevision,
    });
    expect(host.listSessions()).toEqual([]);
  });

  (process.platform === 'win32' ? test.skip : test)(
    'a real slow Git subprocess is killed within the metadata budget and creation succeeds',
    async () => {
      const host = await boot();
      const gitBin = join(workspace, 'bin');
      mkdirSync(gitBin);
      const marker = join(workspace, 'git-started');
      const script = "#!/bin/sh\n: > '" + marker.replace(/'/g, "'\\''") + "'\nexec /bin/sleep 60\n";
      writeFileSync(join(gitBin, 'git'), script, {
        mode: 0o755,
      });
      process.env.PATH = `${gitBin}${delimiter}${originalPath ?? ''}`;
      const nativeExec = childProcess.execFile;
      let probeError: childProcess.ExecFileException | null = null;
      jest.spyOn(childProcess, 'execFile').mockImplementation(((...args: unknown[]) =>
        nativeExec(
          join(gitBin, 'git'),
          args[1] as string[],
          args[2] as childProcess.ExecFileOptionsWithStringEncoding,
          (error, stdout, stderr) => {
            probeError = error;
            (
              args[3] as (
                error: childProcess.ExecFileException | null,
                stdout: string,
                stderr: string
              ) => void
            )(error, stdout, stderr);
          }
        )) as typeof childProcess.execFile);
      const startedAt = Date.now();
      const created = await host.createSession('Git timeout');
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      // A busy machine may exhaust the budget before the shell writes its
      // marker; the native process still must be killed, never wait for sleep.
      expect(probeError).toMatchObject({ killed: true, signal: 'SIGKILL' });
      expect(loadSessionMeta(created.id)?.gitBranch).toBeUndefined();
      expect(host.listSessions().map(session => session.id)).toContain(created.id);
    }
  );
});
