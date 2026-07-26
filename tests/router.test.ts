import { classifyTask, getAgentRouter } from '../src/agents/router';
import type { Task } from '../src/core/agent';

describe('classifyTask', () => {
  test('classifies coding task', () => {
    const result = classifyTask('Implement a function', 'Write a new function');
    expect(result.category).toBe('coding');
    expect(result.confidence).toBeGreaterThan(0);
  });

  test('classifies review task', () => {
    const result = classifyTask('Review the code', 'Check for bugs');
    expect(result.category).toBe('review');
  });

  test('classifies testing task', () => {
    const result = classifyTask('Write tests', 'Add unit tests');
    expect(result.category).toBe('testing');
  });

  test('classifies security task', () => {
    const result = classifyTask('Security check', 'Scan for vulnerabilities');
    expect(result.category).toBe('security');
  });

  test('classifies research task', () => {
    const result = classifyTask('Search for', 'Find the documentation');
    expect(result.category).toBe('research');
  });

  test('returns default for unknown task', () => {
    const result = classifyTask('something random');
    expect(result.category).toBeDefined();
  });
});

describe('AgentRouter', () => {
  test('creates router', () => {
    const router = getAgentRouter();
    expect(router).toBeDefined();
  });

  test('router has default agents', () => {
    const router = getAgentRouter();
    const agents = router.getAgents();
    expect(agents.length).toBeGreaterThan(0);
    expect(router.hasAgent('coder')).toBe(true);
    expect(router.hasAgent('leader')).toBe(true);
  });

  test('router routes task', () => {
    const router = getAgentRouter();
    const task: Task = {
      id: 'test-1',
      name: 'Implement a function',
      description: 'Write code',
      priority: 'P0',
      assignedTo: '',
      status: 'pending',
    };

    const result = router.route(task);
    expect(result.agentId).toBe('coder');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reason).toBeDefined();
  });

  test('router routes review task to reviewer', () => {
    const router = getAgentRouter();
    const task: Task = {
      id: 'test-2',
      name: 'Review the code',
      description: 'Check for bugs',
      priority: 'P0',
      assignedTo: '',
      status: 'pending',
    };

    const result = router.route(task);
    expect(result.agentId).toBe('reviewer');
  });

  test('router routes test task to tester', () => {
    const router = getAgentRouter();
    const task: Task = {
      id: 'test-3',
      name: 'Write tests',
      description: 'Add unit tests',
      priority: 'P0',
      assignedTo: '',
      status: 'pending',
    };

    const result = router.route(task);
    expect(result.agentId).toBe('tester');
  });

  test('router returns agents for category', () => {
    const router = getAgentRouter();
    const agents = router.getAgentsForCategory('coding');
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.some(a => a.id === 'coder')).toBe(true);
  });

  test('router registers custom agent', () => {
    const router = getAgentRouter();
    router.registerAgent({
      id: 'custom',
      name: 'Custom Agent',
      keywords: ['custom'],
      patterns: [],
      priority: 50,
      maxConcurrent: 1,
    });

    expect(router.hasAgent('custom')).toBe(true);
    expect(router.getAgent('custom')?.name).toBe('Custom Agent');
  });
});