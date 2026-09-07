/**
 * v0.3.12 S4 — workspace search bounds (ignored/hidden/sensitive/out-of-root
 * excluded, binary skipped for content, caps enforced).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FileReadServiceV1 } from '../src/web/file-read-service';

function makeFixture(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'oc312-search-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules/pkg'), { recursive: true });
  mkdirSync(join(root, '.hidden'), { recursive: true });
  writeFileSync(join(root, 'src', 'wishlist.ts'), 'export const wish = "orion search";\n');
  writeFileSync(join(root, 'wish.txt'), 'plain text with wish inside\n');
  writeFileSync(join(root, 'node_modules/pkg', 'wish.js'), 'module.exports = "wish";\n');
  writeFileSync(join(root, '.hidden', 'wish.md'), 'wish hidden\n');
  writeFileSync(join(root, '.env'), 'WISH_SECRET=leak\n');
  writeFileSync(join(root, 'bin.dat'), Buffer.concat([Buffer.alloc(32, 0), Buffer.from('wish')]));
  const outside = mkdtempSync(join(tmpdir(), 'oc312-outside-'));
  writeFileSync(join(outside, 'wish.out'), 'outside wish\n');
  symlinkSync(join(outside, 'wish.out'), join(root, 'outside-link'));
  return {
    root,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    },
  };
}

describe('workspace search (v0.3.12 S4)', () => {
  test('name scope finds files but never ignored/hidden/sensitive/out-of-root ones', () => {
    const { root, cleanup } = makeFixture();
    try {
      const service = new FileReadServiceV1(root);
      const result = service.search({ query: 'wish', scope: 'name', limit: 100 });
      const paths = result.items.map(item => item.path).sort();
      expect(paths).toEqual(['src/wishlist.ts', 'wish.txt']);
      expect(result.truncated).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('content scope matches inside text files and skips binary payloads', () => {
    const { root, cleanup } = makeFixture();
    try {
      const service = new FileReadServiceV1(root);
      const byName = service
        .search({ query: 'wishlist', scope: 'content' })
        .items.map(item => item.path);
      expect(byName).toEqual(['src/wishlist.ts']);
      const byContent = service
        .search({ query: 'plain text with', scope: 'content' })
        .items.map(item => item.path);
      expect(byContent).toEqual(['wish.txt']);
      // binary file carries 'wish' bytes but must not appear via content
      const binary = service
        .search({ query: 'wish', scope: 'content' })
        .items.map(item => item.path);
      expect(binary).not.toContain('bin.dat');
    } finally {
      cleanup();
    }
  });

  test('search result ids open through readContent preview', () => {
    const { root, cleanup } = makeFixture();
    try {
      const service = new FileReadServiceV1(root);
      const result = service.search({ query: 'wish', scope: 'name' });
      const file = result.items.find(item => item.path === 'wish.txt');
      expect(file).toBeDefined();
      const page = service.readContent({ fileId: (file as { id: string }).id, limitBytes: 1024 });
      expect(page.name).toBe('wish.txt');
      expect(page.content).toContain('wish');
    } finally {
      cleanup();
    }
  });

  test('requires a non-empty query', () => {
    const { root, cleanup } = makeFixture();
    try {
      const service = new FileReadServiceV1(root);
      expect(() => service.search({ query: '   ', scope: 'name' })).toThrow(/query/);
    } finally {
      cleanup();
    }
  });
});
