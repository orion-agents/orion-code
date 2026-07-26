import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { captureWorkspaceSnapshot, diffWorkspaceSnapshots } from '../src/services/workspace-state';

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

describe('workspace-state', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openhorse-workspace-state-'));
    git(root, ['init']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('captures dirty git status without reading file contents', () => {
    writeFileSync(join(root, 'existing.txt'), 'secret-ish content should not appear in snapshot', 'utf8');

    const snapshot = captureWorkspaceSnapshot(root);

    expect(snapshot.gitAvailable).toBe(true);
    expect(snapshot.dirty).toBe(true);
    expect(snapshot.fileCount).toBe(1);
    expect(snapshot.files).toEqual([
      expect.objectContaining({ path: 'existing.txt', status: '??' }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('secret-ish content');
  });

  it('diffs pre-existing, new, and resolved workspace files', () => {
    writeFileSync(join(root, 'existing.txt'), 'before', 'utf8');
    const before = captureWorkspaceSnapshot(root);

    writeFileSync(join(root, 'new.txt'), 'after', 'utf8');
    rmSync(join(root, 'existing.txt'));
    const after = captureWorkspaceSnapshot(root);

    expect(diffWorkspaceSnapshots(before, after)).toEqual({
      preExistingFiles: ['existing.txt'],
      filesAfterTurn: ['new.txt'],
      newFilesByTurn: ['new.txt'],
      changedByTurn: ['new.txt'],
      modifiedPreExistingByTurn: [],
      resolvedByTurn: ['existing.txt'],
    });
  });

  it('detects pre-existing dirty files modified again during a turn', () => {
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test User']);
    writeFileSync(join(root, 'tracked.txt'), 'clean\n', 'utf8');
    git(root, ['add', 'tracked.txt']);
    git(root, ['commit', '-m', 'initial']);

    writeFileSync(join(root, 'tracked.txt'), 'dirty before\n', 'utf8');
    const before = captureWorkspaceSnapshot(root);

    writeFileSync(join(root, 'tracked.txt'), 'dirty before\nmodified by turn\n', 'utf8');
    const after = captureWorkspaceSnapshot(root);

    expect(diffWorkspaceSnapshots(before, after)).toMatchObject({
      preExistingFiles: ['tracked.txt'],
      filesAfterTurn: ['tracked.txt'],
      newFilesByTurn: [],
      changedByTurn: ['tracked.txt'],
      modifiedPreExistingByTurn: ['tracked.txt'],
      resolvedByTurn: [],
    });
  });
});
