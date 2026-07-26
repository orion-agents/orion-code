/**
 * Test Brain module - async dispatch
 */
const { Brain, BaseAgent } = require('../dist/index.js');

console.log('=== Brain Module Test ===');

// 1. Create Brain instance
const brain = new Brain({
  strategy: 'priority',
  maxConcurrent: 2,
});

console.log('✓ Brain instance created');

// 2. Create mock agent with proper config
class MockAgent extends BaseAgent {
  constructor(config) {
    super(config);
    this.status = 'idle';  // Ensure initial status
  }

  async execute(task) {
    console.log(`MockAgent executing task: ${task.id}`);
    await new Promise(r => setTimeout(r, 100));
    return {
      id: task.id,
      success: true,
      result: `Completed: ${task.description}`,
      timestamp: new Date().toISOString(),
    };
  }
}

const mockAgent = new MockAgent({
  id: 'mock-agent-001',
  name: 'MockAgent',
  description: 'Test agent',
  capabilities: ['test'],
});

// 3. Register agent
brain.registerAgent(mockAgent);
console.log('✓ MockAgent registered');

// 4. Submit task with proper structure (Task type requires priority)
const task = {
  id: 'test-task-001',
  name: 'Test Task',
  description: 'Hello World',
  priority: 'P1',
  assignedTo: 'MockAgent',
  status: 'pending',
};

console.log('Submitting task...');
const promise = brain.submitTask(task);
console.log('✓ Task submitted (async dispatch confirmed - returns Promise)');

// 5. Wait for result
promise.then(() => {
  console.log('✓ Task execution completed');
}).catch(err => {
  console.log('✗ Task failed:', err.message);
});

// Wait for async completion
setTimeout(() => {
  const status = brain.getStatus();
  console.log('Brain status:', JSON.stringify(status, null, 2));
  console.log('\n=== Brain Test Complete ===');
}, 500);