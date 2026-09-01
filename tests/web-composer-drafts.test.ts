import {
  loadComposerDraft,
  removeComposerDraft,
  removeComposerDraftsForWorkspace,
  saveComposerDraft,
} from '../web/src/state/composer-drafts';

const STORAGE_KEY = 'orion.web.composer-drafts.v1';

describe('Composer tab draft storage', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { sessionStorage: storage },
    });
  });

  afterAll(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as { window?: unknown }).window;
  });

  test('isolates text and structured references by opaque Workspace and Session identity', () => {
    saveComposerDraft({
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      text: 'draft-a',
      references: [{ kind: 'file', id: 'file-opaque', label: 'source.ts', revision: 'revision-a' }],
    });
    saveComposerDraft({
      workspaceId: 'workspace-b',
      sessionId: 'session-a',
      text: 'draft-b',
      references: [],
    });

    expect(loadComposerDraft('workspace-a', 'session-a')).toMatchObject({
      text: 'draft-a',
      references: [{ kind: 'file', id: 'file-opaque', revision: 'revision-a' }],
    });
    expect(loadComposerDraft('workspace-b', 'session-a')).toMatchObject({ text: 'draft-b' });
    expect(loadComposerDraft('workspace-a', 'session-missing')).toBeNull();
  });

  test('keeps only the twenty most recently saved Session drafts', () => {
    for (let index = 0; index < 24; index += 1) {
      saveComposerDraft({
        workspaceId: 'workspace',
        sessionId: `session-${index}`,
        text: `draft-${index}`,
        references: [],
      });
    }

    expect(loadComposerDraft('workspace', 'session-23')?.text).toBe('draft-23');
    expect(loadComposerDraft('workspace', 'session-4')?.text).toBe('draft-4');
    expect(loadComposerDraft('workspace', 'session-3')).toBeNull();
  });

  test('rejects an oversized draft without replacing the last-good document', () => {
    saveComposerDraft({
      workspaceId: 'workspace',
      sessionId: 'safe',
      text: 'last-good',
      references: [],
    });

    expect(() =>
      saveComposerDraft({
        workspaceId: 'workspace',
        sessionId: 'too-large',
        text: 'x'.repeat(260 * 1024),
        references: [],
      })
    ).toThrow('Composer draft exceeds');
    expect(loadComposerDraft('workspace', 'safe')?.text).toBe('last-good');
    expect(loadComposerDraft('workspace', 'too-large')).toBeNull();
  });

  test('fails closed on malformed storage and removes the final entry', () => {
    storage.setItem(STORAGE_KEY, '{bad-json');
    expect(loadComposerDraft('workspace', 'session')).toBeNull();

    saveComposerDraft({
      workspaceId: 'workspace',
      sessionId: 'session',
      text: 'temporary',
      references: [],
    });
    removeComposerDraft('workspace', 'session');
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  test('does not cross browser-tab sessionStorage instances', () => {
    saveComposerDraft({
      workspaceId: 'workspace',
      sessionId: 'session',
      text: 'tab-one',
      references: [],
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { sessionStorage: new MemoryStorage() },
    });

    expect(loadComposerDraft('workspace', 'session')).toBeNull();
  });

  test('removes every draft owned by a removed Workspace without touching another one', () => {
    for (const [workspaceId, sessionId] of [
      ['workspace-a', 'session-1'],
      ['workspace-a', 'session-2'],
      ['workspace-b', 'session-3'],
    ] as const) {
      saveComposerDraft({ workspaceId, sessionId, text: sessionId, references: [] });
    }

    removeComposerDraftsForWorkspace('workspace-a');

    expect(loadComposerDraft('workspace-a', 'session-1')).toBeNull();
    expect(loadComposerDraft('workspace-a', 'session-2')).toBeNull();
    expect(loadComposerDraft('workspace-b', 'session-3')?.text).toBe('session-3');
  });
});

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
