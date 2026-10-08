import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  MAX_WORKSPACE_ROOTS,
  WorkspaceRootsRegistryError,
  WorkspaceRootsRegistryV1,
} from '../src/services/workspace-roots-registry';

describe('WorkspaceRootsRegistryV1', () => {
  let storageDir: string;
  let storagePath: string;
  let registry: WorkspaceRootsRegistryV1;

  beforeEach(() => {
    storageDir = mkdtempSync(join(tmpdir(), 'orion-roots-'));
    storagePath = join(storageDir, 'workspace-roots.v1.json');
    registry = new WorkspaceRootsRegistryV1({ storagePath });
  });

  afterEach(() => {
    rmSync(storageDir, { recursive: true, force: true });
  });

  it('adds a root with a canonical path, a label, and 0600 permissions', () => {
    const projectDir = join(storageDir, 'projects', 'alpha');
    mkdirSync(projectDir, { recursive: true });
    const entry = registry.add(join(projectDir, 'subdir', '..'));
    expect(entry.canonicalPath).toBe(realpathSync(projectDir));
    expect(entry.label).toBe('alpha');
    expect(entry.lastScannedAt).toBeUndefined();
    expect(existsSync(storagePath)).toBe(true);
    // The file holds local directory structure: it must not be world-readable.
    const mode = storagePath && require('fs').statSync(storagePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('dedupes by canonical path and keeps the original id', () => {
    const projectDir = join(storageDir, 'beta');
    mkdirSync(projectDir, { recursive: true });
    const first = registry.add(projectDir);
    const second = registry.add(`${projectDir}/.`);
    expect(second.id).toBe(first.id);
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects a nonexistent root with workspace_root_unavailable', () => {
    expect(() => registry.add(join(storageDir, 'does-not-exist'))).toThrow(
      WorkspaceRootsRegistryError
    );
    try {
      registry.add(join(storageDir, 'does-not-exist'));
    } catch (error) {
      expect((error as WorkspaceRootsRegistryError).code).toBe('workspace_root_unavailable');
    }
  });

  it('rejects a file (not a directory) as a root', () => {
    const filePath = join(storageDir, 'a-file.txt');
    writeFileSync(filePath, 'content');
    expect(() => registry.add(filePath)).toThrow(WorkspaceRootsRegistryError);
  });

  it('enforces the roots capacity', () => {
    const tight = new WorkspaceRootsRegistryV1({ storagePath });
    // Fill the capacity via the registry constant.
    for (let index = 0; index < MAX_WORKSPACE_ROOTS; index += 1) {
      const dir = join(storageDir, `root-${index}`);
      mkdirSync(dir, { recursive: true });
      tight.add(dir);
    }
    const overflow = join(storageDir, 'overflow');
    mkdirSync(overflow, { recursive: true });
    try {
      tight.add(overflow);
      throw new Error('expected capacity error');
    } catch (error) {
      expect((error as WorkspaceRootsRegistryError).code).toBe('workspace_roots_capacity');
    }
  });

  it('removes a root by id and reports false for unknown ids', () => {
    const dir = join(storageDir, 'removable');
    mkdirSync(dir, { recursive: true });
    const entry = registry.add(dir);
    expect(registry.remove(entry.id)).toBe(true);
    expect(registry.list()).toHaveLength(0);
    expect(registry.remove(entry.id)).toBe(false);
  });

  it('marks a root as scanned', () => {
    const dir = join(storageDir, 'scanned');
    mkdirSync(dir, { recursive: true });
    const entry = registry.add(dir);
    const scanned = registry.markScanned(entry.id, '2026-10-08T00:00:00.000Z');
    expect(scanned?.lastScannedAt).toBe('2026-10-08T00:00:00.000Z');
    expect(registry.find(entry.id)?.lastScannedAt).toBe('2026-10-08T00:00:00.000Z');
    expect(registry.markScanned('missing-id')).toBeUndefined();
  });

  it('round-trips the document through the storage file', () => {
    const dir = join(storageDir, 'round-trip');
    mkdirSync(dir, { recursive: true });
    const entry = registry.add(dir);
    registry.markScanned(entry.id, '2026-10-08T01:02:03.000Z');
    const reloaded = new WorkspaceRootsRegistryV1({ storagePath });
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0].canonicalPath).toBe(entry.canonicalPath);
    expect(reloaded.list()[0].lastScannedAt).toBe('2026-10-08T01:02:03.000Z');
  });
});
