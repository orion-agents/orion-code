/**
 * v0.2.24 — Goal Model Tools.
 *
 * get_goal, create_goal, update_goal, abandon_goal tool definitions for the Agent.
 * These tools allow the model to read and request changes to the
 * persistent goal. Actual state changes go through GoalCoordinator.
 *
 * v0.2.26 fix: converted to OrionCodeTool format and wired into the
 * tool pipeline via GOAL_TOOLS export.
 */

import { buildTool, type OrionCodeTool, type ToolResult } from '../../framework/tool';
import { AsyncLocalStorage } from 'async_hooks';
import type {
  AgentTurnRequest,
  GoalBlockerCategory,
  GoalCriterionEvidence,
  GoalEvidenceRecord,
  GoalEvidenceKind,
  GoalPlanUpdate,
  GoalTerminalRequest,
  RuntimeGoalSnapshot,
} from './types';
import { GOAL_INVARIANTS } from './types';
import type { GoalCoordinator } from './coordinator';
import { updateSessionGoalBinding } from '../../services/session-storage';

// ---------------------------------------------------------------------------
// Runtime/session-scoped binding. AsyncLocalStorage prevents one session from
// overwriting another session's coordinator while tool calls overlap.
// ---------------------------------------------------------------------------

export interface GoalToolExecutionContext {
  coordinator: GoalCoordinator;
  request: AgentTurnRequest;
  turnId: string;
  pendingTerminalRequest?: GoalTerminalRequest;
  pendingPlanUpdate?: GoalPlanUpdate;
  pendingBlocker?: {
    category: GoalBlockerCategory;
    fingerprint: string;
    summary: string;
    retryable: boolean;
  };
  evidenceRecords: GoalEvidenceRecord[];
}

const goalToolContext = new AsyncLocalStorage<GoalToolExecutionContext>();

export function runWithGoalToolContext<T>(
  context: GoalToolExecutionContext,
  operation: () => Promise<T>
): Promise<T> {
  return goalToolContext.run(context, operation);
}

export function currentGoalToolContext(): GoalToolExecutionContext | undefined {
  return goalToolContext.getStore();
}

function requireContext(): GoalToolExecutionContext {
  const context = currentGoalToolContext();
  if (!context) throw new Error('GoalCoordinator not available in this runtime turn');
  return context;
}

type GoalAbandonmentAuthorization = { authorized: true } | { authorized: false; reason: string };

/**
 * Abandonment is destructive and must originate in the latest human-authored
 * turn input. Model-generated continuations and ambiguous discussion fail closed.
 */
