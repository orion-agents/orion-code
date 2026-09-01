import type { Store } from '../framework/store';
import type { LoopContinuationAction, LoopStats } from '../framework/query';
import type { LLMService } from '../services/llm';
import type { CompactCoordinator } from '../services/compact';
import type { ModelCoordinator } from './model-coordinator';
import type { SessionComposerControlServiceV1 } from './session-composer-control';
import type { OrionCodeCLIConfig } from '../services/config';
import type { SessionMeta, SessionTraceEvent } from '../services/session-storage';
import type { RuntimeSubtaskEvent } from './subagents/types';
import type { ResearchLifecycleEvent } from './subagents/research-renderer';
import type { GoalRuntimeEvent } from './goals/types';
import type { McpServerDescriptorInputV1 } from './mcp';
import type { SkillDescriptorV1 } from './skills';
import type { ToolExternalAssertion } from '../framework/external-assertion';
import type { EffortLevel, EffortPreference, EffortScope } from '../services/effort';
import type { AgentRuntimeRunnerV1 } from './agent-runtime-runner';
import type { FirstPartyApprovalHandlerV1 } from './first-party-tool-services';
import type { OrionRuntimeDiagnosticsV1 } from './orion-runtime-v1';
import type {
  SettingsCoordinatorV1,
  SettingsDocumentViewV1,
  SettingsOperationV1,
  SettingsUpdateResultV1,
} from '../services/settings-coordinator';

/** Re-export so the runtime event protocol can reference subtask events. */
export type { RuntimeSubtaskEvent } from './subagents/types';
export type { ResearchLifecycleEvent } from './subagents/research-renderer';

export type RuntimeEffortEvent =
  | {
      type: 'effort_changed';
      requested: EffortPreference;
      scope: EffortScope;
      previous: EffortPreference;
      effective?: EffortLevel;
      appliesFrom: 'next-logical-request';
    }
  | {
      type: 'effort_resolved';
      model: string;
      provider: string;
      requested: EffortPreference;
      effective?: EffortLevel;
      supportedLevels: EffortLevel[];
    }
  | {
      type: 'effort_unavailable';
      model: string;
      provider: string;
      requested: EffortPreference;
      reason: string;
    };

export type TranscriptRole =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'system'
  | 'command'
  | 'error'
  | 'status';

export type ErrorLayer =
  | 'renderer'
  | 'runtime'
  | 'provider'
  | 'tool'
  | 'session'
  | 'memory'
  | 'mcp'
  | 'skills'
  | 'unknown';

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
  /** Auditable authorization decision applied before this invocation ran. */
  authorization?: ToolAuthorizationView;
  /** v0.2.23: Renderer-neutral tool output view for adaptive collapse. */
  outputView?: import('./tool-output-presentation').ToolOutputView;
}

export interface ToolAuthorizationView {
  approved: boolean;
  source: ToolAuthorizationSource;
  behavior?: import('../framework/tool').PermissionResult['behavior'];
  reason?: string;
}

/** Stable presentation vocabulary; execution-policy internals remain behind ToolGateway. */
export type ToolAuthorizationSource =
  | 'tool_policy'
  | 'config_allow'
  | 'config_deny'
  | 'user'
  | 'missing_confirmation'
  | 'drift_guard'
  | 'mode_auto'
  | 'mode_accept_edits'
  | 'allowlist_allow'
  | 'allowlist_deny'
  | 'allowlist_ask'
  | 'missing_risk_metadata'
  | 'risk_guard'
  | 'config_allow_blocked';

export interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  content: string;
  title?: string;
  errorLayer?: ErrorLayer;
  statusTone?: 'neutral' | 'warning';
  /** Actionable, renderer-neutral projection for an agent-loop budget stop. */
  budgetStop?: LoopBudgetStopView;
  /** Structured tool activity — set by tool event presenter so renderers
   *  consume typed data instead of parsing transcript text. */
  toolActivity?: StructuredToolActivity;
  /** Stable command identity shared by interactive, print, and protocol consumers. */
  command?: {
    id: string;
    name: string;
    source: import('../commands/types').CommandSource;
    success: boolean;
  };
}

export interface LoopBudgetStopView {
  schemaVersion: 1;
  kind: 'llm_request_limit' | 'tool_call_limit' | 'provider_preflight_limit' | 'other';
  reason: string;
  recoverable: true;
  statePreserved: true;
  source?: LoopStats['loopBudgetSource'];
  llmRequests: { current: number; maximum?: number };
  toolCalls: { current: number; maximum?: number };
  stopPoint?: {
    tool: string;
    summary?: string;
    success?: boolean;
  };
  actions: LoopContinuationAction[];
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

/** A single selectable model entry forwarded to renderer pickers. */
export interface ModelPickerCandidate {
  name: string;
  alias?: string;
  provider?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  source?: string;
  effortSupportedLevels?: EffortLevel[];
  effortCurrent?: EffortPreference;
}

/** Structured request to render an interactive model switcher. */
export interface ModelPickerRequest {
  models: ModelPickerCandidate[];
  currentModel?: string;
  title?: string;
  maxVisibleItems?: number;
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
  const defaults =
    renderer == null || isInteractiveRendererName(renderer)
      ? INTERACTIVE_RENDERER_CAPABILITIES
      : NON_INTERACTIVE_RENDERER_CAPABILITIES;

