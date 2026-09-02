import type {
  WebBootstrapV1 as ProtocolWebBootstrapV1,
  WebComposerControlStateV1,
  WebModelCatalogPageV1,
  WebEventEnvelopeV1 as ProtocolWebEventEnvelopeV1,
  WebMcpServerSummaryV1,
  WebFileContentPageV1,
  WebFileNodeV1,
  WebFileTreePageV1,
  WebGitDiffPageV1,
  WebGitFileV1,
  WebGitLogPageV1,
  WebGitStatusV1,
  WebReviewSnapshotV1,
  WebSessionSummaryV1,
  WebSessionSnapshotV1,
  WebSkillSummaryV1,
  WebTerminalMetadataV1,
  WebTerminalCreateResultV1,
  WebWorkspaceSummaryV1,
  WebWorkspaceProjectSummaryV1,
  WebToolDetailPageV1,
  WebToolDetailSummaryV1,
} from '../../src/web/protocol';
import type { SettingsMirrorSnapshot } from './settings/settings-mirror';
import type { SettingsInvalidatedEventV1, WebSettingsDocumentV1 } from './settings/types';
import type { WebSessionRuntimeSummaryV1 } from '../../src/web/session-runtime-registry';

export type WebBootstrapV1 = Omit<ProtocolWebBootstrapV1, 'settings'> & {
  readonly settings: WebSettingsDocumentV1;
};
export type WebEventEnvelopeV1 = ProtocolWebEventEnvelopeV1 | SettingsInvalidatedEventV1;
/** Local compatibility alias while the v0.3 Host protocol moves to a settings document. */
export type WebSettingsSnapshotV1 = WebSettingsDocumentV1;

export type {
  WebMcpServerSummaryV1,
  WebFileContentPageV1,
  WebFileNodeV1,
  WebFileTreePageV1,
  WebGitDiffPageV1,
  WebGitFileV1,
  WebGitLogPageV1,
  WebGitStatusV1,
  WebReviewSnapshotV1,
  WebSessionSummaryV1,
  WebSessionSnapshotV1,
  WebSettingsDocumentV1,
  WebSkillSummaryV1,
  WebTerminalMetadataV1,
  WebTerminalCreateResultV1,
  WebToolDetailPageV1,
  WebToolDetailSummaryV1,
  WebWorkspaceSummaryV1,
  WebWorkspaceProjectSummaryV1,
  WebComposerControlStateV1,
  WebModelCatalogPageV1,
  WebSessionRuntimeSummaryV1,
};

export type RuntimeEvent = Extract<
  WebEventEnvelopeV1,
  { readonly type: 'runtime_event' }
>['payload']['value'];
export type ProtocolTranscriptEntry = Extract<
  RuntimeEvent,
  { readonly type: 'transcript_replace' }
>['entries'][number];
export type PermissionRequest = Extract<
  RuntimeEvent,
  { readonly type: 'permission_requested' }
>['request'];
export type GoalRuntimeEvent = Extract<RuntimeEvent, { readonly type: 'goal_event' }>['event'];
export type GoalSnapshot = Extract<GoalRuntimeEvent, { readonly type: 'goal_updated' }>['goal'];
export type AgentModeSnapshot = Extract<
  RuntimeEvent,
  { readonly type: 'agent_mode_changed' }
>['snapshot'];
export type RuntimeEffortEvent = Extract<RuntimeEvent, { readonly type: 'effort_event' }>['event'];
export type FollowupQueueSnapshot = Extract<
  RuntimeEvent,
  { readonly type: 'followup_queue_changed' }
>['snapshot'];
export type RuntimeSubtaskEvent = Extract<
  RuntimeEvent,
  { readonly type: 'subtask_event' }
>['event'];
export type ResearchLifecycleEvent = Extract<
  RuntimeEvent,
  { readonly type: 'research_event' }
>['event'];
export type EditPreviewRequest = Extract<
  RuntimeEvent,
  { readonly type: 'edit_preview_requested' }
>['request'];

export interface WorkspaceListResponse {
  readonly activeId: string;
  readonly activePath: string;
  readonly workspaces: readonly WebWorkspaceSummaryV1[];
  readonly nextCursor: string | null;
}

export interface WorkspaceSessionsState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly items: readonly WebSessionSummaryV1[];
  readonly nextCursor: string | null;
  readonly error?: string;
}

export interface WebTranscriptEntry {
  readonly id: string;
  readonly role: ProtocolTranscriptEntry['role'];
  readonly content: string;
  readonly title?: string;
  readonly errorLayer?: ProtocolTranscriptEntry['errorLayer'];
  readonly statusTone?: ProtocolTranscriptEntry['statusTone'];
  readonly budgetStop?: ProtocolTranscriptEntry['budgetStop'];
  readonly toolActivity?: ProtocolTranscriptEntry['toolActivity'];
  readonly command?: ProtocolTranscriptEntry['command'];
  readonly eventId: string;
  readonly order: number;
  readonly receivedAt: string;
  readonly live?: boolean;
}

