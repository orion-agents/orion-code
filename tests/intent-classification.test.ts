/**
 * Intent Classification v0.2.7 unit tests
 */

import { classifyIntent } from '../src/harness/intent';
import type { HarnessState } from '../src/harness/types';

function makeState(overrides: Partial<HarnessState> = {}): HarnessState {
  return {
    version: 2,
    ledger: [],
    capsule: {
      currentPlan: [],
      completed: [],
      openTodos: [],
      keyFacts: [],
      changedFiles: [],
      verification: { commandsRun: [], passed: [], failed: [], warnings: [] },
      nextAction: 'continue',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    completionBlockCount: 0,
    taskEpoch: 1,
    rootObjective: 'Build a web app',
    activeInstruction: 'Build a web app',
    intentHistory: [],
    activeConstraints: [],
    nonGoals: [],
    openQuestions: [],
    evidenceIndex: [],
    turnSummaries: [],
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('intent v0.2.7', () => {
  describe('clarification intent', () => {
    const state = makeState();

    test('detects Chinese clarification questions', () => {
      const result = classifyIntent('这是什么意思？', state);
      expect(result.kind).toBe('clarification');
      expect(result.confidence).toBeGreaterThan(0.6);
    });

    test('detects English explanation requests', () => {
      const result = classifyIntent('Can you explain what this does?', state);
      expect(result.kind).toBe('clarification');
      expect(result.confidence).toBeGreaterThan(0.6);
    });

    test('detects "explain" patterns', () => {
      const result = classifyIntent('解释一下这个方案', state);
      expect(result.kind).toBe('clarification');
    });

    test('detects "what is" English questions', () => {
      const result = classifyIntent('What is the purpose of this?', state);
      expect(result.kind).toBe('clarification');
    });

    test('does not confuse clarification with new_task', () => {
      const result = classifyIntent('帮我创建一个新的项目', state);
      expect(result.kind).not.toBe('clarification');
    });
  });

  describe('refinement vs correction', () => {
    const state = makeState();

    test('detects refinement ("补充", "另外")', () => {
      const result = classifyIntent('另外再加一个功能', state);
      expect(result.kind).toBe('refine_current_task');
    });

    test('detects correction ("不对", "错了")', () => {
      const result = classifyIntent('不对，应该是这样改', state);
      expect(result.kind).toBe('interrupt_and_replace_current_step');
    });

    test('detects correction ("改成", "换成")', () => {
      const result = classifyIntent('换成另一种方式实现', state);
      expect(result.kind).toBe('interrupt_and_replace_current_step');
    });

    test('detects meta_configuration', () => {
      const result = classifyIntent('切换到 qwen 配置', state);
      expect(result.kind).toBe('meta_configuration');
    });
  });

  describe('shouldReplaceActiveInstruction', () => {
    const { shouldReplaceActiveInstruction } = require('../src/harness/intent');

    test('clarification does not replace active instruction', () => {
      const intent = classifyIntent('这是什么意思？', makeState());
      expect(shouldReplaceActiveInstruction(intent)).toBe(false);
    });

    test('new_task replaces active instruction', () => {
      const intent = classifyIntent('帮我创建一个新的 web 应用', makeState());
      expect(shouldReplaceActiveInstruction(intent)).toBe(true);
    });

    test('continue does not replace active instruction', () => {
      const intent = classifyIntent('继续', makeState());
      expect(shouldReplaceActiveInstruction(intent)).toBe(false);
    });
  });

  describe('existing intents still work', () => {
    const state = makeState();

    test('new_task with explicit implementation wording', () => {
      const result = classifyIntent('按这个计划开始开发', state);
      expect(result.kind).toBe('new_task');
    });

    test('verify_or_test', () => {
      const result = classifyIntent('跑一下测试', state);
      expect(result.kind).toBe('verify_or_test');
    });

    test('continue_current_task', () => {
      const result = classifyIntent('继续', state);
      expect(result.kind).toBe('continue_current_task');
    });

    test('casual_or_feedback for short feedback', () => {
      const result = classifyIntent('好的', state);
      expect(result.kind).toBe('casual_or_feedback');
    });
  });
});