  return {
    structuredPickers: capabilities?.structuredPickers ?? defaults.structuredPickers,
    inlineProgress: capabilities?.inlineProgress ?? defaults.inlineProgress,
    suppressLegacyTokenMeta:
      capabilities?.suppressLegacyTokenMeta ?? defaults.suppressLegacyTokenMeta,
    extraAssistantSpacing: capabilities?.extraAssistantSpacing ?? defaults.extraAssistantSpacing,
    suppressAbortNotice: capabilities?.suppressAbortNotice ?? defaults.suppressAbortNotice,
  };
}

function isInteractiveRendererName(renderer: unknown): boolean {
  return (
    renderer === 'terminal' ||
    renderer === 'tui' ||
    renderer === 'web' ||
    renderer === 'legacy' ||
    renderer === 'v2'
  );
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
  /** Runtime-produced external assertion; never inferred from display text. */
  externalAssertion?: ToolExternalAssertion;
  /** Authorization provenance carried to every renderer and protocol consumer. */
  authorization?: ToolAuthorizationView;
  /** Exact ExecutionPolicy digest embedded in the validated durable ToolInvocationReceipt. */
  executionPolicyDigest?: string;
  /** Exact validated durable ToolInvocationReceipt digest; never recomputed by a renderer. */
  receiptDigest?: string;
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
  /** Number of recent transcript messages projected into the current renderer. */
  visibleTranscriptMessages?: number;
  /** True when older transcript messages remain durable but are outside the restored UI window. */
  transcriptTruncated?: boolean;
  /** Safe, user-visible recovery notices; never contains transcript content. */
  warnings?: readonly string[];
}

export interface FollowupQueueItem {
  id: string;
  text: string;
  queuedAt: number;
  /** Monotonic item-local CAS token for edit, move, and remove mutations. */
  revision: number;
}

export interface FollowupQueueSnapshot {
  items: readonly FollowupQueueItem[];
  limit: number;
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

/** Renderer-neutral durable Settings mutation accepted by the product composition root. */
export interface RuntimeSettingsMutationV1 {
  readonly requestId: string;
  readonly expectedRevision: string;
  readonly operations: readonly SettingsOperationV1[];
}

export interface OrionCodeUiRuntime extends RuntimeSessionAccessors {
  cwd: string;
  version: string;
  config: OrionCodeCLIConfig;
  store: Store;
  llm: LLMService | null;
  compactCoordinator?: CompactCoordinator;
  modelCoordinator?: ModelCoordinator;
  /** Sole Session-scoped mode/model/effort/permission control authority. */
  sessionComposerControls?: SessionComposerControlServiceV1;
  /** Creates the sole product runner after a renderer-neutral event sink exists. */
  createAgentRunner?: (
    events: UiEventSink,
    options: {
      readonly approvalHandler: FirstPartyApprovalHandlerV1;
      /** Defaults to true; Web snapshots history and opts out of replaying it through live events. */
      readonly replayHistoryOnRestore?: boolean;
    }
  ) => AgentRuntimeRunnerV1;
  /** Read-only v0.2 runtime diagnostics for `/harness explain`; never activates lazy providers. */
  getHarnessDiagnostics?: () => Promise<OrionRuntimeDiagnosticsV1 | undefined>;
  /** Descriptor-only Skill catalog for trusted product surfaces; never loads Skill bodies. */
  inspectSkills?: () => Promise<readonly SkillDescriptorV1[]>;
  /** Descriptor-only MCP catalog; never opens a transport. */
  inspectMcp?: () => readonly McpServerDescriptorInputV1[];
  /** Recreate the active Session Runtime after an idle-boundary configuration change. */
  rebindSessionRuntime?: () => Promise<void>;
  /** Sole product-owned Settings authority shared by Web, TUI and slash commands. */
  settingsCoordinator?: SettingsCoordinatorV1;
  /** Describe effective, secret-free Settings with the current Session override state. */
  describeSettings?: () => SettingsDocumentViewV1;
  /** Commit one CAS Settings mutation through the product-owned runtime hooks. */
  updateSettings?: (input: RuntimeSettingsMutationV1) => Promise<SettingsUpdateResultV1>;
  /** Apply the latest valid external Settings edit before a logical transition starts. */
  synchronizeSettings?: () => Promise<SettingsDocumentViewV1>;
  /** Bind the controller-owned logical-turn idle probe used by Settings admission. */
  bindSettingsRuntimeIdleProbe?: (probe: () => boolean) => () => void;
  isConfigured: boolean;
  shutdown: () => Promise<void>;
}

export interface UiEventSink {
  append: (entry: TranscriptAppendEntry) => string;
  update: (id: string, patch: Partial<Omit<TranscriptEntry, 'id'>>) => void;
  finalize: (id: string, patch?: Partial<Omit<TranscriptEntry, 'id'>>) => void;
  remove: (id: string) => void;
  replaceTranscript: (entries: TranscriptEntry[]) => void;
  clearTranscript: () => void;
  setStatus: (message: string) => void;
  showSessionPicker: (request: SessionPickerRequest) => void;
  showModelPicker?: (request: ModelPickerRequest) => void;
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
  /** Research packet lifecycle; all renderers receive the same ordered stream. */
  researchEvent?: (event: ResearchLifecycleEvent) => void;
  /** Shared Goal lifecycle event; renderers only project this event. */
  goalEvent?: (event: GoalRuntimeEvent) => void;
  effortEvent?: (event: RuntimeEffortEvent) => void;
  /** Ordered user follow-ups that run after the active logical request. */
  followupQueueChanged?: (snapshot: FollowupQueueSnapshot) => void;
  setProcessing: (processing: boolean) => void;
  /** Shared BUILD / PLAN / AUTO mode snapshot, including a deferred next-turn change. */
  agentModeChanged?: (snapshot: import('../framework/agent-mode').AgentModeSnapshot) => void;
  /** v0.1.1: request the renderer to clear its viewport without affecting session state. */
  clearView?: () => void;
  /** v0.1.1: request graceful shutdown with an optional reason string. */
  shutdownRequested?: (reason?: string) => void;
}