export function authorizeGoalAbandonment(request: AgentTurnRequest): GoalAbandonmentAuthorization {
  if (!['user', 'revision'].includes(request.inputKind) || typeof request.text !== 'string') {
    return {
      authorized: false,
      reason: 'The latest runtime input is not an explicit user message or revision.',
    };
  }

  const text = request.text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!text || /[?？]/u.test(text)) {
    return { authorized: false, reason: 'The latest user message is not an explicit instruction.' };
  }

  const englishIntent =
    /^(?:(?:ok(?:ay)?|alright)[,!]?\s+)?(?:please\s+)?(?:(?:let(?:'|’)s|we should|i (?:want|would like) to|can you)\s+)?(?:just\s+)?(?:(?:abandon|cancel|drop|delete|clear|withdraw)\s+(?:(?:this|the|our)\s+)?(?:(?:current|active)\s+)?(?:goal|target|objective)|(?:stop|cease)\s+pursuing\s+(?:(?:this|the|our)\s+)?(?:(?:current|active)\s+)?(?:goal|target|objective)|give\s+up\s+on\s+(?:(?:this|the|our)\s+)?(?:(?:current|active)\s+)?(?:goal|target|objective))(?:\s+(?:now|entirely|completely))?(?:\s+because\s+.+)?[.!]*$/iu;
  const chineseIntent =
    /^(?:好的?|好吧|行)?[，,\s]*(?:我们|我)?(?:请)?(?:现在)?(?:放弃|取消|删除|清除|终止)(?:这个|当前|该|本)?(?:目标|Goal|Target)(?:吧|了|即可)?(?:[，,]\s*(?:因为|原因是).+)?[。！!]*$/iu;
  const chineseStopIntent =
    /^(?:好的?|好吧|行)?[，,\s]*(?:我们|我)?(?:请)?不要再?继续(?:这个|当前|该|本)?(?:目标|Goal|Target)(?:吧|了)?[。！!]*$/iu;

  if (!englishIntent.test(text) && !chineseIntent.test(text) && !chineseStopIntent.test(text)) {
    return {
      authorized: false,
      reason: 'The latest user message does not explicitly instruct abandoning the current Goal.',
    };
  }

  return { authorized: true };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const getGoalTool: OrionCodeTool = buildTool({
  name: 'get_goal',
  description:
    'Read the current persistent goal for this session. Returns null if no goal is active.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  execute: async (): Promise<ToolResult> => {
    const context = requireContext();
    const coord = context.coordinator;
    const snap: RuntimeGoalSnapshot | null = coord.snapshot();
    const goal = coord.goal;
    if (!snap || !goal) return { success: true, output: 'No active goal.' };
    const recentEvidence = [...(goal.evidenceLedger ?? []), ...context.evidenceRecords]
      .filter(record => record.goalId === goal.goalId)
      .slice(-50)
      .map(record => ({
        id: record.id,
        goalRevision: record.goalRevision,
        turnId: record.turnId,
        kind: record.kind,
        subject: record.subject,
        result: record.result,
        capturedAt: record.capturedAt,
      }));
    return {
      success: true,
      output: JSON.stringify(
        {
          goal: snap,
          successCriteria: goal.contract?.successCriteria ?? [],
          recentEvidence,
        },
        null,
        2
      ),
    };
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
});

export const createGoalTool: OrionCodeTool = buildTool({
  name: 'create_goal',
  description:
    'Create a persistent goal for this session. Only use when the user explicitly requests a long-running goal. If the objective is ambiguous, high-risk, or requires external state changes, first ask the user to confirm the objective, constraints, success criteria, and external-action boundary. Rejects if a goal already exists.',
  parameters: {
    type: 'object',
    properties: {
      objective: {
        type: 'string',
        description: 'The goal objective. Must be clear, specific, and verifiable.',
      },
      constraints: {
        type: 'array',
        description: 'Optional user-authored constraints that the agent must preserve.',
        items: { type: 'string' },
      },
      success_criteria: {
        type: 'array',
        description:
          'Optional user-authored success criteria with required runtime evidence kinds.',
        items: {
          type: 'object',
          properties: {
            statement: { type: 'string' },
            required_evidence_kinds: { type: 'array', items: { type: 'string' } },
          },
          required: ['statement', 'required_evidence_kinds'],
        },
      },
    },
    required: ['objective'],
  },
  execute: async (args): Promise<ToolResult> => {
    const coord = requireContext().coordinator;
    const objective = args.objective as string;
    const constraints = Array.isArray(args.constraints)
      ? args.constraints.map(value => String(value).trim())
      : [];
    const rawCriteria = Array.isArray(args.success_criteria)
      ? (args.success_criteria as Array<Record<string, unknown>>)
      : [];
    const successCriteria = rawCriteria.map(criterion => ({
      statement: String(criterion.statement ?? '').trim(),
      requiredEvidenceKinds: Array.isArray(criterion.required_evidence_kinds)
        ? criterion.required_evidence_kinds.map(kind => String(kind) as GoalEvidenceKind)
        : [],
    }));
    const result = coord.create(objective, { constraints, successCriteria });
    if (!result.ok) return { success: false, output: result.error, error: result.error };

    updateSessionGoalBinding(coord.boundSessionId, coord.goal);

    const snap = coord.snapshot();
    return {
      success: true,
      output: snap ? JSON.stringify(snap, null, 2) : 'Goal created but snapshot unavailable.',
    };
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ behavior: 'allow', reason: 'Internal Goal state update' }),
});

export const updateGoalTool: OrionCodeTool = buildTool({
  name: 'update_goal',
  description: `Request an audited Goal status change. Blocked requires the same eligible non-retryable blocker for >= ${GOAL_INVARIANTS.maxConsecutiveBlockerTurns} consecutive Goal turns and no progress for >= ${GOAL_INVARIANTS.maxConsecutiveNoProgressTurns} consecutive Goal turns.`,
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['complete', 'blocked'],
        description: `The requested target status: "complete" when all requirements are verified; "blocked" only when the same eligible non-retryable blocker persisted for >= ${GOAL_INVARIANTS.maxConsecutiveBlockerTurns} consecutive Goal turns and no progress persisted for >= ${GOAL_INVARIANTS.maxConsecutiveNoProgressTurns} consecutive Goal turns.`,
      },
      criterion_evidence: {
        type: 'array',
        description:
          'For completion, map every success criterion to runtime-captured evidence IDs returned by tools.',
        items: {
          type: 'object',
          properties: {
            criterion_id: { type: 'string' },
            evidence_ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['criterion_id', 'evidence_ids'],
        },
      },
      blocker: {
        type: 'object',
        description: `Required for blocked: the same eligible non-retryable external blocker must persist for >= ${GOAL_INVARIANTS.maxConsecutiveBlockerTurns} consecutive Goal turns, and no progress must persist for >= ${GOAL_INVARIANTS.maxConsecutiveNoProgressTurns} consecutive Goal turns.`,
        properties: {
          category: {
            type: 'string',
            enum: ['user_input', 'permission', 'external_state'],
          },
          resource: { type: 'string' },
          reason: { type: 'string' },
          retryable: { type: 'boolean' },
        },
        required: ['category', 'resource', 'reason', 'retryable'],
      },
    },
    required: ['status'],
  },
  execute: async (args): Promise<ToolResult> => {
    const context = requireContext();
    const coord = context.coordinator;
    const status = args.status as 'complete' | 'blocked';
    const goal = coord.goal;
    if (!goal)
      return {
        success: false,
        output: 'No active goal to update.',
        error: 'No active goal to update.',
      };
    if (goal.status !== 'active')
      return {
        success: false,
        output: `Goal is not active (current status: ${goal.status}). Run /target resume to reactivate, then retry.`,
        error: `Goal is not active (current status: ${goal.status}). Run /target resume to reactivate, then retry.`,
      };

    let criterionEvidence: GoalCriterionEvidence[] | undefined;
    if (status === 'complete') {
      const criteria = goal.contract?.successCriteria ?? [];
      const availableEvidence = new Map(
        [...(goal.evidenceLedger ?? []), ...context.evidenceRecords]
          .filter(
            record =>
              record.goalId === goal.goalId &&
              record.goalRevision <= goal.revision &&
              record.objectiveRevision === (goal.contract?.objectiveRevision ?? 0)
          )
          .map(record => [record.id, record])
      );
      const rawMappings = Array.isArray(args.criterion_evidence)
        ? (args.criterion_evidence as Array<Record<string, unknown>>)
        : [];

      criterionEvidence = rawMappings.map(mapping => ({
        criterionId: String(mapping.criterion_id ?? ''),
        evidenceIds: Array.isArray(mapping.evidence_ids)
          ? mapping.evidence_ids.map(id => String(id))
          : [],
      }));

      if (!criterionEvidence || criterionEvidence.length !== criteria.length) {
        return {
          success: false,
          output:
            'Completion requires an evidence mapping for every success criterion. Call get_goal after verification to read captured evidence IDs.',
          error:
            'Completion requires an evidence mapping for every success criterion. Call get_goal after verification to read captured evidence IDs.',
        };
      }
      const seenCriteria = new Set<string>();
      const seenEvidence = new Set<string>();
      for (const mapping of criterionEvidence) {
        const criterion = criteria.find(item => item.id === mapping.criterionId);
        if (
          !criterion ||
          seenCriteria.has(mapping.criterionId) ||
          mapping.evidenceIds.length === 0
        ) {
          return {
            success: false,
            output: `Invalid or duplicate evidence mapping for criterion ${mapping.criterionId || '(empty)'}.`,
            error: `Invalid or duplicate evidence mapping for criterion ${mapping.criterionId || '(empty)'}.`,
          };
        }
        seenCriteria.add(mapping.criterionId);
        for (const evidenceId of mapping.evidenceIds) {
          if (seenEvidence.has(evidenceId)) {
            return {
              success: false,
              output: `Evidence ${evidenceId} cannot be reused across success criteria.`,
              error: `Evidence ${evidenceId} cannot be reused across success criteria.`,
            };
          }
          const record = availableEvidence.get(evidenceId);
          if (!record || !criterion.requiredEvidenceKinds.includes(record.kind)) {
            return {
              success: false,
              output: `Evidence ${evidenceId} is unavailable or irrelevant to ${mapping.criterionId}.`,
              error: `Evidence ${evidenceId} is unavailable or irrelevant to ${mapping.criterionId}.`,
            };
          }
          seenEvidence.add(evidenceId);
        }
      }
    }

    if (status === 'blocked') {
      const blocker =
        args.blocker && typeof args.blocker === 'object'
          ? (args.blocker as Record<string, unknown>)
          : undefined;
      const category = String(blocker?.category ?? '').trim();
      const resource = String(blocker?.resource ?? '').trim();
      const reason = String(blocker?.reason ?? '').trim();
      const retryable = blocker?.retryable;
      if (
        !['user_input', 'permission', 'external_state'].includes(category) ||
        !resource ||
        !reason ||
        typeof retryable !== 'boolean'
      ) {
        return {
          success: false,
          output: 'Blocked requests require blocker category, resource, reason, and retryable.',
          error: 'Blocked requests require blocker category, resource, reason, and retryable.',
        };
      }
      if (retryable) {
        return {
          success: false,
          output: 'Retryable blockers cannot become terminal blocked; continue or pause instead.',
          error: 'Retryable blockers cannot become terminal blocked; continue or pause instead.',
        };
      }
      context.pendingBlocker = {
        category: category as GoalBlockerCategory,
        fingerprint: `${category}:${resource}:${reason}`,
        summary: `${category} on ${resource}: ${reason}`,
        retryable: false,
      };
    }

    context.pendingTerminalRequest = {
      requestedStatus: status,
      requestedAt: Date.now(),
      goalId: goal.goalId,
      goalRevision: goal.revision,
      turnId: context.turnId,
      criterionEvidence,
    };

    return {
      success: true,
      output:
        status === 'blocked'
          ? `Goal blocked request recorded; this does not mean blocked was applied. Audit requires the same eligible blocker for >= ${GOAL_INVARIANTS.maxConsecutiveBlockerTurns} consecutive Goal turns and no progress for >= ${GOAL_INVARIANTS.maxConsecutiveNoProgressTurns} consecutive Goal turns. Current persisted counts: blocker ${goal.blocker?.consecutiveTurns ?? 0}, no progress ${goal.noProgressCount}.`
          : 'Goal complete request recorded. Audit will verify before applying.',
    };
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ behavior: 'allow', reason: 'Internal Goal state update' }),
});

