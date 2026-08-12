import type {
  CompletionGateResult,
  ContextLedgerEntry,
  DriftCheckResult,
  TaskContract,
} from './types';

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
  toolName: string;
  args: Record<string, unknown>;
  mode: 'off' | 'warn' | 'block';
}): DriftCheckResult {
  if (params.mode === 'off' || !params.contract) return { status: 'ok' };

  const argsText = JSON.stringify(params.args).toLowerCase();
  const prohibitionHit = params.contract.prohibitions.find(item => {
    const normalized = item.toLowerCase();
    return normalized && argsText.includes(normalized);
  });

  if (prohibitionHit) {
    return {
      status: params.mode === 'block' ? 'block' : 'warn',
      reason: `Tool arguments may violate prohibition: ${prohibitionHit}`,
      correction: 'Choose a safer tool call or explain why this action is required.',
    };
  }

  return { status: 'ok' };
}

export function evaluateCompletionGate(params: {
  contract?: TaskContract;
  ledger: ContextLedgerEntry[];
}): CompletionGateResult {
  const evidence: string[] = [];
  const missing: string[] = [];

  const verificationPassed = params.ledger.some(
    entry =>
      (entry.type === 'verification' || entry.type === 'test_result') &&
      entry.metadata?.success === true
  );

  for (const entry of params.ledger) {
    if (
      (entry.type === 'verification' || entry.type === 'test_result') &&
      entry.metadata?.success === true
    ) {
      evidence.push(entry.content);
    }
  }

  if (hasExplicitVerificationNeed(params.contract) && !verificationPassed) {
    missing.push('Required verification has not passed yet.');
  }

  return {
    canComplete: missing.length === 0,
    missing,
    evidence,
  };
}
