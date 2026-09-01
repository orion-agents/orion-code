#!/usr/bin/env ts-node

import { createHash } from 'crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';

import { digestRuntimeValue } from '../../src/runtime/protocol/canonical';
import {
  SUPPORTED_RELEASE_NODE_MAJORS_V1,
  createWebE2EReleaseReceiptV1,
  verifyTarballArtifactReceiptV1,
  type ReleaseGateDecisionV1,
  type WebE2ERunEvidenceV1,
} from '../../src/runtime/release-receipts';
import {
  WEB31_REQUIRED_EVIDENCE_FACTS_V1,
  WEB32_REQUIRED_EVIDENCE_FACTS_V1,
  WEB33_REQUIRED_EVIDENCE_FACTS_V1,
  webE2ERunnerDigest,
} from '../../tests/e2e/scenarios';

export interface WebE2EScenarioManifest {
  readonly scenarioId?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly status?: string;
  readonly browser?: { readonly name?: string; readonly version?: string };
  readonly counters?: Readonly<Record<string, number>>;
  readonly facts?: Readonly<Record<string, unknown>>;
  readonly logs?: { readonly stdout?: string; readonly stderr?: string };
}

export interface WebE2ERunManifest {
  readonly version?: number;
  readonly kind?: string;
  readonly runId?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly source?: { readonly gitSha?: string; readonly dirty?: boolean };
  readonly artifact?: {
    readonly packageName?: string;
    readonly packageVersion?: string;
    readonly tarballSha256?: string;
    readonly artifactReceiptDigest?: string;
    readonly installedTargetDigest?: string;
  };
  readonly environment?: {
    readonly node?: string;
    readonly nodeMajor?: number;
    readonly npm?: string;
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
  };
  readonly paths?: Readonly<Record<string, string>>;
  readonly scenarios?: readonly WebE2EScenarioManifest[];
  readonly decision?: string;
}

export interface AssembleWebE2EArgumentsV1 {
  readonly artifact: string;
  readonly primary: readonly string[];
  readonly runtime: readonly string[];
  readonly liveCanary: 'PASS' | 'FAIL' | 'NOT_RUN';
  readonly output: string;
}

export function parseAssembleWebE2EArgumentsV1(argv: readonly string[]): AssembleWebE2EArgumentsV1 {
  const required = (name: string): string => {
    const value = optionValue(argv, name);
    if (!value) throw new Error(`${name} is required.`);
    return resolve(value);
  };
  const primary = optionValues(argv, '--primary').map(value => resolve(value));
  const runtime = optionValues(argv, '--runtime').map(value => resolve(value));
  if (primary.length !== 3) throw new Error('Exactly three --primary manifests are required.');
  if (runtime.length !== SUPPORTED_RELEASE_NODE_MAJORS_V1.length) {
    throw new Error(
      `Exactly ${SUPPORTED_RELEASE_NODE_MAJORS_V1.length} --runtime manifests are required.`
    );
  }
  const liveCanary = optionValue(argv, '--live-canary') ?? 'NOT_RUN';
  if (!['PASS', 'FAIL', 'NOT_RUN'].includes(liveCanary)) {
    throw new Error('--live-canary must be PASS, FAIL, or NOT_RUN.');
  }
  return {
    artifact: required('--artifact'),
    primary,
    runtime,
    liveCanary: liveCanary as AssembleWebE2EArgumentsV1['liveCanary'],
    output: required('--out'),
  };
}

function main(): void {
  const args = parseAssembleWebE2EArgumentsV1(process.argv.slice(2));
  const artifact = verifyTarballArtifactReceiptV1(readJson(args.artifact));
  const primaryRuns = args.primary.map((path, index) => toRunEvidence(path, 'primary', index + 1));
  const runtimeRuns = args.runtime
    .map(path => {
      const manifest = readManifest(path);
      return toRunEvidence(path, 'runtime', manifest.environment?.nodeMajor ?? 0, manifest);
    })
    .sort((left, right) => left.environment.nodeMajor - right.environment.nodeMajor);
  const receipt = createWebE2EReleaseReceiptV1({
    version: 1,
    kind: 'orion.web-e2e-release',
    createdAt: new Date().toISOString(),
    source: artifact.source,
    artifactReceiptDigest: artifact.receiptDigest,
    tarballSha256: artifact.tarball.sha256,
    package: artifact.package,
    primaryRuns,
    runtimeRuns,
    liveCanary: args.liveCanary,
  });
  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    `[web-e2e-receipt] decision=${receipt.decision} sha256=${receipt.tarballSha256} ` +
      `receiptDigest=${receipt.receiptDigest} output=${args.output}\n`
  );
  if (receipt.decision !== 'GO') process.exitCode = 1;
}

