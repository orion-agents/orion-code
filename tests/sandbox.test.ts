/**
 * v0.1.3-2 §1.2 / P1-B — OS-level sandbox planning for shell execution.
 *
 * The plan requires this feature to ship as a *security POC with proof*, not as
 * an assumed capability. These tests therefore assert three separate things:
 *
 *  1. planning is deterministic and argv-based (no shell string interpolation);
 *  2. an unusable or unknown sandbox configuration FAILS CLOSED — a configured
 *     sandbox must never silently degrade into an unsandboxed run;
 *  3. the default (`profile: 'none'`) reproduces the exact legacy invocation.
 *
 * Actual kernel enforcement (a write outside the workspace really being
 * refused) is machine dependent, so those assertions run only when a backend
 * probe succeeds and are otherwise reported as `not_run` — see the
 * "OS enforcement" block at the bottom.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, platform } from 'os';

import {
  buildSeatbeltPolicy,
  describeSandboxPlan,
  detectSandboxCapabilities,
  formatSandboxCapabilities,
  mergeSandboxConfig,
  planSandboxedCommand,
  resetSandboxCapabilityCache,
  resolveSandboxSettings,
  SANDBOX_BACKENDS,
  type SandboxCapabilities,
} from '../src/tools/sandbox';
import { saveProjectConfig, updateGlobalConfig } from '../src/services/global-config';

// ============================================================================
// Fixtures
// ============================================================================

/** Pretend every backend is missing. */
const noBackends: SandboxCapabilities = {
  platform: 'linux',
  backends: SANDBOX_BACKENDS.map(backend => ({
    backend,
    available: false,
    reason: 'probe failed in test',
  })),
};

function only(backend: (typeof SANDBOX_BACKENDS)[number]): SandboxCapabilities {
  return {
    platform: backend === 'seatbelt' ? 'darwin' : 'linux',
    backends: SANDBOX_BACKENDS.map(b => ({
      backend: b,
      available: b === backend,
      reason: b === backend ? undefined : 'not available in test',
    })),
    preferred: backend,
  };
}

const CWD = '/tmp';

// ============================================================================
// Default behaviour / backward compatibility
// ============================================================================

describe('sandbox profile none (default)', () => {
  test('produces the exact legacy `sh -c <command>` invocation', () => {
    const plan = planSandboxedCommand('echo hi', { cwd: CWD, capabilities: noBackends });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.backend).toBe('none');
    expect(plan.file).toBe('sh');
    expect(plan.args).toEqual(['-c', 'echo hi']);
  });

  test('an absent sandbox config behaves like profile none', () => {
    const plan = planSandboxedCommand('echo hi', {
      cwd: CWD,
      settings: {},
      capabilities: noBackends,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.backend).toBe('none');
  });

  test('profile none never consults the backend probe', () => {
    // No capabilities injected and no backend on this machine is required:
    // planning must not fail just because nothing is installed.
    const plan = planSandboxedCommand('echo hi', { cwd: CWD, settings: { profile: 'none' } });
    expect(plan.ok).toBe(true);
  });
});

// ============================================================================
// Fail-closed contract
// ============================================================================

