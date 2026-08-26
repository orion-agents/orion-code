import { createTaskContract, normalizeTaskContract } from '../src/harness';
import type { HarnessState } from '../src/harness/types';
import { createTaskContextService } from '../src/runtime/task-context-service';

function verificationState(): HarnessState {
  const base = createTaskContract('Implement the feature', '/repo');
  const contract = normalizeTaskContract({
    ...base,
    successCriteria: ['Run npm test and ensure it passes', 'Run npm run build successfully'],
    criteria: undefined,
  });
  return { contract, ledger: [], updatedAt: 1 };
}

describe('v0.2.0 TaskContextService contract', () => {
  test('is the blocking completion authority for structured evidence', () => {
    const service = createTaskContextService({
      cwd: '/repo',
      modelId: 'test-model',
      state: verificationState(),
    });

    const initial = service.auditCompletion();
    expect(initial).toMatchObject({ version: 1, canComplete: false });
    expect(initial.missing.length).toBeGreaterThan(0);

    service.observeToolResult({
      name: 'exec_command',
      args: { command: 'npm test', cwd: '/repo' },
      result: JSON.stringify({ success: true, output: 'passed', exitCode: 0, sourceSha: 'abc' }),
      duration: 10,
      success: true,
    });
    expect(service.auditCompletion().criterionResults).toEqual([
      expect.objectContaining({ status: 'passed', missingKinds: [] }),
      expect.objectContaining({ status: 'pending', missingKinds: ['build'] }),
    ]);

    service.observeToolResult({
      name: 'exec_command',
      args: { command: 'npm run build', cwd: '/repo' },
      result: JSON.stringify({ success: true, output: 'built', exitCode: 0, artifactHash: 'def' }),
      duration: 20,
      success: true,
    });
    const completed = service.auditCompletion();
    expect(completed).toMatchObject({ version: 1, canComplete: true, missing: [] });
    expect(completed.revision).toBe(service.revision);
  });

  test('keeps revision monotonic only when authoritative state changes', () => {
    const service = createTaskContextService({ cwd: '/repo', modelId: 'test-model' });
    expect(service.serviceId).toBe('task-context');
    expect(service.revision).toBe(0);

    service.observeAppliedSkills([]);
    expect(service.revision).toBe(0);
    service.observeUserInput('Implement deterministic task context snapshots');
    expect(service.revision).toBe(1);
    service.observeAssistantResponse({ content: 'Decision recorded', model: 'test-model' });
    expect(service.revision).toBe(2);
    service.auditCompletion();
    expect(service.revision).toBe(3);
  });

  test('returns immutable snapshots without exposing HarnessKernel state', () => {
    const service = createTaskContextService({ cwd: '/repo', modelId: 'test-model' });
    service.observeUserInput('Run npm test and preserve evidence');
    const snapshot = service.snapshot();
    const before = service.exportState();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.state)).toBe(true);
    expect(Object.isFrozen(snapshot.state.ledger)).toBe(true);
    expect(() => {
      (snapshot.state as unknown as { updatedAt: number }).updatedAt = 0;
    }).toThrow();
    expect(service.exportState()).toEqual(before);

    const exported = service.exportState();
    exported.ledger.length = 0;
    expect(service.exportState().ledger.length).toBeGreaterThan(0);
  });

  test('restores existing state and keeps persistence outside the service', () => {
    const state = verificationState();
    const service = createTaskContextService({
      cwd: '/repo',
      modelId: 'test-model',
      state,
      revision: 7,
    });

    expect(service.revision).toBe(7);
    expect(service.getContract()?.successCriteria).toEqual(state.contract?.successCriteria);
    expect(service.snapshot()).toMatchObject({
      version: 1,
      revision: 7,
      taskEpoch: state.contract?.taskEpoch ?? 1,
    });
    expect(Object.keys(service)).not.toContain('goal');
    expect(service.exportState()).not.toBe(state);
  });

  test('does not accept opaque output as completion evidence', () => {
    const service = createTaskContextService({
      cwd: '/repo',
      modelId: 'test-model',
      state: verificationState(),
    });
    service.observeToolResult({
      name: 'exec_command',
      args: { command: 'npm test', cwd: '/repo' },
      result: 'passed',
      duration: 5,
      success: true,
    });

    expect(service.auditCompletion()).toMatchObject({ canComplete: false });
  });
});
