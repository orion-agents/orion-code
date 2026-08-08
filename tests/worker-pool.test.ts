/**
 * WorkerPool tests — focused on the queue/drain contract (Issue #25).
 *
 * The old implementation ran a `setInterval` polling loop inside `submit` that
 * executed a queued task without dequeuing it, racing with the completion
 * handler's queue drain. That could execute a queued task twice and/or leave a
 * queued `submit` promise hanging forever. The fixed design keeps one resolver
 * per queued task and drains the queue solely from the completion handler.
 */

import { WorkerPool } from '../src/agents/worker-pool';
import * as forkModule from '../src/agents/fork';

jest.mock('../src/agents/fork', () => ({
  forkSubagent: jest.fn(),
}));

const mockFork = forkModule.forkSubagent as jest.Mock;

function makeTask(id: string): any {
  return { id, description: `task-${id}`, type: 'research' };
}

describe('WorkerPool queue/drain (Issue #25)', () => {
  beforeEach(() => {
    mockFork.mockReset();
    // Each fork resolves on the next tick to simulate async subagent work.
    mockFork.mockImplementation(
      () =>
        new Promise(res => {
          setImmediate(() => res({ success: true, content: 'ok', duration: 1 }));
        }),
    );
  });

  test('queued tasks execute exactly once and submit resolves', async () => {
    const pool = new WorkerPool({ maxWorkers: 1, taskTimeout: 2000 });
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    const results = await Promise.all(tasks.map(t => pool.submit(t)));

    // One fork per task — no double execution.
    expect(mockFork).toHaveBeenCalledTimes(3);
    const descs = mockFork.mock.calls.map(c => c[0].taskDescription).sort();
    expect(descs).toEqual(['task-a', 'task-b', 'task-c']);

    // Every submit promise resolved.
    expect(results).toHaveLength(3);
    expect(results.every(r => r.success)).toBe(true);
  });

  test('does not execute a task until a worker is free', async () => {
    const pool = new WorkerPool({ maxWorkers: 1, taskTimeout: 2000 });
    const pa = pool.submit(makeTask('a'));
    const pb = pool.submit(makeTask('b'));

    // Only the first task runs immediately.
    expect(mockFork).toHaveBeenCalledTimes(1);

    const [ra, rb] = await Promise.all([pa, pb]);
    expect(ra.success).toBe(true);
    expect(rb.success).toBe(true);
    expect(mockFork).toHaveBeenCalledTimes(2);
  });

  test('stopAll resolves pending queued promises instead of hanging', async () => {
    const pool = new WorkerPool({ maxWorkers: 1, taskTimeout: 5000 });
    const pa = pool.submit(makeTask('a')); // runs
    const pb = pool.submit(makeTask('b')); // queued
    const pc = pool.submit(makeTask('c')); // queued

    expect(mockFork).toHaveBeenCalledTimes(1);
    pool.stopAll();

    const results = await Promise.all([pa, pb, pc]);
    // a may or may not have finished; b and c must be resolved (not hang).
    expect(results).toHaveLength(3);
    expect(results[1].success).toBe(false);
    expect(results[1].error).toContain('stopped');
    expect(results[2].success).toBe(false);
    expect(results[2].error).toContain('stopped');
  });
});