export interface WebToolCall {
  readonly callId: string;
  readonly eventId: string;
  readonly order: number;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly sequence: number;
  readonly state: 'running' | 'success' | 'error' | 'skipped';
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly duration?: number;
  readonly summary?: string;
  readonly error?: string;
  readonly outputBytes?: number;
  readonly artifactId?: string;
  readonly workspaceMutation?: {
    readonly phase: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    readonly queuePosition?: number;
  };
  readonly authorization?: {
    readonly approved: boolean;
    readonly source: string;
    readonly behavior?: string;
    readonly reason?: string;
  };
}

export interface WebEditPreview {
  readonly eventId: string;
  readonly order: number;
  readonly receivedAt: string;
  readonly request: EditPreviewRequest;
}

export interface WebSubtask extends RuntimeSubtaskEvent {
  readonly eventId: string;
  readonly order: number;
  readonly updatedAt: string;
}

export interface WebResearch {
  readonly packetId: string;
  readonly eventId: string;
  readonly order: number;
  readonly updatedAt: string;
  readonly objective?: string;
  readonly mode?: string;
  readonly stage: 'running' | 'completed' | 'partial' | 'failed';
  readonly auditStatus?: string;
  readonly conclusion?: string;
  readonly sources: ReadonlyArray<{
    readonly id: string;
    readonly provider: string;
    readonly status: string;
    readonly title?: string;
    readonly location?: string;
    readonly failureReason?: string;
  }>;
  readonly conflicts: readonly string[];
  readonly summary?: Record<string, number>;
}

export interface GoalEvidenceItem {
  readonly id: string;
  readonly kind: string;
  readonly result: 'passed' | 'failed' | 'inconclusive';
  readonly subject: string;
}

export interface GoalActivity {
  readonly type: string;
  readonly message: string;
  readonly timestamp: string;
}

export interface GoalView {
  readonly goalId: string;
  readonly revision: number;
  readonly objective: string;
  readonly status: string;
  readonly tokenBudget?: number;
  readonly tokensUsed: number;
  readonly timeUsedMs: number;
  readonly continuationCount: number;
  readonly updatedAt: number;
  readonly stopReason?: string;
  readonly criteria?: {
    readonly passed: number;
    readonly total: number;
    readonly failed: number;
    readonly stale: number;
  };
  readonly planRevision?: number;
  readonly planPhase?: string;
  readonly nextAction?: string;
  readonly auditRemaining?: readonly string[];
}

export interface DiagnosticsSnapshot extends Record<string, unknown> {
  readonly workspace?: string;
  readonly activeSessionId?: string | null;
  readonly configured?: boolean;
  readonly processing?: boolean;
  readonly agentMode?: string;
  readonly permissionMode?: string;
  readonly contextUsage?: unknown;
  readonly tokenUsage?: unknown;
  readonly plan?: string | null;
  readonly todos?: unknown;
  readonly skills?: {
    readonly configuredPaths?: readonly string[];
    readonly loadedFromPrompt?: boolean;
  };
  readonly mcp?: { readonly servers?: readonly string[] };
  readonly harness?: Record<string, unknown> | null;
  readonly workspaceKernel?: {
    readonly participantCount: number;
    readonly ownerReleased: boolean;
    readonly closed: boolean;
    readonly providerGate: {
      readonly activeCount: number;
      readonly waitingCount: number;
      readonly cooldownUntil: number | null;
      readonly cooldownReason: string | null;
    };
  } | null;
  readonly eventStream?: {
    readonly earliest?: number;
    readonly latest?: number;
    readonly retained?: number;
    readonly replayResets?: number;
  };
  readonly performance?: {
    readonly files?: {
      readonly readOperations: number;
      readonly bytesRead: number;
      readonly itemsParsed: number;
    };
    readonly git?: {
      readonly processCount: number;
      readonly bytesRead: number;
      readonly itemsParsed: number;
    };
    readonly thread?: {
      readonly eventStore: {
        readonly logScans: number;
        readonly bytesScanned: number;
        readonly eventsScanned: number;
      };
      readonly sessionIndex: {
        readonly indexBuilds: number;
        readonly manifestReads: number;
        readonly pageReads: number;
        readonly bytesRead: number;
      };
    };
  };
}

export type ConnectionPhase =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'offline'
  | 'replay-required'
  | 'closed';

export type SessionSnapshotSyncPhase = 'idle' | 'loading' | 'refreshing' | 'ready' | 'failed';

export interface SessionSnapshotSyncState {
  readonly status: SessionSnapshotSyncPhase;
  readonly requestId: number | null;
  readonly error?: string;
}

export interface WorkbenchNotice {
  readonly id: number;
  readonly tone: 'info' | 'warning' | 'error' | 'success';
  readonly title: string;
  readonly detail?: string;
  readonly domain?: 'session-snapshot' | 'transport';
  readonly sessionId?: string;
}

export interface WorkspaceResourceEpochs {
  readonly files: number;
  readonly git: number;
  readonly review: number;
}

