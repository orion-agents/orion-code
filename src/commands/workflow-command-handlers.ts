/** Handler implementations for the workflow-command-handlers boundary. */

import { type CommandContext, type CommandResult } from './types';
import { collectWorkspaceDiff, formatWorkspaceDiff } from '../services/workspace-diff';
import { createCommitPlan, formatCommitPlan } from '../services/commit-plan';

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

export { handleDiff, handleCommitPlan, continueAsSlashChat };
