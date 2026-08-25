import { digestRuntimeValue } from './protocol/canonical';

export const HARNESS_EVAL_VERSION_V1 = 1 as const;
export const HARNESS_EVAL_MIN_ITERATIONS_V1 = 30 as const;

export interface HarnessEvalTaskV1 {
  readonly id: string;
  readonly objective: string;
  readonly criteria: readonly string[];
  readonly requiredTools: readonly string[];
  readonly expectedEvidence: string;
  readonly modelRequests: number;
}

export interface HarnessEvalSampleV1 {
  readonly id: string;
  readonly taskId: string;
  readonly iteration: number;
  readonly success: boolean;
  readonly completionClaimed: boolean;
  readonly evidenceSatisfied: boolean;
  readonly falseCompletion: boolean;
  readonly inputTokens: number;
  readonly modelRequests: number;
  readonly expansionSteps: number;
  readonly orchestrationMs: number;
  readonly toolSchemaBytes: number;
  readonly toolSchemaTokens: number;
  readonly directTools: readonly string[];
  readonly omittedRequiredTools: readonly string[];
  readonly capabilityReceiptDigest?: string;
}

export interface HarnessEvalReceiptV1 {
  readonly version: typeof HARNESS_EVAL_VERSION_V1;
  readonly kind: 'orion.harness-eval';
  readonly mode: 'baseline' | 'candidate';
  readonly createdAt: string;
  readonly source: {
    readonly gitSha: string;
    readonly branch: string;
    readonly dirty: boolean;
    readonly packageVersion: string;
  };
  readonly environment: {
    readonly node: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  };
  readonly corpus: {
    readonly id: string;
    readonly digest: string;
    readonly taskCount: number;
    readonly iterations: number;
    readonly provider: 'deterministic-capability-contract';
    readonly providerCorrectnessDependency: false;
  };
  readonly samples: readonly HarnessEvalSampleV1[];
  readonly summary: {
    readonly samples: number;
    readonly successes: number;
    readonly successRate: number;
    readonly falseCompletions: number;
    readonly falseCompletionRate: number;
    readonly successfulInputTokensP50: number;
    readonly successfulInputTokensP95: number;
    readonly successfulModelRequestsP50: number;
    readonly expansionStepRate: number;
    readonly orchestrationMsP50: number;
    readonly orchestrationMsP95: number;
    readonly toolSchemaBytesP50: number;
  };
  readonly compatibilityFingerprint: string;
  readonly receiptDigest: string;
}

export interface HarnessEvalComparisonV1 {
  readonly version: 1;
  readonly kind: 'orion.harness-eval-comparison';
  readonly baselineDigest: string;
  readonly candidateDigest: string;
  readonly checks: readonly {
    readonly id: string;
    readonly status: 'pass' | 'fail';
    readonly actual: number | string | boolean;
    readonly expected: number | string | boolean;
  }[];
  readonly decision: 'GO' | 'NO_GO';
  readonly receiptDigest: string;
}

export function createHarnessEvalReceiptV1(input: {
  readonly mode: HarnessEvalReceiptV1['mode'];
  readonly createdAt: string;
  readonly source: HarnessEvalReceiptV1['source'];
  readonly environment: HarnessEvalReceiptV1['environment'];
  readonly corpus: HarnessEvalReceiptV1['corpus'];
  readonly samples: readonly HarnessEvalSampleV1[];
}): HarnessEvalReceiptV1 {
  assertReceiptInput(input);
  const samples = input.samples.map(sample => freezeSample(sample));
  const summary = summarizeHarnessEvalSamplesV1(samples);
  const compatibilityFingerprint = digestRuntimeValue({
    environment: input.environment,
    corpus: input.corpus,
  });
  const unsigned = deepFreeze({
    version: HARNESS_EVAL_VERSION_V1,
    kind: 'orion.harness-eval' as const,
    mode: input.mode,
    createdAt: input.createdAt,
    source: { ...input.source },
    environment: { ...input.environment },
    corpus: { ...input.corpus },
    samples,
    summary,
    compatibilityFingerprint,
  });
  return deepFreeze({ ...unsigned, receiptDigest: digestRuntimeValue(unsigned) });
}

