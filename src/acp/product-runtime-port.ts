import { realpath, stat } from 'fs/promises';
import { isAbsolute } from 'path';

import {
  createProductUiRuntime,
  type ProductUiRuntimeBootstrapOptions,
} from '../runtime/product-bootstrap';
import type { AgentRuntimeRunnerV1 } from '../runtime/agent-runtime-runner';
import type { FirstPartyMcpConfigurationV1, FirstPartyMcpServerConfigV1 } from '../runtime/mcp';
import type { OrionCodeUiRuntime } from '../runtime/ui-events';
import { SessionLeaseError } from '../runtime/session-ownership-lease';
import {
  loadSessionMeta,
  loadSessionTranscriptMessages,
  resumeSession,
  type SessionMessage,
  type SessionMeta,
} from '../services/session-storage';
import { mapPromptContent } from './content-mapper';
import { OrionAcpEventMapper } from './event-mapper';
import {
  OrionAcpError,
  type OrionAcpCreateSessionInput,
  type OrionAcpLoadSessionInput,
  type OrionAcpMcpServer,
  type OrionAcpPermissionRequest,
  type OrionAcpPromptInput,
  type OrionAcpRuntimeObserver,
  type OrionAcpRuntimePort,
  type OrionAcpStopReason,
} from './runtime-port';

interface ActiveSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly runtime: OrionCodeUiRuntime;
  readonly eventMapper: OrionAcpEventMapper;
  runner?: AgentRuntimeRunnerV1;
  observer?: OrionAcpRuntimeObserver;
  promptAbortController?: AbortController;
  promptExecution?: Promise<OrionAcpStopReason>;
}

export interface ProductOrionAcpRuntimeDependencies {
  readonly createRuntime: (
    options: ProductUiRuntimeBootstrapOptions
  ) => Promise<OrionCodeUiRuntime>;
  readonly loadSessionMeta: (sessionId: string) => SessionMeta | null;
  readonly resumeSession: (sessionId: string) => SessionMeta | null;
  readonly loadSessionTranscriptMessages: (sessionId: string) => readonly SessionMessage[];
}

const defaultDependencies: ProductOrionAcpRuntimeDependencies = {
  createRuntime: createProductUiRuntime,
  loadSessionMeta,
  resumeSession,
  loadSessionTranscriptMessages,
};

export class ProductOrionAcpRuntimePort implements OrionAcpRuntimePort {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly openingOperations = new Set<Promise<unknown>>();
  private readonly openingSessions = new Map<string, Promise<unknown>>();
  private closing = false;
  private closeExecution?: Promise<void>;

  constructor(
    private readonly dependencies: ProductOrionAcpRuntimeDependencies = defaultDependencies
  ) {}

  async createSession(input: OrionAcpCreateSessionInput): Promise<{ readonly sessionId: string }> {
    this.assertOpen();
    assertSessionInputsSupported(input);
    const mcpConfiguration = createAcpMcpConfigurationV1(input.mcpServers);
    return this.trackOpeningOperation(undefined, async () => {
      let runtime: OrionCodeUiRuntime | undefined;
      try {
        const cwd = await canonicalizeWorkingDirectory(input.cwd);
        this.assertOpen();
        runtime = await this.dependencies.createRuntime({
          cwd,
          mcpConfiguration,
          shutdownReason: 'Orion ACP session closed',
        });
        this.assertOpen();
        const session = runtime.ensureSession();
        await requireSessionActivation(runtime)(session);
        this.assertOpen();
        const active = this.createActiveSession(session.id, cwd, runtime);
        this.sessions.set(session.id, active);
        return { sessionId: session.id };
      } catch (error) {
        await runtime?.shutdown();
        throw mapSessionOwnershipError(error);
      }
    });
  }

