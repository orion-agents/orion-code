/**
 * v0.3.23 T23-C2 — structured failure attribution.
 *
 * Parses verification output (tsc, jest, eslint, build tooling, environment
 * errors) into bounded structured evidence instead of feeding raw logs back to
 * the model. Each attribution carries a stable digest so the repair loop can
 * detect no-progress rounds objectively.
 */
import { createHash } from 'crypto';

export type FailureKind =
  | 'typescript'
  | 'lint'
  | 'build'
  | 'unit-test'
  | 'integration-test'
  | 'environment'
  | 'provider'
  | 'unknown';

export interface FailureEntryV1 {
  readonly file?: string;
  readonly line?: number;
  readonly code?: string;
  readonly message: string;
}

export interface StructuredFailureEvidenceV1 {
  readonly kind: FailureKind;
  readonly summary: string;
  readonly entries: readonly FailureEntryV1[];
  /** Stable over identical failures; changes when the failure changes. */
  readonly digest: string;
}

const TSC_PATTERN = /^(.+?)\((\d+),(\d+)\):\s+(?:error|warning)\s+(TS\d+):\s+(.+)$/gm;
const ESLINT_PATTERN = /^(.+?):(\d+):(\d+)\s+(error|warning)\s+(.+)$/gm;
const JEST_FAIL_PATTERN = /✕\s+(.+?)(?:\s*\(\d+\s*m?s\))?$/gm;

function digestOf(kind: FailureKind, entries: readonly FailureEntryV1[]): string {
  const hash = createHash('sha256');
  hash.update(kind);
  for (const entry of entries) {
    hash.update(`${entry.file ?? ''}|${entry.line ?? ''}|${entry.code ?? ''}|${entry.message}`);
  }
  return hash.digest('hex').slice(0, 32);
}

function evidence(
  kind: FailureKind,
  entries: readonly FailureEntryV1[],
  summary: string
): StructuredFailureEvidenceV1 {
  return {
    kind,
    summary,
    entries: Object.freeze(entries),
    digest: digestOf(kind, entries),
  };
}

export function parseTypeScriptDiagnostics(output: string): readonly FailureEntryV1[] {
  const entries: FailureEntryV1[] = [];
  for (const match of output.matchAll(TSC_PATTERN)) {
    entries.push({
      file: match[1],
      line: Number(match[2]),
      code: match[4],
      message: match[5].trim(),
    });
  }
  return entries;
}

export function parseEsLintOutput(output: string): readonly FailureEntryV1[] {
  const entries: FailureEntryV1[] = [];
  for (const match of output.matchAll(ESLINT_PATTERN)) {
    entries.push({
      file: match[1],
      line: Number(match[2]),
      code: match[4],
      message: match[5].trim(),
    });
  }
  return entries;
}

export function parseJestFailures(output: string): readonly FailureEntryV1[] {
  const entries: FailureEntryV1[] = [];
  for (const match of output.matchAll(JEST_FAIL_PATTERN)) {
    entries.push({ message: match[1].trim() });
  }
  const summary = /Tests:\s+(\d+)\s+failed/.exec(output);
  if (summary && entries.length === 0) {
    entries.push({ message: `${summary[1]} test(s) failed` });
  }
  return entries;
}

/**
 * Attribute a verification failure to a structured kind. Detection order:
 * TypeScript → test failure → lint → build → provider → environment → unknown.
 */
export function attributeFailure(output: string, command = ''): StructuredFailureEvidenceV1 {
  const commandLower = command.toLowerCase();

  const tsEntries = parseTypeScriptDiagnostics(output);
  if (tsEntries.length > 0) {
    return evidence(
      'typescript',
      tsEntries.slice(0, 50),
      `${tsEntries.length} TypeScript diagnostic(s); first: ${tsEntries[0].file}:${tsEntries[0].line} ${tsEntries[0].code}`
    );
  }

  if (/✕|●.*›|Tests:\s+\d+\s+failed|FAIL\s+\S+test/i.test(output)) {
    const jestEntries = parseJestFailures(output);
    const kind: FailureKind =
      /integrat|e2e|playwright/i.test(output) || /e2e/i.test(commandLower)
        ? 'integration-test'
        : 'unit-test';
    return evidence(kind, jestEntries.slice(0, 50), `${jestEntries.length} failed test(s)`);
  }

  const lintEntries = parseEsLintOutput(output);
  if (lintEntries.length > 0 || /eslint/i.test(commandLower)) {
    return evidence('lint', lintEntries.slice(0, 50), `${lintEntries.length} lint problem(s)`);
  }

  if (/build failed|rollup|webpack|vite build|tsc && |error during build/i.test(output)) {
    return evidence('build', [], 'build tooling reported a failure');
  }

  if (
    /provider|api key|rate limit|429|status 5|econnrefused|enotfound|fetch failed|timed out/i.test(
      output
    ) ||
    /provider/i.test(commandLower)
  ) {
    return evidence('provider', [], 'provider or network failure during verification');
  }

  if (
    /eacces|eperm|enoent|enoentries|no such file|permission denied|disk space|enospc/i.test(output)
  ) {
    return evidence('environment', [], 'environment or filesystem failure during verification');
  }

  return evidence('unknown', [], 'verification failed without a recognizable pattern');
}
