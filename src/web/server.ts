import { randomBytes } from 'crypto';
import { createReadStream, existsSync, realpathSync, statSync } from 'fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { extname, join, normalize, resolve, sep } from 'path';

import { PACKAGE_VERSION } from '../product/version';
import { redactTraceText } from '../services/redaction';
import {
  WEB_MAX_BODY_BYTES,
  WEB_NONCE_HEADER,
  WEB_USER_GESTURE_HEADER,
  WebProtocolError,
  parseWebComposerAction,
  parseWebContextActivate,
  parseWebOpenSettingsDocument,
  parseWebSettingsUpdate,
  type WebContextGuardV1,
} from './protocol';
import { WebWorkbenchError } from './errors';
import { attachTerminalWebSocketServer } from './terminal-server';
import { pageCollectionItems, WebWorkbenchController } from './workbench-controller';

export interface OrionWebServerOptions {
  readonly cwd: string;
  readonly port?: number;
  readonly staticRoot?: string;
  readonly nonce?: string;
  readonly workbench?: WebWorkbenchController;
}

export interface OrionWebServerHandle {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly url: string;
  readonly nonce: string;
  readonly workbench: WebWorkbenchController;
  readonly server: Server;
  close(): Promise<void>;
}

const HOST = '127.0.0.1' as const;
const API_PREFIX = '/api/v1';

export async function startOrionWebServer(
  options: OrionWebServerOptions
): Promise<OrionWebServerHandle> {
  const requestedPort = options.port ?? 3080;
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error('Web port must be an integer from 0 through 65535.');
  }
  const nonce = options.nonce ?? randomBytes(32).toString('base64url');
  if (!/^[A-Za-z0-9_-]+$/u.test(nonce)) {
    throw new Error('Web nonce must use unpadded base64url characters.');
  }
  const workbench =
    options.workbench ?? (await WebWorkbenchController.create({ cwd: options.cwd }));
  const staticRoot = options.staticRoot ?? resolveDefaultStaticRoot();
  let origin = '';
  let closing: Promise<void> | undefined;

  const server = createServer((request, response) => {
    void handleRequest({ request, response, nonce, origin, staticRoot, workbench }).catch(error => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendProblem(response, error);
    });
  });
  const terminalSockets = attachTerminalWebSocketServer(
    server,
    () => origin,
    workbench.terminalManager
  );
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;

  await listen(server, requestedPort);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await workbench.shutdown();
    throw new Error('Web server did not expose a TCP address.');
  }
  const port = address.port;
  origin = `http://${HOST}:${port}`;
  const heartbeat = setInterval(() => workbench.eventHub.heartbeat(), 15_000);
  heartbeat.unref();

  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(heartbeat);
      const failures: unknown[] = [];
      await captureCloseFailure(failures, () => terminalSockets.close());
      await captureCloseFailure(failures, () => workbench.shutdown());
      await captureCloseFailure(failures, () => closeServer(server));
      if (failures.length > 0) {
        const error = new Error('Orion Web Host shutdown was incomplete.');
        Object.defineProperty(error, 'failures', { value: Object.freeze([...failures]) });
        throw error;
      }
    })();
    return closing;
  };

  return Object.freeze({ host: HOST, port, url: origin, nonce, workbench, server, close });
}

async function captureCloseFailure(
  failures: unknown[],
  operation: () => void | Promise<void>
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    failures.push(error);
  }
}

interface RequestContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly nonce: string;
  readonly origin: string;
  readonly staticRoot: string;
  readonly workbench: WebWorkbenchController;
}

