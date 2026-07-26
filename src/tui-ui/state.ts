import type {
  EditPreviewRequest,
  RuntimeSubtaskEvent,
  RuntimeSessionRestoredEvent,
  RuntimeToolFinishedEvent,
  RuntimeToolStartedEvent,
  SessionPickerRequest,
  ToolPermissionRequest,
  TranscriptAppendEntry,
  TranscriptEntry,
  UiEventSink,
} from '../runtime/ui-events';
import {
  createPromptState,
  createSessionRestoredView,
  subtaskEventToTimelineEntry,
  type PromptState,
  type StatusSnapshot,
  type SubtaskTimelineEntry,
} from '../runtime/ui-view-model';
import type { TuiPickerItem } from './pickers';

/** Maximum subtask timeline entries (bounded for long-session safety). */
const MAX_SUBTASK_TIMELINE = 100;
const MAX_RECENT_TOOL_DETAILS = 512;

export type TuiPromptState = Pick<PromptState, 'value' | 'cursor'>;

export interface TuiTranscriptRecord extends TranscriptEntry {
  finalized: boolean;
  revision: number;
}

/** Structured status state (replaces renderer-local string concatenation). */
export interface TuiStatusState {
  phase: 'ready' | 'running' | 'error' | 'interrupted';
  snapshot: StatusSnapshot | null;
  message?: string;
  activeTools: number;
  activeSubtasks: number;
  committedTranscriptEntries: number;
}

export type TuiRuntimeToolEvent =
  | ({ type: 'started' } & RuntimeToolStartedEvent)
  | ({ type: 'finished' } & RuntimeToolFinishedEvent);

export type TuiOverlayState =
  | { type: 'sessions'; request: SessionPickerRequest; selectedIndex: number }
  | { type: 'edit'; request: EditPreviewRequest; selectedIndex: number }
  | { type: 'permission'; request: ToolPermissionRequest; selectedIndex: number }
  | { type: 'commands'; query: string; items: TuiPickerItem[]; selectedIndex: number }
  | { type: 'files'; base: string; query: string; items: TuiPickerItem[]; selectedIndex: number }
  | { type: 'shortcuts' }
  | null;

// --- v0.2.23: Tool Inspector state ---

export interface ToolInspectorState {
  selectedIndex: number;
  expandedCallIds: string[];
  listOffset: number;
  detailOffset: number;
  searchQuery: string;
  searchDirection: 1 | -1;
  loadingCallIds: string[];
  error?: string;
}

export interface TuiUiState {
  transcript: TuiTranscriptRecord[];
  runtimeToolEvents: TuiRuntimeToolEvent[];
  /** R8: typed subagent timeline, keyed by taskId (last write wins). */
  subtaskTimeline: SubtaskTimelineEntry[];
  committableTranscriptCount: number;
  queuedTranscriptCount: number;
  committedTranscriptCount: number;
  transcriptGeneration: number;
  prompt: TuiPromptState;
  statusMessage: string;
  /** Structured status (v0.2.21 slice 5). */
  statusState: TuiStatusState;
  processing: boolean;
  overlay: TuiOverlayState;
  /** v0.2.23: Tool output view mode for adaptive collapse. */
  toolOutputViewMode: 'adaptive' | 'collapsed' | 'full';
  /** v0.2.23: Bounded recent tool detail summaries (max 512). */
  recentToolDetails: TuiToolDetailSummary[];
  /** v0.2.23: Inspector state (null when closed). */
  inspector: ToolInspectorState | null;
}

export interface TuiToolDetailSummary {
  callId: string;
  sequence: number;
  toolName: string;
  outputBytes: number;
  state: 'success' | 'error' | 'skipped';
  summary?: string;
  artifactId?: string;
}

