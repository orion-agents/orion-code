/**
 * Workspace delta and verification projections for the chat runtime.
 *
 * This module captures snapshots and derives trace/verification state. It does
 * not execute the chat loop, tools, or commands.
 */

import type { LoopStats } from '../framework';
import { redactTraceText } from '../services/session-storage';
import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
  type WorkspaceSnapshot,
} from '../services/workspace-state';
import {
  isRiskyEdit,
  selectVerificationProfile,
  summarizeVerificationState,
  type VerificationCommandResult,
  type VerificationProfile,
  type VerificationSummary,
} from '../services/verification-profile';
import type { UiEventSink } from './ui-events';
import { compactMiddle, recordTraceEvent } from './chat-trace';

function compactPathList(paths: string[], maxItems = 40): string[] {
  return paths.slice(0, maxItems);
}

function formatWorkspaceFileForTrace(file: WorkspaceSnapshot['files'][number]): string {
  const metadata = [
    typeof file.sizeBytes === 'number' ? `${file.sizeBytes}B` : '',
    typeof file.mtimeMs === 'number' ? `mtime=${file.mtimeMs}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `${file.status} ${file.path}${metadata ? ` (${metadata})` : ''}`;
}

export function appendWorkspaceSnapshotTrace(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  phase: 'pre_turn' | 'post_turn',
  snapshot: WorkspaceSnapshot
): void {
  if (!sessionId) return;
  recordTraceEvent(events, sessionId, {
    turnId,
    type: 'workspace_snapshot',
    workspacePhase: phase,
    workspaceGitAvailable: snapshot.gitAvailable,
    workspaceDirty: snapshot.dirty,
    workspaceBranch: snapshot.branch,
    workspaceFileCount: snapshot.fileCount,
    workspaceFiles: compactPathList(snapshot.files.map(formatWorkspaceFileForTrace)),
    error: snapshot.error ? compactMiddle(snapshot.error, 240) : undefined,
  });
}

function appendWorkspaceDeltaTrace(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot
): ReturnType<typeof diffWorkspaceSnapshots> {
  const delta = diffWorkspaceSnapshots(before, after);
  if (sessionId) {
    recordTraceEvent(events, sessionId, {
      turnId,
      type: 'workspace_delta',
      workspaceFileCount: delta.filesAfterTurn.length,
      workspaceFiles: compactPathList(delta.filesAfterTurn),
      workspaceNewByTurn: compactPathList(delta.newFilesByTurn),
      workspaceChangedByTurn: compactPathList(delta.changedByTurn),
      workspaceModifiedPreExistingByTurn: compactPathList(delta.modifiedPreExistingByTurn),
      workspaceResolvedByTurn: compactPathList(delta.resolvedByTurn),
      note: `pre_existing=${delta.preExistingFiles.length}`,
    });
  }
  return delta;
}

export function workspaceDeltaHasTurnChanges(
  delta: ReturnType<typeof diffWorkspaceSnapshots>
): boolean {
  return (
    delta.newFilesByTurn.length > 0 ||
    delta.changedByTurn.length > 0 ||
    delta.resolvedByTurn.length > 0
  );
}

export function formatFailureRecoveryNotice(
  turnId: string,
  delta: ReturnType<typeof diffWorkspaceSnapshots>,
  checkpointIds: string[]
): string {
  const files = compactPathList(
    [...delta.newFilesByTurn, ...delta.changedByTurn, ...delta.resolvedByTurn],
    8
  );
  const fileText = files.length > 0 ? files.join(', ') : 'workspace changes recorded';
  const checkpointText =
    checkpointIds.length > 0
      ? ` Checkpoints: ${checkpointIds.join(', ')}. Preview rollback with /checkpoint restore <id>; restore each listed checkpoint if multiple.`
      : '';
  return `Turn failed after modifying files: ${fileText}. Inspect /trace ${turnId}.${checkpointText}`;
}

function appendVerificationProfileTrace(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  profile: VerificationProfile
): void {
  if (!sessionId || profile.changedFiles.length === 0) return;
  recordTraceEvent(events, sessionId, {
    turnId,
    type: 'verification_profile',
    verificationProfile: profile.profile,
    verificationRequired: profile.required,
    verificationRisky: isRiskyEdit(profile.changedFiles),
    verificationCommands: compactPathList(profile.commands, 8),
    verificationChangedFiles: compactPathList(profile.changedFiles),
    note: profile.reason,
  });
}

export function appendVerificationResultTrace(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  result: VerificationCommandResult
): void {
  if (!sessionId) return;
  recordTraceEvent(events, sessionId, {
    turnId,
    type: 'verification_result',
    verificationCommand: result.command,
    verificationPassed: result.success,
    outputBytes: result.outputBytes,
    error: result.error ? compactMiddle(result.error, 240) : undefined,
  });
}

function appendVerificationSummaryTrace(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  summary: VerificationSummary,
  changedFiles: string[]
): void {
  if (!sessionId || changedFiles.length === 0) return;
  recordTraceEvent(events, sessionId, {
    turnId,
    type: 'verification_summary',
    verificationProfile: summary.profile,
    verificationRequired: summary.required,
    verificationCommands: compactPathList(summary.commandsRun, 12),
    verificationPassedCommands: compactPathList(summary.passedCommands, 12),
    verificationFailedCommands: compactPathList(summary.failedCommands, 12),
    verificationMissingCommands: compactPathList(summary.missingCommands, 12),
    verificationChangedFiles: compactPathList(changedFiles),
    verificationClaimAllowed: summary.claimAllowed,
    note: summary.skippedReason,
  });
}

function compactVerificationCommands(commands: string[], maxItems = 12): string[] {
  return commands.slice(0, maxItems).map(redactTraceText);
}

export function withVerificationLoopStats(
  stats: LoopStats,
  summary: VerificationSummary
): LoopStats {
  return {
    ...stats,
    verificationProfile: summary.profile,
    verificationRequired: summary.required,
    verificationClaimAllowed: summary.claimAllowed,
    verificationPassedCommands: compactVerificationCommands(summary.passedCommands),
    verificationFailedCommands: compactVerificationCommands(summary.failedCommands),
    verificationMissingCommands: compactVerificationCommands(summary.missingCommands),
    verificationSkippedReason: summary.skippedReason
      ? redactTraceText(summary.skippedReason)
      : undefined,
  };
}

export function shouldRecordVerificationLoopStats(
  profile: VerificationProfile,
  summary: VerificationSummary
): boolean {
  return (
    profile.changedFiles.length > 0 ||
    summary.commandsRun.length > 0 ||
    summary.passedCommands.length > 0 ||
    summary.failedCommands.length > 0 ||
    summary.missingCommands.length > 0
  );
}

export function appendPostWorkspaceTrace(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  cwd: string,
  before: WorkspaceSnapshot,
  verificationResults: VerificationCommandResult[] = []
): {
  delta: ReturnType<typeof diffWorkspaceSnapshots>;
  profile: VerificationProfile;
  summary: VerificationSummary;
} {
  const postWorkspace = captureWorkspaceSnapshot(cwd);
  appendWorkspaceSnapshotTrace(events, sessionId, turnId, 'post_turn', postWorkspace);
  const delta = appendWorkspaceDeltaTrace(events, sessionId, turnId, before, postWorkspace);
  const profile = selectVerificationProfile(cwd, delta.changedByTurn);
  const summary = summarizeVerificationState(profile, verificationResults);
  appendVerificationProfileTrace(events, sessionId, turnId, profile);
  appendVerificationSummaryTrace(events, sessionId, turnId, summary, profile.changedFiles);
  return { delta, profile, summary };
}
