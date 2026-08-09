import type { SubtaskResult } from '../src/runtime/subagents/types';
import { EMPTY_SUBTASK_USAGE } from '../src/runtime/subagents/types';
import type { ResearchPacket } from '../src/runtime/subagents/research-types';
import {
  RESEARCH_HARD_LIMITS,
  createLocalResearchRequest,
  hashPacket,
  stableStringify,
  subtaskResultToPacket,
  validatePacket,
  validateResearchRequest,
} from '../src/runtime/subagents/research-contract';

/** Deterministic completed research result with 2 file findings + 1 inference. */
function completedResult(): SubtaskResult {
  return {
    id: 'task-1',
    role: 'research',
    status: 'completed',
    summary: 'Provider fallback switches the request model once on a 429.',
    findings: [
      {
        severity: 'high',
        title: 'llm.resilience is wired in cli.ts',
        evidence: 'src/cli.ts:234 assigns new ProviderResilienceCoordinator()',
        file: 'src/cli.ts',
        line: 234,
      },
      {
        severity: 'medium',
        title: 'coordinator switches model exactly once',
        evidence: 'ProviderResilienceCoordinator retries with fallbackModel',
        file: 'src/services/provider-resilience/coordinator.ts',
        line: 20,
      },
      {
        title: 'fallback covers rate-limit and timeout paths',
        evidence: 'error-classifier maps 429 and ETIMEDOUT to retryable',
      },
    ],
    files: ['src/cli.ts', 'src/services/provider-resilience/coordinator.ts'],
    commands: [],
    verification: ['unit test asserts single switch'],
    risks: ['fallback provider must preserve source status'],
    usage: EMPTY_SUBTASK_USAGE,
  };
}

