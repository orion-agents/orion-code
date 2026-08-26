/** Semantic, group-safe conversation compaction. */

import { createHash } from 'crypto';
import type { LLMService, Message } from '../llm';
import {
  generateSummaryWithSource,
  normalizeCompactFocus,
  normalizeCompactInstructions,
  type SummaryDiagnostic,
  type SummaryOptions,
} from './summary-generator';
import {
  renderContextCapsule,
  renderHarnessStateForCompact,
  type ContextCapsule,
  type HarnessState,
} from '../../harness';
import { estimateMessagesTokens } from '../../utils/token-estimate';
import { canonicalCompactCandidateFingerprint, canonicalMessagesFingerprint } from './fingerprint';
import {
  DEFAULT_COMPACT_TARGET_RATIO,
  flattenCompactGroups,
  planCompactMessages,
  type CompactPlan,
} from './planner';
import {
  emptyCompactSummary,
  extractCompactSummary,
  type CompactSummary,
  type ContextItem,
} from './semantic-summary';
import { assertToolCallGroups } from './tool-call-groups';

const CONTEXT_SUMMARY_PREFIX = '[Context Summary]\n';
const SUMMARY_ACK =
  'I understand the context. I will continue the conversation with this background information.';

export interface CompactOptions {
  /** Compatibility cap for the recent tail; atomic groups may exceed it. */
  maxMessages?: number;
  /** Deprecated compatibility option. False removes both calls and their results. */
  keepToolCalls?: boolean;
  keepSystemMessage?: boolean;
  /** Legacy message-count trigger used by direct/manual callers. */
  threshold?: number;
  summaryOptions?: SummaryOptions;
  contextCapsule?: ContextCapsule;
  harnessState?: HarnessState;
  goalObjective?: string;
  llm?: LLMService;
  compactMode?: 'manual' | 'auto_pre_turn' | 'mid_turn';
  /** Safe provider input budget used by the semantic headroom validator. */
  safeInputBudget?: number;
  /** Successful candidates must fit this fraction of safeInputBudget. */
  targetRatio?: number;
  /** Explicit summary allowance used by the group planner. */
  summaryReserveTokens?: number;
}

export interface CompactResult {
  messages: Message[];
  originalCount: number;
  compactedCount: number;
  ratio: number;
  summary: string;
  summarySource: 'llm' | 'heuristic';
  summaryGeneratedAt: number;
  semanticSummary: CompactSummary;
  diagnostics: SummaryDiagnostic[];
  fingerprint: string;
  beforeTokens: number;
  afterTokens: number;
  plan: CompactPlan;
}

export interface CompactCandidate {
  status: 'prepared';
  messages: Message[];
  originalCount: number;
  summary: string;
  summarySource: 'llm' | 'heuristic';
  summaryGeneratedAt: number;
  semanticSummary: CompactSummary;
  diagnostics: SummaryDiagnostic[];
  fingerprint: string;
  beforeTokens: number;
  afterTokens: number;
  plan: CompactPlan;
}

export type CompactValidationErrorCode =
  | 'target_headroom_exceeded'
  | 'tool_group_invalid'
  | 'evicted_coverage_mismatch'
  | 'semantic_schema_invalid'
  | 'semantic_reference_invalid'
  | 'task_epoch_mismatch'
  | 'source_boundary_mismatch';

export interface CompactValidationError {
  code: CompactValidationErrorCode;
  message: string;
}

export interface CompactCandidateValidation {
  valid: boolean;
  errors: CompactValidationError[];
}

export class CompactCandidateValidationError extends Error {
  constructor(readonly validation: CompactCandidateValidation) {
    super(validation.errors.map(error => `${error.code}: ${error.message}`).join('; '));
    this.name = 'CompactCandidateValidationError';
  }
}

const DEFAULT_OPTIONS: Required<
  Pick<CompactOptions, 'maxMessages' | 'keepToolCalls' | 'keepSystemMessage' | 'threshold'>
