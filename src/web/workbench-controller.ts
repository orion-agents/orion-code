import { realpathSync, statSync } from 'fs';
import { basename, resolve } from 'path';

import { AgentRuntimeController } from '../runtime/agent-runtime-controller';
import type { AgentRuntimeEvent } from '../runtime/agent-runtime-protocol';
import { loadFirstPartyMcpConfigurationV1 } from '../runtime/mcp';
import { createProductUiRuntime } from '../runtime/product-bootstrap';
import type { OrionRuntimeV1 } from '../runtime/orion-runtime-v1';
import { digestRuntimeValue } from '../runtime/protocol/canonical';
import type { RuntimeEventEnvelopeV1 } from '../runtime/protocol/runtime-protocol-v1';
import {
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
import { WebEventHub } from './event-hub';
import {
  WEB_API_VERSION,
  parseWebCommand,
  projectSessionSummary,
  toAgentRuntimeInput,
  type WebBootstrapV1,
  type WebCommandResultV1,
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
} from './protocol';

export class WebWorkbenchError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = status === 409 ? 'request_conflict' : 'web_workbench_error'
  ) {
    super(message);
    this.name = 'WebWorkbenchError';
  }
}

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

export interface WebWorkbenchControllerOptions {
  readonly cwd: string;
  readonly eventHub?: WebEventHub;
  readonly createRuntime?: (cwd: string) => Promise<OrionCodeUiRuntime>;
}

/** Owns the sole runtime/controller pair exposed through the local Web host. */
export class WebWorkbenchController {
  readonly eventHub: WebEventHub;

  private workspaceValue: string;
  private runtimeValue!: OrionCodeUiRuntime;
  private controllerValue!: AgentRuntimeController;
  private activeOrionRuntime?: { readonly runtime: OrionRuntimeV1; readonly sessionId: string };
  private readonly createRuntime: (cwd: string) => Promise<OrionCodeUiRuntime>;
  private readonly mutationResults = new Map<string, CachedMutationResult>();
  private readonly sessionViews = new Map<string, CachedSessionView>();
  private sessionViewBytes = 0;
  private readonly toolDetails = new FileToolDetailRepository();
  private latestStatus = 'Ready';
  private transition: Promise<void> | undefined;
  private closed = false;

