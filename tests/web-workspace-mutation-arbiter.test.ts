import {
  WorkspaceMutationArbiterError,
  WorkspaceMutationArbiterV1,
  type WorkspaceMutationStateV1,
} from '../src/web/workspace-mutation-arbiter';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('WorkspaceMutationArbiterV1', () => {
  it('serializes one Workspace FIFO while keeping different Workspaces concurrent', async () => {
    const states: WorkspaceMutationStateV1[] = [];
    const arbiter = new WorkspaceMutationArbiterV1({ onStateChanged: state => states.push(state) });
    const a = deferred<void>();
    const b = deferred<void>();
    const order: string[] = [];

    const first = arbiter.run(
      admission('workspace-a', 'first', () => 'r1'),
      async () => {
        order.push('first:start');
        await a.promise;
        order.push('first:end');
        return 'first';
      }
    );
    const second = arbiter.run(
      admission('workspace-a', 'second', () => 'r1'),
      async () => {
        order.push('second:start');
        return 'second';
      }
    );
    const other = arbiter.run(
      admission('workspace-b', 'other', () => 'r1'),
      async () => {
        order.push('other:start');
        await b.promise;
        return 'other';
      }
    );

    expect(
      states.find(state => state.invocationId === 'second' && state.phase === 'queued')
    ).toEqual(expect.objectContaining({ queuePosition: 1 }));

    await flushPromises();
    expect(order).toEqual(['first:start', 'other:start']);
    expect(arbiter.snapshot('workspace-a')).toEqual([
      expect.objectContaining({ invocationId: 'first', phase: 'running' }),
      expect.objectContaining({ invocationId: 'second', phase: 'queued', queuePosition: 1 }),
    ]);

    a.resolve();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    b.resolve();
    await expect(other).resolves.toBe('other');
    expect(order).toEqual(['first:start', 'other:start', 'first:end', 'second:start']);
    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ invocationId: 'second', phase: 'queued', queuePosition: 1 }),
        expect.objectContaining({ invocationId: 'second', phase: 'completed' }),
      ])
    );
  });

  it('fails a stale queued baseline before calling its side effect', async () => {
    const arbiter = new WorkspaceMutationArbiterV1();
    const gate = deferred<void>();
    let revision = 'r1';
    let secondSideEffects = 0;
    const first = arbiter.run(
      admission('workspace', 'first', () => 'r1'),
      async () => {
        await gate.promise;
      }
    );
    const second = arbiter.run(
      admission('workspace', 'second', () => revision),
      async () => {
        secondSideEffects += 1;
      }
    );
    revision = 'after';
    gate.resolve();
    await first;

    await expect(second).rejects.toMatchObject({ code: 'workspace_mutation_conflict' });
    expect(secondSideEffects).toBe(0);
  });

  it('cancels aborted queued work and rejects duplicate invocation ids', async () => {
    const arbiter = new WorkspaceMutationArbiterV1();
    const gate = deferred<void>();
    const controller = new AbortController();
    const first = arbiter.run(
      admission('workspace', 'first', () => 'r1'),
      () => gate.promise
    );
    const cancelled = arbiter.run(
      { ...admission('workspace', 'second', () => 'r1'), abortSignal: controller.signal },
      async () => 'forbidden'
    );
    expect(() =>
      arbiter.run(
        admission('workspace', 'second', () => 'r1'),
        async () => 'duplicate'
      )
    ).toThrow(WorkspaceMutationArbiterError);
    controller.abort();
    gate.resolve();
    await first;
    await expect(cancelled).rejects.toMatchObject({ code: 'workspace_mutation_cancelled' });
  });

  it('fails closed after shutdown and rejects queued work without cancelling active work', async () => {
    const arbiter = new WorkspaceMutationArbiterV1();
    const gate = deferred<void>();
    const active = arbiter.run(
      admission('workspace', 'active', () => 'r1'),
      () => gate.promise
    );
    const queued = arbiter.run(
      admission('workspace', 'queued', () => 'r1'),
      async () => undefined
    );

    arbiter.close('test shutdown');
    await expect(queued).rejects.toMatchObject({ code: 'workspace_mutation_cancelled' });
    expect(() =>
      arbiter.run(
        admission('workspace', 'late', () => 'r1'),
        async () => undefined
      )
    ).toThrow(WorkspaceMutationArbiterError);
    gate.resolve();
    await expect(active).resolves.toBeUndefined();
  });

  it('rechecks a file target after queueing and refuses a stale second write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-workspace-arbiter-'));
    const workspace = join(root, 'workspace');
    const target = join(workspace, 'shared.txt');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(target, 'original');
    const arbiter = new WorkspaceMutationArbiterV1();
    const mutate = deferred<void>();
    const finish = deferred<void>();
    let staleSideEffects = 0;
    try {
      const first = arbiter.runWorkspaceMutation(
        {
          workspaceId: workspace,
          invocationId: 'write-first',
          toolName: 'write_file',
          args: { path: 'shared.txt', content: 'first' },
        },
        async () => {
          await mutate.promise;
          writeFileSync(target, 'first');
          await finish.promise;
          return 'first';
        }
      );
      await flushPromises();
      const second = arbiter.runWorkspaceMutation(
        {
          workspaceId: workspace,
          invocationId: 'write-second',
          toolName: 'write_file',
          args: { path: 'shared.txt', content: 'second' },
        },
        async () => {
          staleSideEffects += 1;
          writeFileSync(target, 'second');
          return 'second';
        }
      );
      await flushPromises();
      mutate.resolve();
      await flushPromises();
      finish.resolve();

      await expect(first).resolves.toBe('first');
      await expect(second).rejects.toMatchObject({ code: 'workspace_mutation_conflict' });
      expect(staleSideEffects).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function admission(workspaceId: string, invocationId: string, current: () => string) {
  return {
    workspaceId,
    invocationId,
    baselineRevision: 'r1',
    readCurrentRevision: current,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}
