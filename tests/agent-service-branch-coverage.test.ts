import * as childProcess from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { Task } from '../src/core/agent';
import * as forkModule from '../src/agents/fork';
import { WorkerPool, getWorkerPool, resetWorkerPool } from '../src/agents/worker-pool';
import * as workerPoolModule from '../src/agents/worker-pool';
import * as routerModule from '../src/agents/router';
import { Coordinator, getCoordinator, resetCoordinator } from '../src/agents/coordinator';
import {
  SessionMemory,
  getSessionMemory,
  resetSessionMemory,
  type SessionMemoryEntry,
} from '../src/services/session-memory/sessionMemory';
import { getProjectMemoryDir } from '../src/services/config-dir';
import * as autoFixConfigModule from '../src/services/auto-fix/autoFixConfig';
import type { AutoFixConfig } from '../src/services/auto-fix/autoFixConfig';
import {
  AutoFixRunner,
  getAutoFixRunner,
  resetAutoFixRunner,
} from '../src/services/auto-fix/autoFixRunner';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    name: `task-${id}`,
    description: `description-${id}`,
    priority: 'P1',
    assignedTo: 'leader',
    status: 'pending',
    ...overrides,
  };
}

function forkResult(success: boolean, content = success ? 'completed result' : '', error?: string) {
  return { success, content, error, duration: 1 };
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  resetWorkerPool();
  resetCoordinator();
  resetSessionMemory();
  resetAutoFixRunner();
});