export type TuiUiAction =
  | { type: 'appendTranscript'; entry: TranscriptAppendEntry & { id: string } }
  | { type: 'updateTranscript'; id: string; patch: Partial<Omit<TranscriptEntry, 'id'>> }
  | { type: 'finalizeTranscript'; id: string; patch?: Partial<Omit<TranscriptEntry, 'id'>> }
  | { type: 'removeTranscript'; id: string }
  | { type: 'replaceTranscript'; entries: TranscriptEntry[] }
  | { type: 'clearTranscript' }
  | { type: 'setPrompt'; value: string; cursor?: number }
  | { type: 'setStatus'; message: string }
  | { type: 'setStatusSnapshot'; snapshot: StatusSnapshot; phase?: TuiStatusState['phase']; message?: string }
  | { type: 'setProcessing'; processing: boolean }
  | { type: 'showSessionPicker'; request: SessionPickerRequest }
  | { type: 'showEditPreview'; request: EditPreviewRequest }
  | { type: 'showPermissionRequest'; request: ToolPermissionRequest }
  | { type: 'toolStarted'; event: RuntimeToolStartedEvent }
  | { type: 'toolFinished'; event: RuntimeToolFinishedEvent }
  | { type: 'subtaskEvent'; event: RuntimeSubtaskEvent }
  | { type: 'showCommandPalette'; query: string; items: TuiPickerItem[] }
  | { type: 'showFilePicker'; base: string; query: string; items: TuiPickerItem[] }
  | { type: 'showShortcuts' }
  | { type: 'moveOverlaySelection'; delta: number }
  | { type: 'closeOverlay' }
  // --- v0.2.23: Tool Inspector actions ---
  | { type: 'setToolOutputViewMode'; mode: 'adaptive' | 'collapsed' | 'full' }
  | { type: 'openToolInspector' }
  | { type: 'closeToolInspector' }
  | { type: 'moveToolInspectorSelection'; delta: number }
  | { type: 'setToolInspectorSelection'; index: number }
  | { type: 'toggleToolInspectorEntry'; callId: string }
  | { type: 'toggleAllToolInspectorEntries' }
  | { type: 'scrollToolInspector'; delta: number }
  | { type: 'setToolInspectorSearch'; query: string }
  | { type: 'toolDetailLoaded'; callId: string }
  | { type: 'toolDetailLoadFailed'; callId: string; error: string };

export const initialTuiUiState: TuiUiState = {
  transcript: [],
  runtimeToolEvents: [],
  subtaskTimeline: [],
  committableTranscriptCount: 0,
  queuedTranscriptCount: 0,
  committedTranscriptCount: 0,
  transcriptGeneration: 0,
  prompt: { value: '', cursor: 0 },
  statusMessage: '',
  statusState: {
    phase: 'ready',
    snapshot: null,
    activeTools: 0,
    activeSubtasks: 0,
    committedTranscriptEntries: 0,
  },
  processing: false,
  overlay: null,
  // v0.2.23
  toolOutputViewMode: 'adaptive',
  recentToolDetails: [],
  inspector: null,
};

