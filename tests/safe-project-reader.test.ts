import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync, type Stats } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  inspectSafeProjectPath,
  readSafeProjectFilePrefix,
} from '../src/services/safe-project-reader';

const fsModule = jest.requireActual<typeof import('fs')>('fs');

describe('safe project reader', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-safe-reader-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  test('returns the canonical in-root path and a bounded regular-file prefix', () => {
    const path = join(root, 'fixture.txt');
    writeFileSync(path, 'abcdef');

    expect(inspectSafeProjectPath(path, root)).toMatchObject({ ok: true });
    const read = readSafeProjectFilePrefix(path, root, 3);
    expect(read).toMatchObject({ ok: true, sizeBytes: 6, truncated: true });
    if (read.ok) expect(read.bytes.toString('utf8')).toBe('abc');
  });

  test('rejects a directory at the regular-file read boundary', () => {
    expect(readSafeProjectFilePrefix(root, root, 10)).toMatchObject({
      ok: false,
      reason: 'non_regular',
    });
  });

  test('rejects a non-regular filesystem node during canonical inspection', () => {
    const path = join(root, 'node');
    writeFileSync(path, 'placeholder');
    const regularStats = fsModule.statSync(path);
    jest.spyOn(fsModule, 'statSync').mockReturnValueOnce({
      ...regularStats,
      isFile: () => false,
      isDirectory: () => false,
    } as Stats);

    expect(inspectSafeProjectPath(path, root)).toMatchObject({
      ok: false,
      reason: 'non_regular',
    });
  });

  test('fails closed when the target is replaced after descriptor open', () => {
    const path = join(root, 'target.txt');
    const previous = join(root, 'target.previous');
    const outside = `${root}-outside-secret.txt`;
    writeFileSync(path, 'trusted content');
    writeFileSync(outside, 'external secret');
    const realFstat = fsModule.fstatSync;
    jest.spyOn(fsModule, 'fstatSync').mockImplementationOnce(descriptor => {
      const openedStats = realFstat(descriptor);
      renameSync(path, previous);
      symlinkSync(outside, path);
      return openedStats;
    });

    try {
      const result = readSafeProjectFilePrefix(path, root, 100);
      expect(result).toMatchObject({ ok: false, reason: 'symlink' });
      if (!result.ok) expect(result.error).not.toContain(outside);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test('redacts underlying filesystem paths from root and open errors', () => {
    const path = join(root, 'fixture.txt');
    const secretPath = `${root}-outside-secret`;
    writeFileSync(path, 'content');
    jest.spyOn(fsModule, 'openSync').mockImplementationOnce(() => {
      throw Object.assign(new Error(`EACCES while opening ${secretPath}`), { code: 'EACCES' });
    });

    const openFailure = readSafeProjectFilePrefix(path, root, 100);
    expect(openFailure).toMatchObject({ ok: false, reason: 'unreadable' });
    if (!openFailure.ok) {
      expect(openFailure.error).not.toContain(secretPath);
      expect(openFailure.error).not.toContain(root);
    }

    const missingRoot = `${root}-missing-root-secret`;
    const rootFailure = inspectSafeProjectPath(join(missingRoot, 'file'), missingRoot);
    expect(rootFailure).toMatchObject({ ok: false, reason: 'unreadable' });
    if (!rootFailure.ok) expect(rootFailure.error).not.toContain(missingRoot);
  });
});
