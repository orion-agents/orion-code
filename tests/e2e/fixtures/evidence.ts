import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve, sep } from 'path';

import type { ConsoleMessage, Page, Request, Response } from '@playwright/test';

import { redactTraceText } from '../../../src/services/redaction';
import type { WebE2EArtifactStateV1 } from './artifact-types';

const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_EVENT_ENTRIES = 256;
const MAX_DETAIL_BYTES = 4 * 1024;
const MAX_FACT_BYTES = 1024;

export type WebE2EScenarioStatusV1 = 'running' | 'pass' | 'fail';
export type WebE2ERunDecisionV1 = 'IN_PROGRESS' | 'GO' | 'NO_GO';
export type WebE2EEvidenceFactV1 = string | number | boolean | null;

export interface WebE2EEvidenceCountersV1 {
  readonly stdoutBytes: number;
  readonly stdoutDroppedBytes: number;
  readonly stderrBytes: number;
  readonly stderrDroppedBytes: number;
  readonly consoleMessages: number;
  readonly consoleErrors: number;
  readonly consoleWarnings: number;
  readonly pageErrors: number;
  readonly networkRequests: number;
  readonly networkFailures: number;
  readonly http5xx: number;
  readonly sseRequests: number;
  readonly secretFindings: number;
  readonly droppedEvents: number;
}

export interface WebE2EScenarioManifestV1 {
  readonly version: 1;
  readonly kind: 'orion.web-e2e-scenario-evidence';
  readonly runId: string;
  readonly scenarioId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly status: Exclude<WebE2EScenarioStatusV1, 'running'>;
  readonly detail?: string;
  readonly browser?: {
    readonly name: string;
    readonly version: string;
  };
  readonly counters: WebE2EEvidenceCountersV1;
  readonly logs: {
    readonly stdout: string;
    readonly stderr: string;
  };
  readonly facts: Readonly<Record<string, WebE2EEvidenceFactV1>>;
  readonly events: readonly WebE2EEvidenceEventV1[];
}

export interface WebE2ERunManifestV1 {
  readonly version: 1;
  readonly kind: 'orion.web-e2e-manifest';
  readonly runId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly source: {
    readonly gitSha: string;
    readonly dirty: boolean;
  };
  readonly artifact: {
    readonly packageName: string;
    readonly packageVersion: string;
    readonly tarballFilename: string;
    readonly tarballSha256: string;
    readonly artifactReceiptDigest: string;
    readonly installedTargetDigest: string;
    readonly source: WebE2EArtifactStateV1['source'];
  };
  readonly environment: WebE2EArtifactStateV1['environment'];
  readonly paths: {
    readonly state: string;
    readonly artifact: string;
    readonly receipt: string;
    readonly installation: string;
    readonly scenarios: string;
  };
  readonly scenarios: readonly WebE2EScenarioManifestV1[];
  readonly counters: WebE2EEvidenceCountersV1;
  readonly decision: WebE2ERunDecisionV1;
}

export interface WebE2EEvidenceEventV1 {
  readonly kind: 'console' | 'page-error' | 'request' | 'request-failed' | 'response';
  readonly detail: string;
  readonly status?: number;
}

export interface WebE2EEvidenceCollectorOptions {
  readonly state: WebE2EArtifactStateV1;
  readonly scenarioId: string;
  readonly privatePaths?: Readonly<Record<string, string>>;
  readonly secretValues?: readonly string[];
}

interface MutableCounters {
  stdoutBytes: number;
  stdoutDroppedBytes: number;
  stderrBytes: number;
  stderrDroppedBytes: number;
  consoleMessages: number;
  consoleErrors: number;
  consoleWarnings: number;
  pageErrors: number;
  networkRequests: number;
  networkFailures: number;
  http5xx: number;
  sseRequests: number;
  secretFindings: number;
  droppedEvents: number;
}