async function handleRequest(context: RequestContext): Promise<void> {
  const { request, response } = context;
  applySecurityHeaders(response, context.nonce);
  assertHost(request, context.origin);
  const url = new URL(request.url ?? '/', context.origin);
  if (!url.pathname.startsWith(API_PREFIX)) {
    await serveStatic(request, response, url.pathname, context.staticRoot);
    return;
  }

  const path = url.pathname.slice(API_PREFIX.length) || '/';
  const method = request.method ?? 'GET';
  if (method === 'GET' && path === '/health') {
    sendJson(response, 200, { ok: true, version: PACKAGE_VERSION });
    return;
  }
  if (method === 'GET' && path === '/bootstrap') {
    sendJson(response, 200, context.workbench.bootstrap(context.nonce));
    return;
  }
  if (method === 'GET' && path === '/events') {
    openEventStream(request, response, url, context.workbench);
    return;
  }
  if (method === 'GET' && path === '/workspaces') {
    const contextGuard = requireContextGuardQuery(url);
    sendJson(
      response,
      200,
      collectionPage(
        url,
        'workspaces',
        context.workbench.listWorkspaces(contextGuard),
        workspace => workspace.id
      )
    );
    return;
  }
  const workspaceSessionsMatch = path.match(/^\/workspaces\/([^/]+)\/sessions$/);
  if (method === 'GET' && workspaceSessionsMatch) {
    const workspaceId = safeDecodePathSegment(workspaceSessionsMatch[1]);
    const contextGuard = requireContextGuardQuery(url);
    sendJson(
      response,
      200,
      collectionPage(
        url,
        `workspace-sessions-${workspaceId}`,
        context.workbench.listWorkspaceSessions(workspaceId, contextGuard),
        session => session.id
      )
    );
    return;
  }
  const archivedSessionsMatch = path.match(/^\/workspaces\/([^/]+)\/sessions\/archived$/);
  if (method === 'GET' && archivedSessionsMatch) {
    const workspaceId = safeDecodePathSegment(archivedSessionsMatch[1]);
    const contextGuard = requireContextGuardQuery(url);
    sendJson(
      response,
      200,
      collectionPage(
        url,
        `workspace-sessions-archived-${workspaceId}`,
        context.workbench.listArchivedWorkspaceSessions(workspaceId, contextGuard),
        session => session.id
      )
    );
    return;
  }
  const workspaceSummaryMatch = path.match(/^\/workspaces\/([^/]+)\/summary$/);
  if (method === 'GET' && workspaceSummaryMatch) {
    const workspaceId = requireUuid(safeDecodePathSegment(workspaceSummaryMatch[1]), 'workspaceId');
    sendJson(
      response,
      200,
      await context.workbench.workspaceProjectSummary(workspaceId, requireContextGuardQuery(url))
    );
    return;
  }
  const workspacePinMatch = path.match(/^\/workspaces\/([^/]+)\/pin$/);
  if (method === 'POST' && workspacePinMatch) {
    assertMutation(request, context.nonce, context.origin);
    const body = requireRecord(await readJson(request), 'Workspace pin request');
    assertOnlyKeys(body, ['requestId', 'pinned', 'expectedContextRevision', 'workspaceId']);
    const requestId = requireUuid(body.requestId, 'requestId');
    const contextGuard = requireContextGuardRecord(body);
    if (typeof body.pinned !== 'boolean') {
      throw new WebWorkbenchError(400, 'pinned must be a boolean.', 'invalid_request');
    }
    const workspaceId = requireUuid(safeDecodePathSegment(workspacePinMatch[1]), 'workspaceId');
    const result = await context.workbench.executeMutation(
      requestId,
      'workspace.pin',
      { targetWorkspaceId: workspaceId, pinned: body.pinned, ...contextGuard },
      () => ({
        requestId,
        workspace: context.workbench.setWorkspacePinned(
          workspaceId,
          body.pinned as boolean,
          contextGuard
        ),
      })
    );
    sendJson(response, 200, result);
    return;
  }
  const workspaceRemoveMatch = path.match(/^\/workspaces\/([^/]+)$/);
  if (method === 'DELETE' && workspaceRemoveMatch) {
    assertMutation(request, context.nonce, context.origin);
    const body = requireRecord(await readJson(request), 'Workspace removal request');
    assertOnlyKeys(body, ['requestId', 'expectedContextRevision', 'workspaceId']);
    const requestId = requireUuid(body.requestId, 'requestId');
    const contextGuard = requireContextGuardRecord(body);
    const workspaceId = requireUuid(safeDecodePathSegment(workspaceRemoveMatch[1]), 'workspaceId');
    const result = await context.workbench.executeMutation(
      requestId,
      'workspace.remove',
      { targetWorkspaceId: workspaceId, ...contextGuard },
      () => {
        context.workbench.removeWorkspace(workspaceId, contextGuard);
        return { requestId, removed: true as const };
      }
    );
    sendJson(response, 200, result);
    return;
  }
  if (method === 'POST' && path === '/context/activate') {
    assertMutation(request, context.nonce, context.origin);
    const body = parseWebContextActivate(await readJson(request));
    const result = await context.workbench.executeMutation(
      body.requestId,
      'context.activate',
      {
        expectedContextRevision: body.expectedContextRevision,
        workspaceId: body.workspaceId,
        sessionId: body.sessionId,
      },
      async () => {
        await context.workbench.activateContext(body);
        return {
          requestId: body.requestId,
          contextRevision: context.workbench.contextRevision,
          bootstrap: context.workbench.bootstrap(context.nonce),
        };
      }
    );
    sendJson(response, 200, result);
    return;
  }
  if (method === 'POST' && path === '/workspaces/activate') {
    assertMutation(request, context.nonce, context.origin);
    const body = requireRecord(await readJson(request), 'Workspace request');
    assertOnlyKeys(body, ['requestId', 'path', 'expectedContextRevision', 'workspaceId']);
    const requestId = requireUuid(body.requestId, 'requestId');
    const contextGuard = requireContextGuardRecord(body);
    const workspace = requireText(body.path, 'path', 4096);
    const result = await context.workbench.executeMutation(
      requestId,
      'workspace.activate',
      { path: workspace, ...contextGuard },
      async () => {
        await context.workbench.switchWorkspace(workspace, contextGuard);
        return {
          requestId,
          active: context.workbench.workspace,
          page: pageCollectionItems(
            'workspaces',
            context.workbench.listWorkspaces(),
            undefined,
            50,
            workspace => workspace.id
          ),
        };
      }
    );
    sendJson(response, 200, result);
    return;
  }
  if (method === 'GET' && path === '/sessions') {
    const contextGuard = requireContextGuardQuery(url);
    sendJson(
      response,
      200,
      collectionPage(
        url,
        'sessions',
        context.workbench.listSessions(contextGuard),
        session => session.id
      )
    );
    return;
  }
  if (method === 'POST' && path === '/sessions') {
    assertMutation(request, context.nonce, context.origin);
    const body = requireRecord(await readJson(request), 'Session request');
    assertOnlyKeys(body, ['requestId', 'name', 'expectedContextRevision', 'workspaceId']);
    const requestId = requireUuid(body.requestId, 'requestId');
    const contextGuard = requireContextGuardRecord(body);
    const name = body.name === undefined ? undefined : requireText(body.name, 'name', 120);
    const result = await context.workbench.executeMutation(
      requestId,
      'session.create',
      { name, ...contextGuard },
      async () => ({
        requestId,
        session: await context.workbench.createSession(name, contextGuard),
      })
    );
    sendJson(response, 201, result);
    return;
  }
  const activateMatch = path.match(/^\/sessions\/([^/]+)\/activate$/);
  if (method === 'POST' && activateMatch) {
    assertMutation(request, context.nonce, context.origin);
    const body = requireRecord(await readJson(request), 'Session activation request');
    assertOnlyKeys(body, ['requestId', 'expectedContextRevision', 'workspaceId']);
    const requestId = requireUuid(body.requestId, 'requestId');
    const contextGuard = requireContextGuardRecord(body);
    const sessionId = safeDecodePathSegment(activateMatch[1]);
    const result = await context.workbench.executeMutation(
      requestId,
      'session.activate',
      { sessionId, ...contextGuard },
      async () => ({
        ...(await context.workbench.activateSession(sessionId, contextGuard)),
        requestId,
      })
    );
    sendJson(response, 200, result);
    return;
  }
  const snapshotMatch = path.match(/^\/sessions\/([^/]+)\/snapshot$/);
  if (method === 'GET' && snapshotMatch) {
    const contextGuard = requireContextGuardQuery(url);
    sendJson(
      response,
      200,
      context.workbench.sessionSnapshot(
        safeDecodePathSegment(snapshotMatch[1]),
        url.searchParams.get('cursor') ?? undefined,
        pageSize(url),
        // A recovery snapshot starts at the latest bounded transcript page and
        // pages backward. Older clients did not send the internal `tail=1`
        // hint, so absence must still use the indexed tail path rather than
        // reopening and replaying the complete Thread.
        url.searchParams.get('tail') !== '0',
        contextGuard
      )
    );
    return;
  }
  const composerStateMatch = path.match(/^\/sessions\/([^/]+)\/composer-state$/);
  if (method === 'GET' && composerStateMatch) {
    const contextGuard = requireContextGuardQuery(url);
    sendJson(
      response,
      200,
      context.workbench.composerState(safeDecodePathSegment(composerStateMatch[1]), contextGuard)
    );
    return;
  }
  const modelCatalogMatch = path.match(/^\/sessions\/([^/]+)\/model-catalog$/);
  if (method === 'GET' && modelCatalogMatch) {
    const contextGuard = requireContextGuardQuery(url);
    const sessionId = safeDecodePathSegment(modelCatalogMatch[1]);
    const catalog = context.workbench.modelCatalog(sessionId, contextGuard);
    const page = pageCollectionItems(
      'composer_models',
      catalog.models,
      url.searchParams.get('cursor') ?? undefined,
      pageSize(url),
      model => model.id
    );
    sendJson(response, 200, {
      revision: catalog.revision,
      unavailableProviders: catalog.unavailableProviders,
      ...page,
    });
    return;
  }
  const composerActionMatch = path.match(/^\/sessions\/([^/]+)\/composer-actions$/);
  if (method === 'POST' && composerActionMatch) {
    assertMutation(request, context.nonce, context.origin);
    const sessionId = safeDecodePathSegment(composerActionMatch[1]);
    const body = parseWebComposerAction(await readJson(request));
    if (body.expectedSessionId !== sessionId) {
      throw new WebProtocolError('expectedSessionId must match the Composer action route');
    }
    const result = await context.workbench.executeMutation(
      body.requestId,
      'composer.action',
      body,
      () => context.workbench.applyComposerAction(body)
    );
    sendJson(response, 200, result);
    return;
  }
  const sessionMatch = path.match(/^\/sessions\/([^/]+)$/);
  if (method === 'PATCH' && sessionMatch) {
    assertMutation(request, context.nonce, context.origin);
    const body = requireRecord(await readJson(request), 'Session update request');
    assertOnlyKeys(body, ['requestId', 'name', 'expectedContextRevision', 'workspaceId']);
    const requestId = requireUuid(body.requestId, 'requestId');
    const contextGuard = requireContextGuardRecord(body);
    const name = requireText(body.name, 'name', 120);
    const sessionId = safeDecodePathSegment(sessionMatch[1]);
    const result = await context.workbench.executeMutation(
      requestId,
      'session.rename',
      { sessionId, name, ...contextGuard },
      () => ({
        requestId,
        session: context.workbench.renameSession(sessionId, name, contextGuard),
      })
    );
    sendJson(response, 200, result);
    return;
  }

  // v0.3.7 — Session tags / archive / restore / delete. One mutation family:
  // every body carries a requestId so the idempotency ledger dedupes retries.
  const sessionTagsMatch = path.match(/^\/sessions\/([^/]+)\/tags$/);
  if (method === 'POST' && sessionTagsMatch) {
    assertMutation(request, context.nonce, context.origin);
    const body = requireRecord(await readJson(request), 'Session tags request');
    assertOnlyKeys(body, ['requestId', 'tags', 'expectedContextRevision', 'workspaceId']);
    const requestId = requireUuid(body.requestId, 'requestId');
    const contextGuard = requireContextGuardRecord(body);
    const sessionId = safeDecodePathSegment(sessionTagsMatch[1]);
    const result = await context.workbench.executeMutation(
      requestId,
      'session.tags',
      { sessionId, tags: body.tags, ...contextGuard },
      () => ({
        requestId,
        session: context.workbench.setSessionTags(sessionId, body.tags, contextGuard),
      })
    );
    sendJson(response, 200, result);
    return;
  }

  const sessionArchiveMatch = path.match(/^\/sessions\/([^/]+)\/archive$/);
  if (method === 'POST' && sessionArchiveMatch) {
    assertMutation(request, context.nonce, context.origin);
    const body = requireRecord(await readJson(request), 'Session archive request');
    assertOnlyKeys(body, ['requestId', 'expectedContextRevision', 'workspaceId']);
    const requestId = requireUuid(body.requestId, 'requestId');
    const contextGuard = requireContextGuardRecord(body);
    const sessionId = safeDecodePathSegment(sessionArchiveMatch[1]);
    const result = await context.workbench.executeMutation(
      requestId,
      'session.archive',
      { sessionId, ...contextGuard },
      () => ({
        requestId,
        session: context.workbench.archiveSession(sessionId, contextGuard),
      })
    );
    sendJson(response, 200, result);
    return;
  }

  const sessionRestoreMatch = path.match(/^\/sessions\/([^/]+)\/restore$/);
  if (method === 'POST' && sessionRestoreMatch) {
    assertMutation(request, context.nonce, context.origin);
    const body = requireRecord(await readJson(request), 'Session restore request');
    assertOnlyKeys(body, ['requestId', 'expectedContextRevision', 'workspaceId']);
    const requestId = requireUuid(body.requestId, 'requestId');
    const contextGuard = requireContextGuardRecord(body);
    const sessionId = safeDecodePathSegment(sessionRestoreMatch[1]);
    const result = await context.workbench.executeMutation(
      requestId,
      'session.restore',
      { sessionId, ...contextGuard },
      () => ({
        requestId,
        session: context.workbench.restoreSession(sessionId, contextGuard),
      })
    );
    sendJson(response, 200, result);
    return;
  }

  const sessionDeleteMatch = path.match(/^\/sessions\/([^/]+)$/);
  if (method === 'DELETE' && sessionDeleteMatch) {
    assertMutation(request, context.nonce, context.origin);
    const body = requireRecord(await readJson(request), 'Session delete request');
    assertOnlyKeys(body, ['requestId', 'expectedContextRevision', 'workspaceId']);
    const requestId = requireUuid(body.requestId, 'requestId');
    const contextGuard = requireContextGuardRecord(body);
    const sessionId = safeDecodePathSegment(sessionDeleteMatch[1]);
    const result = await context.workbench.executeMutation(
      requestId,
      'session.delete',
      { sessionId, ...contextGuard },
      () => ({
        requestId,
        deleted: context.workbench.deleteSession(sessionId, contextGuard).deleted,
      })
    );
    sendJson(response, 200, result);
    return;
  }

  if (method === 'POST' && path === '/commands') {
    assertMutation(request, context.nonce, context.origin);
    sendJson(response, 202, await context.workbench.dispatch(await readJson(request)));
    return;
  }
  if (method === 'GET' && path === '/settings') {
    sendJson(response, 200, await context.workbench.settings());
    return;
  }
  if (method === 'PATCH' && path === '/settings') {
    assertMutation(request, context.nonce, context.origin, 'settings_write_forbidden');
    const body = parseWebSettingsUpdate(await readJson(request));
    const result = await context.workbench.executeMutation(
      body.requestId,
      'settings.update',
      {
        workspaceId: body.workspaceId,
        expectedContextRevision: body.expectedContextRevision,
        expectedRevision: body.expectedRevision,
        operations: body.operations,
      },
      async () => ({ requestId: body.requestId, ...(await context.workbench.updateSettings(body)) })
    );
    sendJson(response, 200, result);
    return;
  }
  if (method === 'POST' && path === '/settings/open-document') {
    assertMutation(request, context.nonce, context.origin, 'settings_write_forbidden');
    const { requestId } = parseWebOpenSettingsDocument(await readJson(request));
    const result = await context.workbench.executeMutation(
      requestId,
      'settings.open-document',
      {},
      async () => ({ requestId, opened: await context.workbench.openSettingsDocument() })
    );
    sendJson(response, 200, result);
    return;
  }
  if (method === 'GET' && path === '/skills') {
    const contextGuard = requireContextGuardQuery(url);
    sendJson(
      response,
      200,
      collectionPage(url, 'skills', await context.workbench.skills(contextGuard), skill => skill.id)
    );
    return;
  }
  if (method === 'GET' && path === '/mcp') {
    const contextGuard = requireContextGuardQuery(url);
    sendJson(
      response,
      200,
      collectionPage(url, 'mcp', context.workbench.mcp(contextGuard), server => server.id)
    );
    return;
  }
  if (method === 'GET' && path === '/files') {
    const contextGuard = requireContextGuardQuery(url);
    sendJson(
      response,
      200,
      context.workbench.listFiles(contextGuard, {
        ...(url.searchParams.get('parentId')
          ? { parentId: url.searchParams.get('parentId') as string }
          : {}),
        ...(url.searchParams.get('cursor')
          ? { cursor: url.searchParams.get('cursor') as string }
          : {}),
        pageSize: pageSize(url),
      })
    );
    return;
  }
  const fileContentMatch = path.match(/^\/files\/([^/]+)\/content$/);
  if (method === 'GET' && fileContentMatch) {
    const contextGuard = requireContextGuardQuery(url);
    sendJson(
      response,
      200,
      context.workbench.readFileContent(contextGuard, {
        fileId: safeDecodePathSegment(fileContentMatch[1]),
        ...(url.searchParams.get('cursor')
          ? { cursor: url.searchParams.get('cursor') as string }
          : {}),
        limitBytes: boundedInteger(url.searchParams.get('limitBytes'), 64 * 1024, 1, 256 * 1024),
      })
    );
    return;
  }
  if (method === 'GET' && path === '/git/status') {
    const contextGuard = requireContextGuardQuery(url);
    sendJson(
      response,
      200,
      await context.workbench.gitStatus(contextGuard, {
        ...(url.searchParams.get('cursor')
          ? { cursor: url.searchParams.get('cursor') as string }
          : {}),
        pageSize: boundedInteger(url.searchParams.get('pageSize'), 200, 1, 2_000),
      })
    );
    return;
  }
  if (method === 'GET' && path === '/git/log') {
    const contextGuard = requireContextGuardQuery(url);
    sendJson(
      response,
      200,
      await context.workbench.gitLog(contextGuard, {
        ...(url.searchParams.get('cursor')
          ? { cursor: url.searchParams.get('cursor') as string }
          : {}),
        pageSize: boundedInteger(url.searchParams.get('pageSize'), 30, 1, 100),
      })
    );
    return;
  }
  const gitDiffMatch = path.match(/^\/git\/diff\/([^/]+)$/);
  if (method === 'GET' && gitDiffMatch) {
    const contextGuard = requireContextGuardQuery(url);
    sendJson(
      response,
      200,
      await context.workbench.gitDiff(contextGuard, {
        fileId: safeDecodePathSegment(gitDiffMatch[1]),
        ...(url.searchParams.get('cursor')
          ? { cursor: url.searchParams.get('cursor') as string }
          : {}),
        lineLimit: boundedInteger(url.searchParams.get('lineLimit'), 240, 1, 500),
        byteLimit: boundedInteger(url.searchParams.get('byteLimit'), 256 * 1024, 1024, 1024 * 1024),
      })
    );
    return;
  }
  if (method === 'GET' && path === '/review') {
    sendJson(response, 200, await context.workbench.review(requireContextGuardQuery(url)));
    return;
  }
  if (method === 'GET' && path === '/terminals') {
    const contextGuard = requireContextGuardQuery(url);
    sendJson(
      response,
      200,
      collectionPage(
        url,
        'terminals',
        context.workbench.listTerminals(contextGuard),
        terminal => terminal.id
      )
    );
    return;
  }
  if (method === 'POST' && path === '/terminals') {
    assertMutation(request, context.nonce, context.origin, 'terminal_create_forbidden');
    assertTerminalUserGesture(request);
    const body = requireRecord(await readJson(request), 'Terminal create request');
    assertOnlyKeys(body, ['requestId', 'expectedContextRevision', 'workspaceId', 'cols', 'rows']);
    const requestId = requireUuid(body.requestId, 'requestId');
    const expectedContextRevision = requireUuid(
      body.expectedContextRevision,
      'expectedContextRevision'
    );
    const workspaceId = requireUuid(body.workspaceId, 'workspaceId');
    const cols = boundedIntegerValue(body.cols, 100, 2, 400, 'cols');
    const rows = boundedIntegerValue(body.rows, 30, 1, 200, 'rows');
    const result = await context.workbench.executeMutation(
      requestId,
      'terminal.create',
      { expectedContextRevision, workspaceId, cols, rows },
      () => ({
        requestId,
        ...context.workbench.terminalManager.create({
          expectedContextRevision,
          workspaceId,
          cols,
          rows,
        }),
      })
    );
    sendJson(response, 201, result);
    return;
  }
  const terminalTicketMatch = path.match(/^\/terminals\/([^/]+)\/attach-ticket$/);
  if (method === 'POST' && terminalTicketMatch) {
    assertMutation(request, context.nonce, context.origin, 'terminal_attach_forbidden');
    const body = requireRecord(await readJson(request), 'Terminal ticket request');
    assertOnlyKeys(body, ['requestId', 'expectedContextRevision', 'workspaceId']);
    const requestId = requireUuid(body.requestId, 'requestId');
    const expectedContextRevision = requireUuid(
      body.expectedContextRevision,
      'expectedContextRevision'
    );
    const workspaceId = requireUuid(body.workspaceId, 'workspaceId');
    const terminalId = safeDecodePathSegment(terminalTicketMatch[1]);
    const result = await context.workbench.executeMutation(
      requestId,
      'terminal.attach-ticket',
      { terminalId, expectedContextRevision, workspaceId },
      () => ({
        requestId,
        ...context.workbench.terminalManager.issueAttachTicket({
          terminalId,
          expectedContextRevision,
          workspaceId,
        }),
      })
    );
    sendJson(response, 200, result);
    return;
  }
  const terminalMatch = path.match(/^\/terminals\/([^/]+)$/);
  if (method === 'DELETE' && terminalMatch) {
    assertMutation(request, context.nonce, context.origin, 'terminal_close_forbidden');
    const body = requireRecord(await readJson(request), 'Terminal close request');
    assertOnlyKeys(body, ['requestId', 'expectedContextRevision', 'workspaceId']);
    const requestId = requireUuid(body.requestId, 'requestId');
    const expectedContextRevision = requireUuid(
      body.expectedContextRevision,
      'expectedContextRevision'
    );
    const workspaceId = requireUuid(body.workspaceId, 'workspaceId');
    const terminalId = safeDecodePathSegment(terminalMatch[1]);
    const result = await context.workbench.executeMutation(
      requestId,
      'terminal.close',
      { terminalId, expectedContextRevision, workspaceId },
      () => ({
        requestId,
        terminal: context.workbench.terminalManager.closeTerminal({
          terminalId,
          expectedContextRevision,
          workspaceId,
        }),
      })
    );
    sendJson(response, 200, result);
    return;
  }
  if (method === 'GET' && path === '/tool-details') {
    const contextGuard = requireContextGuardQuery(url);
    sendJson(
      response,
      200,
      collectionPage(
        url,
        'tool-details',
        await context.workbench.listToolDetails(contextGuard),
        detail => `${detail.sequence}:${detail.callId}`
      )
    );
    return;
  }
  const toolDetailMatch = path.match(/^\/tool-details\/([^/]+)$/);
  if (method === 'GET' && toolDetailMatch) {
    const contextGuard = requireContextGuardQuery(url);
    const offsetBytes = boundedInteger(url.searchParams.get('offsetBytes'), 0, 0, 2 ** 31 - 1);
    const limitBytes = boundedInteger(
      url.searchParams.get('limitBytes'),
      64 * 1024,
      1,
      1024 * 1024
    );
    sendJson(
      response,
      200,
      await context.workbench.readToolDetail(
        safeDecodePathSegment(toolDetailMatch[1]),
        offsetBytes,
        limitBytes,
        contextGuard
      )
    );
    return;
  }
  if (method === 'GET' && path === '/diagnostics') {
    sendJson(response, 200, await context.workbench.diagnostics(requireContextGuardQuery(url)));
    return;
  }
  throw new HttpProblem(404, 'Route not found.');
}

