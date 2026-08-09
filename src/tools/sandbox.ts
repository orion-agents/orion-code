/**
 * Orion Code - OS-level sandbox planning for shell command execution.
 *
 * Contract (v0.1.3-2 §1.2 / P1-B / P1-E)
 * ======================================
 *
 * Why this module exists
 * ----------------------
 * `bash_security.wrapForSandbox()` built a *shell string* (`docker exec ... sh -c
 * '<cmd>'`). That is unsafe to claim as isolation: every layer re-parses the
 * command, so quoting bugs become escapes. This module instead produces an
 * **argv array** that is handed straight to `spawn()`, so the user command is a
 * single opaque argument that no intermediate shell re-parses.
 *
 * Profiles (what the user asks for) vs backends (how we deliver it)
 * ----------------------------------------------------------------
 *   profile  none            -> run exactly as before (no wrapper at all)
 *   profile  read-only       -> no filesystem writes anywhere, no network
 *   profile  workspace-write -> writes confined to the workspace roots + temp,
 *                               no network unless explicitly allowed
 *
 *   backend  seatbelt   -> macOS `sandbox-exec` with a generated SBPL policy
 *   backend  bubblewrap -> Linux `bwrap` with read-only binds
 *   backend  docker     -> `docker run --rm` into a configured image
 *
 * Availability must be PROBED, never inferred
 * -------------------------------------------
 * `which sandbox-exec` succeeding proves nothing: when Orion itself runs inside
 * an application sandbox, every nested `sandbox_apply` fails with
 * `Operation not permitted` (exit 71) even for a trivial `(allow default)`
 * policy. Likewise `docker` on PATH says nothing about the daemon. So each
 * backend is validated with a real, cheap execution probe whose result is
 * cached for the process lifetime.
 *
 * Fail closed
 * -----------
 * If a profile other than `none` is requested and no backend passes its probe,
 * {@link planSandboxedCommand} returns a failure. Callers must refuse to run the
 * command. Falling back to an unsandboxed execution would turn a security
 * setting into a silent no-op, which is the exact failure mode this module
 * exists to prevent. An unrecognised profile value (e.g. written by a newer
 * Orion) is also a failure rather than a downgrade to `none`.
 *
 * Configuration ownership (P1-E)
 * ------------------------------
 *   GlobalConfig.sandbox            user-wide default
 *   ProjectConfig.sandbox           per-project override, shallow-merged on top
 *
 * Default is `{ profile: 'none' }`, so configs written before this module
 * existed keep their exact previous behaviour. Nothing here is secret, so no
 * redaction is required; rolling back is "delete the `sandbox` key", and an
 * older Orion simply ignores the unknown field.
 *
 * Known limitations (recorded, not hidden)
 * ----------------------------------------
 * - seatbelt cannot be applied from inside another sandbox (see above);
 * - macOS seatbelt is filesystem-only here. Its deprecated network filters are
 *   not treated as enforcement, so a network-blocked plan must use another backend;
 * - `docker` runs the command in a *different* process tree, so Orion's
 *   process-group SIGTERM/SIGKILL only reaches the client. `--rm` bounds the
 *   leak, but abort semantics are weaker than the in-process backends;
 * - none of the backends attempt to constrain CPU/memory.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadGlobalConfig, getProjectConfig } from '../services/global-config';
import type { SandboxBackend, SandboxConfig, SandboxProfile } from '../services/global-config';

// ============================================================================
// Types
// ============================================================================

// The persisted shape lives with the rest of the config schema; re-exported here
// so callers can import the whole sandbox vocabulary from one place.
export type { SandboxBackend, SandboxConfig, SandboxProfile };

export const SANDBOX_PROFILES: readonly SandboxProfile[] = ['none', 'read-only', 'workspace-write'];

export const SANDBOX_BACKENDS: readonly SandboxBackend[] = ['seatbelt', 'bubblewrap', 'docker'];

export interface SandboxBackendStatus {
  backend: SandboxBackend;
  available: boolean;
  /** Human-readable explanation, always present when `available` is false. */
  reason?: string;
  /** Resolved binary path or version detail, when known. */
  detail?: string;
}