export function tuiUiReducer(state: TuiUiState, action: TuiUiAction): TuiUiState {
  switch (action.type) {
    case 'appendTranscript': {
      const { live: _live, ...entry } = action.entry;
      void _live;
      return commitStaticTranscriptPrefix({
        ...state,
        transcript: [
          ...state.transcript,
          {
            ...entry,
            finalized: !isLiveTranscriptAppend(action.entry),
            revision: 1,
          },
        ],
      });
    }

    case 'updateTranscript':
      return {
        ...state,
        transcript: state.transcript.map(entry => (
          entry.id === action.id
            ? { ...entry, ...action.patch, revision: entry.revision + 1 }
            : entry
        )),
      };

    case 'finalizeTranscript':
      return commitStaticTranscriptPrefix({
        ...state,
        transcript: state.transcript.map(entry => (
          entry.id === action.id
            ? {
              ...entry,
              ...action.patch,
              finalized: true,
              revision: entry.revision + (action.patch ? 1 : 0),
            }
            : entry
        )),
      });

    case 'removeTranscript':
      return recomputeStaticTranscriptPrefix({
        ...state,
        transcript: state.transcript.filter(entry => entry.id !== action.id),
      });

    case 'replaceTranscript': {
      // Restored history is immutable. Mark every entry finalized so no stale
      // live tail can permanently block commits from subsequent turns.
      return {
        ...state,
        transcript: action.entries.map(entry => ({
          ...entry,
          finalized: true,
          revision: 1,
        })),
        committableTranscriptCount: action.entries.length,
        queuedTranscriptCount: 0,
        committedTranscriptCount: 0,
        transcriptGeneration: state.transcriptGeneration + 1,
        recentToolDetails: mergeRecentToolDetails(
          state.recentToolDetails,
          action.entries.flatMap(toolDetailsFromTranscriptEntry),
        ),
      };
    }

    case 'clearTranscript':
      return {
        ...state,
        transcript: [],
        committableTranscriptCount: 0,
        queuedTranscriptCount: 0,
        committedTranscriptCount: 0,
        transcriptGeneration: state.transcriptGeneration + 1,
      };

    case 'setPrompt':
      {
        const prompt = createPromptState({
          value: action.value,
          cursor: action.cursor ?? action.value.length,
        });
        return {
          ...state,
          prompt: {
            value: prompt.value,
            cursor: prompt.cursor,
          },
        };
      }

    case 'setStatus':
      return {
        ...state,
        statusMessage: action.message,
        statusState: { ...state.statusState, message: action.message },
      };

    case 'setStatusSnapshot': {
      const activeTools = countActiveTools(state.runtimeToolEvents);
      const activeSubtasks = countActiveSubtasks(state.subtaskTimeline);
      return {
        ...state,
        statusState: {
          phase: action.phase ?? state.statusState.phase,
          snapshot: action.snapshot,
          message: action.message ?? state.statusState.message,
          activeTools,
          activeSubtasks,
          committedTranscriptEntries: state.committedTranscriptCount,
        },
      };
    }

    case 'setProcessing':
      return {
        ...state,
        processing: action.processing,
        statusState: {
          ...state.statusState,
          phase: action.processing ? 'running' : 'ready',
        },
      };

    case 'showSessionPicker':
      return {
        ...state,
        overlay: { type: 'sessions', request: action.request, selectedIndex: 0 },
      };

    case 'showEditPreview':
      return {
        ...state,
        overlay: { type: 'edit', request: action.request, selectedIndex: 0 },
      };

    case 'showPermissionRequest':
      return {
        ...state,
        overlay: { type: 'permission', request: action.request, selectedIndex: 0 },
      };

    case 'toolStarted': {
      const next = appendRuntimeToolEvent(state, { type: 'started', ...action.event });
      return updateStatusCounts(next);
    }

    case 'toolFinished': {
      const event = action.event;
      const detail: TuiToolDetailSummary = {
        callId: event.callId,
        sequence: event.sequence,
        toolName: event.name,
        outputBytes: event.outputBytes ?? 0,
        state: event.skipped ? 'skipped' : event.success ? 'success' : 'error',
        summary: event.summary ?? event.error,
        artifactId: event.artifactRef?.id,
      };
      const next = appendRuntimeToolEvent({
        ...state,
        recentToolDetails: mergeRecentToolDetails(state.recentToolDetails, [detail]),
      }, { type: 'finished', ...event });
      return updateStatusCounts(next);
    }

    case 'subtaskEvent': {
      // R8: update the typed timeline, keyed by taskId (last write wins so
      // state advances queued -> running -> terminal without duplicates).
      const entry = subtaskEventToTimelineEntry(action.event);
      const existing = state.subtaskTimeline.filter(e => e.taskId !== entry.taskId);
      let timeline = [...existing, entry];
      // Cap to prevent unbounded growth in long sessions.
      if (timeline.length > MAX_SUBTASK_TIMELINE) {
        timeline = timeline.slice(timeline.length - MAX_SUBTASK_TIMELINE);
      }
      const next = { ...state, subtaskTimeline: timeline };
      return updateStatusCounts(next);
    }

    case 'showCommandPalette':
      return {
        ...state,
        overlay: {
          type: 'commands',
          query: action.query,
          items: action.items,
          selectedIndex: clampNumber(
            state.overlay?.type === 'commands' ? state.overlay.selectedIndex : 0,
            0,
            Math.max(0, action.items.length - 1)
          ),
        },
      };

    case 'showFilePicker':
      return {
        ...state,
        overlay: {
          type: 'files',
          base: action.base,
          query: action.query,
          items: action.items,
          selectedIndex: clampNumber(
            state.overlay?.type === 'files' ? state.overlay.selectedIndex : 0,
            0,
            Math.max(0, action.items.length - 1)
          ),
        },
      };

    case 'showShortcuts':
      return { ...state, overlay: { type: 'shortcuts' } };

    case 'moveOverlaySelection': {
      if (!state.overlay || state.overlay.type === 'shortcuts') return state;
      const lastIndex = Math.max(0, overlayItemCount(state.overlay) - 1);
      const selectedIndex = clampNumber(state.overlay.selectedIndex + action.delta, 0, lastIndex);
      return {
        ...state,
        overlay: { ...state.overlay, selectedIndex },
      };
    }

    case 'closeOverlay':
      return { ...state, overlay: null };

    // --- v0.2.23: Tool Inspector actions ---

    case 'setToolOutputViewMode':
      return { ...state, toolOutputViewMode: action.mode };

    case 'openToolInspector':
      return {
        ...state,
        inspector: {
          selectedIndex: Math.max(0, state.recentToolDetails.length - 1),
          expandedCallIds: [],
          listOffset: 0,
          detailOffset: 0,
          searchQuery: '',
          searchDirection: 1,
          loadingCallIds: [],
        },
      };

    case 'closeToolInspector':
      return { ...state, inspector: null };

    case 'moveToolInspectorSelection': {
      if (!state.inspector) return state;
      const newIndex = clampNumber(
        state.inspector.selectedIndex + action.delta,
        0,
        Math.max(0, state.recentToolDetails.length - 1),
      );
      return {
        ...state,
        inspector: { ...state.inspector, selectedIndex: newIndex, detailOffset: 0 },
      };
    }

    case 'setToolInspectorSelection': {
      if (!state.inspector) return state;
      return {
        ...state,
        inspector: {
          ...state.inspector,
          selectedIndex: Math.max(0, action.index),
          detailOffset: 0,
        },
      };
    }

    case 'toggleToolInspectorEntry': {
      if (!state.inspector) return state;
      const expanded = state.inspector.expandedCallIds.includes(action.callId)
        ? state.inspector.expandedCallIds.filter(id => id !== action.callId)
        : [...state.inspector.expandedCallIds, action.callId];
      return {
        ...state,
        inspector: { ...state.inspector, expandedCallIds: expanded },
      };
    }

    case 'toggleAllToolInspectorEntries': {
      if (!state.inspector) return state;
      const allExpanded = state.inspector.expandedCallIds.length === state.recentToolDetails.length;
      return {
        ...state,
        inspector: {
          ...state.inspector,
          expandedCallIds: allExpanded ? [] : state.recentToolDetails.map(e => e.callId),
        },
      };
    }

    case 'scrollToolInspector': {
      if (!state.inspector) return state;
      return {
        ...state,
        inspector: {
          ...state.inspector,
          detailOffset: Math.max(0, state.inspector.detailOffset + action.delta),
        },
      };
    }

    case 'setToolInspectorSearch': {
      if (!state.inspector) return state;
      return {
        ...state,
        inspector: {
          ...state.inspector,
          searchQuery: action.query,
          searchDirection: action.query === state.inspector.searchQuery
            ? (state.inspector.searchDirection === 1 ? -1 : 1) as 1 | -1
            : 1,
          selectedIndex: 0,
          detailOffset: 0,
        },
      };
    }

    case 'toolDetailLoaded': {
      if (!state.inspector) return state;
      return {
        ...state,
        inspector: {
          ...state.inspector,
          loadingCallIds: state.inspector.loadingCallIds.filter(id => id !== action.callId),
          error: undefined,
        },
      };
    }

    case 'toolDetailLoadFailed': {
      if (!state.inspector) return state;
      return {
        ...state,
        inspector: {
          ...state.inspector,
          loadingCallIds: state.inspector.loadingCallIds.filter(id => id !== action.callId),
          error: action.error,
        },
      };
    }
  }
}

