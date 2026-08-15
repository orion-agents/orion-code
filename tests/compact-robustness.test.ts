import { query, type QueryEvent } from '../src/framework/query';
import { AutoCompact, compactMessages, type AutoCompactAttempt } from '../src/services/compact';
import type { LLMResponse, LLMService, Message } from '../src/services/llm';
import { estimateMessagesTokens } from '../src/utils/token-estimate';

function mockLlm(response: LLMResponse): jest.Mocked<LLMService> {
  return {
    chat: jest.fn(async () => ({ content: 'bounded compact summary', model: 'test-model' })),
    chatStream: jest.fn(async () => response),
    getModel: jest.fn(() => 'test-model'),
    setModel: jest.fn(),
    getConfigSummary: jest.fn(() => ({ model: 'test-model' })),
  } as unknown as jest.Mocked<LLMService>;
}

async function collectQueryEvents(
  messages: Message[],
  llm: jest.Mocked<LLMService>
): Promise<QueryEvent[]> {
  const events: QueryEvent[] = [];
  for await (const event of query({
    messages,
    tools: [],
    toolExecutor: async () => '',
    llm,
  })) {
    events.push(event);
  }
  return events;
}

function expectPaused(
  event: QueryEvent | undefined,
  reasonCode: 'no_headroom' | 'context_thrash'
): void {
  expect(event).toMatchObject({
    type: 'complete',
    stats: {
      finishReason: 'compact_paused',
      stopDecision: {
        scope: 'request',
        status: 'stopped',
        disposition: 'pause_scope',
        reason: { code: reasonCode },
      },
    },
  });
}

describe('compact robustness', () => {
  test('preserves mandatory invariants through ten sequential compacts', async () => {
    const invariant = 'ROOT criterion-keep-001 evidence-keep-001 MUST remain exact';
    let history: Message[] = [{ role: 'system', content: invariant }];

    for (let round = 0; round < 10; round++) {
      history.push(
        ...Array.from({ length: 12 }, (_, index) => ({
          role: 'user' as const,
          content: `round-${round}-message-${index} ${'x'.repeat(900)}`,
        }))
      );
      const result = await compactMessages(history, {
        maxMessages: 3,
        safeInputBudget: 12_000,
      });

      expect(result.messages[0]).toEqual({ role: 'system', content: invariant });
      expect(result.afterTokens).toBeLessThanOrEqual(7_800);
      expect(result.semanticSummary.coverage.groupCount).toBe(result.plan.evictedGroups.length);
      expect(result.semanticSummary.coverage.groupIds).toEqual(
        result.plan.evictedGroups.map(group => group.id)
      );
      history = result.messages;
    }

    expect(history.map(message => message.content).join('\n')).toContain(invariant);
  });

  test('bounds duplicate no-progress attempts and pauses with context_thrash', async () => {
    const compact = new AutoCompact({
      modelId: 'test-model',
      maxMessages: 3,
      maxConsecutiveNoProgressAttempts: 2,
    });
    const source: Message[] = Array.from({ length: 30 }, (_, index) => ({
      role: 'user',
      content: `message-${index} ${'x'.repeat(200)}`,
    }));

    const first = await compact.checkAndCompactOutcome(source, 200_000);
    expect(first.status).toBe('compacted');
    const compacted = first.messages;

    const duplicate = await compact.checkAndCompactOutcome(compacted, 200_000);
    expect(duplicate).toMatchObject({ status: 'duplicate', consecutiveNoProgressAttempts: 1 });

    const paused = await compact.checkAndCompactOutcome(compacted, 200_000);
    expect(paused).toMatchObject({
      status: 'paused',
      failure: { code: 'context_thrash', consecutiveNoProgressAttempts: 2 },
    });
    expect((paused as Extract<AutoCompactAttempt, { status: 'paused' }>).failure.code).toBe(
      'context_thrash'
    );
    expect(compact.getStats()).toMatchObject({
      compactCount: 1,
      duplicateAttemptCount: 2,
      rejectedAttemptCount: 0,
      consecutiveNoProgressAttempts: 2,
    });
  });

  test('captures semantic authority when the 65% headroom pass runs below prewarm threshold', async () => {
    const getContextCapsule = jest.fn(() => undefined);
    const getHarnessState = jest.fn(() => undefined);
    const compact = new AutoCompact({
      modelId: 'test-model',
      maxMessages: 3,
      preCompactThreshold: 0.8,
      getContextCapsule,
      getHarnessState,
    });
    const source: Message[] = Array.from({ length: 30 }, (_, index) => ({
      role: 'user',
      content: `message-${index} ${'x'.repeat(400)}`,
    }));
    const usedTokens = Math.floor(compact.getStats().safeInputBudget * 0.7);

    const result = await compact.ensureHeadroomAndCompactOutcome(source, usedTokens);

    expect(result.status).toBe('compacted');
    expect(compact.getStats().preCompactArmed).toBe(false);
    expect(getContextCapsule).toHaveBeenCalledTimes(1);
    expect(getHarnessState).toHaveBeenCalledTimes(1);
  });

  test('pauses before provider invocation when the newest atomic item cannot fit', async () => {
    const llm = mockLlm({ content: 'must not run', model: 'test-model' });
    const messages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: `oversized ${'y'.repeat(700_000)}` },
    ];

    const events = await collectQueryEvents(messages, llm);
    const complete = events.find(event => event.type === 'complete');

    expectPaused(complete, 'no_headroom');
    expect(llm.chatStream).not.toHaveBeenCalled();
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(100_000);
  });

  test('pauses post-turn when a provider response creates an oversized atomic item', async () => {
    const llm = mockLlm({
      content: `oversized assistant ${'z'.repeat(700_000)}`,
      model: 'test-model',
    });
    const messages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'small request' },
    ];

    const events = await collectQueryEvents(messages, llm);
    const complete = events.find(event => event.type === 'complete');

    expectPaused(complete, 'no_headroom');
    expect(llm.chatStream).toHaveBeenCalledTimes(1);
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'message', role: 'assistant' })])
    );
  });

  test('revalidates a pending predictive compact at 65% before exposing its commit receipt', async () => {
    const llm = mockLlm({
      content: 'small final answer',
      model: 'test-model',
      usage: { promptTokens: 90_000, completionTokens: 20 },
    });
    const messages: Message[] = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `large-${index}-${'x'.repeat(16_000)}`,
    }));

    const events = await collectQueryEvents(messages, llm);
    const complete = events.find(
      (event): event is Extract<QueryEvent, { type: 'complete' }> => event.type === 'complete'
    );

    expect(complete?.stats?.finishReason).toBe('completed');
    expect(complete?.compact).toMatchObject({
      mode: 'predictive',
      after: { percent: expect.any(Number) },
    });
    expect(complete?.compact?.after.percent).toBeLessThanOrEqual(65);
  });
});
