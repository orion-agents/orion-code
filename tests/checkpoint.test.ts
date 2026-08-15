/**
 * Checkpoint unit tests
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  createCheckpoint,
  restoreCheckpoint,
  listCheckpoints,
  cleanupCheckpoints,
  shouldCreateMultiFileCheckpoint,
  CHECKPOINT_TTL_MS,
} from '../src/core/checkpoint';
import { getProjectCheckpointsDir } from '../src/services/config-dir';

const TEST_PROJECT = `/tmp/openhorse-checkpoint-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const OUTSIDE_FILE = path.join(
  path.dirname(TEST_PROJECT),
  `${path.basename(TEST_PROJECT)}-outside.txt`
);
const OUTSIDE_DIR = `${OUTSIDE_FILE}-dir`;

describe('checkpoint', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_PROJECT)) {
      fs.rmSync(TEST_PROJECT, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_PROJECT, { recursive: true });
    const checkpointDir = getProjectCheckpointsDir(TEST_PROJECT);
    if (fs.existsSync(checkpointDir)) {
      fs.rmSync(checkpointDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    const checkpointDir = getProjectCheckpointsDir(TEST_PROJECT);
    if (fs.existsSync(TEST_PROJECT)) {
      fs.rmSync(TEST_PROJECT, { recursive: true, force: true });
    }
    // Also clean up the checkpoint directory under ~/.orion-code
    if (fs.existsSync(checkpointDir)) {
      fs.rmSync(checkpointDir, { recursive: true, force: true });
    }
    fs.rmSync(OUTSIDE_FILE, { force: true });
    fs.rmSync(OUTSIDE_DIR, { recursive: true, force: true });
  });

  test('CHECKPOINT_TTL_MS is 7 days', () => {
    expect(CHECKPOINT_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test('createCheckpoint saves file content', () => {
    const filePath = path.join(TEST_PROJECT, 'test.txt');
    fs.writeFileSync(filePath, 'Hello, checkpoint!', 'utf8');

    const cp = createCheckpoint(TEST_PROJECT, 'turn-1', [filePath]);

    expect(cp).not.toBeNull();
    expect(cp!.turnId).toBe('turn-1');
    expect(cp!.files).toHaveLength(1);
    expect(cp!.files[0].path).toBe('test.txt');
    expect(cp!.files[0].sizeBytes).toBe(Buffer.byteLength('Hello, checkpoint!', 'utf8'));
  });

  test('createCheckpoint returns null for empty project path', () => {
    expect(createCheckpoint('', 'turn-1', ['/tmp/file.txt'])).toBeNull();
  });

  test('createCheckpoint returns null for empty file list', () => {
    expect(createCheckpoint(TEST_PROJECT, 'turn-1', [])).toBeNull();
  });

  test('createCheckpoint records non-existent files for deletion on restore', () => {
    const cp = createCheckpoint(TEST_PROJECT, 'turn-2', [
      path.join(TEST_PROJECT, 'nonexistent.txt'),
    ]);

    expect(cp).not.toBeNull();
    expect(cp!.files).toEqual([
      expect.objectContaining({
        path: 'nonexistent.txt',
        existed: false,
        sizeBytes: 0,
      }),
    ]);
  });

  test('createCheckpoint rejects an in-project symlink to an outside file without artifacts', () => {
    fs.writeFileSync(OUTSIDE_FILE, 'outside secret', 'utf8');
    const link = path.join(TEST_PROJECT, 'outside-link.txt');
    fs.symlinkSync(OUTSIDE_FILE, link);

    expect(createCheckpoint(TEST_PROJECT, 'turn-symlink-file', [link])).toBeNull();
    expect(
      fs.existsSync(path.join(getProjectCheckpointsDir(TEST_PROJECT), 'turn-symlink-file'))
    ).toBe(false);
    expect(fs.readFileSync(OUTSIDE_FILE, 'utf8')).toBe('outside secret');
  });

  test('createCheckpoint rejects a missing target below an outside directory symlink', () => {
    fs.mkdirSync(OUTSIDE_DIR);
    const linkDir = path.join(TEST_PROJECT, 'outside-dir');
    fs.symlinkSync(OUTSIDE_DIR, linkDir);

    expect(
      createCheckpoint(TEST_PROJECT, 'turn-symlink-parent', [path.join(linkDir, 'future.txt')])
    ).toBeNull();
    expect(
      fs.existsSync(path.join(getProjectCheckpointsDir(TEST_PROJECT), 'turn-symlink-parent'))
    ).toBe(false);
  });

  test('createCheckpoint is idempotent — second call returns null', () => {
    const filePath = path.join(TEST_PROJECT, 'test.txt');
    fs.writeFileSync(filePath, 'content', 'utf8');

    expect(createCheckpoint(TEST_PROJECT, 'turn-1', [filePath])).not.toBeNull();
    expect(createCheckpoint(TEST_PROJECT, 'turn-1', [filePath])).toBeNull();
  });

  test('createCheckpoint writes atomically — no leftover .tmp file (Issue #83)', () => {
    const filePath = path.join(TEST_PROJECT, 'atomic.txt');
    fs.writeFileSync(filePath, 'atomic content', 'utf8');

    const cpDir = getProjectCheckpointsDir(TEST_PROJECT);
    expect(createCheckpoint(TEST_PROJECT, 'turn-atomic', [filePath])).not.toBeNull();

    // The final checkpoint payload must exist and hold the content; the
    // intermediate random-suffixed temp file must have been renamed away.
    const payloadPath = path.join(cpDir, 'turn-atomic', 'atomic.txt');
    expect(fs.existsSync(payloadPath)).toBe(true);
    expect(fs.readFileSync(payloadPath, 'utf8')).toBe('atomic content');

    const leftovers = fs
      .readdirSync(cpDir, { recursive: true })
      .filter(f => String(f).includes('.tmp'));
    expect(leftovers).toHaveLength(0);
  });

  test('createCheckpoint handles a pre-existing checkpoint dir without throwing (mkdir TOCTOU, Issue #83)', () => {
    const filePath = path.join(TEST_PROJECT, 'race.txt');
    fs.writeFileSync(filePath, 'race content', 'utf8');

    // Pre-create the turn directory (simulating a concurrent mkdir race) so the
    // non-recursive mkdirSync hits EEXIST. The first create must still succeed.
    const cpDir = getProjectCheckpointsDir(TEST_PROJECT);
    fs.mkdirSync(path.join(cpDir, 'turn-race'), { recursive: true });

    expect(() => createCheckpoint(TEST_PROJECT, 'turn-race', [filePath])).not.toThrow();
    const result = createCheckpoint(TEST_PROJECT, 'turn-race', [filePath]);
    expect(result).toBeNull(); // second call is idempotent, not an EEXIST crash
  });

  test('restoreCheckpoint restores file content', () => {
    const filePath = path.join(TEST_PROJECT, 'restore.txt');
    fs.writeFileSync(filePath, 'original', 'utf8');

    createCheckpoint(TEST_PROJECT, 'turn-1', [filePath]);

    // Modify the file
    fs.writeFileSync(filePath, 'modified', 'utf8');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('modified');

    // Restore
    const result = restoreCheckpoint(TEST_PROJECT, 'turn-1');
    expect(result.error).toBeUndefined();
    expect(result.restored).toHaveLength(1);
    expect(result.restored[0]).toBe('restore.txt');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('original');
  });

  test('restoreCheckpoint preserves binary file bytes exactly', () => {
    const filePath = path.join(TEST_PROJECT, 'image.bin');
    const original = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0x42]);
    fs.writeFileSync(filePath, original);
    createCheckpoint(TEST_PROJECT, 'turn-binary', [filePath]);

    fs.writeFileSync(filePath, Buffer.from('modified'));
    const result = restoreCheckpoint(TEST_PROJECT, 'turn-binary');

    expect(result.error).toBeUndefined();
    expect(fs.readFileSync(filePath)).toEqual(original);
  });

  test('restoreCheckpoint reports failure and rolls back files already restored', () => {
    const first = path.join(TEST_PROJECT, 'first.txt');
    const readOnlyDir = path.join(TEST_PROJECT, 'read-only');
    const second = path.join(readOnlyDir, 'second.txt');
    fs.mkdirSync(readOnlyDir);
    fs.writeFileSync(first, 'checkpoint-first');
    fs.writeFileSync(second, 'checkpoint-second');
    createCheckpoint(TEST_PROJECT, 'turn-rollback', [first, second]);
    fs.writeFileSync(first, 'current-first');
    fs.writeFileSync(second, 'current-second');

    fs.chmodSync(readOnlyDir, 0o500);
    const result = restoreCheckpoint(TEST_PROJECT, 'turn-rollback');
    fs.chmodSync(readOnlyDir, 0o700);

    expect(result.error).toContain('Checkpoint restore failed');
    expect(result.rolledBack).toEqual(['first.txt']);
    expect(fs.readFileSync(first, 'utf8')).toBe('current-first');
    expect(fs.readFileSync(second, 'utf8')).toBe('current-second');
  });

  test('restoreCheckpoint deletes files that did not exist when checkpoint was created', () => {
    const filePath = path.join(TEST_PROJECT, 'new-file.txt');
    createCheckpoint(TEST_PROJECT, 'turn-new-file', [filePath]);

    fs.writeFileSync(filePath, 'created after checkpoint', 'utf8');
    expect(fs.existsSync(filePath)).toBe(true);

    const result = restoreCheckpoint(TEST_PROJECT, 'turn-new-file');
    expect(result.error).toBeUndefined();
    expect(result.restored).toEqual(['new-file.txt']);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test('restoreCheckpoint rejects checkpoint metadata paths outside the project', () => {
    const checkpointDir = path.join(getProjectCheckpointsDir(TEST_PROJECT), 'evil-turn');
    fs.mkdirSync(checkpointDir, { recursive: true });
    fs.writeFileSync(
      path.join(checkpointDir, '.checkpoint.json'),
      JSON.stringify({
        turnId: 'evil-turn',
        createdAt: Date.now(),
        files: [
          {
            path: `../${path.basename(OUTSIDE_FILE)}`,
            content: '',
            sizeBytes: 0,
          },
        ],
      }),
      'utf8'
    );

    if (fs.existsSync(OUTSIDE_FILE)) fs.rmSync(OUTSIDE_FILE, { force: true });

    const result = restoreCheckpoint(TEST_PROJECT, 'evil-turn');
    expect(result.error).toContain('Invalid checkpoint path');
    expect(fs.existsSync(OUTSIDE_FILE)).toBe(false);
  });

  test('restoreCheckpoint refuses metadata that targets an outside symlink', () => {
    fs.writeFileSync(OUTSIDE_FILE, 'outside current', 'utf8');
    fs.symlinkSync(OUTSIDE_FILE, path.join(TEST_PROJECT, 'outside-link.txt'));
    const checkpointDir = path.join(getProjectCheckpointsDir(TEST_PROJECT), 'symlink-turn');
    fs.mkdirSync(checkpointDir, { recursive: true });
    fs.writeFileSync(path.join(checkpointDir, 'outside-link.txt'), 'checkpoint data', 'utf8');
    fs.writeFileSync(
      path.join(checkpointDir, '.checkpoint.json'),
      JSON.stringify({
        turnId: 'symlink-turn',
        createdAt: Date.now(),
        files: [{ path: 'outside-link.txt', content: '', sizeBytes: 15, existed: true }],
      }),
      'utf8'
    );

    const result = restoreCheckpoint(TEST_PROJECT, 'symlink-turn');
    expect(result.error).toContain('Invalid checkpoint path');
    expect(fs.readFileSync(OUTSIDE_FILE, 'utf8')).toBe('outside current');
  });

  test('restoreCheckpoint returns error for non-existent checkpoint', () => {
    const result = restoreCheckpoint(TEST_PROJECT, 'nonexistent');
    expect(result.error).toContain('No checkpoint found');
    expect(result.restored).toHaveLength(0);
  });

  test('listCheckpoints returns sorted checkpoints', () => {
    const file1 = path.join(TEST_PROJECT, 'a.txt');
    const file2 = path.join(TEST_PROJECT, 'b.txt');
    fs.writeFileSync(file1, 'a', 'utf8');
    fs.writeFileSync(file2, 'b', 'utf8');

    createCheckpoint(TEST_PROJECT, 'turn-1', [file1]);
    // Ensure different createdAt
    const start = Date.now();
    while (Date.now() === start) {
      /* spin */
    }
    createCheckpoint(TEST_PROJECT, 'turn-2', [file2]);

    const checkpoints = listCheckpoints(TEST_PROJECT);
    expect(checkpoints).toHaveLength(2);
    // Sorted by createdAt descending
    expect(checkpoints[0].createdAt).toBeGreaterThanOrEqual(checkpoints[1].createdAt);
  });

  test('cleanupCheckpoints removes old checkpoints', () => {
    const filePath = path.join(TEST_PROJECT, 'old.txt');
    fs.writeFileSync(filePath, 'old', 'utf8');
    createCheckpoint(TEST_PROJECT, 'old-turn', [filePath]);

    // Find and age the checkpoint metadata
    const cpDir = getProjectCheckpointsDir(TEST_PROJECT);
    const oldMetaPath = path.join(cpDir, 'old-turn', '.checkpoint.json');

    expect(fs.existsSync(oldMetaPath)).toBe(true);
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago
    fs.utimesSync(oldMetaPath, oldTime, oldTime);

    cleanupCheckpoints(TEST_PROJECT);
    const remaining = listCheckpoints(TEST_PROJECT);
    expect(remaining).toHaveLength(0);
  });

  test('cleanupCheckpoints keeps recent checkpoints', () => {
    const filePath = path.join(TEST_PROJECT, 'recent.txt');
    fs.writeFileSync(filePath, 'recent', 'utf8');
    createCheckpoint(TEST_PROJECT, 'recent-turn', [filePath]);

    cleanupCheckpoints(TEST_PROJECT);
    const remaining = listCheckpoints(TEST_PROJECT);
    expect(remaining).toHaveLength(1);
  });

  test('shouldCreateMultiFileCheckpoint returns true when changed file count meets threshold', () => {
    expect(shouldCreateMultiFileCheckpoint(5)).toBe(true);
    expect(shouldCreateMultiFileCheckpoint(10)).toBe(true);
    expect(shouldCreateMultiFileCheckpoint(7, 3)).toBe(true);
  });

  test('shouldCreateMultiFileCheckpoint returns false when changed file count is below threshold', () => {
    expect(shouldCreateMultiFileCheckpoint(4)).toBe(false);
    expect(shouldCreateMultiFileCheckpoint(1, 5)).toBe(false);
    expect(shouldCreateMultiFileCheckpoint(0)).toBe(false);
  });
});
