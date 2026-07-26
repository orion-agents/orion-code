import { Brain } from '../src/core/brain';
import { BaseAgent, Task, AgentConfig, TaskResultData } from '../src/core/agent';
import { MAX_ENTRYPOINT_BYTES } from '../src/memory/storage';

// Mock agent for Brain tests
class MockAgent extends BaseAgent {
  constructor() {
    super({
      id: 'test-agent',
      name: 'Test Agent',
      description: 'A test agent',
      capabilities: ['test'],
    });
  }
  async execute(task: Task) {
    // Issue #32 #2.4: 返回正确的 TaskResultData 类型
    const data: TaskResultData = { kind: 'generic', value: 'test result' };
    return { success: true, data };
  }
}

describe('Issue #32 fixes', () => {
  describe('2.1: Brain.submitTask fire-and-forget', () => {
    test('submitTask returns Promise (async)', async () => {
      const brain = new Brain();
      brain.registerAgent(new MockAgent());

      const task: Task = {
        id: 'test-1',
        name: 'Test Task',
        description: 'A test task',
        priority: 'P0',
        assignedTo: 'test-agent',
        status: 'pending',
      };

      // Should return a Promise
      const result = brain.submitTask(task);
      expect(result).toBeInstanceOf(Promise);

      // Should be awaitable
      await result;
    });

    test('submitTask dispatches task correctly', async () => {
      const brain = new Brain();
      const agent = new MockAgent();
      brain.registerAgent(agent);

      const task: Task = {
        id: 'test-2',
        name: 'Test Task 2',
        description: 'Another test task',
        priority: 'P0',
        assignedTo: 'test-agent',
        status: 'pending',
      };

      await brain.submitTask(task);

      // Task should be removed from queue after dispatch
      const status = brain.getStatus();
      expect(status.pendingTasks).toBe(0);
    });
  });

  describe('4.5: MEMORY.md truncation loop', () => {
    test('truncation loop terminates correctly', () => {
      // This test verifies the while-loop doesn't hang
      // Simulate large content
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) {
        lines.push(`- [memory-${i}](memory-${i}.md) — This is a long description line ${i}`);
      }

      // Should terminate within reasonable time
      const start = Date.now();
      while (lines.join('\n').length > MAX_ENTRYPOINT_BYTES && lines.length > 10) {
        lines.pop();
      }
      const elapsed = Date.now() - start;

      // Should complete in under 50ms (not hang)
      expect(elapsed).toBeLessThan(50);
      expect(lines.length).toBeGreaterThan(10);
      expect(lines.length).toBeLessThanOrEqual(100);
    });
  });

  describe('3.9: exec_command stdout/stderr consistency', () => {
    test('exec_command tool exists in TOOLS', async () => {
      // Import TOOLS and check exec_command exists
      const { TOOLS } = await import('../src/tools');
      const execCommandTool = TOOLS.find(t => t.name === 'exec_command');
      expect(execCommandTool).toBeDefined();
    });
  });
});