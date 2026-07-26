/**
 * Warning Deduplication unit tests
 */

import { warnOnce, flushWarnings, resetWarnings, getWarningState } from '../src/core/warn-dedup';

describe('warn-dedup', () => {
  beforeEach(() => {
    resetWarnings();
  });

  test('warnOnce emits first warning', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    warnOnce('test-key', 'first warning');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('warnOnce suppresses duplicates', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    warnOnce('test-key', 'first warning');
    warnOnce('test-key', 'first warning');
    warnOnce('test-key', 'first warning');
    // Only the first call emits
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('warnOnce tracks different keys independently', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    warnOnce('key-a', 'warning A');
    warnOnce('key-b', 'warning B');
    warnOnce('key-a', 'warning A');
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  test('warnOnce does not emit after flush', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    warnOnce('test-key', 'first warning');
    flushWarnings();
    warnOnce('test-key', 'this should not emit');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('flushWarnings returns summary with suppressed count', () => {
    warnOnce('test-key', 'first warning');
    warnOnce('test-key', 'first warning');
    warnOnce('test-key', 'first warning');

    const summary = flushWarnings();
    expect(summary).toContain('2 duplicate');
    expect(summary).toContain('first warning');
  });

  test('flushWarnings returns empty string with no warnings', () => {
    const summary = flushWarnings();
    expect(summary).toBe('');
  });

  test('flushWarnings returns empty string with only unique warnings', () => {
    warnOnce('key-a', 'warning A');
    warnOnce('key-b', 'warning B');

    const summary = flushWarnings();
    // No duplicates → empty summary
    expect(summary).toBe('');
  });

  test('resetWarnings clears state', () => {
    warnOnce('test-key', 'first warning');
    resetWarnings();

    const state = getWarningState();
    expect(state.size).toBe(0);
  });

  test('getWarningState returns current counts', () => {
    warnOnce('a', 'msg a');
    warnOnce('a', 'msg a');
    warnOnce('b', 'msg b');

    const state = getWarningState();
    expect(state.get('a')?.count).toBe(2);
    expect(state.get('b')?.count).toBe(1);
  });
});
