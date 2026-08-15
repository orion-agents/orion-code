import { isAbsolute, join, relative, resolve, sep } from 'path';
import type {
  CapabilityProfile,
  CompletionGateResult,
  ContextLedgerEntry,
  DriftCheckResult,
  TaskContract,
} from './types';
import { normalizeTaskContract } from './contract';
import {
  criterionHasAuthorizedWaiver,
  isTrustedEvidence,
  requiredVerificationKinds,
  verificationKindForEntry,
} from './verification';

const PATH_ARGUMENT_KEYS = new Set([
  'cwd',
  'dir',
  'directory',
  'file',
  'file_path',
  'file_paths',
  'filePath',
  'filePaths',
  'new_path',
  'newPath',
  'old_path',
  'oldPath',
  'path',
  'paths',
  'source_path',
  'sourcePath',
  'destination_path',
  'destinationPath',
  'workdir',
  'working_directory',
  'workingDirectory',
]);
const WORKING_DIRECTORY_KEYS = new Set(['cwd', 'workdir', 'working_directory', 'workingDirectory']);
const COMMAND_ARGUMENT_KEYS = new Set(['cmd', 'command', 'commands']);

interface TypedArgument {
  key: string;
  value: string;
  base?: string;
}

interface ArgumentProjection {
  paths: TypedArgument[];
  workingDirectories: TypedArgument[];
  commands: TypedArgument[];
  malformed: string[];
}

interface DriftViolation {
  reason: string;
  correction: string;
}

function valuesForTypedArgument(key: string, value: unknown, malformed: string[]): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(item => typeof item === 'string' && item.trim())
  ) {
    return value.map(item => (item as string).trim());
  }
  malformed.push(key);
  return [];
}

