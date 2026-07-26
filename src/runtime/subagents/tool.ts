/**
 * createSubtaskTool: the runtime-bound `subtask` tool factory.
 *
 * Unlike global stateless tools, this tool is created per root turn and bound
 * to a {@link SubagentSupervisor}. It is the only way the root Agent can
 * request child investigations; children themselves never receive it (the
 * preset allowlist strips `subtask`), so delegation depth is structurally 1.
 *
 * The tool is read-only orchestration: it never writes, and its result is the
 * structured batch summary the root Agent consumes to continue its own work.
 */

import { buildTool, type OpenHorseTool, type ToolInputJSONSchema } from '../../framework/tool';
import { runSubtaskBatch, type SubagentSupervisorDeps } from './supervisor';
import type { SubagentRole, SubtaskPacket, SubtaskRequest } from './types';

const ROLE_VALUES: readonly SubagentRole[] = ['research', 'review', 'test-investigate'];

const SUBTASK_PARAMETERS = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      description: '1-3 independent investigation packets.',
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['research', 'review', 'test-investigate'], description: 'Investigation role.' },
          objective: { type: 'string', description: 'A bounded, independently-investigable question. Must be specific enough to produce a verifiable conclusion.' },
          reason: { type: 'string', description: 'Why this is independently delegable and not a serial dependency.' },
          scope: {
            type: 'object',
            properties: {
              paths: { type: 'array', items: { type: 'string' } },
              symbols: { type: 'array', items: { type: 'string' } },
            },
          },
          contextHints: { type: 'array', items: { type: 'string' } },
          expectedOutput: { type: 'string' },
        },
        required: ['role', 'objective', 'reason'],
      },
    },
    execution: { type: 'string', enum: ['parallel', 'serial'], description: 'parallel (default) or serial.' },
  },
  required: ['tasks'],
} as unknown as ToolInputJSONSchema;

const SUBTASK_DESCRIPTION = [
  'Delegate 1-3 independent, read-only investigations to subagents and receive structured conclusions.',
  'Use ONLY when the work splits into genuinely independent investigations (e.g. researching two unrelated modules, reviewing a diff AND checking test gaps in parallel).',
  'Do NOT use for: single-file reads, simple greps, serial step-by-step work, or anything requiring edits/commands (children cannot edit or run commands).',
  'Each child returns a JSON result with summary, findings (with evidence), files, suggested commands (not executed), verification steps, and risks.',
].join(' ');

/** Coerce model-provided args into a validated SubtaskRequest. */
export function coerceSubtaskRequest(args: Record<string, unknown>): SubtaskRequest | null {
  const tasksRaw = args.tasks;
  if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) return null;
  const tasks: SubtaskPacket[] = [];
  for (const raw of tasksRaw) {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const role = obj.role;
    if (typeof role !== 'string' || !ROLE_VALUES.includes(role as SubagentRole)) return null;
    const objective = typeof obj.objective === 'string' ? obj.objective.trim() : '';
    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    if (!objective || !reason) return null;
    const packet: SubtaskPacket = { role: role as SubagentRole, objective, reason };
    if (obj.scope && typeof obj.scope === 'object') {
      const scope = obj.scope as Record<string, unknown>;
      const paths = Array.isArray(scope.paths) ? scope.paths.filter((p): p is string => typeof p === 'string') : undefined;
      const symbols = Array.isArray(scope.symbols) ? scope.symbols.filter((s): s is string => typeof s === 'string') : undefined;
      if (paths || symbols) packet.scope = { paths, symbols };
    }
    if (Array.isArray(obj.contextHints)) {
      packet.contextHints = obj.contextHints.filter((h): h is string => typeof h === 'string');
    }
    if (typeof obj.expectedOutput === 'string') packet.expectedOutput = obj.expectedOutput;
    // Drop any caller-provided `id`: runtime generates authoritative ids.
    tasks.push(packet);
  }
  const execution = args.execution === 'serial' ? 'serial' : 'parallel';
  return { tasks, execution };
}

/**
 * Create the runtime-bound `subtask` tool. The supervisor is captured in the
 * closure so the tool is stateless from the scheduler's perspective.
 */
export function createSubtaskTool(supervisorDeps: SubagentSupervisorDeps): OpenHorseTool {
  return buildTool({
    name: 'subtask',
    description: SUBTASK_DESCRIPTION,
    parameters: SUBTASK_PARAMETERS,
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    checkPermissions: () => ({ behavior: 'allow', reason: 'subtask is read-only orchestration; policy gate authorizes each child' }),
    async execute(args, context) {
      const request = coerceSubtaskRequest(args);
      if (!request) {
        return {
          success: false,
          output: '',
          error: 'Invalid subtask request: expected tasks[] with role/objective/reason.',
        };
      }
      // Forward the per-turn abort signal so Ctrl+C cancels the whole batch.
      const depsWithAbort: SubagentSupervisorDeps = {
        ...supervisorDeps,
        parentAbortSignal: context.abortSignal ?? supervisorDeps.parentAbortSignal,
      };
      try {
        const outcome = await runSubtaskBatch(request, depsWithAbort);
        const batch = outcome.result;
        const compact = summarizeBatchForModel(batch);
        let serialized: string;
        try {
          serialized = JSON.stringify(batch);
        } catch (jsonErr) {
          // N9: JSON.stringify can throw on circular references. Preserve
          // partial data by serializing a safe subset.
          serialized = JSON.stringify({
            batchId: batch.batchId,
            results: batch.results.map(r => ({ ...r, findings: [], commands: [], verification: [] })),
            aggregateUsage: batch.aggregateUsage,
            _serializationError: String(jsonErr instanceof Error ? jsonErr.message : jsonErr),
          });
        }
        return {
          success: !outcome.rejected,
          output: serialized,
          summary: compact,
          metadata: { batchId: batch.batchId, rejected: outcome.rejected, rejectReason: outcome.rejectReason },
        };
      } catch (err) {
        // N10: log unexpected errors for diagnostics before swallowing.
        console.error('[subtask] unexpected error:', err instanceof Error ? err.message : err);
        return {
          success: false,
          output: '',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    getSummary(_args, result) {
      return result.summary ?? result.output.slice(0, 200);
    },
  });
}

/** Produce a compact, model-facing summary of a batch result. */
export function summarizeBatchForModel(batch: { batchId: string; results: Array<{ role: string; status: string; summary: string; findings: unknown[]; risks: string[] }>; aggregateUsage: { modelRequests: number; toolCalls: number; durationMs: number } }): string {
  const lines = batch.results.map((r, i) => {
    const findingCount = Array.isArray(r.findings) ? r.findings.length : 0;
    const risk = r.risks.length > 0 ? ` risks=${r.risks.length}` : '';
    return `[${i}] ${r.role}/${r.status}: ${r.summary} (findings=${findingCount}${risk})`;
  });
  return [
    `subtask batch ${batch.batchId}: ${batch.results.length} result(s)`,
    ...lines,
    `aggregate: modelRequests=${batch.aggregateUsage.modelRequests} toolCalls=${batch.aggregateUsage.toolCalls} durationMs=${batch.aggregateUsage.durationMs}`,
  ].join('\n');
}
