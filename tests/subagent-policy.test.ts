import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  evaluateSubtaskPolicy,
  canonicalizeScopePaths,
  hasExplicitDelegationIntent,
  clampSubagentConfig,
  type PolicyContext,
} from '../src/runtime/subagents/policy';
import { DEFAULT_SUBAGENT_CONFIG } from '../src/runtime/subagents/types';
import type { SubtaskRequest, SubagentConfig } from '../src/runtime/subagents/types';

function makeCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    depth: 0,
    cwd: '/tmp/project',
    config: { ...DEFAULT_SUBAGENT_CONFIG },
    rootObjective: 'parallel research of runtime, session and tui modules',
    tasksStartedThisTurn: 0,
    runningChildren: 0,
    hasPendingPermission: false,
    parentAborted: false,
    remainingModelRequests: 12,
    providerCanReserve: () => true,
    ...overrides,
  };
}

function researchPacket(objective: string, paths?: string[]): SubtaskRequest['tasks'][number] {
  return {
    role: 'research',
    objective,
    reason: 'independent investigation',
    scope: paths ? { paths } : undefined,
  };
}

const REQUEST = (tasks: SubtaskRequest['tasks'], execution: 'parallel' | 'serial' = 'parallel'): SubtaskRequest => ({
  tasks,
  execution,
});

