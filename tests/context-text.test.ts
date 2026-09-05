/**
 * v0.3.12 Context V2 — line-range extraction and byte-budget helpers.
 */
import { enforceContextBudget, extractLineRange } from '../web/src/context-text';

describe('context text helpers (v0.3.12 file_range)', () => {
  const content = 'one\ntwo\nthree\nfour\nfive';

  test('extracts an inclusive 1-based range', () => {
    expect(extractLineRange(content, 2, 4)).toEqual({
      text: 'two\nthree\nfour',
      clampedAtEnd: false,
    });
    expect(extractLineRange(content, 1, 1)).toEqual({ text: 'one', clampedAtEnd: false });
    expect(extractLineRange(content, 5, 5)).toEqual({ text: 'five', clampedAtEnd: false });
  });

  test('clamps past-the-end ranges instead of throwing', () => {
    expect(extractLineRange(content, 3, 99)).toEqual({
      text: 'three\nfour\nfive',
      clampedAtEnd: true,
    });
    expect(extractLineRange(content, 99, 120)).toEqual({ text: '', clampedAtEnd: true });
    expect(extractLineRange(content, 0, 1)).toEqual({ text: 'one', clampedAtEnd: false });
  });

  test('enforces the soft byte budget without splitting mid-UTF-8', () => {
    const wide = '中'.repeat(50);
    expect(enforceContextBudget(wide, 200).truncated).toBe(false);
    const short = enforceContextBudget(wide, 100);
    expect(short.truncated).toBe(true);
    expect(Buffer.byteLength(short.text, 'utf8')).toBeLessThanOrEqual(100);
    expect(() => Buffer.from(short.text, 'utf8').toString('utf8')).not.toThrow();
  });
});
