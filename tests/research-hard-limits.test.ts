import { EMPTY_SUBTASK_USAGE } from '../src/runtime/subagents/types';
import {
  RESEARCH_HARD_LIMITS,
  createLocalResearchRequest,
  subtaskResultToPacket,
  validatePacket,
  validateResearchRequest,
} from '../src/runtime/subagents/research-contract';

describe('research request hard limits (#106)', () => {
  const request = createLocalResearchRequest('bounded research', '/repo');

  it('rejects budgets above every declared hard maximum', () => {
    const validation = validateResearchRequest({
      ...request,
      maxSources: RESEARCH_HARD_LIMITS.maxSources.max + 1,
      maxFetchBytes: RESEARCH_HARD_LIMITS.maxFetchBytes.max + 1,
      maxDurationMs: RESEARCH_HARD_LIMITS.maxDurationMs.max + 1,
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        `maxSources must be <= ${RESEARCH_HARD_LIMITS.maxSources.max}`,
        `maxFetchBytes must be <= ${RESEARCH_HARD_LIMITS.maxFetchBytes.max}`,
        `maxDurationMs must be <= ${RESEARCH_HARD_LIMITS.maxDurationMs.max}`,
      ])
    );
  });

  it.each([
    ['maxSources', Number.NaN],
    ['maxFetchBytes', Number.POSITIVE_INFINITY],
    ['maxDurationMs', 1.5],
  ] as const)('rejects non-safe-integer %s values', (field, value) => {
    const validation = validateResearchRequest({ ...request, [field]: value });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain(`${field} must be a safe integer`);
  });

  it('revalidates the embedded request when loading or replaying a packet', () => {
    const overBudget = {
      ...request,
      maxSources: RESEARCH_HARD_LIMITS.maxSources.max + 1,
    };
    const researchPacket = subtaskResultToPacket(
      {
        id: 'task-1',
        role: 'research',
        status: 'completed',
        summary: 'summary',
        findings: [],
        files: [],
        commands: [],
        verification: [],
        risks: [],
        usage: EMPTY_SUBTASK_USAGE,
      },
      overBudget,
      { sessionId: 'sess-1', projectPath: '/repo' }
    );

    const validation = validatePacket(researchPacket);

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain(
      `packet.request: maxSources must be <= ${RESEARCH_HARD_LIMITS.maxSources.max}`
    );
  });

  it('fails closed instead of throwing when the embedded request is missing', () => {
    expect(validateResearchRequest(null)).toEqual({
      ok: false,
      errors: ['request is required'],
    });
  });
});