export interface WorkbenchState {
  readonly boot: 'loading' | 'ready' | 'error';
  readonly bootError?: string;
  readonly bootstrap: WebBootstrapV1 | null;
  readonly connection: ConnectionPhase;
  readonly connectionAttempt: number;
  readonly lastCursor: number;
  readonly lastEventId: string | null;
  readonly replayReason?: string;
  readonly contextRevision: string;
  readonly workspaceId: string;
  readonly workspace: string;
  readonly workspaces: readonly WebWorkspaceSummaryV1[];
  readonly sessions: readonly WebSessionSummaryV1[];
  readonly workspaceSessions: Readonly<Record<string, WorkspaceSessionsState>>;
  readonly workspaceProjectSummaries: Readonly<Record<string, WebWorkspaceProjectSummaryV1>>;
  readonly workspaceResourceEpochs: Readonly<Record<string, WorkspaceResourceEpochs>>;
  readonly workspaceNextCursor: string | null;
  readonly sessionNextCursor: string | null;
  readonly activeSessionId: string | null;
  readonly sessionSync: Readonly<Record<string, SessionSnapshotSyncState>>;
  readonly sessionProjectionById: Readonly<Record<string, WebSessionSnapshotV1>>;
  readonly sessionRuntimeById: Readonly<Record<string, WebSessionRuntimeSummaryV1>>;
  readonly transcript: readonly WebTranscriptEntry[];
  readonly tools: readonly WebToolCall[];
  readonly edits: readonly WebEditPreview[];
  readonly subtasks: readonly WebSubtask[];
  readonly research: readonly WebResearch[];
  readonly permission: (PermissionRequest & { readonly eventId: string }) | null;
  readonly processing: boolean;
  readonly statusMessage: string;
  readonly mode: AgentModeSnapshot;
  readonly effort: RuntimeEffortEvent | null;
  readonly queue: FollowupQueueSnapshot;
  readonly goal: GoalView | null;
  readonly goalEvidence: readonly GoalEvidenceItem[];
  readonly goalActivity: readonly GoalActivity[];
  readonly diagnostics: DiagnosticsSnapshot | null;
  readonly settings: WebSettingsDocumentV1 | null;
  readonly settingsMirror: SettingsMirrorSnapshot;
  readonly sessionSnapshot: WebSessionSnapshotV1 | null;
  readonly composer: WebComposerControlStateV1 | null;
  readonly modelCatalog: WebModelCatalogPageV1 | null;
  readonly plan: WebSessionSnapshotV1['plan'] | null;
  readonly skills: readonly WebSkillSummaryV1[];
  readonly mcpServers: readonly WebMcpServerSummaryV1[];
  readonly toolDetails: readonly WebToolDetailSummaryV1[];
  readonly skillNextCursor: string | null;
  readonly mcpNextCursor: string | null;
  readonly toolDetailNextCursor: string | null;
  readonly loopStats: unknown;
  readonly traces: readonly unknown[];
  readonly pendingAction: string | null;
  readonly notice: WorkbenchNotice | null;
  readonly announcement: string;
}

export const initialWorkbenchState: WorkbenchState = {
  boot: 'loading',
  bootstrap: null,
  connection: 'connecting',
  connectionAttempt: 0,
  lastCursor: 0,
  lastEventId: null,
  contextRevision: '',
  workspaceId: '',
  workspace: '',
  workspaces: [],
  sessions: [],
  workspaceSessions: {},
  workspaceProjectSummaries: {},
  workspaceResourceEpochs: {},
  workspaceNextCursor: null,
  sessionNextCursor: null,
  activeSessionId: null,
  sessionSync: {},
  sessionProjectionById: {},
  sessionRuntimeById: {},
  transcript: [],
  tools: [],
  edits: [],
  subtasks: [],
  research: [],
  permission: null,
  processing: false,
  statusMessage: '正在连接本地 Web Host…',
  mode: { baseMode: 'interactive', pendingBaseMode: null },
  effort: null,
  queue: { items: [], limit: 16 },
  goal: null,
  goalEvidence: [],
  goalActivity: [],
  diagnostics: null,
  settings: null,
  settingsMirror: {
    status: 'idle',
    document: null,
    lastGood: null,
    stale: false,
    error: null,
    generation: 0,
  },
  sessionSnapshot: null,
  composer: null,
  modelCatalog: null,
  plan: null,
  skills: [],
  mcpServers: [],
  toolDetails: [],
  skillNextCursor: null,
  mcpNextCursor: null,
  toolDetailNextCursor: null,
  loopStats: null,
  traces: [],
  pendingAction: null,
  notice: null,
  announcement: '',
};

const IDLE_SESSION_SNAPSHOT_SYNC: SessionSnapshotSyncState = Object.freeze({
  status: 'idle',
  requestId: null,
});

export function activeSessionSnapshotSync(state: WorkbenchState): SessionSnapshotSyncState {
  return state.activeSessionId
    ? (state.sessionSync[state.activeSessionId] ?? IDLE_SESSION_SNAPSHOT_SYNC)
    : IDLE_SESSION_SNAPSHOT_SYNC;
}

export function isActiveSessionSnapshotReady(state: WorkbenchState): boolean {
  return Boolean(
    state.activeSessionId &&
    state.sessionSnapshot?.session.id === state.activeSessionId &&
    activeSessionSnapshotSync(state).status === 'ready'
  );
}