export interface SandboxCapabilities {
  platform: NodeJS.Platform;
  backends: SandboxBackendStatus[];
  /** First available backend, if any. */
  preferred?: SandboxBackend;
}

export interface SandboxCommandPlan {
  ok: true;
  profile: SandboxProfile;
  /** `'none'` means "no wrapper", i.e. the legacy `sh -c` invocation. */
  backend: SandboxBackend | 'none';
  /** argv[0] for `spawn()`. */
  file: string;
  /** argv[1..] for `spawn()`. The user command is always a single element. */
  args: string[];
  network: 'allowed' | 'blocked';
  writableRoots: string[];
  /** Generated policy text, for audit/debug output. */
  policy?: string;
}

export interface SandboxPlanFailure {
  ok: false;
  profile: string;
  reason: string;
  capabilities: SandboxCapabilities;
}

export type SandboxPlanResult = SandboxCommandPlan | SandboxPlanFailure;

export interface SandboxPlanOptions {
  /** Directory the command runs in; always the primary writable root. */
  cwd: string;
  settings?: SandboxConfig;
  /** Injectable for tests; defaults to the real probe. */
  capabilities?: SandboxCapabilities;
}

// ============================================================================
// Settings resolution
// ============================================================================

/** Shell used inside every backend. Kept explicit so policies can reference it. */
const INNER_SHELL = '/bin/sh';

function isSandboxProfile(value: unknown): value is SandboxProfile {
  return typeof value === 'string' && (SANDBOX_PROFILES as readonly string[]).includes(value);
}

function sanitizeRoots(roots: unknown): string[] | undefined {
  if (!Array.isArray(roots)) return undefined;
  const out = roots.filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
  return out.length > 0 ? out : undefined;
}

/**
 * Merge global and project sandbox settings.
 * Project keys win individually; absent keys inherit the global value.
 */
export function mergeSandboxConfig(
  global: SandboxConfig | undefined,
  project: SandboxConfig | undefined
): SandboxConfig {
  return {
    profile: project?.profile ?? global?.profile,
    backend: project?.backend ?? global?.backend,
    allowNetwork: project?.allowNetwork ?? global?.allowNetwork,
    writableRoots: sanitizeRoots(project?.writableRoots) ?? sanitizeRoots(global?.writableRoots),
    image: project?.image ?? global?.image,
  };
}

/** Read the effective settings for a project path. Never throws. */
export function resolveSandboxSettings(projectPath: string): SandboxConfig {
  let global: SandboxConfig | undefined;
  let project: SandboxConfig | undefined;
  try {
    global = loadGlobalConfig().sandbox;
  } catch {
    global = undefined;
  }
  try {
    project = getProjectConfig(projectPath).sandbox;
  } catch {
    project = undefined;
  }
  return mergeSandboxConfig(global, project);
}

// ============================================================================
// Capability probing
// ============================================================================

let capabilityCache: SandboxCapabilities | undefined;

/** Drop the cached probe result. Test-only; capabilities do not change at runtime. */
export function resetSandboxCapabilityCache(): void {
  capabilityCache = undefined;
}