describe('research contract (P0-R1)', () => {
  const request = createLocalResearchRequest('confirm provider fallback', '/repo');
  const ctx = { sessionId: 'sess-1', projectPath: '/repo' };

  // Freeze the clock so packet timestamps are identical across builds. The
  // reproducibility contract lives in `hashPacket` (which strips timestamps);
  // `stableStringify` only sorts keys, so without a fixed clock the two packets
  // built below would differ by a millisecond and the determinism test would
  // flicker.
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  it('maps a local-only completed result to a recoverable packet (POC-1)', () => {
    const packet = subtaskResultToPacket(completedResult(), request, ctx);

    expect(packet.schemaVersion).toBe(1);
    expect(packet.sources).toHaveLength(2);
    expect(packet.sources.every(s => s.kind === 'file' && s.provider === 'local')).toBe(true);

    // 2 file findings -> observed; 1 inference finding -> unverified.
    const observed = packet.claims.filter(c => c.verification === 'observed');
    const inferred = packet.claims.filter(c => c.verification === 'unverified');
    expect(observed).toHaveLength(2);
    expect(inferred).toHaveLength(1);
    expect(observed.every(c => c.sourceIds.length === 1)).toBe(true);
    expect(inferred.every(c => c.sourceIds.length === 0)).toBe(true);

    const validation = validatePacket(packet);
    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('produces a deterministic, serializable packet', () => {
    const a = stableStringify(subtaskResultToPacket(completedResult(), request, ctx));
    const b = stableStringify(subtaskResultToPacket(completedResult(), request, ctx));
    expect(a).toBe(b);
  });

  it('content hash is stable across separate builds', () => {
    const a = hashPacket(subtaskResultToPacket(completedResult(), request, ctx));
    const b = hashPacket(subtaskResultToPacket(completedResult(), request, ctx));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails closed when summary is missing', () => {
    const result = completedResult();
    result.summary = '';
    const packet = subtaskResultToPacket(result, request, ctx);
    const validation = validatePacket(packet);
    expect(validation.ok).toBe(false);
    expect(validation.errors.some(e => e.includes('summary'))).toBe(true);
  });

  it('fails closed when an observed claim has no source binding', () => {
    const packet = subtaskResultToPacket(completedResult(), request, ctx);
    packet.claims[0].sourceIds = [];
    const validation = validatePacket(packet);
    expect(validation.ok).toBe(false);
    expect(validation.errors.some(e => e.includes('source binding'))).toBe(true);
  });

  it('fails closed when sources exceed request budget', () => {
    const tight = createLocalResearchRequest('confirm provider fallback', '/repo', { maxSources: 1 });
    const packet = subtaskResultToPacket(completedResult(), tight, ctx);
    const validation = validatePacket(packet);
    expect(validation.ok).toBe(false);
    expect(validation.errors.some(e => e.includes('maxSources'))).toBe(true);
  });

  it('never reports observed claims for non-completed results', () => {
    const failed = completedResult();
    failed.status = 'failed';
    const packet: ResearchPacket = subtaskResultToPacket(failed, request, ctx);
    expect(packet.claims.some(c => c.verification === 'observed')).toBe(false);
    expect(packet.claims.every(c => c.verification === 'unverified')).toBe(true);
  });

  it('validates the research request contract', () => {
    expect(validateResearchRequest(request).ok).toBe(true);
    expect(validateResearchRequest({ ...request, mode: 'remote' as never }).ok).toBe(false);
    expect(validateResearchRequest({ objective: '', scope: { projectRoot: '/x' }, mode: 'local', maxSources: 1, maxFetchBytes: 0, maxDurationMs: 1 } as never).ok).toBe(false);
  });
});

/**
 * Hard-limit and fail-closed branches the P0-R1 suite left unexercised. Every
 * assertion here guards a rejection path: an untested branch in a validator is
 * a validator that can silently fail open.
 */
describe('research contract hard limits and fail-closed branches', () => {
  const request = createLocalResearchRequest('confirm provider fallback', '/repo');
  const ctx = { sessionId: 'sess-1', projectPath: '/repo' };
  const packet = (): ResearchPacket => subtaskResultToPacket(completedResult(), request, ctx);

  it('rejects a packet built against an unsupported schema version', () => {
    const p = packet();
    p.schemaVersion = 99;
    const validation = validatePacket(p);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('unsupported schemaVersion 99');
  });

  it('rejects a summary longer than the hard limit', () => {
    const p = packet();
    p.summary = 'x'.repeat(RESEARCH_HARD_LIMITS.maxSummaryLen + 1);
    const validation = validatePacket(p);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('packet.summary exceeds max length');
  });

  it('rejects more claims than the hard limit', () => {
    const p = packet();
    const seed = p.claims[0];
    p.claims = Array.from({ length: RESEARCH_HARD_LIMITS.maxClaims + 1 }, (_, i) => ({
      ...seed,
      id: `claim-${i}`,
    }));
    const validation = validatePacket(p);
    expect(validation.ok).toBe(false);
    expect(
      validation.errors.some(e => e.includes(`exceed max ${RESEARCH_HARD_LIMITS.maxClaims}`)),
    ).toBe(true);
  });

  it('rejects an inference claim that is marked observed', () => {
    // The core integrity invariant of the packet: something the agent reasoned
    // its way to can never be reported as directly observed, even when a source
    // happens to be attached to it.
    const p = packet();
    const claim = p.claims.find(c => c.verification === 'observed');
    expect(claim).toBeDefined();
    claim!.evidenceKind = 'inference';
    const validation = validatePacket(p);
    expect(validation.ok).toBe(false);
    expect(validation.errors.some(e => e.includes('is inference but marked observed'))).toBe(true);
  });

  it('rejects a request whose schema version is not the supported one', () => {
    const validation = validateResearchRequest({ ...request, schemaVersion: 99 });
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('unsupported schemaVersion 99');
  });

  it('rejects budgets that fall outside their hard floors', () => {
    const validation = validateResearchRequest({
      ...request,
      maxSources: 0,
      maxFetchBytes: -1,
      maxDurationMs: 0,
    });
    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        `maxSources must be >= ${RESEARCH_HARD_LIMITS.maxSources.min}`,
        'maxFetchBytes must be >= 0',
        `maxDurationMs must be >= ${RESEARCH_HARD_LIMITS.maxDurationMs.min}`,
      ]),
    );
  });

  it('rejects a goal binding that is missing its identifiers', () => {
    const validation = validateResearchRequest({ ...request, goalBinding: {} as never });
    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        'goalBinding.goalId is required',
        'goalBinding.objectiveRevision is required',
      ]),
    );
  });
});