interface PageListeners {
  readonly console: (message: ConsoleMessage) => void;
  readonly pageerror: (error: Error) => void;
  readonly request: (request: Request) => void;
  readonly requestfailed: (request: Request) => void;
  readonly response: (response: Response) => void;
}

interface ExpectedConsoleError {
  readonly text: string;
  matched: boolean;
}

class BoundedTextCapture {
  private value = '';
  private observedBytes = 0;
  private sanitizedBytes = 0;
  private persistedBytes = 0;

  constructor(
    private readonly sanitize: (value: string) => string,
    private readonly maximumBytes = MAX_CAPTURE_BYTES
  ) {}

  append(raw: string | Buffer): void {
    const value = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
    this.observedBytes += Buffer.byteLength(value, 'utf8');
    if (this.persistedBytes >= this.maximumBytes) return;
    const sanitized = this.sanitize(value);
    const remaining = this.maximumBytes - this.persistedBytes;
    const encoded = Buffer.from(sanitized, 'utf8');
    this.sanitizedBytes += encoded.length;
    const persisted = encoded.subarray(0, remaining).toString('utf8');
    this.value += persisted;
    this.persistedBytes += Buffer.byteLength(persisted, 'utf8');
  }

  snapshot(): { readonly value: string; readonly observed: number; readonly dropped: number } {
    return Object.freeze({
      value: this.value,
      observed: this.observedBytes,
      dropped: Math.max(0, this.sanitizedBytes - this.persistedBytes),
    });
  }
}

export class WebE2EEvidenceCollector {
  readonly scenarioDirectory: string;
  private readonly startedAt = new Date();
  private readonly counters: MutableCounters = emptyMutableCounters();
  private readonly events: WebE2EEvidenceEventV1[] = [];
  private readonly facts = new Map<string, WebE2EEvidenceFactV1>();
  private readonly privatePaths = new Map<string, string>();
  private readonly secrets = new Set<string>();
  private readonly expectedConsoleErrors: ExpectedConsoleError[] = [];
  private readonly stdout: BoundedTextCapture;
  private readonly stderr: BoundedTextCapture;
  private browserIdentity?: { readonly name: string; readonly version: string };
  private finalized = false;

  constructor(readonly options: WebE2EEvidenceCollectorOptions) {
    const component = safeComponent(options.scenarioId);
    this.scenarioDirectory = join(
      options.state.rawRoot,
      'scenarios',
      `${component}-${randomUUID().slice(0, 8)}`
    );
    mkdirPrivate(this.scenarioDirectory);
    this.addPrivatePath(options.state.repositoryRoot, '<REPOSITORY_ROOT>');
    this.addPrivatePath(options.state.rawRoot, '<RUN_ROOT>');
    for (const [path, replacement] of Object.entries(options.privatePaths ?? {})) {
      this.addPrivatePath(path, replacement);
    }
    for (const value of options.secretValues ?? []) this.addSecretValue(value);
    const sanitize = (value: string) => this.sanitize(value);
    this.stdout = new BoundedTextCapture(sanitize);
    this.stderr = new BoundedTextCapture(sanitize);
  }

  addPrivatePath(path: string, replacement = '<PRIVATE_PATH>'): void {
    if (!path.trim()) return;
    this.privatePaths.set(resolve(path), replacement);
  }

  addSecretValue(value: string): void {
    if (value.length >= 4) this.secrets.add(value);
  }

  setBrowserIdentity(name: string, version: string): void {
    this.browserIdentity = Object.freeze({
      name: this.sanitize(name).slice(0, 80),
      version: this.sanitize(version).slice(0, 120),
    });
  }