function toRunEvidence(
  path: string,
  role: WebE2ERunEvidenceV1['role'],
  ordinal: number,
  supplied?: WebE2ERunManifest
): WebE2ERunEvidenceV1 {
  const manifest = supplied ?? readManifest(path);
  if (manifest.version !== 1 || manifest.kind !== 'orion.web-e2e-manifest') {
    throw new Error(`Invalid Web E2E run manifest: ${path}.`);
  }
  if (!manifest.runId || !manifest.source || !manifest.artifact || !manifest.environment) {
    throw new Error(`Incomplete Web E2E run identity: ${path}.`);
  }
  const scenarios = [...(manifest.scenarios ?? [])];
  if (scenarios.length === 0) throw new Error(`Web E2E run has no scenarios: ${path}.`);
  assertNoSensitiveEvidence(manifest, path);
  const browserIdentities = new Map<string, { readonly name: string; readonly version: string }>();
  for (const scenario of scenarios) {
    const name = scenario.browser?.name ?? '';
    const version = scenario.browser?.version ?? '';
    if (!name || !version) throw new Error(`Scenario browser identity is missing: ${path}.`);
    browserIdentities.set(`${name}\u0000${version}`, { name, version });
    if (!scenario.facts || Object.keys(scenario.facts).length === 0) {
      throw new Error(`Scenario ${scenario.scenarioId ?? 'unknown'} has no structured facts.`);
    }
    assertVersionedEvidenceFacts(scenario, path);
  }
  if (browserIdentities.size !== 1) {
    throw new Error(`Web E2E run used inconsistent browser identities: ${path}.`);
  }
  const runnerDigest = consistentFact(scenarios, 'release.runner_digest', path);
  const runnerName = consistentFact(scenarios, 'release.runner_name', path);
  const runnerImage = consistentFact(scenarios, 'release.runner_image', path);
  const chromeChannel = consistentFact(scenarios, 'release.chrome_channel', path);
  if (!/^[a-f0-9]{64}$/u.test(runnerDigest)) {
    throw new Error(`Web E2E runner digest is invalid: ${path}.`);
  }
  if (runnerDigest !== webE2ERunnerDigest(resolve(__dirname, '../..'))) {
    throw new Error(`Web E2E evidence was produced by a different runner source: ${path}.`);
  }
  for (const value of Object.values(manifest.paths ?? {})) {
    if (
      value.startsWith('/') ||
      /^[A-Za-z]:[\\/]/u.test(value) ||
      value.split('/').includes('..')
    ) {
      throw new Error(`Web E2E manifest contains an unsafe evidence path: ${path}.`);
    }
  }
  const secretScanFindings = scenarios.reduce((sum, scenario) => {
    const findings = scenario.counters?.secretFindings;
    if (!Number.isSafeInteger(findings) || Number(findings) < 0) {
      throw new Error(`Scenario secret scan count is missing or invalid: ${path}.`);
    }
    return sum + Number(findings);
  }, 0);
  const cleanEvidence = scenarios.every(scenario => {
    const counters = scenario.counters ?? {};
    return (
      scenario.status === 'pass' &&
      [
        'consoleErrors',
        'consoleWarnings',
        'pageErrors',
        'http5xx',
        'secretFindings',
        'droppedEvents',
      ].every(key => counters[key] === 0)
    );
  });
  const browser = [...browserIdentities.values()][0];
  const startedAt = boundaryTimestamp(scenarios, 'startedAt', 'minimum', path);
  const completedAt = boundaryTimestamp(scenarios, 'completedAt', 'maximum', path);
  const manifestDigest = verifyEvidenceBundle(path, manifest, scenarios);
  return {
    role,
    ordinal,
    runId: manifest.runId,
    source: {
      gitSha: String(manifest.source.gitSha ?? ''),
      dirty: manifest.source.dirty === true,
    },
    artifactReceiptDigest: String(manifest.artifact.artifactReceiptDigest ?? ''),
    tarballSha256: String(manifest.artifact.tarballSha256 ?? ''),
    installedTargetDigest: String(manifest.artifact.installedTargetDigest ?? ''),
    environment: {
      node: String(manifest.environment.node ?? ''),
      nodeMajor: Number(manifest.environment.nodeMajor ?? 0),
      npm: String(manifest.environment.npm ?? ''),
      platform: manifest.environment.platform ?? process.platform,
      arch: String(manifest.environment.arch ?? ''),
    },
    browser: { ...browser, channel: chromeChannel },
    runner: { name: runnerName, image: runnerImage, digest: runnerDigest },
    startedAt,
    completedAt,
    scenarioIds: scenarios.map(scenario => String(scenario.scenarioId ?? '')).sort(),
    durationMs: scenarios.reduce((sum, scenario) => sum + Number(scenario.durationMs ?? 0), 0),
    manifestDigest,
    secretScanFindings,
    cleanEvidence,
    decision: normalizeDecision(manifest.decision),
  };
}

