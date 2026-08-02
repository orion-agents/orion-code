import { MemoryStore } from '../src/memory/store';

describe('MemoryStore', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('evicts the least-recent working entry into short-term memory at capacity', () => {
    const store = new MemoryStore({ workingCapacity: 2, shortTermCapacity: 3 });
    const writes: unknown[] = [];
    const evictions: unknown[] = [];
    store.on('write', event => writes.push(event));
    store.on('evict', event => evictions.push(event));

    const first = store.pushWorking('first', { tags: ['old'], source: 'agent-a' });
    jest.advanceTimersByTime(10);
    const second = store.pushWorking('second');
    jest.advanceTimersByTime(10);
    const third = store.pushWorking('third');

    expect(store.getStats()).toEqual({ working: 2, 'short-term': 1, 'long-term': 0 });
    expect(store.readWorking().map(entry => entry.id)).toEqual([second.id, third.id]);
    expect(store.readShortTerm().map(entry => entry.id)).toEqual([first.id]);
    expect(writes).toEqual([
      { tier: 'working', id: first.id },
      { tier: 'working', id: second.id },
      { tier: 'working', id: third.id },
    ]);
    expect(evictions).toEqual([{ from: 'working', id: first.id }]);
  });

  it('expires working entries only after the configured TTL boundary', () => {
    const store = new MemoryStore({ workingTTL: 100 });
    const expired: unknown[] = [];
    store.on('expire', event => expired.push(event));
    const entry = store.pushWorking('temporary');

    jest.advanceTimersByTime(100);
    expect(store.readWorking()).toHaveLength(1);

    jest.advanceTimersByTime(1);
    expect(store.readWorking()).toEqual([]);
    expect(expired).toEqual([{ id: entry.id }]);
  });

  it('promotes frequently accessed working entries when working memory is cleared', () => {
    const store = new MemoryStore({ shortTermCapacity: 2 });
    const clearEvents: unknown[] = [];
    store.on('clear', event => clearEvents.push(event));
    const important = store.pushWorking('important');
    store.pushWorking('incidental');

    store.readWorking();
    store.readWorking();
    store.readWorking();

    expect(store.clearWorking()).toBe(2);
    expect(store.getStats()).toEqual({ working: 0, 'short-term': 2, 'long-term': 0 });
    expect(store.readShortTerm()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: important.id, accessCount: 4 })])
    );
    expect(clearEvents).toEqual([{ tier: 'working', count: 2 }]);
  });

  it('promotes displaced short-term entries to long-term memory when enabled', () => {
    const store = new MemoryStore({ shortTermCapacity: 1, autoPromoteToLongTerm: true });
    const evictions: unknown[] = [];
    store.on('evict', event => evictions.push(event));

    const first = store.pushShortTerm('first');
    const second = store.pushShortTerm('second');

    expect(store.readShortTerm().map(entry => entry.id)).toEqual([second.id]);
    expect(store.readLongTerm(first.id)).toMatchObject({ id: first.id, accessCount: 1 });
    expect(store.getStats()).toEqual({ working: 0, 'short-term': 1, 'long-term': 1 });
    expect(evictions).toEqual([{ from: 'short-term', id: first.id }]);
  });

  it('drops displaced short-term entries instead of promoting when disabled', () => {
    const store = new MemoryStore({ shortTermCapacity: 1, autoPromoteToLongTerm: false });
    const first = store.pushShortTerm('first');
    const second = store.pushShortTerm('second');

    expect(store.readShortTerm().map(entry => entry.id)).toEqual([second.id]);
    expect(store.readLongTerm(first.id)).toBeUndefined();
    expect(store.getStats()['long-term']).toBe(0);
  });

  it('searches across tiers by content, tags, source, time, tier, and limit', () => {
    const store = new MemoryStore();
    const start = Date.now();
    const working = store.pushWorking(
      { title: 'Orion release' },
      {
        tags: ['release', 'cli'],
        source: 'planner',
      }
    );
    jest.advanceTimersByTime(10);
    const shortTerm = store.pushShortTerm('verification result', {
      tags: ['test'],
      source: 'runner',
    });
    jest.advanceTimersByTime(10);
    const longTerm = store.pushLongTerm('ORION architecture', {
      tags: ['design'],
      source: 'planner',
    });

    expect(store.search({ query: 'orion', source: 'planner' }).map(entry => entry.id)).toEqual([
      working.id,
      longTerm.id,
    ]);
    expect(store.search({ tags: ['missing', 'test'] }).map(entry => entry.id)).toEqual([
      shortTerm.id,
    ]);
    expect(store.search({ after: start + 5, before: start + 15 })).toEqual([
      expect.objectContaining({ id: shortTerm.id }),
    ]);
    expect(store.search({ limit: 1 }, 'long-term')).toEqual([
      expect.objectContaining({ id: longTerm.id }),
    ]);
  });

  it('reads, deletes, resets long-term entries, and emits management events', () => {
    const store = new MemoryStore();
    const deleted: unknown[] = [];
    const reset = jest.fn();
    store.on('delete', event => deleted.push(event));
    store.on('reset', reset);
    const entry = store.pushLongTerm('durable', { tags: ['keep'] });

    expect(store.readLongTerm(entry.id)).toMatchObject({ accessCount: 1 });
    expect(store.deleteLongTerm(entry.id)).toBe(true);
    expect(store.deleteLongTerm(entry.id)).toBe(false);
    expect(deleted).toEqual([{ id: entry.id }]);

    store.pushWorking('working');
    store.pushShortTerm('short');
    store.pushLongTerm('long');
    expect(store.getAll()).toHaveLength(3);
    store.reset();

    expect(store.getStats()).toEqual({ working: 0, 'short-term': 0, 'long-term': 0 });
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