  recordFact(key: string, value: WebE2EEvidenceFactV1): void {
    if (this.finalized) throw new Error('Cannot record a fact after evidence is finalized.');
    if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(key)) {
      throw new Error(`Invalid Web E2E evidence fact key: ${key}.`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`Evidence fact ${key} must be a finite number.`);
    }
    if (typeof value === 'string') {
      this.countSecrets(value);
      this.facts.set(key, boundedText(this.sanitize(value), MAX_FACT_BYTES));
      return;
    }
    this.facts.set(key, value);
  }

  recordStdout(chunk: string | Buffer): void {
    this.countSecrets(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
    this.stdout.append(chunk);
  }

  recordStderr(chunk: string | Buffer): void {
    this.countSecrets(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
    this.stderr.append(chunk);
  }

  recordPageError(error: Error | string): void {
    const detail = error instanceof Error ? (error.stack ?? error.message) : error;
    this.counters.pageErrors += 1;
    this.countSecrets(detail);
    this.pushEvent({ kind: 'page-error', detail: this.sanitize(detail) });
  }

  /**
   * Register one exact browser-generated error expected from a negative HTTP
   * journey. The occurrence remains in evidence, but does not masquerade as an
   * unexpected application console failure. Missing or additional errors fail.
   */
  expectConsoleErrorOnce(text: string): void {
    const expected = this.sanitize(text).trim();
    if (!expected || Buffer.byteLength(expected, 'utf8') > MAX_DETAIL_BYTES) {
      throw new Error('Expected console error must be a bounded non-empty exact string.');
    }
    this.expectedConsoleErrors.push({ text: expected, matched: false });
  }

  unmatchedExpectedConsoleErrors(): readonly string[] {
    return Object.freeze(
      this.expectedConsoleErrors
        .filter(expected => !expected.matched)
        .map(expected => expected.text)
    );
  }

  recordConsole(type: string, text: string): void {
    const sanitized = this.sanitize(text);
    this.counters.consoleMessages += 1;
    this.countSecrets(text);
    if (type === 'error') {
      const expected = this.expectedConsoleErrors.find(
        candidate => !candidate.matched && candidate.text === sanitized
      );
      if (expected) {
        expected.matched = true;
        const matched = this.expectedConsoleErrors.filter(candidate => candidate.matched).length;
        this.facts.set('browser.expected_console_errors', matched);
        this.pushEvent({ kind: 'console', detail: `expected-error ${sanitized}` });
        return;
      }
    }
    if (type === 'error') this.counters.consoleErrors += 1;
    if (type === 'warning' || type === 'warn') this.counters.consoleWarnings += 1;
    if (type === 'error' || type === 'warning' || type === 'warn') {
      this.pushEvent({ kind: 'console', detail: `${safeComponent(type)} ${sanitized}` });
    }
  }

  recordRequest(method: string, url: string, resourceType = 'other'): void {
    this.counters.networkRequests += 1;
    if (resourceType === 'eventsource') this.counters.sseRequests += 1;
    this.countSecrets(url);
    this.pushEvent({
      kind: 'request',
      detail:
        `${safeComponent(method.toUpperCase())} ${safeUrl(url, value => this.sanitize(value))} ` +
        `[${safeComponent(resourceType)}]`,
    });
  }

  recordRequestFailure(method: string, url: string, failure: string): void {
    this.counters.networkFailures += 1;
    this.countSecrets(`${url}\n${failure}`);
    this.pushEvent({
      kind: 'request-failed',
      detail:
        `${safeComponent(method.toUpperCase())} ${safeUrl(url, value => this.sanitize(value))} ` +
        this.sanitize(failure),
    });
  }

  recordResponse(url: string, status: number): void {
    if (status < 500) return;
    this.counters.http5xx += 1;
    this.countSecrets(url);
    this.pushEvent({
      kind: 'response',
      detail: safeUrl(url, value => this.sanitize(value)),
      status,
    });
  }

  attachPage(page: Page): () => void {
    const listeners: PageListeners = {
      console: message => this.recordConsole(message.type(), message.text()),
      pageerror: error => this.recordPageError(error),
      request: request =>
        this.recordRequest(request.method(), request.url(), request.resourceType()),
      requestfailed: request =>
        this.recordRequestFailure(
          request.method(),
          request.url(),
          request.failure()?.errorText ?? 'request failed without browser detail'
        ),
      response: response => this.recordResponse(response.url(), response.status()),
    };
    page.on('console', listeners.console);
    page.on('pageerror', listeners.pageerror);
    page.on('request', listeners.request);
    page.on('requestfailed', listeners.requestfailed);
    page.on('response', listeners.response);
    return () => {
      page.off('console', listeners.console);
      page.off('pageerror', listeners.pageerror);
      page.off('request', listeners.request);
      page.off('requestfailed', listeners.requestfailed);
      page.off('response', listeners.response);
    };
  }

  finalize(
    status: Exclude<WebE2EScenarioStatusV1, 'running'>,
    detail?: string
  ): WebE2EScenarioManifestV1 {
    if (this.finalized)
      throw new Error(`Evidence for ${this.options.scenarioId} is already final.`);
    this.finalized = true;
    const completedAt = new Date();
    const stdout = this.stdout.snapshot();
    const stderr = this.stderr.snapshot();
    this.counters.stdoutBytes = stdout.observed;
    this.counters.stdoutDroppedBytes = stdout.dropped;
    this.counters.stderrBytes = stderr.observed;
    this.counters.stderrDroppedBytes = stderr.dropped;
    const stdoutPath = join(this.scenarioDirectory, 'stdout.log');
    const stderrPath = join(this.scenarioDirectory, 'stderr.log');
    writePrivateText(stdoutPath, stdout.value);
    writePrivateText(stderrPath, stderr.value);
    const effectiveStatus = status === 'pass' && this.counters.secretFindings > 0 ? 'fail' : status;
    const effectiveDetail =
      status === 'pass' && effectiveStatus === 'fail'
        ? 'Evidence secret scan found one or more credential-shaped values.'
        : detail;
    const manifest: WebE2EScenarioManifestV1 = Object.freeze({
      version: 1,
      kind: 'orion.web-e2e-scenario-evidence',
      runId: this.options.state.runId,
      scenarioId: this.options.scenarioId,
      startedAt: this.startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - this.startedAt.getTime()),
      status: effectiveStatus,
      ...(effectiveDetail
        ? { detail: boundedText(this.sanitize(effectiveDetail), MAX_DETAIL_BYTES) }
        : {}),
      ...(this.browserIdentity ? { browser: this.browserIdentity } : {}),
      counters: Object.freeze({ ...this.counters }),
      logs: Object.freeze({ stdout: 'stdout.log', stderr: 'stderr.log' }),
      facts: Object.freeze(
        Object.fromEntries([...this.facts].sort(([left], [right]) => left.localeCompare(right)))
      ),
      events: Object.freeze([...this.events]),
    });
    writePrivateJson(join(this.scenarioDirectory, 'manifest.json'), manifest);
    aggregateWebE2EEvidence(this.options.state);
    return manifest;
  }

  snapshotCounters(): WebE2EEvidenceCountersV1 {
    const stdout = this.stdout.snapshot();
    const stderr = this.stderr.snapshot();
    return Object.freeze({
      ...this.counters,
      stdoutBytes: stdout.observed,
      stdoutDroppedBytes: stdout.dropped,
      stderrBytes: stderr.observed,
      stderrDroppedBytes: stderr.dropped,
    });
  }

  private sanitize(value: string): string {
    return sanitizeEvidenceText(value, {
      privatePaths: Object.fromEntries(this.privatePaths),
      secretValues: [...this.secrets],
    });
  }

  private countSecrets(value: string): void {
    this.counters.secretFindings += countSecretFindings(value, [...this.secrets]);
  }

  private pushEvent(event: WebE2EEvidenceEventV1): void {
    if (this.events.length >= MAX_EVENT_ENTRIES) {
      this.counters.droppedEvents += 1;
      return;
    }
    this.events.push(
      Object.freeze({
        ...event,
        detail: boundedText(event.detail, MAX_DETAIL_BYTES),
      })
    );
  }
}

