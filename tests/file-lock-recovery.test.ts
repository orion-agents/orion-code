import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setTimeout as delay } from 'timers/promises';

const RECOVERY_WORKER = String.raw`
const fs = require('fs');
const role = process.env.ORION_TEST_ROLE;
const targetPath = process.env.ORION_TEST_TARGET;
const lockPath = targetPath + '.lock';
const readyPath = process.env.ORION_TEST_READY;
const attemptPath = process.env.ORION_TEST_ATTEMPT;
const releasePath = process.env.ORION_TEST_RELEASE;
const finishPath = process.env.ORION_TEST_FINISH;
const resultPath = process.env.ORION_TEST_RESULT;
const originalRenameSync = fs.renameSync.bind(fs);
const originalWriteFileSync = fs.writeFileSync.bind(fs);
const sleep = ms => {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
};

if (role === 'a') {
  let paused = false;
  fs.renameSync = (source, destination) => {
    if (
      !paused &&
      source === lockPath &&
      typeof destination === 'string' &&
      destination.includes('.stale-')
    ) {
      paused = true;
      originalWriteFileSync(readyPath, 'ready');
      while (!fs.existsSync(releasePath)) sleep(10);
    }
    return originalRenameSync(source, destination);
  };
}

const { withFileLockSync } = require('./src/services/file-lock');
originalWriteFileSync(attemptPath, 'attempt');
try {
  withFileLockSync(
    targetPath,
    () => {
      originalWriteFileSync(resultPath, JSON.stringify({ acquired: true, role }));
      while (!fs.existsSync(finishPath)) sleep(10);
    },
    { waitMs: role === 'a' ? 3_000 : 1_000, retryMs: 5, staleMs: 50 },
  );
} catch (error) {
  originalWriteFileSync(
    resultPath,
    JSON.stringify({
      acquired: false,
      role,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}
`;

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await delay(10);
  }
}

describe('file-lock stale recovery serialization', () => {
  it('does not let a stale recovery move a replacement owner lock', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-file-lock-recovery-'));
    const targetPath = path.join(tempDir, 'registry');
    const lockPath = `${targetPath}.lock`;
    const releasePath = path.join(tempDir, 'release');
    const finishPath = path.join(tempDir, 'finish');
    const children: ChildProcessWithoutNullStreams[] = [];
    const diagnostics = new Map<
      ChildProcessWithoutNullStreams,
      { stdout: string; stderr: string }
    >();

    fs.writeFileSync(
      lockPath,
      JSON.stringify({ token: 'dead-owner', pid: 999_999_999, createdAt: Date.now() - 10_000 }),
      { mode: 0o600 }
    );
    const staleTime = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    const startWorker = (role: 'a' | 'b'): ChildProcessWithoutNullStreams => {
      const child = spawn(
        process.execPath,
        ['-r', require.resolve('ts-node/register/transpile-only'), '-e', RECOVERY_WORKER],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ORION_TEST_ROLE: role,
            ORION_TEST_TARGET: targetPath,
            ORION_TEST_READY: path.join(tempDir, `${role}-ready`),
            ORION_TEST_ATTEMPT: path.join(tempDir, `${role}-attempt`),
            ORION_TEST_RELEASE: releasePath,
            ORION_TEST_FINISH: finishPath,
            ORION_TEST_RESULT: path.join(tempDir, `${role}-result.json`),
          },
        }
      );
      const output = { stdout: '', stderr: '' };
      child.stdout.on('data', chunk => (output.stdout += String(chunk)));
      child.stderr.on('data', chunk => (output.stderr += String(chunk)));
      diagnostics.set(child, output);
      children.push(child);
      return child;
    };

    const waitForExit = (child: ChildProcessWithoutNullStreams): Promise<void> =>
      new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => {
          if (code === 0) {
            resolve();
            return;
          }
          const output = diagnostics.get(child);
          reject(
            new Error(
              `recovery worker exited with ${code}\n${output?.stdout ?? ''}\n${output?.stderr ?? ''}`
            )
          );
        });
      });

    try {
      const first = startWorker('a');
      const firstExit = waitForExit(first);
      await waitForFile(path.join(tempDir, 'a-ready'));

      const second = startWorker('b');
      const secondExit = waitForExit(second);
      await waitForFile(path.join(tempDir, 'b-attempt'));
      await delay(250);
      fs.writeFileSync(releasePath, 'release');

      const firstResultPath = path.join(tempDir, 'a-result.json');
      const secondResultPath = path.join(tempDir, 'b-result.json');
      await Promise.all([waitForFile(firstResultPath), waitForFile(secondResultPath)]);
      const results = [firstResultPath, secondResultPath].map(
        file =>
          JSON.parse(fs.readFileSync(file, 'utf8')) as {
            acquired: boolean;
            role: string;
            message?: string;
          }
      );
      const acquired = results.filter(result => result.acquired);
      const rejected = results.filter(result => !result.acquired);

      expect(acquired).toEqual([{ acquired: true, role: 'a' }]);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].message).toMatch(/Timed out waiting for file lock/);

      fs.writeFileSync(finishPath, 'finish');
      await Promise.all([firstExit, secondExit]);
    } finally {
      fs.writeFileSync(releasePath, 'release');
      fs.writeFileSync(finishPath, 'finish');
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 20_000);
});
