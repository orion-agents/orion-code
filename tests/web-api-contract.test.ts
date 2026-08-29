import { readFileSync } from 'fs';
import { resolve } from 'path';

import { load } from 'js-yaml';

type JsonObject = Record<string, unknown>;

const contractPath = resolve(__dirname, '../docs/architecture/v0.3.1-web-api.yaml');

describe('Orion Web OpenAPI contract', () => {
  const document = load(readFileSync(contractPath, 'utf8')) as JsonObject;

  test('resolves every internal reference and keeps operation ids unique', () => {
    const references: string[] = [];
    visit(document, value => {
      if (typeof value.$ref === 'string') references.push(value.$ref);
    });
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) expect(resolveReference(document, reference)).toBeDefined();

    const operationIds = collectOperations(document).map(operation => operation.operationId);
    expect(operationIds.every(value => typeof value === 'string' && value.length > 0)).toBe(true);
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  test('requires requestId on every mutation and an atomic Settings batch CAS', () => {
    const mutations = collectOperations(document).filter(operation => operation.method !== 'get');
    expect(mutations).toHaveLength(13);
    for (const operation of mutations) {
      const schema = requestSchema(document, operation.value);
      expect(schema.required).toEqual(expect.arrayContaining(['requestId']));
      expect(operation.value.security).toEqual(
        expect.arrayContaining([expect.objectContaining({ webNonce: [] })])
      );
    }

    const requestId = resolveReference(document, '#/components/schemas/RequestId') as JsonObject;
    expect(requestId.format).toBe('uuid');

    const settings = resolveReference(
      document,
      '#/components/schemas/UpdateSettingsRequest'
    ) as JsonObject;
    expect(settings.required).toEqual(['requestId', 'expectedRevision', 'operations']);
    const operations = settings.properties as JsonObject;
    expect((operations.operations as JsonObject).minItems).toBe(1);
    expect((operations.operations as JsonObject).maxItems).toBe(20);

    const revision = resolveReference(
      document,
      '#/components/schemas/SettingsRevision'
    ) as JsonObject;
    expect(revision.pattern).toBe('^hmac-sha256:[a-f0-9]{64}$');

    const settingsDocument = resolveReference(
      document,
      '#/components/schemas/SettingsDocument'
    ) as JsonObject;
    expect(settingsDocument.required).toEqual(
      expect.arrayContaining(['revision', 'state', 'workspace', 'sections', 'credentials'])
    );
    const serialized = JSON.stringify(settingsDocument).toLowerCase();
    for (const forbidden of ['apikey', 'authorization', 'cookie', 'password', 'secretvalue']) {
      expect(serialized).not.toContain(forbidden);
    }

    const paths = document.paths as JsonObject;
    const openDocument = paths['/settings/open-document'] as JsonObject;
    const openSchema = requestSchema(document, openDocument.post as JsonObject);
    expect(openSchema.required).toEqual(['requestId']);
    expect(openSchema.properties as JsonObject).not.toHaveProperty('path');
  });

  test('keeps recovery, project tool details and event identities explicit', () => {
    const paths = document.paths as JsonObject;
    expect(paths).toHaveProperty('/sessions/{sessionId}/snapshot');
    expect(paths).toHaveProperty('/tool-details');
    expect(paths).toHaveProperty('/tool-details/{callId}');
    expect(paths).not.toHaveProperty('/sessions/{sessionId}/tool-details');

    const snapshot = resolveReference(
      document,
      '#/components/schemas/SessionSnapshot'
    ) as JsonObject;
    expect(snapshot.required).toEqual(
      expect.arrayContaining([
        'threadId',
        'threadCursor',
        'eventCursor',
        'transcript',
        'pendingApprovals',
        'goal',
        'plan',
      ])
    );

    const event = resolveReference(document, '#/components/schemas/WebEventEnvelope') as JsonObject;
    expect(event.oneOf).toHaveLength(6);
    for (const branch of event.oneOf as JsonObject[]) {
      const schema = resolveReference(document, branch.$ref as string) as JsonObject;
      expect(schema.required).toEqual(
        expect.arrayContaining(['eventId', 'cursor', 'sessionId', 'threadId', 'type'])
      );
    }
  });

  test('freezes multi-project, read-only engineering and isolated terminal routes', () => {
    const paths = document.paths as JsonObject;
    for (const path of [
      '/workspaces/{workspaceId}/sessions',
      '/workspaces/{workspaceId}/summary',
      '/context/activate',
      '/files',
      '/files/{fileId}/content',
      '/git/status',
      '/git/log',
      '/git/diff/{fileId}',
      '/review',
      '/terminals',
      '/terminals/{terminalId}/attach-ticket',
      '/terminals/{terminalId}',
      '/terminals/{terminalId}/stream',
    ]) {
      expect(paths).toHaveProperty(path);
    }

    const context = requestSchema(
      document,
      (paths['/context/activate'] as JsonObject).post as JsonObject
    );
    expect(context.required).toEqual([
      'requestId',
      'expectedContextRevision',
      'workspaceId',
      'sessionId',
    ]);

    const createTerminal = (paths['/terminals'] as JsonObject).post as JsonObject;
    expect(createTerminal.security).toEqual([{ webNonce: [], terminalUserGesture: [] }]);
    const stream = (paths['/terminals/{terminalId}/stream'] as JsonObject).get as JsonObject;
    const websocket = stream['x-orion-websocket'] as JsonObject;
    expect(websocket.subprotocol).toBe('orion-terminal-v1');
    expect(JSON.stringify(stream)).toContain('TerminalAuthenticateMessage');
    expect(JSON.stringify(stream)).not.toContain('EventSource');

    const bootstrap = resolveReference(
      document,
      '#/components/schemas/BootstrapResponse'
    ) as JsonObject;
    expect(bootstrap.required).toEqual(
      expect.arrayContaining(['contextRevision', 'workspaceId', 'capabilities'])
    );
    expect(JSON.stringify(bootstrap)).toContain('terminal');

    const fileNode = resolveReference(document, '#/components/schemas/FileNode') as JsonObject;
    expect(fileNode.required).toEqual(expect.arrayContaining(['id', 'displayPath']));
    expect(JSON.stringify((fileNode.properties as JsonObject).displayPath)).toContain(
      'workspace-relative'
    );

    const verification = resolveReference(
      document,
      '#/components/schemas/ReviewVerification'
    ) as JsonObject;
    expect(verification.required).toEqual(
      expect.arrayContaining([
        'sessionId',
        'threadId',
        'sequence',
        'terminal',
        'success',
        'executionPolicyDigest',
        'receiptDigest',
      ])
    );
    expect(((verification.properties as JsonObject).terminal as JsonObject).enum).toEqual([
      'completed',
      'failed',
      'interrupted',
      'indeterminate',
    ]);
  });

  test('guards active context operations and makes stale admission side-effect free', () => {
    const paths = document.paths as JsonObject;
    const guardedReads = [
      '/workspaces',
      '/sessions',
      '/sessions/{sessionId}/snapshot',
      '/files',
      '/files/{fileId}/content',
      '/git/status',
      '/git/log',
      '/git/diff/{fileId}',
      '/review',
      '/terminals',
      '/tool-details',
      '/tool-details/{callId}',
      '/skills',
      '/mcp',
      '/diagnostics',
    ];
    for (const path of guardedReads) {
      const operation = (paths[path] as JsonObject).get as JsonObject;
      expect(operation.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ $ref: '#/components/parameters/ContextWorkspaceId' }),
          expect.objectContaining({ $ref: '#/components/parameters/ExpectedContextRevision' }),
        ])
      );
      expect(operation.responses as JsonObject).toHaveProperty('409');
    }

    for (const path of [
      '/workspaces/{workspaceId}/sessions',
      '/workspaces/{workspaceId}/summary',
    ]) {
      const operation = (paths[path] as JsonObject).get as JsonObject;
      expect(operation.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ $ref: '#/components/parameters/WorkspaceId' }),
          expect.objectContaining({ $ref: '#/components/parameters/ContextWorkspaceId' }),
          expect.objectContaining({ $ref: '#/components/parameters/ExpectedContextRevision' }),
        ])
      );
      expect(operation.responses as JsonObject).toHaveProperty('409');
    }

    const guardedMutationSchemas = [
      '#/components/schemas/ContextActivateRequest',
      '#/components/schemas/ActivateWorkspaceRequest',
      '#/components/schemas/CreateSessionRequest',
      '#/components/schemas/RenameSessionRequest',
      '#/components/schemas/ContextGuardRequest',
      '#/components/schemas/TerminalCreateRequest',
      '#/components/schemas/WebCommand',
    ];
    for (const reference of guardedMutationSchemas) {
      const schema = resolveReference(document, reference) as JsonObject;
      expect(schema.required).toEqual(
        expect.arrayContaining(['requestId', 'expectedContextRevision'])
      );
    }

    const expectedContext = resolveReference(
      document,
      '#/components/parameters/ExpectedContextRevision'
    ) as JsonObject;
    expect(expectedContext.description).toContain('409 context_revision_conflict');
    expect(expectedContext.description).toContain('zero side effects');
    const conflict = resolveReference(
      document,
      '#/components/responses/ContextConflict'
    ) as JsonObject;
    expect(JSON.stringify(conflict)).toContain('context_revision_conflict');
    expect(JSON.stringify(conflict)).toContain('zero side effects');
  });

  test('separates revision-bound collection and transcript cursor contracts', () => {
    const paths = document.paths as JsonObject;
    for (const path of ['/workspaces', '/sessions', '/skills', '/mcp', '/tool-details']) {
      const operation = (paths[path] as JsonObject).get as JsonObject;
      expect(operation.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ $ref: '#/components/parameters/CollectionCursor' }),
        ])
      );
      expect(operation.responses as JsonObject).toHaveProperty('409');
    }

    const workspaceSessions = (paths['/workspaces/{workspaceId}/sessions'] as JsonObject)
      .get as JsonObject;
    expect(workspaceSessions.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ $ref: '#/components/parameters/CollectionCursor' }),
      ])
    );
    expect(workspaceSessions.responses as JsonObject).toHaveProperty('409');

    for (const path of ['/files', '/files/{fileId}/content', '/git/status', '/git/log']) {
      const operation = (paths[path] as JsonObject).get as JsonObject;
      expect(operation.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ $ref: '#/components/parameters/ResourceCursor' }),
        ])
      );
      expect(operation.responses as JsonObject).toHaveProperty('409');
    }

    const snapshot = (paths['/sessions/{sessionId}/snapshot'] as JsonObject).get as JsonObject;
    expect(snapshot.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ $ref: '#/components/parameters/TranscriptCursor' }),
      ])
    );
    expect(snapshot.responses as JsonObject).toHaveProperty('409');

    const parameters = ((document.components as JsonObject).parameters ?? {}) as JsonObject;
    expect((parameters.CollectionCursor as JsonObject).description).toContain(
      'collection_cursor_stale'
    );
    expect((parameters.TranscriptCursor as JsonObject).description).toContain(
      'transcript_cursor_stale'
    );
    expect(
      ((paths['/tool-details/{callId}'] as JsonObject).get as JsonObject).description as string
    ).toContain('pre-sanitized derivative');
  });
});

