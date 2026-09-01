import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FileReadServiceV1 } from '../src/web/file-read-service';

describe('FileReadServiceV1', () => {
  let root: string;
  let workspace: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-web-files-'));
    workspace = join(root, 'workspace');
    mkdirSync(workspace);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('lazily pages opaque nodes and ignores private/build directories', () => {
    mkdirSync(join(workspace, '.git'));
    mkdirSync(join(workspace, 'node_modules'));
    writeFileSync(join(workspace, '.git', 'config'), 'must not list');
    writeFileSync(join(workspace, 'node_modules', 'package.js'), 'must not list');
    writeFileSync(join(workspace, 'a.txt'), 'a');
    writeFileSync(join(workspace, 'b.txt'), 'b');
    writeFileSync(join(workspace, 'c.txt'), 'c');
    const service = new FileReadServiceV1(workspace);

    const first = service.list({ pageSize: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.items.every(item => item.id.startsWith('file_'))).toBe(true);
    expect(first.items.every(item => item.displayPath === item.name)).toBe(true);
    expect(first.items.map(item => item.name)).not.toEqual(
      expect.arrayContaining(['.git', 'node_modules'])
    );
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = service.list({ pageSize: 2, cursor: first.nextCursor ?? undefined });
    expect([...first.items, ...second.items].map(item => item.name).sort()).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
    ]);
    expect(second.nextCursor).toBeNull();
    expect(JSON.stringify([...first.items, ...second.items])).not.toContain(workspace);
    expect(service.performanceCounters()).toMatchObject({
      readOperations: 2,
      bytesRead: 0,
    });
    expect(service.performanceCounters().itemsParsed).toBeGreaterThanOrEqual(3);
  });

  test('returns workspace-relative display paths while keeping operations opaque', () => {
    mkdirSync(join(workspace, 'src'));
    writeFileSync(join(workspace, 'src', 'nested.ts'), 'export {};\n');
    const service = new FileReadServiceV1(workspace);
    const directory = service.list().items.find(item => item.name === 'src')!;
    const nested = service.list({ parentId: directory.id }).items[0];

    expect(directory.displayPath).toBe('src');
    expect(nested.displayPath).toBe('src/nested.ts');
    expect(nested.id).not.toContain('nested.ts');
    expect(JSON.stringify(nested)).not.toContain(workspace);
  });

  test('returns bounded UTF-8 pages and binds cursors to immutable file revisions', () => {
    writeFileSync(join(workspace, 'notes.txt'), 'first line\nsecond line\n');
    const service = new FileReadServiceV1(workspace);
    const file = service.list().items.find(item => item.name === 'notes.txt')!;

    const first = service.readContent({ fileId: file.id, limitBytes: 8 });
    expect(first).toMatchObject({
      fileId: file.id,
      binary: false,
      offsetBytes: 0,
      content: 'first line\n',
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = service.readContent({
      fileId: file.id,
      cursor: first.nextCursor ?? undefined,
      limitBytes: 64,
    });
    expect(`${first.content}${second.content}`).toBe('first line\nsecond line\n');
    expect(service.performanceCounters()).toMatchObject({ readOperations: 3 });
    expect(service.performanceCounters().bytesRead).toBeGreaterThan(0);

    writeFileSync(join(workspace, 'notes.txt'), 'changed bytes\n');
    expect(() =>
      service.readContent({
        fileId: file.id,
        cursor: first.nextCursor ?? undefined,
        limitBytes: 64,
      })
    ).toThrow(expect.objectContaining({ status: 409, code: 'file_revision_conflict' }));
  });

  test('keeps redaction labels and values in one trusted page even with one-byte requests', () => {
    const marker = 'OPAQUE_PAGED_FILE_SECRET';
    writeFileSync(join(workspace, 'paged.log'), `alpha\ntoken=${marker}\nomega\n`);
    const service = new FileReadServiceV1(workspace);
    const file = service.list().items.find(item => item.name === 'paged.log')!;
    const pages: string[] = [];
    let cursor: string | undefined;
    do {
      const page = service.readContent({ fileId: file.id, cursor, limitBytes: 1 });
      pages.push(page.content ?? '');
      expect(page.content).not.toContain(marker);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(pages.join('')).toContain('[REDACTED_SECRET]');
    expect(pages.join('')).not.toContain(marker);
  });

  test('fails closed when one logical line exceeds the bounded preview budget', () => {
    writeFileSync(join(workspace, 'long.txt'), `token=${'x'.repeat(300_000)}\n`);
    const service = new FileReadServiceV1(workspace);
    const file = service.list().items.find(item => item.name === 'long.txt')!;
    expect(() => service.readContent({ fileId: file.id, limitBytes: 1 })).toThrow(
      expect.objectContaining({ status: 413, code: 'file_line_too_long' })
    );
  });

  test('fails closed for an over-budget line even when the caller requests the maximum page', () => {
    const marker = 'OPAQUE_MAX_PAGE_FILE_SECRET';
    writeFileSync(join(workspace, 'long-max.txt'), `token=${marker}${'x'.repeat(300_000)}\n`);
    const service = new FileReadServiceV1(workspace);
    const file = service.list().items.find(item => item.name === 'long-max.txt')!;

    expect(() => service.readContent({ fileId: file.id, limitBytes: 256 * 1024 })).toThrow(
      expect.objectContaining({ status: 413, code: 'file_line_too_long' })
    );
  });

  test('blocks sensitive content, classifies binary files and redacts ordinary text', () => {
    writeFileSync(join(workspace, '.env'), 'TOKEN=OPAQUE_FILE_SECRET');
    writeFileSync(join(workspace, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(workspace, 'log.txt'), 'token=OPAQUE_FILE_SECRET');
    const service = new FileReadServiceV1(workspace);
    const items = service.list().items;
    const sensitive = items.find(item => item.name === '.env')!;
    const binary = items.find(item => item.name === 'binary.dat')!;
    const log = items.find(item => item.name === 'log.txt')!;

    expect(sensitive.sensitive).toBe(true);
    expect(() => service.readContent({ fileId: sensitive.id })).toThrow(
      expect.objectContaining({ status: 403, code: 'sensitive_file_blocked' })
    );
    const binaryPage = service.readContent({ fileId: binary.id });
    expect(binaryPage).toMatchObject({
      binary: true,
      nextCursor: null,
    });
    expect(binaryPage).not.toHaveProperty('content');
    const text = service.readContent({ fileId: log.id });
    expect(text.content).toContain('[REDACTED_SECRET]');
    expect(text.content).not.toContain('OPAQUE_FILE_SECRET');
  });

  test('allows contained symlinks and fails closed for outside targets and forged ids', () => {
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'outside secret');
    writeFileSync(join(workspace, 'inside.txt'), 'inside');
    symlinkSync(join(workspace, 'inside.txt'), join(workspace, 'inside-link'));
    symlinkSync(outside, join(workspace, 'outside-link'));
    const service = new FileReadServiceV1(workspace);
    const items = service.list().items;
    const inside = items.find(item => item.name === 'inside-link')!;
    const escaped = items.find(item => item.name === 'outside-link')!;

    expect(inside).toMatchObject({ kind: 'symlink', readable: true });
    expect(service.readContent({ fileId: inside.id }).content).toBe('inside');
    expect(escaped).toMatchObject({ kind: 'symlink', readable: false });
    expect(() => service.readContent({ fileId: escaped.id })).toThrow(
      expect.objectContaining({ status: 403, code: 'file_outside_workspace' })
    );
    expect(() => service.readContent({ fileId: 'file_forged' })).toThrow(
      expect.objectContaining({ status: 404, code: 'file_not_found' })
    );
  });

  test('rejects stale or forged directory continuation cursors', () => {
    writeFileSync(join(workspace, 'a.txt'), 'a');
    writeFileSync(join(workspace, 'b.txt'), 'b');
    const service = new FileReadServiceV1(workspace);
    const first = service.list({ pageSize: 1 });
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(() => service.list({ pageSize: 1, cursor: `${first.nextCursor}x` })).toThrow(
      expect.objectContaining({ status: 400, code: 'file_cursor_invalid' })
    );

    writeFileSync(join(workspace, 'c.txt'), 'c');
    expect(() => service.list({ pageSize: 1, cursor: first.nextCursor ?? undefined })).toThrow(
      expect.objectContaining({ status: 409, code: 'file_revision_conflict' })
    );
  });
});