  async loadSession(input: OrionAcpLoadSessionInput): Promise<void> {
    this.assertOpen();
    assertSessionInputsSupported(input);
    const mcpConfiguration = createAcpMcpConfigurationV1(input.mcpServers);
    if (this.sessions.has(input.sessionId) || this.openingSessions.has(input.sessionId)) {
      throw new OrionAcpError(
        'ORION_ACP_SESSION_BUSY',
        `Session ${input.sessionId} is already loaded in this sidecar.`
      );
    }
    return this.trackOpeningOperation(input.sessionId, async () => {
      const cwd = await canonicalizeWorkingDirectory(input.cwd);
      this.assertOpen();
      const stored = this.dependencies.loadSessionMeta(input.sessionId);
      if (!stored) {
        throw new OrionAcpError(
          'ORION_ACP_SESSION_NOT_FOUND',
          `Session ${input.sessionId} was not found.`
        );
      }
      const storedCwd = await canonicalizeWorkingDirectory(stored.cwd ?? stored.projectPath);
      this.assertOpen();
      if (storedCwd !== cwd) {
        throw new OrionAcpError(
          'ORION_ACP_CWD_MISMATCH',
          'The requested working directory does not match the session owner directory.'
        );
      }

      let runtime: OrionCodeUiRuntime | undefined;
      try {
        runtime = await this.dependencies.createRuntime({
          cwd,
          mcpConfiguration,
          shutdownReason: 'Orion ACP loaded session closed',
        });
        this.assertOpen();
        const resumed = this.dependencies.resumeSession(input.sessionId);
        if (!resumed) {
          throw new OrionAcpError(
            'ORION_ACP_SESSION_NOT_FOUND',
            `Session ${input.sessionId} disappeared while it was being loaded.`
          );
        }
        await requireSessionActivation(runtime)(resumed);
        const active = this.createActiveSession(input.sessionId, cwd, runtime);
        active.observer = input.observer;
        if (active.runner?.restoreSession) {
          await active.runner.restoreSession();
          this.assertOpen();
        }
        active.eventMapper.replaySessionMessages(
          this.dependencies.loadSessionTranscriptMessages(input.sessionId)
        );
        await active.eventMapper.drain();
        this.assertOpen();
        this.sessions.set(input.sessionId, active);
      } catch (error) {
        await runtime?.shutdown();
        throw mapSessionOwnershipError(error);
      }
    });
  }

