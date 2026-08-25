import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SubagentBudgetLedger, budgetLimitsFromConfig } from '../src/runtime/subagents/budget';
import { SubagentProviderGate } from '../src/runtime/subagents/provider-gate';
import type {
  ProductionSubagentExecutionPortV1,
  ProductionSubagentExecutionRequestV1,
} from '../src/runtime/subagents/runtime-contract';
import { runSubtaskBatch } from '../src/runtime/subagents/supervisor';
import { DEFAULT_SUBAGENT_CONFIG } from '../src/runtime/subagents/types';
import { createAuthoritySnapshotV1 } from '../src/runtime/step-snapshot';
import type { ParentThreadForkRequestV1 } from '../src/runtime/subagent-thread-runtime';

describe('SubagentSupervisor modern production port', () => {
  test('passes each fair reservation to the child runtime without a legacy query/tool set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-modern-supervisor-'));
    try {
      const scopes = [join(root, 'first'), join(root, 'second')];
      for (const scope of scopes) mkdirSync(scope, { recursive: true });
      const requests: ProductionSubagentExecutionRequestV1[] = [];
      const parentFork: ParentThreadForkRequestV1 = {
        store: {} as ParentThreadForkRequestV1['store'],
        threadId: '00000000-0000-4000-8000-000000000000',
        turnId: '00000000-0000-4000-8000-000000000001',
        stepId: '00000000-0000-4000-8000-000000000002',
        requestId: '00000000-0000-4000-8000-000000000003',
        stepSnapshotDigest: 'step-snapshot-digest',
        capabilityReceiptDigest: 'capability-receipt-digest',
        flush: () => undefined,
      };
      const resolveParentFork = jest.fn(() => parentFork);
      const executeChild: ProductionSubagentExecutionPortV1 = {
        serviceId: 'modern-child-test',
        close: () => undefined,
        execute: async request => {
          requests.push(request);
          return {
            parentCancelled: false,
            result: {
              id: request.taskId,
              role: request.packet.role,
              status: 'completed',
              summary: `done:${request.packet.objective}`,
              findings: [],
              files: [],
              commands: [],
              verification: [],
              risks: [],
              usage: {
                modelRequests: 1,
                toolCalls: 0,
                promptTokens: 5,
                completionTokens: 2,
                durationMs: 3,
                usageComplete: true,
              },
            },
          };
        },
      };
      const config = {
        ...DEFAULT_SUBAGENT_CONFIG,
        maxParallel: 2,
        maxTasksPerTurn: 2,
        maxModelRequestsPerTurn: 4,
        maxModelRequestsPerTask: 3,
        maxToolCallsPerTask: 5,
      };
      const outcome = await runSubtaskBatch(
        {
          execution: 'parallel',
          tasks: [
            {
              role: 'review',
              objective: 'first',
              reason: 'independent first',
              scope: { paths: [scopes[0]] },
            },
            {
              role: 'test-investigate',
              objective: 'second',
              reason: 'independent second',
              scope: { paths: [scopes[1]] },
            },
          ],
        },
        {
          config,
          cwd: root,
          budget: new SubagentBudgetLedger(
            budgetLimitsFromConfig({
              maxModelRequestsPerTurn: config.maxModelRequestsPerTurn,
              maxModelRequestsPerTask: config.maxModelRequestsPerTask,
              maxToolCallsPerTask: config.maxToolCallsPerTask,
              timeoutMs: config.timeoutMs,
            })
          ),
          providerGate: new SubagentProviderGate({ maxConcurrent: 2 }),
          executeChild,
          parentForkSource: {
            serviceId: 'test-parent-step-source',
            current: resolveParentFork,
            close: () => undefined,
          },
          parentAuthority: createAuthoritySnapshotV1({
            authorityId: 'parent',
            projectRoot: root,
            confirmation: 'allow',
            filesystem: 'workspace',
            network: 'deny',
          }),
          rootObjectiveSummary: 'Delegate two independent checks',
        }
      );

      expect(outcome.rejected).toBe(false);
      expect(outcome.result.results.map(result => result.status)).toEqual([
        'completed',
        'completed',
      ]);
      expect(requests).toHaveLength(2);
      expect(resolveParentFork).toHaveBeenCalledTimes(1);
      expect(requests.every(request => request.parent === parentFork)).toBe(true);
      expect(requests.map(request => request.budget)).toEqual([
        { maxModelRequests: 2, maxToolCalls: 5 },
        { maxModelRequests: 2, maxToolCalls: 5 },
      ]);
      expect(requests.every(request => request.parentAuthority.projectRoot === root)).toBe(true);
      expect(requests.map(request => request.canonicalScopePaths?.[0])).toEqual([
        'first',
        'second',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when the current model step has not published a fork anchor', async () => {
    const execute = jest.fn();
    const executeChild: ProductionSubagentExecutionPortV1 = {
      serviceId: 'modern-child-test',
      close: () => undefined,
      execute,
    };
    const outcome = await runSubtaskBatch(
      {
        execution: 'serial',
        tasks: [{ role: 'review', objective: 'must wait for capture', reason: 'anchor proof' }],
      },
      {
        config: DEFAULT_SUBAGENT_CONFIG,
        cwd: '/tmp/project',
        budget: new SubagentBudgetLedger(
          budgetLimitsFromConfig({
            maxModelRequestsPerTurn: 2,
            maxModelRequestsPerTask: 1,
            maxToolCallsPerTask: 1,
            timeoutMs: 1_000,
          })
        ),
        providerGate: new SubagentProviderGate({ maxConcurrent: 1 }),
        executeChild,
        parentForkSource: {
          serviceId: 'empty-parent-step-source',
          current: () => undefined,
          close: () => undefined,
        },
        parentAuthority: createAuthoritySnapshotV1({
          authorityId: 'parent',
          projectRoot: '/tmp/project',
          confirmation: 'allow',
          filesystem: 'workspace',
          network: 'deny',
        }),
      }
    );

    expect(outcome).toMatchObject({
      rejected: true,
      rejectReason: 'production_runtime_unavailable',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