> = {
  maxMessages: 20,
  keepToolCalls: true,
  keepSystemMessage: true,
  threshold: 0,
};

function cloneMessages(messages: readonly Message[]): Message[] {
  return messages.map(message => ({
    ...message,
    tool_calls: message.tool_calls?.map(call => ({
      ...call,
      function: { ...call.function },
    })),
  }));
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [
    ...new Set(values.map(value => value?.trim()).filter((value): value is string => !!value)),
  ];
}

function invariantItemId(kind: ContextItem['kind'], material: string): string {
  const digest = createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 20);
  return `ctx-${kind}-${digest}`;
}

function invariantItem(params: {
  kind: Extract<ContextItem['kind'], 'contract' | 'evidence' | 'next_action'>;
  text: string;
  sourceRefs: string[];
  taskEpoch: number;
  status?: ContextItem['status'];
}): ContextItem {
  const id = invariantItemId(params.kind, `${params.sourceRefs.join('\0')}\0${params.text}`);
  return {
    id,
    groupId: `harness:${id}`,
    kind: params.kind,
    priority: 'must_keep',
    sourceRefs: [...params.sourceRefs],
    tokenEstimate: estimateMessagesTokens([{ role: 'system', content: params.text }]),
    taskEpoch: params.taskEpoch,
    expires: 'task',
    text: params.text,
    sourceRole: 'system',
    messageIndexes: { start: -1, end: -1 },
    status: params.status,
  };
}

function structuredProjectionLine(label: string, value: string, maxLength: number = 280): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const prefix = `${label}: `;
  if (prefix.length + normalized.length <= maxLength) return `${prefix}${normalized}`;
  const ref = createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
  const suffix = ` [full-ref:${ref}]`;
  const available = Math.max(0, maxLength - prefix.length - suffix.length);
  return `${prefix}${normalized.slice(0, available)}${suffix}`;
}

function renderDeterministicSemanticSummary(summary: CompactSummary, maxLength: number): string {
  const lines: string[] = ['[Semantic Snapshot v1]'];
  if (summary.requestedFocus) {
    lines.push(structuredProjectionLine('Requested focus', summary.requestedFocus));
  }
  if (summary.projectInstructions) {
    lines.push(
      structuredProjectionLine('Project compact instructions', summary.projectInstructions)
    );
  }
  if (summary.objective) lines.push(structuredProjectionLine('Objective', summary.objective));
  if (summary.activeInstruction) {
    lines.push(structuredProjectionLine('Active instruction', summary.activeInstruction));
  }
  for (const criterion of summary.criterionStates ?? []) {
    lines.push(
      structuredProjectionLine(
        `Criterion ${criterion.id} [${criterion.status}]`,
        `${criterion.statement}${criterion.evidenceRefs.length ? ` | evidence=${criterion.evidenceRefs.join(',')}` : ''}`
      )
    );
  }
  const appendValues = (label: string, values: readonly string[] | undefined): void => {
    for (const value of values ?? []) lines.push(structuredProjectionLine(label, value));
  };
  appendValues('Constraint', summary.constraints);
  appendValues('Non-goal', summary.nonGoals);
  appendValues('Decision', summary.decisions);
  appendValues('Completed', summary.completed);
  appendValues('Pending', summary.pending);
  appendValues('Blocker', summary.blockers);
  appendValues('Verification passed', summary.successfulVerifications);
  appendValues('Verification failed', summary.failedVerifications);
  appendValues('Changed file', summary.changedFiles);
  appendValues('Open question', summary.openQuestions);
  if (summary.nextAction) lines.push(structuredProjectionLine('Next action', summary.nextAction));
  lines.push(
    `Source boundary: ${summary.coverage.groupCount} groups / ${summary.coverage.messageCount} messages`
  );

  const selected: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const line of lines) {
    const needed = line.length + (selected.length > 0 ? 1 : 0);
    if (used + needed <= maxLength) {
      selected.push(line);
      used += needed;
    } else {
      omitted.push(line);
    }
  }
  if (omitted.length > 0) {
    const ref = createHash('sha256').update(omitted.join('\n'), 'utf8').digest('hex').slice(0, 16);
    const receipt = `Omitted structured lines: ${omitted.length} [full-ref:${ref}]`;
    while (selected.length > 1 && selected.join('\n').length + receipt.length + 1 > maxLength) {
      omitted.unshift(selected.pop()!);
    }
    if (receipt.length <= maxLength) selected.push(receipt);
  }
  return selected.join('\n');
}

