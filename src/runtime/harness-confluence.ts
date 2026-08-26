import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, relative, resolve, sep } from 'path';

import { canonicalRuntimeJson, digestRuntimeValue } from './protocol/canonical';
import { ResourceScope } from './resource-scope';

export const ARCHITECTURE_CONFLUENCE_RECEIPT_VERSION = 1 as const;
export const DEFAULT_RESOURCE_SCOPE_CHURN_CYCLES = 1_000;

export type ArchitectureConfluenceDecisionV1 = 'GO' | 'NO_GO';
export type ArchitectureConfluenceCheckStatusV1 = 'pass' | 'fail';
export type ArchitectureConfluenceFindingCategoryV1 =
  | 'scan'
  | 'ownership'
  | 'import'
  | 'export'
  | 'singleton'
  | 'tarball'
  | 'resource_scope';

export interface ArchitectureConfluenceImportRuleV1 {
  readonly id: string;
  readonly description: string;
  /** Repository-relative target paths. `*` and `**` are supported. */
  readonly targetPatterns: readonly string[];
  readonly allowedFiles?: readonly string[];
}

export interface ArchitectureConfluenceSingletonRuleV1 {
  readonly id: string;
  readonly description: string;
  /** JavaScript regular-expression source, evaluated once per source file. */
  readonly pattern: string;
  readonly allowedFiles?: readonly string[];
}

export interface ArchitectureConfluenceOwnerRuleV1 {
  readonly kind: 'runtime' | 'loop' | 'task_context';
  readonly symbol: string;
  readonly file: string;
  readonly competingFindingRuleIds: readonly string[];
}

export interface ArchitectureConfluenceRulesV1 {
  readonly forbiddenImports: readonly ArchitectureConfluenceImportRuleV1[];
  readonly forbiddenExportSymbols: readonly string[];
  readonly forbiddenSingletons: readonly ArchitectureConfluenceSingletonRuleV1[];
  readonly forbiddenTarballSourcePatterns: readonly string[];
  readonly requiredOwners: readonly ArchitectureConfluenceOwnerRuleV1[];
}

export interface ArchitectureConfluenceAllowlistV1 {
  /** `ruleId:file`, `ruleId:file:target`, or an exact repository-relative file. */
  readonly imports?: readonly string[];
  /** `symbol` or `file:symbol`. */
  readonly exports?: readonly string[];
  /** `ruleId:file` or an exact repository-relative file. */
  readonly singletons?: readonly string[];
  /** Exact intended package entry, such as `dist/init.js`. */
  readonly tarballEntries?: readonly string[];
}

export interface ArchitectureConfluenceConfigV1 {
  /** Strict mode requires at least the default 1,000-cycle scope proof. */
  readonly strict?: boolean;
  readonly sourceRoot?: string;
  readonly productionEntrypoints?: readonly string[];
  readonly publicExportEntrypoints?: readonly string[];
  readonly scopeCycles?: number;
  /** A supplied category replaces that category's default rules. */
  readonly rules?: Partial<ArchitectureConfluenceRulesV1>;
  readonly allow?: ArchitectureConfluenceAllowlistV1;
}

export interface ArchitectureConfluenceFindingV1 {
  readonly ruleId: string;
  readonly category: ArchitectureConfluenceFindingCategoryV1;
  readonly severity: 'error';
  readonly file: string;
  readonly line: number;
  readonly match: string;
  readonly message: string;
}

export interface ArchitectureConfluenceSourceScanV1 {
  readonly sourceRoot: string;
  readonly productionEntrypoints: readonly string[];
  readonly publicExportEntrypoints: readonly string[];
  readonly allSourceFiles: readonly string[];
  readonly reachableProductionFiles: readonly string[];
  readonly missingEntrypoints: readonly string[];
  readonly sourceDigest: string;
}

export interface ArchitectureConfluenceOwnerEvidenceV1 {
  readonly kind: ArchitectureConfluenceOwnerRuleV1['kind'];
  readonly expectedSymbol: string;
  readonly expectedFile: string;
  readonly declarations: readonly { readonly file: string; readonly line: number }[];
  readonly productionReferences: readonly { readonly file: string; readonly line: number }[];
  readonly competingFindingRuleIds: readonly string[];
  readonly status: ArchitectureConfluenceCheckStatusV1;
  readonly reason: string;
}

export interface ArchitectureConfluenceTarballIntentV1 {
  readonly packageFiles: readonly string[];
  readonly compilerIncludes: readonly string[];
  readonly compilerExcludes: readonly string[];
  readonly distIncluded: boolean;
  readonly sourceCompilationEnabled: boolean;
  readonly forbiddenEntries: readonly string[];
  readonly digest: string;
}

export interface ResourceScopeChurnEvidenceV1 {
  readonly cycles: number;
  readonly resourcesActivated: number;
  readonly resourcesDisposed: number;
  readonly leasesAcquired: number;
  readonly leasesReleased: number;
  readonly leakedResources: number;
  readonly leakedLeases: number;
  readonly lifoViolations: number;
  readonly closeErrors: number;
  readonly timedOutCloses: number;
  readonly historyIndependent: boolean;
  readonly status: ArchitectureConfluenceCheckStatusV1;
  readonly digest: string;
}

export interface ArchitectureConfluenceCheckV1 {
  readonly id: string;
  readonly category: ArchitectureConfluenceFindingCategoryV1;
  readonly status: ArchitectureConfluenceCheckStatusV1;
  readonly expected: string;
  readonly observed: string;
}

