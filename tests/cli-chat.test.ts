/**
 * CLI 对话回归测试
 *
 * 测试完整的对话流程：
 * 1. Store 消息添加
 * 2. Query 循环执行
 * 3. LLMService 流式响应（包括 usage）
 */

import { Store } from '../src/framework/store';
import { query, type QueryEvent } from '../src/framework/query';
import { LLMService, type Message, type Tool } from '../src/services/llm';
import { TOOLS } from '../src/tools';
import { loadConfig } from '../src/services/config';
import { executeChat } from '../src/commands';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock LLMService for testing without real API
class MockLLMService {
  private model: string;
  public lastMessages: Message[] = [];
  public lastTools: Tool[] = [];

  constructor(model: string = 'gpt-4o') {
    this.model = model;
  }

  async chatStream(
    messages: Message[],
    callbacks?: { onChunk?: (chunk: string) => void },
    tools?: Tool[],
  ): Promise<{
    content: string;
    model: string;
    usage?: { promptTokens: number; completionTokens: number };
    toolCalls?: any[];
  }> {
    this.lastMessages = messages;
    this.lastTools = tools || [];
    // Simulate streaming response
    const response = 'This is a mock response.';
    if (callbacks?.onChunk) {
      // Stream word by word
      for (const word of response.split(' ')) {
        callbacks.onChunk(word + ' ');
      }
    }

    // Return response WITH usage (this is what we're testing)
    return {
      content: response,
      model: this.model,
      usage: {
        promptTokens: 100,
        completionTokens: 20,
      },
    };
  }

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
  }
}