export function createWebE2EEvidenceCollector(
  options: WebE2EEvidenceCollectorOptions
): WebE2EEvidenceCollector {
  return new WebE2EEvidenceCollector(options);
}

export function initializeWebE2EEvidenceManifest(
  state: WebE2EArtifactStateV1
): WebE2ERunManifestV1 {
  mkdirPrivate(join(state.rawRoot, 'scenarios'));
  return aggregateWebE2EEvidence(state);
}

export function aggregateWebE2EEvidence(
  state: WebE2EArtifactStateV1,
  expectedScenarioIds: readonly string[] = []
): WebE2ERunManifestV1 {
  const scenariosRoot = join(state.rawRoot, 'scenarios');
  mkdirPrivate(scenariosRoot);
  const scenarios = readScenarioManifests(scenariosRoot, state.runId);
  const counters = scenarios.reduce(
    (aggregate, scenario) => sumCounters(aggregate, scenario.counters),
    emptyMutableCounters()
  );
  const previous = readManifestCreatedAt(join(state.rawRoot, 'manifest.json'));
  const manifest: WebE2ERunManifestV1 = Object.freeze({
    version: 1,
    kind: 'orion.web-e2e-manifest',
    runId: state.runId,
    createdAt: previous ?? state.createdAt,
    updatedAt: new Date().toISOString(),
    source: Object.freeze({ ...state.artifact.receipt.source }),
    artifact: Object.freeze({
      packageName: state.artifact.receipt.package.name,
      packageVersion: state.artifact.receipt.package.version,
      tarballFilename: state.artifact.receipt.tarball.filename,
      tarballSha256: state.artifact.receipt.tarball.sha256,
      artifactReceiptDigest: state.artifact.receipt.receiptDigest,
      installedTargetDigest: state.installation.targetDigest,
      source: state.source,
    }),
    environment: Object.freeze({ ...state.environment }),
    paths: Object.freeze({
      state: relativeEvidencePath(state, state.statePath),
      artifact: relativeEvidencePath(state, state.artifact.tarballPath),
      receipt: relativeEvidencePath(state, state.artifact.receiptPath),
      installation: relativeEvidencePath(state, state.installation.prefix),
      scenarios: 'scenarios',
    }),
    scenarios: Object.freeze(scenarios),
    counters: Object.freeze({ ...counters }),
    decision: runDecision(scenarios, expectedScenarioIds),
  });
  writePrivateJson(join(state.rawRoot, 'manifest.json'), manifest);
  return manifest;
}