describe('subagent policy', () => {
  describe('canonicalizeScopePaths', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'subagent-scope-'));
    });

    it('accepts paths inside the project root', () => {
      mkdirSync(join(dir, 'src'));
      const result = canonicalizeScopePaths(dir, ['src', 'src/index.ts']);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.paths).toEqual(['src', 'src/index.ts']);
      }
    });

    it('rejects parent-directory traversal', () => {
      const result = canonicalizeScopePaths(dir, ['../../../etc/passwd']);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('scope_escape');
    });

    it('rejects absolute paths outside root', () => {
      const result = canonicalizeScopePaths(dir, ['/etc']);
      expect(result.ok).toBe(false);
    });

    it('rejects symlink escaping the root', () => {
      const outside = mkdtempSync(join(tmpdir(), 'subagent-outside-'));
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      mkdirSync(join(dir, 'linkdir'));
      symlinkSync(outside, join(dir, 'linkdir', 'escape'));
      const result = canonicalizeScopePaths(dir, ['linkdir/escape/secret.txt']);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('scope_escape');
    });

    it('accepts empty and undefined paths', () => {
      expect(canonicalizeScopePaths(dir, undefined).ok).toBe(true);
      expect(canonicalizeScopePaths(dir, []).ok).toBe(true);
    });
  });

  describe('hasExplicitDelegationIntent', () => {
    it('detects English delegation intent', () => {
      expect(hasExplicitDelegationIntent('investigate these modules in parallel')).toBe(true);
      expect(hasExplicitDelegationIntent('run a review subagent')).toBe(true);
    });
    it('detects CJK delegation intent', () => {
      expect(hasExplicitDelegationIntent('并行调研三个模块')).toBe(true);
      expect(hasExplicitDelegationIntent('分别审查')).toBe(true);
    });
    it('rejects plain single-task intent', () => {
      expect(hasExplicitDelegationIntent('fix the typo in readme')).toBe(false);
      expect(hasExplicitDelegationIntent('read this file')).toBe(false);
    });
  });

  describe('clampSubagentConfig', () => {
    it('clamps out-of-range values to enforced bounds', () => {
      const clamped = clampSubagentConfig({
        ...DEFAULT_SUBAGENT_CONFIG,
        maxParallel: 99,
        maxTasksPerTurn: 0,
        timeoutMs: 1,
      } as SubagentConfig);
      expect(clamped.maxParallel).toBe(3);
      expect(clamped.maxTasksPerTurn).toBe(1);
      expect(clamped.timeoutMs).toBe(5_000);
    });

    it('drops unknown roles and falls back to defaults when empty', () => {
      const clamped = clampSubagentConfig({
        ...DEFAULT_SUBAGENT_CONFIG,
        roles: ['research', 'bogus' as 'research', 'review'],
      });
      expect(clamped.roles).toEqual(['research', 'review']);
      const empty = clampSubagentConfig({ ...DEFAULT_SUBAGENT_CONFIG, roles: [] });
      expect(empty.roles).toEqual(['research', 'review', 'test-investigate']);
    });

    it('normalizes invalid mode to auto', () => {
      const clamped = clampSubagentConfig({ ...DEFAULT_SUBAGENT_CONFIG, mode: 'weird' as 'auto' });
      expect(clamped.mode).toBe('auto');
    });
  });

  describe('evaluateSubtaskPolicy allow/reject (table-driven)', () => {
    const cases: Array<{ name: string; verdict: string; ctx?: Partial<PolicyContext>; req: () => SubtaskRequest }> = [
      { name: 'allows a bounded parallel research batch', verdict: 'allow', req: () => REQUEST([researchPacket('Find all cancel-signal handlers in runtime')]) },
      { name: 'rejects when mode is off', verdict: 'mode_off', ctx: { config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'off' } }, req: () => REQUEST([researchPacket('Investigate something')]) },
      { name: 'rejects when depth is not root', verdict: 'not_root_depth', ctx: { depth: 1 }, req: () => REQUEST([researchPacket('Investigate something')]) },
      { name: 'rejects empty request', verdict: 'empty_request', req: () => REQUEST([]) },
      { name: 'rejects too many tasks in one call', verdict: 'too_many_tasks', req: () => REQUEST([researchPacket('a'), researchPacket('b'), researchPacket('c'), researchPacket('d')]) },
      { name: 'rejects disabled role', verdict: 'role_disabled', ctx: { config: { ...DEFAULT_SUBAGENT_CONFIG, roles: ['research'] } }, req: () => REQUEST([{ role: 'review', objective: 'Review the diff for regressions', reason: 'independent' }]) },
      { name: 'rejects unbounded objective', verdict: 'objective_unbounded', req: () => REQUEST([researchPacket('处理一下')]) },
      { name: 'rejects pending permission', verdict: 'pending_permission', ctx: { hasPendingPermission: true }, req: () => REQUEST([researchPacket('Investigate something')]) },
      { name: 'rejects parent aborted', verdict: 'parent_aborted', ctx: { parentAborted: true }, req: () => REQUEST([researchPacket('Investigate something')]) },
      { name: 'rejects budget exhaustion', verdict: 'budget_exhausted', ctx: { remainingModelRequests: 0 }, req: () => REQUEST([researchPacket('Investigate something')]) },
      { name: 'rejects provider unavailable', verdict: 'provider_unavailable', ctx: { providerCanReserve: () => false }, req: () => REQUEST([researchPacket('Investigate something')]) },
      { name: 'rejects concurrency overflow with running children', verdict: 'concurrency_limit', ctx: { runningChildren: 2, config: { ...DEFAULT_SUBAGENT_CONFIG, maxParallel: 3 } }, req: () => REQUEST([researchPacket('a'), researchPacket('b')]) },
    ];

    for (const c of cases) {
      it(c.name, () => {
        const verdict = evaluateSubtaskPolicy(c.req(), makeCtx(c.ctx));
        if (c.verdict === 'allow') {
          expect(verdict.allowed).toBe(true);
        } else {
          expect(verdict.allowed).toBe(false);
          if (!verdict.allowed) expect(verdict.reason).toBe(c.verdict);
        }
      });
    }
  });

  describe('evaluateSubtaskPolicy explicit mode', () => {
    it('rejects in explicit mode without delegation intent', () => {
      const ctx = makeCtx({
        config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'explicit' },
        rootObjective: 'fix the typo in readme',
      });
      const verdict = evaluateSubtaskPolicy(REQUEST([researchPacket('Investigate the typo')]), ctx);
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toBe('explicit_intent_missing');
    });

    it('allows in explicit mode with delegation intent', () => {
      const ctx = makeCtx({
        config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'explicit' },
        rootObjective: 'review the diff and check for missing tests in parallel',
      });
      const verdict = evaluateSubtaskPolicy(REQUEST([researchPacket('Review the diff')]), ctx);
      expect(verdict.allowed).toBe(true);
    });
  });

  describe('evaluateSubtaskPolicy scope handling', () => {
    it('canonicalizes allowed scope and returns it', () => {
      const dir = mkdtempSync(join(tmpdir(), 'subagent-scope-'));
      mkdirSync(join(dir, 'src'));
      const verdict = evaluateSubtaskPolicy(
        REQUEST([researchPacket('Investigate src', ['src'])]),
        makeCtx({ cwd: dir }),
      );
      expect(verdict.allowed).toBe(true);
      if (verdict.allowed) {
        expect(verdict.canonicalScope.get(0)).toEqual(['src']);
      }
    });

    it('rejects scope escape', () => {
      const dir = mkdtempSync(join(tmpdir(), 'subagent-scope-'));
      const verdict = evaluateSubtaskPolicy(
        REQUEST([researchPacket('Investigate', ['../../../etc'])]),
        makeCtx({ cwd: dir }),
      );
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toBe('scope_escape');
    });

    it('rejects duplicate scope within a batch', () => {
      const dir = mkdtempSync(join(tmpdir(), 'subagent-scope-'));
      mkdirSync(join(dir, 'src'));
      const verdict = evaluateSubtaskPolicy(
        REQUEST([
          researchPacket('Investigate src part A', ['src']),
          researchPacket('Investigate src part B', ['src']),
        ]),
        makeCtx({ cwd: dir }),
      );
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toBe('duplicate_scope');
    });
  });

  describe('serial execution', () => {
    it('allows serial even when it would overflow parallel concurrency', () => {
      const verdict = evaluateSubtaskPolicy(
        REQUEST([researchPacket('Investigate runtime module'), researchPacket('Investigate session module'), researchPacket('Investigate tui module')], 'serial'),
        makeCtx({ runningChildren: 2, config: { ...DEFAULT_SUBAGENT_CONFIG, maxParallel: 3 } }),
      );
      expect(verdict.allowed).toBe(true);
    });
  });

  // ==========================================================================
  // R9: auto-mode delegation eligibility gate
  // ==========================================================================
  describe('R9: auto delegation eligibility', () => {
    it('rejects a single research task with no multi-direction signal', () => {
      // Simple Q&A or single-file investigation should NOT trigger delegation.
      const verdict = evaluateSubtaskPolicy(
        REQUEST([researchPacket('Read the file to find the bug')]),
        makeCtx({ rootObjective: 'Check if there is a bug', config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'auto' } }),
      );
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toBe('not_eligible_for_delegation');
    });

    it('allows a single task with multi-direction root objective', () => {
      const verdict = evaluateSubtaskPolicy(
        REQUEST([researchPacket('Research the runtime and session modules')]),
        makeCtx({ rootObjective: 'Investigate both the runtime cancel paths and session-storage', config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'auto' } }),
      );
      expect(verdict.allowed).toBe(true);
    });

    it('allows a single review or test-investigate task', () => {
      const review = evaluateSubtaskPolicy(
        REQUEST([{ role: 'review', objective: 'Review the changeset for regressions', reason: 'independent' }]),
        makeCtx({ rootObjective: 'Check this diff', config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'auto' } }),
      );
      expect(review.allowed).toBe(true);

      const test = evaluateSubtaskPolicy(
        REQUEST([{ role: 'test-investigate', objective: 'Analyze the failing test in tui', reason: 'independent' }]),
        makeCtx({ rootObjective: 'Debug the test failure', config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'auto' } }),
      );
      expect(test.allowed).toBe(true);
    });

    it('rejects a single review with too-short objective', () => {
      const verdict = evaluateSubtaskPolicy(
        REQUEST([{ role: 'review', objective: 'Review', reason: 'independent' }]),
        makeCtx({ rootObjective: 'Check', config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'auto' } }),
      );
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toBe('not_eligible_for_delegation');
    });

    it('allows a single research with multiple scope paths', () => {
      const verdict = evaluateSubtaskPolicy(
        REQUEST([researchPacket('Investigate the runtime and session modules', ['src/runtime', 'src/services'])]),
        makeCtx({ rootObjective: 'Check modules', config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'auto' } }),
      );
      expect(verdict.allowed).toBe(true);
    });

    it('allows a single research with multiple context hints', () => {
      const verdict = evaluateSubtaskPolicy(
        REQUEST([{ ...researchPacket('Investigate'), contextHints: ['runtime cancel paths', 'session-storage resumption'], scope: undefined }]),
        makeCtx({ rootObjective: 'Check', config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'auto' } }),
      );
      expect(verdict.allowed).toBe(true);
    });

    it('always allows 2+ tasks in auto mode (no single-task gate)', () => {
      const verdict = evaluateSubtaskPolicy(
        REQUEST([researchPacket('Investigate runtime'), researchPacket('Investigate session')]),
        makeCtx({ rootObjective: 'Simple check', config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'auto' } }),
      );
      expect(verdict.allowed).toBe(true);
    });

    it('explicit mode bypasses the eligibility gate (user intended delegation)', () => {
      // Even a simple single-task request passes explicit mode (intent is explicit).
      // Use a root objective that clearly signals delegation intent via the
      // hasExplicitDelegationIntent patterns.
      const verdict = evaluateSubtaskPolicy(
        REQUEST([researchPacket('Look at this file')]),
        makeCtx({ rootObjective: 'Use subagent to investigate this simple thing', config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'explicit' } }),
      );
      expect(verdict.allowed).toBe(true);
    });
  });
});
