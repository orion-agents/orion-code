import { GoalCoordinator } from '../src/runtime/goals/coordinator';

describe('Goal restart and session isolation', () => {
  it('loads an active sidecar into visible paused recovery state', () => {
    const project = `/tmp/goal-resume-${Date.now()}-${Math.random()}`;
    const first = new GoalCoordinator(project, 'session-a');
    first.create('Continue after restart safely');

    const restored = new GoalCoordinator(project, 'session-a');
    expect(restored.load(true)).toBe(true);
    expect(restored.goal?.status).toBe('paused');
    expect(restored.goal?.stopReason?.message).toContain('/target resume');
    expect(restored.buildContinuationRequest()).toBeNull();

    expect(restored.resume()).toBe(true);
    expect(restored.buildContinuationRequest()).toMatchObject({
      inputKind: 'goal_continuation',
      sessionId: 'session-a',
      persistAsUserMessage: false,
      echoToTranscript: false,
    });
  });

  it('never loads another session goal', () => {
    const project = `/tmp/goal-isolation-${Date.now()}-${Math.random()}`;
    const first = new GoalCoordinator(project, 'session-a');
    first.create('Session A objective');

    const second = new GoalCoordinator(project, 'session-b');
    expect(second.load(true)).toBe(false);
    expect(second.goal).toBeNull();
  });

  it('invalidates scheduled requests after replace', () => {
    const coord = new GoalCoordinator('/tmp/goal-generation', 'session-generation');
    coord.create('Old objective');
    const oldRequest = coord.buildContinuationRequest()!;
    coord.replace('New objective');
    expect(coord.generation).not.toBe(oldRequest.generation);
    expect(coord.goal?.goalId).not.toBe(oldRequest.goal?.goalId);
  });

  it('fails closed when two coordinators write the same stale revision', () => {
    const project = `/tmp/goal-cas-${Date.now()}-${Math.random()}`;
    const first = new GoalCoordinator(project, 'session-cas');
    first.create('CAS protected goal');
    const stale = new GoalCoordinator(project, 'session-cas');
    expect(stale.load()).toBe(true);

    expect(first.pause()).toBe(true);
    expect(() => stale.pause()).toThrow('revision_stale');
    expect(stale.goal?.status).toBe('paused');
    expect(stale.goal?.revision).toBe(1);
    expect(stale.canContinue).toBe(false);

    const verify = new GoalCoordinator(project, 'session-cas');
    verify.load();
    expect(verify.goal?.status).toBe('paused');
    expect(verify.goal?.revision).toBe(1);
  });

  it('fails closed when a stale coordinator replaces or clears a newer goal', () => {
    const project = `/tmp/goal-cas-destructive-${Date.now()}-${Math.random()}`;
    const current = new GoalCoordinator(project, 'session-cas-destructive');
    current.create('Keep the current goal');
    const staleReplace = new GoalCoordinator(project, 'session-cas-destructive');
    const staleClear = new GoalCoordinator(project, 'session-cas-destructive');
    expect(staleReplace.load()).toBe(true);
    expect(staleClear.load()).toBe(true);

    expect(current.pause()).toBe(true);
    expect(staleReplace.replace('Overwrite with a stale goal')).toBe(false);
    expect(staleReplace.goal?.objective).toBe('Keep the current goal');
    expect(staleReplace.goal?.revision).toBe(1);
    expect(() => staleClear.clear()).toThrow('revision_stale');

    const verify = new GoalCoordinator(project, 'session-cas-destructive');
    expect(verify.load()).toBe(true);
    expect(verify.goal).toMatchObject({
      objective: 'Keep the current goal',
      status: 'paused',
      revision: 1,
    });
  });
});