function openEventStream(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  workbench: WebWorkbenchController
): void {
  const rawCursor = url.searchParams.get('cursor') ?? request.headers['last-event-id'] ?? '0';
  const cursor = Number(rawCursor);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new HttpProblem(400, 'Event cursor must be a non-negative integer.');
  }
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders();
  response.write('retry: 1000\n\n');
  const detach = workbench.eventHub.attach(response, cursor);
  request.once('aborted', detach);
  response.once('close', detach);
}

function assertMutation(
  request: IncomingMessage,
  nonce: string,
  origin: string,
  forbiddenCode = 'request_forbidden'
): void {
  if (request.headers.origin !== origin) {
    throw new HttpProblem(403, 'Mutation requires the exact loopback Origin.', forbiddenCode);
  }
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new HttpProblem(403, 'Cross-site mutation is not allowed.', forbiddenCode);
  }
  if (request.headers[WEB_NONCE_HEADER] !== nonce) {
    throw new HttpProblem(403, 'Invalid Web Workbench nonce.', forbiddenCode);
  }
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new HttpProblem(415, 'Mutations require application/json.');
  }
}

function assertTerminalUserGesture(request: IncomingMessage): void {
  if (request.headers[WEB_USER_GESTURE_HEADER] !== 'terminal-create-v1') {
    throw new HttpProblem(
      403,
      'Terminal creation requires an explicit browser user gesture.',
      'terminal_user_gesture_required'
    );
  }
}