export interface ArchitectureConfluenceCountsV1 {
  readonly findings: number;
  readonly forbiddenImports: number;
  readonly forbiddenExports: number;
  readonly forbiddenSingletons: number;
  readonly forbiddenTarballEntries: number;
  readonly scanErrors: number;
}

export interface ArchitectureConfluenceReceiptV1 {
  readonly version: typeof ARCHITECTURE_CONFLUENCE_RECEIPT_VERSION;
  readonly generatedAt: number;
  readonly repositoryRoot: string;
  readonly strict: boolean;
  readonly configurationDigest: string;
  readonly scan: ArchitectureConfluenceSourceScanV1;
  readonly owners: readonly ArchitectureConfluenceOwnerEvidenceV1[];
  readonly tarball: ArchitectureConfluenceTarballIntentV1;
  readonly resourceScope: ResourceScopeChurnEvidenceV1;
  readonly counts: ArchitectureConfluenceCountsV1;
  readonly findings: readonly ArchitectureConfluenceFindingV1[];
  readonly checks: readonly ArchitectureConfluenceCheckV1[];
  readonly decision: ArchitectureConfluenceDecisionV1;
  readonly digest: string;
}

export interface RunArchitectureConfluenceAuditOptionsV1 {
  readonly repositoryRoot: string;
  readonly config?: ArchitectureConfluenceConfigV1;
  readonly clock?: () => number;
}

interface ResolvedArchitectureConfluenceConfigV1 {
  readonly strict: boolean;
  readonly sourceRoot: string;
  readonly productionEntrypoints: readonly string[];
  readonly publicExportEntrypoints: readonly string[];
  readonly scopeCycles: number;
  readonly rules: ArchitectureConfluenceRulesV1;
  readonly allow: Required<ArchitectureConfluenceAllowlistV1>;
}

interface SourceFileV1 {
  readonly path: string;
  readonly content: string;
}

interface ImportRecordV1 {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
  readonly typeOnly: boolean;
  readonly target?: string;
}

const DEFAULT_RULES: ArchitectureConfluenceRulesV1 = {
  forbiddenImports: [
    {
      id: 'legacy-import',
      description: 'Production code must not import a legacy runtime, agent, loop, or mock SDK.',
      targetPatterns: [
        'src/init.ts',
        'src/agents/**',
        'src/core/agent.ts',
        'src/core/brain.ts',
        'src/harness/harness.ts',
        'src/harness/safety.ts',
        'src/services/agent-runner.ts',
        'src/sdk/**',
        'src/runtime/chat-controller.ts',
        'src/framework/tool-scheduler.ts',
        'src/tools/index.ts',
        'src/tools/mcp.ts',
        'src/skills/index.ts',
        'src/skills/loader.ts',
        'src/skills/registry.ts',
        'src/skills/runtime.ts',
        'src/runtime/goals/accounting.ts',
        'src/runtime/goals/coordinator.ts',
        'src/runtime/goals/lifecycle.ts',
        'src/runtime/goals/prompt.ts',
        'src/runtime/goals/stop-policy.ts',
        'src/runtime/goals/tools.ts',
      ],
    },
    {
      id: 'direct-query-import',
      description: 'Only AgentLoopV1 may bind the internal model-to-tool recursion function.',
      targetPatterns: ['src/framework/query.ts'],
      allowedFiles: ['src/runtime/agent-loop.ts'],
    },
    {
      id: 'global-tools-import',
      description: 'Production code must receive a tool catalog instead of importing global TOOLS.',
      targetPatterns: ['src/tools.ts', 'src/tools/index.ts'],
    },
    {
      id: 'direct-tool-scheduler-import',
      description:
        'Production effects must converge through ToolGateway instead of tool-scheduler.',
      targetPatterns: ['src/framework/tool-scheduler.ts'],
    },
  ],
  forbiddenExportSymbols: [
    'Brain',
    'BaseAgent',
    'LeaderAgent',
    'CoderAgent',
    'init',
    'Harness',
    'MemorySystem',
    'SafetyChecker',
    'AgentRunner',
    'HarnessEngine',
    'query',
    'simpleQuery',
    'ContextHarness',
    'HarnessKernel',
    'createContextHarness',
    'createHarnessKernel',
  ],
  forbiddenSingletons: [
    {
      id: 'global-tool-catalog',
      description: 'The tool catalog must be injected by the composition root.',
      pattern: '\\bexport\\s+const\\s+TOOLS\\b|\\bexport\\s+function\\s+getRuntimeTools\\b',
    },
    {
      id: 'global-mcp-manager',
      description: 'MCP lifecycle must be owned by the runtime resource scope.',
      pattern: '\\bexport\\s+const\\s+mcpManager\\s*=\\s*new\\s+',
    },
    {
      id: 'global-agent-pool',
      description: 'Agent coordinators and worker pools must not be process singletons.',
      pattern:
        '\\blet\\s+default(?:Coordinator|Pool)\\b|\\bexport\\s+function\\s+get(?:Coordinator|WorkerPool)\\b',
    },
    {
      id: 'global-tool-state',
      description: 'Mutable tool lifecycle state must be task/runtime scoped.',
      pattern:
        '\\blet\\s+state\\s*:\\s*ToolState\\b|\\blet\\s+listeners\\s*:\\s*Array<\\(s:\\s*ToolState',
    },
    {
      id: 'global-sdk-config',
      description: 'SDK configuration must not live in a process-global mutable slot.',
      pattern: '\\blet\\s+globalConfig\\s*:\\s*SDKConfig',
    },
  ],
  forbiddenTarballSourcePatterns: [
    'src/init.ts',
    'src/agents/**',
    'src/core/agent.ts',
    'src/core/brain.ts',
    'src/harness/harness.ts',
    'src/harness/safety.ts',
    'src/services/agent-runner.ts',
    'src/sdk/**',
    'src/runtime/chat-controller.ts',
    'src/framework/tool-scheduler.ts',
    'src/tools/index.ts',
    'src/tools/mcp.ts',
    'src/skills/index.ts',
    'src/skills/loader.ts',
    'src/skills/registry.ts',
    'src/skills/runtime.ts',
    'src/runtime/goals/accounting.ts',
    'src/runtime/goals/coordinator.ts',
    'src/runtime/goals/lifecycle.ts',
    'src/runtime/goals/prompt.ts',
    'src/runtime/goals/stop-policy.ts',
    'src/runtime/goals/tools.ts',
  ],
  requiredOwners: [
    {
      kind: 'runtime',
      symbol: 'OrionRuntimeV1',
      file: 'src/runtime/orion-runtime-v1.ts',
      competingFindingRuleIds: [
        'legacy-import',
        'forbidden-export:Brain',
        'forbidden-export:Harness',
        'forbidden-export:HarnessEngine',
      ],
    },
    {
      kind: 'loop',
      symbol: 'AgentLoopV1',
      file: 'src/runtime/agent-loop.ts',
      competingFindingRuleIds: [
        'direct-query-import',
        'forbidden-export:AgentRunner',
        'forbidden-export:query',
        'forbidden-export:simpleQuery',
      ],
    },
    {
      kind: 'task_context',
      symbol: 'TaskContextService',
      file: 'src/runtime/task-context-service.ts',
      competingFindingRuleIds: [
        'forbidden-export:ContextHarness',
        'forbidden-export:HarnessKernel',
        'forbidden-export:createContextHarness',
        'forbidden-export:createHarnessKernel',
      ],
    },
  ],
};

