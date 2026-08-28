import { readFileSync } from 'fs';
import { resolve } from 'path';

import { load } from 'js-yaml';

type JsonObject = Record<string, unknown>;

const contractPath = resolve(__dirname, '../docs/architecture/v0.3.0-web-api.yaml');

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
    expect(mutations).toHaveLength(7);
    for (const operation of mutations) {
      const schema = requestSchema(document, operation.value);
      expect(schema.required).toEqual(expect.arrayContaining(['requestId']));
    }

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
    expect(event.oneOf).toHaveLength(5);
    for (const branch of event.oneOf as JsonObject[]) {
      const schema = resolveReference(document, branch.$ref as string) as JsonObject;
      expect(schema.required).toEqual(
        expect.arrayContaining(['eventId', 'cursor', 'sessionId', 'threadId', 'type'])
      );
    }
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
