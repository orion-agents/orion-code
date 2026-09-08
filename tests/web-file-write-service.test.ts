/**
 * v0.3.14 T1 — FileWriteServiceV1 contracts: CAS, fences, size/binary limits,
 * idempotent route wiring is covered at the server level; these unit tests
 * pin the service semantics against a real temp workspace.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FileReadServiceV1 } from '../src/web/file-read-service';
import { FileWriteServiceV1 } from '../src/web/file-write-service';

import { WebWorkbenchError } from '../src/web/errors';

function expectFileError(action: () => unknown, statusCode: number, code: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WebWorkbenchError);
  const err = caught as WebWorkbenchError;
  expect(err.status).toBe(statusCode);
  expect(err.code).toBe(code);
}

describe('FileWriteServiceV1 (v0.3.14 T1)', () => {
  let root: string;
  let workspace: string;
  let readService: FileReadServiceV1;
  let writeService: FileWriteServiceV1;
  let textFileId: string;
  let textRevision: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-web-filewrite-'));
    workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'notes.txt'), 'hello world\nsecond line\n');
    readService = new FileReadServiceV1(workspace);
    writeService = new FileWriteServiceV1(readService);
    const page = readService.list({});
    const node = page.items.find(item => item.name === 'notes.txt')!;
    textFileId = node.id;
    const content = readService.readContent({ fileId: textFileId });
    textRevision = content.revision;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('writes new content when the revision matches and reports the next revision', () => {
    const result = writeService.writeContent({
      fileId: textFileId,
      content: 'replaced\nwith three\nlines\n',
      expectedRevision: textRevision,
    });
    expect(result.sizeBytes).toBe(Buffer.byteLength('replaced\nwith three\nlines\n'));
    expect(result.revision).not.toBe(textRevision);
    expect(readFileSync(join(workspace, 'notes.txt'), 'utf8')).toBe(
      'replaced\nwith three\nlines\n'
    );
    // A second save with the OLD revision is rejected by CAS.
    expectFileError(
      () =>
        writeService.writeContent({
          fileId: textFileId,
          content: 'again',
          expectedRevision: textRevision,
        }),
      409,
      'file_revision_conflict'
    );
  });

  test('shrinking writes truncate the file exactly to the payload', () => {
    writeService.writeContent({
      fileId: textFileId,
      content: 'tiny',
      expectedRevision: textRevision,
    });
    const content = readFileSync(join(workspace, 'notes.txt'), 'utf8');
    expect(content).toBe('tiny');
    expect(content.length).toBe(4);
  });

  test('rejects payloads with NUL bytes and oversized content', () => {
    expectFileError(
      () =>
        writeService.writeContent({
          fileId: textFileId,
          content: 'bad\0content',
          expectedRevision: textRevision,
        }),
      415,
      'file_binary'
    );
    expectFileError(
      () =>
        writeService.writeContent({
          fileId: textFileId,
          content: 'x'.repeat(512 * 1024 + 1),
          expectedRevision: textRevision,
        }),
      413,
      'file_too_large'
    );
  });

  test('refuses to edit binary and sensitive targets through the fenced registry', () => {
    writeFileSync(join(workspace, 'blob.bin'), Buffer.from([0x00, 0x01, 0xff]));
    const page = readService.list({});
    const blob = page.items.find(item => item.name === 'blob.bin')!;
    const blobPage = readService.readContent({ fileId: blob.id });
    expect(blobPage.binary).toBe(true);
    expectFileError(
      () =>
        writeService.writeContent({
          fileId: blob.id,
          content: 'text',
          expectedRevision: blobPage.revision,
        }),
      415,
      'file_binary'
    );

    // .git is ignored by the tree walk, so a sensitive path cannot even be
    // remembered through the registry — writing it must fail as unknown.
    expectFileError(
      () =>
        writeService.writeContent({
          fileId: 'file_unknown',
          content: 'x',
          expectedRevision: textRevision,
        }),
      404,
      'file_not_found'
    );
  });

  test('does not follow symlinks that escape the workspace', () => {
    const outside = join(tmpdir(), `orion-escape-${Date.now()}.txt`);
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(workspace, 'escape.txt'));
    const page = readService.list({});
    const link = page.items.find(item => item.name === 'escape.txt')!;
    expectFileError(
      () =>
        writeService.writeContent({
          fileId: link.id,
          content: 'pwn',
          expectedRevision: textRevision,
        }),
      403,
      'file_outside_workspace'
    );
    expect(readFileSync(outside, 'utf8')).toBe('outside');
    // Remove the link and target before the shared cleanup walks the tree.
    rmSync(join(workspace, 'escape.txt'));
    rmSync(outside, { force: true });
  });

  test('accepts a CJK file whose 8 KiB sample ends inside a code point', () => {
    const cjk = join(workspace, 'cjk.txt');
    writeFileSync(cjk, `${'中文内容测试'.repeat(1500)}\n`, 'utf8');
    const page = readService.list({});
    const node = page.items.find(item => item.name === 'cjk.txt')!;
    const loaded = readService.readContent({ fileId: node.id });
    expect(loaded.binary).toBe(false);
    const result = writeService.writeContent({
      fileId: node.id,
      content: `${'中文内容测试'.repeat(1500)}\nupdated\n`,
      expectedRevision: loaded.revision,
    });
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(readFileSync(cjk, 'utf8')).toContain('updated');
  });

  test('validates the revision format before touching the disk', () => {
    expectFileError(
      () =>
        writeService.writeContent({
          fileId: textFileId,
          content: 'x',
          expectedRevision: 'deadbeef',
        }),
      400,
      'file_revision_invalid'
    );
    expect(readFileSync(join(workspace, 'notes.txt'), 'utf8')).toBe('hello world\nsecond line\n');
  });
});
