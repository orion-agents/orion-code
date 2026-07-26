import { createSubtaskTool, coerceSubtaskRequest, summarizeBatchForModel } from '../src/runtime/subagents/tool';
import { SubagentBudgetLedger, budgetLimitsFromConfig } from '../src/runtime/subagents/budget';
import { SubagentProviderGate } from '../src/runtime/subagents/provider-gate';
import type { ExecuteChildQuery, ChildToolSet } from '../src/runtime/subagents/runner';
import type { SubagentSupervisorDeps } from '../src/runtime/subagents/supervisor';
import { DEFAULT_SUBAGENT_CONFIG } from '../src/runtime/subagents/types';

const TOOL_SET: ChildToolSet = { tools: [], toolExecutor: async () => '' };

function makeSupervisorDeps(executeQuery: ExecuteChildQuery): SubagentSupervisorDeps {
  const config = { ...DEFAULT_SUBAGENT_CONFIG };
  return {
    config,
    cwd: '/tmp/project',
    budget: new SubagentBudgetLedger(budgetLimitsFromConfig({
      maxModelRequestsPerTurn: config.maxModelRequestsPerTurn,
      maxModelRequestsPerTask: config.maxModelRequestsPerTask,
      maxToolCallsPerTask: config.maxToolCallsPerTask,
      timeoutMs: config.timeoutMs,
    })),
    providerGate: new SubagentProviderGate({ maxConcurrent: config.maxParallel }),
    executeQuery,
    toolSet: TOOL_SET,
  };
}

describe('subtask tool', () => {
  describe('coerceSubtaskRequest', () => {
    it('coerces a well-formed request', () => {
      const req = coerceSubtaskRequest({
        tasks: [
          { role: 'research', objective: 'Investigate the runtime module', reason: 'independent' },
          { role: 'review', objective: 'Review the diff', reason: 'independent' },
        ],
        execution: 'serial',
      });
      expect(req).not.toBeNull();
      expect(req!.tasks).toHaveLength(2);
      expect(req!.execution).toBe('serial');
    });

    it('defaults execution to parallel', () => {
      const req = coerceSubtaskRequest({ tasks: [{ role: 'research', objective: 'x', reason: 'y' }] });
      expect(req!.execution).toBe('parallel');
    });

    it('drops caller-provided id (runtime owns ids)', () => {
      const req = coerceSubtaskRequest({ tasks: [{ id: 'hacker', role: 'research', objective: 'x', reason: 'y' }] });
      expect(req!.tasks[0].id).toBeUndefined();
    });

    it('rejects unknown roles', () => {
      expect(coerceSubtaskRequest({ tasks: [{ role: 'coder', objective: 'x', reason: 'y' }] })).toBeNull();
    });

    it('rejects missing objective or reason', () => {
      expect(coerceSubtaskRequest({ tasks: [{ role: 'research', objective: '', reason: 'y' }] })).toBeNull();
      expect(coerceSubtaskRequest({ tasks: [{ role: 'research', objective: 'x', reason: '' }] })).toBeNull();
    });

    it('rejects non-array tasks', () => {
      expect(coerceSubtaskRequest({ tasks: 'nope' })).toBeNull();
      expect(coerceSubtaskRequest({})).toBeNull();
    });

    it('preserves scope and hints', () => {
      const req = coerceSubtaskRequest({
        tasks: [{
          role: 'research', objective: 'x', reason: 'y',
          scope: { paths: ['src/a.ts'], symbols: ['foo'] },
          contextHints: ['hint one'],
          expectedOutput: 'a list',
        }],
      });
      expect(req!.tasks[0].scope).toEqual({ paths: ['src/a.ts'], symbols: ['foo'] });
      expect(req!.tasks[0].contextHints).toEqual(['hint one']);
      expect(req!.tasks[0].expectedOutput).toBe('a list');
    });
  });

  describe('createSubtaskTool', () => {
    it('is a read-only, non-concurrent tool named subtask', () => {
      const tool = createSubtaskTool(makeSupervisorDeps(async () => ({ content: '{}', usage: { modelRequests: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, durationMs: 0 } })));
      expect(tool.name).toBe('subtask');
      expect(tool.isReadOnly?.({})).toBe(true);
      expect(tool.isConcurrencySafe?.({})).toBe(false);
      expect(tool.isDestructive?.({})).toBe(false);
      expect(tool.checkPermissions?.({}, { cwd: '/tmp', config: {} as never })).toMatchObject({ behavior: 'allow' });
    });

    it('returns a structured batch result on success', async () => {
      const executeQuery: ExecuteChildQuery = async () => ({
        content: JSON.stringify({ summary: 'Found 2 handlers', findings: [{ title: 'f', evidence: 'e' }] }),
        usage: { modelRequests: 2, toolCalls: 1, promptTokens: 0, completionTokens: 0, durationMs: 100 },
      });
      // R9: use two research packets so auto-mode eligibility gate is satisfied.
      const tool = createSubtaskTool(makeSupervisorDeps(executeQuery));
      const result = await tool.execute(
        { tasks: [
          { role: 'research', objective: 'Investigate the runtime module cancel paths', reason: 'independent' },
          { role: 'research', objective: 'Investigate the session module cancel paths', reason: 'independent' },
        ] },
        { cwd: '/tmp/project', config: {} as never },
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.results).toHaveLength(2);
      expect(parsed.results[0].status).toBe('completed');
      expect(parsed.results[0].summary).toBe('Found 2 handlers');
      expect(result.summary).toMatch(/subtask batch/);
    });

    it('returns failure when the request is invalid', async () => {
      const tool = createSubtaskTool(makeSupervisorDeps(async () => ({ content: '{}', usage: { modelRequests: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, durationMs: 0 } })));
      const result = await tool.execute({ tasks: 'nope' }, { cwd: '/tmp', config: {} as never });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid subtask request/);
    });

    it('marks a rejected batch (mode off) as not successful', async () => {
      const deps = makeSupervisorDeps(async () => ({ content: '{}', usage: { modelRequests: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, durationMs: 0 } }));
      deps.config.mode = 'off';
      const tool = createSubtaskTool(deps);
      const result = await tool.execute(
        { tasks: [{ role: 'research', objective: 'Investigate the runtime module', reason: 'independent' }] },
        { cwd: '/tmp', config: {} as never },
      );
      expect(result.success).toBe(false);
      expect(result.metadata).toMatchObject({ rejected: true, rejectReason: 'mode_off' });
    });
  });

  describe('summarizeBatchForModel', () => {
    it('produces a compact one-line-per-result summary', () => {
      const summary = summarizeBatchForModel({
        batchId: 'batch-1',
        results: [
          { role: 'research', status: 'completed', summary: 'ok', findings: [{}, {}], risks: [] },
          { role: 'review', status: 'failed', summary: 'boom', findings: [], risks: ['r'] },
        ],
        aggregateUsage: { modelRequests: 4, toolCalls: 2, durationMs: 500 },
      });
      expect(summary).toMatch(/batch-1/);
      expect(summary).toMatch(/research\/completed/);
      expect(summary).toMatch(/findings=2/);
      expect(summary).toMatch(/review\/failed/);
      expect(summary).toMatch(/risks=1/);
      expect(summary).toMatch(/modelRequests=4/);
    });
  });
});