describe('agent/service branch coverage: WorkerPool', () => {
  test('uses defaults, creates/reuses workers, merges options, and records success/failure', async () => {
    const fork = jest
      .spyOn(forkModule, 'forkSubagent')
      .mockResolvedValueOnce(forkResult(true, 'first'))
      .mockResolvedValueOnce(forkResult(false, '', 'reported failure'))
      .mockRejectedValueOnce(new Error('fork exploded'));
    const pool = new WorkerPool();

    await expect(pool.submit(task('one'))).resolves.toMatchObject({ success: true });
    expect(fork.mock.calls[0][0]).toMatchObject({
      inheritContext: true,
      taskDescription: 'description-one',
      maxTurns: 3,
    });
    expect(pool.getStatus()).toEqual({
      totalWorkers: 1,
      runningWorkers: 0,
      idleWorkers: 1,
      queueLength: 0,
      completedTasks: 1,
    });

    await expect(pool.submit(task('two'), { maxTurns: 7 })).resolves.toMatchObject({
      success: false,
      error: 'reported failure',
    });
    expect(fork.mock.calls[1][0]).toMatchObject({ maxTurns: 7 });
    expect(pool.getStatus().totalWorkers).toBe(1);

    await expect(pool.submit(task('three'))).resolves.toMatchObject({
      success: false,
      error: 'fork exploded',
    });
    expect(pool.getStatus().totalWorkers).toBe(2);
    expect(pool.collectResults().size).toBe(3);
  });

  test('honors explicit defaults and per-call overrides including false inheritContext', async () => {
    const fork = jest.spyOn(forkModule, 'forkSubagent').mockResolvedValue(forkResult(true));
    const pool = new WorkerPool({
      maxWorkers: 2,
      taskTimeout: 123,
      defaultForkOptions: {
        inheritContext: false,
        maxTurns: 4,
        background: true,
      },
    });
    await pool.submit(task('default-options'));
    await pool.submit(task('override-options'), {
      inheritContext: true,
      maxTurns: 9,
      background: false,
    });
    expect(fork.mock.calls[0][0]).toMatchObject({
      inheritContext: false,
      maxTurns: 4,
      background: true,
    });
    expect(fork.mock.calls[1][0]).toMatchObject({
      inheritContext: true,
      maxTurns: 9,
      background: false,
    });

    const zeroConfig = new WorkerPool({ maxWorkers: 0, taskTimeout: 0 });
    expect((zeroConfig as any).maxWorkers).toBe(3);
    expect((zeroConfig as any).taskTimeout).toBe(60000);
  });

  test('times out a queued task when no worker becomes idle', async () => {
    jest.useFakeTimers();
    const pool = new WorkerPool({ maxWorkers: 1, taskTimeout: 250 });
    (pool as any).workers.set('busy', { id: 'busy', status: 'running', task: task('busy') });

    const queued = pool.submit(task('queued-timeout'));
    expect((pool as any).taskQueue).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(250);
    await expect(queued).resolves.toEqual({
      success: false,
      content: '',
      error: 'Task queue timeout',
      duration: 250,
    });
  });

  test('drains a queued task onto the freed worker when a running task completes', async () => {
    jest.spyOn(forkModule, 'forkSubagent').mockResolvedValue(forkResult(true, 'queued done'));
    const pool = new WorkerPool({ maxWorkers: 1, taskTimeout: 1000 });
    // Fill the only worker with a running task, then queue another.
    const running = pool.submit(task('busy'));
    const queued = pool.submit(task('queued-success'));
    await Promise.all([running, queued]);

    await expect(queued).resolves.toMatchObject({ success: true, content: 'queued done' });
    expect(forkModule.forkSubagent).toHaveBeenCalledTimes(2);
    const worker = Array.from((pool as any).workers.values())[0];
    expect(worker).toMatchObject({
      status: 'completed',
      task: expect.objectContaining({ id: 'queued-success' }),
    });
  });

  test('drains an internal queue recursively and suppresses recursive rejection handling', async () => {
    const fork = jest
      .spyOn(forkModule, 'forkSubagent')
      .mockResolvedValueOnce(forkResult(true, 'first'))
      .mockResolvedValueOnce(forkResult(true, 'second'))
      .mockResolvedValue(forkResult(true, 'third'));
    const pool = new WorkerPool();
    (pool as any).workers.set('worker', { id: 'worker', status: 'running' });
    // Queue items are now { task, forkOptions, resolve } wrappers.
    (pool as any).taskQueue.push({ task: task('next'), forkOptions: undefined, resolve: () => {} });
    await (pool as any).executeTask('worker', task('current'));
    await Promise.resolve();
    await Promise.resolve();
    expect(fork).toHaveBeenCalledTimes(2);
    expect(pool.collectResults()).toEqual(
      new Map([
        ['current', forkResult(true, 'first')],
        ['next', forkResult(true, 'second')],
      ])
    );

    (pool as any).taskQueue.push(undefined);
    await (pool as any).executeTask('worker', task('no-next'));
  });

  test('submits batches, clears successful results only, broadcasts, stops, and resets singleton', async () => {
    jest
      .spyOn(forkModule, 'forkSubagent')
      .mockResolvedValueOnce(forkResult(true, 'ok'))
      .mockResolvedValueOnce(forkResult(false, '', 'bad'));
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const pool = new WorkerPool({ maxWorkers: 2 });
    const results = await pool.submitBatch([task('ok'), task('bad')], { maxTurns: 2 });
    expect(results.size).toBe(2);
    pool.clearResults();
    expect(pool.collectResults()).toEqual(new Map([['bad', forkResult(false, '', 'bad')]]));

    (pool as any).workers.set('running', {
      id: 'running',
      status: 'running',
      task: task('running'),
    });
    pool.broadcast('x'.repeat(80));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`${'x'.repeat(50)}...`));
    pool.stopAll();
    expect((pool as any).workers.get('running').status).toBe('failed');
    expect((pool as any).taskQueue).toEqual([]);

    const first = getWorkerPool({ maxWorkers: 1 });
    expect(getWorkerPool({ maxWorkers: 9 })).toBe(first);
    resetWorkerPool();
    expect(getWorkerPool()).not.toBe(first);
  });

  test('uses the catch-duration fallback when the recorded start time is zero', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(0);
    jest.spyOn(forkModule, 'forkSubagent').mockRejectedValue(new Error('zero-time failure'));
    const pool = new WorkerPool();
    await expect(pool.submit(task('zero-time'))).resolves.toMatchObject({
      success: false,
      error: 'zero-time failure',
      duration: 0,
    });
  });
});

