/**
 * orion code - Plan Mode Tools
 *
 * /plan is the only user-facing entry into planning mode.
 * exit_plan_mode is the model-facing completion transition.
 *
 * State is held in the shared tool-state module so the CLI can mirror it
 * into the main Store.
 */

import { buildTool, type OrionCodeTool } from '../framework/tool';
import { getToolState, setToolState } from '../framework/tool-state';

export const exitPlanModeTool: OrionCodeTool = buildTool({
  name: 'exit_plan_mode',
  description: `Submit the decision-complete implementation plan and finish the planning phase.
Call this exactly once when planning is complete. A successful call saves the plan
and automatically restores the selected execution mode. The runtime starts implementation in a
separate logical request so the completed plan remains a distinct phase. Do not call it with a draft, and do
not ask the user to run a separate exit command.`,
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
  execute: async (args, context) => {
    if (!getToolState().planMode) {
      return {
        success: false,
        output: '',
        error: 'exit_plan_mode is available only after the user starts a task with /plan.',
      };
    }
    const plan = args.plan;
    if (typeof plan !== 'string' || plan.trim().length === 0) {
      return {
        success: false,
        output: '',
        error: 'exit_plan_mode requires a non-empty plan parameter',
      };
    }
    const savedPlan = plan.trim();
    const returnMode = getToolState().planReturnMode ?? 'interactive';
    setToolState({ planMode: false, currentPlan: savedPlan, planReturnMode: returnMode });
    const selectedMode =
      context.onPlanModeChange?.({
        active: false,
        currentPlan: savedPlan,
        returnMode,
      }) ?? returnMode;
    const selectedModeLabel = selectedMode === 'auto' ? 'AUTO' : 'BUILD';
    return {
      success: true,
      output: `Plan saved. Plan mode exited automatically; execution will start in ${selectedModeLabel}.\n\n${savedPlan}`,
      metadata: {
        action: 'plan_completed',
        returnMode: selectedMode,
      },
    };
  },
  // This tool changes only bounded in-process planning metadata, so it is safe
  // to execute without a separate permission prompt in every Agent mode.
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ behavior: 'allow', reason: 'Bounded plan lifecycle transition' }),
  userFacingName: () => 'Complete plan mode',
});

/** Check if currently in plan mode */
export function isInPlanMode(): boolean {
  return getToolState().planMode;
}

/** Get current plan */
export function getCurrentPlan(): string {
  return getToolState().currentPlan ?? '';
}

export const PLAN_TOOLS: OrionCodeTool[] = [exitPlanModeTool];
