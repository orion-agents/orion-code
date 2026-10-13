import childProcess from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';

import {
  getProjectSessionMetaPath,
  resolveProjectStoragePath,
  resolveProjectStoragePathAsync,
} from '../src/product/paths';

describe('project storage identity cache', () => {
  let fixture: string;
  const originalPath = process.env.PATH;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'orion-storage-identity-'));
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    jest.restoreAllMocks();
    rmSync(fixture, { recursive: true, force: true });
  });

  function git(cwd: string, args: readonly string[]): void {
    childProcess.execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', timeout: 5_000 });
  }

  test('reuses storage identity across metadata reads without repeat Git subprocesses', () => {
    git(fixture, ['init']);
    const nested = join(fixture, 'nested');
    mkdirSync(nested);
    const probe = jest.spyOn(childProcess, 'execFileSync');
    for (let index = 0; index < 20; index += 1) {
      expect(getProjectSessionMetaPath(nested, 'test-session')).toBe(
        getProjectSessionMetaPath(fixture, 'test-session')
      );
    }
    expect(probe).toHaveBeenCalledTimes(2);
  });

  test('async cold discovery is single-flight and seeds subsequent synchronous storage reads', async () => {
    git(fixture, ['init']);
    let finish!: (error: Error | null, stdout: string) => void;
    const asyncProbe = jest.spyOn(childProcess, 'execFile').mockImplementation(((
      ...args: unknown[]
    ) => {
      finish = args[3] as typeof finish;
      return new childProcess.ChildProcess();
    }) as typeof childProcess.execFile);
    const syncProbe = jest.spyOn(childProcess, 'execFileSync');
    const requests = Array.from({ length: 20 }, () => resolveProjectStoragePathAsync(fixture));
    await new Promise<void>(resolveYield => setImmediate(resolveYield));
    expect(asyncProbe).toHaveBeenCalledTimes(1);
    expect(syncProbe).not.toHaveBeenCalled();
    finish(null, realpathSync(fixture) + '\n');
    expect(await Promise.all(requests)).toEqual(Array(20).fill(realpathSync(fixture)));
    for (let index = 0; index < 20; index += 1) resolveProjectStoragePath(fixture);
    expect(syncProbe).not.toHaveBeenCalled();
  });

  test('does not publish an asynchronous identity under a changed Git boundary', async () => {
    git(fixture, ['init']);
    let finish!: (error: Error | null, stdout: string) => void;
    jest.spyOn(childProcess, 'execFile').mockImplementation(((...args: unknown[]) => {
      finish = args[3] as typeof finish;
      return new childProcess.ChildProcess();
    }) as typeof childProcess.execFile);
    const resolving = resolveProjectStoragePathAsync(fixture);
    git(fixture, ['config', 'core.worktree', join(fixture, 'new-root')]);
    finish(null, realpathSync(fixture) + '\n');
    await expect(resolving).rejects.toThrow('identity changed');
  });

  test('detects new nested repos and removed Git boundaries instead of pinning stale roots', () => {
    git(fixture, ['init']);
    const nested = join(fixture, 'nested');
    mkdirSync(nested);
    expect(resolveProjectStoragePath(nested)).toBe(realpathSync(fixture));
    git(nested, ['init']);
    expect(resolveProjectStoragePath(nested)).toBe(realpathSync(nested));
    rmSync(join(nested, '.git'), { recursive: true, force: true });
    expect(resolveProjectStoragePath(nested)).toBe(realpathSync(fixture));
  });

  test('keeps worktrees distinct and detects changed symlink destinations', () => {
    git(fixture, ['init']);
    git(fixture, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ]);
    const worktree = join(fixture, 'worktree');
    git(fixture, ['worktree', 'add', '--detach', worktree]);
    expect(resolveProjectStoragePath(worktree)).toBe(realpathSync(worktree));
    expect(resolveProjectStoragePath(fixture)).toBe(realpathSync(fixture));
    if (process.platform !== 'win32') {
      const alias = join(fixture, 'alias');
      symlinkSync(fixture, alias);
      expect(resolveProjectStoragePath(alias)).toBe(realpathSync(fixture));
      rmSync(alias);
      symlinkSync(worktree, alias);
      expect(resolveProjectStoragePath(alias)).toBe(realpathSync(worktree));
    }
  });

  test('rechecks a repository whose configured external worktree root changes', () => {
    git(fixture, ['init']);
    expect(resolveProjectStoragePath(fixture)).toBe(realpathSync(fixture));
    const externalRoot = join(fixture, 'external-root');
    mkdirSync(externalRoot);
    git(fixture, ['config', 'core.worktree', externalRoot]);
    expect(resolveProjectStoragePath(fixture)).toBe(realpathSync(externalRoot));
    git(fixture, ['config', '--unset', 'core.worktree']);
    expect(resolveProjectStoragePath(fixture)).toBe(realpathSync(fixture));
  });

  test('invalidates per-worktree config without repeating warm repository probes', () => {
    git(fixture, ['init']);
    git(fixture, ['config', 'extensions.worktreeConfig', 'true']);
    const externalRoot = join(fixture, 'external-root');
    mkdirSync(externalRoot);
    const probe = jest.spyOn(childProcess, 'execFileSync');
    expect(resolveProjectStoragePath(fixture)).toBe(realpathSync(fixture));
    git(fixture, ['config', '--worktree', 'core.worktree', externalRoot]);
    expect(resolveProjectStoragePath(fixture)).toBe(realpathSync(externalRoot));
    for (let index = 0; index < 20; index += 1) {
      expect(resolveProjectStoragePath(fixture)).toBe(realpathSync(externalRoot));
    }
    git(fixture, ['config', '--worktree', '--unset', 'core.worktree']);
    expect(resolveProjectStoragePath(fixture)).toBe(realpathSync(fixture));
    const rootProbes = probe.mock.calls.filter(([, args]) => args?.includes('rev-parse'));
    expect(rootProbes).toHaveLength(3);
  });

  test('tracks linked gitdir config and shared worktree-config enablement', () => {
    git(fixture, ['init']);
    git(fixture, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ]);
    git(fixture, ['config', 'extensions.worktreeConfig', 'true']);
    const worktree = join(fixture, 'linked');
    const externalRoot = join(fixture, 'external-root');
    mkdirSync(externalRoot);
    git(fixture, ['worktree', 'add', '--detach', worktree]);
    const probe = jest.spyOn(childProcess, 'execFileSync');
    expect(resolveProjectStoragePath(worktree)).toBe(realpathSync(worktree));
    git(worktree, ['config', '--worktree', 'core.worktree', externalRoot]);
    expect(resolveProjectStoragePath(worktree)).toBe(realpathSync(externalRoot));
    for (let index = 0; index < 20; index += 1) {
      expect(resolveProjectStoragePath(worktree)).toBe(realpathSync(externalRoot));
    }
    git(fixture, ['config', 'extensions.worktreeConfig', 'false']);
    expect(resolveProjectStoragePath(worktree)).toBe(realpathSync(worktree));
    git(fixture, ['config', 'extensions.worktreeConfig', 'true']);
    expect(resolveProjectStoragePath(worktree)).toBe(realpathSync(externalRoot));
    git(worktree, ['config', '--worktree', '--unset', 'core.worktree']);
    expect(resolveProjectStoragePath(worktree)).toBe(realpathSync(worktree));
    const rootProbes = probe.mock.calls.filter(([, args]) => args?.includes('rev-parse'));
    expect(rootProbes).toHaveLength(5);
  });

  (process.platform === 'win32' ? test.skip : test)(
    'bounds a real slow first subprocess probe and reuses the folder result afterward',
    () => {
      const gitBin = join(fixture, 'bin');
      mkdirSync(gitBin);
      const marker = join(fixture, 'git-started');
      const script = "#!/bin/sh\n: > '" + marker.replace(/'/g, "'\\''") + "'\nexec /bin/sleep 60\n";
      writeFileSync(join(gitBin, 'git'), script, { mode: 0o755 });
      process.env.PATH = gitBin + delimiter + (originalPath ?? '');
      const nativeExec = childProcess.execFileSync;
      let failureCode: string | undefined;
      const probe = jest.spyOn(childProcess, 'execFileSync').mockImplementation(((
        _file: string,
        args: readonly string[],
        options: childProcess.ExecFileSyncOptionsWithStringEncoding
      ) => {
        try {
          return nativeExec(join(gitBin, 'git'), args, options);
        } catch (error) {
          failureCode = (error as NodeJS.ErrnoException).code;
          throw error;
        }
      }) as typeof childProcess.execFileSync);
      const startedAt = Date.now();
      expect(resolveProjectStoragePath(fixture)).toBe(realpathSync(fixture));
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(failureCode).toBe('ETIMEDOUT');
      for (let index = 0; index < 20; index += 1) resolveProjectStoragePath(fixture);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledWith(
        'git',
        expect.any(Array),
        expect.objectContaining({ timeout: 250, killSignal: 'SIGKILL' })
      );
    }
  );
});
