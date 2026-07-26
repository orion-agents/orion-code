import { randomUUID } from 'crypto';
import type { IntentUpdate, TaskContract } from './types';

const MAX_LINE = 180;

function truncate(text: string, max = MAX_LINE): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > max ? trimmed.slice(0, max - 3) + '...' : trimmed;
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
  return [...new Set(items.map(item => truncate(item)).filter(Boolean))];
}

function isObjectiveFallback(item: string): boolean {
  return item.startsWith('Address the objective: ');
}

export function extractExplicitObjective(input: string): string | undefined {
  const lines = input.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = cleanLine(lines[index]).replace(/^#{1,6}\s*/, '');
    const match = line.match(/^(?:目标|objective)\s*[:：]\s*(.*)$/i);
    if (!match) continue;
    if (match[1].trim()) return truncate(match[1]);
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
    if (objectiveLines.length > 0) return truncate(objectiveLines.join(' '));
  }
  return undefined;
}

export function normalizeTaskContract(contract: TaskContract): TaskContract {
  const requirements = unique(contract.requirements.filter(item => !isSectionHeading(item)));
  const explicitSuccessCriteria = unique(
    contract.successCriteria.filter(item => !isSectionHeading(item) && !isObjectiveFallback(item))
  );
  const fallbackCriteria = unique(contract.successCriteria.filter(isObjectiveFallback));
  const successCriteria =
    explicitSuccessCriteria.length > 0 || requirements.length > 0
      ? explicitSuccessCriteria
      : fallbackCriteria.slice(0, 1);

  return {
    ...contract,
    requirements,
    successCriteria,
  };
}

export function createTaskContract(input: string, cwd: string): TaskContract {
  const now = Date.now();
  const lines = splitMeaningfulLines(input);
  const objective =
    extractExplicitObjective(input) ?? truncate(lines[0] || input || 'Continue the current task');

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
    id: randomUUID(),
    objective,
    userIntent: input.trim(),
    requirements,
    successCriteria,
    constraints: [],
    prohibitions,
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
    allowedScope: { ...normalizedPrevious.allowedScope, cwd },
    updatedAt: Date.now(),
  });
}