describe('agent/service branch coverage: Coordinator', () => {
  function fakePool() {
    return {
      submit: jest.fn(),
      submitBatch: jest.fn(),
    };
  }

  function routeAndPool(pool: ReturnType<typeof fakePool>) {
    jest.spyOn(workerPoolModule, 'getWorkerPool').mockReturnValue(pool as any);
    jest.spyOn(routerModule, 'getAgentRouter').mockReturnValue({
      route: jest.fn((input: Task) => ({
        agentId: input.assignedTo || 'coder',
        reason: `route ${input.id}`,
        confidence: 0.75,
      })),
    } as any);
  }

  test('uses constructor defaults, registers agents, assigns tasks, and exposes status/results', () => {
    const pool = fakePool();
    routeAndPool(pool);
    const coordinator = new Coordinator();
    expect(coordinator.getStatus()).toEqual({
      registeredAgents: 4,
      pendingTasks: 0,
      completedTasks: 0,
      mode: 'distribute',
    });
    coordinator.registerAgent({
      id: 'custom',
      name: 'Custom',
      capabilities: ['custom'],
      priority: 1,
    } as any);
    expect(coordinator.getStatus().registeredAgents).toBe(5);
    expect(coordinator.assignTask(task('assigned', { assignedTo: 'tester' }))).toEqual({
      taskId: 'assigned',
      agentId: 'tester',
      reason: 'route assigned',
      confidence: 0.75,
    });
    expect(coordinator.collectResults()).toEqual(new Map());

    (coordinator as any).config.mode = '';
    expect(coordinator.getStatus().mode).toBe('distribute');

    const zeroConfig = new Coordinator({ maxParallel: 0 } as any);
    expect((zeroConfig as any).config.maxParallel).toBe(3);
  });

  test('executes distribute mode for successful and failed results', async () => {
    const pool = fakePool();
    pool.submit
      .mockResolvedValueOnce(forkResult(true, 'x'.repeat(250)))
      .mockResolvedValueOnce(forkResult(false, '', 'failed'));
    routeAndPool(pool);
    const coordinator = new Coordinator({ mode: 'distribute', maxParallel: 2 });
    const success = await coordinator.execute(task('success'));
    expect(success).toMatchObject({ success: true, summary: 'x'.repeat(200) });
    expect(success.assignments).toHaveLength(1);
    expect(pool.submit).toHaveBeenCalledWith(expect.objectContaining({ id: 'success' }), {
      taskDescription: 'description-success',
      maxTurns: 5,
    });
    const failure = await coordinator.execute(task('failure'));
    expect(failure).toMatchObject({ success: false, summary: '' });
    expect(coordinator.collectResults().size).toBe(2);
  });

  test('decomposes coding work in parallel and leaves non-coding work intact', async () => {
    const pool = fakePool();
    routeAndPool(pool);
    const classify = jest.spyOn(routerModule, 'classifyTask');
    classify.mockReturnValueOnce({ category: 'coding', confidence: 1 });
    pool.submitBatch.mockImplementation(
      async (tasks: Task[]) => new Map(tasks.map(item => [item.id, forkResult(true, item.name)]))
    );
    const coding = new Coordinator({ mode: 'parallel', aggregationStrategy: 'best' });
    const result = await coding.execute(task('feature', { name: 'feature' }));
    expect(result.success).toBe(true);
    expect(result.assignments).toHaveLength(3);
    expect([...result.results.keys()]).toEqual(['feature-impl', 'feature-test', 'feature-review']);

    classify.mockReturnValueOnce({ category: 'review', confidence: 1 });
    pool.submitBatch.mockResolvedValueOnce(new Map([['review', forkResult(false, '', 'none')]]));
    const unchanged = new Coordinator({ mode: 'parallel', aggregationStrategy: 'first' });
    const unchangedResult = await unchanged.execute(task('review'));
    expect(unchangedResult.assignments).toHaveLength(1);
    expect(unchangedResult.success).toBe(false);
  });

  test('executes all pipeline stages or stops at the first failure', async () => {
    const pool = fakePool();
    routeAndPool(pool);
    pool.submit.mockResolvedValue(forkResult(true, 'ok'));
    const success = new Coordinator({ mode: 'pipeline' });
    await expect(success.execute(task('pipe'))).resolves.toMatchObject({
      success: true,
      summary: 'Pipeline completed successfully',
      assignments: expect.arrayContaining([expect.objectContaining({ taskId: 'pipe-plan' })]),
    });
    expect(pool.submit).toHaveBeenCalledTimes(3);

    pool.submit.mockReset();
    pool.submit
      .mockResolvedValueOnce(forkResult(true, 'plan'))
      .mockResolvedValueOnce(forkResult(false, '', 'compile failed'));
    const failed = new Coordinator({ mode: 'pipeline' });
    await expect(failed.execute(task('broken'))).resolves.toMatchObject({
      success: false,
      summary: 'Pipeline failed at stage Implement: compile failed',
    });
    expect(pool.submit).toHaveBeenCalledTimes(2);
  });

  test('covers first, best, all, and invalid aggregation branches', () => {
    const pool = fakePool();
    routeAndPool(pool);

    const first = new Coordinator({ aggregationStrategy: 'first' });
    expect((first as any).aggregateResults(new Map())).toEqual({ success: false, summary: '' });
    expect((first as any).aggregateResults(new Map([['a', forkResult(true, 'first')]]))).toEqual({
      success: true,
      summary: 'first',
    });

    const best = new Coordinator({ aggregationStrategy: 'best' });
    expect(
      (best as any).aggregateResults(
        new Map([
          ['failed', forkResult(false, 'long failed')],
          ['short', forkResult(true, 'a')],
          ['long', forkResult(true, 'longest')],
        ])
      )
    ).toEqual({ success: true, summary: 'longest' });
    expect((best as any).aggregateResults(new Map([['failed', forkResult(false, '')]]))).toEqual({
      success: false,
      summary: 'No successful results',
    });

    const all = new Coordinator({ aggregationStrategy: 'all' });
    expect(
      (all as any).aggregateResults(
        new Map([
          ['one', forkResult(true, 'one')],
          ['empty', forkResult(true, '')],
          ['two', forkResult(false, 'two')],
        ])
      )
    ).toEqual({ success: false, summary: 'one\n\n---\n\ntwo' });
    expect(
      (all as any).aggregateResults(new Map([['one', forkResult(true, 'x'.repeat(600))]])).summary
    ).toHaveLength(500);
    expect((all as any).aggregateResults(new Map()).success).toBe(true);

    const invalid = new Coordinator({ aggregationStrategy: 'invalid' as any });
    expect((invalid as any).aggregateResults(new Map())).toEqual({
      success: false,
      summary: 'Unknown aggregation strategy',
    });
  });

  test('returns the unknown-mode guard and resets the singleton', async () => {
    const pool = fakePool();
    routeAndPool(pool);
    const invalid = new Coordinator({ mode: 'invalid' as any });
    await expect(invalid.execute(task('invalid'))).resolves.toMatchObject({
      success: false,
      assignments: [],
      summary: 'Unknown mode',
    });
    const first = getCoordinator({ mode: 'parallel' });
    expect(getCoordinator({ mode: 'pipeline' })).toBe(first);
    resetCoordinator();
    expect(getCoordinator()).not.toBe(first);
  });
});