export const DEFAULT_ARCHITECTURE_CONFLUENCE_RULES_V1 = deepFreeze(cloneRules(DEFAULT_RULES));

/** Configuration or receipt corruption is an architecture gate error, never an implicit pass. */
export class ArchitectureConfluenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchitectureConfluenceError';
  }
}

/**
 * Run the strict architecture audit and produce a digest-bound, machine-readable receipt.
 * Architecture violations are represented as a NO_GO receipt; invalid input throws fail closed.
 */
export async function runArchitectureConfluenceAuditV1(
  options: RunArchitectureConfluenceAuditOptionsV1
): Promise<ArchitectureConfluenceReceiptV1> {
  const repositoryRoot = resolve(options.repositoryRoot);
  if (!existsSync(repositoryRoot) || !statSync(repositoryRoot).isDirectory()) {
    throw new ArchitectureConfluenceError(`Repository root does not exist: ${repositoryRoot}`);
  }

  const config = resolveConfig(options.config);
  const sourceFiles = readSourceFiles(repositoryRoot, config.sourceRoot);
  const sourceByPath = new Map(sourceFiles.map(file => [file.path, file]));
  const findings: ArchitectureConfluenceFindingV1[] = [];
  const missingEntrypoints: string[] = [];

  for (const entrypoint of uniqueSorted([
    ...config.productionEntrypoints,
    ...config.publicExportEntrypoints,
  ])) {
    if (sourceByPath.has(entrypoint)) continue;
    missingEntrypoints.push(entrypoint);
    findings.push(
      finding(
        'missing-entrypoint',
        'scan',
        entrypoint,
        1,
        entrypoint,
        `Configured architecture entrypoint does not exist: ${entrypoint}`
      )
    );
  }

  const reachableFiles = collectReachableFiles(
    repositoryRoot,
    config.productionEntrypoints,
    sourceByPath
  );
  const importRecords = collectImportRecords(repositoryRoot, reachableFiles, sourceByPath);
  findings.push(...findForbiddenImports(importRecords, config));
  findings.push(...findForbiddenExports(sourceByPath, config));
  findings.push(...findForbiddenSingletons(sourceFiles, config));

  const tarball = scanTarballIntent(repositoryRoot, sourceFiles, config, findings);
  const sortedPreOwnershipFindings = sortFindings(findings);
  const owners = scanOwners(sourceFiles, reachableFiles, config, sortedPreOwnershipFindings);

  for (const owner of owners.filter(candidate => candidate.status === 'fail')) {
    findings.push(
      finding(
        `ownership:${owner.kind}`,
        'ownership',
        owner.expectedFile,
        owner.declarations[0]?.line ?? 1,
        owner.expectedSymbol,
        owner.reason
      )
    );
  }

  const resourceScope = await runResourceScopeChurnV1(config.scopeCycles);
  if (resourceScope.status === 'fail') {
    findings.push(
      finding(
        'resource-scope-churn',
        'resource_scope',
        'src/runtime/resource-scope.ts',
        1,
        `${resourceScope.cycles} cycles`,
        'ResourceScope churn left a leak, teardown error, timeout, or LIFO violation.'
      )
    );
  }

  const sortedFindings = deepFreeze(sortFindings(findings));
  const counts = countFindings(sortedFindings);
  const checks = buildChecks(owners, counts, resourceScope);
  const decision: ArchitectureConfluenceDecisionV1 = checks.every(check => check.status === 'pass')
    ? 'GO'
    : 'NO_GO';
  const scan = buildSourceScan(
    config,
    sourceFiles,
    reachableFiles,
    uniqueSorted(missingEntrypoints)
  );
  const generatedAt = options.clock?.() ?? Date.now();
  if (!Number.isFinite(generatedAt) || generatedAt < 0) {
    throw new ArchitectureConfluenceError(
      'Receipt clock must return a finite non-negative number.'
    );
  }

  const unsigned = {
    version: ARCHITECTURE_CONFLUENCE_RECEIPT_VERSION,
    generatedAt,
    repositoryRoot,
    strict: config.strict,
    configurationDigest: digestRuntimeValue(config),
    scan,
    owners,
    tarball,
    resourceScope,
    counts,
    findings: sortedFindings,
    checks,
    decision,
  } as const;
  return deepFreeze({ ...unsigned, digest: digestRuntimeValue(unsigned) });
}

