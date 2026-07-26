/**
 * Bug-hunt round 14 evidence: encodeProjectPath collides distinct project
 * paths into the same key.
 *
 * encodeProjectPath replaces every run of non-alphanumeric chars with a single
 * '-', so paths that differ only in separator structure collapse:
 *   /Users/hope/my project  ->  Users-hope-my-project
 *   /Users/hope/my-project  ->  Users-hope-my-project
 * Two different project directories then share the same projects/<key>/ store
 * (sessions, harness sidecars, traces, memory), so one project's sessions can
 * be listed/resumed by the other - a data-confusion bug.
 *
 * Fix: mix a short hash of the original path into the key so distinct paths
 * cannot collide, while keeping the human-readable prefix.
 */
import { encodeProjectPath } from '../src/services/config-dir';

describe('encodeProjectPath collision (bug-hunt round 14)', () => {
  it('produces distinct keys for paths that differ only in separators', () => {
    const a = encodeProjectPath('/Users/hope/my project');
    const b = encodeProjectPath('/Users/hope/my-project');
    expect(a).not.toBe(b);
  });

  it('produces distinct keys for paths that differ by a trailing slash', () => {
    const a = encodeProjectPath('/Users/hope/proj');
    const b = encodeProjectPath('/Users/hope/proj/');
    expect(a).not.toBe(b);
  });

  it('produces distinct keys for genuinely different projects', () => {
    const a = encodeProjectPath('/home/user/app');
    const b = encodeProjectPath('/home/user/app-2');
    expect(a).not.toBe(b);
  });

  it('is stable (same path -> same key)', () => {
    const path = '/Users/hope/openhorse';
    expect(encodeProjectPath(path)).toBe(encodeProjectPath(path));
  });
});
