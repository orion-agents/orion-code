import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { WorkspaceRegistryError, WorkspaceRegistryV1 } from '../src/services/workspace-registry';

describe('WorkspaceRegistryV1', () => {
  let root: string;
  let registryPath: string;
  let first: string;
  let second: string;
  let tick: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-workspace-registry-'));
    registryPath = join(root, 'config', 'workspaces.v1.json');
    first = join(root, 'first-project');
    second = join(root, 'second-project');
    mkdirSync(first);
    mkdirSync(second);
    tick = Date.parse('2026-08-29T00:00:00.000Z');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const createRegistry = () =>
    new WorkspaceRegistryV1({
      storagePath: registryPath,
      now: () => new Date((tick += 1_000)),
      createId: (() => {
        let id = 0;
        return () => `workspace-${++id}`;
      })(),
    });

  test('persists zero-session projects with stable opaque identities', () => {
    const registry = createRegistry();
    const created = registry.register(first, { activated: true });
    expect(created).toMatchObject({
      id: 'workspace-1',
      canonicalPath: realpathSync(first),
      label: 'first-project',
    });
    const again = registry.register(first);
    expect(again.id).toBe(created.id);

    const reopened = new WorkspaceRegistryV1({ storagePath: registryPath });
    expect(reopened.list()).toEqual([again]);
    expect(JSON.parse(readFileSync(registryPath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      entries: [{ id: 'workspace-1', canonicalPath: realpathSync(first) }],
    });
  });

  test('imports known projects idempotently and orders pinned before recent', () => {
    const registry = createRegistry();
    const imported = registry.registerKnown([first, second, first], second);
    expect(imported).toHaveLength(2);
    const firstEntry = imported.find(entry => entry.canonicalPath === realpathSync(first));
    const secondEntry = imported.find(entry => entry.canonicalPath === realpathSync(second));
    expect(firstEntry).toBeDefined();
    expect(secondEntry).toBeDefined();

    registry.setPinned(firstEntry!.id, true);
    expect(registry.list().map(entry => entry.id)).toEqual([firstEntry!.id, secondEntry!.id]);
    expect(
      registry
        .registerKnown([first, second], second)
        .map(entry => entry.id)
        .sort()
    ).toEqual([firstEntry!.id, secondEntry!.id].sort());
  });

  test('canonicalizes directory aliases and rejects files or missing paths', () => {
    const alias = join(root, 'first-alias');
    symlinkSync(first, alias);
    const registry = createRegistry();
    expect(registry.register(alias).id).toBe(registry.register(first).id);

    const file = join(root, 'file.txt');
    writeFileSync(file, 'not a directory');
    expect(() => registry.register(file)).toThrow(
      expect.objectContaining({ code: 'workspace_unavailable' })
    );
    expect(() => registry.register(join(root, 'missing'))).toThrow(WorkspaceRegistryError);
  });

  test('rejects corrupt bytes without overwriting them', () => {
    mkdirSync(join(root, 'config'));
    writeFileSync(registryPath, '{bad-json', { mode: 0o600 });
    const registry = createRegistry();
    expect(() => registry.list()).toThrow(
      expect.objectContaining({ code: 'workspace_registry_invalid' })
    );
    expect(() => registry.register(first)).toThrow(
      expect.objectContaining({ code: 'workspace_registry_invalid' })
    );
    expect(readFileSync(registryPath, 'utf8')).toBe('{bad-json');
  });

  test('supports pinning and explicit removal without deleting project data', () => {
    const registry = createRegistry();
    const entry = registry.register(first);
    expect(registry.setPinned(entry.id, true).pinnedOrder).toBe(1);
    expect(registry.setPinned(entry.id, false).pinnedOrder).toBeUndefined();
    expect(registry.remove(entry.id)).toBe(true);
    expect(registry.remove(entry.id)).toBe(false);
    expect(registry.list()).toEqual([]);
    expect(existsSync(first)).toBe(true);
    expect(statSync(first).isDirectory()).toBe(true);
  });
});
