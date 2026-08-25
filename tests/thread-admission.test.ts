import { ThreadAdmissionControllerV1 } from '../src/runtime/thread-admission';

function uuidFactory(): () => string {
  let sequence = 1;
  return () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
}

describe('ThreadAdmissionControllerV1', () => {
  test('arbitrates start, steer, bounded follow-up, and the next active turn', () => {
    let now = 1_000;
    const admission = new ThreadAdmissionControllerV1({
      maxQueuedItems: 2,
      maxQueuedBytes: 12,
      maxQueueWaitMs: 100,
      clock: () => now,
      idFactory: uuidFactory(),
    });

    const started = admission.start({ input: 'first', mode: 'build' });
    expect(started).toEqual({
      status: 'started',
      turnId: '00000000-0000-4000-8000-000000000001',
    });
    expect(admission.steer('revise')).toEqual({
      status: 'steered',
      activeTurnId: started.status === 'started' ? started.turnId : '',
      itemId: '00000000-0000-4000-8000-000000000002',
    });

    const queued = admission.followUp({ input: '后续', mode: 'auto', deadline: 1_500 });
    expect(queued).toMatchObject({
      status: 'queued',
      queueId: '00000000-0000-4000-8000-000000000003',
      position: 1,
      deadline: 1_100,
    });
    // UTF-8 byte accounting: 后续 is six bytes, so another seven-byte input
    // would exceed the twelve-byte aggregate queue limit.
    expect(admission.followUp({ input: '1234567', mode: 'build' })).toEqual({
      status: 'rejected',
      reason: 'overloaded',
    });

    const finish = admission.finish(started.status === 'started' ? started.turnId : '');
    expect(finish).toEqual({
      status: 'started',
      turnId: '00000000-0000-4000-8000-000000000004',
      queueId: '00000000-0000-4000-8000-000000000003',
      expiredQueueIds: [],
    });
    expect(admission.getSnapshot()).toMatchObject({
      activeTurn: { input: '后续', kind: 'regular', mode: 'auto' },
      queue: [],
      queuedBytes: 0,
    });

    now = 2_000;
  });

  test('expires queued work and rejects expired admission deadlines', () => {
    let now = 10;
    const admission = new ThreadAdmissionControllerV1({
      maxQueueWaitMs: 20,
      clock: () => now,
      idFactory: uuidFactory(),
    });
    const active = admission.start({ input: 'active', mode: 'build' });
    const queued = admission.followUp({ input: 'expires', mode: 'build' });
    expect(queued).toMatchObject({ status: 'queued', deadline: 30 });

    now = 30;
    expect(admission.finish(active.status === 'started' ? active.turnId : '')).toEqual({
      status: 'idle',
      expiredQueueIds: [
        queued.status === 'queued' ? queued.queueId : 'unexpected-admission-result',
      ],
    });
    expect(admission.start({ input: 'late', mode: 'build', deadline: 30 })).toEqual({
      status: 'rejected',
      reason: 'deadline_expired',
    });
  });

  test('makes maintenance non-steerable and interrupt intent idempotent', () => {
    const admission = new ThreadAdmissionControllerV1({ idFactory: uuidFactory() });
    const started = admission.start({
      input: 'compact',
      mode: 'maintenance',
      kind: 'maintenance',
    });
    expect(admission.steer('change direction')).toEqual({
      status: 'rejected',
      reason: 'non_steerable',
    });

    const first = admission.interrupt();
    expect(first).toMatchObject({
      status: 'interrupt_requested',
      activeTurnId: started.status === 'started' ? started.turnId : '',
      alreadyRequested: false,
    });
    expect(admission.interrupt()).toEqual({
      ...first,
      alreadyRequested: true,
    });
  });

  test('keeps maintenance out of the user follow-up mode', () => {
    const admission = new ThreadAdmissionControllerV1({ idFactory: uuidFactory() });
    const regular = admission.start({ input: 'first', mode: 'auto' });
    if (regular.status !== 'started') throw new Error('Expected regular turn to start');
    const maintenance = admission.finishAndStartPriority(regular.turnId, {
      input: 'compact:auto',
      mode: 'maintenance',
      kind: 'maintenance',
    });
    expect(maintenance.status).toBe('started');

    const followUp = admission.admit({
      type: 'turn.follow_up',
      data: { input: 'continue after compact' },
    });
    expect(followUp.status).toBe('queued');
    expect(admission.getSnapshot().queue[0]).toMatchObject({
      mode: 'auto',
      kind: 'regular',
    });
  });

  test('rejects empty and oversized input and closes without retaining queued bytes', () => {
    const admission = new ThreadAdmissionControllerV1({
      maxQueuedItems: 1,
      maxQueuedBytes: 8,
      maxInputBytes: 8,
      idFactory: uuidFactory(),
    });
    expect(admission.start({ input: '   ', mode: 'build' })).toEqual({
      status: 'rejected',
      reason: 'invalid_input',
    });
    expect(admission.start({ input: '123456789', mode: 'build' })).toEqual({
      status: 'rejected',
      reason: 'invalid_input',
    });
    admission.start({ input: 'active', mode: 'build' });
    const queued = admission.followUp({ input: 'queued', mode: 'build' });
    expect(admission.close()).toEqual([
      queued.status === 'queued' ? queued.queueId : 'unexpected-admission-result',
    ]);
    expect(admission.getSnapshot()).toMatchObject({
      shutdown: true,
      queue: [],
      queuedBytes: 0,
    });
    expect(admission.start({ input: 'new', mode: 'build' })).toEqual({
      status: 'rejected',
      reason: 'shutdown',
    });
  });
});
