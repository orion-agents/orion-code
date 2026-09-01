import { randomUUID } from 'crypto';
import { existsSync, realpathSync, statSync, watch, type FSWatcher } from 'fs';
import { basename, resolve } from 'path';

import {
  AgentRuntimeController,
  FollowupQueueConflictError,
} from '../runtime/agent-runtime-controller';
import type { AgentRuntimeEvent } from '../runtime/agent-runtime-protocol';
import {
  DurableToolReceiptReaderError,
  listProjectDurableToolReceiptRefsV1,
} from '../runtime/durable-tool-receipt-reader';
import { loadFirstPartyMcpConfigurationV1 } from '../runtime/mcp';
import { createProductUiRuntime } from '../runtime/product-bootstrap';
import type { OrionRuntimeV1 } from '../runtime/orion-runtime-v1';
import { digestRuntimeValue } from '../runtime/protocol/canonical';
import { PlanReviewControlError } from '../runtime/plan-review';
import type { RuntimeEventEnvelopeV1 } from '../runtime/protocol/runtime-protocol-v1';
import { threadEventStorePerformanceCountersV1 } from '../runtime/thread-event-store';
import {
  ThreadSessionIndexError,
  threadSessionIndexPerformanceCountersV1,
} from '../runtime/thread-session-index';
import {
  loadThreadSessionSnapshotPageV1,
  loadThreadSessionViewV1,
  type ThreadSessionRuntimeActivationV1,
  type ThreadSessionViewV1,
} from '../runtime/thread-session-view';
import type { PlanReviewProjectionV1, ThreadProjectionV1 } from '../runtime/thread-projection';
import { FileToolDetailRepository } from '../runtime/tool-detail-repository';
import { parsePlanReceiptV1, parseTurnCommitV1 } from '../runtime/turn-commit';
import { SessionComposerControlError } from '../runtime/session-composer-control';
import type { OrionCodeUiRuntime } from '../runtime/ui-events';
import { incrementSessionCount } from '../services/global-config';
import { redactTraceText } from '../services/redaction';
import { SettingsCoordinatorError } from '../services/settings-coordinator';
import {
  countSessionsByProject,
  createSession,
  listProjectSessions,
  listSessions,
  loadSessionMeta,
  renameSession,
  readSessionMessages,
  type SessionMeta,
} from '../services/session-storage';
import { WorkspaceRegistryError, WorkspaceRegistryV1 } from '../services/workspace-registry';
import { WebWorkbenchError } from './errors';
import { WebEventHub } from './event-hub';
import { FileReadServiceV1 } from './file-read-service';
import { GitReadModelServiceV1 } from './git-read-model-service';
import {
  WorkspaceMutationArbiterV1,
  type WorkspaceMutationStateV1,
} from './workspace-mutation-arbiter';
import {
  WEB_API_VERSION,
  parseWebCommand,
  type WebComposerActionResultV1,
  type WebComposerActionV1,
  type WebComposerControlStateV1,
  projectSessionSummary,
  toAgentRuntimeInput,
  type WebBootstrapV1,
  type WebCommandResultV1,
  type WebCommandV1,
  type WebContextActivateRequestV1,
  type WebContextGuardV1,
  type WebContextReferenceV1,
  type WebMcpServerSummaryV1,
  type WebPageV1,
  type WebSessionSnapshotV1,
  type WebSessionSummaryV1,
  type WebSettingsDocumentV1,
  type WebSettingsMutationResultV1,
  type WebSettingsSnapshotV1,
  type WebSettingsUpdateRequestV1,
  type WebSkillSummaryV1,
  type WebToolDetailPageV1,
  type WebToolDetailSummaryV1,
  type WebWorkspaceSummaryV1,
  type WebWorkspaceProjectSummaryV1,
  type WebWorkspaceInvalidationReasonV1,
} from './protocol';
import { ReviewServiceV1 } from './review-service';
import {
  WebSessionRuntimeRegistryError,
  WebSessionRuntimeRegistryV1,
  type WebSessionActorKeyV1,
  type WebSessionRuntimeSummaryV1,
} from './session-runtime-registry';
import { TerminalManagerV1 } from './terminal-manager';

export { WebWorkbenchError } from './errors';

interface CachedMutationResult {
  readonly fingerprint: string;
  readonly result: Promise<unknown>;
}

interface CachedSessionView {
  readonly fingerprint: string;
  readonly view: NonNullable<ReturnType<typeof loadThreadSessionViewV1>>;
  readonly bytes: number;
}

interface WebWorkbenchSessionActorV1 {
  readonly key: WebSessionActorKeyV1;
  readonly runtime: OrionCodeUiRuntime;
  readonly controller: AgentRuntimeController;
  composerRevision: string;
  composerAuthorityDigest?: string;
  latestStatus: string;
  suppressComposerEdges: number;
  composerStoreUnsubscribe?: () => void;
  composerControlsUnsubscribe?: () => void;
  composerChangeTimer?: NodeJS.Timeout;
}

const SESSION_VIEW_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_MUTATION_RESULTS = 4_096;
const MAX_CONTEXT_REFERENCE_BYTES = 64 * 1024;
const MAX_CONTEXT_MANIFEST_BYTES = 256 * 1024;
const CONTEXT_TRANSITION_MUTATIONS = new Set(['context.activate', 'workspace.activate']);

export interface WebWorkbenchControllerOptions {
  readonly cwd: string;
  readonly eventHub?: WebEventHub;
  readonly createRuntime?: (cwd: string) => Promise<OrionCodeUiRuntime>;
  readonly createSessionRuntime?: (cwd: string) => Promise<OrionCodeUiRuntime>;
  readonly workspaceRegistry?: WorkspaceRegistryV1;
}

/** Owns the Workspace surface plus the bounded Web Session actor registry. */
export class WebWorkbenchController {
  readonly eventHub: WebEventHub;

  private workspaceValue: string;
  private runtimeValue!: OrionCodeUiRuntime;
  private controllerValue!: AgentRuntimeController;
  private activeOrionRuntime?: { readonly runtime: OrionRuntimeV1; readonly sessionId: string };
  private readonly activeOrionRuntimes = new Map<string, OrionRuntimeV1>();
  private readonly createRuntime: (cwd: string) => Promise<OrionCodeUiRuntime>;
  private readonly createSessionRuntime: (cwd: string) => Promise<OrionCodeUiRuntime>;
  private sessionRegistry: WebSessionRuntimeRegistryV1<WebWorkbenchSessionActorV1>;
  private readonly workspaceRegistry: WorkspaceRegistryV1;
  readonly terminalManager: TerminalManagerV1;
  private readonly mutationResults = new Map<string, CachedMutationResult>();
  private readonly sessionViews = new Map<string, CachedSessionView>();
  private sessionViewBytes = 0;
  private readonly toolDetails = new FileToolDetailRepository();
  private readonly workspaceMutations: WorkspaceMutationArbiterV1;
  private readonly workspaceMutationOwners = new Map<string, WebSessionActorKeyV1>();
  private readonly pendingWorkspaceMutationStates = new Map<string, WorkspaceMutationStateV1>();
  private fileService!: FileReadServiceV1;
  private gitService!: GitReadModelServiceV1;
  private reviewService!: ReviewServiceV1;
  private contextRevisionValue = randomUUID();
  private composerRevisionValue = randomUUID();
  private composerAuthorityDigest: string | undefined;
  private composerStoreUnsubscribe?: () => void;
  private composerControlsUnsubscribe?: () => void;
  private composerChangeTimer?: NodeJS.Timeout;
  private suppressComposerEdges = 0;
  private suppressContextEdges = 0;
  private latestStatus = 'Ready';
  private transition: Promise<void> | undefined;
  private activeMutationCount = 0;
  private contextTransitionReserved = false;
  private closed = false;
  private shutdownResult?: Promise<void>;
  private workspaceWatchers: FSWatcher[] = [];
  private resourceInvalidationTimer?: NodeJS.Timeout;

  private constructor(options: WebWorkbenchControllerOptions) {
    this.workspaceValue = canonicalDirectory(options.cwd);
    this.eventHub = options.eventHub ?? new WebEventHub();
    this.workspaceMutations = new WorkspaceMutationArbiterV1({
      onStateChanged: state => this.emitWorkspaceMutationState(state),
    });
    this.workspaceRegistry = options.workspaceRegistry ?? new WorkspaceRegistryV1();
    this.terminalManager = new TerminalManagerV1({
      resolveWorkspace: workspaceId => this.workspaceRegistry.find(workspaceId)?.canonicalPath,
      getActiveContext: () => ({
        workspaceId: this.activeWorkspaceEntry().id,
        contextRevision: this.contextRevisionValue,
      }),
      onWorkspaceMutationHint: workspaceId => {
        if (workspaceId === this.activeWorkspaceEntry().id) {
          this.scheduleWorkspaceResourceInvalidation('terminal-command');
        }
      },
    });
    this.createRuntime =
      options.createRuntime ??
      (cwd =>
        createProductUiRuntime({
          cwd,
          workspaceMutationCoordinator: this.workspaceMutations,
          shutdownReason: 'Orion Web Workbench shutdown',
          onActiveSessionRuntime: (runtime, sessionId, activation) =>
            this.observeThreadRuntime(runtime, sessionId, activation),
          onSettingsInvalidated: event => {
            if (this.suppressContextEdges > 0) return;
            this.eventHub.emit(
              {
                type: 'settings_invalidated',
                revision: event.revision,
                reason: event.reason,
                state: event.state,
              },
              false
            );
          },
        }));
    this.createSessionRuntime =
      options.createSessionRuntime ??
      options.createRuntime ??
      (cwd =>
        createProductUiRuntime({
          cwd,
          workspaceRuntimeKernel: this.runtimeValue.workspaceRuntimeKernel,
          workspaceMutationCoordinator: this.workspaceMutations,
          shutdownReason: 'Orion Web Session actor shutdown',
          onActiveSessionRuntime: (runtime, sessionId, activation) =>
            this.observeThreadRuntime(runtime, sessionId, activation),
        }));
    this.sessionRegistry = this.createSessionRegistry();
  }

  static async create(options: WebWorkbenchControllerOptions): Promise<WebWorkbenchController> {
    const workbench = new WebWorkbenchController(options);
    workbench.initializeWorkspaceRegistry();
    await workbench.installRuntime(workbench.workspaceValue);
    return workbench;
  }

  get workspace(): string {
    return this.workspaceValue;
  }

  get runtime(): OrionCodeUiRuntime {
    return this.runtimeValue;
  }

  get controller(): AgentRuntimeController {
    return this.controllerValue;
  }

  get contextRevision(): string {
    return this.contextRevisionValue;
  }

  bootstrap(nonce: string): WebBootstrapV1 {
    return Object.freeze({
      apiVersion: WEB_API_VERSION,
      productVersion: this.runtimeValue.version,
      nonce,
      contextRevision: this.contextRevisionValue,
      workspaceId: this.activeWorkspaceEntry().id,
      workspace: this.workspaceValue,
      configured: this.runtimeValue.isConfigured,
      activeSessionId: this.runtimeValue.getSession()?.id ?? null,
      settings: this.settings(),
      capabilities: {
        goal: true as const,
        plan: true as const,
        skills: true as const,
        mcp: true as const,
        diagnostics: true as const,
        review: true as const,
        files: true as const,
        git: true as const,
        terminal: this.terminalManager.available,
      },
    });
  }

  settings(): WebSettingsSnapshotV1 {
    this.assertSettingsAvailable();
    const describe = this.runtimeValue.describeSettings;
    if (!describe) {
      throw new WebWorkbenchError(
        503,
        'The product Settings coordinator is unavailable.',
        'settings_document_unavailable'
      );
    }
    try {
      return describe() as WebSettingsDocumentV1;
    } catch (error) {
      throw mapSettingsError(error);
    }
  }

