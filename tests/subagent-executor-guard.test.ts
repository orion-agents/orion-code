/**
 * R3 regression tests: ChildToolExecutorGuard project-root and scope isolation.
 *
 * Verifies that path-bearing tool args (read_file, list_files, glob, grep,
 * batch_read nested) are containment-checked against the project root and
 * packet scope. Covers absolute paths, `../` escapes, outside-scope files,
 * symlink escapes, and batch_read nested args.
 */

import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  evaluateToolCall,
  createChildToolExecutorGuard,
  ScopeHolder,
} from '../src/runtime/subagents/child-executor-guard';

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openhorse-r3-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;');
  writeFileSync(join(root, 'tests', 'b.test.ts'), 'test();');
  return root;
}

describe('R3: ChildToolExecutorGuard', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  describe('root containment (no scope)', () => {
    it('allows a relative path inside root', () => {
      const verdict = evaluateToolCall('read_file', { path: 'src/a.ts' }, { rootCwd: root });
      expect(verdict.ok).toBe(true);
    });

    it('allows an absolute path inside root', () => {
      const verdict = evaluateToolCall('read_file', { path: join(root, 'src', 'a.ts') }, { rootCwd: root });
      expect(verdict.ok).toBe(true);
    });

    it('rejects a `..` escape', () => {
      const verdict = evaluateToolCall('read_file', { path: '../../../etc/passwd' }, { rootCwd: root });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/escapes project root/);
    });

    it('rejects an absolute path outside root', () => {
      const verdict = evaluateToolCall('read_file', { path: '/etc/passwd' }, { rootCwd: root });
      expect(verdict.ok).toBe(false);
    });

    it('rejects a sneaky `..` in the middle', () => {
      const verdict = evaluateToolCall('read_file', { path: 'src/../../etc/passwd' }, { rootCwd: root });
      expect(verdict.ok).toBe(false);
    });

    it('allows list_files inside root', () => {
      const verdict = evaluateToolCall('list_files', { path: 'src' }, { rootCwd: root });
      expect(verdict.ok).toBe(true);
    });

    it('allows glob with path inside root', () => {
      const verdict = evaluateToolCall('glob', { pattern: '**/*.ts', path: 'src' }, { rootCwd: root });
      expect(verdict.ok).toBe(true);
    });

    it('allows grep with path inside root', () => {
      const verdict = evaluateToolCall('grep', { pattern: 'a', path: 'src' }, { rootCwd: root });
      expect(verdict.ok).toBe(true);
    });

    it('allows glob with no path (defaults to cwd)', () => {
      const verdict = evaluateToolCall('glob', { pattern: '**/*.ts' }, { rootCwd: root });
      expect(verdict.ok).toBe(true);
    });
  });

  describe('scope containment', () => {
    it('allows a path inside the specified scope', () => {
      const verdict = evaluateToolCall(
        'read_file',
        { path: 'src/a.ts' },
        { rootCwd: root, scopePaths: ['src'] },
      );
      expect(verdict.ok).toBe(true);
    });

    it('rejects a path inside root but outside scope', () => {
      const verdict = evaluateToolCall(
        'read_file',
        { path: 'tests/b.test.ts' },
        { rootCwd: root, scopePaths: ['src'] },
      );
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/outside packet scope/);
    });

    it('rejects a `..` escape even with scope set', () => {
      const verdict = evaluateToolCall(
        'read_file',
        { path: '../secret' },
        { rootCwd: root, scopePaths: ['src'] },
      );
      expect(verdict.ok).toBe(false);
    });

    it('allows paths in any of multiple scopes', () => {
      const v1 = evaluateToolCall('read_file', { path: 'src/a.ts' }, { rootCwd: root, scopePaths: ['src', 'tests'] });
      const v2 = evaluateToolCall('read_file', { path: 'tests/b.test.ts' }, { rootCwd: root, scopePaths: ['src', 'tests'] });
      expect(v1.ok).toBe(true);
      expect(v2.ok).toBe(true);
    });
  });

  describe('symlink escape', () => {
    it('rejects a symlink pointing outside root', () => {
      const outside = mkdtempSync(join(tmpdir(), 'outside-'));
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      // Create a symlink inside root pointing to outside.
      symlinkSync(join(outside, 'secret.txt'), join(root, 'src', 'escape.txt'));

      const verdict = evaluateToolCall('read_file', { path: 'src/escape.txt' }, { rootCwd: root });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/escapes project root/);
    });
  });

  describe('batch_read nested args', () => {
    it('validates each nested step path', () => {
      const verdict = evaluateToolCall(
        'batch_read',
        {
          steps: [
            { tool: 'read_file', args: { path: 'src/a.ts' } },
            { tool: 'read_file', args: { path: '../../../etc/passwd' } },
          ],
        },
        { rootCwd: root },
      );
      expect(verdict.ok).toBe(false);
    });

    it('allows batch_read when all steps are inside root', () => {
      const verdict = evaluateToolCall(
        'batch_read',
        {
          steps: [
            { tool: 'read_file', args: { path: 'src/a.ts' } },
            { tool: 'list_files', args: { path: 'tests' } },
          ],
        },
        { rootCwd: root },
      );
      expect(verdict.ok).toBe(true);
    });

    it('rejects batch_read step outside scope', () => {
      const verdict = evaluateToolCall(
        'batch_read',
        {
          steps: [{ tool: 'read_file', args: { path: 'tests/b.test.ts' } }],
        },
        { rootCwd: root, scopePaths: ['src'] },
      );
      expect(verdict.ok).toBe(false);
    });
  });

  describe('createChildToolExecutorGuard wrapper', () => {
    it('delegates to inner when containment passes', async () => {
      const inner = jest.fn().mockResolvedValue(JSON.stringify({ success: true, output: 'ok' }));
      const guard = createChildToolExecutorGuard(inner, { rootCwd: root });
      const result = await guard('read_file', { path: 'src/a.ts' });
      expect(inner).toHaveBeenCalledWith('read_file', { path: 'src/a.ts' }, undefined);
      expect(JSON.parse(result).success).toBe(true);
    });

    it('rejects without calling inner on escape', async () => {
      const inner = jest.fn().mockResolvedValue(JSON.stringify({ success: true }));
      const guard = createChildToolExecutorGuard(inner, { rootCwd: root });
      const result = await guard('read_file', { path: '../../../etc/passwd' });
      expect(inner).not.toHaveBeenCalled();
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/scope guard rejected/);
    });

    it('respects scopeHolder for per-packet scope', async () => {
      const inner = jest.fn().mockResolvedValue(JSON.stringify({ success: true }));
      const holder = new ScopeHolder();
      const guard = createChildToolExecutorGuard(inner, { rootCwd: root, scopeHolder: holder });

      // Scope = src: tests path should be rejected.
      holder.setScope(['src']);
      const rejected = await guard('read_file', { path: 'tests/b.test.ts' });
      expect(inner).not.toHaveBeenCalled();
      expect(JSON.parse(rejected).success).toBe(false);

      // Clear scope: only root containment applies, tests path now allowed.
      holder.clear();
      const allowed = await guard('read_file', { path: 'tests/b.test.ts' });
      expect(inner).toHaveBeenCalledTimes(1);
      expect(JSON.parse(allowed).success).toBe(true);
    });
  });
});
