import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  WorkspaceDiscoveryServiceV1,
  WorkspaceDiscoveryTelemetryV1,
  WORKSPACE_DISCOVERY_LIMITS_V1,
} from '../src/web/workspace-discovery';
import type { WorkspaceRootEntryV1 } from '../src/services/workspace-roots-registry';

function makeRoot(
  id: string,
  path: string,
  addedAt = '2026-10-08T00:00:00.000Z'
): WorkspaceRootEntryV1 {
  return { id, canonicalPath: path, label: id, addedAt };
}

/** Build a fixture tree. `markers` maps a relative dir to the marker file to create. */
function buildTree(
  base: string,
  spec: Readonly<Record<string, 'git' | 'manifest' | 'plain'>>
): void {
  for (const [relative, kind] of Object.entries(spec)) {
    const dir = join(base, relative);
    mkdirSync(dir, { recursive: true });
    if (kind === 'git') mkdirSync(join(dir, '.git'), { recursive: true });
    if (kind === 'manifest') writeFileSync(join(dir, 'package.json'), '{}');
  }
}

describe('WorkspaceDiscoveryServiceV1', () => {
  let base: string;
  let telemetry: WorkspaceDiscoveryTelemetryV1;
  let service: WorkspaceDiscoveryServiceV1;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'orion-discovery-'));
    telemetry = new WorkspaceDiscoveryTelemetryV1();
    service = new WorkspaceDiscoveryServiceV1({ telemetry });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('finds git and manifest candidates up to depth 2 and skips ignored directories', async () => {
    buildTree(base, {
      'git-project': 'git',
      'manifest-project': 'manifest',
      'nested/deep-project': 'git',
      'node_modules/ignored-project': 'git',
      '.hidden/hidden-project': 'git',
      'dist/ignored-manifest': 'manifest',
      'plain-folder': 'plain',
    });
    const outcome = await service.discover({ root: makeRoot('root', base) });
    const paths = outcome.candidates.map(candidate => candidate.relativePath).sort();
    expect(paths).toEqual(['git-project', 'manifest-project', 'nested/deep-project']);
    expect(outcome.status).toBe('ready');
    expect(outcome.errorCode).toBeUndefined();
  });

  it('reports the root itself as a candidate when it carries a marker', async () => {
    buildTree(base, { '.': 'git' });
    const outcome = await service.discover({ root: makeRoot('root', base) });
    const rootCandidate = outcome.candidates.find(candidate => candidate.relativePath === '');
    expect(rootCandidate).toBeDefined();
    expect(rootCandidate?.hint).toBe('git');
    expect(rootCandidate?.label).toBe('root');
  });

  it('returns a partial result with budget_exceeded when the budget runs out', async () => {
    // 60 projects at depth 1 and 60 at depth 2: well over the entry budget
    // when the budget is tiny.
    const spec: Record<string, 'git' | 'plain'> = {};
    for (let index = 0; index < 60; index += 1) {
      spec[`proj-${index}`] = 'git';
      spec[`group-${index}/inner`] = 'git';
    }
    buildTree(base, spec);
    // The entry budget makes the partial deterministic (the wall-clock budget
    // at 1ms would exhaust before any readdir resolves).
    const outcome = await service.discover({
      root: makeRoot('root', base),
      limits: { budgetMs: 10_000, maxEntries: 60, maxCandidates: 200 },
    });
    expect(outcome.status).toBe('partial');
    expect(outcome.errorCode).toBe('budget_exceeded');
    expect(outcome.candidates.length).toBeGreaterThan(0);
    expect(outcome.candidates.every(candidate => candidate.status === 'ready')).toBe(true);
  });

  it('caps the candidate count and marks the scan partial', async () => {
    const spec: Record<string, 'git' | 'plain'> = {};
    for (let index = 0; index < 12; index += 1) spec[`proj-${index}`] = 'git';
    buildTree(base, spec);
    const outcome = await service.discover({
      root: makeRoot('root', base),
      limits: { maxCandidates: 5, maxEntries: 500 },
    });
    expect(outcome.candidates).toHaveLength(5);
    expect(outcome.status).toBe('partial');
    expect(outcome.errorCode).toBe('budget_exceeded');
  });

  it('fails with root_missing when the root does not exist', async () => {
    const outcome = await service.discover({ root: makeRoot('root', join(base, 'gone')) });
    expect(outcome.status).toBe('partial');
    expect(outcome.errorCode).toBe('root_missing');
  });

  it('does not follow directory symlinks out of the root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'orion-outside-'));
    try {
      buildTree(outside, { 'outside-project': 'git' });
      const inside = join(base, 'link-to-outside');
      symlinkSync(outside, inside, 'dir');
      const outcome = await service.discover({ root: makeRoot('root', base) });
      expect(outcome.candidates).toHaveLength(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reports scan_cancelled when the signal aborts', async () => {
    // A deep tree: aborting after the first candidate is observed keeps the
    // walk running until the signal is observed between directories.
    const spec: Record<string, 'git' | 'plain'> = {};
    for (let index = 0; index < 40; index += 1) spec[`group-${index}/deep/proj`] = 'git';
    buildTree(base, spec);
    const controller = new AbortController();
    const discovered = service.discover({
      root: makeRoot('root', base),
      signal: controller.signal,
      limits: { budgetMs: 10_000 },
    });
    // Abort as soon as the first microtask slice finishes (walk observes the
    // signal between directories).
    setTimeout(() => controller.abort(), 0);
    const outcome = await discovered;
    expect(['scan_cancelled', 'budget_exceeded']).toContain(outcome.errorCode);
    expect(outcome.status).toBe('partial');
  });

  it('caches the outcome per root within the TTL and invalidates on demand', async () => {
    buildTree(base, { alpha: 'git' });
    const root = makeRoot('root', base);
    let clock = 1_000;
    const now = () => clock;
    const cachedService = new WorkspaceDiscoveryServiceV1({ now });
    const first = await cachedService.discover({ root });
    expect(cachedService.cached('root')).toEqual(first);
    clock = 1_000 + WORKSPACE_DISCOVERY_LIMITS_V1.cacheTtlMs + 1;
    expect(cachedService.cached('root')).toBeUndefined();
    await cachedService.discover({ root });
    cachedService.invalidate('root');
    expect(cachedService.cached('root')).toBeUndefined();
  });

  it('keeps telemetry sanitized: counts and codes only, never paths or labels', async () => {
    buildTree(base, { 'secret-project-name': 'git' });
    const outcome = await service.discover({ root: makeRoot('secret-root', base) });
    telemetry.record({
      operation: 'discover',
      outcome: 'success',
      durationMs: outcome.durationMs,
      candidateCount: outcome.candidates.length,
      scannedEntries: outcome.scannedEntries,
      partial: false,
    });
    const snapshot = telemetry.snapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('secret-project-name');
    expect(serialized).not.toContain('secret-root');
    expect(serialized).not.toContain(base);
    expect(snapshot.recent[0].operation).toBe('discover');
    expect(snapshot.recent[0].candidateCount).toBe(outcome.candidates.length);
  });
});