/** Verify the receipt digest and every derived decision/count field. */
export function verifyArchitectureConfluenceReceiptV1(
  receipt: ArchitectureConfluenceReceiptV1
): ArchitectureConfluenceReceiptV1 {
  if (receipt.version !== ARCHITECTURE_CONFLUENCE_RECEIPT_VERSION) {
    throw new ArchitectureConfluenceError(`Unsupported receipt version: ${receipt.version}`);
  }
  const { digest, ...unsigned } = receipt;
  if (digestRuntimeValue(unsigned) !== digest) {
    throw new ArchitectureConfluenceError('Architecture confluence receipt digest mismatch.');
  }
  const expectedCounts = countFindings(receipt.findings);
  if (canonicalRuntimeJson(expectedCounts) !== canonicalRuntimeJson(receipt.counts)) {
    throw new ArchitectureConfluenceError('Architecture confluence receipt counts mismatch.');
  }
  const expectedDecision = receipt.checks.every(check => check.status === 'pass') ? 'GO' : 'NO_GO';
  if (expectedDecision !== receipt.decision) {
    throw new ArchitectureConfluenceError('Architecture confluence receipt decision mismatch.');
  }
  return receipt;
}

/**
 * Prove bounded teardown under two different activation histories. Each cycle owns a fresh scope,
 * two fake resources and one lease; closing must converge to the same empty state in LIFO order.
 */
export async function runResourceScopeChurnV1(
  cycles = DEFAULT_RESOURCE_SCOPE_CHURN_CYCLES
): Promise<ResourceScopeChurnEvidenceV1> {
  if (!Number.isSafeInteger(cycles) || cycles <= 0) {
    throw new ArchitectureConfluenceError('ResourceScope churn cycles must be a positive integer.');
  }

  let resourcesActivated = 0;
  let resourcesDisposed = 0;
  let leasesAcquired = 0;
  let leasesReleased = 0;
  let leakedResources = 0;
  let leakedLeases = 0;
  let lifoViolations = 0;
  let closeErrors = 0;
  let timedOutCloses = 0;
  const finalStateDigests = new Set<string>();

  for (let cycle = 0; cycle < cycles; cycle++) {
    const scope = new ResourceScope({ id: `harness-confluence-${cycle}`, deadlineMs: 250 });
    const activationOrder = cycle % 2 === 0 ? ['catalog', 'transport'] : ['transport', 'catalog'];
    const disposalOrder: string[] = [];

    for (const resourceId of activationOrder) {
      scope.register(resourceId, () => {
        resourcesDisposed++;
        disposalOrder.push(resourceId);
      });
      resourcesActivated++;
    }

    const lease = scope.acquireLease(`cycle-${cycle}`);
    leasesAcquired++;
    lease.release();
    leasesReleased++;
    const report = await scope.close({ reason: 'confluence_churn', deadlineMs: 250 });
    const expectedDisposalOrder = [...activationOrder].reverse();

    if (canonicalRuntimeJson(disposalOrder) !== canonicalRuntimeJson(expectedDisposalOrder)) {
      lifoViolations++;
    }
    if (report.errors.length > 0) closeErrors += report.errors.length;
    if (report.timedOut || report.leaseTimedOut) timedOutCloses++;
    leakedResources += scope.activeResourceCount;
    leakedLeases += scope.activeLeaseCount;
    finalStateDigests.add(
      digestRuntimeValue({
        state: scope.state,
        activeResourceCount: scope.activeResourceCount,
        activeLeaseCount: scope.activeLeaseCount,
        signalAborted: scope.signal.aborted,
      })
    );
  }

  const historyIndependent = finalStateDigests.size === 1;
  const status: ArchitectureConfluenceCheckStatusV1 =
    resourcesActivated === resourcesDisposed &&
    leasesAcquired === leasesReleased &&
    leakedResources === 0 &&
    leakedLeases === 0 &&
    lifoViolations === 0 &&
    closeErrors === 0 &&
    timedOutCloses === 0 &&
    historyIndependent
      ? 'pass'
      : 'fail';
  const unsigned = {
    cycles,
    resourcesActivated,
    resourcesDisposed,
    leasesAcquired,
    leasesReleased,
    leakedResources,
    leakedLeases,
    lifoViolations,
    closeErrors,
    timedOutCloses,
    historyIndependent,
    status,
  } as const;
  return deepFreeze({ ...unsigned, digest: digestRuntimeValue(unsigned) });
}

