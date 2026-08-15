import { createHash, randomUUID } from 'crypto';
import type { IntentUpdate, TaskContract, TaskCriterion, TaskCriterionStatus } from './types';

function normalizeLine(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function cleanLine(line: string): string {
  return line.replace(/^[-*+\d.)\s]+/, '').trim();
}

function splitMeaningfulLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(line => line && !isSectionHeading(line));
}

function isSectionHeading(line: string): boolean {
  const normalized = line.replace(/^#{1,6}\s*/, '').trim();
  return normalized.length <= 32 && /^[^。.!?？；;，,、/:：]+[:：]$/.test(normalized);
}

function unique(items: string[]): string[] {
  return [...new Set(items.map(item => normalizeLine(item)).filter(Boolean))];
}

function isObjectiveFallback(item: string): boolean {
  return item.startsWith('Address the objective: ');
}

function stableCriterionId(statement: string): string {
  const digest = createHash('sha256').update(normalizeLine(statement).toLowerCase()).digest('hex');
  return `criterion:harness:${digest.slice(0, 16)}`;
}

function normalizeCriterionStatus(criterion: TaskCriterion): TaskCriterionStatus {
  if (
    criterion.status === 'waived' &&
    criterion.waiver?.authorizedBy === 'user' &&
    criterion.waiver.reason?.trim() &&
    Number.isFinite(criterion.waiver.at)
  ) {
    return 'waived';
  }
  return criterion.status === 'passed' || criterion.status === 'failed'
    ? criterion.status
    : 'pending';
}

function normalizeCriteria(
  statements: string[],
  existing: TaskContract['criteria']
): TaskCriterion[] {
  const byStatement = new Map<string, TaskCriterion>();
  for (const criterion of existing ?? []) {
    if (!criterion || typeof criterion.statement !== 'string') continue;
    const statement = normalizeLine(criterion.statement);
    if (!statement || byStatement.has(statement)) continue;
    byStatement.set(statement, {
      id:
        typeof criterion.id === 'string' && criterion.id.trim()
          ? criterion.id.trim()
          : stableCriterionId(statement),
      statement,
      evidenceRefs: unique(
        Array.isArray(criterion.evidenceRefs)
          ? criterion.evidenceRefs.filter(ref => typeof ref === 'string')
          : []
      ),
      source:
        criterion.source?.kind === 'user' ||
        criterion.source?.kind === 'derived' ||
        criterion.source?.kind === 'system'
          ? {
              kind: criterion.source.kind,
              ref:
                typeof criterion.source.ref === 'string' && criterion.source.ref.trim()
                  ? criterion.source.ref.trim()
                  : undefined,
            }
          : { kind: 'user' },
      scope:
        criterion.scope === 'project' || criterion.scope === 'release' ? criterion.scope : 'task',
      dependencies: unique(
        Array.isArray(criterion.dependencies)
          ? criterion.dependencies.filter(item => typeof item === 'string')
          : []
      ),
      status: normalizeCriterionStatus(criterion),
      waiver:
        criterion.waiver?.authorizedBy === 'user' &&
        criterion.waiver.reason?.trim() &&
        Number.isFinite(criterion.waiver.at)
          ? {
              authorizedBy: 'user',
              reason: normalizeLine(criterion.waiver.reason),
              at: criterion.waiver.at,
              sourceRef:
                typeof criterion.waiver.sourceRef === 'string' && criterion.waiver.sourceRef.trim()
                  ? criterion.waiver.sourceRef.trim()
                  : undefined,
            }
          : undefined,
    });
  }
  return statements.map(
    statement =>
      byStatement.get(statement) ?? {
        id: stableCriterionId(statement),
        statement,
        evidenceRefs: [],
        source: { kind: 'user' },
        scope: 'task',
        dependencies: [],
        status: 'pending',
      }
  );
}

export function extractExplicitObjective(input: string): string | undefined {
  const lines = input.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = cleanLine(lines[index]).replace(/^#{1,6}\s*/, '');
    const match = line.match(/^(?:目标|objective)\s*[:：]\s*(.*)$/i);
    if (!match) continue;
    if (match[1].trim()) return normalizeLine(match[1]);
    const objectiveLines: string[] = [];
    for (let next = index + 1; next < lines.length; next++) {
      const candidate = cleanLine(lines[next]);
      if (!candidate) continue;
      if (isSectionHeading(candidate)) break;
      if (
        objectiveLines.length > 0 &&
        /(必须|禁止|不得|要求|must|should|required|do not|never)/i.test(candidate)
      ) {
        break;
      }
      objectiveLines.push(candidate);
      if (objectiveLines.length >= 4) break;
    }
    if (objectiveLines.length > 0) return normalizeLine(objectiveLines.join(' '));
  }
  return undefined;
}

export function normalizeTaskContract(contract: TaskContract): TaskContract {
  const requirements = unique(
    (contract.requirements ?? []).filter(item => !isSectionHeading(item))
  );
  const typedCriterionStatements = (contract.criteria ?? [])
    .map(criterion => criterion?.statement)
    .filter((statement): statement is string => typeof statement === 'string');
  // `successCriteria` remains the compatibility projection and therefore the
  // authoritative statement list when present. Merging stale typed entries
  // back in can resurrect criteria that an older persisted state explicitly
  // removed. Typed-only callers are still supported when the legacy projection
  // is empty or absent; normalizeCriteria preserves ids/status/evidence for
  // statements that remain authoritative.
  const legacySuccessCriteria = contract.successCriteria ?? [];
  const inputSuccessCriteria =
    legacySuccessCriteria.length > 0 ? legacySuccessCriteria : typedCriterionStatements;
  const explicitSuccessCriteria = unique(
    inputSuccessCriteria.filter(item => !isSectionHeading(item) && !isObjectiveFallback(item))
  );
  const fallbackCriteria = unique(inputSuccessCriteria.filter(isObjectiveFallback));
  const successCriteria =
    explicitSuccessCriteria.length > 0 || requirements.length > 0
      ? explicitSuccessCriteria
      : fallbackCriteria.slice(0, 1);

  return {
    ...contract,
    version: 3,
    requirements,
    successCriteria,
    criteria: normalizeCriteria(successCriteria, contract.criteria),
    taskEpoch: Math.max(1, Math.floor(contract.taskEpoch ?? 1)),
    nonGoals: unique(contract.nonGoals ?? []),
    openQuestions: unique(contract.openQuestions ?? []),
  };
}

export function createTaskContract(input: string, cwd: string): TaskContract {
  const now = Date.now();
  const lines = splitMeaningfulLines(input);
  const objective =
    extractExplicitObjective(input) ??
    normalizeLine(lines[0] || input || 'Continue the current task');

  const requirementHints =
    /(must|should|required|require|need|ensure|verify|test|build|run|希望|需要|必须|要求|确保|验证|测试|完成)/i;
  const prohibitionHints = /(do not|don't|never|avoid|without|禁止|不要|不能|不准|避免)/i;
  const verificationHints = /(test|build|tsc|lint|verify|验证|测试|通过|运行|检查)/i;

  const requirements = unique(lines.filter(line => requirementHints.test(line)));
  const prohibitions = unique(lines.filter(line => prohibitionHints.test(line)));
  const successCriteria = unique([
    ...lines.filter(line => verificationHints.test(line)),
    requirements.length === 0 ? `Address the objective: ${objective}` : '',
  ]);

  return normalizeTaskContract({
    version: 3,
    id: randomUUID(),
    objective,
    userIntent: input.trim(),
    requirements,
    successCriteria,
    constraints: [],
    prohibitions,
    nonGoals: [],
    openQuestions: [],
    taskEpoch: 1,
    allowedScope: { cwd },
    createdAt: now,
    updatedAt: now,
  });
}

export function updateTaskContract(
  previous: TaskContract | undefined,
  input: string,
  cwd: string,
  intent?: IntentUpdate
): TaskContract {
  if (!previous) {
    return createTaskContract(input, cwd);
  }

  const normalizedPrevious = normalizeTaskContract(previous);
  const next = createTaskContract(input, cwd);
  if (intent?.kind === 'new_task') {
    return next;
  }

  const nextSuccessCriteria = next.successCriteria.filter(item => !isObjectiveFallback(item));

  return normalizeTaskContract({
    ...normalizedPrevious,
    objective: normalizedPrevious.objective,
    userIntent: input.trim(),
    requirements: unique([...normalizedPrevious.requirements, ...next.requirements]),
    successCriteria: unique([...normalizedPrevious.successCriteria, ...nextSuccessCriteria]),
    constraints: unique([
      ...normalizedPrevious.constraints,
      ...next.constraints,
      ...(intent?.constraints ?? []),
    ]),
    prohibitions: unique([
      ...normalizedPrevious.prohibitions,
      ...next.prohibitions,
      ...(intent?.nonGoals ?? []),
    ]),
    nonGoals: unique([...(normalizedPrevious.nonGoals ?? []), ...(intent?.nonGoals ?? [])]),
    openQuestions: unique([
      ...(normalizedPrevious.openQuestions ?? []),
      ...(intent?.openQuestions ?? []),
    ]),
    taskEpoch: intent?.taskEpoch ?? normalizedPrevious.taskEpoch ?? 1,
    allowedScope: { ...normalizedPrevious.allowedScope, cwd },
    updatedAt: Date.now(),
  });
}
