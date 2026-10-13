import childProcess from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { performance } from 'perf_hooks';
import {
  createSession,
  createSessionAsync,
  prepareSessionCatalogAsync,
  listSessions,
  type SessionMeta,
} from '../src/services/session-storage';
import {
  encodeProjectPath,
  getProjectSessionsDir,
  resolveProjectStoragePathAsync,
} from '../src/product/paths';
import * as atomicWrite from '../src/services/atomic-write';

describe('nonblocking Web storage admission', () => {
  let fixture: string;
  let workspace: string;
  let config: string;
  const originalConfig = process.env.ORION_CODE_CONFIG_DIR;
  const children = new Set<childProcess.ChildProcess>();

  beforeEach(async () => {
    fixture = mkdtempSync(join(tmpdir(), 'orion-storage-admission-'));
    workspace = join(fixture, 'workspace');
    config = join(fixture, 'config');
    mkdirSync(workspace);
    mkdirSync(config);
    process.env.ORION_CODE_CONFIG_DIR = config;
    await resolveProjectStoragePathAsync(workspace);
  });

  afterEach(() => {
    for (const child of children) child.kill('SIGKILL');
    children.clear();
    jest.restoreAllMocks();
    if (originalConfig === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = originalConfig;
    rmSync(fixture, { recursive: true, force: true });
  });

  async function holdCatalogLock(milliseconds: number): Promise<void> {
    const lock = join(config, 'session-catalog.json.lock');
    const child = childProcess.spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('fs'),crypto=require('crypto');
         const lock=process.argv[1],token=crypto.randomUUID(),candidate=lock+'.candidate-'+token;
         fs.writeFileSync(candidate,JSON.stringify({token,pid:process.pid,createdAt:Date.now()}));
         fs.linkSync(candidate,lock);fs.unlinkSync(candidate);
         process.stdout.write('ready\\n');
         setTimeout(()=>{fs.unlinkSync(lock);},Number(process.argv[2]));`,
        lock,
        String(milliseconds),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    children.add(child);
    await new Promise<void>((resolveReady, rejectReady) => {
      child.stdout!.once('data', () => resolveReady());
      child.once('error', rejectReady);
      child.once('exit', code => {
        children.delete(child);
        if (code !== 0) rejectReady(new Error(`Lock contender exited ${code}`));
      });
    });
  }

  async function sample(operation: () => unknown | Promise<unknown>) {
    const start = performance.now();
    const heartbeat = new Promise<number>(resolveHeartbeat =>
      setImmediate(() => resolveHeartbeat(performance.now() - start))
    );
    await operation();
    return { totalMs: performance.now() - start, heartbeatMs: await heartbeat };
  }

  function summarize(samples: { totalMs: number; heartbeatMs: number }[]) {
    const percentile = (key: 'totalMs' | 'heartbeatMs', ratio: number) =>
      samples.map(sample => sample[key]).sort((a, b) => a - b)[
        Math.ceil(samples.length * ratio) - 1
      ];
    return {
      samples,
      totalP50Ms: percentile('totalMs', 0.5),
      totalP95Ms: percentile('totalMs', 0.95),
      heartbeatP95Ms: percentile('heartbeatMs', 0.95),
    };
  }

  test('Catalog contention yields the event loop while retaining cross-process exclusion', async () => {
    createSession(workspace, 'fixture', {});
    const baseline = [];
    const candidate = [];
    for (let index = 0; index < 20; index += 1) {
      await holdCatalogLock(100);
      baseline.push(await sample(() => createSession(workspace, 'baseline', {})));
      await holdCatalogLock(100);
      candidate.push(await sample(() => createSessionAsync(workspace, 'candidate')));
    }
    const report = { baseline: summarize(baseline), candidate: summarize(candidate) };
    console.log('V0324_CATALOG_CONTENTION', JSON.stringify(report));
    expect(report.baseline.heartbeatP95Ms).toBeGreaterThan(70);
    expect(report.candidate.heartbeatP95Ms).toBeLessThan(50);
    expect(listSessions(100).length).toBe(41);
    const catalog = JSON.parse(readFileSync(join(config, 'session-catalog.json'), 'utf8'));
    expect(Object.keys(catalog.sessions)).toHaveLength(41);
    expect(new Set(listSessions(100).map(session => session.id)).size).toBe(41);
  }, 30_000);

  test('a timeout or changed Context commits no Session metadata', async () => {
    const initial = createSession(workspace, 'existing', {});
    await holdCatalogLock(500);
    await expect(createSessionAsync(workspace, 'fixture', { waitMs: 20 })).rejects.toThrow(
      'Timed out waiting for file lock'
    );
    expect(readdirSync(getProjectSessionsDir(workspace))).toEqual([`${initial.id}.json`]);
    let checks = 0;
    await expect(
      createSessionAsync(workspace, 'fixture', {
        beforeCommit: () => {
          checks += 1;
          if (checks > 1) throw new Error('Context changed');
        },
      })
    ).rejects.toThrow('Context changed');
    expect(readdirSync(getProjectSessionsDir(workspace))).toEqual([`${initial.id}.json`]);
    expect(listSessions(100)).toHaveLength(1);
  });

  test('Catalog write failure rolls back unpublished Session metadata', async () => {
    const initial = createSession(workspace, 'existing', {});
    const atomic = atomicWrite.atomicWriteFileSync;
    jest.spyOn(atomicWrite, 'atomicWriteFileSync').mockImplementation((path, ...args) => {
      if (path === join(config, 'session-catalog.json')) throw new Error('disk write failed');
      return atomic(path, ...args);
    });
    await expect(createSessionAsync(workspace, 'fixture')).rejects.toThrow('disk write failed');
    expect(readdirSync(getProjectSessionsDir(workspace))).toEqual([`${initial.id}.json`]);
    expect(existsSync(join(config, 'session-catalog.json.lock'))).toBe(false);
  });

  test('cold scan notices modified, deleted and added metadata before publication', async () => {
    const initial = createSession(workspace, 'initial', {});
    const removed = createSession(workspace, 'removed', {});
    const sessionsDirectory = getProjectSessionsDir(workspace);
    const firstPath = join(sessionsDirectory, `${initial.id}.json`);
    unlinkSync(join(config, 'session-catalog.json'));
    const fsPromises = (await import('fs')).promises;
    const nativeRead = fsPromises.readFile;
    let release!: () => void;
    let paused!: () => void;
    const readPaused = new Promise<void>(resolvePaused => {
      paused = resolvePaused;
    });
    const gate = new Promise<void>(resolveGate => {
      release = resolveGate;
    });
    let intercepted = false;
    jest.spyOn(fsPromises, 'readFile').mockImplementation((async (
      ...args: Parameters<typeof nativeRead>
    ) => {
      const bytes = await nativeRead(...args);
      if (args[0] === firstPath && !intercepted) {
        intercepted = true;
        paused();
        await gate;
      }
      return bytes;
    }) as typeof nativeRead);
    const preparing = prepareSessionCatalogAsync();
    await readPaused;
    writeFileSync(firstPath, JSON.stringify({ ...initial, name: 'changed-after-read' }));
    unlinkSync(join(sessionsDirectory, `${removed.id}.json`));
    const added = { ...initial, id: 'added-during-scan', name: 'added' };
    writeFileSync(join(sessionsDirectory, `${added.id}.json`), JSON.stringify(added));
    release();
    await preparing;
    const catalog = listSessions(100);
    expect(catalog.map(session => session.id).sort()).toEqual([initial.id, added.id].sort());
    expect(catalog.find(session => session.id === initial.id)?.name).toBe('changed-after-read');
  });

  test('a Catalog published by a writer during cold scanning wins over the scan', async () => {
    const initial = createSession(workspace, 'initial', {});
    unlinkSync(join(config, 'session-catalog.json'));
    const fsPromises = (await import('fs')).promises;
    const nativeRead = fsPromises.readFile;
    let release!: () => void;
    let paused!: () => void;
    const readPaused = new Promise<void>(resolvePaused => {
      paused = resolvePaused;
    });
    const gate = new Promise<void>(resolveGate => {
      release = resolveGate;
    });
    let intercepted = false;
    jest.spyOn(fsPromises, 'readFile').mockImplementation((async (
      ...args: Parameters<typeof nativeRead>
    ) => {
      const bytes = await nativeRead(...args);
      if (!intercepted) {
        intercepted = true;
        paused();
        await gate;
      }
      return bytes;
    }) as typeof nativeRead);
    const preparing = prepareSessionCatalogAsync();
    await readPaused;
    const concurrent = createSession(workspace, 'concurrent', {});
    release();
    await preparing;
    expect(
      listSessions(100)
        .map(session => session.id)
        .sort()
    ).toEqual([initial.id, concurrent.id].sort());
  });

  test('async admission retains dead-owner recovery and concurrent-process Catalog updates', async () => {
    const lock = join(config, 'session-catalog.json.lock');
    writeFileSync(
      lock,
      JSON.stringify({ token: 'dead-owner', pid: 2_147_483_647, createdAt: Date.now() - 60_000 })
    );
    const staleTime = new Date(Date.now() - 60_000);
    utimesSync(lock, staleTime, staleTime);
    await createSessionAsync(workspace, 'recovered');
    const concurrent = childProcess.spawn(
      process.execPath,
      [
        '-r',
        'ts-node/register/transpile-only',
        '-e',
        `const storage=require('./src/services/session-storage');
         for(let i=0;i<12;i++)storage.createSession(process.argv[1],'external',{});`,
        workspace,
      ],
      { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    children.add(concurrent);
    const completed = new Promise<void>((resolveChild, rejectChild) => {
      concurrent.once('error', rejectChild);
      concurrent.once('exit', code => {
        children.delete(concurrent);
        if (code === 0) resolveChild();
        else rejectChild(new Error(`Catalog writer exited ${code}`));
      });
    });
    await Promise.all([
      completed,
      ...Array.from({ length: 12 }, () => createSessionAsync(workspace, 'host')),
    ]);
    const sessions = listSessions(100);
    expect(sessions).toHaveLength(25);
    expect(sessions.filter(session => session.model === 'external')).toHaveLength(12);
    expect(sessions.filter(session => session.model === 'host')).toHaveLength(12);
    expect(existsSync(lock)).toBe(false);
  }, 20_000);

  test('cold and warm creation preserve 1000-session Catalog rebuild and ownership', async () => {
    const canonical = realpathSync(workspace);
    const sessionsDirectory = join(config, 'projects', encodeProjectPath(canonical), 'sessions');
    mkdirSync(sessionsDirectory, { recursive: true });
    for (let index = 0; index < 1000; index += 1) {
      const session: SessionMeta = {
        id: `fixture-${index}`,
        projectPath: canonical,
        model: 'fixture',
        startTime: index + 1,
        messageCount: 0,
        historySizeBytes: 0,
        tokenCount: 0,
        cost: 0,
      };
      writeFileSync(join(sessionsDirectory, `${session.id}.json`), JSON.stringify(session));
    }
    const cold = await sample(() => createSessionAsync(workspace, 'cold'));
    const warm = [];
    for (let index = 0; index < 20; index += 1) {
      warm.push(await sample(() => createSessionAsync(workspace, 'warm')));
    }
    console.log('V0324_CATALOG_1000', JSON.stringify({ cold, warm: summarize(warm) }));
    expect(listSessions(2000)).toHaveLength(1021);
    // A corrupt index can still be rebuilt from authoritative Session files.
    unlinkSync(join(config, 'session-catalog.json'));
    await createSessionAsync(workspace, 'rebuild');
    expect(listSessions(2000)).toHaveLength(1022);
  }, 15_000);
});