export function verifyHarnessEvalReceiptV1(value: unknown): HarnessEvalReceiptV1 {
  const receipt = value as HarnessEvalReceiptV1;
  if (!receipt || receipt.version !== 1 || receipt.kind !== 'orion.harness-eval') {
    throw new Error('Invalid HarnessEvalReceiptV1 envelope.');
  }
  const rebuilt = createHarnessEvalReceiptV1({
    mode: receipt.mode,
    createdAt: receipt.createdAt,
    source: receipt.source,
    environment: receipt.environment,
    corpus: receipt.corpus,
    samples: receipt.samples,
  });
  if (rebuilt.receiptDigest !== receipt.receiptDigest) {
    throw new Error('HarnessEvalReceiptV1 digest mismatch.');
  }
  return rebuilt;
}

export function compareHarnessEvalReceiptsV1(
  baselineInput: HarnessEvalReceiptV1,
  candidateInput: HarnessEvalReceiptV1
): HarnessEvalComparisonV1 {
  const baseline = verifyHarnessEvalReceiptV1(baselineInput);
  const candidate = verifyHarnessEvalReceiptV1(candidateInput);
  const inputTokenReduction = reductionPercent(
    baseline.summary.successfulInputTokensP50,
    candidate.summary.successfulInputTokensP50
  );
  const requestGrowth = growthPercent(
    baseline.summary.successfulModelRequestsP50,
    candidate.summary.successfulModelRequestsP50
  );
  const checks: Array<{
    id: string;
    status: 'pass' | 'fail';
    actual: number | string | boolean;
    expected: number | string | boolean;
  }> = [];
  const add = (
    id: string,
    ok: boolean,
    actual: number | string | boolean,
    expected: number | string | boolean
  ): void => {
    checks.push({ id, status: ok ? 'pass' : 'fail', actual, expected });
  };
  add(
    'same-environment-corpus',
    baseline.compatibilityFingerprint === candidate.compatibilityFingerprint,
    candidate.compatibilityFingerprint,
    baseline.compatibilityFingerprint
  );
  add(
    'receipt-modes',
    baseline.mode === 'baseline' && candidate.mode === 'candidate',
    `${baseline.mode}->${candidate.mode}`,
    'baseline->candidate'
  );
  add('successful-input-token-reduction', inputTokenReduction >= 30, inputTokenReduction, 30);
  add(
    'task-success-not-lower',
    candidate.summary.successRate >= baseline.summary.successRate,
    candidate.summary.successRate,
    baseline.summary.successRate
  );
  add(
    'false-completion-rate',
    candidate.summary.falseCompletionRate === 0,
    candidate.summary.falseCompletionRate,
    0
  );
  add('model-request-growth', requestGrowth <= 5, requestGrowth, 5);
  add(
    'capability-expansion-rate',
    candidate.summary.expansionStepRate < 10,
    candidate.summary.expansionStepRate,
    '<10'
  );
  add(
    'local-orchestration-p95',
    candidate.summary.orchestrationMsP95 < 5,
    candidate.summary.orchestrationMsP95,
    '<5'
  );
  const decision: HarnessEvalComparisonV1['decision'] = checks.every(
    check => check.status === 'pass'
  )
    ? 'GO'
    : 'NO_GO';
  const unsigned = deepFreeze({
    version: 1 as const,
    kind: 'orion.harness-eval-comparison' as const,
    baselineDigest: baseline.receiptDigest,
    candidateDigest: candidate.receiptDigest,
    checks: deepFreeze(checks),
    decision,
  });
  return deepFreeze({ ...unsigned, receiptDigest: digestRuntimeValue(unsigned) });
}