function probe(file: string, args: string[], timeoutMs = 5000): { ok: boolean; detail?: string } {
  try {
    const res = spawnSync(file, args, { timeout: timeoutMs, encoding: 'utf8' });
    if (res.error) return { ok: false, detail: res.error.message };
    if (res.status !== 0) {
      const stderr = (res.stderr || '').trim().split('\n')[0];
      return { ok: false, detail: stderr || `exit ${res.status}` };
    }
    return { ok: true, detail: (res.stdout || '').trim().split('\n')[0] || undefined };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function probeSeatbelt(platform: NodeJS.Platform): SandboxBackendStatus {
  if (platform !== 'darwin') {
    return { backend: 'seatbelt', available: false, reason: 'seatbelt requires macOS' };
  }
  // A trivial policy is enough: if `sandbox_apply` is refused (e.g. Orion is
  // itself running inside an app sandbox) it fails here too.
  const res = probe('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']);
  if (!res.ok) {
    return {
      backend: 'seatbelt',
      available: false,
      reason: `sandbox-exec probe failed: ${res.detail ?? 'unknown error'}`,
    };
  }
  return {
    backend: 'seatbelt',
    available: true,
    detail: '/usr/bin/sandbox-exec (filesystem-only; network isolation unsupported)',
  };
}

function probeBubblewrap(platform: NodeJS.Platform): SandboxBackendStatus {
  if (platform !== 'linux') {
    return { backend: 'bubblewrap', available: false, reason: 'bubblewrap requires Linux' };
  }
  const res = probe('bwrap', ['--version']);
  if (!res.ok) {
    return {
      backend: 'bubblewrap',
      available: false,
      reason: `bwrap unavailable: ${res.detail ?? 'not found'}`,
    };
  }
  return { backend: 'bubblewrap', available: true, detail: res.detail };
}

function probeDocker(): SandboxBackendStatus {
  // `docker` on PATH says nothing about the daemon, so query the daemon.
  const res = probe('docker', ['info', '--format', '{{.ServerVersion}}'], 8000);
  if (!res.ok) {
    return {
      backend: 'docker',
      available: false,
      reason: `docker daemon unreachable: ${res.detail ?? 'not found'}`,
    };
  }
  return { backend: 'docker', available: true, detail: `server ${res.detail ?? 'unknown'}` };
}

/** Probe every backend once and cache the matrix for this process. */
export function detectSandboxCapabilities(force = false): SandboxCapabilities {
  if (capabilityCache && !force) return capabilityCache;
  const platform = process.platform;
  const backends = [probeSeatbelt(platform), probeBubblewrap(platform), probeDocker()];
  capabilityCache = {
    platform,
    backends,
    preferred: backends.find(b => b.available)?.backend,
  };
  return capabilityCache;
}

/** Render the capability matrix for `/config` and diagnostics. */
export function formatSandboxCapabilities(caps: SandboxCapabilities): string[] {
  return caps.backends.map(b =>
    b.available
      ? `${b.backend}: available${b.detail ? ` (${b.detail})` : ''}`
      : `${b.backend}: unavailable${b.reason ? ` (${b.reason})` : ''}`
  );
}

// ============================================================================
// Policy generation
// ============================================================================

/** Resolve symlinks so a policy cannot be sidestepped via an aliased path. */
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    const resolved = realpathOrSelf(p);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

/** Escape a path for an SBPL string literal. */
function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build the seatbelt policy.
 *
 * Uses `(allow default)` plus targeted denies rather than `(deny default)` plus
 * an allow-list: a deny-by-default policy has to enumerate every syscall a
 * developer toolchain needs, and each omission looks like a mysterious crash
 * rather than a security decision.
 */
export function buildSeatbeltPolicy(
  writableRoots: string[],
  allowNetwork: boolean,
  projectRoot: string = process.cwd()
): string {
  const lines = ['(version 1)', '(allow default)', '(deny file-write*)'];
  for (const root of writableRoots) {
    lines.push(`(allow file-write* (subpath ${sbplString(root)}))`);
  }
  // Writing to the standard character devices is not a filesystem escape and is
  // required for ordinary shell redirection to keep working.
  lines.push(
    '(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (literal "/dev/dtracehelper"))'
  );
  const home = os.homedir();
  for (const sensitive of [
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    path.join(home, '.azure'),
    path.join(home, '.config', 'gcloud'),
    path.join(home, 'Library', 'Keychains'),
  ]) {
    lines.push(`(deny file-read* (subpath ${sbplString(sensitive)}))`);
  }
  for (const sensitive of ['.env', '.env.local', '.env.production', '.npmrc', '.netrc']) {
    lines.push(`(deny file-read* (literal ${sbplString(path.join(projectRoot, sensitive))}))`);
  }
  lines.push(allowNetwork ? '(allow network*)' : '(deny network*)');
  return lines.join('\n');
}

// ============================================================================
// Planning
// ============================================================================

/**
 * Extra requirements a backend has beyond "the probe passed".
 * Returns the blocking reason, or undefined when the backend is usable as-is.
 */
function missingRequirement(backend: SandboxBackend, settings: SandboxConfig): string | undefined {
  if (backend === 'docker' && !settings.image?.trim()) {
    return 'the docker sandbox backend requires `sandbox.image` to be configured';
  }
  if (backend === 'seatbelt' && settings.allowNetwork !== true) {
    return 'macOS seatbelt cannot verify network isolation; choose docker or explicitly set sandbox.allowNetwork=true';
  }
  return undefined;
}

function selectBackend(
  settings: SandboxConfig,
  caps: SandboxCapabilities
): { backend?: SandboxBackend; reason?: string } {
  const requested = settings.backend;

  if (requested && requested !== 'auto') {
    const status = caps.backends.find(b => b.backend === requested);
    if (!status) {
      return { reason: `unknown sandbox backend "${requested}"` };
    }
    if (!status.available) {
      return { reason: status.reason ?? `sandbox backend "${requested}" is unavailable` };
    }
    // An explicit choice reports its own configuration gap verbatim.
    const missing = missingRequirement(requested, settings);
    return missing ? { reason: missing } : { backend: requested };
  }

  // Auto-selection must skip backends that are installed but not yet usable,
  // otherwise a host with an idle Docker daemon would report "image missing"
  // and hide the real reason the preferred backend was unavailable.
  for (const status of caps.backends) {
    if (!status.available) continue;
    if (!missingRequirement(status.backend, settings)) return { backend: status.backend };
  }

  const detail = caps.backends
    .map(b => {
      if (!b.available) return `${b.backend} (${b.reason ?? 'unavailable'})`;
      return `${b.backend} (${missingRequirement(b.backend, settings)})`;
    })
    .join('; ');
  return { reason: `no sandbox backend is available on ${caps.platform}: ${detail}` };
}

function plainPlan(command: string): SandboxCommandPlan {
  return {
    ok: true,
    profile: 'none',
    backend: 'none',
    file: 'sh',
    args: ['-c', command],
    network: 'allowed',
    writableRoots: [],
  };
}

/**
 * Turn a shell command into a spawnable argv under the configured profile.
 *
 * The returned `args` always end with the untouched user command as one
 * element, so no intermediate shell re-parses it.
 */
export function planSandboxedCommand(
  command: string,
  options: SandboxPlanOptions
): SandboxPlanResult {
  const settings = options.settings ?? {};
  const rawProfile = settings.profile ?? 'none';

  if (!isSandboxProfile(rawProfile)) {
    // Do not silently downgrade: an unknown value most likely comes from a
    // newer Orion that meant something stricter than `none`.
    return {
      ok: false,
      profile: String(rawProfile),
      reason: `unknown sandbox profile "${String(rawProfile)}"; expected one of ${SANDBOX_PROFILES.join(', ')}`,
      capabilities: options.capabilities ?? detectSandboxCapabilities(),
    };
  }

  if (rawProfile === 'none') return plainPlan(command);

  const caps = options.capabilities ?? detectSandboxCapabilities();
  const selected = selectBackend(settings, caps);
  if (!selected.backend) {
    return {
      ok: false,
      profile: rawProfile,
      reason: selected.reason ?? 'no sandbox backend available',
      capabilities: caps,
    };
  }

  const allowNetwork = settings.allowNetwork === true;
  const writableRoots =
    rawProfile === 'workspace-write'
      ? uniquePaths([options.cwd, os.tmpdir(), ...(settings.writableRoots ?? [])])
      : [];

  if (selected.backend === 'seatbelt') {
    const policy = buildSeatbeltPolicy(writableRoots, allowNetwork, options.cwd);
    return {
      ok: true,
      profile: rawProfile,
      backend: 'seatbelt',
      file: '/usr/bin/sandbox-exec',
      args: ['-p', policy, INNER_SHELL, '-c', command],
      network: allowNetwork ? 'allowed' : 'blocked',
      writableRoots,
      policy,
    };
  }

  if (selected.backend === 'bubblewrap') {
    const args: string[] = ['--die-with-parent', '--proc', '/proc', '--dev', '/dev'];
    if (!allowNetwork) args.push('--unshare-net');
    for (const ro of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt']) {
      if (fs.existsSync(ro)) args.push('--ro-bind', ro, ro);
    }
    // Read-only view of the workspace, upgraded to read-write only when the
    // profile asks for it.
    const workspace = realpathOrSelf(options.cwd);
    args.push(writableRoots.length > 0 ? '--bind' : '--ro-bind', workspace, workspace);
    for (const root of writableRoots) {
      if (root === workspace) continue;
      args.push('--bind', root, root);
    }
    args.push('--chdir', workspace, INNER_SHELL, '-c', command);
    return {
      ok: true,
      profile: rawProfile,
      backend: 'bubblewrap',
      file: 'bwrap',
      args,
      network: allowNetwork ? 'allowed' : 'blocked',
      writableRoots,
    };
  }

  // docker
  const image = settings.image?.trim();
  if (!image) {
    return {
      ok: false,
      profile: rawProfile,
      reason: 'the docker sandbox backend requires `sandbox.image` to be configured',
      capabilities: caps,
    };
  }
  // Docker runs in a separate VM (Docker Desktop on macOS). The host path we
  // pass to `-v` must be in the form Docker Desktop actually shares; resolving
  // symlinks (e.g. macOS `/var` -> `/private/var`) points at a path Docker
  // Desktop does not map, so the bind mount silently creates an empty
  // directory and writes land somewhere the caller cannot see. We therefore
  // mount `options.cwd` exactly as supplied. Per-directory write confinement
  // for docker comes from `--read-only` (immutable image rootfs) plus the
  // explicit rw bind mounts below — not from path-text matching.
  const workspace = options.cwd;
  const args = ['run', '--rm', '-i', '--read-only'];
  if (!allowNetwork) args.push('--network', 'none');
  if (writableRoots.length > 0) {
    args.push('-v', `${workspace}:${workspace}:rw`);
    const seen = new Set<string>([workspace]);
    // Raw (non-realpathed) extra roots so Docker Desktop can resolve them.
    for (const raw of [os.tmpdir(), ...(settings.writableRoots ?? [])]) {
      if (!raw || seen.has(raw)) continue;
      seen.add(raw);
      args.push('-v', `${raw}:${raw}:rw`);
    }
  } else {
    args.push('-v', `${workspace}:${workspace}:ro`);
  }
  args.push('-w', workspace, image, INNER_SHELL, '-c', command);
  return {
    ok: true,
    profile: rawProfile,
    backend: 'docker',
    file: 'docker',
    args,
    network: allowNetwork ? 'allowed' : 'blocked',
    writableRoots,
  };
}

/** One-line audit description of an active plan. */
export function describeSandboxPlan(plan: SandboxCommandPlan): string {
  if (plan.backend === 'none') return 'sandbox: none';
  const roots = plan.writableRoots.length > 0 ? plan.writableRoots.join(', ') : '(none)';
  return `sandbox: ${plan.profile} via ${plan.backend}, network ${plan.network}, writable ${roots}`;
}
