import type { CompletionGateResult, ContextLedgerEntry, DriftCheckResult, TaskContract } from './types';

function hasExplicitVerificationNeed(contract: TaskContract | undefined): boolean {
  if (!contract) return false;
  const text = [
    ...contract.requirements,
    ...contract.successCriteria,
  ].join('\n');
  return /\b(test|tests|jest|vitest|tsc|lint|build|verify|verification)\b|测试|验证|通过|运行/.test(text);
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

  const verificationPassed = params.ledger.some(entry =>
    (entry.type === 'verification' || entry.type === 'test_result') &&
    entry.metadata?.success === true
  );

  for (const entry of params.ledger) {
    if ((entry.type === 'verification' || entry.type === 'test_result') && entry.metadata?.success === true) {
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

