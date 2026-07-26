import type { OpenHorseRuntime } from '../init';
import type { Store } from '../framework/store';
import type { LoopStats } from '../framework';
import type { LLMService } from '../services/llm';
import type { CompactCoordinator } from '../services/compact';
import type { OpenHorseCLIConfig } from '../services/config';
import type { SessionMeta, SessionTraceEvent } from '../services/session-storage';
import type { RuntimeSubtaskEvent } from './subagents/types';

/** Re-export so the runtime event protocol can reference subtask events. */
export type { RuntimeSubtaskEvent } from './subagents/types';

export type TranscriptRole = 'user' | 'assistant' | 'tool' | 'system' | 'command' | 'error' | 'status';

export type ErrorLayer = 'renderer' | 'runtime' | 'provider' | 'tool' | 'session' | 'memory' | 'mcp' | 'skills' | 'unknown';

export interface StructuredToolActivity {
  state: 'queued' | 'running' | 'success' | 'error' | 'skipped' | 'requested';
  name: string;
  detail: string;
  command?: string;
  duration?: string;
  summary?: string;
  outputBytes?: number;
  /** Structured display body. When present, TUI ignores legacy TranscriptEntry.content. */
  body?: string;
  error?: string;
  seq?: number;
  artifactHint?: string;
  callId?: string;
  turnId?: string;
  /** v0.2.23: Renderer-neutral tool output view for adaptive collapse. */
  outputView?: import('./tool-output-presentation').ToolOutputView;
}

export interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  content: string;
  title?: string;
  errorLayer?: ErrorLayer;
  statusTone?: 'neutral' | 'warning';
  /** Structured tool activity — set by tool event presenter so renderers
   *  consume typed data instead of parsing transcript text. */
  toolActivity?: StructuredToolActivity;
}

export interface TranscriptAppendEntry extends Omit<TranscriptEntry, 'id'> {
  live?: boolean;
}

export interface SessionPickerRequest {
  sessions: SessionMeta[];
  title: string;
  showProject?: boolean;
  allProjects?: boolean;
  maxVisibleItems?: number;
  moreCount?: number;
}

export interface EditPreviewCandidate {
  index: number;
  line: number;
  match: string;
  contextBefore: string;
  contextAfter: string;
  isReplaceAll: boolean;
}

export interface EditPreviewRequest {
  path: string;
  newString: string;
  kind: 'exact' | 'fuzzy';
  strategy?: string;
  candidates: EditPreviewCandidate[];
  width?: number;
}

export interface UiRendererCapabilities {
  structuredPickers?: boolean;
  inlineProgress?: boolean;
  suppressLegacyTokenMeta?: boolean;
  extraAssistantSpacing?: boolean;
  suppressAbortNotice?: boolean;
}

export type ResolvedUiRendererCapabilities = Required<UiRendererCapabilities>;

const INTERACTIVE_RENDERER_CAPABILITIES: ResolvedUiRendererCapabilities = {
  structuredPickers: true,
  inlineProgress: true,
  suppressLegacyTokenMeta: true,
  extraAssistantSpacing: true,
  suppressAbortNotice: true,
};

const NON_INTERACTIVE_RENDERER_CAPABILITIES: ResolvedUiRendererCapabilities = {
  structuredPickers: false,
  inlineProgress: false,
  suppressLegacyTokenMeta: false,
  extraAssistantSpacing: false,
  suppressAbortNotice: false,
};

export function resolveUiRendererCapabilities(
  capabilities?: UiRendererCapabilities,
  renderer?: unknown
): ResolvedUiRendererCapabilities {
  const defaults = renderer == null || isInteractiveRendererName(renderer)
    ? INTERACTIVE_RENDERER_CAPABILITIES
    : NON_INTERACTIVE_RENDERER_CAPABILITIES;

  return {
    structuredPickers: capabilities?.structuredPickers ?? defaults.structuredPickers,
    inlineProgress: capabilities?.inlineProgress ?? defaults.inlineProgress,
    suppressLegacyTokenMeta: capabilities?.suppressLegacyTokenMeta ?? defaults.suppressLegacyTokenMeta,
    extraAssistantSpacing: capabilities?.extraAssistantSpacing ?? defaults.extraAssistantSpacing,
    suppressAbortNotice: capabilities?.suppressAbortNotice ?? defaults.suppressAbortNotice,
  };
}

