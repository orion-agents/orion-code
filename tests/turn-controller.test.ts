import { TurnController } from '../src/runtime/turn-controller';

describe('TurnController', () => {
  test('begins and finishes a single turn', () => {
    const controller = new TurnController();

    const turn = controller.beginTurn('hello');

    expect(controller.hasActiveTurn()).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      status: 'running',
      activeTurnId: turn.id,
    });
    expect(turn.abortSignal.aborted).toBe(false);

    const revision = controller.finishTurn(turn.id);

    expect(revision).toBeUndefined();
    expect(controller.hasActiveTurn()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ status: 'idle' });
  });

  test('revision aborts the active turn and accumulates consecutive inputs', () => {
    const controller = new TurnController();
    const turn = controller.beginTurn('write tests');

    expect(controller.requestRevision('add docs')).toBe(true);
    expect(controller.requestRevision('fix build')).toBe(true);

    expect(turn.abortSignal.aborted).toBe(true);
    // v0.1.3 §8 G2: consecutive revisions accumulate (newline-joined) instead of
    // overwriting, so no steering input is silently dropped.
    expect(controller.getSnapshot()).toMatchObject({
      status: 'aborting',
      pendingRevision: 'add docs\nfix build',
    });

    expect(controller.finishTurn(turn.id)).toBe('add docs\nfix build');
    expect(controller.hasActiveTurn()).toBe(false);
  });

  test('cannot request a revision without an active turn', () => {
    const controller = new TurnController();

    expect(controller.requestRevision('late change')).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ status: 'idle' });
  });

  test('Ctrl+C exit intent requires a second hit inside the window', () => {
    const controller = new TurnController({ exitConfirmWindowMs: 2000 });

    expect(controller.registerExitIntent(1000)).toBe(false);
    expect(controller.registerExitIntent(2500)).toBe(true);

    expect(controller.registerExitIntent(6000)).toBe(false);
    expect(controller.registerExitIntent(9001)).toBe(false);
  });
});