function resolveConfig(
  input: ArchitectureConfluenceConfigV1 = {}
): ResolvedArchitectureConfluenceConfigV1 {
  const strict = input.strict ?? true;
  const scopeCycles = input.scopeCycles ?? DEFAULT_RESOURCE_SCOPE_CHURN_CYCLES;
  if (!Number.isSafeInteger(scopeCycles) || scopeCycles <= 0) {
    throw new ArchitectureConfluenceError('scopeCycles must be a positive integer.');
  }
  if (strict && scopeCycles < DEFAULT_RESOURCE_SCOPE_CHURN_CYCLES) {
    throw new ArchitectureConfluenceError(
      `Strict mode requires at least ${DEFAULT_RESOURCE_SCOPE_CHURN_CYCLES} ResourceScope cycles.`
    );
  }

  const rules = input.rules ?? {};
  const resolved: ResolvedArchitectureConfluenceConfigV1 = {
    strict,
    sourceRoot: normalizeRepositoryPath(input.sourceRoot ?? 'src'),
    productionEntrypoints: normalizePathList(
      input.productionEntrypoints ?? ['src/cli.ts', 'src/index.ts']
    ),
    publicExportEntrypoints: normalizePathList(input.publicExportEntrypoints ?? ['src/index.ts']),
    scopeCycles,
    rules: {
      forbiddenImports: cloneArray(rules.forbiddenImports ?? DEFAULT_RULES.forbiddenImports),
      forbiddenExportSymbols: uniqueSorted(
        rules.forbiddenExportSymbols ?? DEFAULT_RULES.forbiddenExportSymbols
      ),
      forbiddenSingletons: cloneArray(
        rules.forbiddenSingletons ?? DEFAULT_RULES.forbiddenSingletons
      ),
      forbiddenTarballSourcePatterns: uniqueSorted(
        rules.forbiddenTarballSourcePatterns ?? DEFAULT_RULES.forbiddenTarballSourcePatterns
      ),
      requiredOwners: cloneArray(rules.requiredOwners ?? DEFAULT_RULES.requiredOwners),
    },
    allow: {
      imports: uniqueSorted(input.allow?.imports ?? []),
      exports: uniqueSorted(input.allow?.exports ?? []),
      singletons: uniqueSorted(input.allow?.singletons ?? []),
      tarballEntries: uniqueSorted(input.allow?.tarballEntries ?? []),
    },
  };
  validateResolvedConfig(resolved);
  return deepFreeze(resolved);
}

function validateResolvedConfig(config: ResolvedArchitectureConfluenceConfigV1): void {
  const ruleIds = [
    ...config.rules.forbiddenImports.map(rule => rule.id),
    ...config.rules.forbiddenSingletons.map(rule => rule.id),
  ];
  if (new Set(ruleIds).size !== ruleIds.length) {
    throw new ArchitectureConfluenceError('Architecture rule ids must be unique.');
  }
  for (const rule of config.rules.forbiddenSingletons) {
    try {
      new RegExp(rule.pattern, 'm');
    } catch (error) {
      throw new ArchitectureConfluenceError(
        `Invalid singleton rule ${rule.id}: ${errorMessage(error)}`
      );
    }
  }
  const ownerKinds = config.rules.requiredOwners.map(owner => owner.kind);
  if (new Set(ownerKinds).size !== ownerKinds.length) {
    throw new ArchitectureConfluenceError('Each architecture owner kind must be declared once.');
  }
}

function readSourceFiles(repositoryRoot: string, sourceRoot: string): readonly SourceFileV1[] {
  const absoluteSourceRoot = resolve(repositoryRoot, sourceRoot);
  if (!existsSync(absoluteSourceRoot) || !statSync(absoluteSourceRoot).isDirectory()) {
    throw new ArchitectureConfluenceError(`Source root does not exist: ${sourceRoot}`);
  }
  const files: SourceFileV1[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
        files.push({
          path: toRepositoryPath(repositoryRoot, absolute),
          content: readFileSync(absolute, 'utf8'),
        });
      }
    }
  };
  visit(absoluteSourceRoot);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function collectReachableFiles(
  repositoryRoot: string,
  entrypoints: readonly string[],
  sourceByPath: ReadonlyMap<string, SourceFileV1>
): readonly string[] {
  const reachable = new Set<string>();
  const queue = [...entrypoints.filter(entrypoint => sourceByPath.has(entrypoint))];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || reachable.has(current)) continue;
    reachable.add(current);
    const source = sourceByPath.get(current);
    if (!source) continue;
    for (const record of extractImportRecords(repositoryRoot, source)) {
      if (record.target && sourceByPath.has(record.target) && !reachable.has(record.target)) {
        queue.push(record.target);
      }
    }
  }
  return uniqueSorted(reachable);
}

function collectImportRecords(
  repositoryRoot: string,
  reachableFiles: readonly string[],
  sourceByPath: ReadonlyMap<string, SourceFileV1>
): readonly ImportRecordV1[] {
  return reachableFiles.flatMap(file => {
    const source = sourceByPath.get(file);
    return source ? extractImportRecords(repositoryRoot, source) : [];
  });
}

