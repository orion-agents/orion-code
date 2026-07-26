import { buildHarnessContext, classifyIntent, createContextHarness, createTurnSummary, rankEvidence } from '../src/harness';
import type { EvidenceRecord } from '../src';

describe('Context Harness v2 intent and assembly', () => {
  test('classifies new tasks, refinements, verification, and short feedback', () => {
    expect(classifyIntent('基于当前版本切 v0.1.23 分支，精进 harness').kind).toBe('new_task');
    expect(classifyIntent('继续').kind).toBe('continue_current_task');
    expect(classifyIntent('不对吧').kind).toBe('casual_or_feedback');
    expect(classifyIntent('跑一下 npm test 验证').kind).toBe('verify_or_test');
    expect(classifyIntent('mcp.json 的内容 agent 可以自主调整吧？').kind).toBe('meta_configuration');
  });

  test('keeps root objective stable across short refinements and corrections', () => {
    const harness = createContextHarness({ cwd: '/repo', modelId: 'gpt-4o' });

    harness.updateContractFromUserInput('实现 v0.1.23 Context Harness 完整计划');
    const first = harness.toJSON();
    expect(first.rootObjective).toContain('实现 v0.1.23');
    expect(first.taskEpoch).toBe(1);

    harness.updateContractFromUserInput('灰色填充');
    harness.updateContractFromUserInput('不对吧');
    harness.updateContractFromUserInput('继续');
    const afterRefine = harness.toJSON();
    expect(afterRefine.rootObjective).toBe(first.rootObjective);
    expect(afterRefine.contract?.objective).toBe(first.contract?.objective);
    expect(afterRefine.taskEpoch).toBe(1);

    harness.updateContractFromUserInput('PLEASE IMPLEMENT THIS PLAN: 新任务');
    const afterNewTask = harness.toJSON();
    expect(afterNewTask.rootObjective).toContain('PLEASE IMPLEMENT THIS PLAN');
    expect(afterNewTask.taskEpoch).toBe(2);
  });

  test('keeps root objective stable through realistic long-session feedback', () => {
    const harness = createContextHarness({ cwd: '/repo/openhorse', modelId: 'bailian/qwen3.7-plus' });

    harness.updateContractFromUserInput('v0.2.11 聚焦稳定 agent runtime、tools、harness、session 和 terminal UI');
    const initial = harness.toJSON();

    for (const input of [
      '继续',
      '挺好的',
      '不对吧',
      '先验证后继续',
      '检查一下当前变更',
      '这个版本主要稳定 terminal UI',
    ]) {
      harness.updateContractFromUserInput(input);
    }

    const state = harness.toJSON();
    expect(state.rootObjective).toBe(initial.rootObjective);
    expect(state.contract?.objective).toBe(initial.contract?.objective);
    expect(state.taskEpoch).toBe(1);
    expect(state.activeInstruction).toContain('这个版本主要稳定 terminal UI');
    expect((state.intentHistory ?? []).map(intent => intent.kind)).toEqual(expect.arrayContaining([
      'continue_current_task',
      'casual_or_feedback',
      'verify_or_test',
    ]));
  });

  test('ranks evidence by keyword, verification, path, and recency', () => {
    const now = Date.now();
    const records: EvidenceRecord[] = [
      {
        id: 'old',
        kind: 'decision',
        content: 'unrelated old design note',
        source: 'ledger',
        importance: 2,
        createdAt: now - 10_000_000,
        tokenEstimate: 8,
        tags: ['unrelated'],
      },
      {
        id: 'verify',
        kind: 'verification',
        content: 'npm test passed for src/harness/context-harness.ts',
        source: 'ledger',
        importance: 5,
        createdAt: now,
        tokenEstimate: 12,
        tags: ['npm', 'test', 'src/harness/context-harness.ts'],
        path: 'src/harness/context-harness.ts',
        verificationStatus: 'passed',
      },
    ];

    const ranked = rankEvidence(records, {
      query: '继续修复 src/harness/context-harness.ts 并验证 npm test',
      now,
    });

    expect(ranked[0].id).toBe('verify');
    expect(ranked[0].reasons.join(' ')).toContain('verification');
  });

  test('assembler preserves core objective under tiny budgets and reports stats', () => {
    const harness = createContextHarness({
      cwd: '/repo',
      modelId: 'gpt-4o',
      config: { evidenceBudgetRatio: 0.01 },
    });
    harness.updateContractFromUserInput('实现长会话 harness，必须保留 root objective');
    for (let i = 0; i < 30; i++) {
      harness.recordToolResult({
        name: 'bash',
        args: { command: `npm test -- test-${i}` },
        result: JSON.stringify({ success: true, output: `passed ${i}` }),
        duration: 1,
        success: true,
      });
    }

    const built = buildHarnessContext(harness.toJSON(), 'gpt-4o', { evidenceBudgetRatio: 0.01 }, { input: '继续验证 harness' });
    expect(built.text).toContain('Orion Code Context Harness v2');
    expect(built.text).toContain('实现长会话 harness');
    expect(built.stats.budgetTokens).toBeGreaterThan(0);
    expect(built.stats.includedEvidence.length).toBeGreaterThan(0);
    expect(built.stats.omittedEvidence.length).toBeGreaterThan(0);
  });

  test('turn summary extracts tools, files, verification, and unresolved failures', () => {
    const summary = createTurnSummary({
      turn: 1,
      taskEpoch: 1,
      intent: classifyIntent('编辑 src/harness/types.ts 并运行测试'),
      userInput: '编辑 src/harness/types.ts 并运行测试',
      assistantContent: 'Updated types. One test failed and needs verification.',
      sessionMessages: [
        {
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          tool_calls: [
            { id: 'call-1', type: 'function', function: { name: 'edit_file', arguments: '{"path":"src/harness/types.ts"}' } },
            { id: 'call-2', type: 'function', function: { name: 'bash', arguments: '{"command":"npm test -- --runInBand"}' } },
          ],
        } as any,
        {
          role: 'tool',
          content: JSON.stringify({ success: false, error: 'failed' }),
          timestamp: Date.now(),
          tool_call_id: 'call-2',
        } as any,
      ],
    });

    expect(summary.toolsUsed).toEqual(expect.arrayContaining(['edit_file', 'bash']));
    expect(summary.filesTouched).toContain('src/harness/types.ts');
    expect(summary.verification.commandsRun).toContain('npm test -- --runInBand');
    expect(summary.verification.failed.length).toBe(1);
    expect(summary.unresolved.length).toBeGreaterThan(0);
  });
});