function enrichSemanticSummary(
  summary: CompactSummary,
  options: Pick<CompactOptions, 'harnessState' | 'contextCapsule' | 'goalObjective'>
): CompactSummary {
  const state = options.harnessState;
  const capsule = state?.capsule ?? options.contextCapsule;
  const contract = state?.contract ?? capsule?.contract;
  const capability = state?.capabilityProfile;
  const taskEpoch = Math.max(1, state?.taskEpoch ?? contract?.taskEpoch ?? summary.taskEpoch);
  const criterionStates = contract?.criteria?.map(criterion => ({
    id: criterion.id,
    statement: criterion.statement,
    status: criterion.status ?? ('pending' as const),
    evidenceRefs: [...criterion.evidenceRefs],
  }));
  const boundEvidenceRefs = uniqueStrings(
    (criterionStates ?? []).flatMap(criterion => criterion.evidenceRefs)
  );
  const evidenceByRef = new Map<string, { content: string; status?: ContextItem['status'] }>();
  for (const record of state?.evidenceIndex ?? []) {
    const value = { content: record.content, status: record.verificationStatus };
    evidenceByRef.set(record.id, value);
    evidenceByRef.set(`evidence:${record.id}`, value);
  }
  for (const entry of state?.ledger ?? []) {
    const rawSuccess = entry.metadata?.success;
    const status = rawSuccess === true ? 'passed' : rawSuccess === false ? 'failed' : 'unknown';
    const value = { content: entry.content, status } as const;
    evidenceByRef.set(entry.id, value);
    evidenceByRef.set(`ledger:${entry.id}`, value);
  }
  const invariantItems: ContextItem[] = [];
  if (contract) {
    invariantItems.push(
      invariantItem({
        kind: 'contract',
        text: JSON.stringify({
          objective: contract.objective,
          activeInstruction: state?.activeInstruction ?? contract.userIntent,
          constraints: contract.constraints,
          prohibitions: contract.prohibitions,
          nonGoals: state?.nonGoals ?? contract.nonGoals ?? [],
          openQuestions: state?.openQuestions ?? contract.openQuestions ?? [],
          criteria: criterionStates ?? [],
        }),
        sourceRefs: uniqueStrings([
          `contract:${contract.id}`,
          ...(criterionStates ?? []).map(criterion => criterion.id),
        ]),
        taskEpoch,
      })
    );
  }
  for (const ref of boundEvidenceRefs) {
    const evidence = evidenceByRef.get(ref);
    invariantItems.push(
      invariantItem({
        kind: 'evidence',
        text: evidence?.content ?? `Evidence reference: ${ref}`,
        sourceRefs: [ref],
        taskEpoch,
        status: evidence?.status ?? 'unknown',
      })
    );
  }
  if (capsule?.nextAction) {
    invariantItems.push(
      invariantItem({
        kind: 'next_action',
        text: capsule.nextAction,
        sourceRefs: ['harness:next-action'],
        taskEpoch,
      })
    );
  }

  return {
    ...summary,
    taskEpoch,
    objective:
      options.goalObjective ?? state?.rootObjective ?? contract?.objective ?? summary.objective,
    activeInstruction:
      state?.activeInstruction ?? contract?.userIntent ?? summary.latestUserInstruction,
    scope: contract
      ? {
          cwd: contract.allowedScope.cwd,
          files: contract.allowedScope.files ? [...contract.allowedScope.files] : undefined,
          commands: contract.allowedScope.commands
            ? [...contract.allowedScope.commands]
            : undefined,
        }
      : undefined,
    nonGoals: uniqueStrings([
      ...(summary.nonGoals ?? []),
      ...(state?.nonGoals ?? contract?.nonGoals ?? []),
    ]),
    openQuestions: uniqueStrings([
      ...(summary.openQuestions ?? []),
      ...(state?.openQuestions ?? contract?.openQuestions ?? []),
    ]),
    criterionStates,
    files: uniqueStrings([...summary.files, ...(capsule?.changedFiles ?? [])]),
    changedFiles: uniqueStrings(capsule?.changedFiles ?? []),
    successfulVerifications: uniqueStrings(capsule?.verification.passed ?? []),
    failedVerifications: uniqueStrings(capsule?.verification.failed ?? []),
    blockers: uniqueStrings([...summary.blockers, ...(capsule?.verification.warnings ?? [])]),
    nextAction: capsule?.nextAction,
    evidenceRefs: uniqueStrings([...summary.evidenceRefs, ...boundEvidenceRefs]),
    items: [...invariantItems, ...summary.items.map(item => ({ ...item, taskEpoch }))],
    verification: [
      ...invariantItems.filter(item => item.kind === 'evidence'),
      ...summary.verification.map(item => ({ ...item, taskEpoch })),
    ],
    capability: capability
      ? {
          revision: capability.revision,
          fingerprint: capability.fingerprint,
          modelId: capability.model.id,
          permissionMode: capability.permission.mode,
          tools: [...capability.tools],
        }
      : undefined,
  };
}

