import type {
  EditPreviewRequest,
  ModelPickerRequest,
  RuntimeLoopStats,
  RuntimeToolFinishedEvent,
  RuntimeToolStartedEvent,
  SessionPickerRequest,
  RuntimeTraceEvent,
  RuntimeHarnessDiagnostics,
  RuntimeSessionRestoredEvent,
  RuntimeSubtaskEvent,
  ResearchLifecycleEvent,
  ToolPermissionRequest,
  TranscriptAppendEntry,
  TranscriptEntry,
  UiEventSink,
} from './ui-events';
import type { GoalControlAction, GoalControlInput, GoalRuntimeEvent } from './goals/types';
import type { ToolConfirmationPolicy } from '../services/global-config';
import type { ToolPermissionScope } from '../services/tool-allowlist';

export type AgentRuntimeInput =
  | {
      type: 'submit';
      text: string;
      source?: 'composer' | 'picker' | 'programmatic';
      metadata?: Record<string, unknown>;
    }
  | {
      type: 'select_session';
      sessionId: string;
      allProjects?: boolean;
      source?: 'picker' | 'programmatic';
      metadata?: Record<string, unknown>;
    }
  | {
      type: 'permission_decision';
      requestId: string;
      approved: boolean;
      /** Defaults to `once` for backward-compatible renderer adapters. */
      scope?: ToolPermissionScope;
      source?: 'picker' | 'keyboard' | 'programmatic';
      metadata?: Record<string, unknown>;
    }
  | {
      type: 'interrupt';
      source?: 'keyboard' | 'command' | 'programmatic';
      metadata?: Record<string, unknown>;
    }
  | {
      type: 'clear_exit_intent';
      metadata?: Record<string, unknown>;
    }
  // v0.2.24: goal control input from /target commands.
  | {
      type: 'goal_control';
      action: GoalControlAction;
      payload?: GoalControlInput['payload'];
      source?: 'command' | 'programmatic';
    }
  | {
      type: 'permission_mode_change';
      value: ToolConfirmationPolicy;
      source?: 'command' | 'programmatic';
    };

export type AgentRuntimeSubmitResult =
  | { type: 'empty' }
  | { type: 'command_handled' }
  | { type: 'exit_requested' }
  | { type: 'started' }
  | { type: 'revision_requested' }
  | { type: 'command_queued'; commandId: string }
  | { type: 'command_rejected_busy'; commandId: string }
  | { type: 'command_ignored' };

export type AgentRuntimeInterruptResult =
  | { type: 'exit_requested' }
  | { type: 'interrupted' }
  | { type: 'exit_prompt' };

export type AgentRuntimeInputResult =
  | AgentRuntimeSubmitResult
  | AgentRuntimeInterruptResult
  | { type: 'exit_intent_cleared' }
  | { type: 'permission_decision_recorded' }
  | { type: 'permission_decision_ignored' }
  | { type: 'permission_decision_failed'; reason: string }
  | { type: 'permission_mode_changed' }
  | { type: 'permission_mode_invalid' };

export type AgentRuntimeEvent =
  | { type: 'transcript_append'; entry: TranscriptAppendEntry }
  | { type: 'transcript_update'; id: string; patch: Partial<Omit<TranscriptEntry, 'id'>> }
  | { type: 'transcript_finalize'; id: string; patch?: Partial<Omit<TranscriptEntry, 'id'>> }
  | { type: 'transcript_remove'; id: string }
  | { type: 'transcript_replace'; entries: TranscriptEntry[] }
  | { type: 'transcript_clear' }
  | { type: 'status_changed'; message: string }
  | { type: 'session_picker_requested'; request: SessionPickerRequest }
  | { type: 'model_picker_requested'; request: ModelPickerRequest }
  | { type: 'edit_preview_requested'; request: EditPreviewRequest }
  | { type: 'permission_requested'; request: ToolPermissionRequest }
  | { type: 'tool_started'; event: RuntimeToolStartedEvent }
  | { type: 'tool_finished'; event: RuntimeToolFinishedEvent }
  | { type: 'session_restored'; event: RuntimeSessionRestoredEvent }
  | { type: 'loop_stats_updated'; stats: RuntimeLoopStats }
  | { type: 'trace_event_recorded'; event: RuntimeTraceEvent }
  | { type: 'harness_diagnostics_updated'; diagnostics: RuntimeHarnessDiagnostics }
  | { type: 'subtask_event'; event: RuntimeSubtaskEvent }
  | { type: 'research_event'; event: ResearchLifecycleEvent }
  | { type: 'goal_event'; event: GoalRuntimeEvent }
  | { type: 'effort_event'; event: import('./ui-events').RuntimeEffortEvent }
  | { type: 'processing_changed'; processing: boolean }
  | { type: 'clear_view' }
  | { type: 'shutdown_requested'; reason?: string };

export interface AgentRuntimeEventSink {
  emit(event: AgentRuntimeEvent): string | void;
}