function runDecision(
  scenarios: readonly WebE2EScenarioManifestV1[],
  expectedScenarioIds: readonly string[]
): WebE2ERunDecisionV1 {
  if (scenarios.some(scenario => scenario.status === 'fail')) return 'NO_GO';
  const expected = [...new Set(expectedScenarioIds)];
  if (expected.length === 0) return 'IN_PROGRESS';
  return expected.every(id => scenarios.some(scenario => scenario.scenarioId === id))
    ? 'GO'
    : 'IN_PROGRESS';
}

export function sanitizeEvidenceText(
  value: string,
  options: {
    readonly privatePaths?: Readonly<Record<string, string>>;
    readonly secretValues?: readonly string[];
  } = {}
): string {
  let sanitized = value.replace(/\u0000/gu, '');
  const privatePaths = Object.entries(options.privatePaths ?? {}).sort(
    ([left], [right]) => right.length - left.length
  );
  for (const [path, replacement] of privatePaths) {
    if (path) sanitized = sanitized.split(path).join(replacement);
  }
  for (const secret of options.secretValues ?? []) {
    if (secret.length >= 4) {
      sanitized = sanitized.split(secret).join('[REDACTED_TEST_SECRET]');
    }
  }
  sanitized = redactTraceText(sanitized)
    .replace(/([?&](?:api[_-]?key|key|token|secret|authorization)=)[^&#\s]*/giu, '$1[REDACTED]')
    .replace(/\b(cookie|set-cookie)\s*:\s*[^\r\n]+/giu, '$1: [REDACTED]')
    .replace(
      /\b[A-Za-z]:\\(?:Users|Documents and Settings|Temp)\\[^\r\n"'<>|]*/gu,
      '<ABSOLUTE_PATH>'
    )
    .replace(
      /\/(?:Users|home)\/[^/\s]+(?:\/[^\s"'<>]*)?|\/(?:private\/)?(?:tmp|var\/folders)\/[^\s"'<>]*/gu,
      '<ABSOLUTE_PATH>'
    );
  return sanitized;
}

export function countSecretFindings(value: string, secretValues: readonly string[] = []): number {
  let findings = secretValues.filter(secret => secret.length >= 4 && value.includes(secret)).length;
  const patterns = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu,
    /\bsk-[A-Za-z0-9_.-]{8,}\b/gu,
    /[?&](?:api[_-]?key|key|token|secret|authorization)=[^&#\s]+/giu,
    /\b(?:authorization|api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/giu,
  ];
  for (const pattern of patterns) findings += value.match(pattern)?.length ?? 0;
  return findings;
}

function readScenarioManifests(scenariosRoot: string, runId: string): WebE2EScenarioManifestV1[] {
  const manifests: WebE2EScenarioManifestV1[] = [];
  for (const entry of readdirSync(scenariosRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(scenariosRoot, entry.name, 'manifest.json');
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as WebE2EScenarioManifestV1;
    if (
      manifest.version !== 1 ||
      manifest.kind !== 'orion.web-e2e-scenario-evidence' ||
      manifest.runId !== runId ||
      !['pass', 'fail'].includes(manifest.status)
    ) {
      throw new Error(`Invalid Web E2E scenario manifest: ${basename(dirname(path))}.`);
    }
    manifests.push(manifest);
  }
  return manifests.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

function readManifestCreatedAt(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Partial<WebE2ERunManifestV1>;
    return typeof manifest.createdAt === 'string' ? manifest.createdAt : undefined;
  } catch {
    return undefined;
  }
}

function relativeEvidencePath(state: WebE2EArtifactStateV1, path: string): string {
  const value = relative(state.rawRoot, path);
  if (!value || value === '..' || value.startsWith(`..${sep}`) || resolve(value) === value) {
    if (!value) return '.';
    throw new Error('Evidence path escapes the Web E2E raw root.');
  }
  return value.split(sep).join('/');
}

function sumCounters(
  aggregate: MutableCounters,
  counters: WebE2EEvidenceCountersV1
): MutableCounters {
  for (const key of Object.keys(aggregate) as Array<keyof MutableCounters>) {
    aggregate[key] += counters[key];
  }
  return aggregate;
}

function emptyMutableCounters(): MutableCounters {
  return {
    stdoutBytes: 0,
    stdoutDroppedBytes: 0,
    stderrBytes: 0,
    stderrDroppedBytes: 0,
    consoleMessages: 0,
    consoleErrors: 0,
    consoleWarnings: 0,
    pageErrors: 0,
    networkRequests: 0,
    networkFailures: 0,
    http5xx: 0,
    sseRequests: 0,
    secretFindings: 0,
    droppedEvents: 0,
  };
}

function safeUrl(value: string, sanitize: (value: string) => string): string {
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    if (parsed.search) parsed.search = '?[REDACTED_QUERY]';
    return sanitize(parsed.toString());
  } catch {
    return sanitize(value);
  }
}

function boundedText(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maximumBytes) return value;
  return `${encoded.subarray(0, maximumBytes).toString('utf8')} [TRUNCATED]`;
}

function safeComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 96) || 'scenario';
}

function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function writePrivateText(path: string, value: string): void {
  mkdirPrivate(dirname(path));
  writeFileSync(path, value, { mode: 0o600 });
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirPrivate(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
