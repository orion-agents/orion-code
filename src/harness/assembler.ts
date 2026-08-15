import { createHash } from 'crypto';
import type { Message } from '../services/llm';
import { getModelContextWindow } from '../services/model-context';
import { rankEvidence, estimateTokens } from './evidence';
import type {
  EvidenceRecord,
  HarnessConfig,
  HarnessState,
  PromptAssemblyStats,
  PromptSectionManifestEntry,
} from './types';

export interface PromptAssemblyOptions {
  input?: string;
  tools?: Array<{ name: string; description?: string }>;
}

export interface HarnessContextBuildResult {
  text: string;
  stats: PromptAssemblyStats;
}

function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function compact(text: string, max = 220): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  const reference = contentHash(normalized).slice(0, 16);
  const suffix = `… [full-ref:${reference}]`;
  return `${normalized.slice(0, Math.max(0, max - suffix.length))}${suffix}`;
}

function sectionManifestEntry(
  name: string,
  authority: PromptSectionManifestEntry['authority'],
  source: string,
  text: string,
  budgetTokens: number,
  selected: boolean,
  reason?: string
): PromptSectionManifestEntry {
  return {
    name,
    authority,
    source,
    selected,
    tokenEstimate: estimateTokens(text),
    budgetTokens,
    contentHash: contentHash(text),
    reason,
  };
}

function pushList(lines: string[], title: string, values: string[] | undefined, limit = 8): void {
  const items = (values ?? []).filter(Boolean).slice(0, limit);
  if (items.length === 0) return;
  lines.push(`${title}:`);
  for (const item of items) {
    lines.push(`- ${compact(item)}`);
  }
}