function pinnedContextMessages(options: CompactOptions): Message[] {
  if (options.harnessState) {
    return [
      {
        role: 'user',
        content: renderHarnessStateForCompact(
          options.harnessState,
          options.compactMode ?? 'manual'
        ),
      },
      {
        role: 'assistant',
        content:
          'I will continue from this Orion Code Context State and preserve its root objective, active instruction, constraints, and verification state.',
      },
    ];
  }
  if (options.contextCapsule) {
    return [
      { role: 'user', content: renderContextCapsule(options.contextCapsule) },
      {
        role: 'assistant',
        content:
          'I will continue from this Context Capsule and preserve its open todos, constraints, and verification state.',
      },
    ];
  }
  return [];
}

function stripSyntheticCompactMessages(messages: readonly Message[]): {
  priorSummary?: Message;
  conversation: Message[];
} {
  const priorSummary = [...messages]
    .reverse()
    .find(message => message.content?.startsWith(CONTEXT_SUMMARY_PREFIX));
  const conversation = messages.filter(
    message =>
      !message.content?.startsWith(CONTEXT_SUMMARY_PREFIX) &&
      !(message.role === 'assistant' && message.content === SUMMARY_ACK) &&
      !message.content?.startsWith('[Orion Code Context State v2]') &&
      !message.content?.startsWith('## Context Capsule') &&
      !(
        message.role === 'assistant' &&
        (message.content.startsWith('I will continue from this Orion Code Context State') ||
          message.content.startsWith('I will continue from this Context Capsule'))
      )
  );
  return { priorSummary, conversation: cloneMessages(conversation) };
}

function withoutToolProtocol(messages: readonly Message[]): Message[] {
  const callIds = new Set(
    messages.flatMap(message => message.tool_calls?.map(call => call.id) ?? [])
  );
  return messages
    .filter(message => message.role !== 'tool' || !callIds.has(message.tool_call_id ?? ''))
    .map(message =>
      message.tool_calls?.length ? { ...message, tool_calls: undefined } : { ...message }
    );
}

