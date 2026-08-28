import { createHmac } from 'crypto';
import { spawn } from 'child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SETTINGS_REVISION_KEY_FILE,
  SettingsDocumentRepository,
  SettingsDocumentRepositoryError,
  type SettingsRepositoryInvalidationV1,
} from '../src/services/settings-document-repository';

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function waitForEvent(
  events: SettingsRepositoryInvalidationV1[],
  predicate: (event: SettingsRepositoryInvalidationV1) => boolean
): Promise<SettingsRepositoryInvalidationV1> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 3_000;
    const poll = (): void => {
      const event = events.find(predicate);
      if (event) return resolve(event);
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for settings event'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function expectRepositoryCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error('Expected repository operation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(SettingsDocumentRepositoryError);
    expect(error).toMatchObject({ code });
  }
}

function runChildWriter(
  documentPath: string,
  revisionKeyPath: string,
  revision: string,
  theme: 'light' | 'dark'
): Promise<number | null> {
  const script = `
    require('ts-node/register/transpile-only');
    const { SettingsDocumentRepository } = require('./src/services/settings-document-repository');
    const repository = SettingsDocumentRepository.create({
      documentPath: process.env.ORION_TEST_DOCUMENT,
      revisionKeyPath: process.env.ORION_TEST_REVISION_KEY,
    });
    try {
      repository.persist('/workspace', process.env.ORION_TEST_REVISION, [
        { op: 'set', key: 'appearance.theme', value: process.env.ORION_TEST_THEME },
      ]);
    } catch (error) {
      process.exitCode = error && error.code === 'settings_revision_conflict' ? 2 : 3;
    } finally {
      repository.close();
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ORION_TEST_DOCUMENT: documentPath,
        ORION_TEST_REVISION_KEY: revisionKeyPath,
        ORION_TEST_REVISION: revision,
        ORION_TEST_THEME: theme,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 3) return reject(new Error(`Child settings writer failed: ${stderr}`));
      resolve(code);
    });
  });
}

describe('SettingsDocumentRepository', () => {
  let root: string;
  let documentPath: string;
  let revisionKeyPath: string;
  const repositories: SettingsDocumentRepository[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-settings-repository-'));
    documentPath = join(root, 'orion.json');
    revisionKeyPath = join(root, SETTINGS_REVISION_KEY_FILE);
  });

  afterEach(() => {
    for (const repository of repositories.splice(0)) repository.close();
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  });

  function create(): SettingsDocumentRepository {
    const repository = SettingsDocumentRepository.create({
      documentPath,
      revisionKeyPath,
      watchDebounceMs: 5,
    });
    repositories.push(repository);
    return repository;
  }

  test('uses a stable 0600 machine key and HMACs the exact document bytes', () => {
    const exactBytes = Buffer.from('{"schemaVersion":1, "defaultModel":"gpt-4o"}\n', 'utf8');
    writeFileSync(documentPath, exactBytes, { mode: 0o644 });
    const first = create();
    const snapshot = first.read();
    const key = readFileSync(revisionKeyPath);
    const expected = `hmac-sha256:${createHmac('sha256', key).update(exactBytes).digest('hex')}`;

    expect(snapshot.revision).toBe(expected);
    expect(snapshot.revision).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(mode(revisionKeyPath)).toBe(0o600);
    expect(key).toHaveLength(32);

    first.close();
    repositories.splice(repositories.indexOf(first), 1);
    expect(create().read().revision).toBe(expected);
  });

  test('uses a stable missing sentinel and creates orion.json atomically with 0600 mode', () => {
    const repository = create();
    const missing = repository.read();
    expect(missing).toMatchObject({ state: 'ready', hasDocument: false });

    const persisted = repository.persist('/workspace', missing.revision, [
      { op: 'set', key: 'appearance.theme', value: 'dark' },
    ]);

    expect(persisted.revision).not.toBe(missing.revision);
    expect(mode(documentPath)).toBe(0o600);
    expect(JSON.parse(readFileSync(documentPath, 'utf8'))).toEqual({
      schemaVersion: 1,
      web: { appearance: { theme: 'dark' } },
    });

    const keyHex = readFileSync(revisionKeyPath).toString('hex');
    expect(readFileSync(documentPath, 'utf8')).not.toContain(keyHex);
  });

  test('preserves unknown fields, credentials, arrays, and the exact caller workspace key', () => {
    const nestedCwd = '/repo/packages/web';
    const original = {
      schemaVersion: 1,
      providers: [
        {
          id: 'fixture',
          baseUrl: 'http://127.0.0.1:9999/v1',
          apiKey: 'top-secret',
          protocol: 'openai-completions',
          futureProviderField: ['a', { b: true }],
        },
      ],
      models: [{ id: 'fixture-model', provider: 'fixture', model: 'fixture-wire-model' }],
      defaultModel: 'fixture-model',
      futureRoot: { array: [3, 2, 1], secretLike: 'preserve-me' },
      projects: {
        [nestedCwd]: { allowedTools: ['read'], futureProjectField: { keep: true } },
      },
    };
    writeFileSync(documentPath, JSON.stringify(original));
    const repository = create();
    const before = repository.read();

    repository.persist(nestedCwd, before.revision, [
      { op: 'set', key: 'defaults.effort', value: 'high' },
      { op: 'set', key: 'permissions.toolConfirmation', value: 'ask' },
      { op: 'set', key: 'appearance.motion', value: 'reduced' },
    ]);

    const after = JSON.parse(readFileSync(documentPath, 'utf8'));
    expect(after.providers).toEqual(original.providers);
    expect(after.models).toEqual(original.models);
    expect(after.futureRoot).toEqual(original.futureRoot);
    expect(after.projects[nestedCwd]).toEqual({
      allowedTools: ['read'],
      futureProjectField: { keep: true },
      defaultEffort: 'high',
    });
    expect(Object.keys(after.projects)).toEqual([nestedCwd]);
  });

  test('unset removes only controlled leaves and preserves sibling data', () => {
    writeFileSync(
      documentPath,
      JSON.stringify({
        schemaVersion: 1,
        defaultModel: 'gpt-4o',
        toolConfirmation: 'deny',
        web: { appearance: { theme: 'light', motion: 'reduced' }, future: true },
        projects: { '/workspace': { defaultEffort: 'medium', allowedTools: ['read'] } },
      })
    );
    const repository = create();
    const before = repository.read();
    repository.persist('/workspace', before.revision, [
      { op: 'unset', key: 'appearance.theme' },
      { op: 'unset', key: 'defaults.effort' },
      { op: 'unset', key: 'permissions.toolConfirmation' },
    ]);
    const after = JSON.parse(readFileSync(documentPath, 'utf8'));
    expect(after.web).toEqual({ appearance: { motion: 'reduced' }, future: true });
    expect(after.projects['/workspace']).toEqual({ allowedTools: ['read'] });
    expect(after).not.toHaveProperty('toolConfirmation');
  });

  test('supports the internal global effort operation without exposing an arbitrary path', () => {
    const repository = create();
    const missing = repository.read();
    const set = repository.persist('/workspace', missing.revision, [
      { op: 'set', key: 'defaults.globalEffort', value: 'medium' },
    ]);
    expect(JSON.parse(readFileSync(documentPath, 'utf8')).defaultEffort).toBe('medium');

    repository.persist('/workspace', set.revision, [{ op: 'unset', key: 'defaults.globalEffort' }]);
    expect(JSON.parse(readFileSync(documentPath, 'utf8'))).not.toHaveProperty('defaultEffort');
  });

  test('keeps last-good and fails closed when external JSON or schema is invalid', () => {
    const original = '{"schemaVersion":1,"defaultModel":"gpt-4o"}';
    writeFileSync(documentPath, original);
    const repository = create();
    const good = repository.read();

    const bad = '{"schemaVersion":1,"apiKey":"never-log-this"';
    writeFileSync(documentPath, bad);
    const invalid = repository.read();
    expect(invalid.state).toBe('invalid');
    expect(invalid.document.defaultModel).toBe('gpt-4o');
    expect(invalid.lastGoodRevision).toBe(good.revision);
    expect(JSON.stringify(invalid)).not.toContain('never-log-this');
    expect(() =>
      repository.persist('/workspace', invalid.revision, [
        { op: 'set', key: 'appearance.theme', value: 'dark' },
      ])
    ).toThrow(SettingsDocumentRepositoryError);
    expect(readFileSync(documentPath, 'utf8')).toBe(bad);

    writeFileSync(documentPath, JSON.stringify({ schemaVersion: 99, defaultModel: 'gpt-4o' }));
    expect(repository.read().state).toBe('invalid');
  });

  test('allows only one writer to commit the same durable revision', () => {
    writeFileSync(documentPath, JSON.stringify({ schemaVersion: 1, defaultModel: 'gpt-4o' }));
    const first = create();
    const second = create();
    const revision = first.read().revision;

    first.persist('/workspace', revision, [{ op: 'set', key: 'appearance.theme', value: 'light' }]);
    expectRepositoryCode(
      () =>
        second.persist('/workspace', revision, [
          { op: 'set', key: 'appearance.theme', value: 'dark' },
        ]),
      'settings_revision_conflict'
    );
    expect(JSON.parse(readFileSync(documentPath, 'utf8')).web.appearance.theme).toBe('light');
  });

  test('re-reads CAS inside the existing cross-process file lock', async () => {
    writeFileSync(documentPath, JSON.stringify({ schemaVersion: 1, defaultModel: 'gpt-4o' }));
    const repository = create();
    const revision = repository.read().revision;

    const outcomes = await Promise.all([
      runChildWriter(documentPath, revisionKeyPath, revision, 'light'),
      runChildWriter(documentPath, revisionKeyPath, revision, 'dark'),
    ]);

    expect(outcomes.sort()).toEqual([0, 2]);
    expect(['light', 'dark']).toContain(
      JSON.parse(readFileSync(documentPath, 'utf8')).web.appearance.theme
    );
  });

  test('watcher reports legal edits, invalid bytes, and deletion without replacing last-good', async () => {
    writeFileSync(documentPath, JSON.stringify({ schemaVersion: 1, defaultModel: 'gpt-4o' }));
    const repository = create();
    repository.read();
    const events: SettingsRepositoryInvalidationV1[] = [];
    const unwatch = repository.watch(event => events.push(event));

    writeFileSync(documentPath, '{"schemaVersion":1,"defaultModel":"gpt-4o"}\n');
    await waitForEvent(events, event => event.state === 'ready');
    writeFileSync(documentPath, '{bad-json');
    await waitForEvent(events, event => event.state === 'invalid');
    expect(repository.read().document.defaultModel).toBe('gpt-4o');

    const countBeforeDelete = events.length;
    unlinkSync(documentPath);
    await waitForEvent(
      events,
      event => events.indexOf(event) >= countBeforeDelete && event.state === 'ready'
    );
    expect(repository.read()).toMatchObject({ state: 'ready', hasDocument: false });
    unwatch();
  });

  test('rejects duplicate, unknown, and malformed operations before writing', () => {
    const repository = create();
    const revision = repository.read().revision;
    expectRepositoryCode(
      () =>
        repository.persist('/workspace', revision, [
          { op: 'set', key: 'appearance.theme', value: 'light' },
          { op: 'unset', key: 'appearance.theme' },
        ]),
      'settings_invalid_operation'
    );
    expectRepositoryCode(
      () =>
        repository.persist('/workspace', revision, [
          { op: 'set', key: 'arbitrary.secret', value: 'x' } as never,
        ]),
      'settings_invalid_operation'
    );
    expectRepositoryCode(
      () =>
        repository.persist('/workspace', revision, [
          { op: 'set', key: 'defaults.model', value: '   ' },
        ]),
      'settings_invalid_operation'
    );
  });
});
