import type { ContextLedgerEntry, TaskCriterion, VerificationKind } from './types';

const KIND_ORDER: VerificationKind[] = [
  'test',
  'build',
  'lint',
  'typecheck',
  'diff',
  'git',
  'ci',
  'release',
  'generic',
];

function uniqueKinds(kinds: VerificationKind[]): VerificationKind[] {
  const found = new Set(kinds);
  return KIND_ORDER.filter(kind => found.has(kind));
}

export function classifyVerificationCommand(command: string | undefined): VerificationKind {
  if (!command?.trim()) return 'generic';
  const normalized = command.toLowerCase();
  if (
    /\b(?:npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|jest|vitest|pytest|go\s+test|cargo\s+test)\b/u.test(
      normalized
    )
  ) {
    return 'test';
  }
  if (
    /\b(?:eslint|stylelint|npm\s+run\s+lint|pnpm\s+(?:run\s+)?lint|yarn\s+lint)\b/u.test(normalized)
  ) {
    return 'lint';
  }
  if (/\b(?:tsc|typecheck|type-check|mypy|pyright)\b/u.test(normalized)) {
    return 'typecheck';
  }
  if (
    /\b(?:npm\s+run\s+build|pnpm\s+(?:run\s+)?build|yarn\s+build|cargo\s+build|go\s+build)\b/u.test(
      normalized
    )
  ) {
    return 'build';
  }
  if (/\b(?:git\s+diff\s+--check|diff\s+--check)\b/u.test(normalized)) return 'diff';
  if (/\b(?:github|gh\s+(?:run|workflow|pr)|circleci|buildkite|jenkins)\b/u.test(normalized)) {
    return 'ci';
  }
  if (/\b(?:npm\s+publish|github\s+release|gh\s+release|release|publish|tag)\b/u.test(normalized)) {
    return 'release';
  }
  if (/\bgit\s+(?:status|commit|push|fetch|pull|merge|rebase|tag|rev-parse)\b/u.test(normalized)) {
    return 'git';
  }
  return 'generic';
}

export function requiredVerificationKinds(statement: string): VerificationKind[] {
  const normalized = statement.toLowerCase();
  const englishAction =
    /^(?:please\s+)?(?:run|execute|verify|validate|check|ensure)\b/u.test(normalized) ||
    /\b(?:must|should|need(?:s)?\s+to|required\s+to|require[sd]?|ensure|please|run|execute)\b.{0,120}\b(?:tests?|jest|vitest|tsc|lint|build|verify|verification|validate|check|ci|publish|release|git)\b/u.test(
      normalized
    ) ||
    /\b(?:tests?|jest|vitest|tsc|lint|build|verification|ci|release)\b.{0,120}\b(?:must|should|required|pass(?:ed|ing)?|succeed(?:ed|ing)?|green|complete[sd]?)\b/u.test(
      normalized
    ) ||
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build|lint|typecheck)\b/u.test(normalized) ||
    /\bgit\s+(?:diff\s+--check|commit|push|merge|rebase)\b/u.test(normalized);
  const chineseAction =
    /(?:必须|需要|要求|确保|请|运行|执行|通过|完成|成功).{0,60}(?:测试|验证|构建|编译|检查|发布|提交|推送|流水线)/u.test(
      statement
    ) ||
    /(?:测试|验证|构建|编译|检查|发布|提交|推送|流水线).{0,60}(?:必须|需要|要求|确保|通过|成功|运行|执行|完成)/u.test(
      statement
    );
  if (!englishAction && !chineseAction) return [];

  const kinds: VerificationKind[] = [];
  if (
    /\b(?:tests?|jest|vitest|pytest)\b/u.test(normalized) ||
    /(?:测试|用例).{0,20}(?:通过|运行|执行|成功)/u.test(statement) ||
    /(?:运行|执行|通过).{0,20}(?:测试|用例)/u.test(statement)
  ) {
    kinds.push('test');
  }
  if (
    /\b(?:npm\s+run\s+build|build\s+(?:must\s+)?(?:pass|succeed|green)|successful\s+build)\b/u.test(
      normalized
    ) ||
    /(?:构建|编译).{0,20}(?:通过|运行|执行|成功)/u.test(statement)
  ) {
    kinds.push('build');
  }
  if (
    /\b(?:eslint|stylelint|lint(?:ing)?)(?:\s+(?:must\s+)?(?:pass|succeed|green))?\b/u.test(
      normalized
    ) ||
    /(?:lint|代码检查).{0,20}(?:通过|运行|执行|成功)/iu.test(statement)
  ) {
    kinds.push('lint');
  }
  if (
    /\b(?:tsc|typecheck|type-check|mypy|pyright)\b/u.test(normalized) ||
    /(?:类型检查).{0,20}(?:通过|运行|执行|成功)/u.test(statement)
  ) {
    kinds.push('typecheck');
  }
  if (
    /\b(?:git\s+diff\s+--check|diff\s+check)\b/u.test(normalized) ||
    /(?:diff|差异检查).{0,20}(?:通过|运行|执行|成功)/iu.test(statement)
  ) {
    kinds.push('diff');
  }
  if (
    /\b(?:github\s+actions?|ci)(?:\s+(?:must\s+)?(?:pass|succeed|green))?\b/u.test(normalized) ||
    /(?:CI|流水线).{0,20}(?:通过|成功|绿色)/u.test(statement)
  ) {
    kinds.push('ci');
  }
  if (
    /\b(?:npm\s+publish|publish(?:ed|ing)?|release(?:d|ing)?|tagged)\b/u.test(normalized) ||
    /(?:发布|打标签|tag).{0,20}(?:完成|成功|验证)/iu.test(statement)
  ) {
    kinds.push('release');
  }
  if (
    /\bgit\s+(?:commit|push|merge|rebase)\b/u.test(normalized) ||
    /(?:提交|推送).{0,20}(?:完成|成功)/u.test(statement)
  ) {
    kinds.push('git');
  }
  if (kinds.length === 0 && /\b(?:verify|validate|check)\b/u.test(normalized)) {
    kinds.push('generic');
  }
  if (kinds.length === 0 && /(?:验证|检查)/u.test(statement)) {
    kinds.push('generic');
  }
  return uniqueKinds(kinds);
}

export function verificationKindForEntry(entry: ContextLedgerEntry): VerificationKind {
  const stored = entry.metadata?.verificationKind;
  if (typeof stored === 'string' && KIND_ORDER.includes(stored as VerificationKind)) {
    return stored as VerificationKind;
  }
  const command = typeof entry.metadata?.command === 'string' ? entry.metadata.command : undefined;
  return classifyVerificationCommand(command);
}

export function isTrustedEvidence(entry: ContextLedgerEntry): boolean {
  return (
    entry.metadata?.resultTrust === 'structured' && typeof entry.metadata?.success === 'boolean'
  );
}

export function criterionHasAuthorizedWaiver(criterion: TaskCriterion): boolean {
  return !!(
    criterion.status === 'waived' &&
    criterion.waiver?.authorizedBy === 'user' &&
    criterion.waiver.reason.trim() &&
    Number.isFinite(criterion.waiver.at)
  );
}