describe('CLI Chat Regression', () => {
  describe('Store message handling', () => {
    test('addMessage appends to conversation history', () => {
      const store = new Store({
        config: loadConfig(),
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });

      expect(store.getSnapshot().conversationHistory.length).toBe(0);

      store.addMessage({ role: 'user', content: 'Hello' });
      expect(store.getSnapshot().conversationHistory.length).toBe(1);
      expect(store.getSnapshot().conversationHistory[0].content).toBe('Hello');

      store.addMessage({ role: 'assistant', content: 'Hi there!' });
      expect(store.getSnapshot().conversationHistory.length).toBe(2);
    });

    test('resetConversation clears history and token usage', () => {
      const store = new Store({
        config: loadConfig(),
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });

      store.addMessage({ role: 'user', content: 'Test' });
      store.setTokenUsage({ promptTokens: 100, completionTokens: 50 });

      store.resetConversation();

      expect(store.getSnapshot().conversationHistory.length).toBe(0);
      expect(store.getSnapshot().tokenUsage).toBeNull();
    });

    test('setTokenUsage updates state', () => {
      const store = new Store({
        config: loadConfig(),
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });

      store.setTokenUsage({ promptTokens: 200, completionTokens: 100 });

      const usage = store.getSnapshot().tokenUsage;
      expect(usage?.promptTokens).toBe(200);
      expect(usage?.completionTokens).toBe(100);
    });
  });

  describe('Query loop', () => {
    test('query yields complete event with usage', async () => {
      const mockLLM = new MockLLMService() as unknown as LLMService;

      const messages: Message[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ];

      const toolExecutor = async (name: string, args: Record<string, unknown>) => {
        return JSON.stringify({ success: true });
      };

      const events: QueryEvent[] = [];

      for await (const event of query({
        messages,
        tools: TOOLS,
        toolExecutor,
        llm: mockLLM,
        streamCallbacks: { onChunk: (chunk) => {} },
      })) {
        events.push(event);
      }

      // Should have request_start, message, and complete events
      expect(events.some(e => e.type === 'request_start')).toBe(true);
      expect(events.some(e => e.type === 'complete')).toBe(true);

      // Check complete event has usage
      const completeEvent = events.find(e => e.type === 'complete');
      if (completeEvent?.type === 'complete') {
        expect(completeEvent.usage).toBeDefined();
        expect(completeEvent.usage?.promptTokens).toBe(100);
        expect(completeEvent.usage?.completionTokens).toBe(20);
      }
    });

    test('query preserves conversation history', async () => {
      const mockLLM = new MockLLMService() as unknown as LLMService;

      const messages: Message[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'User message' },
      ];

      const toolExecutor = async () => JSON.stringify({ success: true });

      await (async () => {
        for await (const _ of query({
          messages,
          tools: TOOLS,
          toolExecutor,
          llm: mockLLM,
        })) {
          // Just consume events
        }
      })();

      // Messages should have assistant response appended
      expect(messages.length).toBe(3);
      expect(messages[2].role).toBe('assistant');
    });

    test('executeChat suppresses legacy token meta line in current interactive renderers', async () => {
      const config = loadConfig({
        apiKey: 'test-key',
        ui: { renderer: 'terminal', confirmations: 'config' },
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });
      const mockLLM = new MockLLMService('gpt-4o') as unknown as LLMService;
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const outputChunks: string[] = [];

      try {
        await executeChat({
          cwd: process.cwd(),
          config,
          store,
          llm: mockLLM,
          runtime: {} as any,
          writeOutput: (text: string) => outputChunks.push(text),
          writeLine: (text: string = '') => outputChunks.push(text + '\n'),
        }, 'Hello');

        const output = outputChunks.join('');

        expect(output).toContain('This is a mock response.');
        expect(output).not.toContain('tokens: 100+20');
        expect(output.replace(/\x1b\[[0-9;]*m/g, '')).toContain('response. \n\n');
      } finally {
        logSpy.mockRestore();
      }
    });

    test('executeChat stores last agent-loop stats for status diagnostics', async () => {
      const config = loadConfig({
        apiKey: 'test-key',
        ui: { renderer: 'terminal', confirmations: 'config' },
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });
      const mockLLM = new MockLLMService('gpt-4o') as unknown as LLMService;
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      try {
        await executeChat({
          cwd: process.cwd(),
          config,
          store,
          llm: mockLLM,
          runtime: {} as any,
          writeOutput: () => {},
          writeLine: () => {},
        }, 'Hello');

        expect(store.getSnapshot().lastLoopStats).toMatchObject({
          finishReason: 'completed',
          turnsStarted: 1,
          llmRequests: 1,
          toolCalls: 0,
        });
      } finally {
        logSpy.mockRestore();
      }
    });

    test('executeChat applies configured agent-loop budget in the legacy command path', async () => {
      const config = loadConfig({
        apiKey: 'test-key',
        ui: { renderer: 'terminal', confirmations: 'config' },
        agentLoop: {
          budget: {
            maxLlmRequestsPerUserTurn: 7,
            maxToolCallsPerUserTurn: 33,
          },
        },
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });
      const mockLLM = new MockLLMService('gpt-4o') as unknown as LLMService;
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      try {
        await executeChat({
          cwd: process.cwd(),
          config,
          store,
          llm: mockLLM,
          runtime: {} as any,
          writeOutput: () => {},
          writeLine: () => {},
        }, 'Hello');

        expect(store.getSnapshot().lastLoopStats).toMatchObject({
          finishReason: 'completed',
          loopBudgetSource: 'config',
          loopBudgetMaxLlmRequests: 7,
          loopBudgetMaxToolCalls: 33,
        });
      } finally {
        logSpy.mockRestore();
      }
    });

    test('executeChat injects active skill prompt and scopes tools', async () => {
      const config = loadConfig({
        apiKey: 'test-key',
        ui: { renderer: 'terminal', confirmations: 'config' },
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });
      const mockLLM = new MockLLMService('gpt-4o') as unknown as MockLLMService & LLMService;
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      try {
        await executeChat({
          cwd: process.cwd(),
          config,
          store,
          llm: mockLLM,
          runtime: {} as any,
          writeOutput: () => {},
          writeLine: () => {},
        }, '/review src');

        const systemPrompt = mockLLM.lastMessages[0]?.content || '';
        expect(systemPrompt).toContain('## Active Skills');
        expect(systemPrompt).toContain('# Code Review Skill');
        expect(mockLLM.lastTools.map(tool => tool.function.name).sort()).toEqual(['glob', 'grep', 'read_file']);
        expect(store.getSnapshot().harnessState?.ledger.some(entry => entry.type === 'skill')).toBe(true);
      } finally {
        logSpy.mockRestore();
      }
    });

    test('executeChat injects @ referenced file content into the system prompt', async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'openhorse-chat-file-ref-'));
      const filePath = join(projectDir, 'target.ts');
      writeFileSync(filePath, 'export const referencedValue = 123;\n');
      const config = loadConfig({
        apiKey: 'test-key',
        ui: { renderer: 'terminal', confirmations: 'config' },
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });
      const mockLLM = new MockLLMService('gpt-4o') as unknown as MockLLMService & LLMService;
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      try {
        await executeChat({
          cwd: projectDir,
          config,
          store,
          llm: mockLLM,
          runtime: {} as any,
          writeOutput: () => {},
          writeLine: () => {},
        }, 'explain @target.ts');

        const systemPrompt = mockLLM.lastMessages[0]?.content || '';
        expect(systemPrompt).toContain('User-referenced files');
        expect(systemPrompt).toContain('### @target.ts');
        expect(systemPrompt).toContain('referencedValue');
      } finally {
        logSpy.mockRestore();
        rmSync(projectDir, { recursive: true, force: true });
      }
    });

    test('executeChat refreshes and injects project instructions into the system prompt', async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'openhorse-chat-project-rules-'));
      writeFileSync(join(projectDir, 'AGENTS.md'), 'Fresh repo rules from disk.\n');
      const config = loadConfig({
        apiKey: 'test-key',
        ui: { renderer: 'terminal', confirmations: 'config' },
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'gpt-4o',
        projectInstructionsContent: 'stale rules',
      });
      const mockLLM = new MockLLMService('gpt-4o') as unknown as MockLLMService & LLMService;
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      try {
        await executeChat({
          cwd: projectDir,
          config,
          store,
          llm: mockLLM,
          runtime: {} as any,
          writeOutput: () => {},
          writeLine: () => {},
        }, 'hello');

        const systemPrompt = mockLLM.lastMessages[0]?.content || '';
        expect(systemPrompt).toContain('Project instructions loaded');
        expect(systemPrompt).toContain('Fresh repo rules from disk.');
        expect(systemPrompt).not.toContain('stale rules');
        expect(store.getSnapshot().projectInstructionsContent).toContain('Fresh repo rules from disk.');
      } finally {
        logSpy.mockRestore();
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  });

  describe('CostTracker integration', () => {
    test('CostTracker records usage from query', async () => {
      const { CostTracker } = await import('../src/core/cost-tracker');
      const mockLLM = new MockLLMService() as unknown as LLMService;
      const costTracker = new CostTracker();

      const messages: Message[] = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Test' },
      ];

      const toolExecutor = async () => JSON.stringify({ success: true });

      for await (const event of query({
        messages,
        tools: TOOLS,
        toolExecutor,
        llm: mockLLM,
        costTracker,
      })) {
        if (event.type === 'complete') {
          // After complete, costTracker should have recorded usage
        }
      }

      const stats = costTracker.getStats();
      expect(stats.recordCount).toBe(1);
      expect(stats.totalTokens).toBe(120); // 100 + 20
    });
  });
});