function assertHost(request: IncomingMessage, origin: string): void {
  if (!origin) return;
  const expected = new URL(origin).host;
  if (request.headers.host !== expected) {
    throw new HttpProblem(421, 'Request Host does not match the loopback listener.');
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > WEB_MAX_BODY_BYTES) {
    throw new HttpProblem(413, 'Request body is too large.');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > WEB_MAX_BODY_BYTES) throw new HttpProblem(413, 'Request body is too large.');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpProblem(400, 'Request body is not valid JSON.');
  }
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  staticRoot: string
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new HttpProblem(405, 'Static assets support only GET and HEAD.');
  }
  if (!existsSync(staticRoot) || !statSync(staticRoot).isDirectory()) {
    throw new HttpProblem(503, 'Web client assets are missing; run npm run build:web.');
  }
  const decoded = safeDecode(pathname);
  const relative = normalize(decoded.replace(/^[/\\]+/, ''));
  if (relative === '..' || relative.startsWith(`..${sep}`)) {
    throw new HttpProblem(403, 'Static asset path escapes the Web root.');
  }
  const resolvedRoot = resolve(staticRoot);
  const candidate = resolve(resolvedRoot, relative || 'index.html');
  const lexicalBoundary = `${resolvedRoot}${sep}`;
  if (candidate !== resolvedRoot && !candidate.startsWith(lexicalBoundary)) {
    throw new HttpProblem(403, 'Static asset path escapes the Web root.');
  }
  const selected =
    existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : join(resolvedRoot, 'index.html');
  if (!existsSync(selected) || !statSync(selected).isFile()) {
    throw new HttpProblem(404, 'Asset not found.');
  }
  const canonicalRoot = realpathSync(resolvedRoot);
  const file = realpathSync(selected);
  const canonicalBoundary = `${canonicalRoot}${sep}`;
  if (file !== canonicalRoot && !file.startsWith(canonicalBoundary)) {
    throw new HttpProblem(403, 'Static asset path escapes the Web root.');
  }
  const headers = {
    'Content-Type': contentType(file),
    'Content-Length': statSync(file).size,
    'Cache-Control': file.endsWith('index.html')
      ? 'no-store'
      : 'public, max-age=31536000, immutable',
  };
  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(file);
    stream.once('error', reject);
    stream.once('end', resolveStream);
    stream.pipe(response);
  });
}

