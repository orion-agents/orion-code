import { PrintEventSink } from '../src/print-ui/launch';
import { TerminalEventSink, type TerminalWriter } from '../src/terminal-ui/launch';
import type { LoopStats } from '../src/framework';
import type { OrionCodeUiRuntime, TranscriptAppendEntry } from '../src/runtime/ui-events';
import {
  budgetStopLocaleForInput,
  createLoopBudgetStopView,
  formatLoopBudgetStopView,
} from '../src/runtime/ui-view-model';
import { layoutTranscriptEntry } from '../src/tui-ui/transcript-layout';

function stats(overrides: Partial<LoopStats> = {}): LoopStats {
  return {
    turnsStarted: 8,
    llmRequests: 8,
    toolCalls: 7,
    readOnlyToolCalls: 7,
    unsafeToolCalls: 0,
    toolResultBytes: 4096,
    modelVisibleToolBytes: 2048,
    summarizedBytes: 2048,
    finishReason: 'budget_exceeded',
    budgetExceededReason: 'LLM request budget 8 reached',
    loopBudgetSource: 'config',
    loopBudgetMaxLlmRequests: 8,
    loopBudgetMaxToolCalls: 120,
    continuationActions: [
      'reply_continue',
      'narrow_instruction',
      'inspect_loop_stats',
      'raise_budget',
    ],
    lastToolName: 'read_file',
    lastToolSummary: 'read src/index.ts',
    lastToolSuccess: true,
    singleReadOnlyStreak: 1,
    batchReadSuggestionCount: 0,
    localFastPathUsed: false,
    ...overrides,
  };
}

function transcriptText(entry: TranscriptAppendEntry): string {
  return layoutTranscriptEntry(entry, { width: 64 })
    .map(row => row.map(span => span.text).join(''))
    .join('\n');
}

describe('actionable loop-budget stop view', () => {
  it('projects counters, stop point, recovery state, and all actions', () => {
    const view = createLoopBudgetStopView(stats());

    expect(view).toMatchObject({
      schemaVersion: 1,
      kind: 'llm_request_limit',
      recoverable: true,
      statePreserved: true,
      llmRequests: { current: 8, maximum: 8 },
      toolCalls: { current: 7, maximum: 120 },
      stopPoint: { tool: 'read_file', summary: 'read src/index.ts', success: true },
    });
    expect(view.actions).toEqual([
      'reply_continue',
      'narrow_instruction',
      'inspect_loop_stats',
      'raise_budget',
    ]);
  });

  it('renders plain-language English and Chinese recovery instructions', () => {
    const view = createLoopBudgetStopView(stats());
    const english = formatLoopBudgetStopView(view, 'en');
    const chinese = formatLoopBudgetStopView(view, 'zh-CN');

    expect(english).toContain('recoverable, not a task failure');
    expect(english).toContain('8/8 model requests');
    expect(english).toContain('Stopped after: read_file');
    expect(english).toContain('Reply `继续`');
    expect(english).toContain('/loop-stats');
    expect(english).toContain('agentLoop.budget');
    expect(chinese).toContain('这不是任务失败');
    expect(chinese).toContain('停止位置：read_file');
    expect(chinese).toContain('回复 `继续`');
    expect(budgetStopLocaleForInput('please continue')).toBe('en');
    expect(budgetStopLocaleForInput('继续完成任务')).toBe('zh-CN');
  });

  it('sanitizes the stop point before any renderer receives it', () => {
    const view = createLoopBudgetStopView(
      stats({ lastToolName: 'read_file\x1b[2J', lastToolSummary: 'done\x1b]0;owned\x07' })
    );

    expect(JSON.stringify(view)).not.toContain('\x1b');
    expect(JSON.stringify(view)).not.toContain('\x07');
  });

  it('keeps the same structured card and visible actions in TUI, terminal, and JSON print', () => {
    const view = createLoopBudgetStopView(stats());
    const content = formatLoopBudgetStopView(view, 'en');
    const entry: TranscriptAppendEntry = {
      role: 'status',
      title: 'budget',
      statusTone: 'warning',
      content,
      budgetStop: view,
    };

    const tui = transcriptText(entry);
    expect(tui).toContain('⏸');
    expect(tui).toContain('Reply `继续`');
    expect(tui).toContain('/loop-stats');

    const writes: string[] = [];
    const writer: TerminalWriter = { write: text => writes.push(text) };
    const terminal = new TerminalEventSink({} as OrionCodeUiRuntime, writer);
    terminal.append(entry);
    expect(writes.join('')).toContain('⏸');
    expect(writes.join('')).toContain('Reply `继续`');

    const runtime = {
      getSession: () => null,
      store: { getSnapshot: () => ({ currentModel: 'test-model' }) },
      config: { model: 'test-model' },
    } as unknown as OrionCodeUiRuntime;
    const print = new PrintEventSink(runtime, 'json');
    print.append(entry);
    const result = print.result();
    expect(result.budgetStops).toEqual([view]);
    expect(JSON.parse(JSON.stringify(result)).budgetStops[0]).toEqual(view);
  });
});
