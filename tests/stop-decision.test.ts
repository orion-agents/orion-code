import { createStopDecision, type StopDecisionInput } from '../src/framework/stop-decision';

describe('typed stop decisions', () => {
  it('marks a request resource boundary as resumable instead of task completion', () => {
    const input: StopDecisionInput = {
      scope: 'request',
      status: 'stopped',
      disposition: 'resume_allowed',
      reason: {
        code: 'llm_request_budget',
        message: 'LLM request budget 8 reached',
      },
      evidence: [
        {
          kind: 'resource_limit',
          source: 'query',
          detail: '8/8 model requests',
        },
      ],
      nextActions: [
        {
          kind: 'continue',
          label: 'Continue the same objective',
          command: '继续',
        },
      ],
      resources: {
        llmRequests: { used: 8, limit: 8 },
        toolCalls: { used: 3, limit: 32 },
      },
    };

    expect(createStopDecision(input)).toEqual({
      schemaVersion: 1,
      ...input,
    });
  });

  it('rejects non-finite resource snapshots fail-closed', () => {
    expect(() =>
      createStopDecision({
        scope: 'subagent',
        status: 'stopped',
        disposition: 'resume_allowed',
        reason: { code: 'provider_budget', message: 'provider budget reached' },
        evidence: [],
        nextActions: [],
        resources: { providerAttempts: { used: Number.NaN, limit: 2 } },
      })
    ).toThrow(/finite non-negative integer/);
  });
});