function relevantTools(
  tools: PromptAssemblyOptions['tools'],
  activeInstruction?: string
): string[] {
  if (!tools || tools.length === 0) return [];
  const query = (activeInstruction ?? '').toLowerCase();
  const scored = tools.map(tool => {
    let score = 0;
    if (query.includes(tool.name.toLowerCase())) score += 5;
    if (
      tool.description &&
      tool.description
        .toLowerCase()
        .split(/\W+/)
        .some(word => word.length > 3 && query.includes(word))
    ) {
      score += 2;
    }
    return { tool, score };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, 10)
    .map(item =>
      item.score > 0 ? `${item.tool.name}: ${item.tool.description ?? ''}` : item.tool.name
    );
}

function evidenceLine(record: EvidenceRecord): string {
  const suffix = [
    record.path ? `path=${record.path}` : '',
    record.toolName ? `tool=${record.toolName}` : '',
    record.verificationStatus ? `verification=${record.verificationStatus}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `- (${record.id}) [${record.kind}] ${compact(record.content, 320)}${suffix ? ` (${suffix})` : ''}`;
}

export function buildHarnessContext(
  state: HarnessState,
  modelId: string,
  config: HarnessConfig = {},
  options: PromptAssemblyOptions = {}
): HarnessContextBuildResult {
  const contract = state.contract;
  if (
    !contract &&
    state.ledger.length === 0 &&
    !state.capsule &&
    !state.rootObjective &&
    !state.capabilityProfile
  ) {
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
      sectionManifest: [],
      overBudget: false,
    };
    return { text: '', stats: emptyStats };
  }

  const contextWindow = getModelContextWindow(modelId);
  const evidenceBudgetRatio = config.evidenceBudgetRatio ?? 0.3;
  const budgetTokens = Math.max(
    700,
    Math.min(4200, Math.floor(contextWindow * evidenceBudgetRatio * 0.08))
  );

  const rootObjective = state.rootObjective ?? contract?.objective;
  const activeInstruction = state.activeInstruction ?? contract?.userIntent;
  const latestIntent = state.intentHistory?.[state.intentHistory.length - 1];
  const coreLines: string[] = ['[Orion Code Context Harness v2]'];
  coreLines.push(`Task epoch: ${state.taskEpoch ?? 1}`);
  if (rootObjective) coreLines.push(`Root objective: ${compact(rootObjective, 260)}`);
  if (activeInstruction) coreLines.push(`Active instruction: ${compact(activeInstruction, 320)}`);
  if (latestIntent) {
    coreLines.push(
      `Latest intent: ${latestIntent.kind} (${Math.round(latestIntent.confidence * 100)}%, ${latestIntent.reason})`
    );
  }
  if (state.capabilityProfile) {
    const profile = state.capabilityProfile;
    coreLines.push(
      `Capability profile: v${profile.revision} model=${profile.model.id} mode=${profile.permission.mode} tools=${profile.tools.length} ref=${profile.fingerprint.slice(0, 16)}`
    );
  }
  pushList(coreLines, 'Active constraints', state.activeConstraints ?? contract?.constraints, 8);
  pushList(coreLines, 'Non-goals', state.nonGoals ?? contract?.prohibitions, 8);
  pushList(coreLines, 'Open questions', state.openQuestions, 6);
  pushList(coreLines, 'Success criteria', contract?.successCriteria, 6);

  if (state.capsule) {
    const verification = state.capsule.verification;
    if (
      verification.passed.length > 0 ||
      verification.failed.length > 0 ||
      verification.warnings.length > 0
    ) {
      coreLines.push('Verification state:');
      for (const item of verification.passed.slice(0, 4))
        coreLines.push(`- Passed: ${compact(item)}`);
      for (const item of verification.failed.slice(0, 4))
        coreLines.push(`- Failed: ${compact(item)}`);
      for (const item of verification.warnings.slice(0, 3))
        coreLines.push(`- Warning: ${compact(item)}`);
    }
    if (state.capsule.nextAction) {
      coreLines.push(`Next action: ${compact(state.capsule.nextAction, 240)}`);
    }
  }

  const tools = relevantTools(options.tools, `${activeInstruction ?? ''} ${options.input ?? ''}`);
  if (tools.length > 0) {
    pushList(coreLines, 'Relevant available tools', tools, 8);
  }

  const finalInstruction =
    'Instruction: preserve the root objective across short feedback or refinements. Do not claim verification unless it is listed above or produced by a tool result in this turn.';
  const coreText = coreLines.join('\n');
  const coreTokens = estimateTokens(coreText);
  const instructionTokens = estimateTokens(finalInstruction);
  const optionalBudgetTokens = Math.max(0, budgetTokens - coreTokens - instructionTokens);
  const evidenceBudgetTokens = Math.floor(optionalBudgetTokens * 0.7);
  const recentTurnBudgetTokens = Math.max(0, optionalBudgetTokens - evidenceBudgetTokens);

  const configuredRecentTurns = Number(config.maxRecentTurns ?? 8);
  const recentTurnLimit = Number.isFinite(configuredRecentTurns)
    ? Math.max(0, Math.min(80, Math.floor(configuredRecentTurns)))
    : 8;
  const projectedTurnSummaries =
    recentTurnLimit > 0 ? [...(state.turnSummaries ?? [])].slice(-recentTurnLimit) : [];
  const projectedTurnEvidenceIds = new Set(
    projectedTurnSummaries.map(summary => `turn:${summary.id}`)
  );
  const projectedEvidence = (state.evidenceIndex ?? []).filter(
    record => record.kind !== 'turn_summary' || projectedTurnEvidenceIds.has(record.id)
  );
  const rankedEvidence = rankEvidence(projectedEvidence, {
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
    const line = evidenceLine(record);
    // Charge exactly what reaches the prompt after render-time compaction.
    const tokens = estimateTokens(line);
    if (usedEvidenceTokens + tokens <= evidenceBudgetTokens) {
      usedEvidenceTokens += tokens;
      evidenceLines.push(line);
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
  const recentTurns = [...projectedTurnSummaries].reverse();
  for (const summary of recentTurns) {
    const line = `- Turn ${summary.turn} [${summary.intentKind}]: ${compact(summary.userIntent, 120)} -> ${compact(summary.assistantOutcome, 180)}`;
    const tokens = estimateTokens(line);
    if (usedTurnTokens + tokens > recentTurnBudgetTokens && recentTurnLines.length > 0) break;
    usedTurnTokens += tokens;
    recentTurnLines.push(line);
  }

  const sections: string[] = ['core'];
  const lines = [...coreLines];
  const sectionManifest: PromptSectionManifestEntry[] = [
    sectionManifestEntry(
      'core',
      'system',
      'harness_contract',
      coreText,
      budgetTokens - instructionTokens,
      true,
      coreTokens > budgetTokens - instructionTokens
        ? 'mandatory contract projection exceeds its reserved prompt budget'
        : undefined
    ),
  ];
  const evidenceText = evidenceLines.join('\n');
  if (evidenceLines.length > 0) {
    lines.push('', 'Ranked evidence:');
    lines.push(...evidenceLines);
    sections.push('ranked_evidence');
  }
  sectionManifest.push(
    sectionManifestEntry(
      'ranked_evidence',
      'tool',
      'harness_evidence_index',
      evidenceText,
      evidenceBudgetTokens,
      evidenceLines.length > 0,
      evidenceLines.length > 0 ? undefined : 'no evidence item fit the section budget'
    )
  );
  const recentTurnText = recentTurnLines.join('\n');
  if (recentTurnLines.length > 0) {
    lines.push('', 'Recent turn summaries:');
    lines.push(...recentTurnLines);
    sections.push('recent_turns');
  }
  sectionManifest.push(
    sectionManifestEntry(
      'recent_turns',
      'session',
      'turn_summaries',
      recentTurnText,
      recentTurnBudgetTokens,
      recentTurnLines.length > 0,
      recentTurnLines.length > 0 ? undefined : 'no recent turn fit the section budget'
    )
  );
  lines.push('', finalInstruction);
  sections.push('instruction');
  sectionManifest.push(
    sectionManifestEntry(
      'instruction',
      'system',
      'harness_policy',
      finalInstruction,
      instructionTokens,
      true
    )
  );

  const text = lines.join('\n');
  const estimatedTokens = estimateTokens(text);
  const stats: PromptAssemblyStats = {
    createdAt: Date.now(),
    modelId,
    budgetTokens,
    estimatedTokens,
    coreTokens,
    evidenceBudgetTokens,
    recentTurnBudgetTokens,
    includedEvidence,
    omittedEvidence,
    sections,
    sectionManifest,
    overBudget: estimatedTokens > budgetTokens,
    capabilityProfileVersion: state.capabilityProfile?.revision,
    capabilityProfileFingerprint: state.capabilityProfile?.fingerprint,
  };

  return { text, stats };
}

export function renderHarnessContext(
  state: HarnessState,
  modelId: string,
  config: HarnessConfig = {}
): string {
  return buildHarnessContext(state, modelId, config).text;
}

export function assembleHarnessMessages(
  messages: Message[],
  state: HarnessState,
  modelId: string,
  config: HarnessConfig = {},
  options: PromptAssemblyOptions = {}
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