  listWorkspaces(context?: WebContextGuardV1): readonly WebWorkspaceSummaryV1[] {
    if (context) this.assertContextGuard(context);
    // Session metadata is canonicalized before it enters the catalog. The
    // summary read model deliberately avoids sorting Sessions or re-running
    // realpath/stat for every historical entry. Availability is checked once
    // per registered Workspace below.
    const counts = countSessionsByProject();
    const result = Object.freeze(
      this.workspaceRegistry.list().map(entry => {
        let available = false;
        try {
          available = canonicalDirectory(entry.canonicalPath) === entry.canonicalPath;
        } catch {
          available = false;
        }
        return Object.freeze({
          id: entry.id,
          path: entry.canonicalPath,
          label: entry.label || basename(entry.canonicalPath) || entry.canonicalPath,
          active: entry.canonicalPath === this.workspaceValue,
          available,
          sessionCount: counts.get(entry.canonicalPath) ?? 0,
          lastActivatedAt: entry.lastActivatedAt,
          ...(entry.pinnedOrder !== undefined ? { pinnedOrder: entry.pinnedOrder } : {}),
        });
      })
    );
    if (context) this.assertContextGuard(context);
    return result;
  }

  listWorkspaceSessions(
    workspaceId: string,
    context?: WebContextGuardV1
  ): readonly WebSessionSummaryV1[] {
    if (context) this.assertContextGuard(context);
    const entry = this.workspaceRegistry.find(workspaceId);
    if (!entry) {
      throw new WebWorkbenchError(404, 'Workspace was not found.', 'workspace_not_found');
    }
    try {
      canonicalDirectory(entry.canonicalPath);
    } catch {
      throw new WebWorkbenchError(409, 'Workspace is unavailable.', 'workspace_unavailable');
    }
    const result = Object.freeze(
      listProjectSessions(entry.canonicalPath).map(projectSessionSummary)
    );
    if (context) this.assertContextGuard(context);
    return result;
  }

  async workspaceProjectSummary(
    workspaceId: string,
    context?: WebContextGuardV1
  ): Promise<WebWorkspaceProjectSummaryV1> {
    if (context) this.assertContextGuard(context);
    const entry = this.workspaceRegistry.find(workspaceId);
    if (!entry) {
      throw new WebWorkbenchError(404, 'Workspace was not found.', 'workspace_not_found');
    }
    let workspace: string;
    try {
      workspace = canonicalDirectory(entry.canonicalPath);
    } catch {
      throw new WebWorkbenchError(409, 'Workspace is unavailable.', 'workspace_unavailable');
    }
    const status = await new GitReadModelServiceV1(workspace).status({ pageSize: 2_000 });
    const result = Object.freeze({
      workspaceId,
      repositoryRevision: status.repositoryRevision,
      isRepository: status.isRepository,
      branch: status.branch,
      detached: status.detached,
      head: status.head,
      dirtyCount: status.totalFiles,
      conflictCount: status.conflicted.length,
    });
    if (context) this.assertContextGuard(context);
    return result;
  }

  setWorkspacePinned(
    workspaceId: string,
    pinned: boolean,
    context: WebContextGuardV1
  ): WebWorkspaceSummaryV1 {
    this.assertContextGuard(context);
    try {
      this.workspaceRegistry.setPinned(workspaceId, pinned);
    } catch (error) {
      throw mapWorkspaceRegistryError(error);
    }
    const updated = this.listWorkspaces().find(workspace => workspace.id === workspaceId);
    if (!updated) {
      throw new WebWorkbenchError(404, 'Workspace was not found.', 'workspace_not_found');
    }
    return updated;
  }

  removeWorkspace(workspaceId: string, context: WebContextGuardV1): void {
    this.assertContextGuard(context);
    const entry = this.workspaceRegistry.find(workspaceId);
    if (!entry) {
      throw new WebWorkbenchError(404, 'Workspace was not found.', 'workspace_not_found');
    }
    if (entry.canonicalPath === this.workspaceValue) {
      throw new WebWorkbenchError(
        409,
        'The active Workspace cannot be removed.',
        'workspace_active'
      );
    }
    this.terminalManager.closeWorkspace(workspaceId);
    if (!this.workspaceRegistry.remove(workspaceId)) {
      throw new WebWorkbenchError(404, 'Workspace was not found.', 'workspace_not_found');
    }
  }

  listSessions(context?: WebContextGuardV1): readonly WebSessionSummaryV1[] {
    if (context) this.assertContextGuard(context);
    const result = Object.freeze(
      listProjectSessions(this.workspaceValue).map(projectSessionSummary)
    );
    if (context) this.assertContextGuard(context);
    return result;
  }

  sessionSnapshot(
    sessionId: string,
    cursor?: string,
    pageSize = 50,
    tail = false,
    context?: WebContextGuardV1
  ): WebSessionSnapshotV1 {
    if (context) this.assertContextGuard(context);
    const session = requireSession(sessionId);
    if (canonicalDirectory(session.projectPath) !== this.workspaceValue) {
      throw new WebWorkbenchError(409, 'Session belongs to another workspace.');
    }
    const key = this.sessionActorKey(session);
    const resident = this.sessionRegistry.residentActor(key);
    const actor = resident?.actor;
    const baseSessionRuntime = resident?.runtime ?? this.sessionRegistry.summary(key);
    const active = actor !== undefined;
    const activeProjection = this.activeOrionRuntimes.get(session.id)?.thread.getProjection();
    let indexedPage: ReturnType<typeof loadThreadSessionSnapshotPageV1>;
    if (tail) {
      try {
        indexedPage = loadThreadSessionSnapshotPageV1(
          this.workspaceValue,
          session.id,
          cursor,
          pageSize
        );
      } catch (error) {
        if (error instanceof ThreadSessionIndexError) {
          throw new WebWorkbenchError(
            error.code === 'ORION_THREAD_SESSION_CURSOR_STALE' ? 409 : 400,
            error.message,
            error.code === 'ORION_THREAD_SESSION_CURSOR_STALE'
              ? 'transcript_cursor_stale'
              : 'page_cursor_invalid'
          );
        }
        throw error;
      }
    }
    if (
      indexedPage &&
      activeProjection &&
      (indexedPage.cursor !== activeProjection.cursor ||
        indexedPage.projectionDigest !== activeProjection.digest)
    ) {
      if (cursor) {
        throw new WebWorkbenchError(
          409,
          'Active Thread changed after this transcript cursor was issued.',
          'transcript_cursor_stale'
        );
      }
      // Another process may have advanced the durable Thread before the active
      // Runtime has adopted that head. Never combine the newer page with the
      // older in-memory cursor/digest in one snapshot.
      indexedPage = undefined;
    }
    let view: ReturnType<typeof loadThreadSessionViewV1>;
    if (!indexedPage && !activeProjection) {
      try {
        view = this.loadSessionView(session, activeProjection);
      } catch (error) {
        if (!activeProjection) throw error;
        view = undefined;
      }
    }
    const transcriptSource = indexedPage
      ? indexedPage.transcript.items
      : view
        ? view.transcriptMessages
        : activeProjection
          ? Object.values(activeProjection.items)
              .filter(
                item =>
                  item.kind === 'message' &&
                  item.status !== 'started' &&
                  ['system', 'user', 'assistant', 'tool'].includes(item.role ?? '')
              )
              .sort((left, right) => left.startedSeq - right.startedSeq)
              .map(item => ({
                role: item.role as 'system' | 'user' | 'assistant' | 'tool',
                content: item.content ?? item.summary ?? item.error ?? '',
                timestamp: item.terminalSeq ?? item.startedSeq,
              }))
          : readSessionMessages(session.id).map(message => ({
              role: message.role,
              content: message.content,
              timestamp: message.timestamp,
              ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
              ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
              ...(message.modelVisibleContent
                ? { modelVisibleContent: message.modelVisibleContent }
                : {}),
              ...(message.appliedSkills ? { appliedSkills: message.appliedSkills } : {}),
            }));
    const tailPage =
      tail && !indexedPage ? pageTranscriptTail(transcriptSource, cursor, pageSize) : undefined;
    const transcriptPage = indexedPage
      ? {
          items: indexedPage.transcript.items,
          nextCursor: indexedPage.transcript.nextCursor,
        }
      : (tailPage ?? pageItems(transcriptSource, cursor, pageSize));
    const transcriptOffset = indexedPage
      ? indexedPage.transcript.offset
      : (tailPage?.offset ?? (cursor ? decodePageCursor(cursor) : 0));
    const transcript = Object.freeze({
      items: Object.freeze(
        transcriptPage.items.map((message, index) => ({
          ...message,
          id: `${session.id}:message:${transcriptOffset + index + 1}`,
        }))
      ),
      nextCursor: indexedPage?.transcript.nextCursor ?? transcriptPage.nextCursor,
    });
    const commitProjections = indexedPage
      ? uniqueCommitProjections([indexedPage.latestPlanTurnCommit, indexedPage.latestTurnCommit])
      : view
        ? uniqueCommitProjections([view.latestPlanTurnCommit, view.latestTurnCommit])
        : activeProjection
          ? latestAuthorityCommits(activeProjection)
          : [];
    const commits = commitProjections.map(commit => parseTurnCommitV1(commit.receipt));
    const latestCommit = commits.at(-1);
    const latestProjectedTurn = activeProjection
      ? Object.values(activeProjection.turns)
          .sort((left, right) => left.startedSeq - right.startedSeq)
          .at(-1)
      : undefined;
    const durableTerminal =
      latestProjectedTurn?.status ?? indexedPage?.latestTurn?.status ?? latestCommit?.terminal;
    const recoverableTerminalPhase =
      durableTerminal === 'interrupted' || durableTerminal === 'failed'
        ? durableTerminal
        : undefined;
    const sessionRuntime =
      recoverableTerminalPhase &&
      ['cold', 'idle', 'interrupted', 'failed'].includes(baseSessionRuntime.phase)
        ? Object.freeze({ ...baseSessionRuntime, phase: recoverableTerminalPhase })
        : baseSessionRuntime;
    const planCommit = [...commits].reverse().find(commit => commit.planReceipt);
    const plan = planCommit?.planReceipt
      ? pickPlanReceipt(parsePlanReceiptV1(planCommit.planReceipt))
      : null;
    const state = (actor?.runtime ?? this.runtimeValue).store.getSnapshot();
    const pendingPermissions = active
      ? actor.controller.getPendingPermissions().map(request => ({
          id: request.id,
          toolName: request.name,
          ...(request.reason ? { reason: request.reason } : {}),
          sanitizedArguments: request.args,
          allowedScopes: ['once', 'project', 'global'] as const,
        }))
      : [];
    const projectionStatus: WebSessionSnapshotV1['threadStatus'] =
      activeProjection?.status ?? (indexedPage || view ? 'idle' : 'legacy');
    const goal =
      latestCommit?.goalState && latestCommit.goalStateDigest
        ? {
            authority: 'turn_commit' as const,
            digest: latestCommit.goalStateDigest,
            state: JSON.parse(latestCommit.goalState) as unknown,
          }
        : null;
    const projectedComposer = actor
      ? this.projectActorComposerState(actor, session)
      : this.projectComposerStateValue(session, undefined, indexedPage?.planReview);
    const composer =
      projectedComposer.sessionRuntime.phase === sessionRuntime.phase
        ? projectedComposer
        : Object.freeze({ ...projectedComposer, sessionRuntime });
    const snapshot = Object.freeze({
      apiVersion: WEB_API_VERSION,
      session: projectSessionSummary(session),
      sessionRuntime,
      threadId: activeProjection?.threadId ?? indexedPage?.threadId ?? view?.threadId ?? null,
      threadCursor: activeProjection?.cursor ?? indexedPage?.cursor ?? view?.cursor ?? 0,
      eventCursor: this.eventHub.snapshot().latest,
      ...(activeProjection?.digest || indexedPage?.projectionDigest || view?.projectionDigest
        ? {
            projectionDigest:
              activeProjection?.digest ?? indexedPage?.projectionDigest ?? view?.projectionDigest,
          }
        : {}),
      threadStatus: projectionStatus,
      ...(activeProjection?.activeTurnId ? { activeTurnId: activeProjection.activeTurnId } : {}),
      transcript,
      runtime: {
        active,
        processing: active ? state.isProcessing : false,
        agentMode: state.agentMode,
        permissionMode: state.permissionMode,
        status: actor?.latestStatus ?? 'Ready',
        followups: active ? Object.freeze([...actor.controller.getFollowupQueue()]) : [],
        followupLimit: 16,
        contextUsage: active ? state.contextUsage : null,
        tokenUsage: active ? state.tokenUsage : null,
      },
      pendingApprovals: Object.freeze(pendingPermissions),
      goal,
      plan,
      composer,
      recoveryDiagnostics: indexedPage ? [] : (view?.diagnostics ?? []),
    });
    if (context) this.assertContextGuard(context);
    return snapshot;
  }

