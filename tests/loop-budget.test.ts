import { DEFAULT_LOOP_BUDGET } from '../src/framework';
import { resolveRuntimeLoopBudget } from '../src/runtime/loop-budget';

describe('runtime loop budget', () => {
  it('keeps the conservative default for simple chat', () => {
    expect(resolveRuntimeLoopBudget('hello', {})).toMatchObject({
      maxLlmRequestsPerUserTurn: DEFAULT_LOOP_BUDGET.maxLlmRequestsPerUserTurn,
      maxToolCallsPerUserTurn: DEFAULT_LOOP_BUDGET.maxToolCallsPerUserTurn,
      profile: 'default',
      baseProfile: 'default',
      configOverride: false,
    });
  });

  it('raises budget for complex Chinese coding tasks', () => {
    expect(resolveRuntimeLoopBudget('完成本次开发，修复所有测试问题', {})).toMatchObject({
      maxLlmRequestsPerUserTurn: 48,
      maxToolCallsPerUserTurn: 180,
      maxModelVisibleToolBytes: 96 * 1024,
      profile: 'complex',
      baseProfile: 'complex',
    });
  });

  it('treats explicit large or multi-step tasks as complex work', () => {
    for (const input of [
      '这是一个大的任务，继续做完整优化',
      '长任务：检查并修复项目',
      '多步骤完成这个能力',
      '按计划执行完整开发',
      '继续',
      'large task: continue implementation',
    ]) {
      expect(resolveRuntimeLoopBudget(input, {})).toMatchObject({
        maxLlmRequestsPerUserTurn: 48,
        maxToolCallsPerUserTurn: 180,
      });
    }
  });

  it('inherits complex task budget from restored harness context for continuation inputs', () => {
    expect(resolveRuntimeLoopBudget('继续', {}, {
      rootObjective: '完成一个大的任务：多步骤修复 agent-loop、harness、session 并验证',
      activeInstruction: '接着执行当前计划',
    })).toMatchObject({
      maxLlmRequestsPerUserTurn: 48,
      maxToolCallsPerUserTurn: 180,
    });
  });

  it('raises budget further for release tasks', () => {
    expect(resolveRuntimeLoopBudget('push, PR, npm publish', {})).toMatchObject({
      maxLlmRequestsPerUserTurn: 64,
      maxToolCallsPerUserTurn: 240,
      maxModelVisibleToolBytes: 128 * 1024,
      profile: 'release',
      baseProfile: 'release',
    });
  });

  it('lets config override adaptive defaults', () => {
    expect(resolveRuntimeLoopBudget('push, PR, npm publish', {
      agentLoop: {
        budget: {
          maxLlmRequestsPerUserTurn: 96,
          maxToolCallsPerUserTurn: 360,
        },
      },
    })).toMatchObject({
      maxLlmRequestsPerUserTurn: 96,
      maxToolCallsPerUserTurn: 360,
      profile: 'config',
      baseProfile: 'release',
      configOverride: true,
    });
  });
});