  async prompt(input: OrionAcpPromptInput): Promise<OrionAcpStopReason> {
    this.assertOpen();
    if (this.openingSessions.has(input.sessionId)) {
      throw new OrionAcpError(
        'ORION_ACP_SESSION_BUSY',
        `Session ${input.sessionId} is still loading.`
      );
    }
    const active = this.requireSession(input.sessionId);
    if (active.promptExecution) {
      throw new OrionAcpError(
        'ORION_ACP_SESSION_BUSY',
        `Session ${input.sessionId} is already processing a prompt.`
      );
    }
    if (!active.runner) {
      throw new OrionAcpError(
        'ORION_ACP_MODEL_NOT_CONFIGURED',
        'Orion Code has no configured model. Configure a provider before sending a prompt.'
      );
    }

    const text = mapPromptContent(input.prompt);
    const abortController = new AbortController();
    const detachInputAbort = forwardAbort(input.signal, abortController);
    active.observer = input.observer;
    active.promptAbortController = abortController;
    const execution = this.runPrompt(active, text, abortController.signal);
    active.promptExecution = execution;
    try {
      return await execution;
    } finally {
      detachInputAbort();
      active.promptExecution = undefined;
      active.promptAbortController = undefined;
      active.observer = undefined;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const active = this.sessions.get(sessionId);
    if (!active) return;
    active.promptAbortController?.abort('ACP session cancelled');
    active.runner?.interrupt?.('ACP session cancelled');
    await active.promptExecution?.catch(() => undefined);
  }

  async closeSession(sessionId: string): Promise<void> {
    const opening = this.openingSessions.get(sessionId);
    if (opening) await Promise.allSettled([opening]);
    const active = this.sessions.get(sessionId);
    if (!active) return;
    this.sessions.delete(sessionId);
    await this.closeActiveSession(active);
  }

  close(): Promise<void> {
    if (!this.closeExecution) {
      this.closing = true;
      this.closeExecution = this.closeAllSessions();
    }
    return this.closeExecution;
  }

  private async closeAllSessions(): Promise<void> {
    await Promise.allSettled([...this.openingOperations]);
    const activeSessions = [...this.sessions.values()];
    this.sessions.clear();
    const results = await Promise.allSettled(
      activeSessions.map(active => this.closeActiveSession(active))
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failure) throw failure.reason;
  }

  private trackOpeningOperation<T>(
    sessionId: string | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    const tracked = operation();
    const finish = (): void => {
      this.openingOperations.delete(tracked);
      if (sessionId && this.openingSessions.get(sessionId) === tracked) {
        this.openingSessions.delete(sessionId);
      }
    };
    this.openingOperations.add(tracked);
    if (sessionId) this.openingSessions.set(sessionId, tracked);
    tracked.then(finish, finish);
    return tracked;
  }

  private createActiveSession(
    sessionId: string,
    cwd: string,
    runtime: OrionCodeUiRuntime
  ): ActiveSession {
    const activeHolder: { active?: ActiveSession } = {};
    const eventMapper = new OrionAcpEventMapper(() => activeHolder.active?.observer);
    const active: ActiveSession = { sessionId, cwd, runtime, eventMapper };
    activeHolder.active = active;
    active.runner = runtime.createAgentRunner?.(eventMapper, {
      replayHistoryOnRestore: false,
      approvalHandler: request =>
        this.requestPermission(active, {
          requestId: request.id,
          toolCallId: request.id,
          name: request.name,
          args: request.args,
          reason: request.reason,
          signal: request.abortSignal,
        }),
    });
    return active;
  }

  private async requestPermission(
    active: ActiveSession,
    request: OrionAcpPermissionRequest
  ): Promise<boolean> {
    const observer = active.observer;
    if (!observer || active.promptAbortController?.signal.aborted) return false;
    try {
      return await observer.requestPermission(request);
    } catch {
      return false;
    }
  }

  private async runPrompt(
    active: ActiveSession,
    text: string,
    signal: AbortSignal
  ): Promise<OrionAcpStopReason> {
    try {
      await active.runner?.runInput(text, { abortSignal: signal });
      await active.eventMapper.drain();
      return signal.aborted ? 'cancelled' : 'end_turn';
    } catch (error) {
      await active.eventMapper.drain();
      if (signal.aborted) return 'cancelled';
      throw error;
    }
  }

  private async closeActiveSession(active: ActiveSession): Promise<void> {
    active.promptAbortController?.abort('ACP session closed');
    active.runner?.interrupt?.('ACP session closed');
    await active.promptExecution?.catch(() => undefined);
    await active.runtime.shutdown();
  }

  private requireSession(sessionId: string): ActiveSession {
    const active = this.sessions.get(sessionId);
    if (!active) {
      throw new OrionAcpError(
        'ORION_ACP_SESSION_NOT_FOUND',
        `Session ${sessionId} is not active in this sidecar.`
      );
    }
    return active;
  }

  private assertOpen(): void {
    if (this.closing) {
      throw new OrionAcpError('ORION_ACP_CLOSED', 'Orion ACP runtime is closed.');
    }
  }
}

export function createProductOrionAcpRuntimePort(): OrionAcpRuntimePort {
  process.env.ORION_CODE_DISABLE_ENV_FILES = '1';
  return new ProductOrionAcpRuntimePort();
}

async function canonicalizeWorkingDirectory(cwd: string): Promise<string> {
  if (!isAbsolute(cwd)) {
    throw new OrionAcpError('ORION_ACP_INVALID_CWD', 'ACP cwd must be an absolute path.');
  }
  let canonical: string;
  try {
    canonical = await realpath(cwd);
  } catch {
    throw new OrionAcpError(
      'ORION_ACP_INVALID_CWD',
      'ACP cwd must resolve to an existing directory.'
    );
  }
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) {
    throw new OrionAcpError('ORION_ACP_INVALID_CWD', 'ACP cwd must be a directory.');
  }
  return canonical;
}