describe('agent/service branch coverage: SessionMemory', () => {
  let projectPath: string;
  let configDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'orion-session-memory-'));
    configDir = mkdtempSync(join(tmpdir(), 'orion-session-memory-config-'));
    originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
  });

  test('handles disabled mode, missing files, force update, and clear variants', () => {
    const disabled = new SessionMemory(projectPath, { enabled: false, filename: 'disabled.md' });
    disabled.recordToolCall('write', { path: 'ignored.ts' }, 'ignored');
    disabled.updateFromMessages([{ role: 'user', content: 'ignored' }]);
    expect(disabled.getLatestEntries()).toEqual([]);
    expect(disabled.getContent()).toBe('');
    disabled.clear();
    disabled.forceUpdate();
    expect(disabled.getContent()).toContain('No activities recorded yet.');
    disabled.clear();
    expect(disabled.getContent()).toBe('');
  });

  test('loads an existing file and writes when the tool-call frequency is reached', () => {
    const memoryDir = getProjectMemoryDir(projectPath);
    const file = join(memoryDir, 'memory.md');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(file, 'existing');
    const memory = new SessionMemory(projectPath, {
      filename: 'memory.md',
      enabled: true,
      updateFrequency: 2,
    });
    expect(memory.getContent()).toBe('existing');
    memory.recordToolCall('read', { query: 'query topic', path: 'a.ts' }, 'ok');
    expect(memory.getContent()).toBe('existing');
    memory.recordToolCall('write', { message: 'message topic', file_path: 'b.ts' }, 'ok');
    expect(memory.getContent()).toContain('## Topics Discussed');
    expect(memory.getContent()).toContain('- query topic');
    expect(memory.getContent()).toContain('- message topic');
    expect(memory.getContent()).toContain('- a.ts');
    expect(memory.getContent()).toContain('- b.ts');
    expect((memory as any).toolCallCount).toBe(0);
  });

  test('extracts optional tool arguments and lets message override query topic', () => {
    const memory = new SessionMemory(projectPath);
    const entry = (memory as any).extractEntry(
      'tool',
      { path: 'one.ts', file_path: 'two.ts', query: 'query', message: 'message' },
      'result'
    ) as SessionMemoryEntry;
    expect(entry).toMatchObject({
      topic: 'message',
      actions: ['tool'],
      filesModified: ['one.ts', 'two.ts'],
    });
    expect((memory as any).extractEntry('tool', { path: 1, query: false }, 'x')).toMatchObject({
      topic: '',
      filesModified: [],
    });
  });

  test('extracts user topics and valid tool paths while ignoring invalid/no-path arguments', () => {
    const memory = new SessionMemory(projectPath);
    expect((memory as any).extractFromMessages([])).toBeNull();
    expect(
      (memory as any).extractFromMessages([{ role: 'assistant', content: '', tool_calls: [] }])
    ).toBeNull();

    memory.updateFromMessages([
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'plain' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'one',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"one.ts"}' },
          },
          {
            id: 'two',
            type: 'function',
            function: { name: 'search', arguments: '{"query":"x"}' },
          },
          {
            id: 'three',
            type: 'function',
            function: { name: 'broken', arguments: '{broken' },
          },
        ],
      },
      { role: 'user', content: 'latest user topic' },
    ]);
    expect(memory.getLatestEntries(1)[0]).toMatchObject({
      topic: 'latest user topic',
      actions: ['read_file', 'search', 'broken'],
      filesModified: ['one.ts'],
    });
    expect(memory.getContent()).toContain('latest user topic');

    const emptyContent = (memory as any).extractFromMessages([
      { role: 'user', content: undefined as any },
    ]);
    expect(emptyContent.topic).toBe('');
  });

  test('generates every optional markdown section, removes duplicates, and truncates lists', () => {
    const memory = new SessionMemory(projectPath);
    const entries: SessionMemoryEntry[] = Array.from({ length: 25 }, (_, index) => ({
      timestamp: index,
      topic: index % 2 === 0 ? `topic-${index}` : '',
      actions: [],
      decisions: index < 22 ? [`decision-${index}`] : [],
      filesModified: [`file-${index}.ts`, 'shared.ts'],
      openQuestions: index < 22 ? [`question-${index}`] : [],
    }));
    (memory as any).entries = entries;
    const markdown = (memory as any).generateMarkdown() as string;
    expect(markdown).toContain('## Topics Discussed');
    expect(markdown).toContain('## Files Modified');
    expect(markdown).toContain('## Key Decisions');
    expect(markdown).toContain('## Open Questions');
    expect(markdown.match(/shared\.ts/g)).toHaveLength(1);
    expect(markdown).not.toContain('topic-0');
    expect(markdown).not.toContain('file-0.ts');
    expect(markdown.split('\n').filter(line => line.startsWith('- file-')).length).toBe(14);
    expect(markdown.split('\n').filter(line => line.startsWith('- decision-')).length).toBe(5);
    expect(markdown.split('\n').filter(line => line.startsWith('- question-')).length).toBe(5);
  });

  test('omits empty optional sections and supports default/explicit latest-entry counts', () => {
    const memory = new SessionMemory(projectPath);
    (memory as any).entries = Array.from({ length: 7 }, (_, index) => ({
      timestamp: index,
      topic: '',
      actions: [],
      decisions: [],
      filesModified: [],
      openQuestions: [],
    }));
    const markdown = (memory as any).generateMarkdown() as string;
    expect(markdown).not.toContain('## Topics Discussed');
    expect(markdown).not.toContain('## Files Modified');
    expect(markdown).not.toContain('## Key Decisions');
    expect(markdown).not.toContain('## Open Questions');
    expect(memory.getLatestEntries()).toHaveLength(5);
    expect(memory.getLatestEntries(2)).toHaveLength(2);
  });

  test('uses and resets the session-memory singleton with explicit and default project paths', () => {
    const first = getSessionMemory(projectPath, { filename: 'one.md' });
    expect(getSessionMemory(join(projectPath, 'ignored'))).toBe(first);
    resetSessionMemory();
    const second = getSessionMemory(undefined, { enabled: false });
    expect(second).not.toBe(first);
    expect((second as any).projectPath).toBe(process.cwd());
  });
});