  composerState(sessionId: string, context?: WebContextGuardV1): WebComposerControlStateV1 {
    if (context) this.assertContextGuard(context);
    const session = requireSession(sessionId);
    this.assertSessionWorkspace(session);
    const actor = this.sessionRegistry.residentActor(this.sessionActorKey(session))?.actor;
    const state = actor
      ? this.projectActorComposerState(actor, session)
      : this.projectComposerStateValue(session);
    if (context) this.assertContextGuard(context);
    return state;
  }

  sessionRuntimeSummary(sessionId: string): WebSessionRuntimeSummaryV1 {
    const session = requireSession(sessionId);
    this.assertSessionWorkspace(session);
    return this.sessionRegistry.summary(this.sessionActorKey(session));
  }

  async waitForSessionIdle(sessionId: string): Promise<void> {
    const session = requireSession(sessionId);
    this.assertSessionWorkspace(session);
    const actor = this.sessionRegistry.residentActor(this.sessionActorKey(session))?.actor;
    await actor?.controller.waitForIdle();
  }

  private projectActorComposerState(
    actor: WebWorkbenchSessionActorV1,
    session: SessionMeta
  ): WebComposerControlStateV1 {
    const state = this.projectComposerStateValue(session, actor);
    // Durable Thread and Store authority can advance before the debounced SSE
    // observer runs. Keep every projected control state and its CAS token in
    // the same synchronous boundary so the UI never receives new controls
    // paired with an older revision.
    const authorityDigest = composerAuthorityDigest(state);
    if (actor.composerAuthorityDigest === undefined) {
      actor.composerAuthorityDigest = authorityDigest;
      return state;
    }
    if (authorityDigest === actor.composerAuthorityDigest) return state;

    actor.composerRevision = randomUUID();
    actor.composerAuthorityDigest = authorityDigest;
    return Object.freeze({ ...state, controlRevision: actor.composerRevision });
  }

  private projectComposerStateValue(
    session: SessionMeta,
    actor?: WebWorkbenchSessionActorV1,
    indexedPlanReview?: PlanReviewProjectionV1
  ): WebComposerControlStateV1 {
    const runtimeOwner = actor?.runtime ?? this.runtimeValue;
    const controller = actor?.controller;
    const controls = runtimeOwner.sessionComposerControls;
    if (!controls) {
      throw new WebWorkbenchError(
        503,
        'Session Composer controls are unavailable.',
        'composer_controls_unavailable'
      );
    }
    const runtime = controls.describeSession(session);
    const queue = actor
      ? actor.controller.getFollowupQueueSnapshot()
      : { items: [] as const, limit: 16 };
    const projection = actor
      ? this.activeOrionRuntimes.get(session.id)?.thread.getProjection()
      : undefined;
    const review = projection?.planReview ?? indexedPlanReview;
    const workspaceId = this.workspaceRegistry
      .list()
      .find(entry => entry.canonicalPath === canonicalDirectory(session.projectPath))?.id;
    if (!workspaceId) {
      throw new WebWorkbenchError(404, 'Workspace was not found.', 'workspace_not_found');
    }
    const sessionRuntime = this.sessionRegistry.summary({ workspaceId, sessionId: session.id });
    return Object.freeze({
      apiVersion: WEB_API_VERSION,
      workspaceId,
      sessionId: session.id,
      contextRevision: this.contextRevisionValue,
      controlRevision: actor?.composerRevision ?? sessionRuntime.runtimeRevision,
      sessionRuntime,
      processing:
        Boolean(actor) &&
        (runtimeOwner.store.getSnapshot().isProcessing || Boolean(projection?.activeTurnId)),
      mode: controller
        ? Object.freeze({ ...controller.getAgentModeSnapshot() })
        : Object.freeze({ baseMode: 'interactive' as const, pendingBaseMode: null }),
      model: runtime.model,
      permission: runtime.permission,
      contextUsage: runtime.contextUsage,
      compactAvailable: controller?.canCompactContext() ?? false,
      pending: runtime.pending,
      lastError: runtime.lastError,
      planReview: review
        ? Object.freeze({
            planDigest: review.planDigest,
            revision: review.revision,
            status: review.status,
            createdAt: review.createdAt,
            createdModel: review.createdModel,
            returnMode: review.returnMode,
            ...(review.resolvedAt === undefined ? {} : { resolvedAt: review.resolvedAt }),
          })
        : null,
      queue: Object.freeze({
        items: Object.freeze(queue.items.map(item => Object.freeze({ ...item }))),
        limit: queue.limit,
      }),
    });
  }

  modelCatalog(sessionId: string, context?: WebContextGuardV1) {
    if (context) this.assertContextGuard(context);
    const session = requireSession(sessionId);
    this.assertSessionWorkspace(session);
    const actor = this.sessionRegistry.residentActor(this.sessionActorKey(session))?.actor;
    const controls = (actor?.runtime ?? this.runtimeValue).sessionComposerControls;
    if (!controls) {
      throw new WebWorkbenchError(
        503,
        'Session model catalog is unavailable.',
        'composer_controls_unavailable'
      );
    }
    const catalog = controls.catalog();
    if (context) this.assertContextGuard(context);
    return catalog;
  }

  async applyComposerAction(input: WebComposerActionV1): Promise<WebComposerActionResultV1> {
    this.assertContextGuard(input);
    const session = requireSession(input.expectedSessionId);
    this.assertSessionWorkspace(session);
    const key = this.sessionActorKey(session);
    const wasResident = this.sessionRegistry.summary(key).resident;
    let actor: WebWorkbenchSessionActorV1;
    try {
      actor = (await this.sessionRegistry.ensureResident(key, input.expectedSessionRuntimeRevision))
        .actor;
    } catch (error) {
      throw mapSessionRuntimeError(error);
    }
    const actorSession = actor.runtime.getSession();
    if (!actorSession || actorSession.id !== input.expectedSessionId) {
      throw new WebWorkbenchError(
        503,
        'Session actor is not bound to the expected Session.',
        'session_unavailable'
      );
    }
    if (!wasResident) actor.composerRevision = input.expectedControlRevision;
    const admittedState = this.projectActorComposerState(actor, actorSession);
    if (input.expectedControlRevision !== admittedState.controlRevision) {
      throw new WebWorkbenchError(
        409,
        'Composer controls changed before the action was admitted.',
        'composer_control_conflict'
      );
    }
    const controls = actor.runtime.sessionComposerControls;
    if (!controls) {
      throw new WebWorkbenchError(
        503,
        'Session Composer controls are unavailable.',
        'composer_controls_unavailable'
      );
    }
    let outcome: WebComposerActionResultV1['outcome'] = 'applied';
    let detail: string | undefined;
    let modelReceipt: WebComposerActionResultV1['modelReceipt'];
    let permissionReceipt: WebComposerActionResultV1['permissionReceipt'];
    let planReviewReceipt: WebComposerActionResultV1['planReviewReceipt'];
    actor.suppressComposerEdges += 1;
    try {
      switch (input.type) {
        case 'set_agent_mode': {
          const result = actor.controller.setAgentMode(input.mode);
          outcome =
            result.type === 'agent_mode_changed' && result.appliesFrom === 'next-logical-request'
              ? 'deferred'
              : 'applied';
          detail = JSON.stringify(result);
          break;
        }
        case 'set_permission_override':
          permissionReceipt = await controls.setPermissionOverride(input.value);
          outcome = permissionReceipt.appliesFrom === 'immediate' ? 'applied' : 'deferred';
          break;
        case 'clear_permission_override':
          permissionReceipt = await controls.setPermissionOverride(null);
          outcome = permissionReceipt.appliesFrom === 'immediate' ? 'applied' : 'deferred';
          break;
        case 'select_model':
          modelReceipt = await controls.selectModel({
            modelId: input.modelId,
            ...(input.effort ? { effort: input.effort } : {}),
          });
          outcome = modelReceipt.appliesFrom === 'next-logical-request' ? 'deferred' : 'applied';
          break;
        case 'compact_context': {
          const result = await actor.controller.compactContext();
          if (result.status === 'rejected') {
            throw new WebWorkbenchError(409, 'Context compact was rejected.', 'runtime_busy');
          }
          detail = JSON.stringify(result);
          break;
        }
        case 'edit_queue_item':
          detail = JSON.stringify(
            actor.controller.editFollowupQueueItem(
              input.itemId,
              input.expectedItemRevision,
              input.text
            )
          );
          break;
        case 'move_queue_item':
          detail = JSON.stringify(
            actor.controller.moveFollowupQueueItem(
              input.itemId,
              input.expectedItemRevision,
              input.targetIndex
            )
          );
          break;
        case 'remove_queue_item':
          detail = JSON.stringify(
            actor.controller.removeFollowupQueueItem(input.itemId, input.expectedItemRevision)
          );
          break;
        case 'review_plan': {
          planReviewReceipt = await actor.controller.reviewPlan({
            planDigest: input.planDigest,
            action: input.action,
            ...(input.feedback ? { feedback: input.feedback } : {}),
          });
          if (input.action === 'approve') actor.controller.setAgentMode('interactive');
          else if (input.action === 'continue') actor.controller.setAgentMode('plan');
          detail = JSON.stringify(planReviewReceipt.admission);
          break;
        }
      }
    } catch (error) {
      throw mapComposerControlError(error);
    } finally {
      actor.suppressComposerEdges -= 1;
    }
    actor.composerRevision = randomUUID();
    const state = this.projectComposerStateValue(actorSession, actor);
    actor.composerAuthorityDigest = composerAuthorityDigest(state);
    this.eventHub.emit({ type: 'composer_state_changed', state }, true, {
      sessionId: input.expectedSessionId,
    });
    return Object.freeze({
      requestId: input.requestId,
      outcome,
      controlRevision: actor.composerRevision,
      state,
      ...(modelReceipt ? { modelReceipt } : {}),
      ...(permissionReceipt ? { permissionReceipt } : {}),
      ...(planReviewReceipt ? { planReviewReceipt } : {}),
      ...(detail ? { detail } : {}),
    });
  }

  async skills(context?: WebContextGuardV1): Promise<readonly WebSkillSummaryV1[]> {
    if (context) this.assertContextGuard(context);
    const descriptors = (await this.runtimeValue.inspectSkills?.()) ?? [];
    const result = Object.freeze(
      descriptors.map(descriptor =>
        Object.freeze({
          id: descriptor.id,
          name: descriptor.name,
          description: descriptor.description,
          providerId: descriptor.providerId,
          sourceScope: descriptor.sourceScope,
          modelInvocable: descriptor.modelInvocable,
          userInvocable: descriptor.userInvocable,
          requestedCapabilities: Object.freeze([...descriptor.requestedCapabilities]),
          digest: descriptor.digest,
        })
      )
    );
    if (context) this.assertContextGuard(context);
    return result;
  }