export function staticTuiTranscriptEntries(state: TuiUiState): TranscriptEntry[] {
  return staticTuiTranscriptRecords(state).map(stripRecord);
}

export function liveTuiTranscriptEntries(state: TuiUiState): TranscriptEntry[] {
  return liveTuiTranscriptRecords(state).map(stripRecord);
}

/** Entries ready to commit (committable but not yet queued). */
export function pendingCommitEntries(state: TuiUiState): TranscriptEntry[] {
  return pendingCommitRecords(state).map(stripRecord);
}

/** Renderer-local records retain revision/finalized metadata for styled layout and caching. */
export function staticTuiTranscriptRecords(state: TuiUiState): TuiTranscriptRecord[] {
  return state.transcript.slice(0, state.committableTranscriptCount);
}

export function liveTuiTranscriptRecords(state: TuiUiState): TuiTranscriptRecord[] {
  return state.transcript.slice(state.committableTranscriptCount);
}

/** Renderer-local records ready to commit (committable but not yet queued). */
export function pendingCommitRecords(state: TuiUiState): TuiTranscriptRecord[] {
  return state.transcript.slice(state.queuedTranscriptCount, state.committableTranscriptCount);
}

/** Advance the queued boundary after enqueueing a commit batch. */
export function markTranscriptQueued(state: TuiUiState, count: number): TuiUiState {
  return { ...state, queuedTranscriptCount: state.queuedTranscriptCount + count };
}

