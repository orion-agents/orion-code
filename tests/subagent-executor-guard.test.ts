/**
 * R3 regression tests: ChildToolExecutorGuard project-root and scope isolation.
 *
 * Verifies that path-bearing tool args (read_file, list_files, glob, grep,
 * batch_read nested) are containment-checked against the project root and
 * packet scope. Covers absolute paths, `../` escapes, outside-scope files,
 * symlink escapes, and batch_read nested args.
 */

import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'fs';
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
      const verdict = evaluateToolCall(
        'read_file',
        { path: join(root, 'src', 'a.ts') },
        { rootCwd: root }
      );
      expect(verdict.ok).toBe(true);
    });

    it('rejects a `..` escape', () => {
      const verdict = evaluateToolCall(
        'read_file',
        { path: '../../../etc/passwd' },
        { rootCwd: root }
      );
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/escapes project root/);
    });

    it('rejects an absolute path outside root', () => {
      const verdict = evaluateToolCall('read_file', { path: '/etc/passwd' }, { rootCwd: root });
      expect(verdict.ok).toBe(false);
    });

    it('rejects a sneaky `..` in the middle', () => {
      const verdict = evaluateToolCall(
        'read_file',
        { path: 'src/../../etc/passwd' },
        { rootCwd: root }
      );
      expect(verdict.ok).toBe(false);
    });

    it('allows list_files inside root', () => {
      const verdict = evaluateToolCall('list_files', { path: 'src' }, { rootCwd: root });
      expect(verdict.ok).toBe(true);
    });

    it('allows glob with path inside root', () => {
      const verdict = evaluateToolCall(
        'glob',
        { pattern: '**/*.ts', path: 'src' },
        { rootCwd: root }
      );
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

    it('allows root-bound git_status when packet scope is empty', () => {
      const verdict = evaluateToolCall('git_status', {}, { rootCwd: root, scopePaths: [] });

      expect(verdict.ok).toBe(true);
    });

    it('allows relative and absolute git_status cwd values contained by root', () => {
      const relativeVerdict = evaluateToolCall(
        'git_status',
        { cwd: 'src' },
        { rootCwd: root, scopePaths: [] }
      );
      const absoluteVerdict = evaluateToolCall(
        'git_status',
        { cwd: join(root, 'src') },
        { rootCwd: root, scopePaths: [] }
      );

      expect(relativeVerdict.ok).toBe(true);
      expect(absoluteVerdict.ok).toBe(true);
    });

    it('normalizes and rejects external git_status cwd values', () => {
      const outside = mkdtempSync(join(tmpdir(), 'outside-git-status-'));
      const variants = [
        outside,
        '../outside',
        `file://${outside}`,
        `[outside](<${outside}>)`,
        `\`${outside}\``,
      ];

      for (const cwd of variants) {
        const verdict = evaluateToolCall('git_status', { cwd }, { rootCwd: root, scopePaths: [] });
        expect(verdict.ok).toBe(false);
      }
    });

    it('only treats cwd as git_status filesystem input, matching its schema', () => {
      const verdict = evaluateToolCall(
        'git_status',
        { path: '/etc', workdir: '/etc' },
        { rootCwd: root, scopePaths: [] }
      );

      expect(verdict.ok).toBe(true);
    });

    it('rejects explicit and default-root grep when a descendant file symlink escapes root', () => {
      const outside = mkdtempSync(join(tmpdir(), 'outside-root-grep-'));
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      symlinkSync(join(outside, 'secret.txt'), join(root, 'src', 'outside.txt'));

      const explicitVerdict = evaluateToolCall(
        'grep',
        { pattern: 'secret', path: 'src' },
        { rootCwd: root, scopePaths: [] }
      );
      const defaultRootVerdict = evaluateToolCall(
        'grep',
        { pattern: 'secret' },
        { rootCwd: root, scopePaths: [] }
      );

      expect(explicitVerdict.ok).toBe(false);
      expect(defaultRootVerdict.ok).toBe(false);
      if (!explicitVerdict.ok) expect(explicitVerdict.reason).toMatch(/escapes project root/);
      if (!defaultRootVerdict.ok) expect(defaultRootVerdict.reason).toMatch(/escapes project root/);
    });

    it('allows root-only grep when a descendant file symlink stays inside root', () => {
      symlinkSync(join(root, 'src', 'a.ts'), join(root, 'src', 'inside-link.ts'));

      const verdict = evaluateToolCall(
        'grep',
        { pattern: 'export', path: 'src' },
        { rootCwd: root, scopePaths: [] }
      );

      expect(verdict.ok).toBe(true);
    });

    it('normalizes known-tool file URLs, Markdown links, and wrapping quotes before checking', () => {
      const outside = mkdtempSync(join(tmpdir(), 'outside-normalized-'));
      const outsideFile = join(outside, 'secret file.txt');
      writeFileSync(outsideFile, 'secret');
      const encodedFileUrl = new URL(`file://${outsideFile}`).toString();
      const variants = [
        encodedFileUrl,
        `[secret](<${outsideFile}>)`,
        `[secret](${outsideFile} "outside file")`,
        `'${outsideFile}'`,
        `"${outsideFile}"`,
        `\`${outsideFile}\``,
      ];

      for (const path of variants) {
        expect(evaluateToolCall('read_file', { path }, { rootCwd: root }).ok).toBe(false);
      }

      expect(
        evaluateToolCall(
          'read_file',
          { path: `[source](<${join(root, 'src', 'a.ts')}>)` },
          { rootCwd: root }
        ).ok
      ).toBe(true);
    });

    it('validates nested unknown-tool resourceUri and location arguments against root', () => {
      const resourceVerdict = evaluateToolCall(
        'mcp__resources__read',
        { options: { resourceUri: 'file:///etc/passwd' } },
        { rootCwd: root }
      );
      const locationVerdict = evaluateToolCall(
        'mcp__resources__read',
        { metadata: { location: '/etc/passwd' } },
        { rootCwd: root }
      );

      expect(resourceVerdict.ok).toBe(false);
      expect(locationVerdict.ok).toBe(false);
    });

    it.each(['filepath', 'source', 'destination', 'target'])(
      'validates unknown-tool %s arguments against root',
      key => {
        const verdict = evaluateToolCall(
          'mcp__filesystem__operation',
          { options: { [key]: '/etc/passwd' } },
          { rootCwd: root }
        );

        expect(verdict.ok).toBe(false);
      }
    );

    it('fails closed for an uncertified pathless MCP tool with an empty packet scope', () => {
      const verdict = evaluateToolCall(
        'mcp__web__search',
        { query: 'Orion Code' },
        { rootCwd: root, scopePaths: [] }
      );

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/not certified scope-agnostic/);
    });

    it('fails closed for opaque unknown-tool arguments with an empty packet scope', () => {
      const verdict = evaluateToolCall(
        'mcp__filesystem__opaque_reader',
        { selector: '/etc/passwd' },
        { rootCwd: root, scopePaths: [] }
      );

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/not certified scope-agnostic/);
    });

    it('preserves explicit scope-agnostic certification for a root-only child', () => {
      const verdict = evaluateToolCall(
        'mcp__web__search',
        { query: 'Orion Code' },
        {
          rootCwd: root,
          scopePaths: [],
          scopeAgnosticTools: ['mcp__web__search'],
        }
      );

      expect(verdict.ok).toBe(true);
    });
  });

  describe('scope containment', () => {
    it('allows a path inside the specified scope', () => {
      const verdict = evaluateToolCall(
        'read_file',
        { path: 'src/a.ts' },
        { rootCwd: root, scopePaths: ['src'] }
      );
      expect(verdict.ok).toBe(true);
    });

    it('rejects a path inside root but outside scope', () => {
      const verdict = evaluateToolCall(
        'read_file',
        { path: 'tests/b.test.ts' },
        { rootCwd: root, scopePaths: ['src'] }
      );
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/outside packet scope/);
    });

    it('rejects a `..` escape even with scope set', () => {
      const verdict = evaluateToolCall(
        'read_file',
        { path: '../secret' },
        { rootCwd: root, scopePaths: ['src'] }
      );
      expect(verdict.ok).toBe(false);
    });

    it('allows paths in any of multiple scopes', () => {
      const v1 = evaluateToolCall(
        'read_file',
        { path: 'src/a.ts' },
        { rootCwd: root, scopePaths: ['src', 'tests'] }
      );
      const v2 = evaluateToolCall(
        'read_file',
        { path: 'tests/b.test.ts' },
        { rootCwd: root, scopePaths: ['src', 'tests'] }
      );
      expect(v1.ok).toBe(true);
      expect(v2.ok).toBe(true);
    });

    it('does not widen a missing scope path to its existing ancestor', () => {
      const verdict = evaluateToolCall(
        'read_file',
        { path: 'src/a.ts' },
        { rootCwd: root, scopePaths: ['src/not-created'] }
      );

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/outside packet scope/);
    });

    it('allows a not-yet-created target inside a missing scope path', () => {
      const verdict = evaluateToolCall(
        'read_file',
        { path: 'src/not-created/generated.ts' },
        { rootCwd: root, scopePaths: ['src/not-created'] }
      );

      expect(verdict.ok).toBe(true);
    });

    it.each(['glob', 'grep'])('rejects scoped %s calls without an explicit path', tool => {
      const verdict = evaluateToolCall(
        tool,
        { pattern: '**/*.ts' },
        { rootCwd: root, scopePaths: ['src'] }
      );

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/requires explicit path/);
    });

    it('rejects root-bound git_status under a non-empty packet scope', () => {
      const verdict = evaluateToolCall('git_status', {}, { rootCwd: root, scopePaths: ['src'] });

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/root-bound.*packet scope/);
    });

    it('fails closed for an uncertified MCP filesystem tool outside scope', () => {
      const verdict = evaluateToolCall(
        'mcp__filesystem__read_file',
        { path: '/etc/passwd' },
        { rootCwd: root, scopePaths: ['src'] }
      );

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/not certified scope-agnostic/);
    });

    it('fails closed for an uncertified MCP filesystem tool inside scope', () => {
      const verdict = evaluateToolCall(
        'mcp__filesystem__read_file',
        { path: 'src/a.ts' },
        { rootCwd: root, scopePaths: ['src'] }
      );

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/not certified scope-agnostic/);
    });

    it('fails closed for a pathless MCP call unless explicitly certified', () => {
      const verdict = evaluateToolCall(
        'mcp__web__search',
        { query: 'Orion Code' },
        { rootCwd: root, scopePaths: ['src'] }
      );

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/not certified scope-agnostic/);
    });

    it('allows an explicitly certified pathless MCP call under scope', () => {
      const verdict = evaluateToolCall(
        'mcp__web__search',
        { query: 'Orion Code' },
        {
          rootCwd: root,
          scopePaths: ['src'],
          scopeAgnosticTools: ['mcp__web__search'],
        }
      );

      expect(verdict.ok).toBe(true);
    });

    it('rejects path-like args even for an explicitly certified scope-agnostic tool', () => {
      const verdict = evaluateToolCall(
        'mcp__web__search',
        { request: { resourceUri: 'file:///etc/passwd' } },
        {
          rootCwd: root,
          scopePaths: ['src'],
          scopeAgnosticTools: ['mcp__web__search'],
        }
      );

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/requires pathless arguments/);
    });

    it('rejects an unkeyed nested file URL for a certified scope-agnostic tool', () => {
      const verdict = evaluateToolCall(
        'mcp__web__search',
        { query: { value: 'file:///etc/passwd' } },
        {
          rootCwd: root,
          scopePaths: ['src'],
          scopeAgnosticTools: ['mcp__web__search'],
        }
      );

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/requires pathless arguments/);
    });

    it('does not treat ordinary HTTP URLs as filesystem paths', () => {
      const builtInVerdict = evaluateToolCall(
        'web_fetch',
        { url: 'https://example.com/docs' },
        { rootCwd: root, scopePaths: ['src'] }
      );
      const certifiedVerdict = evaluateToolCall(
        'mcp__web__search',
        { resourceUri: 'https://example.com/resource' },
        {
          rootCwd: root,
          scopePaths: ['src'],
          scopeAgnosticTools: ['mcp__web__search'],
        }
      );

      expect(builtInVerdict.ok).toBe(true);
      expect(certifiedVerdict.ok).toBe(true);
    });

    it.each(['time', 'web_search', 'web_fetch'])(
      'allows explicitly built-in scope-agnostic %s without path-like arguments',
      tool => {
        const verdict = evaluateToolCall(
          tool,
          { query: 'Orion Code' },
          { rootCwd: root, scopePaths: ['src'] }
        );

        expect(verdict.ok).toBe(true);
      }
    );

    it('allows scoped glob with an outside descendant symlink because glob does not follow it', () => {
      const outside = mkdtempSync(join(tmpdir(), 'outside-glob-'));
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      symlinkSync(join(outside, 'secret.txt'), join(root, 'src', 'outside.txt'));

      const verdict = evaluateToolCall(
        'glob',
        { pattern: '**/*.ts', path: 'src' },
        { rootCwd: root, scopePaths: ['src'] }
      );

      expect(verdict.ok).toBe(true);
    });

    it('rejects scoped grep when a searched descendant symlink points outside scope', () => {
      const outside = mkdtempSync(join(tmpdir(), 'outside-grep-'));
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      symlinkSync(join(outside, 'secret.txt'), join(root, 'src', 'outside.txt'));

      const verdict = evaluateToolCall(
        'grep',
        { pattern: 'secret', path: 'src' },
        { rootCwd: root, scopePaths: ['src'] }
      );

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/descendant symlink escapes/);
    });

    it('ignores an outside grep symlink excluded by args.glob', () => {
      const outside = mkdtempSync(join(tmpdir(), 'outside-grep-filtered-'));
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      symlinkSync(join(outside, 'secret.txt'), join(root, 'src', 'outside.txt'));

      const verdict = evaluateToolCall(
        'grep',
        { pattern: 'secret', path: 'src', glob: '*.ts' },
        { rootCwd: root, scopePaths: ['src'] }
      );

      expect(verdict.ok).toBe(true);
    });

    it('ignores hidden outside symlinks because grep skips hidden entries', () => {
      const outside = mkdtempSync(join(tmpdir(), 'outside-grep-hidden-'));
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      symlinkSync(join(outside, 'secret.txt'), join(root, 'src', '.outside.txt'));

      const verdict = evaluateToolCall(
        'grep',
        { pattern: 'secret', path: 'src' },
        { rootCwd: root, scopePaths: ['src'] }
      );

      expect(verdict.ok).toBe(true);
    });

    it('ignores outside directory symlinks because grep only streams files', () => {
      const outside = mkdtempSync(join(tmpdir(), 'outside-grep-directory-'));
      symlinkSync(outside, join(root, 'src', 'outside.txt'));

      const verdict = evaluateToolCall(
        'grep',
        { pattern: 'secret', path: 'src', glob: '*.txt' },
        { rootCwd: root, scopePaths: ['src'] }
      );

      expect(verdict.ok).toBe(true);
    });

    it('ignores dangling symlinks because grep skips them before streaming', () => {
      const outside = mkdtempSync(join(tmpdir(), 'outside-grep-dangling-'));
      symlinkSync(join(outside, 'missing.txt'), join(root, 'src', 'dangling.txt'));

      const verdict = evaluateToolCall(
        'grep',
        { pattern: 'secret', path: 'src', glob: '*.txt' },
        { rootCwd: root, scopePaths: ['src'] }
      );

      expect(verdict.ok).toBe(true);
    });

    it('rejects an outside grep symlink included by args.glob', () => {
      const outside = mkdtempSync(join(tmpdir(), 'outside-grep-included-'));
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      symlinkSync(join(outside, 'secret.txt'), join(root, 'src', 'outside.txt'));

      const verdict = evaluateToolCall(
        'grep',
        { pattern: 'secret', path: 'src', glob: '*.txt' },
        { rootCwd: root, scopePaths: ['src'] }
      );

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/descendant symlink escapes/);
    });

    it('allows scoped grep when a searched descendant symlink stays inside scope', () => {
      symlinkSync(join(root, 'src', 'a.ts'), join(root, 'src', 'inside-link.ts'));

      const verdict = evaluateToolCall(
        'grep',
        { pattern: 'export', path: 'src', glob: '*.ts' },
        { rootCwd: root, scopePaths: ['src'] }
      );

      expect(verdict.ok).toBe(true);
    });

    it('validates camelCase path-like arguments from unknown tools', () => {
      const verdict = evaluateToolCall(
        'mcp__filesystem__custom_reader',
        { options: { filePath: 'tests/b.test.ts' } },
        { rootCwd: root, scopePaths: ['src'] }
      );

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/not certified scope-agnostic/);
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
        { rootCwd: root }
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
        { rootCwd: root }
      );
      expect(verdict.ok).toBe(true);
    });

    it('allows root-bound git_status in batch_read when packet scope is empty', () => {
      const verdict = evaluateToolCall(
        'batch_read',
        { steps: [{ tool: 'git_status', args: {} }] },
        { rootCwd: root, scopePaths: [] }
      );

      expect(verdict.ok).toBe(true);
    });

    it('rejects root-bound git_status in batch_read under packet scope', () => {
      const verdict = evaluateToolCall(
        'batch_read',
        { steps: [{ tool: 'git_status', args: {} }] },
        { rootCwd: root, scopePaths: ['src'] }
      );

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/root-bound.*packet scope/);
    });

    it('guards serialized batch_read git_status cwd before delegation', () => {
      const outside = mkdtempSync(join(tmpdir(), 'outside-batch-git-status-'));
      const insideVerdict = evaluateToolCall(
        'batch_read',
        {
          steps: JSON.stringify([
            { tool: 'git_status', args: JSON.stringify({ cwd: join(root, 'src') }) },
          ]),
        },
        { rootCwd: root, scopePaths: [] }
      );
      const outsideVerdict = evaluateToolCall(
        'batch_read',
        {
          steps: JSON.stringify([
            { tool: 'git_status', args: JSON.stringify({ cwd: `file://${outside}` }) },
          ]),
        },
        { rootCwd: root, scopePaths: [] }
      );

      expect(insideVerdict.ok).toBe(true);
      expect(outsideVerdict.ok).toBe(false);
    });

    it('rejects root-only batch_read grep through an outside descendant symlink', () => {
      const outside = mkdtempSync(join(tmpdir(), 'outside-batch-grep-'));
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      symlinkSync(join(outside, 'secret.txt'), join(root, 'src', 'outside.txt'));

      const verdict = evaluateToolCall(
        'batch_read',
        { steps: [{ tool: 'grep', args: { pattern: 'secret', path: 'src' } }] },
        { rootCwd: root, scopePaths: [] }
      );

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/escapes project root/);
    });

    it('allows root-only batch_read grep through an inside descendant symlink', () => {
      symlinkSync(join(root, 'src', 'a.ts'), join(root, 'src', 'inside-link.ts'));

      const verdict = evaluateToolCall(
        'batch_read',
        { steps: [{ tool: 'grep', args: { pattern: 'export', path: 'src' } }] },
        { rootCwd: root, scopePaths: [] }
      );

      expect(verdict.ok).toBe(true);
    });

    it('rejects batch_read step outside scope', () => {
      const verdict = evaluateToolCall(
        'batch_read',
        {
          steps: [{ tool: 'read_file', args: { path: 'tests/b.test.ts' } }],
        },
        { rootCwd: root, scopePaths: ['src'] }
      );
      expect(verdict.ok).toBe(false);
    });

    it('rejects a scoped batch_read search step without an explicit path', () => {
      const verdict = evaluateToolCall(
        'batch_read',
        {
          steps: [{ tool: 'grep', args: { pattern: 'secret' } }],
        },
        { rootCwd: root, scopePaths: ['src'] }
      );

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/grep requires explicit path/);
    });

    it('validates path-like arguments in an unknown nested batch step', () => {
      const verdict = evaluateToolCall(
        'batch_read',
        {
          steps: [{ tool: 'mcp__filesystem__read_file', args: { path: '/etc/passwd' } }],
        },
        { rootCwd: root, scopePaths: ['src'] }
      );

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/not allowed in batch_read/);
    });

    it('parses JSON string steps and JSON string step args before guarding', () => {
      const verdict = evaluateToolCall(
        'batch_read',
        {
          steps: JSON.stringify([
            { tool: 'read_file', args: JSON.stringify({ path: 'src/a.ts' }) },
            { tool: 'read_file', args: JSON.stringify({ path: '/etc/passwd' }) },
          ]),
        },
        { rootCwd: root }
      );

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/escapes project root/);
    });

    it('allows JSON string steps and args when every path is contained', () => {
      const verdict = evaluateToolCall(
        'batch_read',
        {
          steps: JSON.stringify([
            { tool: 'read_file', args: JSON.stringify({ path: 'src/a.ts' }) },
            { tool: 'list_files', args: JSON.stringify({ path: 'src' }) },
          ]),
        },
        { rootCwd: root, scopePaths: ['src'] }
      );

      expect(verdict.ok).toBe(true);
    });

    it('rejects a scoped JSON string search step without an explicit path', () => {
      const verdict = evaluateToolCall(
        'batch_read',
        {
          steps: JSON.stringify([{ tool: 'grep', args: JSON.stringify({ pattern: 'secret' }) }]),
        },
        { rootCwd: root, scopePaths: ['src'] }
      );

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/grep requires explicit path/);
    });

    it.each([
      '{not-json',
      JSON.stringify([{ tool: 'read_file', args: '{not-json' }]),
      JSON.stringify([]),
    ])('rejects malformed batch_read input: %s', steps => {
      const verdict = evaluateToolCall('batch_read', { steps }, { rootCwd: root });

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/invalid batch_read/);
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

    it('rejects uncertified MCP calls without scope before invoking inner', async () => {
      const inner = jest.fn().mockResolvedValue(JSON.stringify({ success: true }));
      const guard = createChildToolExecutorGuard(inner, { rootCwd: root });

      const result = await guard('mcp__filesystem__opaque_reader', {
        selector: '/etc/passwd',
      });

      expect(inner).not.toHaveBeenCalled();
      expect(JSON.parse(result).error).toMatch(/not certified scope-agnostic/);
    });

    it('delegates root-bound git_status only when the current packet scope is empty', async () => {
      const inner = jest.fn().mockResolvedValue(JSON.stringify({ success: true }));
      const holder = new ScopeHolder();
      const guard = createChildToolExecutorGuard(inner, { rootCwd: root, scopeHolder: holder });

      const allowed = await guard('git_status', { cwd: join(root, 'src') });
      const outside = mkdtempSync(join(tmpdir(), 'outside-wrapper-git-status-'));
      const escaped = await guard('git_status', { cwd: `[outside](<${outside}>)` });
      holder.setScope(['src']);
      const rejected = await guard('git_status', {});

      expect(JSON.parse(allowed).success).toBe(true);
      expect(JSON.parse(escaped).success).toBe(false);
      expect(JSON.parse(rejected).success).toBe(false);
      expect(JSON.parse(rejected).error).toMatch(/root-bound.*packet scope/);
      expect(inner).toHaveBeenCalledTimes(1);
    });

    it('canonicalizes omitted and relative git_status cwd before delegation', async () => {
      const inner = jest.fn().mockResolvedValue(JSON.stringify({ success: true }));
      const guard = createChildToolExecutorGuard(inner, { rootCwd: root });

      await guard('git_status', {});
      await guard('git_status', { cwd: 'src' });

      const canonicalRoot = realpathSync(root);
      expect(inner).toHaveBeenNthCalledWith(1, 'git_status', { cwd: canonicalRoot }, undefined);
      expect(inner).toHaveBeenNthCalledWith(
        2,
        'git_status',
        { cwd: join(canonicalRoot, 'src') },
        undefined
      );
    });

    it('canonicalizes serialized batch_read git_status cwd before delegation', async () => {
      const inner = jest.fn().mockResolvedValue(JSON.stringify({ success: true }));
      const guard = createChildToolExecutorGuard(inner, { rootCwd: root });

      await guard('batch_read', {
        steps: JSON.stringify([{ tool: 'git_status', args: JSON.stringify({ cwd: 'src' }) }]),
      });

      expect(inner).toHaveBeenCalledWith(
        'batch_read',
        {
          steps: [{ tool: 'git_status', args: { cwd: join(realpathSync(root), 'src') } }],
        },
        undefined
      );
    });

    it('rejects root-only grep symlink escape before wrapper delegation', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'outside-wrapper-grep-'));
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      symlinkSync(join(outside, 'secret.txt'), join(root, 'src', 'outside.txt'));
      const inner = jest.fn().mockResolvedValue(JSON.stringify({ success: true }));
      const guard = createChildToolExecutorGuard(inner, { rootCwd: root });

      const result = await guard('grep', { pattern: 'secret', path: 'src' });

      expect(JSON.parse(result).success).toBe(false);
      expect(JSON.parse(result).error).toMatch(/escapes project root/);
      expect(inner).not.toHaveBeenCalled();
    });

    it('delegates root-only grep when descendant symlinks stay inside root', async () => {
      symlinkSync(join(root, 'src', 'a.ts'), join(root, 'src', 'inside-link.ts'));
      const inner = jest.fn().mockResolvedValue(JSON.stringify({ success: true }));
      const guard = createChildToolExecutorGuard(inner, { rootCwd: root });

      const result = await guard('grep', { pattern: 'export', path: 'src' });

      expect(JSON.parse(result).success).toBe(true);
      expect(inner).toHaveBeenCalledTimes(1);
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

    it('forwards explicit scope-agnostic certifications through the wrapper', async () => {
      const inner = jest.fn().mockResolvedValue(JSON.stringify({ success: true }));
      const guard = createChildToolExecutorGuard(inner, {
        rootCwd: root,
        scopePaths: ['src'],
        scopeAgnosticTools: ['mcp__web__search'],
      });

      const result = await guard('mcp__web__search', { query: 'Orion Code' });

      expect(inner).toHaveBeenCalledTimes(1);
      expect(JSON.parse(result).success).toBe(true);
    });

    it('keeps clear isolated to the current async scope and restores the parent scope', async () => {
      const holder = new ScopeHolder();
      holder.setScope(['tests']);

      let releaseSibling!: () => void;
      const childCleared = new Promise<void>(resolve => {
        releaseSibling = resolve;
      });

      const first = holder.runWithScope(['src'], async () => {
        expect(holder.getScope()).toEqual(['src']);
        holder.clear();
        expect(holder.getScope()).toEqual([]);
        releaseSibling();
      });
      const sibling = holder.runWithScope(['tests'], async () => {
        await childCleared;
        expect(holder.getScope()).toEqual(['tests']);
      });

      await Promise.all([first, sibling]);
      expect(holder.getScope()).toEqual(['tests']);
    });
  });
});