function emptyPlan(messages: readonly Message[]): CompactPlan {
  return planCompactMessages(messages, { maxMessages: messages.length });
}

function resultFromCandidate(candidate: CompactCandidate): CompactResult {
  return {
    messages: cloneMessages(candidate.messages),
    originalCount: candidate.originalCount,
    compactedCount: candidate.messages.length,
    ratio: candidate.originalCount === 0 ? 1 : candidate.messages.length / candidate.originalCount,
    summary: candidate.summary,
    summarySource: candidate.summarySource,
    summaryGeneratedAt: candidate.summaryGeneratedAt,
    semanticSummary: candidate.semanticSummary,
    diagnostics: candidate.diagnostics.map(diagnostic => ({ ...diagnostic })),
    fingerprint: candidate.fingerprint,
    beforeTokens: candidate.beforeTokens,
    afterTokens: candidate.afterTokens,
    plan: candidate.plan,
  };
}

/** Prepare a model-context projection without mutating or persisting its source. */
export async function prepareCompactCandidate(
  messages: readonly Message[],
  options: CompactOptions = {}
): Promise<CompactCandidate> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const source = cloneMessages(messages);
  const systemMessages = opts.keepSystemMessage
    ? source.filter(message => message.role === 'system')
    : [];
  const nonSystem = opts.keepSystemMessage
    ? source.filter(message => message.role !== 'system')
    : source;
  const { priorSummary, conversation } = stripSyntheticCompactMessages(nonSystem);
  const pinned = pinnedContextMessages(opts);
  const framingTokens = estimateMessagesTokens([
    { role: 'user', content: CONTEXT_SUMMARY_PREFIX },
    { role: 'assistant', content: SUMMARY_ACK },
  ]);
  const plan = planCompactMessages(conversation, {
    maxMessages: opts.maxMessages,
    safeInputBudget: opts.safeInputBudget,
    targetRatio: opts.targetRatio ?? DEFAULT_COMPACT_TARGET_RATIO,
    fixedTokens: estimateMessagesTokens([...systemMessages, ...pinned]) + framingTokens,
    summaryReserveTokens: opts.summaryReserveTokens,
  });
  const evictedMessages = flattenCompactGroups(plan.evictedGroups);
  const oldMessages = priorSummary ? [{ ...priorSummary }, ...evictedMessages] : evictedMessages;
  let semanticSummary = extractCompactSummary(plan.evictedGroups, {
    taskEpoch: opts.harnessState?.taskEpoch ?? opts.harnessState?.contract?.taskEpoch,
  });
  semanticSummary = {
    ...semanticSummary,
    requestedFocus: normalizeCompactFocus(opts.summaryOptions?.focus),
    projectInstructions: normalizeCompactInstructions(opts.summaryOptions?.instructions),
  };
  semanticSummary = enrichSemanticSummary(semanticSummary, opts);

  let summary = '';
  let summarySource: CompactCandidate['summarySource'] = 'heuristic';
  let diagnostics: SummaryDiagnostic[] = [];
  if (plan.evictedGroups.length > 0) {
    if (opts.llm) {
      const generated = await generateSummaryWithSource(oldMessages, opts.llm, opts.summaryOptions);
      summary = generated.text;
      summarySource = generated.source;
      diagnostics = generated.diagnostics;
      if (generated.source === 'heuristic') {
        const projectionBudget = Math.max(
          256,
          Math.min(opts.summaryOptions?.maxLength ?? 2000, plan.summaryReserveTokens * 3 || 2000)
        );
        summary = renderDeterministicSemanticSummary(semanticSummary, projectionBudget);
      }
    } else {
      const projectionBudget = Math.max(
        256,
        Math.min(opts.summaryOptions?.maxLength ?? 2000, plan.summaryReserveTokens * 3 || 2000)
      );
      summary = renderDeterministicSemanticSummary(semanticSummary, projectionBudget);
      diagnostics = [
        {
          code: 'deterministic_projection',
          message: 'Rendered the typed semantic snapshot without a summary provider.',
          fallbackUsed: true,
        },
      ];
    }
  } else if (priorSummary) {
    summary = priorSummary.content.slice(CONTEXT_SUMMARY_PREFIX.length);
  }

  const candidateMessages: Message[] = [...systemMessages];
  if (plan.evictedGroups.length > 0) candidateMessages.push(...pinned);
  if (summary) {
    candidateMessages.push(
      { role: 'user', content: `${CONTEXT_SUMMARY_PREFIX}${summary}` },
      { role: 'assistant', content: SUMMARY_ACK }
    );
  }
  candidateMessages.push(...flattenCompactGroups(plan.recentGroups));
  const visibleMessages = opts.keepToolCalls
    ? candidateMessages
    : withoutToolProtocol(candidateMessages);

  return {
    status: 'prepared',
    messages: visibleMessages,
    originalCount: source.length,
    summary,
    summarySource,
    summaryGeneratedAt: Date.now(),
    semanticSummary,
    diagnostics,
    fingerprint: canonicalCompactCandidateFingerprint({
      messages: visibleMessages,
      sourceBoundary: {
        firstGroupId: semanticSummary.sourceBoundary?.firstGroupId,
        lastGroupId: semanticSummary.sourceBoundary?.lastGroupId,
        groupCount:
          semanticSummary.sourceBoundary?.groupCount ?? semanticSummary.coverage.groupCount,
        messageCount:
          semanticSummary.sourceBoundary?.messageCount ?? semanticSummary.coverage.messageCount,
        groupIds: semanticSummary.coverage.groupIds,
      },
    }),
    beforeTokens: estimateMessagesTokens(source),
    afterTokens: estimateMessagesTokens(visibleMessages),
    plan,
  };
}

