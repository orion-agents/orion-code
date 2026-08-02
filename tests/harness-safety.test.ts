import type { Task } from '../src/core/agent';
import { HarnessEngine } from '../src/harness/harness';
import { SafetyChecker } from '../src/harness/safety';

describe('SafetyChecker', () => {
  it('allows checks without recording them when the policy is disabled', () => {
    const checker = new SafetyChecker({ enabled: false });
    const listener = jest.fn();
    checker.on('check', listener);

    expect(checker.check('rm -rf /')).toEqual({ passed: true, level: 'safe' });
    expect(checker.getAuditSummary()).toEqual({ total: 0, passed: 0, failed: 0, blocked: 0 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('applies blocked rules before dangerous rules and emits the recorded check', () => {
    const checker = new SafetyChecker({
      allowed: ['*'],
      blocked: ['forbidden', 'eval'],
      dangerousPatterns: ['eval\\s*\\('],
    });
    const listener = jest.fn();
    checker.on('check', listener);

    expect(checker.check('forbidden operation')).toMatchObject({
      passed: false,
      level: 'blocked',
      reason: 'Action matches blocked pattern',
    });
    expect(checker.check('eval(input)')).toMatchObject({ passed: false, level: 'blocked' });
    expect(listener).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ action: 'forbidden operation', level: 'blocked' })
    );
  });

  it('classifies dangerous patterns separately from blocked actions', () => {
    const checker = new SafetyChecker({
      allowed: ['*'],
      blocked: [],
      dangerousPatterns: ['eval\\s*\\('],
    });

    expect(checker.check('eval(input)')).toMatchObject({
      passed: false,
      level: 'dangerous',
      suggestion: expect.stringContaining('safe alternatives'),
    });
    expect(checker.getAuditSummary()).toEqual({ total: 1, passed: 0, failed: 1, blocked: 0 });
  });

  it.each([
    [
      'blocked path',
      'read file',
      { path: '/private/secrets/key' },
      { blockedPaths: ['/private/secrets'] },
      'blocked',
      'Access to blocked path',
    ],
    [
      'oversized output',
      'read output',
      { output: '12345' },
      { maxOutputLength: 4 },
      'warning',
      'Output exceeds max length',
    ],
    [
      'disallowed filesystem operation',
      'delete file',
      { fsOp: 'delete' },
      { allowedFileSystemOps: ['read'] as Array<'read' | 'write' | 'delete' | 'execute'> },
      'blocked',
      'File system operation "delete" is not allowed',
    ],
  ])('rejects a %s', (_label, action, context, policy, level, reason) => {
    const checker = new SafetyChecker({ allowed: ['*'], ...policy });

    expect(checker.check(action, context)).toMatchObject({
      passed: false,
      level,
      reason: expect.stringContaining(reason),
    });
  });

  it('returns whitelist warnings while allowing wildcard and listed actions', () => {
    const checker = new SafetyChecker({ allowed: ['read'], blocked: [], dangerousPatterns: [] });

    expect(checker.check('read file')).toEqual({
      passed: true,
      level: 'safe',
      action: 'read file',
    });
    expect(checker.check('write file')).toMatchObject({
      passed: true,
      level: 'warning',
      reason: 'Action "write" not in whitelist',
    });

    checker.updatePolicy({ allowed: ['*'] });
    expect(checker.check('write file')).toMatchObject({ passed: true, level: 'safe' });
    expect(checker.getPolicy().allowed).toEqual(['*']);
  });

  it('recompiles blocked and dangerous regexes when the policy changes', () => {
    const checker = new SafetyChecker({
      allowed: ['*'],
      blocked: ['old-blocked'],
      dangerousPatterns: ['old-dangerous'],
    });

    checker.updatePolicy({
      blocked: ['new-blocked'],
      dangerousPatterns: ['new-dangerous'],
    });

    expect(checker.check('old-blocked')).toMatchObject({ passed: true, level: 'safe' });
    expect(checker.check('old-dangerous')).toMatchObject({ passed: true, level: 'safe' });
    expect(checker.check('new-blocked')).toMatchObject({ passed: false, level: 'blocked' });
    expect(checker.check('new-dangerous')).toMatchObject({ passed: false, level: 'dangerous' });
  });

  it('isolates constructor policy arrays from caller mutation', () => {
    const blocked = ['initial-blocked'];
    const checker = new SafetyChecker({ allowed: ['*'], blocked, dangerousPatterns: [] });

    blocked[0] = 'mutated-blocked';

    expect(checker.getPolicy().blocked).toEqual(['initial-blocked']);
    expect(checker.check('initial-blocked')).toMatchObject({ passed: false, level: 'blocked' });
    expect(checker.check('mutated-blocked')).toMatchObject({ passed: true, level: 'safe' });
  });

  it('isolates update policy arrays from caller mutation', () => {
    const checker = new SafetyChecker({ allowed: ['*'], blocked: [], dangerousPatterns: [] });
    const dangerousPatterns = ['initial-dangerous'];

    checker.updatePolicy({ dangerousPatterns });
    dangerousPatterns[0] = 'mutated-dangerous';

    expect(checker.getPolicy().dangerousPatterns).toEqual(['initial-dangerous']);
    expect(checker.check('initial-dangerous')).toMatchObject({
      passed: false,
      level: 'dangerous',
    });
    expect(checker.check('mutated-dangerous')).toMatchObject({ passed: true, level: 'safe' });
  });

  it('returns an isolated policy snapshot', () => {
    const checker = new SafetyChecker({
      allowed: ['read'],
      blocked: ['blocked'],
      dangerousPatterns: [],
      blockedPaths: ['/private'],
    });
    const snapshot = checker.getPolicy();

    snapshot.allowed[0] = '*';
    snapshot.blocked[0] = 'changed';
    snapshot.blockedPaths[0] = '/tmp';

    expect(checker.getPolicy()).toMatchObject({
      allowed: ['read'],
      blocked: ['blocked'],
      blockedPaths: ['/private'],
    });
    expect(checker.check('blocked')).toMatchObject({ passed: false, level: 'blocked' });
    expect(checker.check('write')).toMatchObject({ passed: true, level: 'warning' });
    expect(checker.check('read file', { path: '/private/key' })).toMatchObject({
      passed: false,
      level: 'blocked',
    });
  });

  it('handles invalid and excessively long policy regexes without throwing', () => {
    const checker = new SafetyChecker({
      allowed: ['*'],
      blocked: ['[', 'x'.repeat(501)],
      dangerousPatterns: ['('],
    });

    expect(() => checker.check('ordinary action')).not.toThrow();
    expect(checker.check('ordinary action')).toMatchObject({ passed: true, level: 'safe' });
  });

  it('checks batches, returns the newest audit records, and clears the audit log', () => {
    const checker = new SafetyChecker({
      allowed: ['read'],
      blocked: ['blocked'],
      dangerousPatterns: ['danger'],
    });

    expect(checker.checkBatch(['read file', 'write file', 'danger', 'blocked'])).toEqual([
      expect.objectContaining({ passed: true, level: 'safe' }),
      expect.objectContaining({ passed: true, level: 'warning' }),
      expect.objectContaining({ passed: false, level: 'dangerous' }),
      expect.objectContaining({ passed: false, level: 'blocked' }),
    ]);
    expect(checker.getAuditSummary()).toEqual({ total: 4, passed: 2, failed: 1, blocked: 1 });
    expect(checker.getAuditLog(2).map(entry => entry.action)).toEqual(['danger', 'blocked']);

    checker.clearAuditLog();
    expect(checker.getAuditLog()).toEqual([]);
  });

  it('bounds the audit log and discards the oldest entry', () => {
    const checker = new SafetyChecker({ allowed: ['*'], blocked: [], dangerousPatterns: [] });

    for (let index = 0; index <= 1000; index++) {
      checker.check(`read-${index}`);
    }

    expect(checker.getAuditSummary()).toEqual({
      total: 1000,
      passed: 1000,
      failed: 0,
      blocked: 0,
    });
    expect(checker.getAuditLog(1000)[0].action).toBe('read-1');
    expect(checker.getAuditLog(1)[0].action).toBe('read-1000');
  });
});

describe('HarnessEngine safety integration', () => {
  const task: Task = {
    id: 'task-1',
    name: 'deploy production',
    description: 'Deploy the current build',
    priority: 'P1',
    assignedTo: 'agent-1',
    status: 'pending',
  };

  it('routes sandbox pre-checks through SafetyChecker and can disable the sandbox', () => {
    const harness = new HarnessEngine({
      sandbox: true,
      safetyPolicy: {
        allowed: ['*'],
        blocked: ['deploy'],
        dangerousPatterns: [],
      },
    });

    expect(harness.getSafetyChecker()).toBeInstanceOf(SafetyChecker);
    expect(harness.preCheck(task)).toMatchObject({
      passed: false,
      stage: 'pre-exec',
      reason: 'Action matches blocked pattern',
    });

    harness.updateConfig({ sandbox: false });
    expect(harness.getSafetyChecker()).toBeNull();
    expect(harness.preCheck(task)).toEqual({ passed: true, stage: 'pre-exec' });
  });
});
