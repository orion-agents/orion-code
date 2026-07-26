import type { Message } from '../services/llm';
import { getModelContextWindow } from '../services/model-context';
import { rankEvidence, estimateTokens } from './evidence';
import type { EvidenceRecord, HarnessConfig, HarnessState, PromptAssemblyStats } from './types';

function truncateByChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 80)) + '\n[truncated by Context Harness]';
}

export interface PromptAssemblyOptions {
  input?: string;
  tools?: Array<{ name: string; description?: string }>;
}

export interface HarnessContextBuildResult {
  text: string;
  stats: PromptAssemblyStats;
}

function compact(text: string, max = 220): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? normalized.slice(0, max - 3) + '...' : normalized;
}

function pushList(lines: string[], title: string, values: string[] | undefined, limit = 8): void {
  const items = (values ?? []).filter(Boolean).slice(0, limit);
  if (items.length === 0) return;
  lines.push(`${title}:`);
  for (const item of items) {
    lines.push(`- ${compact(item)}`);
  }
}

function relevantTools(tools: PromptAssemblyOptions['tools'], activeInstruction?: string): string[] {
  if (!tools || tools.length === 0) return [];
  const query = (activeInstruction ?? '').toLowerCase();
  const scored = tools.map(tool => {
    let score = 0;
    if (query.includes(tool.name.toLowerCase())) score += 5;
    if (tool.description && tool.description.toLowerCase().split(/\W+/).some(word => word.length > 3 && query.includes(word))) {
      score += 2;
    }
    return { tool, score };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, 10)
    .map(item => item.score > 0 ? `${item.tool.name}: ${item.tool.description ?? ''}` : item.tool.name);
}

function evidenceLine(record: EvidenceRecord): string {
  const suffix = [
    record.path ? `path=${record.path}` : '',
    record.toolName ? `tool=${record.toolName}` : '',
    record.verificationStatus ? `verification=${record.verificationStatus}` : '',
  ].filter(Boolean).join(' ');
  return `- (${record.id}) [${record.kind}] ${compact(record.content, 320)}${suffix ? ` (${suffix})` : ''}`;
}

export function buildHarnessContext(
  state: HarnessState,
  modelId: string,
  config: HarnessConfig = {},
  options: PromptAssemblyOptions = {},
): HarnessContextBuildResult {
  const contract = state.contract;
  if (!contract && state.ledger.length === 0 && !state.capsule && !state.rootObjective) {
    const emptyStats: PromptAssemblyStats = {
      createdAt: Date.now(),
      modelId,
      budgetTokens: 0,
      estimatedTokens: 0,
      coreTokens: 0,
      evidenceBudgetTokens: 0,
      recentTurnBudgetTokens: 0,
      includedEvidence: [],
      omittedEvidence: [],
      sections: [],
    };
    return { text: '', stats: emptyStats };
  }

  const contextWindow = getModelContextWindow(modelId);
  const evidenceBudgetRatio = config.evidenceBudgetRatio ?? 0.3;
  const budgetTokens = Math.max(700, Math.min(4200, Math.floor(contextWindow * evidenceBudgetRatio * 0.08)));
  const evidenceBudgetTokens = Math.max(160, Math.floor(budgetTokens * 0.46));
  const recentTurnBudgetTokens = Math.max(120, Math.floor(budgetTokens * 0.18));

  const rootObjective = state.rootObjective ?? contract?.objective;
  const activeInstruction = state.activeInstruction ?? contract?.userIntent;
  const latestIntent = state.intentHistory?.[state.intentHistory.length - 1];
  const coreLines: string[] = ['[Orion Code Context Harness v2]'];
  coreLines.push(`Task epoch: ${state.taskEpoch ?? 1}`);
  if (rootObjective) coreLines.push(`Root objective: ${compact(rootObjective, 260)}`);
  if (activeInstruction) coreLines.push(`Active instruction: ${compact(activeInstruction, 320)}`);
  if (latestIntent) {
    coreLines.push(`Latest intent: ${latestIntent.kind} (${Math.round(latestIntent.confidence * 100)}%, ${latestIntent.reason})`);
  }
  pushList(coreLines, 'Active constraints', state.activeConstraints ?? contract?.constraints, 8);
  pushList(coreLines, 'Non-goals', state.nonGoals ?? contract?.prohibitions, 8);
  pushList(coreLines, 'Open questions', state.openQuestions, 6);
  pushList(coreLines, 'Success criteria', contract?.successCriteria, 6);

  if (state.capsule) {
    const verification = state.capsule.verification;
    if (verification.passed.length > 0 || verification.failed.length > 0 || verification.warnings.length > 0) {
      coreLines.push('Verification state:');
      for (const item of verification.passed.slice(0, 4)) coreLines.push(`- Passed: ${compact(item)}`);
      for (const item of verification.failed.slice(0, 4)) coreLines.push(`- Failed: ${compact(item)}`);
      for (const item of verification.warnings.slice(0, 3)) coreLines.push(`- Warning: ${compact(item)}`);
    }
    if (state.capsule.nextAction) {
      coreLines.push(`Next action: ${compact(state.capsule.nextAction, 240)}`);
    }
  }

  const tools = relevantTools(options.tools, `${activeInstruction ?? ''} ${options.input ?? ''}`);
  if (tools.length > 0) {
    pushList(coreLines, 'Relevant available tools', tools, 8);
  }

  const rankedEvidence = rankEvidence(state.evidenceIndex ?? [], {
    query: options.input,
    taskEpoch: state.taskEpoch,
    activeInstruction,
    rootObjective,
  });
  const evidenceLines: string[] = [];
  const includedEvidence: PromptAssemblyStats['includedEvidence'] = [];
  const omittedEvidence: PromptAssemblyStats['omittedEvidence'] = [];
  let usedEvidenceTokens = 0;
  for (const record of rankedEvidence) {
    const tokens = Math.max(record.tokenEstimate, estimateTokens(record.content));
    if (usedEvidenceTokens + tokens <= evidenceBudgetTokens || includedEvidence.length < 4) {
      usedEvidenceTokens += tokens;
      evidenceLines.push(evidenceLine(record));
      includedEvidence.push({
        id: record.id,
        kind: record.kind,
        score: record.score,
        tokens,
        reason: record.reasons.join(', '),
      });
    } else {
      omittedEvidence.push({
        id: record.id,
        kind: record.kind,
        score: record.score,
        tokens,
        reason: 'evidence budget exceeded',
      });
    }
  }

  const recentTurnLines: string[] = [];
  let usedTurnTokens = 0;
  const recentTurns = [...(state.turnSummaries ?? [])].slice(-5).reverse();
  for (const summary of recentTurns) {
    const line = `- Turn ${summary.turn} [${summary.intentKind}]: ${compact(summary.userIntent, 120)} -> ${compact(summary.assistantOutcome, 180)}`;
    const tokens = estimateTokens(line);
    if (usedTurnTokens + tokens > recentTurnBudgetTokens && recentTurnLines.length > 0) break;
    usedTurnTokens += tokens;
    recentTurnLines.push(line);
  }

  const sections: string[] = ['core'];
  const lines = [...coreLines];
  if (evidenceLines.length > 0) {
    lines.push('', 'Ranked evidence:');
    lines.push(...evidenceLines);
    sections.push('ranked_evidence');
  }
  if (recentTurnLines.length > 0) {
    lines.push('', 'Recent turn summaries:');
    lines.push(...recentTurnLines);
    sections.push('recent_turns');
  }
  lines.push('', 'Instruction: preserve the root objective across short feedback or refinements. Do not claim verification unless it is listed above or produced by a tool result in this turn.');

  const rendered = lines.join('\n');
  const maxChars = budgetTokens * 4;
  const text = truncateByChars(rendered, maxChars);
  const estimatedTokens = estimateTokens(text);
  const stats: PromptAssemblyStats = {
    createdAt: Date.now(),
    modelId,
    budgetTokens,
    estimatedTokens,
    coreTokens: estimateTokens(coreLines.join('\n')),
    evidenceBudgetTokens,
    recentTurnBudgetTokens,
    includedEvidence,
    omittedEvidence,
    sections,
  };

  return { text, stats };
}

export function renderHarnessContext(state: HarnessState, modelId: string, config: HarnessConfig = {}): string {
  return buildHarnessContext(state, modelId, config).text;
}

export function assembleHarnessMessages(
  messages: Message[],
  state: HarnessState,
  modelId: string,
  config: HarnessConfig = {},
  options: PromptAssemblyOptions = {},
): Message[] {
  if (config.enabled === false) return messages;

  const harnessContext = buildHarnessContext(state, modelId, config, options).text;
  if (!harnessContext.trim()) return messages;

  const cloned = messages.map(message => ({ ...message }));
  const systemIndex = cloned.findIndex(message => message.role === 'system');
  if (systemIndex >= 0) {
    cloned[systemIndex] = {
      ...cloned[systemIndex],
      content: `${cloned[systemIndex].content}\n\n---\n${harnessContext}`,
    };
  } else {
    cloned.unshift({ role: 'system', content: harnessContext });
  }

  return cloned;
}
