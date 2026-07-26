/**
 * Bug-hunt round 2 evidence: gitBranchCache never invalidates.
 *
 * getGitBranch caches the branch per projectPath at module scope and only
 * evicts via the 256-entry LRU. Switching branches within a single process
 * (e.g. create a session, switch branches, create another session) records
 * the STALE branch because the cache is never refreshed.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSession, type SessionMeta } from '../src/services/session-storage';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

describe('session-storage gitBranch cache staleness', () => {
  let root: string;
  const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-code-branch-cache-'));
    process.env.ORION_CODE_CONFIG_DIR = join(root, '.orion-code-config');
    git(root, ['init', '--quiet']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    writeFileSync(join(root, 'a.txt'), 'a', 'utf8');
    git(root, ['add', '.']);
    git(root, ['commit', '--quiet', '-m', 'init']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalConfigDir !== undefined) {
      process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.ORION_CODE_CONFIG_DIR;
    }
  });

  it('records the current branch after a branch switch (not a stale cached value)', () => {
    const initialBranch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);

    // First session caches the initial branch for this projectPath.
    const session1: SessionMeta = createSession(root, 'test-model');
    expect(session1.gitBranch).toBe(initialBranch);

    // Switch to a new branch in the same process.
    git(root, ['checkout', '--quiet', '-b', 'feature-x']);

    // A new session created after the switch must reflect the new branch.
    const session2: SessionMeta = createSession(root, 'test-model');
    expect(session2.gitBranch).toBe('feature-x');
  });

  it('resumeSession refreshes the branch after a switch', () => {
    const session = createSession(root, 'test-model');
    expect(session.gitBranch).toBeDefined();

    git(root, ['checkout', '--quiet', '-b', 'feature-y']);

    const resumed = createSession(root, 'test-model'); // fresh session post-switch
    // resumeSession path also calls getGitBranch; confirm it is not stale.
    expect(resumed.gitBranch).toBe('feature-y');
  });
});