function extractImportRecords(repositoryRoot: string, source: SourceFileV1): ImportRecordV1[] {
  const records: ImportRecordV1[] = [];
  const expressions: Array<{
    readonly expression: RegExp;
    readonly specifierGroup: number;
    readonly typeOnlyGroup?: number;
  }> = [
    {
      expression: /\b(?:import|export)\s+(type\s+)?[^;'"`]*?\s+from\s*['"]([^'"]+)['"]/g,
      specifierGroup: 2,
      typeOnlyGroup: 1,
    },
    { expression: /\bimport\s*['"]([^'"]+)['"]/g, specifierGroup: 1 },
    { expression: /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, specifierGroup: 1 },
    { expression: /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, specifierGroup: 1 },
  ];
  const seen = new Set<string>();
  for (const parser of expressions) {
    for (const match of source.content.matchAll(parser.expression)) {
      const specifier = match[parser.specifierGroup];
      const index = (match.index ?? 0) + match[0].lastIndexOf(specifier);
      const key = `${index}:${specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({
        file: source.path,
        line: lineNumberAt(source.content, index),
        specifier,
        typeOnly: parser.typeOnlyGroup !== undefined && match[parser.typeOnlyGroup] !== undefined,
        target: resolveTypeScriptImport(repositoryRoot, source.path, specifier),
      });
    }
  }
  return records.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line
  );
}

function resolveTypeScriptImport(
  repositoryRoot: string,
  importer: string,
  specifier: string
): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(repositoryRoot, dirname(importer), specifier);
  const candidates = /\.(?:ts|tsx|js)$/.test(base)
    ? [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')]
    : [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), resolve(base, 'index.tsx')];
  const target = candidates.find(
    candidate => existsSync(candidate) && statSync(candidate).isFile()
  );
  return target ? toRepositoryPath(repositoryRoot, target) : undefined;
}

function findForbiddenImports(
  records: readonly ImportRecordV1[],
  config: ResolvedArchitectureConfluenceConfigV1
): readonly ArchitectureConfluenceFindingV1[] {
  const findings: ArchitectureConfluenceFindingV1[] = [];
  for (const record of records) {
    if (!record.target || record.typeOnly) continue;
    for (const rule of config.rules.forbiddenImports) {
      if (!rule.targetPatterns.some(pattern => matchesPathPattern(record.target!, pattern)))
        continue;
      if (rule.allowedFiles?.some(pattern => matchesPathPattern(record.file, pattern))) continue;
      const keys = [
        record.file,
        `${rule.id}:${record.file}`,
        `${rule.id}:${record.file}:${record.target}`,
      ];
      if (keys.some(key => config.allow.imports.includes(key))) continue;
      findings.push(
        finding(
          rule.id,
          'import',
          record.file,
          record.line,
          record.specifier,
          `${rule.description} Resolved target: ${record.target}.`
        )
      );
    }
  }
  return findings;
}

function findForbiddenExports(
  sourceByPath: ReadonlyMap<string, SourceFileV1>,
  config: ResolvedArchitectureConfluenceConfigV1
): readonly ArchitectureConfluenceFindingV1[] {
  const findings: ArchitectureConfluenceFindingV1[] = [];
  for (const path of config.publicExportEntrypoints) {
    const source = sourceByPath.get(path);
    if (!source) continue;
    const exported = extractExports(source.content);
    for (const symbol of config.rules.forbiddenExportSymbols) {
      const match = exported.find(candidate => candidate.symbol === symbol);
      if (!match) continue;
      if (
        config.allow.exports.includes(symbol) ||
        config.allow.exports.includes(`${path}:${symbol}`)
      ) {
        continue;
      }
      findings.push(
        finding(
          `forbidden-export:${symbol}`,
          'export',
          path,
          match.line,
          symbol,
          `Legacy symbol ${symbol} remains reachable from a public export entrypoint.`
        )
      );
    }
  }
  return findings;
}

function extractExports(content: string): readonly { symbol: string; line: number }[] {
  const exports: Array<{ symbol: string; line: number }> = [];
  const blocks = /\bexport\s+(?:type\s+)?\{([\s\S]*?)\}(?:\s+from\s*['"][^'"]+['"])?/g;
  for (const block of content.matchAll(blocks)) {
    const body = block[1];
    const bodyOffset = (block.index ?? 0) + block[0].indexOf(body);
    for (const rawPart of body.split(',')) {
      const part = rawPart.trim();
      if (!part) continue;
      const names = part.split(/\s+as\s+/).map(name => name.trim());
      const symbol = names[names.length - 1];
      const localOffset = body.indexOf(rawPart) + rawPart.indexOf(symbol);
      exports.push({ symbol, line: lineNumberAt(content, bodyOffset + localOffset) });
    }
  }
  const declarations =
    /\bexport\s+(?:default\s+)?(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const declaration of content.matchAll(declarations)) {
    exports.push({
      symbol: declaration[1],
      line: lineNumberAt(
        content,
        (declaration.index ?? 0) + declaration[0].lastIndexOf(declaration[1])
      ),
    });
  }
  return exports;
}

function findForbiddenSingletons(
  sourceFiles: readonly SourceFileV1[],
  config: ResolvedArchitectureConfluenceConfigV1
): readonly ArchitectureConfluenceFindingV1[] {
  const findings: ArchitectureConfluenceFindingV1[] = [];
  for (const source of sourceFiles) {
    for (const rule of config.rules.forbiddenSingletons) {
      if (rule.allowedFiles?.some(pattern => matchesPathPattern(source.path, pattern))) continue;
      const match = new RegExp(rule.pattern, 'm').exec(source.content);
      if (!match) continue;
      const keys = [source.path, `${rule.id}:${source.path}`];
      if (keys.some(key => config.allow.singletons.includes(key))) continue;
      findings.push(
        finding(
          rule.id,
          'singleton',
          source.path,
          lineNumberAt(source.content, match.index),
          match[0],
          rule.description
        )
      );
    }
  }
  return findings;
}

function scanTarballIntent(
  repositoryRoot: string,
  sourceFiles: readonly SourceFileV1[],
  config: ResolvedArchitectureConfluenceConfigV1,
  findings: ArchitectureConfluenceFindingV1[]
): ArchitectureConfluenceTarballIntentV1 {
  const packageJson = readJsonObject(repositoryRoot, 'package.json', findings);
  const tsconfig = readJsonObject(repositoryRoot, 'tsconfig.json', findings);
  const packageFiles = toStringArray(packageJson?.files);
  const compilerIncludes = toStringArray(tsconfig?.include);
  const compilerExcludes = toStringArray(tsconfig?.exclude);
  const main = typeof packageJson?.main === 'string' ? packageJson.main : '';
  const distIncluded =
    packageFiles.length === 0
      ? main.startsWith('dist/')
      : packageFiles.some(pattern => /^(?:\.\/)?dist(?:\/|\/\*\*?|$)/.test(pattern));
  const isCompiledSource = (source: SourceFileV1): boolean =>
    compilerIncludes.some(pattern =>
      matchesPathPattern(source.path, normalizeRepositoryPath(pattern))
    ) &&
    !compilerExcludes.some(pattern =>
      matchesPathPattern(source.path, normalizeRepositoryPath(pattern))
    );
  const sourceCompilationEnabled = sourceFiles.some(isCompiledSource);
  const forbiddenEntries =
    distIncluded && sourceCompilationEnabled
      ? uniqueSorted(
          sourceFiles
            .filter(isCompiledSource)
            .filter(source =>
              config.rules.forbiddenTarballSourcePatterns.some(pattern =>
                matchesPathPattern(source.path, pattern)
              )
            )
            .map(source => source.path.replace(/^src\//, 'dist/').replace(/\.tsx?$/, '.js'))
            .filter(entry => !config.allow.tarballEntries.includes(entry))
        )
      : [];
  for (const entry of forbiddenEntries) {
    findings.push(
      finding(
        'legacy-tarball-entry',
        'tarball',
        'package.json',
        1,
        entry,
        `Build/package intent includes forbidden legacy entry ${entry}.`
      )
    );
  }
  const unsigned = {
    packageFiles: uniqueSorted(packageFiles),
    compilerIncludes: uniqueSorted(compilerIncludes),
    compilerExcludes: uniqueSorted(compilerExcludes),
    distIncluded,
    sourceCompilationEnabled,
    forbiddenEntries,
  } as const;
  return deepFreeze({ ...unsigned, digest: digestRuntimeValue(unsigned) });
}

function readJsonObject(
  repositoryRoot: string,
  path: string,
  findings: ArchitectureConfluenceFindingV1[]
): Record<string, unknown> | undefined {
  const absolute = resolve(repositoryRoot, path);
  try {
    const value: unknown = JSON.parse(readFileSync(absolute, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch (error) {
    findings.push(
      finding(
        'invalid-package-intent',
        'scan',
        path,
        1,
        path,
        `Unable to read architecture package intent: ${errorMessage(error)}`
      )
    );
    return undefined;
  }
}

function scanOwners(
  sourceFiles: readonly SourceFileV1[],
  reachableFiles: readonly string[],
  config: ResolvedArchitectureConfluenceConfigV1,
  findings: readonly ArchitectureConfluenceFindingV1[]
): readonly ArchitectureConfluenceOwnerEvidenceV1[] {
  const reachable = new Set(reachableFiles);
  return deepFreeze(
    config.rules.requiredOwners.map(owner => {
      const expression = new RegExp(
        `^\\s*export\\s+(?:abstract\\s+)?(?:class|interface|function|const|type)\\s+${escapeRegExp(
          owner.symbol
        )}\\b`,
        'gm'
      );
      const declarations = sourceFiles.flatMap(source =>
        [...source.content.matchAll(expression)].map(match => ({
          file: source.path,
          line: lineNumberAt(source.content, match.index ?? 0),
        }))
      );
      const referenceExpression = new RegExp(`\\b${escapeRegExp(owner.symbol)}\\b`, 'g');
      const productionReferences = sourceFiles
        .filter(source => reachable.has(source.path) && source.path !== owner.file)
        .flatMap(source => {
          const match = referenceExpression.exec(source.content);
          referenceExpression.lastIndex = 0;
          return match
            ? [{ file: source.path, line: lineNumberAt(source.content, match.index) }]
            : [];
        });
      const competingFindingRuleIds = uniqueSorted(
        findings
          .filter(candidate => owner.competingFindingRuleIds.includes(candidate.ruleId))
          .map(candidate => candidate.ruleId)
      );
      const declarationIsUnique = declarations.length === 1 && declarations[0].file === owner.file;
      const isProductionOwned = productionReferences.length > 0;
      const status: ArchitectureConfluenceCheckStatusV1 =
        declarationIsUnique && isProductionOwned && competingFindingRuleIds.length === 0
          ? 'pass'
          : 'fail';
      const reasons: string[] = [];
      if (!declarationIsUnique) {
        reasons.push(
          `expected exactly one ${owner.symbol} declaration at ${owner.file}, observed ${declarations.length}`
        );
      }
      if (!isProductionOwned)
        reasons.push('owner is not referenced by the production entrypoint graph');
      if (competingFindingRuleIds.length > 0) {
        reasons.push(`competing paths remain: ${competingFindingRuleIds.join(', ')}`);
      }
      return deepFreeze({
        kind: owner.kind,
        expectedSymbol: owner.symbol,
        expectedFile: owner.file,
        declarations,
        productionReferences,
        competingFindingRuleIds,
        status,
        reason: reasons.length > 0 ? reasons.join('; ') : 'single production owner confirmed',
      });
    })
  );
}

function buildSourceScan(
  config: ResolvedArchitectureConfluenceConfigV1,
  sourceFiles: readonly SourceFileV1[],
  reachableFiles: readonly string[],
  missingEntrypoints: readonly string[]
): ArchitectureConfluenceSourceScanV1 {
  const fileDigests = sourceFiles.map(source => ({
    file: source.path,
    digest: digestRuntimeValue(source.content),
  }));
  return deepFreeze({
    sourceRoot: config.sourceRoot,
    productionEntrypoints: config.productionEntrypoints,
    publicExportEntrypoints: config.publicExportEntrypoints,
    allSourceFiles: sourceFiles.map(source => source.path),
    reachableProductionFiles: reachableFiles,
    missingEntrypoints,
    sourceDigest: digestRuntimeValue(fileDigests),
  });
}

function buildChecks(
  owners: readonly ArchitectureConfluenceOwnerEvidenceV1[],
  counts: ArchitectureConfluenceCountsV1,
  resourceScope: ResourceScopeChurnEvidenceV1
): readonly ArchitectureConfluenceCheckV1[] {
  const checks: ArchitectureConfluenceCheckV1[] = owners.map(owner => ({
    id: `ownership.${owner.kind}`,
    category: 'ownership',
    status: owner.status,
    expected: `one production ${owner.expectedSymbol} owner and no competitor`,
    observed: owner.reason,
  }));
  checks.push(
    countCheck('legacy.imports', 'import', counts.forbiddenImports),
    countCheck('legacy.exports', 'export', counts.forbiddenExports),
    countCheck('global.singletons', 'singleton', counts.forbiddenSingletons),
    countCheck('legacy.tarball_entries', 'tarball', counts.forbiddenTarballEntries),
    countCheck('scan.integrity', 'scan', counts.scanErrors),
    {
      id: 'resource_scope.churn',
      category: 'resource_scope',
      status: resourceScope.status,
      expected: `${resourceScope.cycles} cycles, zero leaks/errors/timeouts/LIFO violations`,
      observed: `${resourceScope.leakedResources} resource leaks, ${resourceScope.leakedLeases} lease leaks, ${resourceScope.closeErrors} close errors, ${resourceScope.lifoViolations} LIFO violations`,
    }
  );
  return deepFreeze(checks);
}

function countCheck(
  id: string,
  category: ArchitectureConfluenceFindingCategoryV1,
  count: number
): ArchitectureConfluenceCheckV1 {
  return {
    id,
    category,
    status: count === 0 ? 'pass' : 'fail',
    expected: '0 violations',
    observed: `${count} violations`,
  };
}

function countFindings(
  findings: readonly ArchitectureConfluenceFindingV1[]
): ArchitectureConfluenceCountsV1 {
  return deepFreeze({
    findings: findings.length,
    forbiddenImports: findings.filter(candidate => candidate.category === 'import').length,
    forbiddenExports: findings.filter(candidate => candidate.category === 'export').length,
    forbiddenSingletons: findings.filter(candidate => candidate.category === 'singleton').length,
    forbiddenTarballEntries: findings.filter(candidate => candidate.category === 'tarball').length,
    scanErrors: findings.filter(candidate => candidate.category === 'scan').length,
  });
}

function finding(
  ruleId: string,
  category: ArchitectureConfluenceFindingCategoryV1,
  file: string,
  line: number,
  match: string,
  message: string
): ArchitectureConfluenceFindingV1 {
  return deepFreeze({
    ruleId,
    category,
    severity: 'error' as const,
    file: normalizeRepositoryPath(file),
    line: Math.max(1, line),
    match: compactMatch(match),
    message,
  });
}

function sortFindings(
  findings: readonly ArchitectureConfluenceFindingV1[]
): ArchitectureConfluenceFindingV1[] {
  const unique = new Map<string, ArchitectureConfluenceFindingV1>();
  for (const candidate of findings) {
    const key = `${candidate.ruleId}:${candidate.file}:${candidate.line}:${candidate.match}`;
    unique.set(key, candidate);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.category.localeCompare(right.category) ||
      left.ruleId.localeCompare(right.ruleId) ||
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.match.localeCompare(right.match)
  );
}

function cloneRules(rules: ArchitectureConfluenceRulesV1): ArchitectureConfluenceRulesV1 {
  return {
    forbiddenImports: cloneArray(rules.forbiddenImports),
    forbiddenExportSymbols: [...rules.forbiddenExportSymbols],
    forbiddenSingletons: cloneArray(rules.forbiddenSingletons),
    forbiddenTarballSourcePatterns: [...rules.forbiddenTarballSourcePatterns],
    requiredOwners: cloneArray(rules.requiredOwners),
  };
}

function cloneArray<T>(values: readonly T[]): readonly T[] {
  return values.map(value => (value && typeof value === 'object' ? ({ ...value } as T) : value));
}

function normalizePathList(paths: readonly string[]): readonly string[] {
  return uniqueSorted(paths.map(normalizeRepositoryPath));
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function toRepositoryPath(repositoryRoot: string, absolutePath: string): string {
  return normalizeRepositoryPath(relative(repositoryRoot, absolutePath));
}

function normalizeRepositoryPath(path: string): string {
  return path.split(sep).join('/').replace(/^\.\//, '').replace(/\/$/, '');
}

function matchesPathPattern(path: string, pattern: string): boolean {
  return globToRegExp(normalizeRepositoryPath(pattern)).test(normalizeRepositoryPath(path));
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index++;
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else {
      source += escapeRegExp(character);
    }
  }
  return new RegExp(`${source}$`);
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, Math.max(0, index)).split('\n').length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compactMatch(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