export function summarizeHarnessEvalSamplesV1(
  samples: readonly HarnessEvalSampleV1[]
): HarnessEvalReceiptV1['summary'] {
  if (samples.length === 0) throw new Error('Harness eval requires samples.');
  const successful = samples.filter(sample => sample.success);
  const falseCompletions = samples.filter(sample => sample.falseCompletion).length;
  const expansionSteps = samples.reduce((total, sample) => total + sample.expansionSteps, 0);
  return deepFreeze({
    samples: samples.length,
    successes: successful.length,
    successRate: percent(successful.length, samples.length),
    falseCompletions,
    falseCompletionRate: percent(falseCompletions, samples.length),
    successfulInputTokensP50: percentile(
      successful.map(sample => sample.inputTokens),
      0.5
    ),
    successfulInputTokensP95: percentile(
      successful.map(sample => sample.inputTokens),
      0.95
    ),
    successfulModelRequestsP50: percentile(
      successful.map(sample => sample.modelRequests),
      0.5
    ),
    expansionStepRate: percent(expansionSteps, samples.length),
    orchestrationMsP50: percentile(
      samples.map(sample => sample.orchestrationMs),
      0.5,
      6
    ),
    orchestrationMsP95: percentile(
      samples.map(sample => sample.orchestrationMs),
      0.95,
      6
    ),
    toolSchemaBytesP50: percentile(
      samples.map(sample => sample.toolSchemaBytes),
      0.5
    ),
  });
}

function assertReceiptInput(input: {
  readonly mode: HarnessEvalReceiptV1['mode'];
  readonly createdAt: string;
  readonly source: HarnessEvalReceiptV1['source'];
  readonly environment: HarnessEvalReceiptV1['environment'];
  readonly corpus: HarnessEvalReceiptV1['corpus'];
  readonly samples: readonly HarnessEvalSampleV1[];
}): void {
  if (input.mode !== 'baseline' && input.mode !== 'candidate') {
    throw new Error('Harness eval mode must be baseline or candidate.');
  }
  if (Number.isNaN(Date.parse(input.createdAt)))
    throw new Error('Harness eval timestamp is invalid.');
  if (input.corpus.iterations < HARNESS_EVAL_MIN_ITERATIONS_V1) {
    throw new Error(`Harness eval requires at least ${HARNESS_EVAL_MIN_ITERATIONS_V1} iterations.`);
  }
  if (input.corpus.provider !== 'deterministic-capability-contract') {
    throw new Error('Harness eval provider identity is invalid.');
  }
  const expected = input.corpus.taskCount * input.corpus.iterations;
  if (input.samples.length !== expected) {
    throw new Error(
      `Harness eval expected ${expected} samples but received ${input.samples.length}.`
    );
  }
  const ids = new Set<string>();
  for (const sample of input.samples) {
    if (ids.has(sample.id)) throw new Error(`Duplicate harness eval sample ${sample.id}.`);
    ids.add(sample.id);
    for (const [name, value] of [
      ['iteration', sample.iteration],
      ['inputTokens', sample.inputTokens],
      ['modelRequests', sample.modelRequests],
      ['expansionSteps', sample.expansionSteps],
      ['toolSchemaBytes', sample.toolSchemaBytes],
      ['toolSchemaTokens', sample.toolSchemaTokens],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${sample.id} ${name} must be a non-negative safe integer.`);
      }
    }
    if (!Number.isFinite(sample.orchestrationMs) || sample.orchestrationMs < 0) {
      throw new Error(`${sample.id} orchestrationMs must be finite and non-negative.`);
    }
    if (sample.falseCompletion !== (sample.completionClaimed && !sample.evidenceSatisfied)) {
      throw new Error(`${sample.id} falseCompletion is inconsistent with completion evidence.`);
    }
    if (sample.success !== (sample.completionClaimed && sample.evidenceSatisfied)) {
      throw new Error(`${sample.id} success is inconsistent with completion evidence.`);
    }
  }
}

function freezeSample(sample: HarnessEvalSampleV1): HarnessEvalSampleV1 {
  return deepFreeze({
    ...sample,
    directTools: [...sample.directTools],
    omittedRequiredTools: [...sample.omittedRequiredTools],
  });
}

function percentile(values: readonly number[], quantile: number, digits = 0): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return Number(sorted[index].toFixed(digits));
}

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(6));
}

function reductionPercent(baseline: number, candidate: number): number {
  return baseline <= 0 ? 0 : Number((((baseline - candidate) / baseline) * 100).toFixed(6));
}

function growthPercent(baseline: number, candidate: number): number {
  return baseline <= 0
    ? candidate <= 0
      ? 0
      : Number.POSITIVE_INFINITY
    : Number((((candidate - baseline) / baseline) * 100).toFixed(6));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