function isInteractiveRendererName(renderer: unknown): boolean {
  return renderer === 'terminal'
    || renderer === 'tui'
    || renderer === 'ink'
    || renderer === 'legacy'
    || renderer === 'v2';
}

export interface ToolPermissionRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
  reason?: string;
  abortSignal?: AbortSignal;
}

export interface RuntimeToolStartedEvent {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  /** Monotonic tool invocation sequence across the session (1-based). */
  sequence: number;
  batchCount?: number;
  batchIndex?: number;
}

export interface RuntimeToolFinishedEvent {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  success: boolean;
  skipped?: boolean;
  duration: number;
  summary?: string;
  error?: string;
  outputBytes?: number;
  artifactRef?: { id: string; outputBytes: number };
  /** Monotonic tool invocation sequence across the session (1-based). */
  sequence: number;
  batchCount?: number;
  batchIndex?: number;
}

export interface RuntimeSessionRestoredEvent {
  sessionId: string;
  projectPath: string;
  model: string;
  restoredMessages: number;
  messageCount?: number;
  summary?: string;
  summaryGeneratedAt?: number;
  summarySource?: 'llm' | 'heuristic' | 'resume_heuristic';
  summaryCoveredMessages?: number;
  checkpointId?: string;
  transcriptMessages?: number;
}

export type RuntimeLoopStats = LoopStats;
export type RuntimeTraceEvent = SessionTraceEvent;

export interface RuntimeHarnessDiagnostics {
  taskEpoch?: number;
  rootObjective?: string;
  activeInstruction?: string;
  openQuestions?: string[];
  diagnostics?: string[];
  ledgerSize: number;
  evidenceSize: number;
  turnSummaryCount: number;
  promptAssembly?: {
    modelId: string;
    estimatedTokens: number;
    budgetTokens: number;
    sections: string[];
    includedEvidence: number;
    omittedEvidence: number;
  };
}

export interface RuntimeSessionAccessors {
  ensureSession: () => SessionMeta;
  setSession: (session: SessionMeta | null) => void;
  getSession: () => SessionMeta | null;
}

export interface OrionCodeUiRuntime extends RuntimeSessionAccessors {
  cwd: string;
  version: string;
  config: OpenHorseCLIConfig;
  store: Store;
  llm: LLMService | null;
  compactCoordinator?: CompactCoordinator;
  runtime: OpenHorseRuntime;
  isConfigured: boolean;
  mcpReady?: Promise<void>;
  shutdown: () => Promise<void>;
}

/** @deprecated Use OrionCodeUiRuntime. */
export type OpenHorseUiRuntime = OrionCodeUiRuntime;

/** @deprecated Use OrionCodeUiRuntime. Runtime context is shared by every renderer. */
export type OpenHorseInkRuntime = OrionCodeUiRuntime;

export interface UiEventSink {
  append: (entry: TranscriptAppendEntry) => string;
  update: (id: string, patch: Partial<Omit<TranscriptEntry, 'id'>>) => void;
  finalize: (id: string, patch?: Partial<Omit<TranscriptEntry, 'id'>>) => void;
  remove: (id: string) => void;
  replaceTranscript: (entries: TranscriptEntry[]) => void;
  clearTranscript: () => void;
  setStatus: (message: string) => void;
  showSessionPicker: (request: SessionPickerRequest) => void;
  showEditPreview: (request: EditPreviewRequest) => void;
  showPermissionRequest?: (request: ToolPermissionRequest) => void;
  toolStarted?: (event: RuntimeToolStartedEvent) => void;
  toolFinished?: (event: RuntimeToolFinishedEvent) => void;
  sessionRestored?: (event: RuntimeSessionRestoredEvent) => void;
  loopStatsUpdated?: (stats: LoopStats) => void;
  traceEventRecorded?: (event: SessionTraceEvent) => void;
  harnessDiagnosticsUpdated?: (diagnostics: RuntimeHarnessDiagnostics) => void;
  /** Subagent lifecycle event (queued/running/completed/...). Renderer-independent. */
  subtaskEvent?: (event: RuntimeSubtaskEvent) => void;
  setProcessing: (processing: boolean) => void;
}