/** Extract only explicitly path- and command-typed fields; arbitrary prompt text is not policy. */
function projectTypedArguments(args: Record<string, unknown>): ArgumentProjection {
  const projection: ArgumentProjection = {
    paths: [],
    workingDirectories: [],
    commands: [],
    malformed: [],
  };
  const seen = new WeakSet<object>();
  let visited = 0;

  const visit = (value: unknown, depth: number, inheritedBase?: string): void => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    if (depth > 8 || ++visited > 1_000) {
      throw new Error('tool arguments exceed the drift validation complexity limit');
    }
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, inheritedBase);
      return;
    }

    const entries = Object.entries(value);
    let localBase = inheritedBase;
    for (const [key, item] of entries) {
      if (!WORKING_DIRECTORY_KEYS.has(key)) continue;
      const projected = valuesForTypedArgument(key, item, projection.malformed).map(path => ({
        key,
        value: path,
        base: inheritedBase,
      }));
      projection.paths.push(...projected);
      projection.workingDirectories.push(...projected);
      if (projected[0]) localBase = combineWorkingDirectory(inheritedBase, projected[0].value);
    }

    for (const [key, item] of entries) {
      if (WORKING_DIRECTORY_KEYS.has(key)) continue;
      if (PATH_ARGUMENT_KEYS.has(key)) {
        const projected = valuesForTypedArgument(key, item, projection.malformed).map(path => ({
          key,
          value: path,
          base: localBase,
        }));
        projection.paths.push(...projected);
        continue;
      }
      if (COMMAND_ARGUMENT_KEYS.has(key)) {
        projection.commands.push(
          ...valuesForTypedArgument(key, item, projection.malformed).map(command => ({
            key,
            value: command,
          }))
        );
        continue;
      }
      visit(item, depth + 1, localBase);
    }
  };

  visit(args, 0);
  return projection;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function resolveFrom(base: string, value: string): string {
  return resolve(base, value);
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function combineWorkingDirectory(parent: string | undefined, child: string): string {
  if (isAbsolute(child) || !parent) return child;
  return isAbsolute(parent) ? resolve(parent, child) : join(parent, child);
}

function profileViolation(
  profile: CapabilityProfile | undefined,
  toolName: string
): DriftViolation | undefined {
  if (!profile) return;
  if (!profile.model.toolCalling) {
    return {
      reason: `Capability profile v${profile.revision} does not permit tool calling.`,
      correction: 'Refresh the model capability profile before scheduling a tool call.',
    };
  }
  if (!profile.tools.includes(toolName)) {
    return {
      reason: `Tool ${toolName} is absent from capability profile v${profile.revision}.`,
      correction: 'Use a tool listed in the active capability profile or refresh the profile.',
    };
  }
  return;
}

function allowedScopeViolation(
  contract: TaskContract | undefined,
  profile: CapabilityProfile | undefined,
  projection: ArgumentProjection
): DriftViolation | undefined {
  if (!contract) return;
  if (!contract.allowedScope.cwd?.trim()) {
    return {
      reason: 'TaskContract allowedScope.cwd is missing.',
      correction: 'Repair the TaskContract project scope before using tools.',
    };
  }
  const root = resolve(contract.allowedScope.cwd);
  if (profile && resolve(profile.projectRoot) !== root) {
    return {
      reason: `Capability project root does not match TaskContract allowedScope.cwd (${contract.allowedScope.cwd}).`,
      correction: 'Refresh the capability profile for the active project before using tools.',
    };
  }
  if (projection.malformed.length > 0) {
    return {
      reason: `Cannot validate malformed typed tool argument(s): ${[...new Set(projection.malformed)].join(', ')}.`,
      correction: 'Provide non-empty string path and command arguments.',
    };
  }

  const workingDirectories = projection.workingDirectories.map(item => {
    const parentBase = item.base ? resolveFrom(root, item.base) : root;
    return { ...item, resolved: resolveFrom(parentBase, item.value) };
  });
  const escapedWorkingDirectory = workingDirectories.find(
    item => !isContained(root, item.resolved)
  );
  if (escapedWorkingDirectory) {
    return {
      reason: `Tool working directory ${escapedWorkingDirectory.value} is outside allowedScope.cwd.`,
      correction: `Keep the tool working directory within ${contract.allowedScope.cwd}.`,
    };
  }
  if (contract.allowedScope.files?.some(file => typeof file !== 'string' || !file.trim())) {
    return {
      reason: 'TaskContract allowedScope.files contains an invalid path.',
      correction: 'Repair the TaskContract file scope before using path-based tools.',
    };
  }
  const allowedFiles = contract.allowedScope.files?.map(file => resolveFrom(root, file));
  const invalidAllowedFile = allowedFiles?.find(file => !isContained(root, file));
  if (invalidAllowedFile) {
    return {
      reason: 'TaskContract allowedScope.files contains a path outside allowedScope.cwd.',
      correction: 'Repair the TaskContract file scope before using path-based tools.',
    };
  }

  for (const item of projection.paths) {
    const base = item.base ? resolveFrom(root, item.base) : root;
    const candidate = resolveFrom(base, item.value);
    if (!isContained(root, candidate)) {
      return {
        reason: `Tool path ${item.value} is outside TaskContract allowedScope.cwd.`,
        correction: `Keep file operations within ${contract.allowedScope.cwd}.`,
      };
    }
    if (
      !WORKING_DIRECTORY_KEYS.has(item.key) &&
      allowedFiles !== undefined &&
      !allowedFiles.some(file => isContained(file, candidate))
    ) {
      return {
        reason: `Tool path ${item.value} is not listed by TaskContract allowedScope.files.`,
        correction: 'Use a file path inside the explicitly allowed file scope.',
      };
    }
  }

  if (contract.allowedScope.commands !== undefined) {
    if (
      contract.allowedScope.commands.some(command => typeof command !== 'string' || !command.trim())
    ) {
      return {
        reason: 'TaskContract allowedScope.commands contains an invalid command.',
        correction: 'Repair the TaskContract command scope before using command tools.',
      };
    }
    const allowedCommands = new Set(contract.allowedScope.commands.map(normalizeCommand));
    const denied = projection.commands.find(
      item => !allowedCommands.has(normalizeCommand(item.value))
    );
    if (denied) {
      return {
        reason: `Tool command ${denied.value} is not listed by TaskContract allowedScope.commands.`,
        correction:
          'Use an explicitly allowed command or update the TaskContract with user authority.',
      };
    }
  }
  return;
}

function driftResult(mode: 'warn' | 'block', violation: DriftViolation): DriftCheckResult {
  return {
    status: mode === 'block' ? 'block' : 'warn',
    reason: violation.reason,
    correction: violation.correction,
  };
}

function hasExplicitVerificationNeed(contract: TaskContract | undefined): boolean {
  if (!contract) return false;
  const lines = [...contract.requirements, ...contract.successCriteria];

  return lines.some(line => {
    const normalized = line.trim().toLowerCase();

    // A one-word smoke input such as `test` is ambiguous: it may be checking
    // that the CLI responds at all, and must not lock the session behind a
    // verification gate. Require an object, command, or obligation below.
    if (/^(?:test|verify|validate|check|build|lint)[.!?]?$/u.test(normalized)) return false;
    if (/^(?:测试|验证|检查|构建|编译)[。！!？?]?$/u.test(line.trim())) return false;

    // A noun such as "markdown render test" can describe a fixture or feature.
    // Only make verification a completion gate when the contract also contains
    // an explicit action, obligation, or passing criterion.
    const englishAction =
      /^(?:please\s+)?(?:run|execute|verify|validate|check|build|lint|test)\b/.test(normalized) ||
      /\b(?:must|should|need(?:s)?\s+to|required\s+to|require[sd]?|ensure|please)\b.{0,80}\b(?:tests?|jest|vitest|tsc|lint|build|verify|verification|validate|check)\b/.test(
        normalized
      ) ||
      /\b(?:tests?|jest|vitest|tsc|lint|build|verification)\b.{0,80}\b(?:must|should|required|pass(?:ed|ing)?|succeed(?:ed|ing)?|green)\b/.test(
        normalized
      );
    const chineseAction =
      /(?:必须|需要|要求|确保|请|运行|执行).{0,40}(?:测试|验证|构建|检查)/.test(line) ||
      /(?:测试|验证|构建|检查).{0,40}(?:必须|需要|要求|确保|通过|成功|运行|执行)/.test(line) ||
      /(?:并|且|同时|完成后).{0,12}(?:测试|验证|构建|检查)/.test(line);

    return englishAction || chineseAction;
  });
}

export function checkToolDrift(params: {
  contract?: TaskContract;
  capabilityProfile?: CapabilityProfile;
  toolName: string;
  args: Record<string, unknown>;
  mode: 'off' | 'warn' | 'block';
}): DriftCheckResult {
  if (params.mode === 'off') return { status: 'ok' };

  try {
    if (params.mode === 'block' && !params.capabilityProfile) {
      return driftResult(params.mode, {
        reason: 'Capability profile is unavailable, so this tool call cannot be validated.',
        correction: 'Create or refresh the active capability profile before using tools.',
      });
    }
    const capabilityMismatch = profileViolation(params.capabilityProfile, params.toolName);
    if (capabilityMismatch) return driftResult(params.mode, capabilityMismatch);

    const projection = projectTypedArguments(params.args);
    const scopeMismatch = allowedScopeViolation(
      params.contract,
      params.capabilityProfile,
      projection
    );
    if (scopeMismatch) return driftResult(params.mode, scopeMismatch);

    if (params.contract) {
      const argsText = JSON.stringify(params.args).toLowerCase();
      const prohibitionHit = params.contract.prohibitions.find(item => {
        const normalized = item.toLowerCase();
        return normalized && argsText.includes(normalized);
      });
      if (prohibitionHit) {
        return driftResult(params.mode, {
          reason: `Tool arguments may violate prohibition: ${prohibitionHit}`,
          correction: 'Choose a safer tool call or explain why this action is required.',
        });
      }
    }

    return { status: 'ok' };
  } catch (error) {
    return driftResult(params.mode, {
      reason: `Drift guard could not validate this tool call: ${error instanceof Error ? error.message : String(error)}`,
      correction: 'Use simple typed path/command arguments or refresh the task capability state.',
    });
  }
}

export function evaluateCompletionGate(params: {
  contract?: TaskContract;
  ledger: ContextLedgerEntry[];
}): CompletionGateResult {
  const evidence: string[] = [];
  const missing: string[] = [];
  const byEvidenceRef = new Map<string, ContextLedgerEntry>();
  for (const entry of params.ledger) {
    byEvidenceRef.set(entry.id, entry);
    byEvidenceRef.set(`ledger:${entry.id}`, entry);
  }

  const contract = params.contract ? normalizeTaskContract(params.contract) : undefined;
  const criterionResults = (contract?.criteria ?? []).map(criterion => {
    const requiredKinds = requiredVerificationKinds(criterion.statement);
    const applicable = requiredKinds.length > 0;
    const linked = criterion.evidenceRefs
      .map(ref => ({ ref, entry: byEvidenceRef.get(ref) }))
      .filter(
        (item): item is { ref: string; entry: ContextLedgerEntry } => item.entry !== undefined
      );

    if (criterionHasAuthorizedWaiver(criterion)) {
      return {
        criterionId: criterion.id,
        statement: criterion.statement,
        status: 'waived' as const,
        applicable,
        evidenceRefs: linked.map(item => item.ref),
        requiredKinds,
        missingKinds: [],
        failedKinds: [],
      };
    }

    const trusted = linked.filter(item => isTrustedEvidence(item.entry));
    const passedKinds = new Set(
      trusted
        .filter(item => item.entry.metadata?.success === true)
        .map(item => verificationKindForEntry(item.entry))
    );
    const failedKinds = requiredKinds.filter(kind =>
      trusted.some(
        item =>
          item.entry.metadata?.success === false && verificationKindForEntry(item.entry) === kind
      )
    );
    const missingKinds = requiredKinds.filter(kind => !passedKinds.has(kind));
    const status = !applicable
      ? (criterion.status ?? 'pending')
      : missingKinds.length === 0
        ? 'passed'
        : failedKinds.length > 0
          ? 'failed'
          : 'pending';

    for (const item of trusted) {
      if (item.entry.metadata?.success === true && !evidence.includes(item.entry.content)) {
        evidence.push(item.entry.content);
      }
    }

    return {
      criterionId: criterion.id,
      statement: criterion.statement,
      status,
      applicable,
      evidenceRefs: linked.map(item => item.ref),
      requiredKinds,
      missingKinds,
      failedKinds,
    };
  });

  const unsatisfied = criterionResults.filter(
    result => result.applicable && result.status !== 'passed' && result.status !== 'waived'
  );
  if (
    unsatisfied.length > 0 ||
    (criterionResults.length === 0 && hasExplicitVerificationNeed(contract))
  ) {
    missing.push('Required verification has not passed yet.');
  }

  return {
    canComplete: missing.length === 0,
    missing,
    evidence,
    criterionResults,
  };
}
