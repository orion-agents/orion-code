/** Handler implementations for the workflow-command-handlers boundary. */

import { type CommandContext, type CommandResult } from './types';
import { collectWorkspaceDiff, formatWorkspaceDiff } from '../services/workspace-diff';
import { createCommitPlan, formatCommitPlan } from '../services/commit-plan';
import { setAgentMode } from '../framework/agent-mode';

async function handlePlan(ctx: CommandContext, args: string): Promise<CommandResult> {
  const task = args.trim();
  const [subcommand = '', ...tail] = task.split(/\s+/);
  if (['status', 'approve', 'continue', 'cancel'].includes(subcommand)) {
    if (!ctx.getPlanReviewState || !ctx.reviewPlan) {
      return { success: false, error: 'Durable Plan review is unavailable in this Runtime.' };
    }
    const state = await ctx.getPlanReviewState();
    if (!state) return { success: false, error: 'No durable Plan review exists for this Session.' };
    if (subcommand === 'status') {
      return {
        success: true,
        output: `Plan ${state.planDigest.slice(0, 12)} · ${state.status} · revision ${state.revision}`,
      };
    }
    if (state.status !== 'awaiting_review') {
      return { success: false, error: `Plan review is already ${state.status}.` };
    }
    const feedback = tail.join(' ').trim();
    if (subcommand === 'continue' && !feedback) {
      return { success: false, error: 'Usage: /plan continue <feedback>' };
    }
    const action =
      subcommand === 'approve' ? 'approve' : subcommand === 'continue' ? 'continue' : 'cancel';
    const receipt = await ctx.reviewPlan({
      planDigest: state.planDigest,
      action,
      ...(feedback ? { feedback } : {}),
    });
    const nextMode = action === 'approve' ? 'interactive' : action === 'continue' ? 'plan' : null;
    if (nextMode) {
      if (ctx.agentModeLifecycle) ctx.agentModeLifecycle.setMode(nextMode);
      else setAgentMode(ctx.store, nextMode);
    }
    return {
      success: true,
      output: `Plan review ${receipt.state.status}; follow-on ${receipt.admission.status}.`,
    };
  }
  const snapshot = ctx.store.getSnapshot();

  if (!snapshot.planMode || snapshot.agentMode !== 'plan') {
    if (ctx.agentModeLifecycle) ctx.agentModeLifecycle.setMode('plan');
    else setAgentMode(ctx.store, 'plan');
  }

  if (!task) {
    return {
      success: true,
      output:
        'Plan mode started with the current tool permission policy. Send the task; Orion will save the plan and wait for explicit review.',
    };
  }

  return {
    success: true,
    output:
      'Plan mode started with full tool availability under the current permission policy. Orion will save the plan, then wait for approve, continue, or cancel.',
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