  mcp(context?: WebContextGuardV1): readonly WebMcpServerSummaryV1[] {
    if (context) this.assertContextGuard(context);
    const descriptors = this.runtimeValue.inspectMcp?.() ?? [];
    let runtimeServers: ReadonlyMap<
      string,
      ReturnType<OrionRuntimeV1['diagnostics']>['mcp']['servers'][number]
    > = new Map();
    try {
      runtimeServers = new Map(
        (this.activeOrionRuntime?.runtime.diagnostics().mcp.servers ?? []).map(server => [
          server.serverId,
          server,
        ])
      );
    } catch {
      // A concurrent session transition may close the previous diagnostics graph.
    }
    const result = Object.freeze(
      descriptors.map(descriptor => {
        const runtime = runtimeServers.get(descriptor.id);
        return Object.freeze({
          id: descriptor.id,
          name: descriptor.name,
          ...(descriptor.description ? { description: descriptor.description } : {}),
          transport: descriptor.transport,
          tags: Object.freeze([...(descriptor.tags ?? [])]),
          disabled: descriptor.disabled ?? false,
          state: runtime?.state ?? 'dormant',
          generation: runtime?.generation ?? 0,
          toolCount: runtime?.toolCount ?? 0,
          activeCallCount: runtime?.activeCallCount ?? 0,
          ...(runtime?.failure
            ? { failure: 'Runtime transport failure. See local Host diagnostics for details.' }
            : {}),
        });
      })
    );
    if (context) this.assertContextGuard(context);
    return result;
  }

  async listToolDetails(context?: WebContextGuardV1): Promise<readonly WebToolDetailSummaryV1[]> {
    if (context) this.assertContextGuard(context);
    const result = Object.freeze(await this.toolDetails.list(this.workspaceValue));
    if (context) this.assertContextGuard(context);
    return result;
  }

  async readToolDetail(
    callId: string,
    offsetBytes: number,
    limitBytes: number,
    context?: WebContextGuardV1
  ): Promise<WebToolDetailPageV1> {
    if (context) this.assertContextGuard(context);
    const entry = (await this.toolDetails.list(this.workspaceValue)).find(
      detail => detail.callId === callId || detail.artifactId === callId
    );
    if (!entry?.artifactId) throw new WebWorkbenchError(404, 'Tool detail was not found.');
    const result = await this.toolDetails.read(
      {
        callId: entry.callId,
        sequence: entry.sequence,
        artifactId: entry.artifactId,
        outputBytes: entry.outputBytes,
      },
      { offsetBytes, limitBytes },
      this.workspaceValue
    );
    if (context) this.assertContextGuard(context);
    return result;
  }

  listFiles(context: WebContextGuardV1, input: Parameters<FileReadServiceV1['list']>[0]) {
    this.assertContextGuard(context);
    const result = this.fileService.list(input);
    this.assertContextGuard(context);
    return result;
  }

  readFileContent(
    context: WebContextGuardV1,
    input: Parameters<FileReadServiceV1['readContent']>[0]
  ) {
    this.assertContextGuard(context);
    const result = this.fileService.readContent(input);
    this.assertContextGuard(context);
    return result;
  }

  async gitStatus(
    context: WebContextGuardV1,
    input: Parameters<GitReadModelServiceV1['status']>[0]
  ) {
    this.assertContextGuard(context);
    const result = await this.gitService.status(input);
    this.assertContextGuard(context);
    return result;
  }

  async gitLog(context: WebContextGuardV1, input: Parameters<GitReadModelServiceV1['log']>[0]) {
    this.assertContextGuard(context);
    const result = await this.gitService.log(input);
    this.assertContextGuard(context);
    return result;
  }

  async gitDiff(context: WebContextGuardV1, input: Parameters<GitReadModelServiceV1['diff']>[0]) {
    this.assertContextGuard(context);
    const result = await this.gitService.diff(input);
    this.assertContextGuard(context);
    return result;
  }

  async review(context: WebContextGuardV1) {
    this.assertContextGuard(context);
    try {
      const result = await this.reviewService.snapshot();
      this.assertContextGuard(context);
      return result;
    } catch (error) {
      if (error instanceof DurableToolReceiptReaderError) {
        throw new WebWorkbenchError(
          500,
          'Durable Review receipt facts failed integrity validation.',
          'review_receipt_invalid'
        );
      }
      throw error;
    }
  }

  listTerminals(context: WebContextGuardV1) {
    this.assertContextGuard(context);
    const result = this.terminalManager.list(this.activeWorkspaceEntry().id);
    this.assertContextGuard(context);
    return result;
  }

  async createSession(name?: string, context?: WebContextGuardV1): Promise<WebSessionSummaryV1> {
    if (context) this.assertContextGuard(context);
    // A new Session inherits the durable default; an override on another
    // Session actor must never leak into it. Creation does not activate or
    // close any actor; foreground selection belongs to the browser tab.
    const session = createSession(
      this.workspaceValue,
      this.settings().sections.defaults.model.effectiveValue
    );
    incrementSessionCount();
    const named = name?.trim() ? (renameSession(session.id, name.trim()) ?? session) : session;
    this.sessionRegistry.summary(this.sessionActorKey(named));
    return projectSessionSummary(named);
  }

  async activateSession(
    sessionId: string,
    context?: WebContextGuardV1
  ): Promise<WebCommandResultV1> {
    if (context) this.assertContextGuard(context);
    const session = requireSession(sessionId);
    this.assertSessionWorkspace(session);
    const sessionRuntime = this.sessionRegistry.summary(this.sessionActorKey(session));
    return {
      requestId: `activate:${session.id}`,
      result: 'foreground_session_selected',
      sessionRuntime,
    };
  }

  renameSession(sessionId: string, name: string, context?: WebContextGuardV1): WebSessionSummaryV1 {
    if (context) this.assertContextGuard(context);
    const session = requireSession(sessionId);
    if (canonicalDirectory(session.projectPath) !== this.workspaceValue) {
      throw new WebWorkbenchError(409, 'Session belongs to another workspace.');
    }
    const normalizedName = name.trim();
    if (!normalizedName) throw new WebWorkbenchError(400, 'Session name is required.');
    if (normalizedName.length > 120) throw new WebWorkbenchError(400, 'Session name is too long.');
    const updated = renameSession(session.id, normalizedName);
    if (!updated) throw new WebWorkbenchError(404, 'Session no longer exists.');
    return projectSessionSummary(updated);
  }

  async switchWorkspace(path: string, context: WebContextGuardV1): Promise<void> {
    this.assertContextGuard(context);
    const next = canonicalDirectory(path);
    if (next === this.workspaceValue) return;
    let entry;
    try {
      entry = this.workspaceRegistry.register(next);
    } catch (error) {
      throw mapWorkspaceRegistryError(error);
    }
    await this.activateContext({
      expectedContextRevision: context.expectedContextRevision,
      workspaceId: entry.id,
      sessionId: null,
    });
  }

  async activateContext(input: Omit<WebContextActivateRequestV1, 'requestId'>): Promise<void> {
    if (input.expectedContextRevision !== this.contextRevisionValue) {
      throw new WebWorkbenchError(
        409,
        'The active Context changed before activation was admitted.',
        'context_revision_conflict'
      );
    }
    const entry = this.workspaceRegistry.find(input.workspaceId);
    if (!entry) throw new WebWorkbenchError(404, 'Workspace was not found.', 'workspace_not_found');
    const targetWorkspace = canonicalDirectory(entry.canonicalPath);
    const targetSession = input.sessionId ? requireSession(input.sessionId) : null;
    if (targetSession && canonicalDirectory(targetSession.projectPath) !== targetWorkspace) {
      throw new WebWorkbenchError(
        409,
        'Session does not belong to the requested Workspace.',
        'context_session_mismatch'
      );
    }
    const currentSessionId = this.runtimeValue.getSession()?.id ?? null;
    if (targetWorkspace === this.workspaceValue) {
      if (targetSession) this.sessionRegistry.summary(this.sessionActorKey(targetSession));
      // Session foreground selection is browser-local. A same-Workspace
      // selection never mutates the Host Context or any Session actor.
      return;
    }

    this.assertReadyForTransition('activate a Context');
    const previousWorkspace = this.workspaceValue;
    const previousSessionId = currentSessionId;
    const previousRuntime = this.runtimeValue;
    const previousController = this.controllerValue;
    const transition = (async () => {
      this.suppressContextEdges += 1;
      try {
        await previousController.stopActiveTurn();
        await previousController.waitForIdle();
        if (targetWorkspace !== previousWorkspace) {
          await this.sessionRegistry.shutdown('Workspace Context changed');
          await previousRuntime.shutdown();
          await this.installRuntime(targetWorkspace, false);
          this.sessionRegistry = this.createSessionRegistry();
        }
        this.workspaceRegistry.register(targetWorkspace, { activated: true });
      } catch (activationError) {
        try {
          if (targetWorkspace !== previousWorkspace) {
            if (this.runtimeValue !== previousRuntime) await this.runtimeValue.shutdown();
            await this.installRuntime(previousWorkspace, false);
            this.sessionRegistry = this.createSessionRegistry();
          }
          await this.restoreContextSession(previousSessionId);
        } catch {
          throw new WebWorkbenchError(
            503,
            'Context activation failed and the previous Context could not be restored.',
            'context_recovery_required'
          );
        }
        throw activationError;
      } finally {
        this.suppressContextEdges -= 1;
      }
      this.emitState();
      this.emitWorkspaceResourceInvalidation('context-change');
      if (targetWorkspace !== previousWorkspace) this.emitSettingsWorkspaceChange();
    })().finally(() => {
      if (this.transition === transition) this.transition = undefined;
    });
    this.transition = transition;
    return transition;
  }

  dispatch(raw: unknown): Promise<WebCommandResultV1> {
    const command = parseWebCommand(raw);
    return this.executeMutation(command.requestId, 'command', command, async () => {
      this.assertContextGuard(command);
      const session = requireSession(command.expectedSessionId);
      this.assertSessionWorkspace(session);
      const key = this.sessionActorKey(session);
      if (command.type === 'cancel_queued_turn') {
        try {
          const sessionRuntime = this.sessionRegistry.cancelQueued(
            key,
            command.queueId as string,
            command.expectedSessionRuntimeRevision
          );
          return Object.freeze({
            requestId: command.requestId,
            result: 'session_turn_queue_cancelled',
            sessionRuntime,
          });
        } catch (error) {
          throw mapSessionRuntimeError(error);
        }
      }
      const resolved = await this.resolveCommandContext(command);
      const runtimeInput =
        resolved && command.type === 'queue_followup'
          ? ({
              type: 'queue_followup',
              text: command.text as string,
              resolvedText: resolved.text,
              source: 'programmatic',
            } as const)
          : toAgentRuntimeInput({ ...command, ...(resolved ? { text: resolved.text } : {}) });
      try {
        if (command.type === 'submit') {
          const currentRuntime = this.sessionRegistry.summary(key);
          if (['running', 'waiting_approval'].includes(currentRuntime.phase)) {
            const routed = await this.sessionRegistry.withActor(
              key,
              command.expectedSessionRuntimeRevision,
              actor => {
                if (!actor.controller.hasActiveTurn()) {
                  throw new WebSessionRuntimeRegistryError(
                    409,
                    'session_runtime_revision_conflict',
                    'The Session turn ended before steering was admitted.'
                  );
                }
                return actor.controller.handle(runtimeInput);
              }
            );
            return Object.freeze({
              requestId: command.requestId,
              result: routed.result.type,
              detail: JSON.stringify(routed.result),
              sessionRuntime: routed.runtime,
              ...(resolved ? { contextReceipt: resolved.receipt } : {}),
            });
          }
          const admission = await this.sessionRegistry.admitTurn({
            key,
            expectedRuntimeRevision: command.expectedSessionRuntimeRevision,
            start: async actor => {
              const runtimeResult = actor.controller.handle(runtimeInput);
              return {
                accepted: runtimeResult,
                settled: actor.controller.waitForIdle(),
              };
            },
          });
          if (admission.status === 'queued') {
            return Object.freeze({
              requestId: command.requestId,
              result: 'session_turn_queued',
              queueId: admission.queueId,
              queuePosition: admission.queuePosition,
              sessionRuntime: admission.runtime,
              ...(resolved ? { contextReceipt: resolved.receipt } : {}),
            });
          }
          return Object.freeze({
            requestId: command.requestId,
            result: admission.accepted.type,
            detail: JSON.stringify(admission.accepted),
            sessionRuntime: admission.runtime,
            ...(resolved ? { contextReceipt: resolved.receipt } : {}),
          });
        }

        const routed = await this.sessionRegistry.withActor(
          key,
          command.expectedSessionRuntimeRevision,
          actor => {
            const runtimeResult = actor.controller.handle(runtimeInput);
            if (command.type === 'permission_decision') {
              this.sessionRegistry.setPendingApprovalCount(
                key,
                actor.controller.getPendingPermissions().length
              );
            }
            return runtimeResult;
          }
        );
        return Object.freeze({
          requestId: command.requestId,
          result: routed.result.type,
          detail: JSON.stringify(routed.result),
          sessionRuntime: routed.runtime,
          ...(resolved ? { contextReceipt: resolved.receipt } : {}),
        });
      } catch (error) {
        throw mapSessionRuntimeError(error);
      }
    });
  }

