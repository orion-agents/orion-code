import { mkdtempSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanupStaleAtomicWriteFiles } from '../src/services/atomic-write';

describe('atomic-write startup cleanup', () => {
  test('removes only stale Orion temp files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orion-atomic-cleanup-'));
    const staleAtomic = join(directory, '.usage.json.123.456.tmp');
    const staleRandom = join(directory, '.usage.json.0123456789abcdef01234567.tmp');
    const staleGoal = join(directory, 'session.goal.json.tmp-deadbeef');
    const recent = join(directory, '.active.json.0123456789abcdef01234567.tmp');
    const unrelated = join(directory, 'user.tmp');
    for (const file of [staleAtomic, staleRandom, staleGoal, recent, unrelated]) {
      writeFileSync(file, 'x');
    }
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const file of [staleAtomic, staleRandom, staleGoal]) utimesSync(file, old, old);

    expect(cleanupStaleAtomicWriteFiles(directory)).toBe(3);
    expect(() => statSync(recent)).not.toThrow();
    expect(() => statSync(unrelated)).not.toThrow();
  });

  test('ignores missing directories', () => {
    const missing = join(tmpdir(), `orion-missing-${Date.now()}`);
    expect(cleanupStaleAtomicWriteFiles(missing)).toBe(0);
  });
});