function assertSessionInputsSupported(input: OrionAcpCreateSessionInput): void {
  if ((input.additionalDirectories?.length ?? 0) > 0) {
    throw new OrionAcpError(
      'ORION_ACP_ADDITIONAL_DIRECTORIES_UNSUPPORTED',
      'Additional workspace directories are not supported by this Orion Code version.'
    );
  }
}

function requireSessionActivation(
  runtime: OrionCodeUiRuntime
): NonNullable<OrionCodeUiRuntime['activateSession']> {
  if (!runtime.activateSession) {
    throw new OrionAcpError(
      'ORION_ACP_INTERNAL_ERROR',
      'Orion Code runtime does not provide transactional Session ownership.'
    );
  }
  return runtime.activateSession;
}

function mapSessionOwnershipError(error: unknown): unknown {
  if (!(error instanceof SessionLeaseError)) return error;
  const code =
    error.code === 'ORION_SESSION_BUSY'
      ? 'ORION_ACP_SESSION_BUSY'
      : error.code === 'ORION_INVALID_SESSION_ID'
        ? 'ORION_ACP_INVALID_SESSION_ID'
        : 'ORION_ACP_PROCESS_IDENTITY_UNAVAILABLE';
  return new OrionAcpError(code, error.message);
}

export function createAcpMcpConfigurationV1(
  mcpServers: readonly OrionAcpMcpServer[]
): FirstPartyMcpConfigurationV1 {
  const servers: Record<string, FirstPartyMcpServerConfigV1> = {};
  for (const [index, server] of mcpServers.entries()) {
    const candidate = server as unknown;
    if (!isRecord(candidate)) {
      throw invalidMcpServer(index, 'must be an object');
    }
    if (candidate.type !== undefined) {
      const transport = typeof candidate.type === 'string' ? candidate.type : 'invalid';
      throw new OrionAcpError(
        'ORION_ACP_MCP_UNSUPPORTED_TRANSPORT',
        `ACP MCP server ${index + 1} uses unsupported transport ${transport}.`
      );
    }

    const name = requiredMcpText(candidate.name, index, 'name');
    const command = requiredMcpText(candidate.command, index, 'command');
    if (
      !Array.isArray(candidate.args) ||
      !candidate.args.every(value => typeof value === 'string')
    ) {
      throw invalidMcpServer(index, 'args must be an array of strings');
    }
    if (!Array.isArray(candidate.env)) {
      throw invalidMcpServer(index, 'env must be an array');
    }
    const environment: Record<string, string> = {};
    for (const entry of candidate.env) {
      if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.value !== 'string') {
        throw invalidMcpServer(index, 'env entries must contain string name and value fields');
      }
      const environmentName = entry.name.trim();
      if (!environmentName || environmentName.includes('=')) {
        throw invalidMcpServer(index, 'environment variable names must be non-empty and omit =');
      }
      if (Object.prototype.hasOwnProperty.call(environment, environmentName)) {
        throw invalidMcpServer(index, `contains duplicate environment variable ${environmentName}`);
      }
      environment[environmentName] = entry.value;
    }

    const serverId = `acp-session-${String(index + 1).padStart(4, '0')}`;
    servers[serverId] = {
      type: 'stdio',
      name,
      command,
      args: [...candidate.args],
      env: environment,
    };
  }
  return { mcpServers: servers };
}

function requiredMcpText(value: unknown, index: number, field: 'name' | 'command'): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidMcpServer(index, `${field} must be a non-empty string`);
  }
  return field === 'name' ? value.trim() : value;
}

function invalidMcpServer(index: number, reason: string): OrionAcpError {
  return new OrionAcpError(
    'ORION_ACP_INVALID_MCP_SERVER',
    `ACP MCP server ${index + 1} ${reason}.`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}