  private async resolveCommandContext(command: WebCommandV1): Promise<
    | {
        readonly text: string;
        readonly receipt: NonNullable<WebCommandResultV1['contextReceipt']>;
      }
    | undefined
  > {
    const references = command.contextReferences ?? [];
    if (references.length === 0) return undefined;
    if (command.type !== 'submit' && command.type !== 'queue_followup') {
      throw new WebWorkbenchError(
        400,
        'Context references are valid only for submitted or queued messages.',
        'context_reference_invalid'
      );
    }
    const resolved: Array<Record<string, unknown>> = [];
    let totalBytes = 0;
    for (const reference of references) {
      let entry: Record<string, unknown>;
      try {
        entry = await this.resolveContextReference(reference);
      } catch (error) {
        throw mapContextReferenceError(error);
      }
      const bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
      if (bytes > MAX_CONTEXT_REFERENCE_BYTES) {
        throw new WebWorkbenchError(
          413,
          'A Context reference exceeds the per-reference byte budget.',
          'context_reference_too_large'
        );
      }
      totalBytes += bytes;
      if (totalBytes > MAX_CONTEXT_MANIFEST_BYTES) {
        throw new WebWorkbenchError(
          413,
          'Context references exceed the request byte budget.',
          'context_reference_too_large'
        );
      }
      resolved.push(Object.freeze(entry));
    }
    const manifestContent = Object.freeze({
      version: 1 as const,
      references: Object.freeze(resolved),
    });
    const manifestDigest = digestRuntimeValue(manifestContent);
    const manifest = Object.freeze({ ...manifestContent, manifestDigest });
    return Object.freeze({
      text: [
        command.text!.trim(),
        '',
        '[Orion Context Manifest V1]',
        JSON.stringify(manifest),
      ].join('\n'),
      receipt: Object.freeze({
        manifestDigest,
        referenceCount: resolved.length,
        totalBytes,
      }),
    });
  }

  private async resolveContextReference(
    reference: WebContextReferenceV1
  ): Promise<Record<string, unknown>> {
    switch (reference.kind) {
      case 'file': {
        const page = this.fileService.readContent({
          fileId: reference.id,
          limitBytes: MAX_CONTEXT_REFERENCE_BYTES,
        });
        if (page.revision !== reference.revision) {
          throw new WebWorkbenchError(409, 'Referenced file changed.', 'context_reference_stale');
        }
        if (page.binary || page.content === undefined) {
          throw new WebWorkbenchError(
            403,
            'Binary files cannot be added to model Context.',
            'context_reference_forbidden'
          );
        }
        return {
          kind: 'file',
          id: reference.id,
          label: this.sanitizeContextText(page.name),
          revision: page.revision,
          content: this.sanitizeContextText(page.content),
          truncated: page.nextCursor !== null,
        };
      }
      case 'folder': {
        const page = this.fileService.list({ parentId: reference.id, pageSize: 100 });
        if (page.revision !== reference.revision) {
          throw new WebWorkbenchError(409, 'Referenced folder changed.', 'context_reference_stale');
        }
        return {
          kind: 'folder',
          id: reference.id,
          label: this.sanitizeContextText(reference.label),
          revision: page.revision,
          entries: page.items
            .filter(item => !item.sensitive)
            .map(item => ({
              name: this.sanitizeContextText(item.name),
              kind: item.kind,
              sizeBytes: item.sizeBytes ?? null,
            })),
          truncated: page.nextCursor !== null,
        };
      }
      case 'review': {
        const snapshot = await this.reviewService.snapshot();
        if (snapshot.repositoryRevision !== reference.gitRevision) {
          throw new WebWorkbenchError(409, 'Referenced Review changed.', 'context_reference_stale');
        }
        return {
          kind: 'review',
          id: reference.id,
          revision: snapshot.repositoryRevision,
          clean: snapshot.clean,
          files: snapshot.changedFiles.slice(0, 100).map(file => ({
            id: file.fileId,
            path: this.sanitizeContextText(file.path),
            indexStatus: file.indexStatus,
            worktreeStatus: file.worktreeStatus,
          })),
          truncated: snapshot.truncated || snapshot.changedFiles.length > 100,
        };
      }
      case 'session': {
        const session = requireSession(reference.id);
        if (canonicalDirectory(session.projectPath) !== this.workspaceValue) {
          throw new WebWorkbenchError(
            403,
            'Referenced Session belongs to another Workspace.',
            'context_reference_forbidden'
          );
        }
        const summary = projectSessionSummary(session);
        if (summary.contextDigest !== reference.digest) {
          throw new WebWorkbenchError(
            409,
            'Referenced Session changed.',
            'context_reference_stale'
          );
        }
        const page = loadThreadSessionSnapshotPageV1(this.workspaceValue, session.id, undefined, 8);
        return {
          kind: 'session',
          id: session.id,
          label: this.sanitizeContextText(
            session.name?.trim() || `Session ${session.id.slice(0, 8)}`
          ),
          digest: summary.contextDigest,
          messages: (page?.transcript.items ?? []).map(message => ({
            role: message.role,
            content: this.sanitizeContextText(message.content),
          })),
          truncated: Boolean(page?.transcript.nextCursor),
        };
      }
      case 'skill': {
        const descriptor = ((await this.runtimeValue.inspectSkills?.()) ?? []).find(
          skill => skill.id === reference.id
        );
        if (!descriptor || descriptor.digest !== reference.digest) {
          throw new WebWorkbenchError(409, 'Referenced Skill changed.', 'context_reference_stale');
        }
        if (!descriptor.userInvocable) {
          throw new WebWorkbenchError(
            403,
            'Referenced Skill is not user-invocable.',
            'context_reference_forbidden'
          );
        }
        return {
          kind: 'skill',
          id: descriptor.id,
          label: this.sanitizeContextText(descriptor.name),
          digest: descriptor.digest,
          invocation: `$${descriptor.id}`,
          description: this.sanitizeContextText(descriptor.description),
        };
      }
    }
  }

  private sanitizeContextText(value: string): string {
    return redactTraceText(value).split(this.workspaceValue).join('<workspace>');
  }

  async updateSettings(
    input: WebSettingsUpdateRequestV1
  ): Promise<Omit<WebSettingsMutationResultV1, 'requestId'>> {
    this.assertContextGuard(input);
    this.assertSettingsAvailable();
    const update = this.runtimeValue.updateSettings;
    if (!update) {
      throw new WebWorkbenchError(
        503,
        'The product Settings coordinator is unavailable.',
        'settings_document_unavailable'
      );
    }
    try {
      const result = await update({
        requestId: input.requestId,
        expectedRevision: input.expectedRevision,
        operations: input.operations,
      });
      return Object.freeze({
        revision: result.revision,
        appliedKeys: result.appliedKeys as WebSettingsMutationResultV1['appliedKeys'],
        settings: result.document as WebSettingsDocumentV1,
      });
    } catch (error) {
      throw mapSettingsError(error);
    }
  }

  async openSettingsDocument(): Promise<true> {
    this.assertSettingsAvailable();
    const coordinator = this.runtimeValue.settingsCoordinator;
    if (!coordinator) {
      throw new WebWorkbenchError(
        503,
        'The product Settings coordinator is unavailable.',
        'settings_document_unavailable'
      );
    }
    try {
      await coordinator.openDocument();
      return true;
    } catch (error) {
      throw mapSettingsError(error);
    }
  }

