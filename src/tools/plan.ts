/**
 * orion code - Plan Mode Tools
 *
 * enter_plan_mode: Enter planning mode for complex tasks
 * exit_plan_mode: Exit planning mode with a plan
 *
 * State is held in the shared tool-state module so the CLI can mirror it
 * into the main Store.
 */

import { buildTool, type OpenHorseTool } from '../framework/tool';
import { getToolState, setToolState } from '../framework/tool-state';

export const enterPlanModeTool: OpenHorseTool = buildTool({
  name: 'enter_plan_mode',
  description: `Enter plan mode for complex tasks requiring exploration and planning.
In plan mode, you should explore the project structure, understand the problem,
and create a detailed implementation plan WITHOUT executing any code changes.
Use this when the task is complex, ambiguous, or requires careful consideration.`,
  parameters: {
    type: 'object',
    properties: {},
  },
  execute: async () => {
    setToolState({ planMode: true, currentPlan: null });
    return {
      success: true,
      output: 'Entered plan mode. Explore the project, understand the problem, and create a plan. Use exit_plan_mode when ready with your plan.',
    };
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ behavior: 'allow', reason: 'Safe mode change' }),
  userFacingName: () => 'Enter plan mode',
});

export const exitPlanModeTool: OpenHorseTool = buildTool({
  name: 'exit_plan_mode',
  description: `Exit plan mode and save the implementation plan.
This tool finalizes the plan and returns to execution mode.`,
  parameters: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description: 'The detailed implementation plan',
      },
    },
    required: ['plan'],
  },
  execute: async (args) => {
    const plan = args.plan;
    if (typeof plan !== 'string' || plan.trim().length === 0) {
      return {
        success: false,
        output: '',
        error: 'exit_plan_mode requires a non-empty plan parameter',
      };
    }
    setToolState({ planMode: false, currentPlan: plan });
    return {
      success: true,
      output: `Exited plan mode. Plan saved:\n\n${plan}`,
    };
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ behavior: 'allow', reason: 'Safe mode change' }),
  userFacingName: () => 'Exit plan mode',
});

/** Check if currently in plan mode */
export function isInPlanMode(): boolean {
  return getToolState().planMode;
}

/** Get current plan */
export function getCurrentPlan(): string {
  return getToolState().currentPlan ?? '';
}

export const PLAN_TOOLS: OpenHorseTool[] = [enterPlanModeTool, exitPlanModeTool];