export function emitToUiEventSink(events: UiEventSink, event: AgentRuntimeEvent): string | void {
  switch (event.type) {
    case 'transcript_append':
      return events.append(event.entry);
    case 'transcript_update':
      events.update(event.id, event.patch);
      return undefined;
    case 'transcript_finalize':
      events.finalize(event.id, event.patch);
      return undefined;
    case 'transcript_remove':
      events.remove(event.id);
      return undefined;
    case 'transcript_replace':
      events.replaceTranscript(event.entries);
      return undefined;
    case 'transcript_clear':
      events.clearTranscript();
      return undefined;
    case 'status_changed':
      events.setStatus(event.message);
      return undefined;
    case 'session_picker_requested':
      events.showSessionPicker(event.request);
      return undefined;
    case 'model_picker_requested':
      events.showModelPicker?.(event.request);
      return undefined;
    case 'edit_preview_requested':
      events.showEditPreview(event.request);
      return undefined;
    case 'permission_requested':
      events.showPermissionRequest?.(event.request);
      return undefined;
    case 'tool_started':
      events.toolStarted?.(event.event);
      return undefined;
    case 'tool_finished':
      events.toolFinished?.(event.event);
      return undefined;
    case 'session_restored':
      events.sessionRestored?.(event.event);
      return undefined;
    case 'loop_stats_updated':
      events.loopStatsUpdated?.(event.stats);
      return undefined;
    case 'trace_event_recorded':
      events.traceEventRecorded?.(event.event);
      return undefined;
    case 'harness_diagnostics_updated':
      events.harnessDiagnosticsUpdated?.(event.diagnostics);
      return undefined;
    case 'subtask_event':
      events.subtaskEvent?.(event.event);
      return undefined;
    case 'research_event':
      events.researchEvent?.(event.event);
      return undefined;
    case 'goal_event':
      events.goalEvent?.(event.event);
      return undefined;
    case 'effort_event':
      events.effortEvent?.(event.event);
      return undefined;
    case 'processing_changed':
      events.setProcessing(event.processing);
      return undefined;
    case 'clear_view':
      events.clearView?.();
      return undefined;
    case 'shutdown_requested':
      events.shutdownRequested?.(event.reason);
      return undefined;
  }
}

export function createUiEventSinkFromAgentRuntimeEvents(sink: AgentRuntimeEventSink): UiEventSink {
  let nextSyntheticId = 1;

  return {
    append: entry => {
      const id = sink.emit({ type: 'transcript_append', entry });
      return typeof id === 'string' && id ? id : `runtime-entry-${nextSyntheticId++}`;
    },
    update: (id, patch) => {
      sink.emit({ type: 'transcript_update', id, patch });
    },
    finalize: (id, patch) => {
      sink.emit({ type: 'transcript_finalize', id, patch });
    },
    remove: id => {
      sink.emit({ type: 'transcript_remove', id });
    },
    replaceTranscript: entries => {
      sink.emit({ type: 'transcript_replace', entries });
    },
    clearTranscript: () => {
      sink.emit({ type: 'transcript_clear' });
    },
    setStatus: message => {
      sink.emit({ type: 'status_changed', message });
    },
    showSessionPicker: request => {
      sink.emit({ type: 'session_picker_requested', request });
    },
    showModelPicker: request => {
      sink.emit({ type: 'model_picker_requested', request });
    },
    showEditPreview: request => {
      sink.emit({ type: 'edit_preview_requested', request });
    },
    showPermissionRequest: request => {
      sink.emit({ type: 'permission_requested', request });
    },
    toolStarted: event => {
      sink.emit({ type: 'tool_started', event });
    },
    toolFinished: event => {
      sink.emit({ type: 'tool_finished', event });
    },
    sessionRestored: event => {
      sink.emit({ type: 'session_restored', event });
    },
    loopStatsUpdated: stats => {
      sink.emit({ type: 'loop_stats_updated', stats });
    },
    traceEventRecorded: event => {
      sink.emit({ type: 'trace_event_recorded', event });
    },
    harnessDiagnosticsUpdated: diagnostics => {
      sink.emit({ type: 'harness_diagnostics_updated', diagnostics });
    },
    subtaskEvent: event => {
      sink.emit({ type: 'subtask_event', event });
    },
    researchEvent: event => {
      sink.emit({ type: 'research_event', event });
    },
    goalEvent: event => {
      sink.emit({ type: 'goal_event', event });
    },
    effortEvent: event => {
      sink.emit({ type: 'effort_event', event });
    },
    setProcessing: processing => {
      sink.emit({ type: 'processing_changed', processing });
    },
    clearView: () => {
      sink.emit({ type: 'clear_view' });
    },
    shutdownRequested: reason => {
      sink.emit({ type: 'shutdown_requested', reason });
    },
  };
}

export function createAgentRuntimeEventSinkFromUiEvents(
  events: UiEventSink
): AgentRuntimeEventSink {
  return {
    emit: event => emitToUiEventSink(events, event),
  };
}
