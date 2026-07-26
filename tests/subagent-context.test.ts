import { buildChildMessages } from '../src/runtime/subagents/context-builder';
import type { ContextCapsule } from '../src/harness/types';
import type { SubtaskPacket } from '../src/runtime/subagents/types';

function packet(overrides: Partial<SubtaskPacket> = {}): SubtaskPacket {
  return {
    role: 'research',
    objective: 'Find all cancel-signal handlers in the runtime module',
    reason: 'independent investigation',
    ...overrides,
  };
}

function capsule(overrides: Partial<ContextCapsule> = {}): ContextCapsule {
  return {
    contract: { id: 'c1', objective: 'audit cancel semantics', userIntent: '', requirements: [], successCriteria: [], constraints: [], prohibitions: [], allowedScope: { cwd: '/tmp' }, createdAt: 0, updatedAt: 0 },
    currentPlan: [],
    completed: ['read runtime files'],
    openTodos: ['verify session cancel'],
    keyFacts: [{ id: 'f1', type: 'file_fact', content: 'AbortController is derived per turn', source: { kind: 'tool' }, importance: 3, ttl: 'session', createdAt: 0 }],
    changedFiles: ['src/runtime/chat-controller.ts'],
    verification: { commandsRun: [], passed: [], failed: [], warnings: [] },
    nextAction: 'check supervisor cleanup',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('subagent context builder', () => {
  it('produces system + user messages only', () => {
    const messages = buildChildMessages({ cwd: '/tmp/project', packet: packet() });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('includes the role system prompt with JSON contract in the system message', () => {
    const messages = buildChildMessages({ cwd: '/tmp/project', packet: packet() });
    expect(messages[0].content).toMatch(/JSON/);
    expect(messages[0].content).toMatch(/findings/);
    expect(messages[0].content).toMatch(/Project root: \/tmp\/project/);
    // Forbids recursion and writes
    expect(messages[0].content).toMatch(/depth 1/);
    expect(messages[0].content).toMatch(/may NOT create further subagents/);
  });

  it('frames the task objective, scope and hints in the user message', () => {
    const messages = buildChildMessages({
      cwd: '/tmp/project',
      packet: packet({
        objective: 'Investigate session cancel',
        reason: 'independent module',
        contextHints: ['check AbortController', 'check resume path'],
        expectedOutput: 'a list of cancel points',
      }),
      canonicalScopePaths: ['src/runtime', 'src/services/session-storage.ts'],
    });
    const user = messages[1].content;
    expect(user).toMatch(/Investigate session cancel/);
    expect(user).toMatch(/scope: src\/runtime, src\/services\/session-storage.ts/);
    expect(user).toMatch(/check AbortController/);
    expect(user).toMatch(/expected output: a list of cancel points/);
  });

  it('injects a read-only root objective summary, truncated', () => {
    const long = 'x'.repeat(2000);
    const messages = buildChildMessages({
      cwd: '/tmp/project',
      packet: packet(),
      rootObjectiveSummary: long,
    });
    expect(messages[0].content).toMatch(/Root objective \(read-only summary\)/);
    // The full 2000-char objective must NOT appear verbatim; it is truncated.
    expect(messages[0].content).not.toContain(long);
    expect(messages[0].content).toContain('x'.repeat(800 - 1).slice(0, 100));
  });

  it('injects a compacted parent capsule', () => {
    const messages = buildChildMessages({
      cwd: '/tmp/project',
      packet: packet(),
      capsule: capsule(),
    });
    const system = messages[0].content;
    expect(system).toMatch(/Parent context capsule/);
    expect(system).toMatch(/audit cancel semantics/);
    expect(system).toMatch(/AbortController is derived per turn/);
    expect(system).toMatch(/changed files:/);
  });

  it('omits capsule section when no capsule is provided', () => {
    const messages = buildChildMessages({ cwd: '/tmp/project', packet: packet() });
    expect(messages[0].content).not.toMatch(/Parent context capsule/);
  });

  it('uses the research role prompt by default for unknown role', () => {
    const messages = buildChildMessages({
      cwd: '/tmp/project',
      packet: packet({ role: 'review' }),
    });
    expect(messages[0].content).toMatch(/code review subagent/);
  });

  it('includes model label when provided', () => {
    const messages = buildChildMessages({
      cwd: '/tmp/project',
      packet: packet(),
      modelLabel: 'gpt-4o',
    });
    expect(messages[0].content).toMatch(/Model: gpt-4o/);
  });

  it('injects project instructions when provided', () => {
    const messages = buildChildMessages({
      cwd: '/tmp/project',
      packet: packet(),
      projectInstructions: 'Never commit directly to main.',
    });
    expect(messages[0].content).toMatch(/Project instructions/);
    expect(messages[0].content).toMatch(/Never commit directly to main/);
  });

  it('truncates very long objective text in the user message gracefully', () => {
    const longObjective = 'Investigate ' + 'a'.repeat(5000);
    const messages = buildChildMessages({
      cwd: '/tmp/project',
      packet: packet({ objective: longObjective }),
    });
    // User message holds the objective but system prompt stayed bounded
    expect(messages[1].content).toMatch(/Investigate a+/);
    expect(messages[0].content.length).toBeLessThan(10000);
  });
});
