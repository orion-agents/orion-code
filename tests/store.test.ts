import { Store } from '../src/framework/store';
import type { AppState } from '../src/framework/store';
import { buildTool } from '../src/framework/tool';
import type { OpenHorseTool } from '../src/framework/tool';

const mockTool: OpenHorseTool = buildTool({
  name: 'test_tool',
  description: 'A test tool',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ success: true, output: '' }),
});

function makeConfig(overrides = {}) {
  return {
    apiKey: 'test-key',
    model: 'gpt-4o',
    fallbackModel: 'backup-model',
    name: 'test',
    mode: 'development' as const,
    logLevel: 'info' as const,
    toolConfirmation: 'allow' as const,
    ...overrides,
  };
}

const defaultStoreInit = {
  config: makeConfig(),
  tools: [] as OpenHorseTool[],
  currentModel: 'test-model',
};

describe('Store', () => {
  test('initializes with default values', () => {
    const store = new Store({
      config: makeConfig(),
      tools: [mockTool],
      currentModel: 'test-model',
    });
    const state = store.getSnapshot();
    expect(state.conversationHistory).toEqual([]);
    expect(state.isProcessing).toBe(false);
    expect(state.tokenUsage).toBeNull();
    expect(state.contextUsage).toBeNull();
    expect(state.config.apiKey).toBe('test-key');
    expect(state.tools).toHaveLength(1);
  });

  test('getSnapshot returns current state', () => {
    const store = new Store({ ...defaultStoreInit });
    const snapshot = store.getSnapshot();
    expect(snapshot).toBeDefined();
    expect(snapshot.config).toBeDefined();
  });

  test('setState updates state and notifies listeners', () => {
    const store = new Store({ ...defaultStoreInit });
    const listener = jest.fn();
    store.subscribe(listener);

    store.setState({ currentModel: 'new-model' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].currentModel).toBe('new-model');
    expect(store.getSnapshot().currentModel).toBe('new-model');
  });

  test('subscribe returns unsubscribe function', () => {
    const store = new Store({ ...defaultStoreInit });
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    store.setState({ currentModel: 'changed' });
    expect(listener).not.toHaveBeenCalled();
  });

  test('resetConversation clears history, token usage, and context usage', () => {
    const store = new Store({ ...defaultStoreInit });
    store.addMessage({ role: 'user', content: 'hello' });
    store.setTokenUsage({ promptTokens: 10, completionTokens: 20 });
    store.setContextUsage({
      modelId: 'gpt-4o',
      usedTokens: 1000,
      contextWindow: 128000,
      percent: 0,
      source: 'estimated',
      warningThresholdPercent: 80,
      autoCompactThresholdPercent: 95,
      autoCompactEnabled: true,
    });

    store.resetConversation();
    const state = store.getSnapshot();
    expect(state.conversationHistory).toHaveLength(0);
    expect(state.tokenUsage).toBeNull();
    expect(state.contextUsage).toBeNull();
  });

  test('setProcessing updates isProcessing', () => {
    const store = new Store({ ...defaultStoreInit });
    store.setProcessing(true);
    expect(store.getSnapshot().isProcessing).toBe(true);

    store.setProcessing(false);
    expect(store.getSnapshot().isProcessing).toBe(false);
  });

  test('addMessage appends to conversationHistory', () => {
    const store = new Store({ ...defaultStoreInit });
    store.addMessage({ role: 'system', content: 'You are a bot.' });
    store.addMessage({ role: 'user', content: 'Hello' });
    store.addMessage({ role: 'assistant', content: 'Hi there!' });

    const state = store.getSnapshot();
    expect(state.conversationHistory).toHaveLength(3);
    expect(state.conversationHistory[0].role).toBe('system');
    expect(state.conversationHistory[1].content).toBe('Hello');
    expect(state.conversationHistory[2].role).toBe('assistant');
  });

  test('addMessage preserves immutability', () => {
    const store = new Store({ ...defaultStoreInit });
    store.addMessage({ role: 'user', content: 'first' });
    const snap1 = store.getSnapshot();

    store.addMessage({ role: 'user', content: 'second' });
    const snap2 = store.getSnapshot();

    expect(snap1.conversationHistory).toHaveLength(1);
    expect(snap2.conversationHistory).toHaveLength(2);
  });

  test('setTokenUsage updates tokenUsage', () => {
    const store = new Store({ ...defaultStoreInit });
    store.setTokenUsage({ promptTokens: 100, completionTokens: 200 });
    const state = store.getSnapshot();
    expect(state.tokenUsage).toEqual({ promptTokens: 100, completionTokens: 200 });
  });

  test('setContextUsage stores current request pressure separately from session tokens', () => {
    const store = new Store({ ...defaultStoreInit });
    const contextUsage = {
      modelId: 'gpt-4o',
      usedTokens: 102400,
      contextWindow: 128000,
      percent: 80,
      source: 'estimated' as const,
      warningThresholdPercent: 80,
      autoCompactThresholdPercent: 95,
      autoCompactEnabled: true,
    };

    store.setTokenUsage({ promptTokens: 500000, completionTokens: 100000 });
    store.setContextUsage(contextUsage);

    expect(store.getSnapshot().contextUsage).toEqual(contextUsage);
    expect(store.getSnapshot().tokenUsage).toEqual({
      promptTokens: 500000,
      completionTokens: 100000,
    });
  });

  test('multiple listeners all get notified', () => {
    const store = new Store({ ...defaultStoreInit });
    const l1 = jest.fn();
    const l2 = jest.fn();
    store.subscribe(l1);
    store.subscribe(l2);

    store.setState({ currentModel: 'model-x' });
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });

  test('setState merges partial updates', () => {
    const store = new Store({
      config: makeConfig(),
      tools: [mockTool],
      currentModel: 'original-model',
    });
    store.setState({ currentModel: 'new-model' });
    const state = store.getSnapshot();
    expect(state.currentModel).toBe('new-model');
    expect(state.tools).toHaveLength(1);
    expect(state.config.apiKey).toBe('test-key');
  });
});