export const abandonGoalTool: OrionCodeTool = buildTool({
  name: 'abandon_goal',
  description:
    'Permanently abandon and delete the current persistent Goal only when the latest user message explicitly instructs abandoning that Goal. Never infer authorization from age, blockers, failures, or model judgment.',
  parameters: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'A concise audit reason for the user-authorized abandonment.',
      },
    },
    required: ['reason'],
  },
  execute: async (args): Promise<ToolResult> => {
    const context = requireContext();
    const authorization = authorizeGoalAbandonment(context.request);
    if (!authorization.authorized) {
      const error = `Goal abandonment denied: ${authorization.reason}`;
      return { success: false, output: error, error };
    }
    if (context.request.sessionId !== context.coordinator.boundSessionId) {
      const error = 'Goal abandonment denied: runtime session does not own this Goal.';
      return { success: false, output: error, error };
    }

    const reason = typeof args.reason === 'string' ? args.reason.replace(/\s+/gu, ' ').trim() : '';
    if (!reason || reason.length > 500) {
      const error = 'Goal abandonment requires a non-empty reason of at most 500 characters.';
      return { success: false, output: error, error };
    }

    const goal = context.coordinator.goal;
    if (!goal) {
      const error = 'No persistent Goal is available to abandon.';
      return { success: false, output: error, error };
    }

    const audit = {
      action: 'abandon_goal' as const,
      goalId: goal.goalId,
      goalRevision: goal.revision,
      turnId: context.turnId,
      reason,
      authorizedBy: 'latest_user_explicit_intent' as const,
      abandonedAt: Date.now(),
    };
    try {
      if (!context.coordinator.clear()) {
        const error = 'Goal abandonment failed because the Goal was no longer active.';
        return { success: false, output: error, error };
      }
      updateSessionGoalBinding(context.coordinator.boundSessionId, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: `Goal abandonment could not be completed: ${message}`,
        error: `Goal abandonment could not be completed: ${message}`,
      };
    }

    return {
      success: true,
      output: JSON.stringify(audit, null, 2),
      summary: `Abandoned Goal ${goal.goalId.slice(0, 8)}: ${reason}`,
      metadata: audit,
    };
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => true,
  checkPermissions: () => {
    const context = currentGoalToolContext();
    if (!context) {
      return { behavior: 'deny', reason: 'Goal runtime context is unavailable' };
    }
    const authorization = authorizeGoalAbandonment(context.request);
    return authorization.authorized
      ? {
          behavior: 'allow',
          reason: 'Explicit Goal abandonment instruction from latest user input',
        }
      : {
          behavior: 'deny',
          reason: authorization.reason,
        };
  },
});

