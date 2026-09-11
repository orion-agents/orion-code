/**
 * v0.3.16 — controller contract for the LOCAL WORKSPACE picker.
 *
 * Covers the two invariants that matter: `inspectWorkspacePath` is strictly
 * read-only (it must not register anything), and the native picker is a
 * single-in-flight browse action.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { WorkspaceRegistryV1 } from '../src/services/workspace-registry';
import type { NativeDirectoryPicker } from '../src/web/native-directory-picker';
import { WebWorkbenchController } from '../src/web/workbench-controller';
import { createFakeWebRuntime } from './support/web-runtime';

describe('WebWorkbenchController workspace picker', () => {
  let root: string;
  let active: string;
  let project: string;
  let registry: WorkspaceRegistryV1;
  const controllers: WebWorkbenchController[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-workspace-picker-'));
    active = join(root, 'active');
    project = join(root, 'project');
    mkdirSync(active, { recursive: true });
    mkdirSync(project, { recursive: true });
    registry = new WorkspaceRegistryV1({
      storagePath: join(root, 'config', 'workspaces.v1.json'),
    });
  });

  afterEach(async () => {
    // Shut controllers down before removing the temp tree: a live watcher timer
    // would otherwise fire against a deleted workspace.
    while (controllers.length) await controllers.pop()?.shutdown();
    rmSync(root, { recursive: true, force: true });
  });

  const createController = async (
    picker: NativeDirectoryPicker = { pickDirectory: async () => ({ kind: 'cancelled' }) }
  ) => {
    const controller = await WebWorkbenchController.create({
      cwd: active,
      createRuntime: async cwd => createFakeWebRuntime(cwd),
      workspaceRegistry: registry,
      nativeDirectoryPicker: picker,
    });
    controllers.push(controller);
    return controller;
  };

  describe('inspectWorkspacePath', () => {
    it('describes a Git directory without registering it', async () => {
      mkdirSync(join(project, '.git'));
      const controller = await createController();

      const candidate = controller.inspectWorkspacePath(project, 'picker');

      expect(candidate.availability).toBe('available');
      expect(candidate.kind).toBe('git');
      expect(candidate.source).toBe('picker');
      expect(candidate.label).toBe('project');
      // Read-only contract: inspection must not create a registry entry.
      expect(controller.listWorkspaces().map(entry => entry.path)).not.toContain(
        candidate.canonicalPath
      );
      expect(registry.list().map(entry => entry.canonicalPath)).not.toContain(
        candidate.canonicalPath
      );
    });

    it('treats a directory without .git as a plain folder', async () => {
      const controller = await createController();
      expect(controller.inspectWorkspacePath(project)).toMatchObject({
        kind: 'folder',
        availability: 'available',
        source: 'manual',
      });
    });

    it('reports a missing path instead of throwing', async () => {
      const controller = await createController();
      const candidate = controller.inspectWorkspacePath(join(root, 'nope'));
      expect(candidate.availability).toBe('missing');
    });

    it('reports a file as not_directory', async () => {
      const file = join(root, 'file.txt');
      writeFileSync(file, 'x');
      const controller = await createController();
      expect(controller.inspectWorkspacePath(file).availability).toBe('not_directory');
    });

    it('links an already-registered path to its workspace id', async () => {
      const entry = registry.register(project);
      const controller = await createController();
      expect(controller.inspectWorkspacePath(project).existingWorkspaceId).toBe(entry.id);
    });
  });

  describe('pickDirectory', () => {
    it('passes the picker result through unchanged', async () => {
      const controller = await createController({
        pickDirectory: async () => ({ kind: 'selected' as const, path: '/tmp/chosen' }),
      });
      await expect(controller.pickDirectory({})).resolves.toEqual({
        kind: 'selected',
        path: '/tmp/chosen',
      });
    });

    it('surfaces an unavailable picker verbatim', async () => {
      const controller = await createController({
        pickDirectory: async () => ({ kind: 'unavailable' as const, reason: 'picker_unavailable' }),
      });
      await expect(controller.pickDirectory({})).resolves.toEqual({
        kind: 'unavailable',
        reason: 'picker_unavailable',
      });
    });

    it('allows only one picker at a time', async () => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const controller = await createController({
        pickDirectory: async () => {
          await gate;
          return { kind: 'cancelled' as const };
        },
      });

      const first = controller.pickDirectory({});
      await expect(controller.pickDirectory({})).rejects.toMatchObject({ code: 'picker_busy' });
      release();
      await expect(first).resolves.toEqual({ kind: 'cancelled' });
      // The guard releases once the first picker settles.
      await expect(controller.pickDirectory({})).resolves.toEqual({ kind: 'cancelled' });
    });

    it('rejects a blank inspected path', async () => {
      const controller = await createController();
      expect(() => controller.inspectWorkspacePath('   ')).toThrow(/directory path is required/i);
    });
  });
});
