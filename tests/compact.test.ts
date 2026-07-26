import {
  getAutoCompact,
  resetAutoCompact,
  AutoCompact,
} from '../src/services/compact/auto-compact';
import { compactMessages } from '../src/services/compact/compact';
import { CompactCoordinator } from '../src/services/compact/coordinator';
import { createContextHarness } from '../src/harness';
import {
  createContextUsageSnapshot,
  resolveContextBudget,
  resolveModelContext,
} from '../src/services/model-context';
import type { Message } from '../src/services/llm';

function createMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: 'user' as const,
    content: `Message ${i}`,
  }));
}

beforeEach(() => {
  resetAutoCompact();
});

afterEach(() => {
  resetAutoCompact();
});

describe('AutoCompact', () => {
  describe('token-based compact', () => {
    test('triggers compact when token usage exceeds 95%', async () => {
      const autoCompact = getAutoCompact({
        modelId: 'test-model',
        threshold: 0.95,
        maxMessages: 5,
      });

      // 95% of 128000 (default) = 121600 tokens
      const msgs = createMessages(30);
      const result = await autoCompact.checkAndCompact(msgs, 125000);
      expect(result.length).toBeLessThan(msgs.length);
    });

    test('does nothing when below 95%', async () => {
      const autoCompact = getAutoCompact({
        modelId: 'glm-5', // 202752 context
        maxMessages: 5,
      });

      const msgs = createMessages(30);
      // Only 1000 tokens, well below 95% of 202752
      const result = await autoCompact.checkAndCompact(msgs, 1000);
      expect(result.length).toBe(msgs.length);
    });

    test('does not round 94.99% up into an automatic compact', async () => {
      const autoCompact = getAutoCompact({
        modelId: 'test-model',
        maxMessages: 5,
      });
      const msgs = createMessages(30);
      const safeInputBudget = resolveContextBudget('test-model').safeInputBudget;

      const result = await autoCompact.checkAndCompact(
        msgs,
        Math.floor(safeInputBudget * 0.9499)
      );

      expect(result).toBe(msgs);
      expect(autoCompact.getStats().ctxPercent).toBe(94);
    });

    test('triggers automatic compact at exactly 95%', async () => {
      const autoCompact = getAutoCompact({
        modelId: 'test-model',
        maxMessages: 5,
      });
      const msgs = createMessages(30);
      const safeInputBudget = resolveContextBudget('test-model').safeInputBudget;

      const result = await autoCompact.checkAndCompact(msgs, safeInputBudget * 0.95);

      expect(result.length).toBeLessThan(msgs.length);
      expect(autoCompact.getStats().ctxPercent).toBe(95);
    });

    test('does not repeatedly compact the same unchanged history', async () => {
      const autoCompact = getAutoCompact({
        modelId: 'test-model',
        maxMessages: 3,
      });

      const msgs = createMessages(30);
      const result1 = await autoCompact.checkAndCompact(msgs, 200000);
      expect(result1.length).toBeLessThan(msgs.length);

      const result2 = await autoCompact.checkAndCompact(result1, 200000);
      expect(result2).toBe(result1);
      expect(autoCompact.getStats().compactCount).toBe(1);
    });

    test('can compact changed context again within 30 seconds', async () => {
      const autoCompact = getAutoCompact({
        modelId: 'test-model',
        maxMessages: 3,
      });

      const result1 = await autoCompact.checkAndCompact(createMessages(30), 200000);
      const grown = [...result1, ...createMessages(30)];
      const result2 = await autoCompact.checkAndCompact(grown, 200000);

      expect(result2.length).toBeLessThan(grown.length);
      expect(autoCompact.getStats().compactCount).toBe(2);
    });

    test('forceCompact bypasses interval check', async () => {
      const autoCompact = getAutoCompact({
        modelId: 'test-model',
        maxMessages: 3,
      });

      const msgs = createMessages(30);
      await autoCompact.checkAndCompact(msgs, 200000);

      // Force compact should work even within interval
      const freshMsgs = createMessages(30);
      const result = await autoCompact.forceCompact(freshMsgs);
      expect(result.length).toBeLessThan(freshMsgs.length);
    });

    test('setEnabled(false) disables auto compact', async () => {
      const autoCompact = getAutoCompact({
        modelId: 'test-model',
        maxMessages: 5,
        enabled: false,
      });
      const msgs = createMessages(30);

      const result = await autoCompact.checkAndCompact(msgs, 200000);
      expect(result.length).toBe(msgs.length);
    });

    test('getStats returns correct values', async () => {
      const autoCompact = getAutoCompact({
        modelId: 'glm-5',
        maxMessages: 5,
      });
      const msgs = createMessages(30);

      await autoCompact.checkAndCompact(msgs, 200000);
      const stats = autoCompact.getStats();

      expect(stats.compactCount).toBe(1);
      expect(stats.threshold).toBe(0.95);
      expect(stats.enabled).toBe(true);
      expect(stats.modelId).toBe('glm-5');
    });

    test('uses model-specific context window', async () => {
      const autoCompact = getAutoCompact({
        modelId: 'glm-5', // 202752 context
      });

      const msgs = createMessages(30);

      // 100k tokens is 52% of glm-5's safe input budget — should NOT compact
      const result = await autoCompact.checkAndCompact(msgs, 100000);
      expect(result.length).toBe(msgs.length);

      // Check ctxPercent
      const pct = autoCompact.getCtxPercent(100000);
      expect(pct).toBe(52);
    });

    test('setModel updates context window', async () => {
      const autoCompact = getAutoCompact({
        modelId: 'glm-5', // 202752
      });

      // Percentages use the safe input budget rather than the raw context window.
      expect(autoCompact.getCtxPercent(100000)).toBe(52);

      autoCompact.setModel('gpt-4o'); // 128000
      expect(autoCompact.getCtxPercent(100000)).toBe(85);
    });

    test('resolves provider-prefixed model aliases to known context windows', () => {
      const info = resolveModelContext('bailian/qwen3.7-plus');

      expect(info.source).toBe('builtin');
      expect(info.matchedId).toBe('qwen3.7-plus');
      expect(info.contextWindow).toBe(131072);
    });

    test('predictive compact triggers before the hard threshold', async () => {
      const onCompact = jest.fn();
      const autoCompact = getAutoCompact({
        modelId: 'test-model',
        maxMessages: 3,
        predictiveCompactThreshold: 0.88,
        threshold: 0.95,
        onCompact,
      });

      const msgs = createMessages(30);
      const result = await autoCompact.checkPredictiveAndCompact(msgs, 114000);

      expect(result.length).toBeLessThan(msgs.length);
      expect(onCompact).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'predictive',
        })
      );
      expect(autoCompact.getStats().preCompactArmed).toBe(true);
    });

    test('uses 95% as the default predictive and hard threshold', () => {
      const stats = getAutoCompact({ modelId: 'test-model' }).getStats();

      expect(stats.predictiveCompactThreshold).toBe(0.95);
      expect(stats.threshold).toBe(0.95);
    });

    test('passes configured LLM to compact summary generation', async () => {
      const llm = {
        chat: jest.fn(async () => ({
          content: 'Auto LLM summary',
          model: 'test-model',
        })),
      };
      const autoCompact = getAutoCompact({
        modelId: 'test-model',
        maxMessages: 2,
        llm: llm as any,
      });

      const result = await autoCompact.checkAndCompact(createMessages(10), 200000);

      expect(llm.chat).toHaveBeenCalled();
      expect(result.map(message => message.content).join('\n')).toContain('Auto LLM summary');
    });
  });

  test('creates context snapshots from current context rather than cumulative usage', () => {
    const usage = createContextUsageSnapshot({
      modelId: 'gpt-4',
      usedTokens: 4915,
      outputReserveTokens: 1024,
    });

    expect(usage).toMatchObject({
      usedTokens: 4915,
      contextWindow: 8192,
      percent: 79,
      rawPercent: 59,
      safeInputBudget: 6144,
      reservedOutputTokens: 1024,
      safetyMarginTokens: 1024,
      warningThresholdPercent: 80,
      autoCompactThresholdPercent: 95,
      source: 'estimated',
    });
  });

  test('calibrates estimates from provider usage and resets on model change', () => {
    const autoCompact = new AutoCompact({ modelId: 'glm-5' });

    autoCompact.recordProviderUsage(1000, 1250, 'glm-5');
    expect(autoCompact.adjustTokenEstimate(2000, 'glm-5')).toBe(2250);
    expect(autoCompact.hasProviderCalibration('glm-5')).toBe(true);

    autoCompact.configure({ modelId: 'gpt-4o' });
    expect(autoCompact.adjustTokenEstimate(2000, 'gpt-4o')).toBe(2000);
    expect(autoCompact.hasProviderCalibration('gpt-4o')).toBe(false);
  });

  test('manual compact settings do not mutate the automatic 20-message policy', async () => {
    const coordinator = new CompactCoordinator({ modelId: 'test-model' });

    const manual = await coordinator.compactManual(createMessages(60), 3);
    expect(manual.messages.length).toBeLessThan(10);
    expect(coordinator.getAutomatic().getStats()).toMatchObject({
      modelId: 'test-model',
    });

    const automatic = await coordinator
      .getAutomatic()
      .checkAndCompact(createMessages(60), 200000);
    expect(automatic.filter(message => message.content?.startsWith('Message '))).toHaveLength(20);
  });

  test('compactMessages preserves structured Harness State v2 before summary text', async () => {
    const harness = createContextHarness({ cwd: '/repo', modelId: 'gpt-4o' });
    harness.updateContractFromUserInput('实现 v0.1.23 harness，必须支持 resume 后继续');

    const messages: Message[] = [{ role: 'system', content: 'base' }, ...createMessages(12)];

    const result = await compactMessages(messages, {
      maxMessages: 2,
      harnessState: harness.toJSON(),
      compactMode: 'manual',
    });

    const joined = result.messages.map(message => message.content).join('\n');
    expect(joined).toContain('[Orion Code Context State v2]');
    expect(joined).toContain('rootObjective');
    expect(joined.indexOf('[Orion Code Context State v2]')).toBeLessThan(
      joined.indexOf('[Context Summary]')
    );
  });

  test('compactMessages uses LLM summary when an LLM service is provided', async () => {
    const llm = {
      chat: jest.fn(async () => ({
        content: 'LLM compact summary',
        model: 'test-model',
      })),
    };

    const result = await compactMessages(createMessages(8), {
      maxMessages: 2,
      llm: llm as any,
    });

    expect(llm.chat).toHaveBeenCalled();
    expect(result.summary).toBe('LLM compact summary');
    expect(result.messages.map(message => message.content).join('\n')).toContain(
      'LLM compact summary'
    );
  });

  test('falls back to a redacted heuristic summary when the summary model fails', async () => {
    const llm = {
      chat: jest.fn(async () => {
        throw new Error('provider unavailable');
      }),
    };
    const result = await compactMessages(
      [
        { role: 'user', content: 'deploy using apiKey=sk-testsecret123456' },
        ...createMessages(5),
      ],
      { maxMessages: 1, llm: llm as any }
    );

    expect(result.summarySource).toBe('heuristic');
    expect(result.summary).toContain('[REDACTED_SECRET]');
    expect(result.summary).not.toContain('sk-testsecret');
  });

  test('merges an existing context summary with only new history', async () => {
    const llm = {
      chat: jest.fn(async () => ({ content: 'merged durable summary', model: 'test-model' })),
    };
    const result = await compactMessages(
      [
        { role: 'user', content: '[Context Summary]\nprior durable summary' },
        {
          role: 'assistant',
          content:
            'I understand the context. I will continue the conversation with this background information.',
        },
        { role: 'user', content: 'new work' },
        { role: 'assistant', content: 'new result' },
      ],
      { maxMessages: 1, llm: llm as any }
    );

    const prompt = (llm.chat as jest.Mock).mock.calls[0][0][0].content as string;
    expect(prompt).toContain('Prior durable summary');
    expect(prompt).toContain('prior durable summary');
    expect(prompt.match(/prior durable summary/g)).toHaveLength(1);
    expect(result.summary).toBe('merged durable summary');
  });
});