  executeMutation<T>(
    requestId: string,
    operation: string,
    payload: unknown,
    action: () => T | Promise<T>
  ): Promise<T> {
    if (!requestId.trim() || requestId.length > 128) {
      throw new WebWorkbenchError(
        400,
        'requestId must be a non-empty string up to 128 characters.'
      );
    }
    const fingerprint = digestRuntimeValue({ operation, payload });
    const cached = this.mutationResults.get(requestId);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw new WebWorkbenchError(
          409,
          'requestId was already used for another mutation.',
          'request_id_conflict'
        );
      }
      return cached.result as Promise<T>;
    }
    if (this.mutationResults.size >= MAX_MUTATION_RESULTS) {
      throw new WebWorkbenchError(
        503,
        'The mutation idempotency ledger is full; restart the local Web Host before retrying.',
        'mutation_capacity_exhausted'
      );
    }
    const contextTransition = CONTEXT_TRANSITION_MUTATIONS.has(operation);
    let result: Promise<T>;
    try {
      this.reserveMutation(contextTransition);
      result = Promise.resolve()
        .then(() => {
          this.assertMutationAdmission();
          return action();
        })
        .finally(() => this.releaseMutation(contextTransition));
    } catch (error) {
      // Mutation admission is part of the idempotent result contract. Cache a
      // rejected Promise just like failures raised by the action so a retry of
      // the same requestId cannot observe a different outcome.
      result = Promise.reject(error);
    }
    this.mutationResults.set(requestId, { fingerprint, result });
    return result;
  }

  async diagnostics(context?: WebContextGuardV1): Promise<Record<string, unknown>> {
    if (context) this.assertContextGuard(context);
    const state = this.runtimeValue.store.getSnapshot();
    const mcp = loadFirstPartyMcpConfigurationV1();
    const activeSessionId = this.runtimeValue.getSession()?.id ?? null;
    // Harness diagnostics may need the lazy Session runtime. A read-only Web
    // baseline must not manufacture a Session merely by opening the page.
    const harness = activeSessionId
      ? ((await this.runtimeValue.getHarnessDiagnostics?.()) ?? null)
      : null;
    const result = {
      workspace: this.workspaceValue,
      activeSessionId,
      configured: this.runtimeValue.isConfigured,
      processing: state.isProcessing,
      agentMode: state.agentMode,
      permissionMode: state.permissionMode,
      contextUsage: state.contextUsage,
      tokenUsage: state.tokenUsage,
      plan: state.currentPlan,
      todos: state.todos,
      skills: {
        configuredPaths: this.runtimeValue.config.skills?.paths ?? [],
        loadedFromPrompt: state.skillsContent.length > 0,
      },
      mcp: { servers: mcpServerIds(mcp) },
      harness,
      eventStream: this.eventHub.snapshot(),
      workspaceKernel: this.runtimeValue.workspaceRuntimeKernel?.diagnostics() ?? null,
      performance: {
        files: this.fileService.performanceCounters(),
        git: this.gitService.performanceCounters(),
        thread: {
          eventStore: threadEventStorePerformanceCountersV1(),
          sessionIndex: threadSessionIndexPerformanceCountersV1(),
        },
      },
    };
    if (context) this.assertContextGuard(context);
    return result;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownResult) return this.shutdownResult;
    this.closed = true;
    this.shutdownResult = this.shutdownOwnedResources();
    return this.shutdownResult;
  }

  private async shutdownOwnedResources(): Promise<void> {
    const failures: unknown[] = [];
    this.workspaceMutations.close('Orion Web Workbench shutdown');

    try {
      await this.sessionRegistry.shutdown('Orion Web Workbench shutdown');
    } catch {
      // The registry retains failed actor handles. Retry once after every
      // actor received its first close attempt; a persistent failure remains
      // an explicit Host shutdown error rather than an orphan hidden as GO.
      try {
        await this.sessionRegistry.shutdown('Orion Web Workbench shutdown retry');
      } catch (retryError) {
        failures.push(retryError);
      }
    }
    await captureShutdownFailure(failures, () => this.controllerValue.stopActiveTurn());
    await captureShutdownFailure(failures, () => this.controllerValue.waitForIdle());
    try {
      this.closeWorkspaceWatchers();
      this.closeComposerObserver();
    } catch (error) {
      failures.push(error);
    }
    await captureShutdownFailure(failures, () => this.terminalManager.shutdown());
    await captureShutdownFailure(failures, () => this.runtimeValue.shutdown());
    try {
      this.eventHub.close();
    } catch (error) {
      failures.push(error);
    }
    this.workspaceMutationOwners.clear();
    this.pendingWorkspaceMutationStates.clear();
    if (failures.length > 0) {
      throw new WebWorkbenchError(
        503,
        `${failures.length} Web Workbench resource(s) could not be closed safely.`,
        'workbench_shutdown_incomplete'
      );
    }
  }

  private createSessionRegistry(): WebSessionRuntimeRegistryV1<WebWorkbenchSessionActorV1> {
    return new WebSessionRuntimeRegistryV1<WebWorkbenchSessionActorV1>({
      maxRunningSessions: 3,
      maxResidentSessionActors: 4,
      createActor: key => this.createSessionActor(key),
      initializeActor: actor => actor.runtime.rebindSessionRuntime?.() ?? Promise.resolve(),
      closeActor: (actor, reason) => this.closeSessionActor(actor, reason),
      estimateActorBytes: actor => estimateSessionActorBytes(actor),
      onSummaryChanged: runtime => {
        if (this.closed || this.suppressContextEdges > 0) return;
        this.eventHub.emit({ type: 'session_runtime_changed', runtime }, true, {
          sessionId: runtime.sessionId,
        });
      },
    });
  }

  private async createSessionActor(key: WebSessionActorKeyV1): Promise<WebWorkbenchSessionActorV1> {
    const workspace = this.workspaceRegistry.find(key.workspaceId);
    if (!workspace) {
      throw new WebWorkbenchError(404, 'Workspace was not found.', 'workspace_not_found');
    }
    const session = requireSession(key.sessionId);
    if (canonicalDirectory(session.projectPath) !== workspace.canonicalPath) {
      throw new WebWorkbenchError(
        409,
        'Session belongs to another Workspace.',
        'session_workspace_conflict'
      );
    }
    const runtime = await this.createSessionRuntime(workspace.canonicalPath);
    runtime.setSession(session);
    const actorRef: { current?: WebWorkbenchSessionActorV1 } = {};
    const eventSink = {
      emit: (event: AgentRuntimeEvent): string | void =>
        this.emitSessionActorRuntimeEvent(key, runtime, actorRef.current, event),
    };
    const controller = new AgentRuntimeController({
      runtime,
      eventSink,
      uiRenderer: 'web',
      echoSubmittedInput: false,
      useRuntimeToolPermissions: true,
      uiCapabilities: {
        structuredPickers: true,
        inlineProgress: true,
        suppressLegacyTokenMeta: true,
        extraAssistantSpacing: true,
        suppressAbortNotice: true,
      },
    });
    const actor: WebWorkbenchSessionActorV1 = {
      key: Object.freeze({ ...key }),
      runtime,
      controller,
      composerRevision: randomUUID(),
      latestStatus: 'Ready',
      suppressComposerEdges: 0,
    };
    actorRef.current = actor;
    actor.composerStoreUnsubscribe = runtime.store.subscribe(() =>
      this.scheduleActorComposerStateChanged(actor as WebWorkbenchSessionActorV1)
    );
    actor.composerControlsUnsubscribe = runtime.sessionComposerControls?.subscribe(() =>
      this.scheduleActorComposerStateChanged(actor as WebWorkbenchSessionActorV1)
    );
    return actor;
  }

  private async closeSessionActor(
    actor: WebWorkbenchSessionActorV1,
    _reason: string
  ): Promise<void> {
    if (actor.composerChangeTimer) clearTimeout(actor.composerChangeTimer);
    actor.composerChangeTimer = undefined;
    actor.composerStoreUnsubscribe?.();
    actor.composerControlsUnsubscribe?.();
    actor.composerStoreUnsubscribe = undefined;
    actor.composerControlsUnsubscribe = undefined;
    await actor.controller.stopActiveTurn();
    await actor.controller.waitForIdle();
    await actor.runtime.shutdown();
    this.activeOrionRuntimes.delete(actor.key.sessionId);
    for (const [invocationId, owner] of this.workspaceMutationOwners) {
      if (owner.sessionId === actor.key.sessionId && owner.workspaceId === actor.key.workspaceId) {
        this.workspaceMutationOwners.delete(invocationId);
        this.pendingWorkspaceMutationStates.delete(invocationId);
      }
    }
  }

  private emitSessionActorRuntimeEvent(
    key: WebSessionActorKeyV1,
    runtime: OrionCodeUiRuntime,
    actor: WebWorkbenchSessionActorV1 | undefined,
    event: AgentRuntimeEvent
  ): string | void {
    if (event.type === 'status_changed' && actor) actor.latestStatus = event.message;
    if (event.type === 'followup_queue_changed') {
      if (actor && actor.suppressComposerEdges === 0) {
        this.publishActorComposerState(actor);
      }
      return undefined;
    }
    if (event.type === 'tool_started') {
      this.workspaceMutationOwners.set(event.event.callId, Object.freeze({ ...key }));
    }
    const thread = this.activeOrionRuntimes.get(key.sessionId)?.thread.getProjection().threadId;
    const envelope = this.eventHub.emitRuntime(event, {
      sessionId: key.sessionId,
      ...(thread ? { threadId: thread } : {}),
    });
    if (event.type === 'tool_started') {
      const pendingMutation = this.pendingWorkspaceMutationStates.get(event.event.callId);
      if (pendingMutation) {
        this.pendingWorkspaceMutationStates.delete(event.event.callId);
        this.emitWorkspaceMutationState(pendingMutation);
      }
    }
    if (event.type === 'permission_requested' && actor) {
      this.sessionRegistry.setPendingApprovalCount(
        key,
        actor.controller.getPendingPermissions().length
      );
    }
    if (event.type === 'tool_finished' && key.workspaceId === this.activeWorkspaceEntry().id) {
      this.scheduleWorkspaceResourceInvalidation('tool-finished');
    }
    if (event.type === 'tool_finished') {
      this.workspaceMutationOwners.delete(event.event.callId);
      this.pendingWorkspaceMutationStates.delete(event.event.callId);
    }
    return event.type === 'transcript_append' ? `web-entry-${envelope.cursor}` : undefined;
  }

  private emitWorkspaceMutationState(state: WorkspaceMutationStateV1): void {
    if (this.closed || this.suppressContextEdges > 0) return;
    const owner = this.workspaceMutationOwners.get(state.invocationId);
    if (!owner) {
      if (state.phase === 'queued' || state.phase === 'running') {
        this.pendingWorkspaceMutationStates.set(state.invocationId, Object.freeze({ ...state }));
      } else {
        this.pendingWorkspaceMutationStates.delete(state.invocationId);
      }
      return;
    }
    this.eventHub.emit(
      {
        type: 'workspace_mutation_changed',
        state: {
          callId: state.invocationId,
          phase: state.phase,
          ...(state.queuePosition === undefined ? {} : { queuePosition: state.queuePosition }),
        },
      },
      false,
      { sessionId: owner.sessionId }
    );
    if (['completed', 'failed', 'cancelled'].includes(state.phase)) {
      this.workspaceMutationOwners.delete(state.invocationId);
      this.pendingWorkspaceMutationStates.delete(state.invocationId);
    }
  }

  private scheduleActorComposerStateChanged(actor: WebWorkbenchSessionActorV1): void {
    if (this.closed || actor.suppressComposerEdges > 0) return;
    if (actor.composerChangeTimer) clearTimeout(actor.composerChangeTimer);
    actor.composerChangeTimer = setTimeout(() => {
      actor.composerChangeTimer = undefined;
      if (this.closed || actor.suppressComposerEdges > 0) return;
      this.publishActorComposerState(actor);
    }, 100);
    actor.composerChangeTimer.unref();
  }

  private publishActorComposerState(actor: WebWorkbenchSessionActorV1): void {
    try {
      const state = this.projectActorComposerState(actor, requireSession(actor.key.sessionId));
      this.eventHub.emit({ type: 'composer_state_changed', state }, true, {
        sessionId: actor.key.sessionId,
      });
    } catch {
      // A concurrent actor teardown publishes its final Runtime summary.
    }
  }

  private async installRuntime(workspace: string, publishState = true): Promise<void> {
    this.closeComposerObserver();
    const runtime = await this.createRuntime(workspace);
    this.closeWorkspaceWatchers();
    this.activeOrionRuntime = undefined;
    this.sessionViews.clear();
    this.sessionViewBytes = 0;
    this.latestStatus = 'Ready';
    this.workspaceValue = workspace;
    this.runtimeValue = runtime;
    this.fileService = new FileReadServiceV1(workspace);
    this.gitService = new GitReadModelServiceV1(workspace);
    this.reviewService = new ReviewServiceV1(this.gitService, () =>
      listProjectDurableToolReceiptRefsV1(this.workspaceValue)
    );
    const eventSink = {
      emit: (event: AgentRuntimeEvent): string | void => {
        if (event.type === 'status_changed') this.latestStatus = event.message;
        if (this.suppressContextEdges > 0) return undefined;
        const activeSessionId = this.runtimeValue.getSession()?.id;
        if (event.type === 'followup_queue_changed') {
          // The queue is part of the Composer CAS authority. Publishing the
          // Runtime queue event on its own lets the browser observe new items
          // with an older controlRevision and guarantees a 409 on its next
          // edit/move/remove action. Project one complete Composer state in
          // this same synchronous boundary instead. Composer actions suppress
          // their intermediate queue edge and publish their final state below.
          if (activeSessionId && this.suppressComposerEdges === 0) {
            const state = this.composerState(activeSessionId);
            this.eventHub.emit({ type: 'composer_state_changed', state }, true, {
              sessionId: activeSessionId,
            });
          }
          return undefined;
        }
        const activeThread =
          activeSessionId && this.activeOrionRuntime?.sessionId === activeSessionId
            ? this.activeOrionRuntime.runtime.thread.getProjection().threadId
            : undefined;
        const envelope = this.eventHub.emitRuntime(event, {
          ...(activeSessionId ? { sessionId: activeSessionId } : {}),
          ...(activeThread ? { threadId: activeThread } : {}),
        });
        if (event.type === 'session_restored') this.emitState();
        if (event.type === 'tool_finished') {
          this.scheduleWorkspaceResourceInvalidation('tool-finished');
        }
        return event.type === 'transcript_append' ? `web-entry-${envelope.cursor}` : undefined;
      },
    };
    this.controllerValue = new AgentRuntimeController({
      runtime,
      eventSink,
      uiRenderer: 'web',
      // Thread events are authoritative for Web transcript projection. Echoing here
      // would duplicate every submitted user item when the Thread observer catches up.
      echoSubmittedInput: false,
      useRuntimeToolPermissions: true,
      uiCapabilities: {
        structuredPickers: true,
        inlineProgress: true,
        suppressLegacyTokenMeta: true,
        extraAssistantSpacing: true,
        suppressAbortNotice: true,
      },
    });
    this.composerRevisionValue = randomUUID();
    this.composerAuthorityDigest = undefined;
    this.composerStoreUnsubscribe = runtime.store.subscribe(() =>
      this.scheduleComposerStateChanged()
    );
    this.composerControlsUnsubscribe = runtime.sessionComposerControls?.subscribe(() =>
      this.scheduleComposerStateChanged()
    );
    this.installWorkspaceWatchers();
    if (publishState) this.emitState(false);
  }

  private emitState(advanceRevision = true): void {
    if (this.suppressContextEdges > 0) return;
    if (advanceRevision) this.contextRevisionValue = randomUUID();
    if (advanceRevision) this.composerRevisionValue = randomUUID();
    const workspace = this.activeWorkspaceEntry();
    const sessionId = this.runtimeValue.getSession()?.id ?? null;
    if (sessionId) {
      try {
        this.composerAuthorityDigest = composerAuthorityDigest(
          this.projectComposerStateValue(requireSession(sessionId))
        );
      } catch {
        this.composerAuthorityDigest = undefined;
      }
    } else {
      this.composerAuthorityDigest = undefined;
    }
    this.eventHub.emit({
      type: 'workbench_state',
      contextRevision: this.contextRevisionValue,
      workspaceId: workspace.id,
      workspace: this.workspaceValue,
      activeSessionId: sessionId,
    });
  }

  private emitWorkspaceResourceInvalidation(reason: WebWorkspaceInvalidationReasonV1): void {
    if (this.closed || this.suppressContextEdges > 0) return;
    this.eventHub.emit(
      {
        type: 'workspace_resource_invalidated',
        workspaceId: this.activeWorkspaceEntry().id,
        resources: ['files', 'git', 'review'],
        reason,
      },
      false
    );
  }

  private scheduleWorkspaceResourceInvalidation(reason: WebWorkspaceInvalidationReasonV1): void {
    if (this.closed) return;
    if (this.resourceInvalidationTimer) clearTimeout(this.resourceInvalidationTimer);
    const workspace = this.workspaceValue;
    this.resourceInvalidationTimer = setTimeout(() => {
      this.resourceInvalidationTimer = undefined;
      if (!this.closed && this.workspaceValue === workspace) {
        this.emitWorkspaceResourceInvalidation(reason);
      }
    }, 120);
    this.resourceInvalidationTimer.unref();
  }

  private bumpComposerRevision(): void {
    this.composerRevisionValue = randomUUID();
  }

  private scheduleComposerStateChanged(): void {
    if (
      this.closed ||
      this.suppressComposerEdges > 0 ||
      this.suppressContextEdges > 0 ||
      !this.runtimeValue.getSession()
    ) {
      return;
    }
    if (this.composerChangeTimer) clearTimeout(this.composerChangeTimer);
    this.composerChangeTimer = setTimeout(() => {
      this.composerChangeTimer = undefined;
      const sessionId = this.runtimeValue.getSession()?.id;
      if (!sessionId || this.closed || this.suppressComposerEdges > 0) return;
      try {
        const state = this.composerState(sessionId);
        this.eventHub.emit({ type: 'composer_state_changed', state }, true, { sessionId });
      } catch {
        // A concurrent Context transition publishes a fresh baseline instead.
      }
    }, 100);
    this.composerChangeTimer.unref();
  }

  private closeComposerObserver(): void {
    this.composerStoreUnsubscribe?.();
    this.composerStoreUnsubscribe = undefined;
    this.composerControlsUnsubscribe?.();
    this.composerControlsUnsubscribe = undefined;
    if (this.composerChangeTimer) clearTimeout(this.composerChangeTimer);
    this.composerChangeTimer = undefined;
  }

  private installWorkspaceWatchers(): void {
    const watchPaths = [this.workspaceValue, resolve(this.workspaceValue, '.git')].filter(path =>
      existsSync(path)
    );
    for (const path of watchPaths) {
      try {
        const watcher = watch(path, { persistent: false }, () =>
          this.scheduleWorkspaceResourceInvalidation('filesystem-change')
        );
        watcher.on('error', () => {
          watcher.close();
          this.workspaceWatchers = this.workspaceWatchers.filter(item => item !== watcher);
        });
        this.workspaceWatchers.push(watcher);
      } catch {
        // Watchers are only refresh hints. Revisioned reads and explicit refresh remain authoritative.
      }
    }
  }

  private closeWorkspaceWatchers(): void {
    if (this.resourceInvalidationTimer) clearTimeout(this.resourceInvalidationTimer);
    this.resourceInvalidationTimer = undefined;
    for (const watcher of this.workspaceWatchers) watcher.close();
    this.workspaceWatchers = [];
  }

  private async restoreContextSession(sessionId: string | null): Promise<void> {
    if (!sessionId) {
      this.runtimeValue.setSession(null);
      await this.runtimeValue.rebindSessionRuntime?.();
      if (this.suppressContextEdges === 0) {
        this.eventHub.emitRuntime({ type: 'transcript_clear' });
      }
      return;
    }
    const result = this.controllerValue.handle({
      type: 'select_session',
      sessionId,
      source: 'programmatic',
    });
    await this.controllerValue.waitForIdle();
    if (this.runtimeValue.getSession()?.id !== sessionId) {
      throw new WebWorkbenchError(
        409,
        `Session activation was rejected by the runtime (${result.type}).`,
        'context_session_rejected'
      );
    }
  }

  private emitSettingsWorkspaceChange(): void {
    const describe = this.runtimeValue.describeSettings;
    if (!describe) {
      throw new WebWorkbenchError(
        503,
        'The product Settings coordinator is unavailable.',
        'settings_document_unavailable'
      );
    }
    const settings = describe();
    this.eventHub.emit(
      {
        type: 'settings_invalidated',
        revision: settings.revision,
        reason: 'workspace-change',
        state: settings.state === 'ready' || settings.state === 'read-only' ? 'ready' : 'invalid',
      },
      false
    );
  }

  private observeThreadRuntime(
    runtime: OrionRuntimeV1,
    sessionId: string,
    activation?: ThreadSessionRuntimeActivationV1
  ): () => void {
    let replaying = true;
    const pending: RuntimeEventEnvelopeV1[] = [];
    const unsubscribe = runtime.thread.observeCommittedEvents(events => {
      if (replaying) pending.push(...events);
      else for (const event of events) this.eventHub.emitThread(event, sessionId);
    });
    try {
      const edge = runtime.thread.getProjection().cursor;
      // Historical transcript state comes from the cursor-bound snapshot.
      // Publishing the entire Thread through the live SSE hub on every switch
      // made activation O(history) and evicted the reconnect window.
      replaying = false;
      for (const event of pending
        .filter(event => event.seq > edge)
        .sort((left, right) => left.seq - right.seq)) {
        this.eventHub.emitThread(event, sessionId);
      }
      if (activation?.sessionId === sessionId && activation.view) {
        this.rememberSessionView(sessionId, activation.view);
      }
      this.activeOrionRuntime = { runtime, sessionId };
      this.activeOrionRuntimes.set(sessionId, runtime);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    return () => {
      unsubscribe();
      if (this.activeOrionRuntime?.runtime === runtime) this.activeOrionRuntime = undefined;
      if (this.activeOrionRuntimes.get(sessionId) === runtime) {
        this.activeOrionRuntimes.delete(sessionId);
      }
    };
  }

  private loadSessionView(
    session: SessionMeta,
    activeProjection?: ThreadProjectionV1
  ): ReturnType<typeof loadThreadSessionViewV1> {
    const expectedFingerprint = activeProjection
      ? threadViewFingerprint(activeProjection)
      : session.threadReadModel
        ? [
            session.threadReadModel.threadId,
            session.threadReadModel.cursor,
            session.threadReadModel.projectionDigest,
          ].join(':')
        : undefined;
    const cached = expectedFingerprint ? this.sessionViews.get(session.id) : undefined;
    if (cached && expectedFingerprint && cached.fingerprint === expectedFingerprint) {
      this.sessionViews.delete(session.id);
      this.sessionViews.set(session.id, cached);
      return cached.view;
    }

    const view = loadThreadSessionViewV1(this.workspaceValue, session.id);
    if (!view) return undefined;
    return this.rememberSessionView(session.id, view);
  }

  private rememberSessionView(sessionId: string, view: ThreadSessionViewV1): ThreadSessionViewV1 {
    const previous = this.sessionViews.get(sessionId);
    if (previous) this.sessionViewBytes -= previous.bytes;
    const entry = {
      fingerprint: [view.threadId, view.cursor, view.projectionDigest].join(':'),
      view,
      bytes: estimateSessionViewBytes(view),
    } satisfies CachedSessionView;
    this.sessionViews.delete(sessionId);
    this.sessionViews.set(sessionId, entry);
    this.sessionViewBytes += entry.bytes;
    while (this.sessionViewBytes > SESSION_VIEW_CACHE_BYTES && this.sessionViews.size > 1) {
      const oldest = this.sessionViews.keys().next().value as string | undefined;
      if (!oldest) break;
      const evicted = this.sessionViews.get(oldest);
      this.sessionViews.delete(oldest);
      this.sessionViewBytes -= evicted?.bytes ?? 0;
    }
    return view;
  }

  private assertReadyForTransition(operation: string): void {
    if (this.closed) throw new WebWorkbenchError(503, 'Web Workbench is closed.');
    if (this.transition || this.activeMutationCount > 0) {
      throw new WebWorkbenchError(409, 'A workspace transition is running.', 'runtime_busy');
    }
    if (this.controllerValue.hasActiveTurn()) {
      throw new WebWorkbenchError(
        409,
        `Cannot ${operation} while a turn is active.`,
        'runtime_busy'
      );
    }
    const activeActor = this.sessionRegistry
      .summaries()
      .find(runtime =>
        ['starting', 'queued', 'running', 'waiting_approval', 'stopping'].includes(runtime.phase)
      );
    if (activeActor) {
      throw new WebWorkbenchError(
        409,
        `Cannot ${operation} while Session ${activeActor.sessionId} is ${activeActor.phase}.`,
        'runtime_busy'
      );
    }
  }

  private assertMutationAdmission(): void {
    if (this.closed) throw new WebWorkbenchError(503, 'Web Workbench is closed.');
    if (this.transition) {
      throw new WebWorkbenchError(409, 'A Context transition is running.', 'runtime_busy');
    }
  }

  private reserveMutation(contextTransition: boolean): void {
    this.assertMutationAdmission();
    if (contextTransition) {
      if (this.contextTransitionReserved || this.activeMutationCount > 0) {
        throw new WebWorkbenchError(409, 'Another mutation is still running.', 'runtime_busy');
      }
      this.contextTransitionReserved = true;
      return;
    }
    if (this.contextTransitionReserved) {
      throw new WebWorkbenchError(409, 'A Context transition is being admitted.', 'runtime_busy');
    }
    this.activeMutationCount += 1;
  }

  private releaseMutation(contextTransition: boolean): void {
    if (contextTransition) {
      this.contextTransitionReserved = false;
      return;
    }
    this.activeMutationCount = Math.max(0, this.activeMutationCount - 1);
  }

  private assertContextGuard(context: WebContextGuardV1): void {
    this.assertMutationAdmission();
    if (
      context.expectedContextRevision !== this.contextRevisionValue ||
      context.workspaceId !== this.activeWorkspaceEntry().id
    ) {
      throw new WebWorkbenchError(
        409,
        'The active Context changed before the operation was admitted.',
        'context_revision_conflict'
      );
    }
  }

  private assertCommandSession(expectedSessionId: string): void {
    if (this.closed) throw new WebWorkbenchError(503, 'Web Workbench is closed.');
    if (this.transition) {
      throw new WebWorkbenchError(409, 'A Session transition is running.', 'runtime_busy');
    }
    if (this.runtimeValue.getSession()?.id !== expectedSessionId) {
      throw new WebWorkbenchError(
        409,
        'The active Session changed before the command was admitted.',
        'active_session_changed'
      );
    }
  }

  private assertSessionWorkspace(session: SessionMeta): void {
    if (canonicalDirectory(session.projectPath) !== this.workspaceValue) {
      throw new WebWorkbenchError(
        409,
        'Session belongs to another Workspace.',
        'session_workspace_conflict'
      );
    }
  }

  private sessionActorKey(session: SessionMeta): WebSessionActorKeyV1 {
    this.assertSessionWorkspace(session);
    return Object.freeze({
      workspaceId: this.activeWorkspaceEntry().id,
      sessionId: session.id,
    });
  }

  private assertSettingsAvailable(): void {
    if (this.closed) {
      throw new WebWorkbenchError(503, 'Web Workbench is closed.', 'settings_document_unavailable');
    }
    if (this.transition) {
      throw new WebWorkbenchError(409, 'A workspace transition is running.', 'runtime_busy');
    }
  }

  private initializeWorkspaceRegistry(): void {
    const paths = [this.workspaceValue];
    for (const session of listSessions()) {
      try {
        paths.push(canonicalDirectory(session.projectPath));
      } catch {
        // Unavailable historical projects remain in the Session catalog but
        // are not imported as selectable Workspace registry entries.
      }
    }
    try {
      this.workspaceRegistry.registerKnown(paths, this.workspaceValue);
    } catch (error) {
      throw mapWorkspaceRegistryError(error);
    }
  }

  private activeWorkspaceEntry() {
    const entry = this.workspaceRegistry
      .list()
      .find(candidate => candidate.canonicalPath === this.workspaceValue);
    if (!entry) {
      throw new WebWorkbenchError(503, 'Active Workspace is missing from the registry.');
    }
    return entry;
  }
}