function applySecurityHeaders(response: ServerResponse, styleNonce: string): void {
  response.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'; style-src-elem 'self' 'nonce-${styleNonce}'; style-src-attr 'unsafe-inline'`
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function sendProblem(response: ServerResponse, error: unknown): void {
  const status =
    error instanceof HttpProblem || error instanceof WebWorkbenchError
      ? error.status
      : error instanceof WebProtocolError
        ? error.status
        : 500;
  const detail =
    status >= 500
      ? 'The local Web Workbench request failed.'
      : redactTraceText(error instanceof Error ? error.message : String(error));
  const code =
    error instanceof HttpProblem ||
    error instanceof WebWorkbenchError ||
    error instanceof WebProtocolError
      ? error.code
      : 'web_internal_error';
  const body = JSON.stringify({
    type: `https://orioncode.dev/problems/${code}`,
    title: statusTitle(status),
    status,
    code,
    detail,
  });
  response.writeHead(status, {
    'Content-Type': 'application/problem+json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = defaultProblemCode(status)
  ) {
    super(message);
    this.name = 'HttpProblem';
  }
}

function defaultProblemCode(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request';
    case 403:
      return 'request_forbidden';
    case 409:
      return 'request_conflict';
    case 413:
      return 'request_too_large';
    case 415:
      return 'unsupported_media_type';
    case 421:
      return 'misdirected_request';
    case 503:
      return 'service_unavailable';
    default:
      return `web_${status}`;
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpProblem(400, `${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpProblem(400, `${name} must be a non-empty string.`);
  }
  if (value.length > maxLength) throw new HttpProblem(400, `${name} is too long.`);
  return value.trim();
}

function requireUuid(value: unknown, name: string): string {
  const text = requireText(value, name, 128);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(text)) {
    throw new HttpProblem(400, `${name} must be a UUID.`);
  }
  return text;
}

function requireContextGuardRecord(value: Record<string, unknown>): WebContextGuardV1 {
  return Object.freeze({
    expectedContextRevision: requireUuid(value.expectedContextRevision, 'expectedContextRevision'),
    workspaceId: requireUuid(value.workspaceId, 'workspaceId'),
  });
}

function requireContextGuardQuery(url: URL): WebContextGuardV1 {
  return Object.freeze({
    expectedContextRevision: requireUuid(
      url.searchParams.get('expectedContextRevision'),
      'expectedContextRevision'
    ),
    workspaceId: requireUuid(url.searchParams.get('workspaceId'), 'workspaceId'),
  });
}

function boundedIntegerValue(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new HttpProblem(400, `${name} must be between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown) throw new HttpProblem(400, `Unknown request field: ${unknown}.`);
}

function statusTitle(status: number): string {
  if (status === 400) return 'Invalid request';
  if (status === 403) return 'Request rejected';
  if (status === 404) return 'Not found';
  if (status === 409) return 'State conflict';
  if (status === 413) return 'Payload too large';
  if (status === 415) return 'Unsupported media type';
  if (status === 421) return 'Misdirected request';
  if (status === 503) return 'Service unavailable';
  return 'Internal server error';
}

function safeDecode(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    throw new HttpProblem(400, 'Malformed asset path.');
  }
}

function safeDecodePathSegment(value: string): string {
  const decoded = safeDecode(value);
  if (!decoded || decoded.includes('/') || decoded.includes('\\')) {
    throw new HttpProblem(400, 'Malformed path identifier.');
  }
  return decoded;
}

function boundedInteger(
  raw: string | null,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new HttpProblem(400, `Integer query value must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function pageSize(url: URL): number {
  return boundedInteger(url.searchParams.get('pageSize'), 50, 1, 100);
}

function collectionPage<T>(
  url: URL,
  scope: string,
  items: readonly T[],
  keyOf: (item: T) => string
) {
  return pageCollectionItems(
    scope,
    items,
    url.searchParams.get('cursor') ?? undefined,
    pageSize(url),
    keyOf
  );
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

function resolveDefaultStaticRoot(): string {
  const candidates = [
    resolve(__dirname, '../../dist/web-client'),
    resolve(__dirname, '../../web/dist'),
    resolve(process.cwd(), 'dist/web-client'),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0];
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise(resolveClose => server.close(() => resolveClose()));
}
