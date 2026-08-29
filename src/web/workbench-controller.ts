import { randomUUID } from 'crypto';
import { existsSync, realpathSync, statSync, watch, type FSWatcher } from 'fs';
import { basename, resolve } from 'path';

import { AgentRuntimeController } from '../runtime/agent-runtime-controller';
import type { AgentRuntimeEvent } from '../runtime/agent-runtime-protocol';
import {
  DurableToolReceiptReaderError,
  listProjectDurableToolReceiptRefsV1,
} from '../runtime/durable-tool-receipt-reader';
import { loadFirstPartyMcpConfigurationV1 } from '../runtime/mcp';
import { createProductUiRuntime } from '../runtime/product-bootstrap';
import type { OrionRuntimeV1 } from '../runtime/orion-runtime-v1';
import { digestRuntimeValue } from '../runtime/protocol/canonical';
import type { RuntimeEventEnvelopeV1 } from '../runtime/protocol/runtime-protocol-v1';
import { ThreadSessionIndexError } from '../runtime/thread-session-index';
import {
  loadThreadSessionSnapshotPageV1,
  loadThreadSessionViewV1,
  type ThreadSessionRuntimeActivationV1,
  type ThreadSessionViewV1,
} from '../runtime/thread-session-view';
import type { ThreadProjectionV1 } from '../runtime/thread-projection';
import { FileToolDetailRepository } from '../runtime/tool-detail-repository';
import { parsePlanReceiptV1, parseTurnCommitV1 } from '../runtime/turn-commit';
import type { OrionCodeUiRuntime } from '../runtime/ui-events';
import { incrementSessionCount } from '../services/global-config';
import { SettingsCoordinatorError } from '../services/settings-coordinator';
import {
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
  WEB_API_VERSION,
  parseWebCommand,
  projectSessionSummary,
  toAgentRuntimeInput,
  type WebBootstrapV1,
  type WebCommandResultV1,
  type WebContextActivateRequestV1,
  type WebContextGuardV1,
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

const SESSION_VIEW_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_MUTATION_RESULTS = 4_096;

export interface WebWorkbenchControllerOptions {
  readonly cwd: string;
  readonly eventHub?: WebEventHub;
  readonly createRuntime?: (cwd: string) => Promise<OrionCodeUiRuntime>;
  readonly workspaceRegistry?: WorkspaceRegistryV1;
}

/** Owns the sole runtime/controller pair exposed through the local Web host. */
export class WebWorkbenchController {
  readonly eventHub: WebEventHub;

  private workspaceValue: string;
  private runtimeValue!: OrionCodeUiRuntime;
  private controllerValue!: AgentRuntimeController;
  private activeOrionRuntime?: { readonly runtime: OrionRuntimeV1; readonly sessionId: string };
  private readonly createRuntime: (cwd: string) => Promise<OrionCodeUiRuntime>;
  private readonly workspaceRegistry: WorkspaceRegistryV1;
  readonly terminalManager: TerminalManagerV1;
  private readonly mutationResults = new Map<string, CachedMutationResult>();
  private readonly sessionViews = new Map<string, CachedSessionView>();
  private sessionViewBytes = 0;
  private readonly toolDetails = new FileToolDetailRepository();
  private fileService!: FileReadServiceV1;
  private gitService!: GitReadModelServiceV1;
  private reviewService!: ReviewServiceV1;
  private contextRevisionValue = randomUUID();
  private suppressContextEdges = 0;
  private latestStatus = 'Ready';
  private transition: Promise<void> | undefined;
  private sessionTransition = false;
  private closed = false;
  private workspaceWatchers: FSWatcher[] = [];
  private resourceInvalidationTimer?: NodeJS.Timeout;

  private constructor(options: WebWorkbenchControllerOptions) {
    this.workspaceValue = canonicalDirectory(options.cwd);
    this.eventHub = options.eventHub ?? new WebEventHub();
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

  listWorkspaces(): readonly WebWorkspaceSummaryV1[] {
    const counts = new Map<string, number>();
    for (const session of listSessions()) {
      try {
        const path = canonicalDirectory(session.projectPath);
        counts.set(path, (counts.get(path) ?? 0) + 1);
      } catch {
        // Stale projects remain in session history but are not selectable workspaces.
      }
    }
    return Object.freeze(
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
  }

  listWorkspaceSessions(workspaceId: string): readonly WebSessionSummaryV1[] {
    const entry = this.workspaceRegistry.find(workspaceId);
    if (!entry) {
      throw new WebWorkbenchError(404, 'Workspace was not found.', 'workspace_not_found');
    }
    try {
      canonicalDirectory(entry.canonicalPath);
    } catch {
      throw new WebWorkbenchError(409, 'Workspace is unavailable.', 'workspace_unavailable');
    }
    return Object.freeze(listProjectSessions(entry.canonicalPath).map(projectSessionSummary));
  }

  async workspaceProjectSummary(workspaceId: string): Promise<WebWorkspaceProjectSummaryV1> {
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
    return Object.freeze({
      workspaceId,
      repositoryRevision: status.repositoryRevision,
      isRepository: status.isRepository,
      branch: status.branch,
      detached: status.detached,
      head: status.head,
      dirtyCount: status.totalFiles,
      conflictCount: status.conflicted.length,
    });
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
    const active = this.runtimeValue.getSession()?.id === session.id;
    const activeProjection =
      this.activeOrionRuntime?.sessionId === session.id
        ? this.activeOrionRuntime.runtime.thread.getProjection()
        : undefined;
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
    const planCommit = [...commits].reverse().find(commit => commit.planReceipt);
    const plan = planCommit?.planReceipt
      ? pickPlanReceipt(parsePlanReceiptV1(planCommit.planReceipt))
      : null;
    const state = this.runtimeValue.store.getSnapshot();
    const pendingPermissions = active
      ? this.controllerValue.getPendingPermissions().map(request => ({
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
    const snapshot = Object.freeze({
      apiVersion: WEB_API_VERSION,
      session: projectSessionSummary(session),
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
        status: this.latestStatus,
        followups: active ? Object.freeze([...this.controllerValue.getFollowupQueue()]) : [],
        followupLimit: 16,
        contextUsage: active ? state.contextUsage : null,
        tokenUsage: active ? state.tokenUsage : null,
      },
      pendingApprovals: Object.freeze(pendingPermissions),
      goal,
      plan,
      recoveryDiagnostics: indexedPage ? [] : (view?.diagnostics ?? []),
    });
    if (context) this.assertContextGuard(context);
    return snapshot;
  }

  async skills(): Promise<readonly WebSkillSummaryV1[]> {
    const descriptors = (await this.runtimeValue.inspectSkills?.()) ?? [];
    return Object.freeze(
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
  }

  mcp(): readonly WebMcpServerSummaryV1[] {
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
    return Object.freeze(
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
  }

  async listToolDetails(): Promise<readonly WebToolDetailSummaryV1[]> {
    return Object.freeze(await this.toolDetails.list(this.workspaceValue));
  }

  async readToolDetail(
    callId: string,
    offsetBytes: number,
    limitBytes: number
  ): Promise<WebToolDetailPageV1> {
    const entry = (await this.toolDetails.list(this.workspaceValue)).find(
      detail => detail.callId === callId || detail.artifactId === callId
    );
    if (!entry?.artifactId) throw new WebWorkbenchError(404, 'Tool detail was not found.');
    return this.toolDetails.read(
      {
        callId: entry.callId,
        sequence: entry.sequence,
        artifactId: entry.artifactId,
        outputBytes: entry.outputBytes,
      },
      { offsetBytes, limitBytes },
      this.workspaceValue
    );
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
    this.assertReadyForTransition('create a session');
    if (context) this.assertContextGuard(context);
    this.sessionTransition = true;
    try {
      // A new Session inherits the durable default; an override on the currently
      // active Session must never leak into the next Session.
      const session = createSession(
        this.workspaceValue,
        this.settings().sections.defaults.model.effectiveValue
      );
      incrementSessionCount();
      const named = name?.trim() ? (renameSession(session.id, name.trim()) ?? session) : session;
      this.runtimeValue.setSession(named);
      await this.runtimeValue.rebindSessionRuntime?.();
      this.eventHub.emitRuntime({ type: 'transcript_clear' });
      this.emitState();
      return projectSessionSummary(named);
    } finally {
      this.sessionTransition = false;
    }
  }

  async activateSession(
    sessionId: string,
    context?: WebContextGuardV1
  ): Promise<WebCommandResultV1> {
    this.assertReadyForTransition('switch sessions');
    if (context) this.assertContextGuard(context);
    this.sessionTransition = true;
    this.suppressContextEdges += 1;
    let activated = false;
    try {
      const session = requireSession(sessionId);
      if (canonicalDirectory(session.projectPath) !== this.workspaceValue) {
        throw new WebWorkbenchError(409, 'Session belongs to another workspace.');
      }
      const result = this.controllerValue.handle({
        type: 'select_session',
        sessionId: session.id,
        source: 'programmatic',
      });
      await this.controllerValue.waitForIdle();
      if (this.runtimeValue.getSession()?.id !== session.id) {
        throw new WebWorkbenchError(409, 'Session activation was rejected by the runtime.');
      }
      activated = true;
      return { requestId: `activate:${session.id}`, result: result.type };
    } finally {
      this.suppressContextEdges -= 1;
      this.sessionTransition = false;
      if (activated) this.emitState();
    }
  }

  renameSession(sessionId: string, name: string, context?: WebContextGuardV1): WebSessionSummaryV1 {
    if (context) this.assertContextGuard(context);
    const session = requireSession(sessionId);
    if (canonicalDirectory(session.projectPath) !== this.workspaceValue) {
      throw new WebWorkbenchError(409, 'Session belongs to another workspace.');
    }
    if (name.length > 120) throw new WebWorkbenchError(400, 'Session name is too long.');
    const updated = renameSession(session.id, name);
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
    if (targetWorkspace === this.workspaceValue && targetSession?.id === currentSessionId) return;
    if (targetWorkspace === this.workspaceValue && !targetSession && currentSessionId === null)
      return;

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
          await previousRuntime.shutdown();
          await this.installRuntime(targetWorkspace, false);
        }
        await this.restoreContextSession(targetSession?.id ?? null);
        this.workspaceRegistry.register(targetWorkspace, { activated: true });
      } catch (activationError) {
        try {
          if (targetWorkspace !== previousWorkspace) {
            if (this.runtimeValue !== previousRuntime) await this.runtimeValue.shutdown();
            await this.installRuntime(previousWorkspace, false);
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
    return this.executeMutation(command.requestId, 'command', command, () => {
      this.assertCommandSession(command.expectedSessionId);
      const runtimeResult = this.controllerValue.handle(toAgentRuntimeInput(command));
      return Object.freeze({
        requestId: command.requestId,
        result: runtimeResult.type,
        detail: JSON.stringify(runtimeResult),
      });
    });
  }

  async updateSettings(
    input: WebSettingsUpdateRequestV1
  ): Promise<Omit<WebSettingsMutationResultV1, 'requestId'>> {
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
    const result = Promise.resolve().then(() => {
      this.assertMutationAdmission();
      return action();
    });
    this.mutationResults.set(requestId, { fingerprint, result });
    return result;
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    const state = this.runtimeValue.store.getSnapshot();
    const mcp = loadFirstPartyMcpConfigurationV1();
    const activeSessionId = this.runtimeValue.getSession()?.id ?? null;
    // Harness diagnostics may need the lazy Session runtime. A read-only Web
    // baseline must not manufacture a Session merely by opening the page.
    const harness = activeSessionId
      ? ((await this.runtimeValue.getHarnessDiagnostics?.()) ?? null)
      : null;
    return {
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
    };
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.controllerValue.stopActiveTurn();
    await this.controllerValue.waitForIdle();
    this.closeWorkspaceWatchers();
    await this.terminalManager.shutdown();
    await this.runtimeValue.shutdown();
    this.eventHub.close();
  }

  private async installRuntime(workspace: string, publishState = true): Promise<void> {
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
    this.installWorkspaceWatchers();
    if (publishState) this.emitState(false);
  }

  private emitState(advanceRevision = true): void {
    if (this.suppressContextEdges > 0) return;
    if (advanceRevision) this.contextRevisionValue = randomUUID();
    const workspace = this.activeWorkspaceEntry();
    this.eventHub.emit({
      type: 'workbench_state',
      contextRevision: this.contextRevisionValue,
      workspaceId: workspace.id,
      workspace: this.workspaceValue,
      activeSessionId: this.runtimeValue.getSession()?.id ?? null,
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
    } catch (error) {
      unsubscribe();
      throw error;
    }
    return () => {
      unsubscribe();
      if (this.activeOrionRuntime?.runtime === runtime) this.activeOrionRuntime = undefined;
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
    if (this.transition || this.sessionTransition) {
      throw new WebWorkbenchError(409, 'A workspace transition is running.', 'runtime_busy');
    }
    if (this.controllerValue.hasActiveTurn()) {
      throw new WebWorkbenchError(
        409,
        `Cannot ${operation} while a turn is active.`,
        'runtime_busy'
      );
    }
  }

  private assertMutationAdmission(): void {
    if (this.closed) throw new WebWorkbenchError(503, 'Web Workbench is closed.');
    if (this.transition || this.sessionTransition) {
      throw new WebWorkbenchError(409, 'A Context transition is running.', 'runtime_busy');
    }
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
    if (this.transition || this.sessionTransition) {
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
