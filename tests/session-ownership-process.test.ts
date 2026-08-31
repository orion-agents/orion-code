import { fork, type ChildProcess } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ProductOrionAcpRuntimePort } from '../src/acp/product-runtime-port';
import { createSession } from '../src/services/session-storage';

describe('renderer-neutral Session ownership across processes', () => {
  const originalDataDirectory = process.env.ORION_CODE_DATA_DIR;
  const originalConfigDirectory = process.env.ORION_CODE_CONFIG_DIR;
  const originalDisableEnvironmentFiles = process.env.ORION_CODE_DISABLE_ENV_FILES;
  let root: string;
  let cwd: string;
  let sessionId: string;
  let children: ChildProcess[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-session-ownership-'));
    cwd = join(root, 'workspace');
    mkdirSync(cwd);
    process.env.ORION_CODE_DATA_DIR = join(root, 'data');
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');
    process.env.ORION_CODE_DISABLE_ENV_FILES = '1';
    sessionId = createSession(cwd, 'test-model').id;
    children = [];
  });

  afterEach(async () => {
    await Promise.all(children.map(child => stopChild(child)));
    restoreEnvironment('ORION_CODE_DATA_DIR', originalDataDirectory);
    restoreEnvironment('ORION_CODE_CONFIG_DIR', originalConfigDirectory);
    restoreEnvironment('ORION_CODE_DISABLE_ENV_FILES', originalDisableEnvironmentFiles);
    rmSync(root, { recursive: true, force: true });
  });

  test.each(['cli', 'web', 'acp'] as const)(
    '%s owner excludes an ACP owner in the same data root',
    async mode => {
      const child = await startOwner(mode, sessionId, cwd);
      children.push(child);
      const contender = new ProductOrionAcpRuntimePort();

      await expect(
        contender.loadSession({ sessionId, cwd, mcpServers: [], observer: fixtureObserver })
      ).rejects.toMatchObject({ code: 'ORION_ACP_SESSION_BUSY' });
      await contender.close();
    }
  );

  test('recovers ownership after an owner is forcibly terminated', async () => {
    const child = await startOwner('cli', sessionId, cwd);
    children.push(child);
    child.kill('SIGKILL');
    await waitForExit(child);

    const recovered = new ProductOrionAcpRuntimePort();
    await expect(
      recovered.loadSession({ sessionId, cwd, mcpServers: [], observer: fixtureObserver })
    ).resolves.toBeUndefined();
    await recovered.close();
  });
});

const fixtureObserver = {
  update: async () => undefined,
  requestPermission: async () => false,
};

async function startOwner(
  mode: 'cli' | 'web' | 'acp',
  sessionId: string,
  cwd: string
): Promise<ChildProcess> {
  const fixture = join(__dirname, 'fixtures', 'acp-v1', 'session-owner-child.ts');
  const child = fork(fixture, [mode, sessionId, cwd], {
    cwd: join(__dirname, '..'),
    execArgv: ['-r', require.resolve('ts-node/register/transpile-only')],
    env: { ...process.env },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${mode} owner did not become ready.`)),
      15_000
    );
    const stderr: Buffer[] = [];
    child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('exit', code => {
      reject(
        new Error(
          `${mode} owner exited before ready (${code ?? 'signal'}): ${Buffer.concat(stderr).toString('utf8')}`
        )
      );
    });
    child.on('message', message => {
      if (!message || typeof message !== 'object') return;
      if ((message as { type?: unknown }).type === 'ready') {
        clearTimeout(timeout);
        resolve();
      }
      if ((message as { type?: unknown }).type === 'error') {
        clearTimeout(timeout);
        reject(new Error(String((message as { message?: unknown }).message)));
      }
    });
  });
  return child;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await waitForExit(child);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => child.once('exit', () => resolve()));
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