function collectOperations(document: JsonObject): Array<{
  readonly method: string;
  readonly operationId: unknown;
  readonly value: JsonObject;
}> {
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
  const operations: Array<{ method: string; operationId: unknown; value: JsonObject }> = [];
  for (const pathItem of Object.values(document.paths as JsonObject)) {
    if (!isObject(pathItem)) continue;
    for (const [method, value] of Object.entries(pathItem)) {
      if (methods.has(method) && isObject(value)) {
        operations.push({ method, operationId: value.operationId, value });
      }
    }
  }
  return operations;
}

function requestSchema(document: JsonObject, operation: JsonObject): JsonObject {
  const requestBody = operation.requestBody;
  if (!isObject(requestBody) || !isObject(requestBody.content)) throw new Error('Missing body');
  const media = requestBody.content['application/json'];
  if (!isObject(media) || !isObject(media.schema)) throw new Error('Missing JSON schema');
  return typeof media.schema.$ref === 'string'
    ? (resolveReference(document, media.schema.$ref) as JsonObject)
    : media.schema;
}

function resolveReference(document: JsonObject, reference: string): unknown {
  if (!reference.startsWith('#/')) throw new Error(`Unsupported reference: ${reference}`);
  return reference
    .slice(2)
    .split('/')
    .map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>((value, segment) => (isObject(value) ? value[segment] : undefined), document);
}

function visit(value: unknown, visitor: (value: JsonObject) => void): void {
  if (Array.isArray(value)) {
    value.forEach(entry => visit(entry, visitor));
    return;
  }
  if (!isObject(value)) return;
  visitor(value);
  Object.values(value).forEach(entry => visit(entry, visitor));
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