function mapWorkspaceRegistryError(error: unknown): WebWorkbenchError {
  if (error instanceof WebWorkbenchError) return error;
  if (error instanceof WorkspaceRegistryError) {
    const status = error.code === 'workspace_registry_invalid' ? 503 : 409;
    return new WebWorkbenchError(status, error.message, error.code);
  }
  return new WebWorkbenchError(503, 'Workspace registry is unavailable.');
}

function mapSessionRuntimeError(error: unknown): WebWorkbenchError {
  if (error instanceof WebWorkbenchError) return error;
  if (error instanceof WebSessionRuntimeRegistryError) {
    return new WebWorkbenchError(error.status, error.message, error.code);
  }
  throw error;
}

function mapSettingsError(error: unknown): WebWorkbenchError {
  if (error instanceof WebWorkbenchError) return error;
  if (error instanceof SettingsCoordinatorError) {
    return new WebWorkbenchError(error.status, error.message, error.code);
  }
  return new WebWorkbenchError(
    503,
    'The product Settings coordinator is unavailable.',
    'settings_document_unavailable'
  );
}

function mapComposerControlError(error: unknown): WebWorkbenchError {
  if (error instanceof WebWorkbenchError) return error;
  if (error instanceof FollowupQueueConflictError) {
    return new WebWorkbenchError(409, error.message, error.code);
  }
  if (error instanceof SessionComposerControlError) {
    const status =
      error.code === 'composer_recovery_required'
        ? 503
        : ['runtime_busy', 'composer_control_conflict'].includes(error.code)
          ? 409
          : 422;
    return new WebWorkbenchError(status, error.message, error.code);
  }
  if (error instanceof PlanReviewControlError) {
    const status = error.code === 'plan_review_invalid' ? 422 : 409;
    return new WebWorkbenchError(status, error.message, error.code);
  }
  return new WebWorkbenchError(
    503,
    'The Session Composer control action failed.',
    'composer_control_failed'
  );
}

