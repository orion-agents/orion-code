import childProcess from 'child_process';
import fs from 'fs';
import { randomUUID } from 'crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createSessionAsync,
  listSessions,
  type SessionMeta,
} from '../src/services/session-storage';
import { encodeProjectPath } from '../src/product/paths';
import { WebWorkbenchController } from '../src/web/workbench-controller';
import { createFakeWebRuntime } from './support/web-runtime';

describe('Web storage identity admission boundaries', () => {
  let fixture: string;
  let workspace: string;
  let config: string;
  const variables = ['ORION_CODE_CONFIG_DIR', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'];
  let previous: Record<string, string | undefined>;
  const git = (cwd: string, args: string[]) =>
    childProcess.execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
  beforeEach(() => {
    previous = Object.fromEntries(variables.map(key => [key, process.env[key]]));
    for (const key of variables) delete process.env[key];
    fixture = mkdtempSync(join(tmpdir(), 'orion-identity-admission-'));
    workspace = join(fixture, 'workspace');
    config = join(fixture, 'config');
    mkdirSync(workspace);
    process.env.ORION_CODE_CONFIG_DIR = config;
    git(workspace, ['init']);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of variables) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(fixture, { recursive: true, force: true });
  });

  test.each(['absolute', 'relative'])(
    'explicit %s Git env creates without any synchronous Git subprocess',
    async form => {
      process.env.GIT_DIR = form === 'relative' ? '.git' : join(workspace, '.git');
      process.env.GIT_COMMON_DIR = form === 'relative' ? '.git' : join(workspace, '.git');
      process.env.GIT_WORK_TREE = form === 'relative' ? '.' : workspace;
      const sync = jest.spyOn(childProcess, 'execFileSync');
      const created = await createSessionAsync(workspace, 'fixture');
      expect(created.projectPath).toBe(realpathSync(workspace));
      expect(sync).not.toHaveBeenCalled();
      const path = join(config, 'projects', created.projectKey!, 'sessions', `${created.id}.json`);
      expect(JSON.parse(readFileSync(path, 'utf8')).id).toBe(created.id);
    }
  );

  test('an existing Host can create under explicit Git env without synchronous re-probing', async () => {
    const host = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async cwd => createFakeWebRuntime(cwd),
    });
    try {
      process.env.GIT_DIR = '.git';
      process.env.GIT_COMMON_DIR = '.git';
      process.env.GIT_WORK_TREE = '.';
      const sync = jest.spyOn(childProcess, 'execFileSync');
      await host.createSession('explicit-env');
      expect(sync).not.toHaveBeenCalled();
    } finally {
      await host.shutdown();
    }
  });

  test('a realpath race returns the stable retryable error without a Session write', async () => {
    jest.spyOn(fs, 'realpathSync').mockImplementationOnce(() => {
      throw new Error('symlink changed');
    });
    await expect(createSessionAsync(workspace, 'race')).rejects.toMatchObject({
      code: 'project_storage_identity_unavailable',
    });
    expect(fs.existsSync(join(config, 'session-catalog.json'))).toBe(false);
  });

  test.each(['nested-repo', 'core-worktree', 'environment', 'relative-gitdir-config'])(
    'rejects %s identity changes during real Catalog-lock waiting',
    async change => {
      const initial = await createSessionAsync(workspace, 'initial');
      const nested = join(workspace, 'nested');
      mkdirSync(nested);
      if (change === 'relative-gitdir-config') {
        process.env.GIT_DIR = '../.git';
        process.env.GIT_COMMON_DIR = '../.git';
        process.env.GIT_WORK_TREE = '..';
      }
      const catalog = join(config, 'session-catalog.json');
      const before = readFileSync(catalog, 'utf8');
      const lock = `${catalog}.lock`;
      writeFileSync(
        lock,
        JSON.stringify({ token: randomUUID(), pid: process.pid, createdAt: Date.now() })
      );
      let admitted!: () => void;
      const started = new Promise<void>(resolveStarted => {
        admitted = resolveStarted;
      });
      let checks = 0;
      const pending = createSessionAsync(nested, 'must-not-persist', {
        beforeCommit: () => {
          if (++checks === 2) admitted();
        },
      });
      await started;
      const external = join(fixture, 'external');
      mkdirSync(external);
      if (change === 'nested-repo') git(nested, ['init']);
      if (change === 'core-worktree' || change === 'relative-gitdir-config') {
        // Keep the actual filesystem mutation separate from the candidate's env.
        childProcess.execFileSync('git', ['-C', workspace, 'config', 'core.worktree', external], {
          env: {
            ...process.env,
            GIT_DIR: join(workspace, '.git'),
            GIT_COMMON_DIR: join(workspace, '.git'),
            GIT_WORK_TREE: workspace,
          },
        });
      }
      if (change === 'environment') process.env.GIT_WORK_TREE = external;
      await expect(pending).rejects.toMatchObject({ code: 'project_storage_identity_unavailable' });
      unlinkSync(lock);
      expect(readFileSync(catalog, 'utf8')).toBe(before);
      expect(readdirSync(join(config, 'projects', initial.projectKey!, 'sessions'))).toEqual([
        `${initial.id}.json`,
      ]);
    }
  );

  test('a broken historical repo cannot block healthy Host startup or migrate its stored root', async () => {
    const historical = join(fixture, 'historical');
    mkdirSync(historical);
    git(historical, ['init']);
    const canonical = realpathSync(historical);
    const id = randomUUID();
    const session: SessionMeta = {
      id,
      projectPath: canonical,
      projectKey: encodeProjectPath(canonical),
      model: 'historical',
      startTime: 1,
      tokenCount: 0,
      cost: 0,
    };
    const directory = join(config, 'projects', session.projectKey!, 'sessions');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${id}.json`), JSON.stringify(session));
    writeFileSync(join(historical, '.git', 'config'), '[broken config\n');
    const sync = jest.spyOn(childProcess, 'execFileSync');
    const async = jest.spyOn(childProcess, 'execFile');
    const host = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async cwd => createFakeWebRuntime(cwd),
    });
    try {
      expect(listSessions().find(item => item.id === id)?.projectPath).toBe(canonical);
      const created = await host.createSession('healthy');
      expect(created.projectPath).toBe(realpathSync(workspace));
      expect(listSessions()).toHaveLength(2);
      expect(sync).not.toHaveBeenCalled();
      expect(
        async.mock.calls.some(([, args]) => Array.isArray(args) && args.includes(historical))
      ).toBe(false);
    } finally {
      await host.shutdown();
    }
  });
});