const ALLOWED_DERIVED_EVIDENCE = new Set<GoalEvidenceKind>([
  'test',
  'build',
  'lint',
  'file',
  'runtime',
  'external',
]);

export const updateGoalPlanTool: OrionCodeTool = buildTool({
  name: 'update_goal_plan',
  description:
    'Update the current Goal execution plan and add derived success criteria. The runtime applies it atomically when the current turn finalizes.',
  parameters: {
    type: 'object',
    properties: {
      phase: { type: 'string', description: 'Short current execution phase.' },
      steps: {
        type: 'array',
        description: 'Current bounded execution steps.',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            done: { type: 'boolean' },
          },
          required: ['description', 'done'],
        },
      },
      next_action: { type: 'string', description: 'The next concrete action.' },
      derived_criteria: {
        type: 'array',
        description: 'Additional agent-derived criteria; existing user criteria are never removed.',
        items: {
          type: 'object',
          properties: {
            statement: { type: 'string' },
            evidence_kinds: { type: 'array', items: { type: 'string' } },
          },
          required: ['statement', 'evidence_kinds'],
        },
      },
    },
    required: ['phase', 'steps'],
  },
  execute: async (args): Promise<ToolResult> => {
    const context = requireContext();
    const goal = context.coordinator.goal;
    if (!goal || goal.status !== 'active') {
      return {
        success: false,
        output: 'No active goal to plan.',
        error: 'No active goal to plan.',
      };
    }
    const phase = String(args.phase ?? '').trim();
    const rawSteps = Array.isArray(args.steps)
      ? (args.steps as Array<Record<string, unknown>>)
      : [];
    if (!phase || rawSteps.length > 50) {
      return {
        success: false,
        output: 'Plan phase is required and steps are limited to 50.',
        error: 'Plan phase is required and steps are limited to 50.',
      };
    }
    const steps = rawSteps.map(step => ({
      description: String(step.description ?? '').trim(),
      done: step.done === true,
    }));
    if (steps.some(step => !step.description)) {
      return {
        success: false,
        output: 'Every plan step requires a description.',
        error: 'Every plan step requires a description.',
      };
    }
    const rawCriteria = Array.isArray(args.derived_criteria)
      ? (args.derived_criteria as Array<Record<string, unknown>>)
      : [];
    const derivedCriteria: GoalPlanUpdate['derivedCriteria'] = [];
    for (const raw of rawCriteria) {
      const statement = String(raw.statement ?? '').trim();
      const kinds = Array.isArray(raw.evidence_kinds)
        ? raw.evidence_kinds.map(kind => String(kind) as GoalEvidenceKind)
        : [];
      if (
        !statement ||
        kinds.length === 0 ||
        kinds.some(kind => !ALLOWED_DERIVED_EVIDENCE.has(kind))
      ) {
        return {
          success: false,
          output: 'Derived criteria require a statement and valid runtime evidence kinds.',
          error: 'Derived criteria require a statement and valid runtime evidence kinds.',
        };
      }
      derivedCriteria.push({ statement, requiredEvidenceKinds: [...new Set(kinds)] });
    }
    context.pendingPlanUpdate = {
      phase,
      steps,
      nextAction: String(args.next_action ?? '').trim() || undefined,
      derivedCriteria,
    };
    return {
      success: true,
      output: 'Goal plan update recorded. The coordinator will apply it when this turn finalizes.',
    };
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ behavior: 'allow', reason: 'Internal Goal state update' }),
});

export const GOAL_TOOLS: OrionCodeTool[] = [
  getGoalTool,
  createGoalTool,
  updateGoalPlanTool,
  updateGoalTool,
  abandonGoalTool,
];