export function verifyEvidenceBundle(
  manifestPath: string,
  manifest: WebE2ERunManifest,
  scenarios: readonly WebE2EScenarioManifest[]
): string {
  const runRoot = dirname(manifestPath);
  const scenariosRoot = join(runRoot, 'scenarios');
  const expectedDigests = new Set(scenarios.map(scenario => digestRuntimeValue(scenario)));
  const observedDigests = new Set<string>();
  const files: Array<{ readonly path: string; readonly sha256: string }> = [];
  for (const entry of readdirSync(scenariosRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const scenarioRoot = join(scenariosRoot, entry.name);
    const scenarioManifestPath = join(scenarioRoot, 'manifest.json');
    const scenario = readJson(scenarioManifestPath) as WebE2EScenarioManifest;
    const digest = digestRuntimeValue(scenario);
    if (!expectedDigests.has(digest) || observedDigests.has(digest)) {
      throw new Error(
        `Raw Web E2E scenario evidence does not match the run manifest: ${manifestPath}.`
      );
    }
    observedDigests.add(digest);
    assertNoSensitiveEvidence(scenario, scenarioManifestPath);
    assertVersionedEvidenceFacts(scenario, scenarioManifestPath);
    addEvidenceFile(files, runRoot, scenarioManifestPath);
    for (const key of ['stdout', 'stderr'] as const) {
      const filename = scenario.logs?.[key];
      if (filename !== `${key}.log`) {
        throw new Error(`Scenario ${key} evidence path is missing or unsafe: ${manifestPath}.`);
      }
      const logPath = join(scenarioRoot, filename);
      const body = readFileSync(logPath);
      assertNoSensitiveEvidence(body.toString('utf8'), logPath);
      addEvidenceFile(files, runRoot, logPath, body);
    }
    addScreenshotEvidence(files, runRoot, scenarioRoot, scenario, manifestPath);
  }
  if (observedDigests.size !== expectedDigests.size || observedDigests.size !== scenarios.length) {
    throw new Error(`Raw Web E2E scenario evidence is incomplete: ${manifestPath}.`);
  }
  return digestRuntimeValue({
    manifest,
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  });
}

function assertVersionedEvidenceFacts(scenario: WebE2EScenarioManifest, path: string): void {
  const scenarioId = scenario.scenarioId ?? '';
  const requirements =
    WEB31_REQUIRED_EVIDENCE_FACTS_V1[scenarioId] ??
    WEB32_REQUIRED_EVIDENCE_FACTS_V1[scenarioId] ??
    WEB33_REQUIRED_EVIDENCE_FACTS_V1[scenarioId];
  if (!requirements) return;
  const facts = scenario.facts ?? {};
  for (const requirement of requirements) {
    const observed = facts[requirement.key];
    const exactOk = requirement.equals === undefined || observed === requirement.equals;
    const minimumOk =
      requirement.minimum === undefined ||
      (typeof observed === 'number' &&
        Number.isFinite(observed) &&
        observed >= requirement.minimum);
    if (!exactOk || !minimumOk) {
      throw new Error(
        `Versioned Web evidence fact ${requirement.key} is missing or invalid for ${scenarioId}: ${path}.`
      );
    }
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;
const MAX_SCREENSHOT_DIMENSION = 32_768;
const MAX_SCREENSHOT_PIXELS = 100_000_000;

function addScreenshotEvidence(
  files: Array<{ readonly path: string; readonly sha256: string }>,
  runRoot: string,
  scenarioRoot: string,
  scenario: WebE2EScenarioManifest,
  manifestPath: string
): void {
  const screenshotFacts = Object.entries(scenario.facts ?? {}).filter(([key]) =>
    key.startsWith('screenshot.')
  );
  const requiresScreenshot = /^(?:SET|WEB31|WEB32|WEB33)-P0-\d{2}$/u.test(
    scenario.scenarioId ?? ''
  );
  if (requiresScreenshot && screenshotFacts.length === 0) {
    throw new Error(`Release scenario screenshot evidence is missing: ${manifestPath}.`);
  }

  const filenames = new Set<string>();
  for (const [key, value] of screenshotFacts) {
    if (
      !/^screenshot\.[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(key) ||
      typeof value !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/u.test(value) ||
      value.includes('/') ||
      value.includes('\\')
    ) {
      throw new Error(`Scenario screenshot evidence path is missing or unsafe: ${manifestPath}.`);
    }
    filenames.add(value);
  }

  for (const filename of filenames) {
    const screenshotPath = join(scenarioRoot, filename);
    const body = readValidatedPng(screenshotPath, manifestPath);
    addEvidenceFile(files, runRoot, screenshotPath, body);
  }
}

function readValidatedPng(path: string, manifestPath: string): Buffer {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`Scenario screenshot evidence is missing: ${manifestPath}.`);
  }
  if (!stat.isFile()) {
    throw new Error(`Scenario screenshot evidence must be a regular file: ${manifestPath}.`);
  }
  if (stat.size < 33 || stat.size > MAX_SCREENSHOT_BYTES) {
    throw new Error(`Scenario screenshot evidence has an invalid PNG size: ${manifestPath}.`);
  }
  const body = readFileSync(path);
  const width = body.readUInt32BE(16);
  const height = body.readUInt32BE(20);
  if (
    !body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    body.readUInt32BE(8) !== 13 ||
    body.subarray(12, 16).toString('ascii') !== 'IHDR' ||
    width === 0 ||
    height === 0 ||
    width > MAX_SCREENSHOT_DIMENSION ||
    height > MAX_SCREENSHOT_DIMENSION ||
    width * height > MAX_SCREENSHOT_PIXELS
  ) {
    throw new Error(`Scenario screenshot evidence is not a valid bounded PNG: ${manifestPath}.`);
  }
  return body;
}

function addEvidenceFile(
  files: Array<{ readonly path: string; readonly sha256: string }>,
  runRoot: string,
  path: string,
  supplied?: Buffer
): void {
  const safePath = relative(runRoot, path).replace(/\\/gu, '/');
  if (!safePath || safePath.startsWith('../') || safePath.includes('/../')) {
    throw new Error('Raw Web E2E evidence path escapes the run root.');
  }
  if (!lstatSync(path).isFile()) throw new Error('Raw Web E2E evidence must be a regular file.');
  files.push({
    path: safePath,
    sha256: createHash('sha256')
      .update(supplied ?? readFileSync(path))
      .digest('hex'),
  });
}

function consistentFact(
  scenarios: readonly WebE2EScenarioManifest[],
  key: string,
  path: string
): string {
  const values = scenarios.map(scenario => scenario.facts?.[key]);
  if (values.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error(`Scenario fact ${key} is missing: ${path}.`);
  }
  const normalized = values.map(value => String(value));
  if (new Set(normalized).size !== 1) {
    throw new Error(`Scenario fact ${key} is inconsistent: ${path}.`);
  }
  return normalized[0];
}

function boundaryTimestamp(
  scenarios: readonly WebE2EScenarioManifest[],
  key: 'startedAt' | 'completedAt',
  direction: 'minimum' | 'maximum',
  path: string
): string {
  const values = scenarios.map(scenario => scenario[key]);
  if (values.some(value => !value || Number.isNaN(Date.parse(value)))) {
    throw new Error(`Scenario ${key} is missing or invalid: ${path}.`);
  }
  const timestamps = values.map(value => String(value)).sort();
  return direction === 'minimum' ? timestamps[0] : timestamps[timestamps.length - 1];
}

function assertNoSensitiveEvidence(value: unknown, path: string): void {
  const sensitiveKeys =
    /^(?:authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|password|secret|headers?|prompt|body|config|configuration)$/iu;
  const sensitiveValues = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
    /\bsk-[A-Za-z0-9_.-]{8,}\b/u,
    /[?&](?:api[_-]?key|key|token|secret|authorization)=[^&#\s]+/iu,
    /\b(?:authorization|api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/iu,
    /\b(?:ORION_CODE_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|AZURE_OPENAI_API_KEY)\b/u,
    /\/(?:Users|home)\/[^\s"'<>]+/u,
    /\b[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\r\n"'<>|]+/u,
  ];
  const visit = (entry: unknown): void => {
    if (typeof entry === 'string') {
      if (sensitiveValues.some(pattern => pattern.test(entry))) {
        throw new Error(`Web E2E manifest contains sensitive evidence: ${path}.`);
      }
      return;
    }
    if (!entry || typeof entry !== 'object') return;
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    for (const [key, nested] of Object.entries(entry as Record<string, unknown>)) {
      if (sensitiveKeys.test(key)) {
        throw new Error(`Web E2E manifest contains forbidden evidence key ${key}: ${path}.`);
      }
      visit(nested);
    }
  };
  visit(value);
}

function readManifest(path: string): WebE2ERunManifest {
  return readJson(path) as WebE2ERunManifest;
}

function normalizeDecision(value: string | undefined): ReleaseGateDecisionV1 {
  return value === 'GO' ? 'GO' : 'NO_GO';
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const inline = argv.find(value => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function optionValues(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith(`${name}=`)) values.push(value.slice(name.length + 1));
    else if (value === name && argv[index + 1]) values.push(argv[++index]);
  }
  return values;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
