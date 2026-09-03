import type { WebContextReferenceV1 } from '../../../src/web/protocol';

const STORAGE_KEY = 'orion.web.composer-drafts.v1';
const MAX_DRAFTS = 20;
const MAX_DRAFT_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

export interface ComposerDraftV1 {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly references: readonly WebContextReferenceV1[];
  readonly updatedAt: number;
}

interface ComposerDraftDocumentV1 {
  readonly version: 1;
  readonly entries: readonly ComposerDraftV1[];
}

export function loadComposerDraft(workspaceId: string, sessionId: string): ComposerDraftV1 | null {
  return (
    readDocument().entries.find(
      entry => entry.workspaceId === workspaceId && entry.sessionId === sessionId
    ) ?? null
  );
}

export function saveComposerDraft(input: Omit<ComposerDraftV1, 'updatedAt'>): void {
  const storage = browserSessionStorage();
  if (!storage) return;
  const entry = Object.freeze({
    ...input,
    references: [...input.references],
    updatedAt: Date.now(),
  });
  if (encodedBytes(entry) > MAX_DRAFT_BYTES) {
    throw new Error(`Composer draft exceeds ${MAX_DRAFT_BYTES} bytes.`);
  }
  const existing = readDocument().entries.filter(
    item => !(item.workspaceId === input.workspaceId && item.sessionId === input.sessionId)
  );
  const entries = [entry, ...existing].slice(0, MAX_DRAFTS);
  while (entries.length > 0 && encodedBytes({ version: 1, entries }) > MAX_TOTAL_BYTES) {
    entries.pop();
  }
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries }));
}

export function removeComposerDraft(workspaceId: string, sessionId: string): void {
  const storage = browserSessionStorage();
  if (!storage) return;
  const entries = readDocument().entries.filter(
    item => !(item.workspaceId === workspaceId && item.sessionId === sessionId)
  );
  if (entries.length === 0) storage.removeItem(STORAGE_KEY);
  else storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries }));
}

export function removeComposerDraftsForWorkspace(workspaceId: string): void {
  const storage = browserSessionStorage();
  if (!storage) return;
  const entries = readDocument().entries.filter(item => item.workspaceId !== workspaceId);
  if (entries.length === 0) storage.removeItem(STORAGE_KEY);
  else storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries }));
}

function readDocument(): ComposerDraftDocumentV1 {
  const storage = browserSessionStorage();
  if (!storage) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(
      storage.getItem(STORAGE_KEY) ?? ''
    ) as Partial<ComposerDraftDocumentV1>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return { version: 1, entries: [] };
    return {
      version: 1,
      entries: parsed.entries.filter(isComposerDraft).slice(0, MAX_DRAFTS),
    };
  } catch {
    return { version: 1, entries: [] };
  }
}

function isComposerDraft(value: unknown): value is ComposerDraftV1 {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<ComposerDraftV1>;
  return (
    typeof entry.workspaceId === 'string' &&
    typeof entry.sessionId === 'string' &&
    typeof entry.text === 'string' &&
    Array.isArray(entry.references) &&
    typeof entry.updatedAt === 'number' &&
    Number.isFinite(entry.updatedAt) &&
    encodedBytes(entry) <= MAX_DRAFT_BYTES
  );
}

function browserSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