  private constructor(options: WebWorkbenchControllerOptions) {
    this.workspaceValue = canonicalDirectory(options.cwd);
    this.eventHub = options.eventHub ?? new WebEventHub();
    this.createRuntime =
      options.createRuntime ??
      (cwd =>
        createProductUiRuntime({
          cwd,
          shutdownReason: 'Orion Web Workbench shutdown',
          onActiveSessionRuntime: (runtime, sessionId, activation) =>
            this.observeThreadRuntime(runtime, sessionId, activation),
          onSettingsInvalidated: event => {
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

  bootstrap(nonce: string): WebBootstrapV1 {
    return Object.freeze({
      apiVersion: WEB_API_VERSION,
      productVersion: this.runtimeValue.version,
      nonce,
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
    const paths = new Set<string>([this.workspaceValue]);
    const counts = new Map<string, number>();
    for (const session of listSessions()) {
      try {
        const path = canonicalDirectory(session.projectPath);
        paths.add(path);
        counts.set(path, (counts.get(path) ?? 0) + 1);
      } catch {
        // Stale projects remain in session history but are not selectable workspaces.
      }
    }
    return Object.freeze(
      [...paths].sort().map(path =>
        Object.freeze({
          path,
          label: basename(path) || path,
          active: path === this.workspaceValue,
          sessionCount: counts.get(path) ?? 0,
        })
      )
    );
  }

  listSessions(): readonly WebSessionSummaryV1[] {
    return Object.freeze(listProjectSessions(this.workspaceValue).map(projectSessionSummary));
  }

  sessionSnapshot(
    sessionId: string,
    cursor?: string,
    pageSize = 50,
    tail = false
  ): WebSessionSnapshotV1 {
    const session = requireSession(sessionId);
    if (canonicalDirectory(session.projectPath) !== this.workspaceValue) {
      throw new WebWorkbenchError(409, 'Session belongs to another workspace.');
    }
    const active = this.runtimeValue.getSession()?.id === session.id;
    const activeProjection =
      this.activeOrionRuntime?.sessionId === session.id
        ? this.activeOrionRuntime.runtime.thread.getProjection()
        : undefined;
    let view: ReturnType<typeof loadThreadSessionViewV1>;
    try {
      view = this.loadSessionView(session, activeProjection);
    } catch (error) {
      if (!activeProjection) throw error;
      view = undefined;
    }
    const transcriptSource = view
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
    const tailPage = tail ? pageTranscriptTail(transcriptSource, cursor, pageSize) : undefined;
    const transcriptPage = tailPage ?? pageItems(transcriptSource, cursor, pageSize);
    const transcriptOffset = tailPage?.offset ?? (cursor ? decodePageCursor(cursor) : 0);
    const transcript = Object.freeze({
      items: Object.freeze(
        transcriptPage.items.map((message, index) => ({
          ...message,
          id: `${session.id}:message:${transcriptOffset + index + 1}`,
        }))
      ),
      nextCursor: transcriptPage.nextCursor,
    });
    const commitProjections = view
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
      activeProjection?.status ?? (view ? 'idle' : 'legacy');
    const goal =
      latestCommit?.goalState && latestCommit.goalStateDigest
        ? {
            authority: 'turn_commit' as const,
            digest: latestCommit.goalStateDigest,
            state: JSON.parse(latestCommit.goalState) as unknown,
          }
        : null;
    return Object.freeze({
      apiVersion: WEB_API_VERSION,
      session: projectSessionSummary(session),
      threadId: activeProjection?.threadId ?? view?.threadId ?? null,
      threadCursor: activeProjection?.cursor ?? view?.cursor ?? 0,
      eventCursor: this.eventHub.snapshot().latest,
      ...(activeProjection?.digest || view?.projectionDigest
        ? { projectionDigest: activeProjection?.digest ?? view?.projectionDigest }
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
      recoveryDiagnostics: view?.diagnostics ?? [],
    });
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
          ...(runtime?.failure ? { failure: runtime.failure } : {}),
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

  async createSession(name?: string): Promise<WebSessionSummaryV1> {
    this.assertReadyForTransition('create a session');
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
  }

  async activateSession(sessionId: string): Promise<WebCommandResultV1> {
    this.assertReadyForTransition('switch sessions');
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
    return { requestId: `activate:${session.id}`, result: result.type };
  }

  renameSession(sessionId: string, name: string): WebSessionSummaryV1 {
    const session = requireSession(sessionId);
    if (canonicalDirectory(session.projectPath) !== this.workspaceValue) {
      throw new WebWorkbenchError(409, 'Session belongs to another workspace.');
    }
    if (name.length > 120) throw new WebWorkbenchError(400, 'Session name is too long.');
    const updated = renameSession(session.id, name);
    if (!updated) throw new WebWorkbenchError(404, 'Session no longer exists.');
    return projectSessionSummary(updated);
  }

  async switchWorkspace(path: string): Promise<void> {
    if (this.transition) throw new WebWorkbenchError(409, 'A workspace transition is running.');
    const next = canonicalDirectory(path);
    if (next === this.workspaceValue) return;
    this.assertReadyForTransition('switch workspaces');
    const previousRuntime = this.runtimeValue;
    const previousController = this.controllerValue;
    const previousWorkspace = this.workspaceValue;
    const transition = (async () => {
      await previousController.stopActiveTurn();
      await previousController.waitForIdle();
      await previousRuntime.shutdown();
      try {
        await this.installRuntime(next);
      } catch (error) {
        try {
          await this.installRuntime(previousWorkspace);
        } catch {
          throw new WebWorkbenchError(
            503,
            'Workspace activation failed and the previous workspace could not be restored.'
          );
        }
        throw error;
      }
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
    })().finally(() => {
      if (this.transition === transition) this.transition = undefined;
    });
    this.transition = transition;
    return transition;
  }

  dispatch(raw: unknown): Promise<WebCommandResultV1> {
    const command = parseWebCommand(raw);
    return this.executeMutation(command.requestId, 'command', command, () => {
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
    const result = Promise.resolve().then(action);
    this.mutationResults.set(requestId, { fingerprint, result });
    while (this.mutationResults.size > 512) {
      const oldest = this.mutationResults.keys().next().value as string | undefined;
      if (!oldest) break;
      this.mutationResults.delete(oldest);
    }
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
    await this.runtimeValue.shutdown();
    this.eventHub.close();
  }

  private async installRuntime(workspace: string): Promise<void> {
    const runtime = await this.createRuntime(workspace);
    this.activeOrionRuntime = undefined;
    this.sessionViews.clear();
    this.sessionViewBytes = 0;
    this.latestStatus = 'Ready';
    this.workspaceValue = workspace;
    this.runtimeValue = runtime;
    const eventSink = {
      emit: (event: AgentRuntimeEvent): string | void => {
        if (event.type === 'status_changed') this.latestStatus = event.message;
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
    this.emitState();
  }

  private emitState(): void {
    this.eventHub.emit({
      type: 'workbench_state',
      workspace: this.workspaceValue,
      activeSessionId: this.runtimeValue.getSession()?.id ?? null,
    });
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
    if (this.transition) {
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

  private assertSettingsAvailable(): void {
    if (this.closed) {
      throw new WebWorkbenchError(503, 'Web Workbench is closed.', 'settings_document_unavailable');
    }
    if (this.transition) {
      throw new WebWorkbenchError(409, 'A workspace transition is running.', 'runtime_busy');
    }
  }
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
