/**
 * v0.2.24 — Goal Model Tools.
 *
 * get_goal, create_goal, update_goal tool definitions for the Agent.
 * These tools allow the model to read and request changes to the
 * persistent goal. Actual state changes go through GoalCoordinator.
 *
 * v0.2.26 fix: converted to OpenHorseTool format and wired into the
 * tool pipeline via GOAL_TOOLS export.
 */

import { buildTool, type OpenHorseTool, type ToolResult } from '../../framework/tool';
import type { RuntimeGoalSnapshot } from './types';
import type { GoalCoordinator } from './coordinator';

// ---------------------------------------------------------------------------
// Runtime binding — set by AgentRuntimeController when a GoalCoordinator
// is available. This avoids passing the coordinator through every tool call.
// ---------------------------------------------------------------------------

let _coordinator: GoalCoordinator | null = null;

export function setGoalToolCoordinator(coord: GoalCoordinator | null): void {
  _coordinator = coord;
}

function requireCoordinator(): GoalCoordinator {
  if (!_coordinator) throw new Error('GoalCoordinator not available');
  return _coordinator;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const getGoalTool: OpenHorseTool = buildTool({
  name: 'get_goal',
  description: 'Read the current persistent goal for this session. Returns null if no goal is active.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  execute: async (): Promise<ToolResult> => {
    const coord = requireCoordinator();
    const snap: RuntimeGoalSnapshot | null = coord.snapshot();
    return {
      success: true,
      output: snap ? JSON.stringify(snap, null, 2) : 'No active goal.',
    };
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
});

export const createGoalTool: OpenHorseTool = buildTool({
  name: 'create_goal',
  description: 'Create a persistent goal for this session. Only use when the user explicitly requests a long-running goal. Rejects if a goal already exists.',
  parameters: {
    type: 'object',
    properties: {
      objective: {
        type: 'string',
        description: 'The goal objective. Must be clear, specific, and verifiable.',
      },
      token_budget: {
        type: 'number',
        description: 'Optional token budget. Only set when the user explicitly provides a budget.',
      },
    },
    required: ['objective'],
  },
  execute: async (args): Promise<ToolResult> => {
    const coord = requireCoordinator();
    const objective = args.objective as string;
    const tokenBudget = args.token_budget as number | undefined;
    const result = coord.create(objective);
    if (!result.ok) return { success: false, output: '', error: result.error };

    if (tokenBudget && tokenBudget > 0) {
      coord.setBudget(tokenBudget);
    }

    const snap = coord.snapshot();
    return {
      success: true,
      output: snap ? JSON.stringify(snap, null, 2) : 'Goal created but snapshot unavailable.',
    };
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
});

export const updateGoalTool: OpenHorseTool = buildTool({
  name: 'update_goal',
  description: 'Request a status change for the current goal. The request is audited before the change takes effect.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['complete', 'blocked'],
        description: 'The requested target status: "complete" when all requirements are verified; "blocked" when the same blocker persisted for 3+ turns.',
      },
    },
    required: ['status'],
  },
  execute: async (args): Promise<ToolResult> => {
    const coord = requireCoordinator();
    const status = args.status as 'complete' | 'blocked';
    const goal = coord.goal;
    if (!goal) return { success: false, output: '', error: 'No active goal to update.' };
    if (goal.status !== 'active') return { success: false, output: '', error: `Goal is not active (current status: ${goal.status}).` };

    return {
      success: true,
      output: `Goal ${status} request recorded. Audit will verify before applying.`,
    };
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
});

export const GOAL_TOOLS: OpenHorseTool[] = [getGoalTool, createGoalTool, updateGoalTool];