describe('agent/service branch coverage: AutoFixRunner', () => {
  function config(overrides: Partial<AutoFixConfig> = {}): AutoFixConfig {
    return {
      enabled: true,
      lintCommand: 'lint --check',
      buildCommand: 'build --check',
      testCommand: 'test --check',
      timeout: 123,
      maxFixAttempts: 2,
      triggers: [],
      ...overrides,
    };
  }

  function mockExec(outputs: Record<string, { error?: Error; stdout?: string; stderr?: string }>) {
    return (childProcess.execFile as unknown as jest.Mock).mockReset().mockImplementation(((
      command: string,
      args: readonly string[],
      options: unknown,
      callback: Function
    ) => {
      const output = outputs[command] || {};
      callback(output.error || null, output.stdout || '', output.stderr || '');
      return {} as any;
    }) as any);
  }

  test('uses explicit/detected config and project-path defaults', () => {
    const detected = config({ lintCommand: undefined });
    const detect = jest.spyOn(autoFixConfigModule, 'detectAutoFixConfig').mockReturnValue(detected);
    const cwdRunner = new AutoFixRunner();
    expect(detect).toHaveBeenCalledWith(process.cwd());
    expect(cwdRunner.getConfig()).toBe(detected);

    const explicit = config();
    const runner = new AutoFixRunner('/tmp/project', explicit);
    expect(runner.getConfig()).toBe(explicit);
    runner.setEnabled(false);
    expect(runner.getConfig().enabled).toBe(false);
  });

  test('returns an immediate successful result when disabled', async () => {
    const runner = new AutoFixRunner('/tmp/project', config({ enabled: false }));
    await expect(
      runner.run({ projectPath: '/tmp/project', changedFiles: [], trigger: { type: 'manual' } })
    ).resolves.toEqual({
      success: true,
      lintPassed: true,
      testPassed: true,
      errors: [],
      fixAttempts: 0,
      duration: 0,
    });
  });

  test('runs all configured commands successfully with split arguments and command options', async () => {
    const exec = mockExec({ lint: {}, build: {}, test: {} });
    const runner = new AutoFixRunner('/tmp/project', config());
    await expect(
      runner.run({
        projectPath: '/tmp/project',
        changedFiles: ['a.ts'],
        trigger: { type: 'file_edit' },
      })
    ).resolves.toMatchObject({
      success: true,
      lintPassed: true,
      buildPassed: true,
      testPassed: true,
      errors: [],
      fixAttempts: 0,
    });
    expect(exec).toHaveBeenCalledWith(
      'lint',
      ['--check'],
      expect.objectContaining({ cwd: '/tmp/project', timeout: 123, maxBuffer: 1024 * 1024 }),
      expect.any(Function)
    );
  });

  test('parses lint/build/test failures and evaluates every success conjunction operand', async () => {
    mockExec({
      lint: {
        error: new Error('lint'),
        stdout: [
          '/tmp/a.ts:10:5: error message --fix',
          'error: simple message at /tmp/b.ts:20',
          'ignored',
        ].join('\n'),
      },
      build: {
        error: new Error('build'),
        stderr: ['src/a.ts(7,3): error TS1234: build message', 'ignored'].join('\n'),
      },
      test: {
        error: new Error('test'),
        stdout: ['FAIL src/a.test.ts', 'Error: test message', 'AssertionError: expected'].join(
          '\n'
        ),
      },
    });
    const failed = new AutoFixRunner('/tmp/project', config());
    const result = await failed.run({
      projectPath: '/tmp/project',
      changedFiles: [],
      trigger: { type: 'manual' },
    });
    expect(result).toMatchObject({
      success: false,
      lintPassed: false,
      buildPassed: false,
      testPassed: false,
    });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'lint', file: '/tmp/a.ts', line: 10, fixable: true }),
        expect.objectContaining({ type: 'lint', file: '/tmp/b.ts', line: 20, fixable: false }),
        expect.objectContaining({ type: 'build', file: 'src/a.ts', line: 7 }),
        expect.objectContaining({ type: 'test', message: 'FAIL src/a.test.ts' }),
        expect.objectContaining({ type: 'test', message: 'AssertionError: expected' }),
      ])
    );

    jest.restoreAllMocks();
    mockExec({ lint: {}, build: {}, test: { error: new Error('test') } });
    await expect(
      new AutoFixRunner('/tmp/project', config()).run({
        projectPath: '/tmp/project',
        changedFiles: [],
        trigger: { type: 'manual' },
      })
    ).resolves.toMatchObject({ success: false, lintPassed: true, testPassed: false });

    jest.restoreAllMocks();
    mockExec({ lint: {}, build: { error: new Error('build') }, test: {} });
    await expect(
      new AutoFixRunner('/tmp/project', config()).run({
        projectPath: '/tmp/project',
        changedFiles: [],
        trigger: { type: 'manual' },
      })
    ).resolves.toMatchObject({
      success: false,
      lintPassed: true,
      testPassed: true,
      buildPassed: false,
    });
  });

  test('skips absent commands and covers quick-check no-command/success/failure paths', async () => {
    const noCommands = new AutoFixRunner(
      '/tmp/project',
      config({ lintCommand: undefined, buildCommand: undefined, testCommand: undefined })
    );
    await expect(
      noCommands.run({ projectPath: '/tmp/project', changedFiles: [], trigger: { type: 'manual' } })
    ).resolves.toMatchObject({
      success: true,
      lintPassed: true,
      testPassed: true,
      buildPassed: true,
    });
    await expect(noCommands.quickCheck([])).resolves.toEqual({ passed: true, errors: [] });

    mockExec({ lint: {} });
    const quick = new AutoFixRunner(
      '/tmp/project',
      config({ buildCommand: undefined, testCommand: undefined })
    );
    await expect(quick.quickCheck(['a.ts'])).resolves.toEqual({ passed: true, errors: [] });

    jest.restoreAllMocks();
    mockExec({ lint: { error: new Error('bad'), stdout: 'a.ts:1:2: error bad' } });
    await expect(quick.quickCheck(['a.ts'])).resolves.toMatchObject({
      passed: false,
      errors: [expect.objectContaining({ type: 'lint', file: 'a.ts', line: 1 })],
    });
  });

  test('caps parsed test errors at ten and avoids false-positive parser lines', () => {
    const runner = new AutoFixRunner('/tmp/project', config());
    const testOutput = Array.from({ length: 8 }, (_, index) => [
      `FAIL test-${index}`,
      `AssertionError: failure-${index}`,
    ])
      .flat()
      .join('\n');
    expect((runner as any).parseTestErrors(testOutput)).toHaveLength(10);
    expect((runner as any).parseLintErrors('ordinary output')).toEqual([]);
    expect((runner as any).parseBuildErrors('ordinary output')).toEqual([]);
    expect((runner as any).parseTestErrors('ordinary output')).toEqual([]);
  });

  test('uses and resets the AutoFix singleton', () => {
    const first = getAutoFixRunner('/tmp/one', config());
    expect(getAutoFixRunner('/tmp/two', config({ enabled: false }))).toBe(first);
    resetAutoFixRunner();
    expect(getAutoFixRunner('/tmp/two', config())).not.toBe(first);
  });
});
