import type { QueryCompactCommit } from '../framework';
import type { Store } from '../framework/store';
import type { HarnessState } from '../harness';
import {
  advanceSessionCompactSourceReceipt,
  commitSessionCompactCheckpoint,
  readSessionMessages,
  type SessionMessage,
} from '../services/session-storage';
import { compactTraceError, recordTraceEvent } from './chat-trace';
import type { SessionGoalV1 } from './goals/types';
import type { UiEventSink } from './ui-events';

interface CommitChatCompactInput {
  pendingCompact: QueryCompactCommit;
  sessionId?: string;
  turnId: string;
  modelId: string;
  sessionMessages: readonly SessionMessage[];
  harnessState: HarnessState;
  activeGoal?: SessionGoalV1 | null;
  store: Store;
  events: UiEventSink;
}

/**
 * Commit one prepared compact receipt without allowing the chat controller to
 * become a second persistence owner. Transcript/checkpoint CAS remains inside
 * session-storage; this adapter only emits the matching runtime trace and UI
 * projection.
 */
export function commitChatCompact(input: CommitChatCompactInput): void {
  const {
    pendingCompact,
    sessionId,
    turnId,
    modelId,
    sessionMessages,
    harnessState,
    activeGoal,
    store,
    events,
  } = input;
  const compactTrace = {
    model: modelId,
    compactMode: pendingCompact.mode,
    compactStrategy:
      pendingCompact.summary.source === 'llm' ? 'semantic-llm-v2' : 'deterministic-fallback-v2',
    compactCandidateFingerprint: pendingCompact.fingerprint,
    compactBeforeTokens: pendingCompact.beforeTokens,
    compactAfterTokens: pendingCompact.afterTokens,
    compactTargetTokens: pendingCompact.plan?.targetTokens,
    compactTargetRatio: pendingCompact.plan?.targetRatio,
    compactDiagnosticsCount: pendingCompact.diagnostics?.length ?? 0,
  };

  if (sessionId) {
    recordTraceEvent(events, sessionId, {
      turnId,
      type: 'compact_prepare',
      ...compactTrace,
    });
  }

  try {
    let committedCheckpointId: string | undefined;
    if (sessionId) {
      const prepareSource = pendingCompact.prepareSource
        ? advanceSessionCompactSourceReceipt(pendingCompact.prepareSource, sessionMessages)
        : undefined;
      const sourceMessageCount =
        prepareSource?.sourceMessageCount ?? readSessionMessages(sessionId).length;
      const checkpoint = commitSessionCompactCheckpoint({
        sessionId,
        mode: pendingCompact.mode,
        modelId,
        sourceMessageCount,
        transcriptStartMessageIndex: Math.max(0, sourceMessageCount - 20),
        modelHistory: pendingCompact.modelHistory,
        summary: pendingCompact.summary,
        beforeUsage: pendingCompact.before,
        afterUsage: pendingCompact.after,
        harnessState,
        semanticHarnessState: pendingCompact.semanticHarnessState,
        goalBinding: activeGoal
          ? { goalId: activeGoal.goalId, revision: activeGoal.revision, state: activeGoal }
          : undefined,
        prepareSource,
        candidate: {
          fingerprint: pendingCompact.fingerprint,
          beforeTokens: pendingCompact.beforeTokens,
          afterTokens: pendingCompact.afterTokens,
          plan: pendingCompact.plan,
          semanticSummary: pendingCompact.semanticSummary,
          diagnostics: pendingCompact.diagnostics,
        },
      });
      committedCheckpointId = checkpoint.checkpointId;
      for (const type of ['compact_validate', 'compact_commit'] as const) {
        recordTraceEvent(events, sessionId, {
          turnId,
          type,
          checkpointId: committedCheckpointId,
          success: true,
          compactSourceMessageCount: sourceMessageCount,
          ...compactTrace,
        });
      }
      store.setState({ conversationHistory: checkpoint.modelHistory });
      recordTraceEvent(events, sessionId, {
        turnId,
        type: 'compact_boundary',
        checkpointId: committedCheckpointId,
        success: true,
        compactSourceMessageCount: sourceMessageCount,
        ...compactTrace,
      });
    } else {
      store.setState({
        conversationHistory: pendingCompact.modelHistory.filter(
          message => message.role !== 'system'
        ),
      });
    }

    store.setContextUsage(pendingCompact.after);
    if (sessionId) {
      recordTraceEvent(events, sessionId, {
        turnId,
        type: 'compact_completed',
        checkpointId: committedCheckpointId,
        ...compactTrace,
        note: pendingCompact.mode,
      });
    }
    events.append({
      role: 'status',
      title: 'auto-compact',
      statusTone: 'neutral',
      content: `Context reached ${pendingCompact.before.percent}% of the safe input budget. Agent core committed a ${pendingCompact.mode} compact checkpoint; current context is ${pendingCompact.after.percent}%.`,
    });
  } catch (error) {
    if (sessionId) {
      recordTraceEvent(events, sessionId, {
        turnId,
        type: 'compact_rollback',
        success: false,
        error: compactTraceError(error),
        ...compactTrace,
      });
      recordTraceEvent(events, sessionId, {
        turnId,
        type: 'compact_failed',
        ...compactTrace,
        error: compactTraceError(error),
        note: pendingCompact.mode,
      });
    }
    events.append({
      role: 'error',
      title: 'compact-failed',
      content: `Compact checkpoint failed; the previous model context remains active. ${error instanceof Error ? error.message : String(error)}`,
      errorLayer: 'runtime',
    });
  }
}
