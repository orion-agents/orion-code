import type { Message } from '../src/services/llm';
import {
  analyzeRequestComplexity,
  DEFAULT_ROUTING_CONFIG,
  quickRoute,
  type SmartRoutingConfig,
} from '../src/services/smart-routing';

const customConfig: SmartRoutingConfig = {
  cheapModel: 'cheap-model',
  strongModel: 'strong-model',
  simpleThresholdChars: 100,
  simpleThresholdWords: 10,
  strongKeywords: ['architect'],
  simpleKeywords: ['rename'],
};

function toolCall(id: number) {
  return {
    id: `call-${id}`,
    type: 'function' as const,
    function: { name: 'read_file', arguments: '{}' },
  };
}

describe('smart routing', () => {
  it('routes strong keywords to the strong model with high confidence', () => {
    expect(analyzeRequestComplexity('Please design the architecture', [])).toEqual({
      recommendedModel: DEFAULT_ROUTING_CONFIG.strongModel,
      needsStrongModel: true,
      reason: 'Contains strong keywords indicating complex task',
      confidence: 0.9,
    });
  });

  it('uses the custom character and word thresholds independently', () => {
    const longByCharacters = analyzeRequestComplexity('x'.repeat(301), [], customConfig);
    expect(longByCharacters).toMatchObject({
      recommendedModel: 'strong-model',
      reason: 'Very long input indicating complex request',
      confidence: 0.7,
    });

    const wordSensitiveConfig = {
      ...customConfig,
      simpleThresholdChars: 1_000,
      simpleThresholdWords: 2,
    };
    const longByWords = analyzeRequestComplexity(
      'one two three four five six seven',
      [],
      wordSensitiveConfig
    );
    expect(longByWords).toMatchObject({
      recommendedModel: 'strong-model',
      reason: 'Many words indicating detailed request',
    });
  });

  it('routes a complex conversation history to the strong model', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'a'.repeat(450),
        tool_calls: Array.from({ length: 10 }, (_, index) => toolCall(index)),
      },
      { role: 'user', content: 'b'.repeat(450) },
      { role: 'assistant', content: 'c'.repeat(450) },
    ];

    expect(analyzeRequestComplexity('continue', messages, customConfig)).toMatchObject({
      recommendedModel: 'strong-model',
      needsStrongModel: true,
      reason: 'History indicates ongoing complex task',
      confidence: 0.885,
    });
  });

  it('routes short simple requests to the cheap model', () => {
    expect(analyzeRequestComplexity('rename x', [], customConfig)).toEqual({
      recommendedModel: 'cheap-model',
      needsStrongModel: false,
      reason: 'Contains simple keywords and short input',
      confidence: 0.85,
    });

    expect(analyzeRequestComplexity('hello', [], customConfig)).toEqual({
      recommendedModel: 'cheap-model',
      needsStrongModel: false,
      reason: 'Short and simple input',
      confidence: 0.6,
    });
  });

  it('conservatively sends medium-complexity requests to the strong model', () => {
    expect(analyzeRequestComplexity('x'.repeat(180), [], customConfig)).toEqual({
      recommendedModel: 'strong-model',
      needsStrongModel: true,
      reason: 'Medium complexity, using strong model for reliability',
      confidence: 0.6,
    });
  });

  it('accounts for mixed keywords and long otherwise-simple inputs in confidence', () => {
    expect(analyzeRequestComplexity('rename and architect', [], customConfig)).toMatchObject({
      recommendedModel: 'strong-model',
      confidence: 0.85,
    });

    const relaxedConfig = {
      ...customConfig,
      simpleThresholdChars: 1_000,
      simpleThresholdWords: 100,
    };
    const manyWords = Array.from({ length: 31 }, () => 'word').join(' ');
    expect(analyzeRequestComplexity(manyWords, [], relaxedConfig)).toMatchObject({
      recommendedModel: 'cheap-model',
      confidence: 0.7,
    });
  });

  it('quickRoute uses keywords, length, and custom model names', () => {
    expect(quickRoute('please debug this')).toBe(DEFAULT_ROUTING_CONFIG.strongModel);
    expect(quickRoute('x'.repeat(DEFAULT_ROUTING_CONFIG.simpleThresholdChars * 2 + 1))).toBe(
      DEFAULT_ROUTING_CONFIG.strongModel
    );
    expect(quickRoute('hello')).toBe(DEFAULT_ROUTING_CONFIG.cheapModel);
    expect(quickRoute('architect the service', customConfig)).toBe('strong-model');
    expect(quickRoute('rename x', customConfig)).toBe('cheap-model');
  });
});
