/**
 * v0.3.23 T23-B3 — task-relevant context recall over the symbol index.
 *
 * Given the user intent, the currently active files, and (optionally) recently
 * changed files, produce a bounded, ranked candidate list. Every candidate
 * carries explicit `reasons[]` — the recall result is evidence, not a black
 * box — and the caller can log it into the Harness ledger.
 *
 * Scoring (heuristic, evaluated by the Recall@K suite — not claimed as
 * semantic understanding):
 *   +50 direct mention: the intent names the path or its basename
 *   +30 symbol match:   a quoted/known symbol from the intent is defined here
 *   +20 import adjacency: an active file imports this file (or vice versa)
 *   +15 test pairing:    tests/<x>.test.* <-> src/<x>.*
 *   +10 recent change:   the file appears in the changed set
 */
import type { RepoSymbolIndexV1 } from './symbol-index';

export interface RecallCandidateV1 {
  readonly path: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface RecallOptionsV1 {
  /** Free-text user intent (task description). */
  readonly intent: string;
  /** Files the user or the current turn is already working with. */
  readonly activeFiles: readonly string[];
  /** Files changed in the current change-set (git diff), if available. */
  readonly changedFiles?: readonly string[];
  /** Maximum number of candidates returned. */
  readonly limit?: number;
}

const basenameOf = (path: string): string => path.split('/').pop() ?? path;

const testPairOf = (path: string): string | undefined => {
  const normalized = path.split('\\').join('/');
  const testMatch = /^(?:tests?\/)(.+)\.(?:test|spec)\.[cm]?[jt]sx?$/.exec(normalized);
  if (testMatch) {
    const base = testMatch[1];
    for (const candidate of [`src/${base}.ts`, `src/${base}.tsx`, `src/${base}.js`]) {
      return candidate;
    }
  }
  const srcMatch = /^src\/(.+)\.[cm]?[jt]sx?$/.exec(normalized);
  if (srcMatch) {
    const base = srcMatch[1];
    return `tests/${base}.test.ts`;
  }
  return undefined;
};

export function recallFiles(
  index: RepoSymbolIndexV1,
  options: RecallOptionsV1
): readonly RecallCandidateV1[] {
  const limit = options.limit ?? 20;
  const snapshot = index.getSnapshot();
  const intentLower = options.intent.toLowerCase();
  const activeSet = new Set(options.activeFiles.map(path => path.split('\\').join('/')));
  const changedSet = new Set((options.changedFiles ?? []).map(path => path.split('\\').join('/')));

  // Symbols explicitly named in the intent (quoted or camel-cased tokens).
  const intentSymbols = new Set<string>();
  for (const match of options.intent.matchAll(/[A-Za-z_$][\w$]{2,}/g)) {
    intentSymbols.add(match[0]);
  }

  const scores = new Map<string, { score: number; reasons: Set<string> }>();
  const bump = (path: string, points: number, reason: string): void => {
    const normalized = path.split('\\').join('/');
    const entry = scores.get(normalized) ?? { score: 0, reasons: new Set<string>() };
    entry.score += points;
    entry.reasons.add(reason);
    scores.set(normalized, entry);
  };

  for (const [path, record] of snapshot) {
    const base = basenameOf(path);
    // Direct mention: the intent names the file path or its basename.
    if (intentLower.includes(path.toLowerCase()) || intentLower.includes(base.toLowerCase())) {
      bump(path, 50, 'mentioned in the task intent');
    }
    // Symbol match: an intent token matches a symbol defined in this file.
    for (const symbol of record.symbols) {
      if (symbol.name.length >= 4 && intentSymbols.has(symbol.name)) {
        bump(path, 30, `defines symbol ${symbol.name}`);
        break;
      }
    }
    // Import adjacency to active files.
    for (const active of activeSet) {
      if (record.imports.includes(active)) {
        bump(path, 20, `imports the active file ${active}`);
      }
      if (snapshot.get(active)?.imports.includes(path)) {
        bump(path, 20, `imported by the active file ${active}`);
      }
    }
    // Test pairing.
    const pair = testPairOf(path);
    if (pair && (activeSet.has(pair) || changedSet.has(pair))) {
      bump(path, 15, `paired with ${pair}`);
    }
    // Recent change.
    if (changedSet.has(path)) {
      bump(path, 10, 'in the current change-set');
    }
  }

  return [...scores.entries()]
    .map(([path, entry]) => ({
      path,
      score: entry.score,
      reasons: [...entry.reasons].sort(),
    }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit);
}

/**
 * Budget-aware selection: rank candidates, deduplicate by directory concentration
 * (at most `maxPerDirectory` per immediate directory), and always keep explicitly
 * active files (the user touched them — they are never dropped for budget).
 */
export function selectWithinBudget(
  candidates: readonly RecallCandidateV1[],
  options: {
    readonly activeFiles: readonly string[];
    readonly maxFiles?: number;
    readonly maxPerDirectory?: number;
  }
): readonly RecallCandidateV1[] {
  const maxFiles = options.maxFiles ?? 12;
  const maxPerDirectory = options.maxPerDirectory ?? 4;
  const activeSet = new Set(options.activeFiles.map(path => path.split('\\').join('/')));
  const perDirectory = new Map<string, number>();
  const selected: RecallCandidateV1[] = [];
  for (const candidate of candidates) {
    const normalized = candidate.path.split('\\').join('/');
    if (selected.length >= maxFiles) break;
    const directory = normalized.split('/').slice(0, -1).join('/');
    const isProtected = activeSet.has(normalized);
    const count = perDirectory.get(directory) ?? 0;
    if (!isProtected && count >= maxPerDirectory) continue;
    selected.push(candidate);
    perDirectory.set(directory, count + 1);
  }
  // Active files that scoring missed are still kept (user-touched is sacred).
  for (const active of activeSet) {
    if (selected.length >= maxFiles) break;
    if (!selected.some(candidate => candidate.path === active)) {
      selected.push({ path: active, score: 0, reasons: ['active file (user-pinned)'] });
    }
  }
  return selected;
}