function mapContextReferenceError(error: unknown): WebWorkbenchError {
  if (error instanceof WebWorkbenchError) {
    if (error.code.startsWith('context_reference_')) return error;
    if (
      error.status === 403 ||
      ['sensitive_file_blocked', 'file_binary', 'file_not_regular'].includes(error.code)
    ) {
      return new WebWorkbenchError(
        403,
        'The Context reference is not available to the model.',
        'context_reference_forbidden'
      );
    }
    if (error.status === 404 || error.status === 409) {
      return new WebWorkbenchError(
        409,
        'The Context reference changed or is no longer available.',
        'context_reference_stale'
      );
    }
  }
  return new WebWorkbenchError(
    422,
    'The Context reference could not be resolved.',
    'context_reference_invalid'
  );
}

function composerAuthorityDigest(state: WebComposerControlStateV1): string {
  return digestRuntimeValue({
    workspaceId: state.workspaceId,
    sessionId: state.sessionId,
    mode: state.mode,
    model: state.model,
    permission: state.permission,
    pending: state.pending,
    lastError: state.lastError,
    planReview: state.planReview,
    queue: state.queue,
  });
}

function pickPlanReceipt(receipt: ReturnType<typeof parsePlanReceiptV1>) {
  return Object.freeze({
    body: receipt.plan,
    returnMode: receipt.returnMode,
    digest: receipt.digest,
  });
}

function threadViewFingerprint(projection: ThreadProjectionV1): string {
  return [projection.threadId, projection.cursor, projection.digest].join(':');
}

interface CommitProjectionView {
  readonly seq: number;
  readonly receipt: string;
}

function uniqueCommitProjections(
  commits: readonly (CommitProjectionView | undefined)[]
): CommitProjectionView[] {
  return [...new Map(commits.filter(Boolean).map(commit => [commit!.seq, commit!])).values()].sort(
    (left, right) => left.seq - right.seq
  );
}

function latestAuthorityCommits(projection: ThreadProjectionV1): CommitProjectionView[] {
  const commits = Object.values(projection.turns)
    .flatMap(turn => (turn.commit ? [turn.commit] : []))
    .sort((left, right) => left.seq - right.seq);
  const latest = commits.at(-1);
  const latestPlan = [...commits].reverse().find(commit => {
    try {
      return Boolean(parseTurnCommitV1(commit.receipt).planReceipt);
    } catch {
      return false;
    }
  });
  return uniqueCommitProjections([latestPlan, latest]);
}

function estimateSessionViewBytes(
  view: NonNullable<ReturnType<typeof loadThreadSessionViewV1>>
): number {
  let bytes = 1024;
  for (const message of view.transcriptMessages) {
    bytes += Buffer.byteLength(message.content, 'utf8') + 256;
    if (message.modelVisibleContent) {
      bytes += Buffer.byteLength(message.modelVisibleContent, 'utf8');
    }
  }
  for (const message of view.modelHistory) {
    bytes += Buffer.byteLength(JSON.stringify(message), 'utf8') + 128;
  }
  for (const commit of uniqueCommitProjections([
    view.latestPlanTurnCommit,
    view.latestTurnCommit,
  ])) {
    bytes += Buffer.byteLength(commit.receipt, 'utf8');
  }
  return bytes;
}

export function pageItems<T>(items: readonly T[], cursor?: string, pageSize = 50): WebPageV1<T> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new WebWorkbenchError(400, 'pageSize must be an integer from 1 through 100.');
  }
  const offset = cursor ? decodePageCursor(cursor) : 0;
  if (offset > items.length) throw new WebWorkbenchError(400, 'Page cursor is out of range.');
  const page = items.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  return Object.freeze({
    items: Object.freeze(page),
    nextCursor: nextOffset < items.length ? encodePageCursor(nextOffset) : null,
  });
}

export function pageCollectionItems<T>(
  scope: string,
  items: readonly T[],
  cursor: string | undefined,
  pageSize: number,
  keyOf: (item: T) => string
): WebPageV1<T> {
  if (!scope || scope.length > 80 || !/^[a-z][a-z0-9_-]*$/.test(scope)) {
    throw new WebWorkbenchError(500, 'Collection scope is invalid.');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new WebWorkbenchError(400, 'pageSize must be an integer from 1 through 100.');
  }
  const keys = items.map(keyOf);
  if (keys.some(key => !key || key.length > 4096) || new Set(keys).size !== keys.length) {
    throw new WebWorkbenchError(500, `Collection ${scope} has invalid or duplicate keys.`);
  }
  const revision = digestRuntimeValue(items);
  let offset = 0;
  if (cursor) {
    const decoded = decodeCollectionCursor(cursor, scope);
    if (decoded.revision !== revision) {
      throw new WebWorkbenchError(
        409,
        'Collection changed after this page cursor was issued.',
        'collection_cursor_stale'
      );
    }
    offset = keys.indexOf(decoded.after) + 1;
    if (offset === 0) {
      throw new WebWorkbenchError(
        409,
        'Collection page boundary no longer exists.',
        'collection_cursor_stale'
      );
    }
  }
  const page = items.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  return Object.freeze({
    items: Object.freeze(page),
    nextCursor:
      nextOffset < items.length && page.length > 0
        ? encodeCollectionCursor(scope, revision, keys[nextOffset - 1])
        : null,
  });
}

function pageTranscriptTail<T>(
  items: readonly T[],
  cursor?: string,
  pageSize = 50
): WebPageV1<T> & { readonly offset: number } {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new WebWorkbenchError(400, 'pageSize must be an integer from 1 through 100.');
  }
  const end = cursor ? decodePageCursor(cursor) : items.length;
  if (end > items.length) throw new WebWorkbenchError(400, 'Page cursor is out of range.');
  const offset = Math.max(0, end - pageSize);
  return Object.freeze({
    items: Object.freeze(items.slice(offset, end)),
    nextCursor: offset > 0 ? encodePageCursor(offset) : null,
    offset,
  });
}

function encodePageCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ version: 1, offset })).toString('base64url');
}

function encodeCollectionCursor(scope: string, revision: string, after: string): string {
  return Buffer.from(
    JSON.stringify({ version: 2, kind: 'collection', scope, revision, after })
  ).toString('base64url');
}

function decodeCollectionCursor(
  cursor: string,
  expectedScope: string
): { readonly revision: string; readonly after: string } {
  if (!cursor || cursor.length > 8192) {
    throw new WebWorkbenchError(400, 'Collection page cursor is invalid.');
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).version !== 2 ||
      (parsed as Record<string, unknown>).kind !== 'collection' ||
      (parsed as Record<string, unknown>).scope !== expectedScope ||
      typeof (parsed as Record<string, unknown>).revision !== 'string' ||
      typeof (parsed as Record<string, unknown>).after !== 'string'
    ) {
      throw new Error('invalid');
    }
    return {
      revision: (parsed as Record<string, unknown>).revision as string,
      after: (parsed as Record<string, unknown>).after as string,
    };
  } catch {
    throw new WebWorkbenchError(400, 'Collection page cursor is invalid.');
  }
}

function decodePageCursor(cursor: string): number {
  if (!cursor || cursor.length > 512) throw new WebWorkbenchError(400, 'Page cursor is invalid.');
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { version?: unknown }).version !== 1 ||
      !Number.isSafeInteger((parsed as { offset?: unknown }).offset) ||
      ((parsed as { offset: number }).offset ?? -1) < 0
    ) {
      throw new Error('invalid cursor');
    }
    return (parsed as { offset: number }).offset;
  } catch {
    throw new WebWorkbenchError(400, 'Page cursor is invalid.');
  }
}

function estimateSessionActorBytes(actor: WebWorkbenchSessionActorV1): number {
  try {
    return Math.max(
      256 * 1024,
      Buffer.byteLength(JSON.stringify(actor.runtime.store.getSnapshot()), 'utf8')
    );
  } catch {
    return 256 * 1024;
  }
}

async function captureShutdownFailure(
  failures: unknown[],
  operation: () => void | Promise<void>
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    failures.push(error);
  }
}

function canonicalDirectory(path: string): string {
  const candidate = resolve(path);
  let canonical: string;
  try {
    canonical = realpathSync(candidate);
  } catch {
    throw new WebWorkbenchError(400, 'Workspace path does not exist.');
  }
  try {
    if (!statSync(canonical).isDirectory()) {
      throw new WebWorkbenchError(400, 'Workspace path must be a directory.');
    }
  } catch (error) {
    if (error instanceof WebWorkbenchError) throw error;
    throw new WebWorkbenchError(400, 'Workspace path is not readable.');
  }
  return canonical;
}

function requireSession(sessionId: string): SessionMeta {
  if (!sessionId.trim()) throw new WebWorkbenchError(400, 'Session id is required.');
  const session = loadSessionMeta(sessionId);
  if (!session) throw new WebWorkbenchError(404, 'Session was not found.');
  return session;
}

function mcpServerIds(config: ReturnType<typeof loadFirstPartyMcpConfigurationV1>): string[] {
  const ids = new Set<string>();
  for (const envelope of [config.mcpServers, config.servers, config.orion?.mcp?.servers]) {
    for (const id of Object.keys(envelope ?? {})) ids.add(id);
  }
  return [...ids].sort();
}