/** Advance the committed boundary after successful surface write. */
export function markTranscriptCommitted(state: TuiUiState, count: number): TuiUiState {
  return { ...state, committedTranscriptCount: state.committedTranscriptCount + count };
}

export interface TranscriptCommitAcknowledgement {
  generation: number;
  recordIds: string[];
}

/** Release only the exact finalized prefix confirmed by the surface write. */
export function acknowledgeTranscriptCommit(
  state: TuiUiState,
  acknowledgement: TranscriptCommitAcknowledgement,
): { state: TuiUiState; accepted: boolean } {
  if (acknowledgement.generation !== state.transcriptGeneration) {
    return { state, accepted: false };
  }
  const count = acknowledgement.recordIds.length;
  if (count === 0 || count > state.queuedTranscriptCount || count > state.committableTranscriptCount) {
    return { state, accepted: false };
  }
  const prefix = state.transcript.slice(0, count);
  if (prefix.some((entry, index) => !entry.finalized || entry.id !== acknowledgement.recordIds[index])) {
    return { state, accepted: false };
  }
  return {
    accepted: true,
    state: {
      ...state,
      transcript: state.transcript.slice(count),
      committableTranscriptCount: state.committableTranscriptCount - count,
      queuedTranscriptCount: state.queuedTranscriptCount - count,
      committedTranscriptCount: 0,
    },
  };
}

export function createTuiUiEventSink(
  dispatch: (action: TuiUiAction) => void,
  options: { idFactory?: () => string } = {}
): UiEventSink {
  let nextId = 1;
  const idFactory = options.idFactory ?? (() => `tui-${nextId++}`);

  return {
    append: entry => {
      const id = idFactory();
      dispatch({ type: 'appendTranscript', entry: { id, ...entry } });
      return id;
    },
    update: (id, patch) => dispatch({ type: 'updateTranscript', id, patch }),
    finalize: (id, patch) => dispatch({ type: 'finalizeTranscript', id, patch }),
    remove: id => dispatch({ type: 'removeTranscript', id }),
    replaceTranscript: entries => dispatch({ type: 'replaceTranscript', entries }),
    clearTranscript: () => dispatch({ type: 'clearTranscript' }),
    setStatus: message => dispatch({ type: 'setStatus', message }),
    showSessionPicker: request => dispatch({ type: 'showSessionPicker', request }),
    showEditPreview: request => dispatch({ type: 'showEditPreview', request }),
    showPermissionRequest: request => dispatch({ type: 'showPermissionRequest', request }),
    toolStarted: event => dispatch({ type: 'toolStarted', event }),
    toolFinished: event => dispatch({ type: 'toolFinished', event }),
    sessionRestored: (event: RuntimeSessionRestoredEvent) => {
      const view = createSessionRestoredView(event);
      const lines = [view.headline];
      if (view.summary) lines.push(`Summary: ${view.summary}`);
      if (view.summaryGeneratedAt) {
        lines.push(
          `Generated: ${new Date(view.summaryGeneratedAt).toLocaleString()} (${view.checkpointId ? 'compact checkpoint' : 'generated on resume'})`
        );
      }
      if (typeof view.summaryCoveredMessages === 'number') {
        lines.push(`Covers: ${view.summaryCoveredMessages} source messages`);
      }
      lines.push(
        `✔ Restored ${event.restoredMessages} model-context messages / ${event.transcriptMessages ?? event.messageCount ?? event.restoredMessages} transcript messages`
      );
      const id = idFactory();
      dispatch({
        type: 'appendTranscript',
        entry: {
          id,
          role: 'status',
          title: 'resume',
          content: lines.join('\n'),
        },
      });
    },
    subtaskEvent: event => dispatch({ type: 'subtaskEvent', event }),
    setProcessing: processing => dispatch({ type: 'setProcessing', processing }),
  };
}

