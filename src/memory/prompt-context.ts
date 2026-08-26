import { truncateIfNeeded } from './entrypoint';
import { extractKeywords } from './relevant-finder';
import { loadMemory, loadMemoryIndex } from './storage';

const DEFAULT_TOTAL_CHARS = 24_000;
const DEFAULT_ENTRYPOINT_CHARS = 8_000;
const DEFAULT_RELEVANT_ENTRIES = 5;
const DEFAULT_ENTRY_CHARS = 3_000;
const MAX_RELEVANCE_CANDIDATES = 20;

export interface MemoryPromptContextOptions {
  maxTotalChars?: number;
  maxEntrypointChars?: number;
  maxRelevantEntries?: number;
  maxEntryChars?: number;
  minScore?: number;
}

export interface MemoryPromptSelection {
  name: string;
  type: string;
  score: number;
  matchedKeywords: string[];
  includedChars: number;
  truncated: boolean;
}

export interface MemoryPromptManifest {
  budgetChars: number;
  usedChars: number;
  candidateCount: number;
  entrypoint: {
    originalChars: number;
    includedChars: number;
    truncated: boolean;
  };
  selected: MemoryPromptSelection[];
  omitted: Array<{ name: string; reason: 'entry_limit' | 'budget' | 'unavailable' }>;
}

export interface MemoryPromptContext {
  content: string;
  manifest: MemoryPromptManifest;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.max(0, Math.min(value, maximum));
}

function appendWithinBudget(parts: string[], value: string, budget: number): string {
  const used = parts.reduce((total, part) => total + part.length, 0);
  if (used >= budget) return '';
  const included = value.slice(0, budget - used);
  parts.push(included);
  return included;
}

interface MemoryIndexCandidate {
  name: string;
  score: number;
  matchedKeywords: string[];
}

function findIndexCandidates(
  index: string,
  query: string,
  minScore: number,
  limit: number
): MemoryIndexCandidate[] {
  const queryKeywords = extractKeywords(query);
  if (queryKeywords.length === 0) return [];
  const candidates: MemoryIndexCandidate[] = [];
  for (const line of index.split('\n')) {
    const linkStart = line.lastIndexOf('](');
    const hookStart = linkStart >= 0 ? line.indexOf(') — ', linkStart + 2) : -1;
    if (linkStart < 0 || hookStart < 0) continue;
    const target = line.slice(linkStart + 2, hookStart);
    if (!target.endsWith('.md')) continue;
    const name = target.slice(0, -3);
    const hook = line.slice(hookStart + 4);
    const memoryKeywords = extractKeywords(`${name} ${hook}`);
    const matchedKeywords = queryKeywords.filter(queryKeyword =>
      memoryKeywords.some(
        memoryKeyword =>
          memoryKeyword === queryKeyword ||
          memoryKeyword.includes(queryKeyword) ||
          queryKeyword.includes(memoryKeyword)
      )
    );
    const score = matchedKeywords.length / queryKeywords.length;
    if (score >= minScore) candidates.push({ name, score, matchedKeywords });
  }
  return candidates
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, limit);
}

/**
 * Build a deterministic, bounded memory projection for a model-visible prompt.
 *
 * This is an integration API only: callers choose where the returned content
 * is injected and should persist the manifest beside the request receipt.
 */
export function buildMemoryPromptContext(
  query: string,
  projectPath?: string,
  options: MemoryPromptContextOptions = {}
): MemoryPromptContext {
  const maxTotalChars = boundedInteger(options.maxTotalChars, DEFAULT_TOTAL_CHARS, 100_000);
  const maxEntrypointChars = Math.min(
    boundedInteger(options.maxEntrypointChars, DEFAULT_ENTRYPOINT_CHARS, 25_000),
    maxTotalChars
  );
  const maxRelevantEntries = boundedInteger(
    options.maxRelevantEntries,
    DEFAULT_RELEVANT_ENTRIES,
    10
  );
  const maxEntryChars = boundedInteger(options.maxEntryChars, DEFAULT_ENTRY_CHARS, 12_000);
  const minScore =
    Number.isFinite(options.minScore) && options.minScore !== undefined
      ? Math.max(0, Math.min(options.minScore, 1))
      : 0.1;

  const rawEntrypoint = loadMemoryIndex(projectPath);
  const normalizedEntrypoint = truncateIfNeeded(rawEntrypoint).content;
  const entrypoint = normalizedEntrypoint.slice(0, maxEntrypointChars);
  const candidateLimit = Math.min(
    MAX_RELEVANCE_CANDIDATES,
    Math.max(maxRelevantEntries + 1, maxRelevantEntries * 4)
  );
  const candidates = query.trim()
    ? findIndexCandidates(normalizedEntrypoint, query, minScore, candidateLimit)
    : [];

  const parts: string[] = [];
  let includedEntrypoint = '';
  if (entrypoint) {
    appendWithinBudget(parts, '## Memory index\n\n', maxTotalChars);
    includedEntrypoint = appendWithinBudget(parts, entrypoint, maxTotalChars);
  }

  const selected: MemoryPromptSelection[] = [];
  const omitted: MemoryPromptManifest['omitted'] = [];
  for (const candidate of candidates) {
    if (selected.length >= maxRelevantEntries) {
      omitted.push({ name: candidate.name, reason: 'entry_limit' });
      continue;
    }

    const memory = loadMemory(candidate.name, projectPath);
    if (!memory) {
      omitted.push({ name: candidate.name, reason: 'unavailable' });
      continue;
    }

    const separator = parts.length > 0 ? '\n\n' : '';
    const header = `${separator}## Relevant memory: ${memory.name} (${memory.type})\n\n`;
    const body = memory.content.slice(0, maxEntryChars);
    const available = maxTotalChars - parts.reduce((total, part) => total + part.length, 0);
    if (available <= header.length) {
      omitted.push({ name: memory.name, reason: 'budget' });
      continue;
    }

    appendWithinBudget(parts, header, maxTotalChars);
    const includedBody = appendWithinBudget(parts, body, maxTotalChars);
    selected.push({
      name: memory.name,
      type: memory.type,
      score: candidate.score,
      matchedKeywords: candidate.matchedKeywords.slice(0, 8),
      includedChars: includedBody.length,
      truncated:
        includedBody.length < memory.content.length || memory.content.length > maxEntryChars,
    });
  }

  const content = parts.join('');
  return {
    content,
    manifest: {
      budgetChars: maxTotalChars,
      usedChars: content.length,
      candidateCount: candidates.length,
      entrypoint: {
        originalChars: normalizedEntrypoint.length,
        includedChars: includedEntrypoint.length,
        truncated: includedEntrypoint.length < normalizedEntrypoint.length,
      },
      selected,
      omitted,
    },
  };
}