describe('fail-closed behaviour', () => {
  test('a requested profile with no available backend is refused', () => {
    const plan = planSandboxedCommand('echo hi', {
      cwd: CWD,
      settings: { profile: 'read-only' },
      capabilities: noBackends,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/no sandbox backend is available/);
    // The reason must name each backend so the user can fix it.
    for (const backend of SANDBOX_BACKENDS) expect(plan.reason).toContain(backend);
  });

  test('an explicitly forced but unavailable backend is refused with its own reason', () => {
    const plan = planSandboxedCommand('echo hi', {
      cwd: CWD,
      settings: { profile: 'workspace-write', backend: 'seatbelt' },
      capabilities: only('docker'),
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/not available in test/);
  });

  test('an unknown profile fails closed instead of downgrading to none', () => {
    const plan = planSandboxedCommand('echo hi', {
      cwd: CWD,
      // Simulates a config written by a newer Orion.
      settings: { profile: 'strict' as never },
      capabilities: only('seatbelt'),
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/unknown sandbox profile "strict"/);
  });

  test('an unknown backend name is refused', () => {
    const plan = planSandboxedCommand('echo hi', {
      cwd: CWD,
      settings: { profile: 'read-only', backend: 'firejail' as never },
      capabilities: only('seatbelt'),
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/unknown sandbox backend "firejail"/);
  });

  test('the docker backend without an image is refused', () => {
    const plan = planSandboxedCommand('echo hi', {
      cwd: CWD,
      settings: { profile: 'read-only', backend: 'docker' },
      capabilities: only('docker'),
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/requires `sandbox\.image`/);
  });
});

// ============================================================================
// argv shape (quoting safety)
// ============================================================================

describe('argv construction', () => {
  const nasty = `echo 'a'"'"'b'; touch /tmp/pwned $(id) \`whoami\` "x"`;

  test.each(['seatbelt', 'bubblewrap'] as const)(
    '%s passes the command through as one untouched argv element',
    backend => {
      const plan = planSandboxedCommand(nasty, {
        cwd: CWD,
        settings: {
          profile: 'workspace-write',
          ...(backend === 'seatbelt' ? { allowNetwork: true } : {}),
        },
        capabilities: only(backend),
      });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      // Exactly one element equals the original command, byte for byte.
      expect(plan.args.filter(a => a === nasty)).toHaveLength(1);
      expect(plan.args[plan.args.length - 1]).toBe(nasty);
      expect(plan.args[plan.args.length - 2]).toBe('-c');
      // Nothing built a composite shell string containing the command.
      expect(plan.args.some(a => a !== nasty && a.includes('touch /tmp/pwned'))).toBe(false);
    }
  );

  test('docker passes the command through as one untouched argv element', () => {
    const plan = planSandboxedCommand(nasty, {
      cwd: CWD,
      settings: { profile: 'workspace-write', backend: 'docker', image: 'alpine:3' },
      capabilities: only('docker'),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.args[plan.args.length - 1]).toBe(nasty);
    expect(plan.args).toContain('alpine:3');
    expect(plan.args.join(' ')).toContain('--rm');
  });
});

// ============================================================================
// Policy semantics
// ============================================================================

describe('seatbelt policy', () => {
  test('refuses to claim network isolation for the deprecated seatbelt backend', () => {
    const plan = planSandboxedCommand('ls', {
      cwd: CWD,
      settings: { profile: 'read-only' },
      capabilities: only('seatbelt'),
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain('cannot verify network isolation');
  });

  test('auto-selection skips seatbelt when network isolation is required', () => {
    const plan = planSandboxedCommand('ls', {
      cwd: CWD,
      settings: { profile: 'workspace-write' },
      capabilities: only('seatbelt'),
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain('seatbelt');
    expect(plan.reason).toContain('network isolation');
  });

  test('network is only allowed when explicitly requested', () => {
    const plan = planSandboxedCommand('curl x', {
      cwd: CWD,
      settings: { profile: 'workspace-write', allowNetwork: true },
      capabilities: only('seatbelt'),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.network).toBe('allowed');
    expect(plan.policy).toContain('(allow network*)');
  });

  test('paths are escaped so they cannot terminate the policy string', () => {
    const policy = buildSeatbeltPolicy(['/tmp/we"ird\\path'], false);
    expect(policy).toContain('\\"');
    expect(policy).toContain('\\\\');
    // Balanced quotes: escaping must not leave an odd number of raw quotes.
    const rawQuotes = policy.split('').filter((c, i) => c === '"' && policy[i - 1] !== '\\').length;
    expect(rawQuotes % 2).toBe(0);
  });

  test('denies reads from credential directories and project secret files', () => {
    const policy = buildSeatbeltPolicy([], true, '/workspace');
    expect(policy).toContain('.ssh');
    expect(policy).toContain('.aws');
    expect(policy).toContain('Library/Keychains');
    expect(policy).toContain('/workspace/.env');
    expect(policy).toContain('/workspace/.npmrc');
  });

  test('pins project secret denies to projectRoot when command cwd differs', () => {
    const plan = planSandboxedCommand('pwd', {
      cwd: '/workspace/project/packages/app',
      projectRoot: '/workspace/project',
      settings: { profile: 'workspace-write', allowNetwork: true },
      capabilities: only('seatbelt'),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.policy).toContain('/workspace/project/.env');
    expect(plan.policy).toContain('/workspace/project/.npmrc');
    expect(plan.policy).not.toContain('/workspace/project/packages/app/.env');
  });

  test('symlinked writable roots are resolved to their real path', () => {
    const plan = planSandboxedCommand('ls', {
      cwd: '/tmp',
      settings: { profile: 'workspace-write', allowNetwork: true },
      capabilities: only('seatbelt'),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    if (platform() === 'darwin') {
      // /tmp is a symlink to /private/tmp; the policy must name the real path,
      // otherwise it can be bypassed through the alias.
      expect(plan.writableRoots.some(r => r.startsWith('/private/'))).toBe(true);
    }
    expect(plan.writableRoots.every(r => !r.endsWith('/'))).toBe(true);
  });
});

describe('bubblewrap plan', () => {
  test('read-only mounts the workspace read-only and unshares the network', () => {
    const plan = planSandboxedCommand('ls', {
      cwd: CWD,
      settings: { profile: 'read-only' },
      capabilities: only('bubblewrap'),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.file).toBe('bwrap');
    expect(plan.args).toContain('--unshare-net');
    expect(plan.args).toContain('--ro-bind');
    expect(plan.args).not.toContain('--bind');
  });

  test('workspace-write binds the workspace read-write', () => {
    const plan = planSandboxedCommand('ls', {
      cwd: CWD,
      settings: { profile: 'workspace-write', allowNetwork: true },
      capabilities: only('bubblewrap'),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.args).toContain('--bind');
    expect(plan.args).toContain('--die-with-parent');
  });
});

// ============================================================================
// Configuration merge and resolution
// ============================================================================

describe('configuration', () => {
  const originalDir = process.env.ORION_CODE_CONFIG_DIR;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orion-sandbox-cfg-'));
    process.env.ORION_CODE_CONFIG_DIR = dir;
  });

  afterEach(() => {
    if (originalDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = originalDir;
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  test('project settings override global ones key by key', () => {
    const merged = mergeSandboxConfig(
      { profile: 'read-only', allowNetwork: true, image: 'base:1' },
      { profile: 'workspace-write' }
    );
    expect(merged.profile).toBe('workspace-write');
    // Unspecified project keys still inherit.
    expect(merged.allowNetwork).toBe(true);
    expect(merged.image).toBe('base:1');
  });

  test('empty or non-string writable roots are dropped', () => {
    const merged = mergeSandboxConfig(
      { writableRoots: ['/a', '', 42 as never] },
      { writableRoots: [] }
    );
    expect(merged.writableRoots).toEqual(['/a']);
  });

  test('resolveSandboxSettings reads global then project scope', () => {
    updateGlobalConfig({ sandbox: { profile: 'read-only' } });
    const projectA = join(dir, 'proj-a');
    const projectB = join(dir, 'proj-b');
    saveProjectConfig(projectA, { sandbox: { profile: 'workspace-write' } });

    expect(resolveSandboxSettings(projectA).profile).toBe('workspace-write');
    // A project without an override inherits the global profile.
    expect(resolveSandboxSettings(projectB).profile).toBe('read-only');
  });

  test('no configuration at all resolves to an undefined (i.e. none) profile', () => {
    expect(resolveSandboxSettings(join(dir, 'untouched')).profile).toBeUndefined();
  });
});

// ============================================================================
// Capability reporting
// ============================================================================

describe('capability probing', () => {
  afterEach(() => resetSandboxCapabilityCache());

  test('reports one entry per backend with a reason when unavailable', () => {
    resetSandboxCapabilityCache();
    const caps = detectSandboxCapabilities(true);
    expect(caps.backends).toHaveLength(SANDBOX_BACKENDS.length);
    for (const status of caps.backends) {
      if (!status.available) expect(status.reason).toBeTruthy();
    }
    expect(caps.platform).toBe(process.platform);
  });

  test('the result is cached until explicitly reset', () => {
    resetSandboxCapabilityCache();
    const first = detectSandboxCapabilities();
    expect(detectSandboxCapabilities()).toBe(first);
    resetSandboxCapabilityCache();
    expect(detectSandboxCapabilities()).not.toBe(first);
  });

  test('formats a human-readable matrix', () => {
    const lines = formatSandboxCapabilities(noBackends);
    expect(lines).toHaveLength(SANDBOX_BACKENDS.length);
    expect(lines.every(l => l.includes('unavailable'))).toBe(true);
  });

  test('describeSandboxPlan summarises the active isolation', () => {
    const plan = planSandboxedCommand('ls', {
      cwd: CWD,
      settings: { profile: 'workspace-write', allowNetwork: true },
      capabilities: only('seatbelt'),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const text = describeSandboxPlan(plan);
    expect(text).toContain('workspace-write');
    expect(text).toContain('seatbelt');
    expect(text).toContain('network allowed');
  });
});

// ============================================================================
// OS enforcement (evidence-gated)
// ============================================================================

/**
 * These assertions require a working backend on the host. When none is
 * available — e.g. Orion itself runs inside an application sandbox, where every
 * nested `sandbox_apply` returns "Operation not permitted" — the enforcement
 * evidence is `not_run` rather than `met`, and we assert the fail-closed path
 * instead. Per the plan, a skipped test must never be reported as a pass.
 */
describe('OS enforcement', () => {
  const caps = detectSandboxCapabilities(true);
  // The image the POC is allowed to use when Docker is the only live backend.
  const POC_IMAGE = 'alpine:latest';
  // Build the settings that actually yield a runnable plan on this host:
  // auto-select picks the first usable backend, and Docker additionally needs
  // an image before a plan can succeed.
  const effectiveSettings: Record<string, unknown> = { profile: 'workspace-write' };
  if (caps.preferred === 'docker') effectiveSettings.image = POC_IMAGE;
  // Gate on a real plan rather than on `caps.preferred`: a backend can be
  // installed and still unusable without extra configuration (Docker needs an
  // image), and only a successful plan proves we can actually execute.
  const live = planSandboxedCommand('true', {
    cwd: tmpdir(),
    settings: effectiveSettings as never,
    capabilities: caps,
  }).ok;
  const maybe = live ? test : test.skip;

  test('capability matrix is recorded for the evidence ledger', () => {
    // Always runs: makes the host's real matrix visible in test output.
    const lines = formatSandboxCapabilities(caps);
    expect(lines.length).toBe(SANDBOX_BACKENDS.length);
    if (!live) {
      // eslint-disable-next-line no-console
      console.warn(
        `[sandbox] no backend available on ${caps.platform}; OS enforcement assertions are not_run:\n  ${lines.join('\n  ')}`
      );
    }
  });

  maybe('a workspace-write sandbox refuses a write outside the workspace', async () => {
    const { spawnSync } = await import('child_process');
    const ws = mkdtempSync(join(tmpdir(), 'orion-sandbox-ws-'));
    // A path under a read-only mounted root (/usr on bwrap/docker, denied by the
    // seatbelt policy otherwise) — refused by every backend, not just Docker.
    const outside = `/usr/local/orion-sandbox-outside-${Date.now()}.txt`;
    try {
      const plan = planSandboxedCommand(`echo blocked > ${outside}`, {
        cwd: ws,
        settings: effectiveSettings as never,
      });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      const res = spawnSync(plan.file, plan.args, { encoding: 'utf8' });
      expect(res.status).not.toBe(0);
      expect(existsSync(outside)).toBe(false);
    } finally {
      // Cleanup is best-effort: this process runs under Orion's safe-delete
      // guard, which refuses `rm` on arbitrary temp paths. The assertions above
      // do not depend on cleanup succeeding.
      try {
        rmSync(ws, { recursive: true, force: true });
        rmSync(outside, { force: true });
      } catch {
        /* ignore safe-delete guard errors */
      }
    }
  });

  maybe('a workspace-write sandbox allows a write inside the workspace', async () => {
    const { spawnSync } = await import('child_process');
    const ws = mkdtempSync(join(tmpdir(), 'orion-sandbox-ws-'));
    try {
      const plan = planSandboxedCommand(`echo ok > ${join(ws, 'inside.txt')}`, {
        cwd: ws,
        settings: effectiveSettings as never,
      });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      const res = spawnSync(plan.file, plan.args, { encoding: 'utf8' });
      expect(res.status).toBe(0);
      expect(existsSync(join(ws, 'inside.txt'))).toBe(true);
    } finally {
      try {
        rmSync(ws, { recursive: true, force: true });
      } catch {
        /* ignore safe-delete guard errors */
      }
    }
  });

  maybe('a read-only sandbox refuses a write inside the workspace too', async () => {
    const { spawnSync } = await import('child_process');
    const ws = mkdtempSync(join(tmpdir(), 'orion-sandbox-ro-'));
    try {
      writeFileSync(join(ws, 'seed.txt'), 'seed');
      const plan = planSandboxedCommand(`echo nope > ${join(ws, 'blocked.txt')}`, {
        cwd: ws,
        settings: { ...effectiveSettings, profile: 'read-only' } as never,
      });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      const res = spawnSync(plan.file, plan.args, { encoding: 'utf8' });
      expect(res.status).not.toBe(0);
      expect(existsSync(join(ws, 'blocked.txt'))).toBe(false);
    } finally {
      try {
        rmSync(ws, { recursive: true, force: true });
      } catch {
        /* ignore safe-delete guard errors */
      }
    }
  });
});