function appendRuntimeToolEvent(state: TuiUiState, event: TuiRuntimeToolEvent): TuiUiState {
  // Keyed by (callId, type) so a re-emitted event (e.g. a status update that
  // re-fires `started`) replaces its prior copy instead of appending a
  // duplicate, while the distinct started/finished lifecycle events for the
  // same callId are both retained. Active-tool counting (countActiveTools)
  // already relies on the callId/type pairing, so this keeps the feed and the
  // count consistent.
  const key = `${event.callId}:${event.type}`;
  const withoutDuplicate = state.runtimeToolEvents.filter(e => `${e.callId}:${e.type}` !== key);
  const next = [...withoutDuplicate, event];
  return {
    ...state,
    runtimeToolEvents: next.slice(-MAX_RECENT_TOOL_DETAILS * 2),
  };
}

function mergeRecentToolDetails(
  current: TuiToolDetailSummary[],
  incoming: TuiToolDetailSummary[],
): TuiToolDetailSummary[] {
  const byCallId = new Map(current.map(detail => [detail.callId, detail]));
  for (const detail of incoming) {
    byCallId.delete(detail.callId);
    byCallId.set(detail.callId, detail);
  }
  return Array.from(byCallId.values()).slice(-MAX_RECENT_TOOL_DETAILS);
}

function toolDetailsFromTranscriptEntry(entry: TranscriptEntry): TuiToolDetailSummary[] {
  const activity = entry.toolActivity;
  const detailRef = activity?.outputView?.detailRef;
  if (!activity || !detailRef) return [];
  const state = activity.state === 'error'
    ? 'error'
    : activity.state === 'skipped'
      ? 'skipped'
      : 'success';
  return [{
    callId: detailRef.callId,
    sequence: detailRef.sequence,
    toolName: activity.name,
    outputBytes: detailRef.outputBytes,
    state,
    summary: activity.summary ?? activity.outputView?.summary,
    artifactId: detailRef.artifactId,
  }];
}

/** Count tools with a 'started' event but no matching 'finished' event. */
function countActiveTools(events: TuiRuntimeToolEvent[]): number {
  const finished = new Set<string>();
  let active = 0;
  for (const ev of events) {
    if (ev.type === 'finished') {
      finished.add(ev.callId);
    }
  }
  for (const ev of events) {
    if (ev.type === 'started' && !finished.has(ev.callId)) {
      active += 1;
    }
  }
  return active;
}

/** Count subtasks in a non-terminal state (queued/running). */
function countActiveSubtasks(timeline: SubtaskTimelineEntry[]): number {
  return timeline.filter(e => e.state === 'queued' || e.state === 'running').length;
}

/** Recompute status counts after tool/subtask state changes. */
function updateStatusCounts(state: TuiUiState): TuiUiState {
  return {
    ...state,
    statusState: {
      ...state.statusState,
      activeTools: countActiveTools(state.runtimeToolEvents),
      activeSubtasks: countActiveSubtasks(state.subtaskTimeline),
      committedTranscriptEntries: state.committedTranscriptCount,
    },
  };
}

function isLiveTranscriptAppend(entry: TranscriptAppendEntry): boolean {
  return entry.live === true || entry.role === 'tool';
}

function commitStaticTranscriptPrefix(state: TuiUiState): TuiUiState {
  let committableTranscriptCount = state.committableTranscriptCount;
  while (
    committableTranscriptCount < state.transcript.length
    && state.transcript[committableTranscriptCount]?.finalized
  ) {
    committableTranscriptCount += 1;
  }
  return committableTranscriptCount === state.committableTranscriptCount
    ? state
    : { ...state, committableTranscriptCount };
}

function recomputeStaticTranscriptPrefix(state: TuiUiState): TuiUiState {
  let committableTranscriptCount = 0;
  while (
    committableTranscriptCount < state.transcript.length
    && state.transcript[committableTranscriptCount]?.finalized
  ) {
    committableTranscriptCount += 1;
  }
  return { ...state, committableTranscriptCount };
}

function stripRecord(entry: TuiTranscriptRecord): TranscriptEntry {
  const { finalized: _finalized, revision: _revision, ...rest } = entry;
  void _finalized;
  void _revision;
  return rest;
}

function overlayItemCount(overlay: Exclude<TuiOverlayState, null | { type: 'shortcuts' }>): number {
  if (overlay.type === 'sessions') return overlay.request.sessions.length;
  if (overlay.type === 'permission') return 2;
  if (overlay.type === 'edit') return overlay.request.candidates.length;
  return overlay.items.length;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
