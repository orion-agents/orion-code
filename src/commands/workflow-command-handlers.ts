/** Handler implementations for the workflow-command-handlers boundary. */

import { type CommandContext, type CommandResult } from './types';
import { collectWorkspaceDiff, formatWorkspaceDiff } from '../services/workspace-diff';
import { createCommitPlan, formatCommitPlan } from '../services/commit-plan';
import { getToolState } from '../framework/tool-state';
import { setAgentMode } from '../framework/agent-mode';

function handlePlan(ctx: CommandContext, args: string): CommandResult {
  const task = args.trim();
  const state = getToolState();
  const snapshot = ctx.store.getSnapshot();

  if (!state.planMode || snapshot.agentMode !== 'plan') {
    if (ctx.agentModeLifecycle) ctx.agentModeLifecycle.setMode('plan');
    else setAgentMode(ctx.store, 'plan');
  }

  if (!task) {
    return {
      success: true,
      output:
        'Plan mode started. Send the task to explore read-only; Orion will save the plan, exit Plan, and execute it in the next logical request.',
    };
  }

  return {
    success: true,
    output: 'Plan mode started. Orion will plan read-only, then execute the saved plan.',
    continueAsChat: true,
    chatInput: task,
  };
}

function handleDiff(ctx: CommandContext, args: string): CommandResult {
  const maxFilesMatch = args.match(/--max-files(?:=|\s+)(\d+)/);
  const maxFiles = maxFilesMatch ? Number(maxFilesMatch[1]) : 40;
  const report = collectWorkspaceDiff({ cwd: ctx.cwd, maxFiles });
  return {
    success: report.isGitRepo,
    output: formatWorkspaceDiff(report, { maxFiles }),
  };
}

function handleCommitPlan(ctx: CommandContext, args: string): CommandResult {
  const maxFilesMatch = args.match(/--max-files(?:=|\s+)(\d+)/);
  const maxFiles = maxFilesMatch ? Number(maxFilesMatch[1]) : 20;
  const plan = createCommitPlan({ cwd: ctx.cwd, maxFiles });
  return { success: plan.diff.isGitRepo, output: formatCommitPlan(plan) };
}

function continueAsSlashChat(name: string, args: string): CommandResult {
  const trimmed = args.trim();
  return {
    success: true,
    continueAsChat: true,
    chatInput: `/${name}${trimmed ? ` ${trimmed}` : ''}`,
  };
}

export { handlePlan, handleDiff, handleCommitPlan, continueAsSlashChat };
