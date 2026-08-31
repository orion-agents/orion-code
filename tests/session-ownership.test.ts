import type { SessionLease } from '../src/acp/session-lease';
import { SessionOwnershipCoordinator } from '../src/runtime/session-ownership';

describe('SessionOwnershipCoordinator', () => {
  test('serializes activation and keeps the old owner until the candidate transition commits', async () => {
    const events: string[] = [];
    const firstTransition = deferred();
    const coordinator = createCoordinator(events);

    const first = coordinator.activate('first', async () => {
      events.push('transition:first:start');
      await firstTransition.promise;
      events.push('transition:first:end');
    });
    const second = coordinator.switch('second', async () => {
      events.push('transition:second');
    });

    await nextTurn();
    expect(events).toEqual(['acquire:first', 'transition:first:start']);
    firstTransition.resolve();
    await first;
    await second;

    expect(events).toEqual([
      'acquire:first',
      'transition:first:start',
      'transition:first:end',
      'acquire:second',
      'transition:second',
      'release:first',
    ]);
    expect(coordinator.activeSessionId).toBe('second');
    await coordinator.close();
  });

  test('rolls back a failed candidate without releasing the current owner', async () => {
    const events: string[] = [];
    const coordinator = createCoordinator(events);
    await coordinator.activate('current', async () => undefined);

    await expect(
      coordinator.activate('candidate', async () => {
        throw new Error('candidate failed');
      })
    ).rejects.toThrow('candidate failed');

    expect(coordinator.activeSessionId).toBe('current');
    expect(events).toEqual(['acquire:current', 'acquire:candidate', 'release:candidate']);
    await coordinator.close();
  });

  test('closes the active runtime before releasing ownership and is idempotent', async () => {
    const events: string[] = [];
    const coordinator = createCoordinator(events);
    await coordinator.activate('active', async () => undefined);

    await coordinator.close(async () => {
      events.push('runtime:close');
    });
    await coordinator.close(async () => {
      events.push('runtime:close-again');
    });

    expect(events).toEqual(['acquire:active', 'runtime:close', 'release:active']);
  });
});

function createCoordinator(events: string[]): SessionOwnershipCoordinator {
  return new SessionOwnershipCoordinator({
    version: 'test',
    acquireLease: async sessionId => {
      events.push(`acquire:${sessionId}`);
      return createLease(sessionId, events);
    },
  });
}

function createLease(sessionId: string, events: string[]): SessionLease {
  let released = false;
  return {
    owner: {
      schemaVersion: 1,
      sessionId,
      pid: process.pid,
      processStartTime: 'test',
      ownerToken: `owner:${sessionId}`,
      sidecarVersion: 'test',
      acquiredAt: new Date(0).toISOString(),
    },
    release: async () => {
      if (released) return;
      released = true;
      events.push(`release:${sessionId}`);
    },
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}