/** Validate semantic coverage, provider headroom, and tool protocol invariants. */
export function validateCompactCandidate(candidate: CompactCandidate): CompactCandidateValidation {
  const errors: CompactValidationError[] = [];
  try {
    assertToolCallGroups(candidate.messages);
  } catch (error) {
    errors.push({
      code: 'tool_group_invalid',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (
    candidate.plan.targetTokens !== undefined &&
    candidate.afterTokens > candidate.plan.targetTokens
  ) {
    errors.push({
      code: 'target_headroom_exceeded',
      message: `Candidate uses ${candidate.afterTokens} tokens; target is ${candidate.plan.targetTokens}.`,
    });
  }

  const expectedCoverage = candidate.plan.evictedGroups.map(group => group.id);
  if (
    expectedCoverage.length !== candidate.semanticSummary.coverage.groupIds.length ||
    expectedCoverage.some(
      (groupId, index) => candidate.semanticSummary.coverage.groupIds[index] !== groupId
    )
  ) {
    errors.push({
      code: 'evicted_coverage_mismatch',
      message: 'Semantic summary does not cover every evicted atomic group in order.',
    });
  }

  const summary = candidate.semanticSummary;
  const expectedMessageCount = candidate.plan.evictedGroups.reduce(
    (total, group) => total + group.messages.length,
    0
  );
  if (
    summary.sourceBoundary?.firstGroupId !== expectedCoverage[0] ||
    summary.sourceBoundary?.lastGroupId !== expectedCoverage.at(-1) ||
    summary.sourceBoundary?.groupCount !== expectedCoverage.length ||
    summary.sourceBoundary?.messageCount !== expectedMessageCount
  ) {
    errors.push({
      code: 'source_boundary_mismatch',
      message: 'Semantic source boundary does not match the evicted atomic groups.',
    });
  }

  const validKinds = new Set([
    'system',
    'contract',
    'decision',
    'evidence',
    'tool_group',
    'turn',
    'next_action',
  ]);
  const validPriorities = new Set(['must_keep', 'high', 'normal', 'evictable']);
  const schemaInvalid =
    !Number.isSafeInteger(summary.taskEpoch) ||
    summary.taskEpoch < 1 ||
    summary.items.some(
      item =>
        !item.id ||
        !item.groupId ||
        !validKinds.has(item.kind) ||
        !validPriorities.has(item.priority) ||
        !Array.isArray(item.sourceRefs) ||
        item.sourceRefs.length === 0 ||
        !Number.isSafeInteger(item.tokenEstimate) ||
        item.tokenEstimate < 0
    );
  if (schemaInvalid) {
    errors.push({
      code: 'semantic_schema_invalid',
      message: 'Semantic ContextItems do not satisfy the typed schema.',
    });
  }

  if (summary.items.some(item => item.taskEpoch !== summary.taskEpoch)) {
    errors.push({
      code: 'task_epoch_mismatch',
      message: 'Semantic ContextItems are not bound to the current task epoch.',
    });
  }

  const conversationItems = summary.items.filter(item => item.messageIndexes.start >= 0);
  if (
    conversationItems.length !== expectedCoverage.length ||
    expectedCoverage.some(
      (groupId, index) =>
        conversationItems[index]?.groupId !== groupId ||
        !conversationItems[index]?.sourceRefs.includes(`group:${groupId}`)
    )
  ) {
    errors.push({
      code: 'semantic_reference_invalid',
      message: 'Conversation ContextItems do not bind every evicted group in order.',
    });
  }

  const criterionIds = new Set<string>();
  let semanticReferenceInvalid = false;
  for (const criterion of summary.criterionStates ?? []) {
    if (!criterion.id || criterionIds.has(criterion.id)) semanticReferenceInvalid = true;
    criterionIds.add(criterion.id);
    if (
      !summary.items.some(
        item => item.kind === 'contract' && item.sourceRefs.includes(criterion.id)
      )
    ) {
      semanticReferenceInvalid = true;
    }
    for (const evidenceRef of criterion.evidenceRefs) {
      if (
        !summary.evidenceRefs.includes(evidenceRef) ||
        !summary.items.some(
          item => item.kind === 'evidence' && item.sourceRefs.includes(evidenceRef)
        )
      ) {
        semanticReferenceInvalid = true;
      }
    }
  }
  if (semanticReferenceInvalid) {
    errors.push({
      code: 'semantic_reference_invalid',
      message: 'Criterion or evidence references are missing, duplicated, or dangling.',
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Commit the prepared in-memory projection. This intentionally does not write a
 * session checkpoint; the runtime/session owner must perform that transaction.
 */
export function commitCompactCandidate(candidate: CompactCandidate): CompactResult {
  const validation = validateCompactCandidate(candidate);
  if (!validation.valid) throw new CompactCandidateValidationError(validation);
  return resultFromCandidate(candidate);
}

export async function compactMessages(
  messages: Message[],
  options: CompactOptions = {}
): Promise<CompactResult> {
  const threshold = options.threshold ?? DEFAULT_OPTIONS.threshold;
  if (messages.length <= threshold) {
    const cloned = cloneMessages(messages);
    const tokens = estimateMessagesTokens(cloned);
    return {
      messages,
      originalCount: messages.length,
      compactedCount: messages.length,
      ratio: 1,
      summary: '',
      summarySource: 'heuristic',
      summaryGeneratedAt: Date.now(),
      semanticSummary: emptyCompactSummary(),
      diagnostics: [],
      fingerprint: canonicalMessagesFingerprint(cloned),
      beforeTokens: tokens,
      afterTokens: tokens,
      plan: emptyPlan(cloned),
    };
  }
  return commitCompactCandidate(await prepareCompactCandidate(messages, options));
}

export function needsCompact(messages: Message[], threshold?: number): boolean {
  return messages.length > (threshold ?? DEFAULT_OPTIONS.threshold);
}

export { CompactOptions as CompactConfig, CompactResult as CompactResultData };
