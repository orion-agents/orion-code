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

import * as sessionStorage from '../src/services/session-storage';
import { WorkspaceRegistryV1 } from '../src/services/workspace-registry';
import type { NativeDirectoryPicker } from '../src/web/native-directory-picker';
import type { WorkspaceOpenTelemetrySnapshotV1 } from '../src/web/workspace-open-telemetry';
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

  describe('inspectWorkspaceFast', () => {
    it('describes a Git directory without registering it', async () => {
      mkdirSync(join(project, '.git'));
      const controller = await createController();

      const candidate = await controller.inspectWorkspaceFast(project, 'picker');

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

    it('never triggers the catalog rebuild path while previewing', async () => {
      const controller = await createController();
      const spy = jest.spyOn(sessionStorage, 'countSessionsByProject');
      spy.mockClear();

      const candidate = await controller.inspectWorkspaceFast(project);

      // The preview must read the warm cache only. Calling countSessionsByProject
      // can rebuild the catalog and hold the file lock for up to 10s, which is
      // exactly what must not gate the confirmation card.
      expect(spy).not.toHaveBeenCalled();
      expect(candidate.sessionCountStatus).toBe('ready');
      spy.mockRestore();
    });

    it('fills the session count once the catalog is already warm', async () => {
      // Warm the in-process catalog cache first (as ordinary listing would).
      sessionStorage.countSessionsByProject();
      const controller = await createController();
      const warm = await controller.inspectWorkspaceFast(project);
      expect(warm.sessionCountStatus).toBe('ready');
      expect(warm.sessionCount).toBe(0);
    });

    it('treats a directory without .git as a plain folder', async () => {
      const controller = await createController();
      await expect(controller.inspectWorkspaceFast(project)).resolves.toMatchObject({
        kind: 'folder',
        availability: 'available',
        source: 'manual',
      });
    });

    it('reports a missing path instead of throwing', async () => {
      const controller = await createController();
      const candidate = await controller.inspectWorkspaceFast(join(root, 'nope'));
      expect(candidate.availability).toBe('missing');
    });

    it('reports a file as not_directory', async () => {
      const file = join(root, 'file.txt');
      writeFileSync(file, 'x');
      const controller = await createController();
      expect((await controller.inspectWorkspaceFast(file)).availability).toBe('not_directory');
    });

    it('links an already-registered path to its workspace id', async () => {
      const entry = registry.register(project);
      const controller = await createController();
      expect((await controller.inspectWorkspaceFast(project)).existingWorkspaceId).toBe(entry.id);
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
      await expect(controller.inspectWorkspaceFast('   ')).rejects.toThrow(
        /directory path is required/i
      );
    });
  });

  describe('open-path telemetry', () => {
    const openTraces = async (controller: WebWorkbenchController) =>
      (await controller.diagnostics()).workspaceOpen as WorkspaceOpenTelemetrySnapshotV1;

    it('records a picker trace without leaking the chosen path', async () => {
      const controller = await createController({
        pickDirectory: async () => ({
          kind: 'selected' as const,
          path: '/Users/hope/top-secret-project',
        }),
      });

      await controller.pickDirectory({ requestId: '11111111-1111-4111-8111-111111111111' });

      const { recent } = await openTraces(controller);
      expect(recent).toHaveLength(1);
      expect(recent[0]).toMatchObject({
        requestId: '11111111-1111-4111-8111-111111111111',
        operation: 'pick-directory',
        outcome: 'success',
      });
      expect(recent[0].stages.picker_launch).toBeGreaterThanOrEqual(0);
      expect(recent[0].stages.picker_result).toBeGreaterThanOrEqual(0);
      // Privacy contract: a trace never carries a path.
      expect(JSON.stringify(recent)).not.toContain('top-secret');
    });

    it('marks a cancelled picker as cancelled, not failed', async () => {
      const controller = await createController({
        pickDirectory: async () => ({ kind: 'cancelled' as const }),
      });

      await controller.pickDirectory({ requestId: '33333333-3333-4333-8333-333333333333' });

      const { recent } = await openTraces(controller);
      expect(recent[0].outcome).toBe('cancelled');
    });

    it('records an inspect trace with fs and session-count stages', async () => {
      const controller = await createController();

      await controller.inspectWorkspaceFast(
        project,
        'manual',
        '22222222-2222-4222-8222-222222222222'
      );

      const { recent } = await openTraces(controller);
      const [trace] = recent;
      expect(trace).toMatchObject({
        requestId: '22222222-2222-4222-8222-222222222222',
        operation: 'inspect',
        outcome: 'success',
      });
      expect(trace.stages.inspect_fs).toBeGreaterThanOrEqual(0);
      expect(trace.stages.inspect_session_count).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(trace)).not.toContain(project);
    });
  });
});
